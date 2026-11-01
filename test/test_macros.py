"""Chat macros — run: python test/test_macros.py

Api.chat_macro sends exactly one chat command per call (a fake sender records them), only
for one-line commands starting with /. Api.set_macros cleans the list and refuses a hotkey
another hotkey or macro already uses."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import gui  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


class FakeSender:
    def __init__(self):
        self.sent = []

    def send(self, cmd):
        self.sent.append(cmd)
        return {"ok": True}


api = gui.Api()
api._start_macro_hotkeys = lambda: None  # no real hotkey threads in a test
api._sender = FakeSender()

check("sends one command", api.chat_macro("/delve") == {"ok": True} and api._sender.sent == ["/delve"], api._sender.sent)
check("command with an argument", api.chat_macro("/kick SomeName")["ok"] and api._sender.sent[-1] == "/kick SomeName")
for bad in ["delve", "/delve\n/exit", "", "@Buyer hi", "/" + "x" * 50, "/de\rlve"]:
    n = len(api._sender.sent)
    r = api.chat_macro(bad)
    check("refused: %r" % bad[:20], r["ok"] is False and len(api._sender.sent) == n, r)

r = api.set_macros(json.dumps([
    {"label": "Delve", "command": "/delve", "hotkey": "f2"},
    {"label": "Exit", "command": "/exit", "hotkey": "f2"},           # same key as the one above
    {"label": "Menagerie", "command": "/menagerie", "hotkey": "ctrl+d"},  # the price-check key
    {"label": "Bad", "command": "kingsmarch", "hotkey": "off"},       # no slash
    {"label": "Kings", "command": "/kingsmarch", "hotkey": "d"},      # bare letter: refused
]))
keys = {m["command"]: m["hotkey"] for m in r["macros"]}
check("set_macros keeps valid ones", r["ok"] and set(keys) == {"/delve", "/exit", "/menagerie", "/kingsmarch"}, keys)
check("first f2 kept, clash turned off", keys["/delve"] == "f2" and keys["/exit"] == "off", keys)
check("can't take the price-check hotkey", keys["/menagerie"] == "off", keys)
check("bare letter hotkey refused", keys["/kingsmarch"] == "off", keys)
check("problems reported", len(r["errors"]) == 4, r["errors"])
r = api.set_hotkey("sheet", "f2")
check("other hotkeys can't take a macro's key", r["ok"] is False and "already used" in r["error"], r)
check("at most 12 macros", len(api.set_macros(json.dumps([{"command": "/delve"}] * 20))["macros"]) == 12)

print("ALL TESTS PASSED" if not failures else "%d FAILED" % failures)
sys.exit(1 if failures else 0)
