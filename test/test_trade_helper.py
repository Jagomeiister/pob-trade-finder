"""Trade helper backend — run: python test/test_trade_helper.py

Client.txt parsing, log tailing (poll_once on a temp file), chat-key config,
chat command building, ChatSender with fake Win32 hooks (no real keys or
clipboard), Client.txt discovery with a fake exe lookup, stash cell geometry."""
import os
import shutil
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import trade_helper as th  # noqa: E402

failures = 0
try:
    sys.stdout.reconfigure(errors="backslashreplace")  # details hold non-ASCII names on a cp1252 console
except Exception:
    pass


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


check("import: no Win32 bound, no threads started", th._a is None and not any(
    t.name in ("client-log-tail", "stash-highlight") for t in threading.enumerate()))

P = "2026/11/01 13:01:03 123456789 cffb0734 [INFO Client 12345] "

# -- whispers -------------------------------------------------------------------
e = th.parse_line(P + "@From <<ART>™> SomeName: hello there")
check("whisper: guild tag with <, > and non-ASCII", e and e["type"] == "whisper" and e["guild"] == "<ART>™"
      and e["name"] == "SomeName" and e["text"] == "hello there" and e["dir"] == "in", e)
check("whisper: time kept", e and e["time"] == "2026/11/01 13:01:03", e)
check("whisper: plain chat has no trade", e and e["trade"] is None, e)
e = th.parse_line(P + "@From Ünïcode_Näme: hi")
check("whisper: no guild, unicode name", e and e["guild"] is None and e["name"] == "Ünïcode_Näme" and e["text"] == "hi", e)
e = th.parse_line(P + "@To <GG> Buyer_1: sure, 1 sec")
check("whisper: outgoing", e and e["dir"] == "out" and e["guild"] == "GG" and e["name"] == "Buyer_1", e)

# -- trade whispers -------------------------------------------------------------
e = th.parse_line(P + '@From <<ART>™> SomeName: Hi, I would like to buy your Tabula Rasa Simple Robe listed for '
                      '10 chaos in Settlers (stash tab "~price 10 chaos"; position: left 5, top 7) can you do 9?  ')
t = e and e["trade"]
check("item trade: all fields", t == {"kind": "item", "item": "Tabula Rasa Simple Robe", "price": 10.0,
                                      "currency": "chaos", "league": "Settlers", "tab": "~price 10 chaos",
                                      "left": 5, "top": 7, "count": None, "note": "can you do 9?"}, t)
t = th.parse_trade('Hi, I would like to buy your Headhunter Leather Belt listed for 1.5 divine in Hardcore Settlers '
                   '(stash tab "$$$"; position: left 12, top 1)')
check("item trade: decimal price, league with space, empty note",
      t and t["price"] == 1.5 and t["currency"] == "divine" and t["league"] == "Hardcore Settlers"
      and t["note"] == "" and t["left"] == 12 and t["top"] == 1, t)
t = th.parse_trade('Hi, I would like to buy your Kaom\'s Heart Glorious Plate in Standard (stash tab "sale"; '
                   'position: left 1, top 2)')
check("item trade: no price", t and t["kind"] == "item" and t["item"] == "Kaom's Heart Glorious Plate"
      and t["price"] is None and t["currency"] is None and t["league"] == "Standard" and t["tab"] == "sale", t)
t = th.parse_trade("Hi, I would like to buy your Goldrim Leather Cap listed for 3 chaos in Settlers")
check("item trade: no stash part", t and t["item"] == "Goldrim Leather Cap" and t["price"] == 3.0
      and t["league"] == "Settlers" and t["tab"] is None and t["left"] is None and t["top"] is None, t)
t = th.parse_trade("Hi, I would like to buy your Goldrim Leather Cap in Settlers.")
check("item trade: no price, no stash", t and t["item"] == "Goldrim Leather Cap" and t["league"] == "Settlers"
      and t["price"] is None, t)
e = th.parse_line(P + "@From Seller: Hi, I'd like to buy your 50 Chaos Orb for my 1 Divine Orb in Settlers. ty")
t = e and e["trade"]
check("bulk trade", t == {"kind": "bulk", "item": "Chaos Orb", "price": 1.0, "currency": "divine",
                          "league": "Settlers", "tab": None, "left": None, "top": None, "count": 50.0,
                          "note": "ty"}, t)
t = th.parse_trade("Hi, I'd like to buy your 1,200 Orb of Alteration for my 2.5 Exalted Orb in Standard")
check("bulk trade: thousands separator, no trailing dot", t and t["count"] == 1200.0 and t["price"] == 2.5
      and t["currency"] == "exalted" and t["league"] == "Standard" and t["note"] == "", t)
t = th.parse_trade("Hi, I'd like to buy your 10 Awakened Sextant for my 30 Some Weird Currency in Standard.")
check("bulk trade: unknown currency lowercased", t and t["currency"] == "some weird currency", t)
check("currency normalisation", [th.normalize_currency(c) for c in
                                 ("chaos", "Chaos Orb", "Divine Orb", "divine", "Exalted Orb", "exalted", "Mirror Shard")]
      == ["chaos", "chaos", "divine", "divine", "exalted", "exalted", "mirror shard"])
check("not a trade whisper", th.parse_trade("Hi, I would like to sell you stuff") is None
      and th.parse_trade("") is None and th.parse_trade(None) is None)

# -- system lines ---------------------------------------------------------------
cases = [
    (": SomeGuy has joined the area.", {"type": "joined", "name": "SomeGuy"}),
    (": SomeGuy has left the area.", {"type": "left", "name": "SomeGuy"}),
    (": Trade accepted.", {"type": "trade_accepted"}),
    (": Trade cancelled.", {"type": "trade_cancelled"}),
    (': AFK mode is now ON. Autoreply "This player is AFK."', {"type": "afk", "on": True}),
    (": AFK mode is now OFF.", {"type": "afk", "on": False}),
    (': DND mode is now ON. Autoreply "busy"', {"type": "dnd", "on": True}),
    (": DND mode is now OFF.", {"type": "dnd", "on": False}),
    (": You have entered Lioneye's Watch.", {"type": "zone", "area": "Lioneye's Watch"}),
]
for msg, want in cases:
    want = dict(want, time="2026/11/01 13:01:03")
    got = th.parse_line(P + msg)
    check("system line: " + want["type"] + (" " + str(want.get("on")) if "on" in want else ""), got == want, got)

garbage = ["", None, "random text", P, P + "#Global: hi", P + "$Trade: wtb stuff", P + "Local: SomeGuy has joined the area.",
           "2026/11/01 13:01:03 nonsense", P + "@From : x", P + "@From <x> : y", b"bytes", 12345,
           P + "[SCENE] Set Source [Lioneye's Watch]", P + ": Trade accepted. extra", "\x00\xff" * 50]
check("garbage lines -> None", all(th.parse_line(g) is None for g in garbage),
      [g for g in garbage if th.parse_line(g) is not None])

# -- LogTail --------------------------------------------------------------------
tmp = tempfile.mkdtemp(prefix="th_test_")
log = os.path.join(tmp, "Client.txt")


def append(data, mode="ab"):
    with open(log, mode) as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))


append(P + "@From Old: Hi, I would like to buy your Old Thing in Standard\n" * 3, "wb")
events, errors = [], []
tail = th.LogTail(log, events.append, on_error=errors.append)
check("tail: first poll primes at the end (history ignored)", tail.poll_once() == [] and events == [])
check("tail: nothing new", tail.poll_once() == [])
append(P + "@From New: hello\n" + P + ": Trade accepted.\n" + "junk line\n")
got = tail.poll_once()
check("tail: appended lines parsed", [e["type"] for e in events] == ["whisper", "trade_accepted"]
      and events[0]["name"] == "New" and got == events, events)
append(P + "@From Part: first half")
check("tail: partial line held", tail.poll_once() == [] and len(events) == 2)
append(" second half\r\n")
got = tail.poll_once()
check("tail: partial completed + CRLF stripped", len(got) == 1 and got[0]["text"] == "first half second half", got)
append(b"\xff\xfe\x00 broken utf8 \x80\n" + (P + "@From Bad: caf\xc3\xa9 \xff\n").encode("latin-1"))
got = tail.poll_once()
check("tail: bad bytes decoded with replacement", len(got) == 1 and got[0]["name"] == "Bad"
      and got[0]["text"].startswith("café"), got)
append(P + ": DND mode is now ON.\n", "wb")  # file replaced by a shorter one
got = tail.poll_once()
check("tail: truncation resets to start", len(got) == 1 and got[0]["type"] == "dnd", got)
check("tail: no errors so far", errors == [], errors)

boom = []


def bad_handler(ev):
    raise RuntimeError("handler broke")


tail2 = th.LogTail(log, bad_handler, on_error=boom.append)
tail2.poll_once()
append(P + ": Trade cancelled.\n")
check("tail: handler exception reported, not raised", len(tail2.poll_once()) == 1 and boom and "handler broke" in boom[0], boom)

missing = os.path.join(tmp, "nope", "Client.txt")
merr, mev = [], []
tail3 = th.LogTail(missing, mev.append, on_error=merr.append)
for _ in range(3):
    tail3.poll_once()
check("tail: missing file reported once", len(merr) == 1, merr)
os.makedirs(os.path.dirname(missing))
with open(missing, "wb") as f:
    f.write((P + "@From Before: x\n").encode())
tail3.poll_once()
with open(missing, "ab") as f:
    f.write((P + "@From After: y\n").encode())
tail3.poll_once()
check("tail: file appearing later starts at its end", [e["name"] for e in mev] == ["After"], mev)

tev = []
tail4 = th.LogTail(log, tev.append, poll=0.02)
tail4.start()
check("tail: running after start", tail4.running)
append(P + ": You have entered The Coast.\n")
deadline = time.time() + 3
while not tev and time.time() < deadline:
    time.sleep(0.02)
tail4.stop()
check("tail: thread delivers events", [e.get("area") for e in tev] == ["The Coast"], tev)
check("tail: stopped", not tail4.running)

# -- read_chat_key --------------------------------------------------------------


def ini(name, data):
    p = os.path.join(tmp, name)
    with open(p, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))
    return p


check("chat key: chat=13", th.read_chat_key(ini("a.ini", "[GENERAL]\nx=1\n[ACTION_KEYS]\nchat=13\n")) == 13)
check("chat key: 'chat=84 0' -> 84", th.read_chat_key(ini("b.ini", "[ACTION_KEYS]\nopen_inventory=73 0\nchat=84 0\n")) == 84)
check("chat key: missing section -> 13", th.read_chat_key(ini("c.ini", "[GENERAL]\nchat=84\n")) == 13)
check("chat key: UTF-8 BOM", th.read_chat_key(ini("d.ini", b"\xef\xbb\xbf[ACTION_KEYS]\r\nchat=84 0\r\n")) == 84)
check("chat key: UTF-16", th.read_chat_key(ini("e.ini", "[ACTION_KEYS]\nchat=89\n".encode("utf-16"))) == 89)
check("chat key: duplicate keys/sections tolerated",
      th.read_chat_key(ini("f.ini", "[ACTION_KEYS]\nchat=84\nchat=85\n[ACTION_KEYS]\nother=1\n")) in (84, 85))
check("chat key: malformed file (no header first)", th.read_chat_key(ini("g.ini", "junk\n[ACTION_KEYS]\nchat=84\n")) == 84)
check("chat key: bad value -> 13", th.read_chat_key(ini("h.ini", "[ACTION_KEYS]\nchat=abc\n")) == 13)
check("chat key: latin-1 junk bytes", th.read_chat_key(ini("i.ini", b"[GENERAL]\nname=\xe9\xff\n[ACTION_KEYS]\nchat=84\n")) == 84)
check("chat key: missing file -> 13", th.read_chat_key(os.path.join(tmp, "missing.ini")) == 13)
before = open(os.path.join(tmp, "b.ini"), "rb").read()
th.read_chat_key(os.path.join(tmp, "b.ini"))
check("chat key: config file not modified", open(os.path.join(tmp, "b.ini"), "rb").read() == before)

# -- command_for ----------------------------------------------------------------
check("command: invite", th.command_for("invite", "Some_Name1") == "/invite Some_Name1")
check("command: kick/trade/hideout/whois/ignore",
      [th.command_for(a, "Bob") for a in ("kick", "trade", "hideout", "whois", "ignore")]
      == ["/kick Bob", "/tradewith Bob", "/hideout Bob", "/whois Bob", "/ignore Bob"])
check("command: accented name", th.command_for("trade", "Ünïcode_Näme") == "/tradewith Ünïcode_Näme")
check("command: whisper", th.command_for("whisper", "Bob", "  sold, sorry ") == "@Bob sold, sorry")
check("command: whisper newlines stripped", th.command_for("whisper", "Bob", "one\r\ntwo\nthree\rfour")
      == "@Bob one two three four")


def raises(fn, *a):
    try:
        fn(*a)
    except ValueError:
        return True
    return False


for bad in ("a b", "x\n/kick y", "@x", "", "x:y", "a/b", "x\n", "a" * 41, None, 5):
    check("command: rejects name %r" % (bad,), raises(th.command_for, "invite", bad))
check("command: 40-char name ok", th.command_for("invite", "a" * 40) == "/invite " + "a" * 40)
check("command: unknown action", raises(th.command_for, "trade_all", "Bob") and raises(th.command_for, "", "Bob"))
check("command: empty whisper", raises(th.command_for, "whisper", "Bob", " \r\n ") and raises(th.command_for, "whisper", "Bob"))
check("command: whisper too long", raises(th.command_for, "whisper", "Bob", "x" * 301)
      and th.command_for("whisper", "Bob", "x" * 300) == "@Bob " + "x" * 300)

# -- ChatSender (fakes only) ----------------------------------------------------
CTRL, A, V, ENTER = 0x11, 0x41, 0x56, 0x0D


class FakeWin:
    def __init__(self, clip="old clip", focus_ok=True, mismatch=False, fail_set=None):
        self.log, self.clip, self.focus_ok, self.mismatch, self.fail_set = [], clip, focus_ok, mismatch, fail_set
        self.fg = 1

    def foreground(self):
        return self.fg

    def focus(self, hwnd):
        self.log.append(("focus", hwnd))
        if self.focus_ok:
            self.fg = hwnd
        return self.focus_ok

    def key(self, vk, up=False):
        self.log.append(("key", vk, up))

    def get_clipboard(self):
        self.log.append(("getclip",))
        return self.clip

    def set_clipboard(self, text):
        self.log.append(("setclip", text))
        if text == self.fail_set:
            raise RuntimeError("clipboard busy")
        self.clip = text

    def elevation_mismatch(self, hwnd):
        return self.mismatch


def tap(vk, ctrl=False):
    keys = [("key", vk, False), ("key", vk, True)]
    return [("key", CTRL, False)] + keys + [("key", CTRL, True)] if ctrl else keys


def sender(win, game=777, vk=ENTER):
    return th.ChatSender(find_game=lambda: game, chat_vk=vk, sleep=lambda s: win.log.append(("sleep", s)), win=win)


def no_sleep(log):
    return [x for x in log if x[0] != "sleep"]


w = FakeWin()
r = sender(w).send("/invite Bob")
want = ([("getclip",), ("focus", 777)] + tap(ENTER) + tap(A, True) + [("setclip", "/invite Bob")]
        + tap(V, True) + tap(ENTER) + [("setclip", "old clip")])
check("sender: ok", r == {"ok": True, "error": None}, r)
check("sender: exact sequence", no_sleep(w.log) == want, no_sleep(w.log))
check("sender: clipboard restored", w.clip == "old clip")
last_enter = max(i for i, x in enumerate(w.log) if x == ("key", ENTER, True))
check("sender: waits before restoring clipboard", any(x[0] == "sleep" and x[1] >= 0.2 for x in w.log[last_enter:]), w.log)
check("sender: short sleeps between steps", all(x[1] <= 0.3 for x in w.log if x[0] == "sleep")
      and sum(1 for x in w.log if x[0] == "sleep") >= 5)

w = FakeWin()
r = sender(w).paste_search('"!ege|abi" "m q.*(\\d{3}|[6-9]\\d)%"')
want = ([("getclip",), ("focus", 777)] + tap(0x46, True) + tap(A, True) +
        [("setclip", '"!ege|abi" "m q.*(\\d{3}|[6-9]\\d)%"')] + tap(V, True) + [("setclip", "old clip")])
check("search paste: Ctrl+F, Ctrl+A, paste, no Enter, clipboard back", r["ok"] and no_sleep(w.log) == want,
      no_sleep(w.log))
w = FakeWin()
check("search paste: refuses two lines / empty", not sender(w).paste_search("a\nb")["ok"] and
      not sender(w).paste_search("  ")["ok"] and not any(x[0] == "key" for x in w.log), w.log)

w = FakeWin()
sender(w, vk=84).send("@Bob hi")
check("sender: custom chat key", no_sleep(w.log)[2:4] == tap(84), no_sleep(w.log))

orig = th.read_chat_key
th.read_chat_key = lambda config_path=None: 89
w = FakeWin()
th.ChatSender(find_game=lambda: 5, sleep=lambda s: None, win=w).send("/kick Bob")
th.read_chat_key = orig
check("sender: chat key read from config when not given", no_sleep(w.log)[2:4] == tap(89), w.log)

w = FakeWin(clip=None)
r = sender(w).send("/hideout Bob")
check("sender: no text on clipboard -> nothing to restore", r["ok"] and w.log[-1] != ("setclip", None), w.log)

w = FakeWin()
r = sender(w, game=0).send("/invite Bob")
check("sender: no game -> error", not r["ok"] and r["error"] == "Path of Exile isn't running", r)
check("sender: no game -> no keys, clipboard untouched", not any(x[0] in ("key", "setclip", "focus") for x in w.log)
      and w.clip == "old clip", w.log)

w = FakeWin(mismatch=True)
r = sender(w).send("/invite Bob")
check("sender: elevation mismatch -> error", not r["ok"] and "administrator" in r["error"], r)
check("sender: elevation mismatch -> no keys", not any(x[0] in ("key", "setclip", "focus") for x in w.log)
      and w.clip == "old clip", w.log)

w = FakeWin(focus_ok=False)
r = sender(w).send("/invite Bob")
check("sender: focus failure -> error", not r["ok"] and "front" in r["error"], r)
check("sender: focus failure -> no keys, clipboard intact", not any(x[0] == "key" for x in w.log)
      and w.clip == "old clip", w.log)

w = FakeWin(fail_set="/invite Bob")
r = sender(w).send("/invite Bob")
i = w.log.index(("setclip", "/invite Bob"))
check("sender: clipboard failure -> error", not r["ok"] and "clipboard busy" in r["error"], r)
check("sender: clipboard failure -> no keys after it", not any(x[0] == "key" for x in w.log[i:]), w.log[i:])
check("sender: clipboard failure -> previous text restored", w.clip == "old clip" and w.log[-1] == ("setclip", "old clip"))

for bad in ("", "   ", "/invite a\n/kick b", "/invite a\r", None, "x" * 600):
    w = FakeWin()
    r = sender(w).send(bad)
    check("sender: rejects %r" % (bad if not isinstance(bad, str) or len(bad) < 40 else bad[:10] + "..."),
          not r["ok"] and w.log == [], r)

w = FakeWin()
s = th.ChatSender(find_game=lambda: 9, chat_vk=ENTER, sleep=lambda x: time.sleep(0.001), win=w)
results = []
threads = [threading.Thread(target=lambda c=c: results.append(s.send(c))) for c in ("/invite A", "/invite B", "/kick C")]
for t_ in threads:
    t_.start()
for t_ in threads:
    t_.join()
blocks = no_sleep(w.log)
starts = [i for i, x in enumerate(blocks) if x == ("getclip",)]
seqs = [blocks[a:b] for a, b in zip(starts, starts[1:] + [len(blocks)])]
check("sender: concurrent calls serialized, never interleaved",
      len(results) == 3 and all(r["ok"] for r in results) and len(seqs) == 3
      and all(len(q) == len(want) and q[0] == ("getclip",) and q[-1] == ("setclip", "old clip") for q in seqs), blocks)
check("sender: one command per call", sorted(x[1] for x in blocks if x[0] == "setclip" and x[1] != "old clip")
      == ["/invite A", "/invite B", "/kick C"])

# -- find_client_log (fake exe lookup) ------------------------------------------


def mklog(folder, name="Client.txt"):
    os.makedirs(os.path.join(folder, "logs"), exist_ok=True)
    p = os.path.join(folder, "logs", name)
    open(p, "w").close()
    return p


steam = os.path.join(tmp, "steam game")
want_log = mklog(steam)
got = th.find_client_log(123, exe_path_of=lambda h: os.path.join(steam, "PathOfExile_x64Steam.exe"), common_dirs=())
check("client log: from the game exe", got == want_log, got)
kg = os.path.join(tmp, "kakao")
mklog(kg)
want_kg = mklog(kg, "KakaoClient.txt")
got = th.find_client_log(123, exe_path_of=lambda h: os.path.join(kg, "PathOfExile_x64_KG.exe"), common_dirs=())
check("client log: Kakao client prefers KakaoClient.txt", got == want_kg, got)
extra = os.path.join(tmp, "extra")
want_extra = mklog(extra)
got = th.find_client_log(123, extra_dirs=[extra], exe_path_of=lambda h: r"C:\Windows\notepad.exe", common_dirs=())
check("client log: unknown exe ignored, extra dir used", got == want_extra, got)
got = th.find_client_log(123, exe_path_of=lambda h: None, common_dirs=[os.path.join(tmp, "x"), steam])
check("client log: common dirs fallback", got == want_log, got)


def boom_exe(h):
    raise OSError("access denied")


check("client log: nothing found -> None", th.find_client_log(123, exe_path_of=boom_exe, common_dirs=()) is None)

# -- stash geometry -------------------------------------------------------------
G1080, G1440 = (0, 0, 1920, 1080), (100, 50, 2560, 1440)
check("stash 1080p: first cell", th.stash_cell_rect(G1080, 1, 1) == (16, 127, 53, 53), th.stash_cell_rect(G1080, 1, 1))
check("stash 1080p: last cell", th.stash_cell_rect(G1080, 12, 12) == (599, 710, 53, 53), th.stash_cell_rect(G1080, 12, 12))
x, y, w_, h_ = th.stash_cell_rect(G1080, 1, 1, quad=True)
check("stash 1080p: quad first cell is half size", (x, y) == (16, 127) and w_ in (26, 27) and h_ in (26, 27), (x, y, w_, h_))
x, y, w_, h_ = th.stash_cell_rect(G1080, 13, 2)
check("stash 1080p: auto-quad when left > 12", abs(x - (16 + 12 * 26.5)) <= 1 and abs(y - (127 + 26.5)) <= 1
      and w_ in (26, 27), (x, y, w_, h_))
qx, qy, qw, qh = th.stash_cell_rect(G1080, 24, 24)
nx, ny, nw, nh = th.stash_cell_rect(G1080, 12, 12)
check("stash 1080p: quad and normal grids end at the same edge", qx + qw == nx + nw and qy + qh == ny + nh)
check("stash 1440p: first cell, offset by the game position", th.stash_cell_rect(G1440, 1, 1) == (121, 219, 71, 71),
      th.stash_cell_rect(G1440, 1, 1))
x, y, w_, h_ = th.stash_cell_rect(G1440, 12, 12)
check("stash 1440p: last cell", abs(x - (100 + 1440 * (16 + 11 * 53) / 1080)) <= 1
      and abs(y - (50 + 1440 * (127 + 11 * 53) / 1080)) <= 1 and w_ in (70, 71), (x, y, w_, h_))
x, y, w_, h_ = th.stash_cell_rect(G1440, 3, 20)
check("stash 1440p: auto-quad when top > 12", abs(x - (100 + 1440 * (16 + 2 * 26.5) / 1080)) <= 1
      and abs(y - (50 + 1440 * (127 + 19 * 26.5) / 1080)) <= 1 and w_ in (35, 36), (x, y, w_, h_))
check("stash: out-of-range positions rejected", raises(th.stash_cell_rect, G1080, 0, 1)
      and raises(th.stash_cell_rect, G1080, 25, 1) and raises(th.stash_cell_rect, G1080, 13, 1, False))

check("still nothing Win32-bound or threaded after pure tests",
      th._a is None and not any(t.name == "stash-highlight" for t in threading.enumerate()))
shutil.rmtree(tmp, ignore_errors=True)
print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
