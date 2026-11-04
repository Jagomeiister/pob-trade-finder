"""Loot filter files + checkpoints (the file side of js/app/29-lootfilter.js).

The game reads item filters from Documents\\My Games\\Path of Exile\\*.filter. This module
lists, reads and saves them there, and keeps checkpoints (copies made before every save or
restore) in data/filter_checkpoints/ so any change the app makes can be undone.

- Only bare "<name>.filter" file names in that one folder: no paths, no "..", no drives,
  no Windows device names.
- A save refuses to overwrite a file that changed since it was read (the user edited it,
  or FilterBlade / the game wrote it): pass the mtime read_filter returned.
- Saves are atomic: a temp file in the same folder, then os.replace, so the game never
  sees half a filter.
- Nothing here talks to the game. The user reloads the filter in game themselves.
"""
import calendar
import ctypes
import hashlib
import json
import os
import re
import sys
import tempfile
import threading
import time
import uuid

FILTER_EXT = ".filter"
MAX_BYTES = 10 * 1024 * 1024
KEEP_DEFAULT = 50
BOM = b"\xef\xbb\xbf"
CHECKPOINTS = "filter_checkpoints"
FOLDERID_DOCUMENTS = "{FDD39AD0-238F-46AF-ADB4-6C85480369C7}"

# tests point these at temp folders
FILTER_DIR_OVERRIDE = None
DATA_DIR_OVERRIDE = None

# same layout as gui.py: a frozen exe sits next to data/
if getattr(sys, "frozen", False):
    _APP_DIR = os.path.dirname(sys.executable)
else:
    _APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(_APP_DIR, "data")

_RESERVED = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"} \
    | {"COM%d" % i for i in range(10)} | {"LPT%d" % i for i in range(10)} \
    | {"COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"}
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_ID_RE = re.compile(r"(\d{8}-\d{6})(?:-(\d{1,4}))?")
_ID_FMT = "%Y%m%d-%H%M%S"

_lock = threading.RLock()


class FilterError(ValueError):
    """A clear, user-facing refusal (bad name, too big, not UTF-8, ...)."""


class FilterConflict(FilterError):
    """The file changed on disk since it was read: not overwritten."""


# -- where the game keeps filters --------------------------------------------------------
def _documents_dir():
    """The user's real Documents folder: Known Folder API, because Documents is often
    redirected (OneDrive, another drive). Falls back to ~/Documents."""
    if sys.platform == "win32":
        try:
            from ctypes import wintypes
            shell32 = ctypes.WinDLL("shell32")
            ole32 = ctypes.WinDLL("ole32")
            shell32.SHGetKnownFolderPath.argtypes = [ctypes.c_void_p, wintypes.DWORD, wintypes.HANDLE,
                                                     ctypes.POINTER(ctypes.c_void_p)]
            shell32.SHGetKnownFolderPath.restype = ctypes.c_long
            ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
            guid = ctypes.create_string_buffer(uuid.UUID(FOLDERID_DOCUMENTS).bytes_le, 16)
            out = ctypes.c_void_p()
            hr = shell32.SHGetKnownFolderPath(guid, 0, None, ctypes.byref(out))
            try:
                if hr == 0 and out.value:
                    path = ctypes.wstring_at(out.value)
                    if path:
                        return path
            finally:
                if out.value:
                    ole32.CoTaskMemFree(out)
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Documents")


def filter_dir():
    """Documents\\My Games\\Path of Exile (or FILTER_DIR_OVERRIDE)."""
    if FILTER_DIR_OVERRIDE:
        return FILTER_DIR_OVERRIDE
    return os.path.join(_documents_dir(), "My Games", "Path of Exile")


def _data_dir(data_dir=None):
    return data_dir or DATA_DIR_OVERRIDE or DATA_DIR


# -- names --------------------------------------------------------------------------------
def _check_name(name):
    """A bare "<something>.filter" file name, or FilterError."""
    if not isinstance(name, str) or not name:
        raise FilterError("no filter file name given")
    if len(name) > 255:
        raise FilterError("filter file name is too long")
    if _BAD_CHARS.search(name) or ".." in name:
        raise FilterError("not a plain filter file name: %r" % name)
    if not name.lower().endswith(FILTER_EXT):
        raise FilterError("only .filter files: %r" % name)
    stem = name[:-len(FILTER_EXT)]
    if not stem.strip(" ."):
        raise FilterError("not a plain filter file name: %r" % name)
    if name != name.strip() or name.startswith("."):
        raise FilterError("not a plain filter file name: %r" % name)
    if stem.split(".")[0].rstrip(" ").upper() in _RESERVED:
        raise FilterError("%r is a reserved Windows name" % name)
    return name


def _safe_path(name, dir=None):
    """Full path of a filter file in the filter folder; ValueError (FilterError) otherwise."""
    _check_name(name)
    folder = os.path.abspath(dir or filter_dir())
    path = os.path.abspath(os.path.join(folder, name))
    if os.path.dirname(path) != folder or os.path.basename(path) != name:
        raise FilterError("not a plain filter file name: %r" % name)
    return path



def _checkpoint_folder(name, data_dir=None):
    """data/filter_checkpoints/<name without .filter>. Windows drops trailing dots / spaces
    from folder names, so such a name gets a hash suffix instead of colliding."""
    _check_name(name)
    stem = name[:-len(FILTER_EXT)]
    if stem != stem.rstrip(" .") or stem != stem.lstrip(" "):
        stem = "%s~%s" % (stem.strip(" ."), hashlib.sha1(name.encode("utf-8")).hexdigest()[:8])
    return os.path.join(_data_dir(data_dir), CHECKPOINTS, stem)


# -- small file helpers -------------------------------------------------------------------
def _sha1(data):
    return hashlib.sha1(data).hexdigest()


def _mtime(path):
    return os.stat(path).st_mtime


def _same_mtime(a, b):
    try:
        return abs(float(a) - float(b)) < 1e-4
    except (TypeError, ValueError):
        return False


def _atomic_write(path, data):
    """Temp file in the same folder, fsync, os.replace. Never leaves the temp behind."""
    folder = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix="." + os.path.basename(path) + ".", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        for attempt in range(10):  # a reader (antivirus, the game) can hold it for a moment
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.1)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _read_bytes(path):
    size = os.path.getsize(path)
    if size > MAX_BYTES:
        raise FilterError("%s is over 10 MB (%d bytes): not a loot filter?" % (os.path.basename(path), size))
    with open(path, "rb") as f:
        return f.read()


# -- filters ------------------------------------------------------------------------------
def list_filters(dir=None):
    """[{name, size, mtime}] for the *.filter files in the filter folder, newest first.
    A missing folder (game never run) is an empty list."""
    folder = dir or filter_dir()
    out = []
    try:
        names = os.listdir(folder)
    except FileNotFoundError:
        return out
    for name in names:
        if not name.lower().endswith(FILTER_EXT):
            continue
        try:
            _check_name(name)
        except FilterError:
            continue
        path = os.path.join(folder, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        if not os.path.isfile(path):
            continue
        out.append({"name": name, "size": st.st_size, "mtime": st.st_mtime})
    out.sort(key=lambda f: (-f["mtime"], f["name"].lower()))
    return out


def read_filter(name, dir=None):
    """{text, bom, eol, mtime, size}: text is the whole file as UTF-8, BOM stripped (bom says
    whether it had one), line endings untouched (eol says which: "\\r\\n" or "\\n")."""
    path = _safe_path(name, dir)
    if not os.path.isfile(path):
        raise FileNotFoundError("no filter called %s in %s" % (name, os.path.dirname(path)))
    data = _read_bytes(path)
    size = len(data)
    mtime = _mtime(path)
    bom = data.startswith(BOM)
    if bom:
        data = data[len(BOM):]
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise FilterError("%s is not UTF-8 text (byte %d): the game wants UTF-8 filters" % (name, e.start))
    eol = "\r\n" if "\r\n" in text else "\n"
    return {"text": text, "bom": bom, "eol": eol, "mtime": mtime, "size": size}


def _encode(text, bom):
    if not isinstance(text, str):
        raise FilterError("filter text must be a string")
    if text.startswith("﻿"):
        text = text[1:]
    data = (BOM if bom else b"") + text.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise FilterError("that filter is over 10 MB: not saved")
    return data


def write_filter(name, text, expect_mtime=None, keep=KEEP_DEFAULT, bom=False, label=None,
                 dir=None, data_dir=None):
    """Save a whole filter. expect_mtime (from read_filter): refuse if the file changed since.
    The current file is checkpointed first. Returns {mtime, checkpoint} (checkpoint: the id
    holding the previous content, or None for a new file)."""
    path = _safe_path(name, dir)
    data = _encode(text, bom)
    with _lock:
        exists = os.path.isfile(path)
        if expect_mtime is not None:
            if not exists:
                raise FilterConflict("%s was deleted or renamed since it was opened: not saved" % name)
            if not _same_mtime(_mtime(path), expect_mtime):
                raise FilterConflict("%s changed on disk since it was opened (edited elsewhere or by the "
                                     "game): not saved. Reopen it to see the new version." % name)
        cp = None
        if exists:
            cp, _created = _make_checkpoint(name, _read_bytes(path), label or "before save", keep, data_dir)
        elif not os.path.isdir(os.path.dirname(path)):
            raise FileNotFoundError("the filter folder doesn't exist: %s" % os.path.dirname(path))
        _atomic_write(path, data)
        return {"mtime": _mtime(path), "checkpoint": cp}


# -- checkpoints --------------------------------------------------------------------------
def _id_key(cid):
    m = _ID_RE.fullmatch(cid)
    return (m.group(1), int(m.group(2) or 0)) if m else None


def _check_id(cid):
    if not isinstance(cid, str) or not _ID_RE.fullmatch(cid):
        raise FilterError("not a checkpoint id: %r" % (cid,))
    try:
        time.strptime(cid[:15], _ID_FMT)
    except ValueError:
        raise FilterError("not a checkpoint id: %r" % (cid,))
    return cid


def _ids(folder):
    """Checkpoint ids in a folder, oldest first."""
    try:
        names = os.listdir(folder)
    except FileNotFoundError:
        return []
    ids = [n[:-len(FILTER_EXT)] for n in names if n.endswith(FILTER_EXT) and _ID_RE.fullmatch(n[:-len(FILTER_EXT)])]
    return sorted(ids, key=_id_key)


def _meta(folder, cid):
    try:
        with open(os.path.join(folder, cid + ".json"), "r", encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


def _cp_sha1(folder, cid):
    sha = _meta(folder, cid).get("sha1")
    if isinstance(sha, str) and sha:
        return sha
    try:
        with open(os.path.join(folder, cid + FILTER_EXT), "rb") as f:
            return _sha1(f.read())
    except OSError:
        return None


def _new_id(folder, existing):
    base = time.strftime(_ID_FMT, time.gmtime())
    newest = _id_key(existing[-1]) if existing else None
    if newest and base < newest[0]:  # clock went back: stay after the newest
        base = newest[0]
    n = 0
    while True:
        cid = base if n == 0 else "%s-%d" % (base, n)
        if (newest is None or (base, n) > newest) and not os.path.exists(os.path.join(folder, cid + FILTER_EXT)):
            return cid
        n += 1


def _make_checkpoint(name, data, label, keep, data_dir):
    """Store data as a checkpoint of name. Same content as the newest one: no duplicate,
    returns (that id, False). Prunes to `keep`. Returns (id, created)."""
    folder = _checkpoint_folder(name, data_dir)
    keep = max(1, int(keep or KEEP_DEFAULT))
    with _lock:
        os.makedirs(folder, exist_ok=True)
        existing = _ids(folder)
        sha = _sha1(data)
        if existing and _cp_sha1(folder, existing[-1]) == sha:
            return existing[-1], False
        cid = _new_id(folder, existing)
        _atomic_write(os.path.join(folder, cid + FILTER_EXT), data)
        meta = {"label": str(label or "")[:200], "size": len(data), "sha1": sha}
        _atomic_write(os.path.join(folder, cid + ".json"), json.dumps(meta).encode("utf-8"))
        existing.append(cid)
        for old in existing[:-keep]:
            for ext in (FILTER_EXT, ".json"):
                try:
                    os.remove(os.path.join(folder, old + ext))
                except OSError:
                    pass
        return cid, True


def checkpoint(name, label=None, keep=KEEP_DEFAULT, dir=None, data_dir=None):
    """Checkpoint the current file now. {id, created} (created False: identical to the newest)."""
    path = _safe_path(name, dir)
    if not os.path.isfile(path):
        raise FileNotFoundError("no filter called %s in %s" % (name, os.path.dirname(path)))
    with _lock:
        cid, created = _make_checkpoint(name, _read_bytes(path), label or "checkpoint", keep, data_dir)
    return {"id": cid, "created": created}


def list_checkpoints(name, data_dir=None):
    """[{id, label, size, time}] newest first (time: epoch seconds)."""
    folder = _checkpoint_folder(name, data_dir)
    out = []
    for cid in reversed(_ids(folder)):
        path = os.path.join(folder, cid + FILTER_EXT)
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        try:
            t = calendar.timegm(time.strptime(cid[:15], _ID_FMT))
        except ValueError:
            t = None
        out.append({"id": cid, "label": _meta(folder, cid).get("label", ""), "size": size, "time": t})
    return out


def restore_checkpoint(name, id, keep=KEEP_DEFAULT, dir=None, data_dir=None):
    """Put a checkpoint's content back: the current file is checkpointed first ("before
    restore"), then the old bytes are written back atomically. {mtime, checkpoint, restored}."""
    _check_id(id)
    path = _safe_path(name, dir)
    folder = _checkpoint_folder(name, data_dir)
    src = os.path.join(folder, id + FILTER_EXT)
    with _lock:
        if not os.path.isfile(src):
            raise FileNotFoundError("no checkpoint %s for %s" % (id, name))
        old = _read_bytes(src)
        cp = None
        if os.path.isfile(path):
            cp, _created = _make_checkpoint(name, _read_bytes(path), "before restore", keep, data_dir)
        elif not os.path.isdir(os.path.dirname(path)):
            raise FileNotFoundError("the filter folder doesn't exist: %s" % os.path.dirname(path))
        _atomic_write(path, old)
        return {"mtime": _mtime(path), "checkpoint": cp, "restored": id}


# -- online filters (FilterBlade / the PoE site) -----------------------------------------
# The game keeps filters followed on the PoE website in OnlineFilters\ (no extension, a
# "#name:" header). The game owns that folder and replaces those files on its own, so they
# are never edited: Import copies one to "<name>-local.filter" next to the other filters
# (the copy edits are made to) and records which online file and version it came from in
# data/filter_baselines/. When the online file changes, the app replays the recorded edits
# onto the new version (js/filter-edit.js) and saves the local copy again.
ONLINE_DIR = "OnlineFilters"
BASELINES = "filter_baselines"
_HEADER_RE = re.compile(r"^#\s*([A-Za-z]+)\s*:(.*)$")


def online_dir(dir=None):
    return os.path.join(dir or filter_dir(), ONLINE_DIR)


def _check_online_id(oid):
    """An online filter's file name: plain, no extension needed, no paths."""
    if not isinstance(oid, str) or not oid or len(oid) > 255:
        raise FilterError("not an online filter: %r" % (oid,))
    if _BAD_CHARS.search(oid) or ".." in oid or oid != oid.strip() or oid.startswith("."):
        raise FilterError("not an online filter: %r" % (oid,))
    if oid.split(".")[0].rstrip(" ").upper() in _RESERVED:
        raise FilterError("not an online filter: %r" % (oid,))
    return oid


def _online_path(oid, dir=None):
    _check_online_id(oid)
    folder = os.path.abspath(online_dir(dir))
    path = os.path.abspath(os.path.join(folder, oid))
    if os.path.dirname(path) != folder or os.path.basename(path) != oid:
        raise FilterError("not an online filter: %r" % (oid,))
    return path


def header_fields(text):
    """The "#key:value" lines at the top of an online filter ({"name": ..., "hash": ...})."""
    out = {}
    for line in text.splitlines()[:40]:
        m = _HEADER_RE.match(line.strip())
        if not m:
            if line.strip() and not line.startswith("#"):
                break
            continue
        key = m.group(1).lower()
        if key not in out:
            out[key] = m.group(2).strip()
    return out


def _decode(data, label):
    if data.startswith(BOM):
        data = data[len(BOM):]
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as e:
        raise FilterError("%s is not UTF-8 text (byte %d)" % (label, e.start))


def _version(text, data):
    """The online filter's version: its "#hash:" header, or a hash of the bytes."""
    return header_fields(text).get("hash") or _sha1(data)


def local_name_for(name):
    """"<online name>-local.filter", made a safe file name."""
    stem = _BAD_CHARS.sub("_", str(name or "").strip()).strip(" .") or "online"
    stem = stem[:200]
    if stem.split(".")[0].upper() in _RESERVED:
        stem = "_" + stem
    if not stem.lower().endswith("-local"):
        stem += "-local"
    return _check_name(stem + FILTER_EXT)


def list_online(dir=None, data_dir=None):
    """[{id, name, version, mtime, size, local, imported}] for the online filters, newest first.
    imported: a "-local" copy of it exists in the filter folder."""
    folder = online_dir(dir)
    out = []
    try:
        names = os.listdir(folder)
    except FileNotFoundError:
        return out
    for oid in names:
        try:
            path = _online_path(oid, dir)
            if not os.path.isfile(path):
                continue
            data = _read_bytes(path)
            text = _decode(data, oid)
        except (FilterError, OSError):
            continue
        name = header_fields(text).get("name") or oid
        local = local_name_for(name)
        out.append({"id": oid, "name": name, "version": _version(text, data), "mtime": _mtime(path),
                    "size": len(data), "local": local,
                    "imported": os.path.isfile(os.path.join(dir or filter_dir(), local))})
    out.sort(key=lambda f: (-f["mtime"], f["name"].lower()))
    return out


def read_online(oid, dir=None):
    """{text, name, version, mtime, eol}: an online filter, read only."""
    path = _online_path(oid, dir)
    if not os.path.isfile(path):
        raise FileNotFoundError("no online filter %s in %s" % (oid, os.path.dirname(path)))
    data = _read_bytes(path)
    text = _decode(data, oid)
    return {"text": text, "name": header_fields(text).get("name") or oid, "version": _version(text, data),
            "mtime": _mtime(path), "eol": "\r\n" if "\r\n" in text else "\n"}


def localise_text(text, local):
    """The online text with its "#name:" header renamed to the local copy (so the game's
    filter list shows which one is which). Everything else is kept as it is."""
    stem = local[:-len(FILTER_EXT)]
    lines = text.split("\n")
    for i, line in enumerate(lines[:40]):
        m = _HEADER_RE.match(line.strip())
        if m and m.group(1).lower() == "name":
            lines[i] = "#name: " + stem + ("\r" if line.endswith("\r") else "")
            return "\n".join(lines)
    return text


def _baseline_path(local, data_dir=None):
    _check_name(local)
    return os.path.join(_data_dir(data_dir), BASELINES, local[:-len(FILTER_EXT)] + ".json")


def get_baseline(local, data_dir=None):
    """{online, name, version, time} for a "-local" copy, or None (not imported by the app)."""
    try:
        with open(_baseline_path(local, data_dir), "r", encoding="utf-8") as f:
            b = json.load(f)
        return b if isinstance(b, dict) and b.get("online") else None
    except (OSError, ValueError):
        return None


def set_baseline(local, oid, version, name=None, data_dir=None):
    _check_online_id(oid)
    path = _baseline_path(local, data_dir)
    b = {"online": oid, "name": str(name or "")[:200], "version": str(version or "")[:200], "time": time.time()}
    with _lock:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _atomic_write(path, json.dumps(b).encode("utf-8"))
    return b


def import_online(oid, overwrite=False, keep=KEEP_DEFAULT, dir=None, data_dir=None):
    """Copy an online filter to "<name>-local.filter" and remember where it came from.
    An existing local copy is only replaced with overwrite=True (it is checkpointed first).
    {local, version, mtime, checkpoint}."""
    src = read_online(oid, dir)
    local = local_name_for(src["name"])
    path = _safe_path(local, dir)
    if os.path.isfile(path) and not overwrite:
        raise FilterConflict("%s already exists: open it, or import again to replace it" % local)
    r = write_filter(local, localise_text(src["text"], local), keep=keep, label="before import", dir=dir,
                     data_dir=data_dir)
    set_baseline(local, oid, src["version"], src["name"], data_dir)
    return {"local": local, "version": src["version"], "mtime": r["mtime"], "checkpoint": r["checkpoint"]}


def online_status(local, dir=None, data_dir=None):
    """Is there a newer online version than the one this local copy was made from?
    {imported, online, name, version, current, changed, missing}."""
    b = get_baseline(local, data_dir)
    if not b:
        return {"imported": False}
    out = {"imported": True, "online": b["online"], "name": b.get("name") or "", "version": b.get("version") or "",
           "current": None, "changed": False, "missing": False}
    try:
        cur = read_online(b["online"], dir)
        out["current"] = cur["version"]
        out["changed"] = cur["version"] != out["version"]
    except (FileNotFoundError, FilterError):
        out["missing"] = True
    return out
