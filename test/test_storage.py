"""Durable storage (gui.Api storage_set / _load_storage) — run: python test/test_storage.py

Saves are atomic and serialised; a damaged storage.json is set aside and the backup is used."""
import json
import os
import sys
import tempfile
import threading

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
sys.path.insert(0, ROOT)
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail and not cond else ""))


def api(path):
    a = gui.Api.__new__(gui.Api)
    a._storage_path = path
    a._storage_lock = threading.Lock()
    a._storage = gui.Api._load_storage(path)
    return a


with tempfile.TemporaryDirectory() as td:
    path = os.path.join(td, "storage.json")
    a = api(path)
    check("empty start", a.storage_get() == {"ok": True, "data": {}})
    check("set saves", a.storage_set("k", "v")["ok"] and json.load(open(path)) == {"k": "v"})
    a.storage_set("k2", "v2")
    check("the previous state is kept as .bak", json.load(open(path + ".bak")) == {"k": "v"})
    check("no temp file left", not os.path.exists(path + ".tmp"))
    got = a.storage_get()["data"]
    got["x"] = 1
    check("storage_get hands out a copy", "x" not in a._storage)

    # many threads, many keys: every key lands and the file is whole
    def work(n):
        for i in range(40):
            a.storage_set("t%d-%d" % (n, i), "x" * 200)
    ts = [threading.Thread(target=work, args=(n,)) for n in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    disk = json.load(open(path))
    check("concurrent saves: all 320 keys on disk, file parses", sum(k.startswith("t") for k in disk) == 320, len(disk))

    # a damaged file: set aside, the backup loads, and the next save doesn't wipe anything
    good = dict(disk)
    with open(path, "w") as f:
        f.write('{"k": "v", "broken')
    b = api(path)
    bad = [f for f in os.listdir(td) if ".bad-" in f]
    check("damaged file is set aside, not deleted", len(bad) == 1 and not os.path.exists(path), os.listdir(td))
    check("the backup is loaded (one save behind at most)", len(b._storage) >= len(good) - 1 and b._storage.get("k") == "v", len(b._storage))
    b.storage_set("after", "1")
    check("the next save keeps the recovered data", len(json.load(open(path))) >= len(good), len(json.load(open(path))))

    # crash between the two renames: only the .bak exists
    os.remove(path)
    c = api(path)
    check("missing main file: the backup loads", c._storage.get("k") == "v")

    # not an object
    with open(path, "w") as f:
        f.write("[1, 2]")
    os.remove(path + ".bak")
    d = api(path)
    check("a non-object file is set aside and the store starts empty", d._storage == {} and not os.path.exists(path))

print("\n" + ("ALL TESTS PASSED" if not failures else "%d FAILED" % failures))
sys.exit(1 if failures else 0)
