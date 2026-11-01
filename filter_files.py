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
