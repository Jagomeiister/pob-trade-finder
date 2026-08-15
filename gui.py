"""PoB Trade Finder — desktop GUI.

Wraps the web app in a native window (Edge WebView2 via pywebview) and exposes
a Python bridge for things the browser can't do: fetching share links without
CORS, querying the trade API for live prices, refreshing the bundled stat
database, and opening searches in the system browser.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile

import webview

VERSION = "1.7.4"
GITHUB_OWNER = "Jagomeiister"
GITHUB_REPO = "pob-trade-finder"

# Frozen (PyInstaller) exe lives next to index.html/js/data — same layout as source
if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PoB-Trade-Finder/1.0"
TRADE_BASE = "https://www.pathofexile.com/api/trade"

# GGG rate limits are strict; space all trade API calls out and honour 429s.
MIN_INTERVAL = 2.5


class Api:
    def __init__(self):
        self._lock = threading.Lock()
        self._last_call = 0.0
        self._blocked_until = 0.0  # global hold-off from 429s / quota headers
        self._rate_cache = {}  # league -> {currency: (chaos_rate, fetched_at)}
        self._unique_icons_path = os.path.join(DATA_DIR, "unique_icons.json")
        try:
            with open(self._unique_icons_path, "r", encoding="utf-8") as f:
                self._unique_icons = json.load(f)
        except Exception:
            self._unique_icons = {}
        self._session_path = os.path.join(DATA_DIR, "session.json")
        self._poesessid = ""
        try:
            with open(self._session_path, "r", encoding="utf-8") as f:
                self._poesessid = (json.load(f).get("poesessid") or "").strip()
        except Exception:
            pass
        self._live_subs = {}  # searchId -> {'queue': [], 'status': str, 'ws': app}
        # durable key-value store: the exe's WebView2 localStorage is ephemeral
        # (onefile temp dirs), so persistence lives here instead
        self._storage_path = os.path.join(DATA_DIR, "storage.json")
        try:
            with open(self._storage_path, "r", encoding="utf-8") as f:
                self._storage = json.load(f)
        except Exception:
            self._storage = {}

    # -- shared HTTP helper: quota-aware throttle, global 429 lockout ------------
    def _read_quota(self, headers):
        """Parse X-Rate-Limit headers and return seconds to hold off before the
        NEXT call so we never trip a window. GGG reports every active rule."""
        hold = 0.0
        rules = (headers.get("X-Rate-Limit-Rules") or "").split(",")
        for rule in [r.strip() for r in rules if r.strip()]:
            limits = (headers.get("X-Rate-Limit-%s" % rule) or "").split(",")
            states = (headers.get("X-Rate-Limit-%s-State" % rule) or "").split(",")
            for lim, st in zip(limits, states):
                try:
                    lmax, lperiod, _ = (int(x) for x in lim.split(":"))
                    hits, _, restricted = (int(x) for x in st.split(":"))
                except ValueError:
                    continue
                if restricted > 0:
                    hold = max(hold, restricted)
                elif hits >= lmax - 1:      # one call from the cap — wait the window out
                    hold = max(hold, lperiod)
                elif hits >= lmax * 0.6:    # over 60% used — pace to the window rate
                    hold = max(hold, lperiod / max(1, lmax))
        return hold

    BG_INTERVAL = 6.0  # background (icon prefetch) calls pace far gentler

    def _http(self, url, payload=None, background=False):
        with self._lock:
            now = time.time()
            hold = self._blocked_until - now
            if background and hold > 0:
                # background work never competes during any cooldown
                raise RuntimeError("cooldown — background fetch skipped")
            if hold > 30:
                # long cooldown (rate-limit penalty) — fail fast with a countdown
                # instead of stacking sleeping threads that hammer on wake
                raise RuntimeError("GGG rate-limit cooldown — %dm %ds remaining"
                                   % (int(hold) // 60, int(hold) % 60))
            interval = self.BG_INTERVAL if background else MIN_INTERVAL
            wait = max(interval - (now - self._last_call), hold)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.time()
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"User-Agent": UA, "Content-Type": "application/json"}
        # logged-in trade requests get higher rate and query-complexity budgets
        # (needed for weight-group searches); cookie goes only to pathofexile.com
        if self._poesessid and "pathofexile.com" in url:
            headers["Cookie"] = "POESESSID=" + self._poesessid
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                hold = self._read_quota(resp.headers)
                if hold > 0:
                    with self._lock:
                        self._blocked_until = max(self._blocked_until, time.time() + hold)
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                retry = int(e.headers.get("Retry-After", "60"))
                # global lockout: EVERY caller (price checks, live, watcher, icons)
                # waits it out — no retry hammering, which extends GGG bans
                with self._lock:
                    self._blocked_until = max(self._blocked_until, time.time() + retry)
                raise RuntimeError("GGG rate limit hit — cooling down %ss, then try again" % retry)
            body = ""
            try:
                body = e.read().decode("utf-8", "replace")[:200]
            except Exception:
                pass
            raise RuntimeError("HTTP %s: %s" % (e.code, body or e.reason))

    # -- link fetching ---------------------------------------------------------
    def fetch_pob_link(self, url):
        """Fetch a PoB export code from a share link."""
        try:
            candidates = []
            m = re.search(r"pobb\.in/([A-Za-z0-9_-]+)", url)
            if m:
                candidates.append("https://pobb.in/%s/raw" % m.group(1))
            m = re.search(r"pastebin\.com/(?:raw/)?([A-Za-z0-9]+)", url)
            if m:
                candidates.append("https://pastebin.com/raw/%s" % m.group(1))
            m = re.search(r"poe\.ninja/pob/([A-Za-z0-9]+)", url)
            if m:
                candidates.append("https://poe.ninja/pob/raw/%s" % m.group(1))
            # Only fetch from known PoB-sharing hosts — never arbitrary URLs.
            if url.startswith("http"):
                host = (urllib.parse.urlparse(url).hostname or "").lower()
                allowed = ("pobb.in", "pastebin.com", "poe.ninja")
                if any(host == a or host.endswith("." + a) for a in allowed):
                    candidates.append(url)

            last_err = "unsupported link — paste a pobb.in, pastebin, or poe.ninja URL (or the raw code)"
            for cand in candidates:
                try:
                    req = urllib.request.Request(cand, headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        body = resp.read().decode("utf-8", "replace").strip()
                    if len(body) > 100 and re.fullmatch(r"[A-Za-z0-9_\-=+/\s]+", body):
                        return {"ok": True, "code": body}
                    last_err = "response was not a PoB code (%s)" % cand
                except Exception as e:
                    last_err = "%s (%s)" % (e, cand)
            return {"ok": False, "error": last_err}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- live price check ------------------------------------------------------
    PAGE_SIZE = 10  # trade fetch endpoint maximum per call

    @staticmethod
    def _listing_from(r):
        li = r.get("listing", {})
        it = r.get("item", {})
        price = li.get("price") or {}
        ext = it.get("extended") or {}
        return {
            "basePercentile": ext.get("base_defence_percentile"),
            "dps": ext.get("dps"),
            "pdps": ext.get("pdps"),
            "edps": ext.get("edps"),
            "id": r.get("id", ""),
            "name": (it.get("name") or "").strip(),
            "base": it.get("typeLine", ""),
            "frameType": it.get("frameType", 2),
            "icon": it.get("icon", ""),
            "ilvl": it.get("ilvl", 0),
            "corrupted": bool(it.get("corrupted")),
            "identified": it.get("identified", True),
            "sockets": it.get("sockets", []),
            "properties": it.get("properties", []),
            "additionalProperties": it.get("additionalProperties", []),
            "searing": bool(it.get("searing")),
            "tangled": bool(it.get("tangled")),
            "synthesised": bool(it.get("synthesised")),
            "veiledMods": it.get("veiledMods", []),
            "implicitMods": it.get("implicitMods", []),
            "enchantMods": it.get("enchantMods", []),
            "fracturedMods": it.get("fracturedMods", []),
            "explicitMods": it.get("explicitMods", []),
            "craftedMods": it.get("craftedMods", []),
            "amount": price.get("amount"),
            "currency": price.get("currency", ""),
            "priceType": price.get("type", ""),
            "fee": li.get("fee"),  # instant-buyout gold fee (None for in-person)
            "account": (li.get("account") or {}).get("name", ""),
            "whisper": li.get("whisper", ""),
        }

    def trade_search(self, league, payload_json):
        """Run a trade search: first page of listings + the full id list so the
        UI can page through the rest via trade_fetch."""
        try:
            payload = json.loads(payload_json)
            search = self._http("%s/search/%s" % (TRADE_BASE, urllib.request.quote(league)), payload)
            ids = search.get("result", [])[:100]
            total = search.get("total", len(search.get("result", [])))
            listings = []
            if ids:
                fetched = self._http("%s/fetch/%s?query=%s"
                                     % (TRADE_BASE, ",".join(ids[:self.PAGE_SIZE]), search["id"]))
                listings = [self._listing_from(r) for r in fetched.get("result", []) if r]
            return {"ok": True, "total": total, "searchId": search["id"],
                    "ids": ids, "pageSize": self.PAGE_SIZE, "listings": listings}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trade_fetch(self, search_id, ids_json):
        """Fetch one further page of listings for an existing search."""
        try:
            if not re.fullmatch(r"[A-Za-z0-9]{1,32}", search_id or ""):
                return {"ok": False, "error": "bad search id"}
            ids = json.loads(ids_json)[:self.PAGE_SIZE]
            if not ids or not all(re.fullmatch(r"[a-f0-9]{16,80}", i or "") for i in ids):
                return {"ok": False, "error": "bad listing ids"}
            fetched = self._http("%s/fetch/%s?query=%s" % (TRADE_BASE, ",".join(ids), search_id))
            return {"ok": True, "listings": [self._listing_from(r) for r in fetched.get("result", []) if r]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- character import (public profiles; no auth) ------------------------------
    def _char_get(self, path, params):
        url = "https://www.pathofexile.com/character-window/%s?%s" % (
            path, urllib.parse.urlencode(params))
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read().decode("utf-8")
            if body.lstrip().startswith("<"):
                raise RuntimeError("unexpected response — check the account name (Name#1234)")
            return json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise RuntimeError("profile is private — set 'Hide characters' off on pathofexile.com, or check the name")
            if e.code == 404:
                raise RuntimeError("account not found — use the full name, e.g. Name#1234")
            raise RuntimeError("HTTP %s" % e.code)

    def get_characters(self, account):
        try:
            chars = self._char_get("get-characters", {"accountName": account, "realm": "pc"})
            return {"ok": True, "characters": [
                {"name": c.get("name"), "league": c.get("league"),
                 "level": c.get("level"), "class": c.get("class")}
                for c in chars if isinstance(c, dict)]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_character_items(self, account, character):
        try:
            d = self._char_get("get-items", {"accountName": account,
                                             "character": character, "realm": "pc"})
            items = []
            for it in d.get("items", []):
                items.append({
                    "inventoryId": it.get("inventoryId"),
                    "x": it.get("x", 0),
                    "name": (it.get("name") or "").strip(),
                    "base": it.get("typeLine", ""),
                    "frameType": it.get("frameType", 2),
                    "icon": it.get("icon", ""),
                    "ilvl": it.get("ilvl", 0),
                    "corrupted": bool(it.get("corrupted")),
                    "implicitMods": it.get("implicitMods", []),
                    "explicitMods": it.get("explicitMods", []),
                    "craftedMods": it.get("craftedMods", []),
                    "enchantMods": it.get("enchantMods", []),
                    "fracturedMods": it.get("fracturedMods", []),
                })
            return {"ok": True, "items": items}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- unique item art: one trade lookup per unique, cached on disk forever ----
    def unique_icon(self, name, base):
        try:
            if not name:
                return {"ok": False, "error": "no name"}
            cached = self._unique_icons.get(name)
            if cached:
                return {"ok": True, "icon": cached}
            query = {"query": {"status": {"option": "any"}, "name": name}}
            if base and base != name:
                query["query"]["type"] = base
            # Standard has every unique ever — league items may not exist yet
            search = self._http(TRADE_BASE + "/search/Standard", query, background=True)
            ids = search.get("result", [])[:1]
            if not ids:
                return {"ok": False, "error": "no listings found"}
            fetched = self._http("%s/fetch/%s?query=%s" % (TRADE_BASE, ids[0], search["id"]),
                                 background=True)
            for r in fetched.get("result", []):
                icon = (r or {}).get("item", {}).get("icon", "")
                if icon:
                    self._unique_icons[name] = icon
                    try:
                        with open(self._unique_icons_path, "w", encoding="utf-8") as f:
                            json.dump(self._unique_icons, f)
                    except Exception:
                        pass
                    return {"ok": True, "icon": icon}
            return {"ok": False, "error": "no icon in listing"}
        except Exception as e:
            try:
                with open(os.path.join(DATA_DIR, "debug.log"), "a", encoding="utf-8") as f:
                    f.write("%s unique_icon(%r): %s\n" % (time.strftime("%H:%M:%S"), name, e))
            except Exception:
                pass
            return {"ok": False, "error": str(e)}

    def gem_icon(self, name):
        """Proper single-frame gem art via one trade lookup (RePoE gem art is
        often a multi-frame atlas). Cached forever alongside unique icons."""
        try:
            key = "gem::" + name
            cached = self._unique_icons.get(key)
            if cached:
                return {"ok": True, "icon": cached}
            search = self._http(TRADE_BASE + "/search/Standard",
                                {"query": {"status": {"option": "any"}, "type": name}},
                                background=True)
            ids = search.get("result", [])[:1]
            if not ids:
                return {"ok": False, "error": "no listings"}
            fetched = self._http("%s/fetch/%s?query=%s" % (TRADE_BASE, ids[0], search["id"]),
                                 background=True)
            for r in fetched.get("result", []):
                icon = (r or {}).get("item", {}).get("icon", "")
                if icon:
                    self._unique_icons[key] = icon
                    try:
                        with open(self._unique_icons_path, "w", encoding="utf-8") as f:
                            json.dump(self._unique_icons, f)
                    except Exception:
                        pass
                    return {"ok": True, "icon": icon}
            return {"ok": False, "error": "no icon"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- currency -> chaos rates via GGG's own bulk exchange ---------------------
    def exchange_rates(self, league, currencies_json):
        """Median chaos rate for each currency, from live exchange offers.
        Cached 30 min per league+currency. Returns {'ok', 'rates': {cur: chaos}}"""
        try:
            wanted = [c for c in json.loads(currencies_json) if c and c != "chaos"]
            rates = {"chaos": 1.0}
            now = time.time()
            cache = self._rate_cache.setdefault(league, {})
            for cur in wanted[:12]:
                hit = cache.get(cur)
                if hit and now - hit[1] < 1800:
                    rates[cur] = hit[0]
                    continue
                try:
                    res = self._http(
                        "%s/exchange/%s" % (TRADE_BASE, urllib.request.quote(league)),
                        {"query": {"status": {"option": "online"},
                                   "want": [cur], "have": ["chaos"]},
                         "sort": {"have": "asc"}})
                    result = res.get("result") or {}
                    entries = list(result.values()) if isinstance(result, dict) else []
                    ratios = []
                    for entry in entries[:20]:
                        for off in (entry.get("listing") or {}).get("offers", [])[:1]:
                            ex = off.get("exchange") or {}
                            it = off.get("item") or {}
                            if ex.get("currency") == "chaos" and it.get("amount"):
                                ratios.append(float(ex["amount"]) / float(it["amount"]))
                    if ratios:
                        ratios.sort()
                        rate = ratios[len(ratios) // 2]  # median beats troll offers
                        rates[cur] = rate
                        cache[cur] = (rate, now)
                except Exception:
                    pass  # currency without offers — skip
            return {"ok": True, "rates": rates}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- refresh bundled data ---------------------------------------------------
    def refresh_data(self):
        """Re-download stats + leagues from GGG and regenerate the bundled JS."""
        try:
            stats = self._http(TRADE_BASE + "/data/stats")
            leagues = self._http(TRADE_BASE + "/data/leagues")
            if "result" not in stats or "result" not in leagues:
                return {"ok": False, "error": "unexpected API response"}
            with open(os.path.join(DATA_DIR, "stats.json"), "w", encoding="utf-8") as f:
                json.dump(stats, f)
            with open(os.path.join(DATA_DIR, "leagues.json"), "w", encoding="utf-8") as f:
                json.dump(leagues, f)
            with open(os.path.join(DATA_DIR, "stats.js"), "w", encoding="utf-8") as f:
                f.write("window.POE_STATS = " + json.dumps(stats) + ";\n")
            with open(os.path.join(DATA_DIR, "leagues.js"), "w", encoding="utf-8") as f:
                f.write("window.POE_LEAGUES = " + json.dumps(leagues) + ";\n")
            n = len([l for l in leagues["result"] if l.get("realm") == "pc"])
            return {"ok": True, "leagues": n}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- in-game whisper / hideout travel ------------------------------------------
    # One chat message per user click, pasted into the PoE client — the same
    # approach Awakened PoE Trade uses (one action per input, within GGG's rules).
    def _find_poe_window(self):
        import ctypes
        user32 = ctypes.windll.user32
        titles = ("Path of Exile", "Path of Exile 2")
        found = []

        @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
        def cb(hwnd, _):
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                if buf.value in titles and user32.IsWindowVisible(hwnd):
                    found.append(hwnd)
            return True

        user32.EnumWindows(cb, 0)
        return found[0] if found else None

    def _set_clipboard(self, text):
        import ctypes
        CF_UNICODETEXT = 13
        GMEM_MOVEABLE = 0x0002
        user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
        if not user32.OpenClipboard(None):
            raise RuntimeError("could not open clipboard")
        try:
            user32.EmptyClipboard()
            data = text.encode("utf-16-le") + b"\x00\x00"
            h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(data))
            p = kernel32.GlobalLock(h)
            ctypes.memmove(p, data, len(data))
            kernel32.GlobalUnlock(h)
            user32.SetClipboardData(CF_UNICODETEXT, h)
        finally:
            user32.CloseClipboard()

    def poe_chat(self, text):
        """Paste one chat line into the running PoE client and press Enter."""
        try:
            import ctypes
            if not text or len(text) > 500:
                return {"ok": False, "error": "invalid chat text"}
            hwnd = self._find_poe_window()
            if not hwnd:
                return {"ok": False, "error": "Path of Exile window not found — is the game running?"}
            user32 = ctypes.windll.user32
            self._set_clipboard(text)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.20)

            VK_RETURN, VK_CONTROL, VK_V, KEYUP = 0x0D, 0x11, 0x56, 0x0002
            def key(vk, up=False):
                user32.keybd_event(vk, 0, KEYUP if up else 0, 0)

            key(VK_RETURN); key(VK_RETURN, True)          # open chat
            time.sleep(0.08)
            key(VK_CONTROL); key(VK_V); key(VK_V, True); key(VK_CONTROL, True)  # paste
            time.sleep(0.08)
            key(VK_RETURN); key(VK_RETURN, True)          # send
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- rate-limit visibility -------------------------------------------------------
    def rate_status(self):
        hold = max(0.0, self._blocked_until - time.time())
        return {"ok": True, "cooldownSeconds": int(hold)}

    # -- durable storage for the web app -------------------------------------------
    def storage_get(self):
        return {"ok": True, "data": self._storage}

    def storage_set(self, key, value):
        try:
            self._storage[str(key)] = str(value)
            with open(self._storage_path, "w", encoding="utf-8") as f:
                json.dump(self._storage, f)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- POESESSID session + true live search over the trade WebSocket -------------
    # The session cookie is stored ONLY in data/session.json on this machine and
    # sent ONLY to pathofexile.com. It enables the same instant live search the
    # trade website has.
    def set_poesessid(self, value):
        try:
            self._poesessid = (value or "").strip()
            with open(self._session_path, "w", encoding="utf-8") as f:
                json.dump({"poesessid": self._poesessid}, f)
            return {"ok": True, "set": bool(self._poesessid)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def session_status(self):
        return {"ok": True, "set": bool(self._poesessid)}

    def live_start(self, league, payload_json):
        """Open a GGG live-search WebSocket for this query. Returns a subId to
        poll with live_poll. Needs a POESESSID."""
        if not self._poesessid:
            return {"ok": False, "error": "no POESESSID set"}
        try:
            import websocket
        except ImportError:
            return {"ok": False, "error": "websocket-client not installed (pip install websocket-client)"}
        try:
            payload = json.loads(payload_json)
            search = self._http("%s/search/%s" % (TRADE_BASE, urllib.request.quote(league)), payload)
            search_id = search.get("id")
            if not search_id:
                return {"ok": False, "error": "search failed"}
            sub = {"queue": [], "status": "connecting", "ws": None}

            def on_message(ws, msg):
                try:
                    data = json.loads(msg)
                    ids = data.get("new") or []
                    if ids:
                        sub["queue"].extend(ids)
                    sub["status"] = "connected"
                except Exception:
                    pass

            def on_open(ws):
                sub["status"] = "connected"

            def on_error(ws, err):
                sub["status"] = "error: %s" % str(err)[:120]

            def on_close(ws, code, reason):
                if not sub["status"].startswith("error"):
                    sub["status"] = "closed"

            url = "wss://www.pathofexile.com/api/trade/live/%s/%s" % (
                urllib.request.quote(league), search_id)
            ws = websocket.WebSocketApp(
                url,
                header=["User-Agent: " + UA,
                        "Origin: https://www.pathofexile.com",
                        "Cookie: POESESSID=" + self._poesessid],
                on_message=on_message, on_open=on_open,
                on_error=on_error, on_close=on_close)
            sub["ws"] = ws
            t = threading.Thread(target=lambda: ws.run_forever(ping_interval=30), daemon=True)
            t.start()
            self._live_subs[search_id] = sub
            return {"ok": True, "subId": search_id,
                    "total": search.get("total", len(search.get("result", [])))}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def live_poll(self, sub_id):
        sub = self._live_subs.get(sub_id)
        if not sub:
            return {"ok": False, "error": "unknown live search"}
        ids = sub["queue"][:10]
        del sub["queue"][:len(ids)]
        return {"ok": True, "status": sub["status"], "ids": ids}

    def live_stop(self, sub_id):
        sub = self._live_subs.pop(sub_id, None)
        if sub and sub.get("ws"):
            try:
                sub["ws"].close()
            except Exception:
                pass
        return {"ok": True}

    # -- auto-update via GitHub Releases ------------------------------------------
    @staticmethod
    def _semver(tag):
        parts = []
        for p in (tag or "").lstrip("vV").split("."):
            digits = "".join(ch for ch in p if ch.isdigit())
            parts.append(int(digits or 0))
        while len(parts) < 3:
            parts.append(0)
        return tuple(parts[:3])

    def check_update(self):
        """Compare VERSION against the latest GitHub release."""
        try:
            url = "https://api.github.com/repos/%s/%s/releases/latest" % (GITHUB_OWNER, GITHUB_REPO)
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "application/vnd.github+json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                rel = json.loads(r.read().decode("utf-8"))
            latest = rel.get("tag_name", "")
            asset = next((a for a in rel.get("assets", [])
                          if a.get("name", "").lower().endswith(".zip")), None)
            return {"ok": True, "current": VERSION, "latest": latest,
                    "newer": self._semver(latest) > self._semver(VERSION),
                    "notes": (rel.get("body") or "")[:500],
                    "url": asset.get("browser_download_url") if asset else None}
        except Exception as e:
            return {"ok": False, "current": VERSION, "error": str(e)}

    def apply_update(self, url):
        """Download the release zip, stage it, and hand over to a swap script
        that replaces the app files after this process exits, then relaunches."""
        try:
            prefix = "https://github.com/%s/%s/releases/" % (GITHUB_OWNER, GITHUB_REPO)
            if not (url or "").startswith(prefix):
                return {"ok": False, "error": "refusing non-release URL"}
            staged = os.path.join(APP_DIR, "_update")
            shutil.rmtree(staged, ignore_errors=True)
            os.makedirs(staged, exist_ok=True)
            zpath = os.path.join(staged, "update.zip")
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=600) as r, open(zpath, "wb") as f:
                shutil.copyfileobj(r, f)
            with zipfile.ZipFile(zpath) as z:
                for member in z.namelist():
                    norm = os.path.normpath(member)
                    if norm.startswith("..") or os.path.isabs(norm):
                        return {"ok": False, "error": "unsafe path in update zip"}
                z.extractall(staged)
            os.remove(zpath)

            exe_path = sys.executable if getattr(sys, "frozen", False) else None
            bat = os.path.join(APP_DIR, "_apply_update.bat")
            log = os.path.join(APP_DIR, "_update.log")
            with open(bat, "w", encoding="ascii") as f:
                f.write("@echo off\n")
                f.write('cd /d "%~dp0"\n')
                f.write('echo update started %date% %time% > "_update.log"\n')
                # 'timeout' needs a console stdin and dies when run windowless —
                # ping is the reliable console-free delay
                f.write("ping -n 3 127.0.0.1 >nul\n")
                # /R:60 /W:1 — retry the (briefly locked) exe every second
                # instead of robocopy's default 30s waits
                f.write('robocopy "%s" "%s" /E /MOVE /R:60 /W:1 /NFL /NDL /NJH /NJS >> "_update.log" 2>&1\n'
                        % (staged, APP_DIR))
                if exe_path:
                    f.write('start "" "%s"\n' % exe_path)
                f.write('echo update finished %date% %time% >> "_update.log"\n')
                f.write('del "%~f0"\n')
            try:
                os.remove(log)
            except Exception:
                pass
            # fully detach: parent teardown (PyInstaller cleanup) must not
            # touch the swap process. 0x08000000 CREATE_NO_WINDOW |
            # 0x00000200 CREATE_NEW_PROCESS_GROUP
            subprocess.Popen(["cmd", "/c", bat], cwd=APP_DIR, close_fds=True,
                             creationflags=0x08000000 | 0x00000200,
                             stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
            for w in list(webview.windows):
                try:
                    w.destroy()
                except Exception:
                    pass
            threading.Timer(1.0, lambda: os._exit(0)).start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- open in system browser --------------------------------------------------
    def open_url(self, url):
        if url.startswith("https://www.pathofexile.com/"):
            webbrowser.open(url)
            return {"ok": True}
        return {"ok": False, "error": "refusing to open non-trade URL"}


def main():
    index = os.path.join(APP_DIR, "index.html")
    if not os.path.exists(index):
        sys.exit("index.html not found next to gui.py")
    webview.create_window(
        "PoB Trade Finder",
        index,
        js_api=Api(),
        width=1060,
        height=880,
        background_color="#0c0b09",
    )
    webview.start()


if __name__ == "__main__":
    main()
