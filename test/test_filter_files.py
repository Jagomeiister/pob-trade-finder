"""Loot filter files + checkpoints — run: python test/test_filter_files.py

filter_files: list / read / save the game's *.filter files (safe names only, BOM + line
endings kept, atomic saves, refuses to overwrite a file changed since it was read) and the
checkpoints made before every save / restore (dedupe, keep limit, strict ids). Plus the gui
bridge methods' {"ok": ...} dicts. Temp folders for both the filter folder and data/: the
real Documents\\My Games\\Path of Exile is never touched, and no window is opened."""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402
import filter_files as ff  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


def raises(fn, exc=Exception):
    try:
        fn()
    except exc as e:
        return e
    except Exception as e:  # the wrong kind
        return None if exc is not Exception else e
    return None


root = tempfile.mkdtemp(prefix="pobtf-filters-")
FDIR = os.path.join(root, "Path of Exile")
DDIR = os.path.join(root, "data")
os.makedirs(FDIR)
os.makedirs(DDIR)
real_data_dir = gui.DATA_DIR
ff.FILTER_DIR_OVERRIDE = FDIR
ff.DATA_DIR_OVERRIDE = DDIR
gui.DATA_DIR = DDIR


def put(name, data, mtime=None):
    p = os.path.join(FDIR, name)
    with open(p, "wb") as f:
        f.write(data)
    if mtime is not None:
        os.utime(p, (mtime, mtime))
    return p


def raw(name):
    with open(os.path.join(FDIR, name), "rb") as f:
        return f.read()


def leftovers():
    return [n for n in os.listdir(FDIR) if n.endswith(".tmp")]


try:
    # -- where filters live -------------------------------------------------------------
    ff.FILTER_DIR_OVERRIDE = None
    real = ff.filter_dir()
    ff.FILTER_DIR_OVERRIDE = FDIR
    check("filter folder = Documents\\My Games\\Path of Exile",
          real.endswith(os.path.join("My Games", "Path of Exile")) and os.path.isabs(real), real)
    docs = ff._documents_dir()
    check("Documents folder found (Known Folder API / fallback)", os.path.isdir(docs), docs)
    check("override used by filter_dir()", ff.filter_dir() == FDIR)

    # -- list -----------------------------------------------------------------------------
    now = time.time()
    put("Old.filter", b"Show\n", now - 300)
    put("New.filter", b"Hide\n", now - 10)
    put("Mid.FILTER", b"Show\n", now - 100)
    put("notes.txt", b"x", now)
    put("x.filter.bak", b"x", now)
    os.makedirs(os.path.join(FDIR, "folder.filter"))
    names = [f["name"] for f in ff.list_filters()]
    check("list: only .filter files", set(names) == {"Old.filter", "New.filter", "Mid.FILTER"}, names)
    check("list: newest first", names == ["New.filter", "Mid.FILTER", "Old.filter"], names)
    f0 = ff.list_filters()[0]
    check("list: name, size, mtime", f0["size"] == 5 and abs(f0["mtime"] - (now - 10)) < 1, f0)
    check("list: missing folder is empty", ff.list_filters(os.path.join(root, "nope")) == [])

    # -- safe names -----------------------------------------------------------------------
    for bad in ("..\\x.filter", "a/b.filter", "a\\b.filter", "C:\\x.filter", "C:x.filter", "x.txt", "con.filter",
                "CON.filter", "nul.x.filter", "com1.filter", "lpt9.filter", "../x.filter", "..filter", ".filter",
                "x.filter:stream", "x?.filter", "", None, "a\x00.filter", " x.filter", "x" * 300 + ".filter"):
        e = raises(lambda: ff._safe_path(bad, FDIR), ValueError)
        check("safe name rejects %r" % (bad if bad is None or len(bad) < 40 else bad[:20] + "..."), e is not None)
    check("safe name accepts a plain name", ff._safe_path("NeverSink's 3-STRICT.filter", FDIR)
          == os.path.join(os.path.abspath(FDIR), "NeverSink's 3-STRICT.filter"))
    check("read refuses a bad name", raises(lambda: ff.read_filter("..\\gui.filter"), ValueError) is not None)
    check("write refuses a bad name (nothing written)",
          raises(lambda: ff.write_filter("x.txt", "Show"), ValueError) is not None
          and not os.path.exists(os.path.join(FDIR, "x.txt")))

    # -- read -----------------------------------------------------------------------------
    put("bom.filter", b"\xef\xbb\xbfShow\r\n\tBaseType \"Mirror\xc3\xa9\"\r\n")
    r = ff.read_filter("bom.filter")
    check("read: BOM detected and stripped", r["bom"] is True and r["text"].startswith("Show"), r)
    check("read: CRLF detected, text untouched", r["eol"] == "\r\n" and "\r\n" in r["text"] and "\u00e9" in r["text"])
    check("read: mtime is the file's", abs(r["mtime"] - os.stat(os.path.join(FDIR, "bom.filter")).st_mtime) < 1e-6)
    put("lf.filter", b"Show\n\tRarity Unique\n")
    r = ff.read_filter("lf.filter")
    check("read: no BOM, LF", r["bom"] is False and r["eol"] == "\n", r)
    put("latin.filter", b"Show # caf\xe9\n")
    e = raises(lambda: ff.read_filter("latin.filter"), ValueError)
    check("read: not UTF-8 refused clearly", e is not None and "UTF-8" in str(e), e)
    check("read: missing file", raises(lambda: ff.read_filter("missing.filter"), FileNotFoundError) is not None)
    big = os.path.join(FDIR, "big.filter")
    with open(big, "wb") as f:
        f.truncate(ff.MAX_BYTES + 1)
    e = raises(lambda: ff.read_filter("big.filter"), ValueError)
    check("read: over 10 MB refused", e is not None and "10 MB" in str(e), e)
    os.remove(big)

    # -- write: checkpoint first, atomic, BOM / eol as passed --------------------------------
    r0 = ff.read_filter("bom.filter")
    before = raw("bom.filter")
    w = ff.write_filter("bom.filter", r0["text"] + "Hide\r\n", expect_mtime=r0["mtime"], bom=True)
    cps = ff.list_checkpoints("bom.filter")
    check("write: returns mtime + checkpoint", w["checkpoint"] and abs(w["mtime"] - os.stat(
        os.path.join(FDIR, "bom.filter")).st_mtime) < 1e-6, w)
    cp_file = os.path.join(DDIR, "filter_checkpoints", "bom", w["checkpoint"] + ".filter")
    with open(cp_file, "rb") as f:
        check("write: checkpoint holds the previous bytes exactly", f.read() == before)
    check("write: checkpoint sidecar json", os.path.isfile(cp_file[:-len(".filter")] + ".json")
          and cps and cps[0]["label"] == "before save" and cps[0]["size"] == len(before), cps)
    check("write: BOM + CRLF kept as passed", raw("bom.filter") == before + b"Hide\r\n")
    check("write: no temp file left behind", leftovers() == [], leftovers())
    w2 = ff.write_filter("lf.filter", "Show\n", bom=False)
    check("write: no BOM when bom=False", raw("lf.filter") == b"Show\n" and w2["checkpoint"])
    ff.write_filter("lf.filter", "\ufeffShow\n", bom=True)
    check("write: never a double BOM", raw("lf.filter") == b"\xef\xbb\xbfShow\n")
    w3 = ff.write_filter("brand new.filter", "Show\n")
    check("write: a new file has no checkpoint", w3["checkpoint"] is None and raw("brand new.filter") == b"Show\n", w3)

    # a failing replace leaves the old file and no temp
    real_replace = os.replace

    def broken_replace(a, b):
        raise OSError("disk on fire")

    os.replace = broken_replace
    try:
        e = raises(lambda: ff.write_filter("brand new.filter", "Hide\n"), OSError)
    finally:
        os.replace = real_replace
    check("write: failed replace keeps the old file", e is not None and raw("brand new.filter") == b"Show\n")
    check("write: failed replace leaves no temp", leftovers() == [], leftovers())

    # -- expect_mtime conflict ----------------------------------------------------------------
    r = ff.read_filter("New.filter")
    put("New.filter", b"Hide # edited in FilterBlade\n", r["mtime"] + 5)
    n_cps = len(ff.list_checkpoints("New.filter"))
    e = raises(lambda: ff.write_filter("New.filter", "Show # ours\n", expect_mtime=r["mtime"]), ff.FilterConflict)
    check("conflict: refused with a clear error", e is not None and "changed on disk" in str(e), e)
    check("conflict: file unchanged", raw("New.filter") == b"Hide # edited in FilterBlade\n")
    check("conflict: no checkpoint made", len(ff.list_checkpoints("New.filter")) == n_cps)
    os.remove(os.path.join(FDIR, "Mid.FILTER"))
    e = raises(lambda: ff.write_filter("Mid.FILTER", "x", expect_mtime=now - 100), ff.FilterConflict)
    check("conflict: file deleted since read", e is not None and not os.path.exists(os.path.join(FDIR, "Mid.FILTER")))
    ok = ff.write_filter("New.filter", "Show # ours\n", expect_mtime=ff.read_filter("New.filter")["mtime"])
    check("matching mtime saves", raw("New.filter") == b"Show # ours\n" and ok["checkpoint"])

    # -- checkpoints: dedupe, keep limit, ids ----------------------------------------------------
    put("cp.filter", b"v1\n")
    a = ff.checkpoint("cp.filter", "first")
    b = ff.checkpoint("cp.filter", "again")
    check("checkpoint on demand", a["created"] is True and ff.list_checkpoints("cp.filter")[0]["label"] == "first", a)
    check("identical content: no duplicate", b["created"] is False and b["id"] == a["id"]
          and len(ff.list_checkpoints("cp.filter")) == 1, b)
    ff.write_filter("cp.filter", "v2\n")  # current (v1) == newest checkpoint: still one
    check("save after an identical checkpoint: no duplicate", len(ff.list_checkpoints("cp.filter")) == 1)
    for i in range(3, 9):
        ff.write_filter("cp.filter", "v%d\n" % i, keep=3)
    cps = ff.list_checkpoints("cp.filter")
    folder = os.path.join(DDIR, "filter_checkpoints", "cp")
    check("keep limit prunes the oldest", len(cps) == 3 and len(os.listdir(folder)) == 6, [c["id"] for c in cps])

    def content(cid):
        with open(os.path.join(folder, cid + ".filter"), "rb") as f:
            return f.read()

    check("newest first, newest kept", [content(c["id"]) for c in cps] == [b"v7\n", b"v6\n", b"v5\n"],
          [content(c["id"]) for c in cps])
    check("ids are timestamps", all(ff._ID_RE.fullmatch(c["id"]) for c in cps)
          and len({c["id"] for c in cps}) == 3, [c["id"] for c in cps])
    check("checkpoint time is epoch seconds", all(abs(c["time"] - time.time()) < 120 for c in cps), cps[0])
    check("no checkpoints yet: empty", ff.list_checkpoints("Old.filter") == [])
    check("checkpoints refuse a bad name", raises(lambda: ff.list_checkpoints("..\\x.filter"), ValueError) is not None)
    odd = ff._checkpoint_folder("foo .filter", DDIR)
    check("name with a trailing space gets its own checkpoint folder",
          os.path.basename(odd) != os.path.basename(ff._checkpoint_folder("foo.filter", DDIR))
          and not os.path.basename(odd).endswith((" ", ".")), odd)

    # -- restore -----------------------------------------------------------------------------------
    put("rs.filter", b"\xef\xbb\xbfShow\r\n\tRarity Unique\r\n")
    original = raw("rs.filter")
    first = ff.checkpoint("rs.filter", "good")["id"]
    ff.write_filter("rs.filter", "Hide\n")
    current = raw("rs.filter")
    r = ff.restore_checkpoint("rs.filter", first)
    check("restore: old content back byte-identical", raw("rs.filter") == original)
    cps = ff.list_checkpoints("rs.filter")
    with open(os.path.join(DDIR, "filter_checkpoints", "rs", r["checkpoint"] + ".filter"), "rb") as f:
        check("restore: current content checkpointed first", f.read() == current
              and cps[0]["id"] == r["checkpoint"] and cps[0]["label"] == "before restore", cps[0])
    check("restore: returns mtime + restored id", r["restored"] == first and r["mtime"], r)
    check("restore: no temp left", leftovers() == [])
    for bad in ("../x", "20260101-000000.filter", "x", "20261399-000000", "20260101-000000/../..",
                "20260101-000000\\x", "", None, "20260101-000000-12345", "..\\..\\gui"):
        check("restore refuses id %r" % (bad,), raises(lambda: ff.restore_checkpoint("rs.filter", bad), ValueError)
              is not None and raw("rs.filter") == original)
    check("restore: unknown (valid) id", raises(lambda: ff.restore_checkpoint("rs.filter", "20000101-000000"),
                                                 FileNotFoundError) is not None and raw("rs.filter") == original)

    # -- gui bridge -----------------------------------------------------------------------------------
    api = gui.Api.__new__(gui.Api)
    r = api.filter_list()
    check("bridge list: ok + dir + filters", r["ok"] and r["dir"] == FDIR and r["exists"]
          and r["filters"][0]["name"] in {f["name"] for f in ff.list_filters()}, r.get("dir"))
    r = api.filter_read("rs.filter")
    check("bridge read: ok + text/bom/eol/mtime", r["ok"] and r["bom"] and r["eol"] == "\r\n" and r["name"] == "rs.filter"
          and "Rarity Unique" in r["text"], r)
    r = api.filter_read("..\\gui.py")
    check("bridge read: bad name -> ok False + error", r["ok"] is False and isinstance(r["error"], str) and r["error"], r)
    r = api.filter_read("missing.filter")
    check("bridge read: missing -> ok False", r["ok"] is False and "missing.filter" in r["error"], r)
    rd = api.filter_read("rs.filter")
    w = api.filter_write("rs.filter", rd["text"] + "Hide\r\n", rd["mtime"], True, "my label")
    check("bridge write: ok + checkpoint with label", w["ok"] and w["checkpoint"] and
          raw("rs.filter") == original + b"Hide\r\n" and api.filter_checkpoints("rs.filter")["checkpoints"][0]["label"]
          == "my label", w)
    w = api.filter_write("rs.filter", "Show\n", rd["mtime"] - 50)
    check("bridge write: conflict -> ok False + conflict flag, file unchanged",
          w["ok"] is False and w.get("conflict") is True and raw("rs.filter") == original + b"Hide\r\n", w)
    r = api.filter_checkpoints("rs.filter")
    check("bridge checkpoints: ok + list", r["ok"] and len(r["checkpoints"]) >= 2, r)
    check("bridge checkpoints: bad name -> ok False", api.filter_checkpoints("a/b.filter")["ok"] is False)
    c = api.filter_checkpoint("rs.filter", "manual")
    check("bridge checkpoint: ok + id", c["ok"] and c["created"] and
          api.filter_checkpoints("rs.filter")["checkpoints"][0]["label"] == "manual", c)
    r = api.filter_restore("rs.filter", first)
    check("bridge restore: ok, content back", r["ok"] and raw("rs.filter") == original, r)
    r = api.filter_restore("rs.filter", "../../x")
    check("bridge restore: bad id -> ok False", r["ok"] is False and "checkpoint id" in r["error"], r)
    check("bridge debug log went to the temp data dir", os.path.isfile(os.path.join(DDIR, "debug.log")))

    # -- online filters: OnlineFilters\ is read only, edits go to "<name>-local.filter" -----
    ODIR = os.path.join(FDIR, "OnlineFilters")
    check("online list: no folder -> empty", ff.list_online() == [])
    os.makedirs(ODIR)
    online = "#Online Item Filter\r\n#name: Neversink Strict\r\n#version:3.29\r\n#hash:aaa111\r\n#=====\r\nShow\r\n"
    with open(os.path.join(ODIR, "f00d1234"), "wb") as f:
        f.write(online.encode("utf-8"))
    with open(os.path.join(ODIR, "notes.txt"), "wb") as f:
        f.write(b"\xff\xfe not utf-8")  # skipped, not an error
    lst = api.filter_online_list()
    check("online list: one filter, name + version from its header", lst["ok"] and len(lst["filters"]) == 1
          and lst["filters"][0]["name"] == "Neversink Strict" and lst["filters"][0]["version"] == "aaa111"
          and lst["filters"][0]["local"] == "Neversink Strict-local.filter"
          and lst["filters"][0]["imported"] is False, lst)
    check("online read: bad id refused", api.filter_online_read("..\\gui.py")["ok"] is False)
    check("online read: path refused", api.filter_online_read("sub/x")["ok"] is False)
    check("status: not imported", api.filter_online_status("rs.filter") == {"ok": True, "imported": False,
                                                                           "name": "rs.filter"})
    imp = api.filter_online_import("f00d1234")
    local = "Neversink Strict-local.filter"
    check("import: local copy written, header renamed, CRLF kept", imp["ok"] and imp["local"] == local
          and raw(local) == online.replace("#name: Neversink Strict", "#name: Neversink Strict-local").encode(), imp)
    check("import: the online file is untouched", open(os.path.join(ODIR, "f00d1234"), "rb").read() == online.encode())
    check("import again without overwrite -> conflict", api.filter_online_import("f00d1234").get("conflict") is True)
    st = api.filter_online_status(local)
    check("status: imported, not changed", st["ok"] and st["imported"] and st["changed"] is False
          and st["online"] == "f00d1234", st)
    with open(os.path.join(ODIR, "f00d1234"), "wb") as f:
        f.write(online.replace("aaa111", "bbb222").encode("utf-8"))
    st = api.filter_online_status(local)
    check("status: the game downloaded a new version -> changed", st["changed"] and st["current"] == "bbb222", st)
    check("mark: baseline moves to the new version", api.filter_online_mark(local, "f00d1234", "bbb222")["ok"]
          and api.filter_online_status(local)["changed"] is False)
    check("mark: bad online id refused", api.filter_online_mark(local, "../x", "v")["ok"] is False)
    os.remove(os.path.join(ODIR, "f00d1234"))
    check("status: online file gone -> missing", api.filter_online_status(local)["missing"] is True)
    check("local name: unsafe characters replaced", ff.local_name_for('a:b/c?') == "a_b_c_-local.filter")
    check("local name: no double -local", ff.local_name_for("Main-local") == "Main-local.filter")
    check("local name: reserved name made safe", ff.local_name_for("CON") == "_CON-local.filter")

    # -- game commands: one chat command per call, names validated --------------------------
    class FakeSender:
        def __init__(self):
            self.sent = []

        def send(self, cmd):
            self.sent.append(cmd)
            return {"ok": True}
    api._sender = FakeSender()
    check("reload: one /reloaditemfilter", api.filter_reload()["ok"] and api._sender.sent == ["/reloaditemfilter"])
    check("switch: /itemfilter <name>, .filter dropped", api.filter_switch("Main-local.filter")["ok"]
          and api._sender.sent[-1] == "/itemfilter Main-local")
    check("switch: online names with spaces", api.filter_switch("Neversink Strict")["ok"]
          and api._sender.sent[-1] == "/itemfilter Neversink Strict")
    for bad in ["", "a\nb", "a\r/kick x", "..\\x", "a/b", "x" * 200]:
        n = len(api._sender.sent)
        check("switch refused: %r" % bad[:12], api.filter_switch(bad)["ok"] is False and len(api._sender.sent) == n)
    api._sender = None

    opened = []
    real_startfile = getattr(os, "startfile", None)
    os.startfile = lambda p, *a, **k: opened.append(p)
    try:
        r = api.filter_open_folder()
        check("bridge open folder: only the filter folder", r["ok"] and opened == [FDIR], (r, opened))
        ff.FILTER_DIR_OVERRIDE = os.path.join(root, "not there")
        r = api.filter_open_folder()
        check("bridge open folder: missing folder -> ok False, nothing opened", r["ok"] is False and len(opened) == 1, r)
        r = api.filter_list()
        check("bridge list: missing folder -> ok, exists False, empty", r["ok"] and r["exists"] is False
              and r["filters"] == [], r)
        ff.FILTER_DIR_OVERRIDE = FDIR
    finally:
        if real_startfile is not None:
            os.startfile = real_startfile
        else:
            del os.startfile
    check("real data dir untouched by these tests", not os.path.isdir(os.path.join(real_data_dir, "filter_checkpoints"))
          or not os.path.isdir(os.path.join(real_data_dir, "filter_checkpoints", "rs")))
finally:
    gui.DATA_DIR = real_data_dir
    ff.FILTER_DIR_OVERRIDE = None
    ff.DATA_DIR_OVERRIDE = None
    shutil.rmtree(root, ignore_errors=True)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
