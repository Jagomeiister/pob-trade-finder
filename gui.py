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
import uuid
import webbrowser
import zipfile

import webview

import price_hotkey
import single_instance
import trade_helper
from currency_feed import CurrencyFeed
from timeless import TimelessData
from art_cache import ArtCache
import oauth

VERSION = "2.5.22"
GITHUB_OWNER = "Jagomeiister"
GITHUB_REPO = "pob-trade-finder"
CONTACT = "https://github.com/%s/%s/issues" % (GITHUB_OWNER, GITHUB_REPO)
# Official OAuth client id from GGG (public client, redirect http://127.0.0.1:8080/callback).
# Empty = official login switched off: GGG isn't accepting new applications yet. Once one
# is issued, set it here and stash value + official character access turn on (oauth.py).
OAUTH_CLIENT_ID = ""

# Frozen (PyInstaller) exe lives next to index.html/js/data — same layout as source
if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(APP_DIR, "data")
# GGG's developer docs ask every client to identify itself with a version and a contact.
# Not "OAuth {clientId}/…": this app has no registered OAuth client, so it doesn't claim one.
UA = "PoBTradeFinder/%s (contact: %s)" % (VERSION, CONTACT)
TRADE_BASE = "https://www.pathofexile.com/api/trade"
# the app's backend (server/): poe.ninja prices proxied and cached, as poe.ninja asks of desktop apps
PRICES_API = "https://pob-trade-finder.vercel.app/api/prices"
PRICES_TTL = 1800
# where div cards drop: tools/make_divcards.py (community wiki) writes it into the app
# (data/divcards.json) and onto the backend as a static file, so installs pick up newer
# drop data between releases. Prices come from GGG's currency exchange feed.
DIVCARDS_API = "https://pob-trade-finder.vercel.app/divcards.json"
DIVCARDS_TTL = 6 * 3600
# cheat sheets (tools/make_cheatsheets.py): the server's copy lets fixes reach the app between releases
CHEATSHEETS_API = "https://pob-trade-finder.vercel.app/cheatsheets.json"
CHEATSHEETS_TTL = 6 * 3600
# mechanic strategy guides (tools/make_guides.py), drawn inside the cheat sheets: same server pattern
GUIDES_API = "https://pob-trade-finder.vercel.app/guides.json"
GUIDES_TTL = 6 * 3600

# GGG rate limits are strict; space all trade API calls out and honour 429s.
MIN_INTERVAL = 2.5

# in-game price-check overlay: a second window on index.html?overlay=1
OVERLAY_TITLE = "PoB Trade Finder - Price check"
OVERLAY_SIZE = (560, 700)

# in-game overlays (Awakened Trade / Lurker style): a small PoB icon over the game while it's
# focused, and trade cards. Frameless, see-through, never take focus (js/app/19-trades.js).
# The Trade helper itself (sales, buyers, setup) is a view of the main window.
MAIN_TITLE = "PoB Trade Finder"
# Separate pieces, each draggable on its own (Lurker / Awakened style). default = where the
# top-left (or, for one in the lower half, the bottom edge) sits as a fraction of the game.
OVERLAYS = {
    "icon": {"title": "PoB Trade Finder - Icon", "query": "?ovicon=1", "pos": "pobtf-ov-icon-pos",
             "default": (0.55, 0.006), "size": (60, 48)},
    "cards": {"title": "PoB Trade Finder - Trade cards", "query": "?cards=1", "pos": "pobtf-ov-cards-pos",
              "default": (0.5, 0.80), "size": (380, 60)},  # centred, above the skill bar / XP bar
    # leveling cheat sheet (js/app/24-cheatsheets.js): shown / hidden by its hotkey
    "sheet": {"title": "PoB Trade Finder - Cheat sheet", "query": "?sheet=1", "pos": "pobtf-ov-sheet-pos",
              "default": (0.74, 0.12), "size": (320, 120)},
    # "Sanctum cheat sheet? Open" when you enter a mechanic's area: a small pill, top centre
    "hint": {"title": "PoB Trade Finder - Sheet hint", "query": "?sheethint=1", "pos": "pobtf-ov-hint-pos",
             "default": (0.5, 0.015), "size": (300, 40)},
}
CENTRED_OVERLAYS = ("cards", "hint")  # their default x is the centre, not the left edge
HIDDEN_AT_START = ("sheet", "hint")   # shown only when their page asks (hotkey, a suggestion)
# Hotkeys (Settings → In game): each held only while the game (or our overlay) is focused.
HOTKEY_DEFAULTS = {"price": "ctrl+d", "app": "shift+space", "trades": "alt+t", "sheet": "alt+c",
                   "filter": "ctrl+shift+d"}
HOTKEY_PREFS = {"price": "hotkey", "app": "hotkeyApp", "trades": "hotkeyTrades", "sheet": "hotkeySheet",
                "filter": "hotkeyFilter"}
# hotkeys that only fire while Path of Exile itself is the foreground window (they copy the hovered item)
GAME_ONLY_HOTKEYS = ("price", "filter")
CHAT_KEY_NAMES = {13: "Enter", 9: "Tab", 32: "Space", 192: "` (backtick)", 222: "' (quote)", 191: "/ (slash)"}


DEBUG_LOG_MAX = 256 * 1024


def _debug_log(msg):
    try:
        path = os.path.join(DATA_DIR, "debug.log")
        if os.path.exists(path) and os.path.getsize(path) > DEBUG_LOG_MAX:
            with open(path, "rb") as f:
                f.seek(-DEBUG_LOG_MAX // 2, os.SEEK_END)
                keep = f.read().split(b"\n", 1)[-1]  # drop the partial first line
            with open(path, "wb") as f:
                f.write(keep)
        with open(path, "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (time.strftime("%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


class Api:
    def __init__(self):
        self._lock = threading.Lock()
        self._last_call = 0.0
        self._blocked_until = 0.0  # global hold-off from 429s / quota headers
        self._err_times = []  # recent 4xx timestamps — GGG restricts clients that burst errors
        self._rate_cache = {}  # league -> {currency: (chaos_rate, fetched_at)}
        self._feed = CurrencyFeed(os.path.join(DATA_DIR, "cx_cache"), UA)
        try:
            with open(os.path.join(DATA_DIR, "currencymap.json"), "r", encoding="utf-8") as f:
                self._currency_map = json.load(f)  # trade code -> {id, name, img}
        except Exception:
            self._currency_map = {}
        threading.Thread(target=self._feed.prune, daemon=True).start()
        self._timeless = TimelessData(DATA_DIR, "PoBTradeFinder/%s (+https://github.com/%s/%s)"
                                      % (VERSION, GITHUB_OWNER, GITHUB_REPO))
        self._unique_icons_path = os.path.join(DATA_DIR, "unique_icons.json")
        try:
            with open(self._unique_icons_path, "r", encoding="utf-8") as f:
                self._unique_icons = json.load(f)
        except Exception:
            self._unique_icons = {}
        # when each art link was last confirmed against the trade site (re-checked
        # after ICON_RECHECK_DAYS so changed art is picked up)
        self._icon_meta_path = os.path.join(DATA_DIR, "unique_icons_meta.json")
        try:
            with open(self._icon_meta_path, "r", encoding="utf-8") as f:
                self._icon_meta = json.load(f)
        except Exception:
            self._icon_meta = {}
        self._art = ArtCache(DATA_DIR, UA)
        self._oauth = oauth.OAuth(OAUTH_CLIENT_ID, VERSION, CONTACT, os.path.join(DATA_DIR, "oauth.json"),
                                  open_url=webbrowser.open)
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
        # in-game price check: hotkey thread + overlay window (wired up by main())
        self._hotkey = None
        self._overlay = None
        self._quitting = False
        self._destroyed = set()  # window uids already closed (see _destroy_once)
        self._destroy_lock = threading.Lock()
        # trade helper (wired up by main()): Client.txt tail, chat sender, stash outline
        self._trades = None
        self._overlay_windows = {}  # name -> pywebview window (OVERLAYS)
        # the cheat sheet starts hidden (its hotkey shows it); the others report once their page loads
        self._ov = {n: {"content": n not in HIDDEN_AT_START, "placed": None, "placed_at": 0.0, "dragging": False, "replace": False}
                    for n in OVERLAYS}
        self._app_overlay = False   # main window brought over the game by the app hotkey
        self._main_was_hidden = False
        self._app_overlay_at = 0.0
        self._main = None
        self._tray = None
        self._hotkeys = {}
        self._tail = None
        self._sender = None
        self._highlight = None
        self._trade_lock = threading.Lock()
        self._hotkey_specs = {}
        try:
            prefs = json.loads(self._storage.get("pobtf-prefs") or "{}")
        except Exception:
            prefs = {}
        for name, default in HOTKEY_DEFAULTS.items():
            spec = prefs.get(HOTKEY_PREFS[name], default)
            try:
                price_hotkey.parse_hotkey(spec)
            except Exception:
                spec = default
            if spec not in price_hotkey.OFF and spec in self._hotkey_specs.values():
                spec = "off"  # e.g. the price check already set to Ctrl+Shift+D: that one keeps it
            self._hotkey_specs[name] = spec
        self._hotkey_spec = self._hotkey_specs["price"]
        self._zone = None  # last "Generating level N area" from Client.txt (filter editor's zone level)
        self._macro_watchers = []
        try:
            self._macros = self._clean_macros(prefs.get("macros") or [])[0]
        except Exception:
            self._macros = []

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
    ERR_BURST, ERR_WINDOW, ERR_HOLD = 5, 60.0, 60.0  # 5 errors in 60s -> 60s pause

    def _http(self, url, payload=None, background=False, extra_headers=None):
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
        # (needed for weight-group searches); the cookie goes only to the trade site's
        # host — never to api.pathofexile.com, which takes the official OAuth token
        if self._poesessid and urllib.parse.urlsplit(url).hostname == "www.pathofexile.com":
            headers["Cookie"] = "POESESSID=" + self._poesessid
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                hold = self._read_quota(resp.headers)
                if hold > 0:
                    with self._lock:
                        self._blocked_until = max(self._blocked_until, time.time() + hold)
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            _debug_log("HTTP %s %s %s" % (e.code, "POST" if data else "GET", urllib.parse.urlsplit(url).path))
            if e.code == 429:
                retry = int(e.headers.get("Retry-After", "60"))
                # global lockout: EVERY caller (price checks, live, watcher, icons)
                # waits it out — no retry hammering, which extends GGG bans
                with self._lock:
                    self._blocked_until = max(self._blocked_until, time.time() + retry)
                raise RuntimeError("GGG rate limit hit — cooling down %ss, then try again" % retry)
            if 400 <= e.code < 500 and "pathofexile.com" in url:
                with self._lock:
                    now = time.time()
                    self._err_times = [t for t in self._err_times if now - t < self.ERR_WINDOW]
                    self._err_times.append(now)
                    if len(self._err_times) >= self.ERR_BURST:
                        self._err_times = []
                        self._blocked_until = max(self._blocked_until, now + self.ERR_HOLD)
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
            **Api._split_listing_mods(it),
            "amount": price.get("amount"),
            "currency": price.get("currency", ""),
            "priceType": price.get("type", ""),
            "fee": li.get("fee"),  # instant-buyout gold fee (None for in-person)
            "account": (li.get("account") or {}).get("name", ""),
            "whisper": li.get("whisper", ""),
            "indexed": li.get("indexed", ""),  # when listed (ISO time)
            # account.online is an object while the seller is online ({"status": "afk"} when away)
            "online": bool((li.get("account") or {}).get("online")),
            "afk": ((li.get("account") or {}).get("online") or {}).get("status") == "afk",
        }

    @staticmethod
    def _split_listing_mods(it):
        # since 3.29 the fetch API merges crafted/fractured mods into
        # explicitMods (rich objects tagged by domain/flags) and drops the
        # separate arrays; re-split them so colours, tiers and affix counts work
        out = {"implicitMods": [], "enchantMods": [], "fracturedMods": [],
               "explicitMods": [], "craftedMods": []}
        for src in out:
            for m in it.get(src, []) or []:
                dest = src
                if isinstance(m, dict) and src == "explicitMods":
                    flags = m.get("flags") or {}
                    domain = m.get("domain")
                    if flags.get("crafted") or domain == "crafted":
                        dest = "craftedMods"
                    elif flags.get("fractured") or domain == "fractured":
                        dest = "fracturedMods"
                out[dest].append(m)
        return out

    def trade_search(self, league, payload_json, background=False):
        """Run a trade search: first page of listings + the full id list so the
        UI can page through the rest via trade_fetch. background=True (saved-build
        re-pricing) paces gently and is skipped during any rate-limit cooldown."""
        try:
            payload = json.loads(payload_json)
            bg = bool(background)
            search = self._http("%s/search/%s" % (TRADE_BASE, urllib.request.quote(league)), payload, background=bg)
            ids = search.get("result", [])[:100]
            total = search.get("total", len(search.get("result", [])))
            listings = []
            if ids:
                fetched = self._http("%s/fetch/%s?query=%s"
                                     % (TRADE_BASE, ",".join(ids[:self.PAGE_SIZE]), search["id"]), background=bg)
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
                    "linkGroups": self._char_links(it),
                    "reqs": self._char_reqs(it),  # socket colours lean on these (gem compare)
                    "quality": self._gem_prop(it, "Quality"),
                    **self._char_mods(it),
                })
            return {"ok": True, "items": items}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def get_character_passives(self, account, character):
        """Allocated passives of a public character, for the Skill tree view's
        "Compare with my character" (one call, the user's button). hashes = tree node ids,
        hashesEx = cluster jewel passives, masteries = mastery node -> effect, jewels =
        socketed tree jewels (x = index into the tree's jewelSlots)."""
        try:
            d = self._char_get("get-passive-skills", {"accountName": account,
                                                      "character": character, "realm": "pc"})
            if not isinstance(d, dict):
                raise RuntimeError("unexpected response")

            def ints(xs):
                return [int(x) for x in (xs or []) if isinstance(x, (int, float, str)) and str(x).isdigit()]

            masteries = d.get("mastery_effects") or {}
            if isinstance(masteries, list):  # [[node, effect], ...] or packed numbers
                masteries = {str(m[0]): m[1] for m in masteries if isinstance(m, (list, tuple)) and len(m) == 2}
            jewels = []
            for it in d.get("items", []) or []:
                if not isinstance(it, dict):
                    continue
                jewels.append({
                    "x": it.get("x", -1),
                    "name": (it.get("name") or "").strip(),
                    "base": it.get("typeLine", ""),
                    "frameType": it.get("frameType", 2),
                    **self._char_mods(it),
                })
            return {"ok": True, "hashes": ints(d.get("hashes")), "hashesEx": ints(d.get("hashes_ex")),
                    "masteries": {str(k): v for k, v in masteries.items()} if isinstance(masteries, dict) else {},
                    "jewels": jewels}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # worn slots whose gems count (main inventory items carry socketed gems too)
    GEM_INV = {"Helm", "BodyArmour", "Gloves", "Boots", "Amulet", "Ring", "Ring2", "Belt",
               "Weapon", "Offhand", "Weapon2", "Offhand2"}

    @staticmethod
    def _gem_prop(gem, name):
        for p in gem.get("properties") or []:
            if p.get("name") == name and p.get("values"):
                m = re.search(r"\d+", str(p["values"][0][0]))
                return int(m.group()) if m else 0
        return 0

    @staticmethod
    def _char_reqs(it):
        """An item's attribute requirements {"str", "dex", "int"}: its non-white sockets roll
        red / green / blue in proportion to them."""
        out = {"str": 0, "dex": 0, "int": 0}
        for r in it.get("requirements") or []:
            key = str(r.get("name") or "").lower()[:3]
            if key in out and r.get("values"):
                m = re.search(r"\d+", str(r["values"][0][0]))
                out[key] = int(m.group()) if m else 0
        return out

    @staticmethod
    def _char_links(it):
        """An equipped item's link groups for the gem compare, in socket order:
        [{"links": sockets in the group, "gems": [{name, level, quality}],
          "sockets": [{"c": socket colour, "gem": gem name or ""}]}] — empty groups included,
        so the socket picture shows every link group on the item."""
        if it.get("inventoryId") not in Api.GEM_INV:
            return []
        sockets = it.get("sockets") or []
        in_socket = {}
        for gem in it.get("socketedItems") or []:
            i = gem.get("socket")
            if isinstance(i, int) and 0 <= i < len(sockets):
                in_socket[i] = gem
        groups, order = {}, []
        for i, s in enumerate(sockets):
            g = s.get("group", 0)
            if g not in groups:
                groups[g] = {"links": 0, "gems": [], "sockets": []}
                order.append(g)
            grp = groups[g]
            grp["links"] += 1
            gem = in_socket.get(i)
            if gem is None or gem.get("frameType") != 4:  # abyss jewels sit in sockets too
                grp["sockets"].append({"c": s.get("sColour") or s.get("attr") or "W", "gem": ""})
                continue
            name = (gem.get("typeLine") or gem.get("baseType") or "").strip()
            grp["sockets"].append({"c": s.get("sColour") or s.get("attr") or "W", "gem": name})
            grp["gems"].append({"name": name, "level": Api._gem_prop(gem, "Level"),
                                "quality": Api._gem_prop(gem, "Quality")})
        return [groups[g] for g in order]

    @staticmethod
    def _char_mods(it):
        # character-window mods arrive either as plain strings (old format) or
        # as {"description": ..., "flags": {"crafted"/"fractured": true}} objects
        # with crafted/fractured merged into explicitMods (new format). Emit the
        # old string-array contract either way, re-splitting flagged mods.
        out = {"implicitMods": [], "explicitMods": [], "craftedMods": [],
               "enchantMods": [], "fracturedMods": []}
        for src in out:
            for m in it.get(src, []) or []:
                if isinstance(m, str):
                    out[src].append(m)
                    continue
                if not isinstance(m, dict):
                    continue
                line = m.get("description") or m.get("line") or ""
                if not line:
                    continue
                flags = m.get("flags") or {}
                if src in ("implicitMods", "explicitMods") and flags.get("crafted"):
                    out["craftedMods"].append(line)
                elif src == "explicitMods" and flags.get("fractured"):
                    out["fracturedMods"].append(line)
                else:
                    out[src].append(line)
        return out

    # -- unique item art: one trade lookup per unique, cached on disk forever ----
    ICON_RECHECK_DAYS = 30
    ICON_RECHECKS_PER_RUN = 5   # keep background trade calls rare

    ICON_FAIL_DAYS = 7  # a lookup with a definite "no" isn't retried for a week

    def _save_icon_meta(self):
        try:
            with open(self._icon_meta_path, "w", encoding="utf-8") as f:
                json.dump(self._icon_meta, f)
        except Exception:
            pass

    def _failed_recently(self, key):
        ts = self._icon_meta.get("fail::" + key)
        return ts is not None and time.time() - ts < self.ICON_FAIL_DAYS * 86400

    def _remember_failure(self, key, error):
        """Remember definite failures (unknown name, nothing listed) — not rate limits or
        network trouble, which are worth retrying next run."""
        if re.match(r"(HTTP 400|no listings|no icon)", str(error)):
            self._icon_meta["fail::" + key] = int(time.time())
            self._save_icon_meta()

    def _remember_icon(self, key, icon):
        self._unique_icons[key] = icon
        self._icon_meta.pop("fail::" + key, None)
        self._icon_meta[key] = int(time.time())
        try:
            with open(self._unique_icons_path, "w", encoding="utf-8") as f:
                json.dump(self._unique_icons, f)
            with open(self._icon_meta_path, "w", encoding="utf-8") as f:
                json.dump(self._icon_meta, f)
        except Exception:
            pass

    def _maybe_recheck(self, key, lookup):
        """Art links are saved forever, but GGG can change art: confirm a link again
        once it is ICON_RECHECK_DAYS old, in the background, a few per run. A changed
        link means changed art, which the image cache then downloads once."""
        checked = self._icon_meta.get(key)
        if checked is None:  # saved before re-checks existed — start the clock now
            self._icon_meta[key] = int(time.time())
            try:
                with open(self._icon_meta_path, "w", encoding="utf-8") as f:
                    json.dump(self._icon_meta, f)
            except Exception:
                pass
            return
        if time.time() - checked < self.ICON_RECHECK_DAYS * 86400:
            return
        if getattr(self, "_rechecks", 0) >= self.ICON_RECHECKS_PER_RUN:
            return
        self._rechecks = getattr(self, "_rechecks", 0) + 1
        threading.Thread(target=lookup, daemon=True).start()

    # -- art images cached on disk (see art_cache.py) --------------------------------
    def art_manifest(self):
        try:
            return {"ok": True, "art": self._art.manifest()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def cache_art(self, urls_json):
        try:
            urls = json.loads(urls_json)[:40]
            return {"ok": True, "art": self._art.cache(urls)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def unique_icon(self, name, base, _refresh=False):
        try:
            if not name:
                return {"ok": False, "error": "no name"}
            cached = self._unique_icons.get(name)
            if cached and not _refresh:
                self._maybe_recheck(name, lambda: self.unique_icon(name, base, True))
                return {"ok": True, "icon": cached}
            if not cached and self._failed_recently(name):
                return {"ok": False, "error": "lookup failed recently — retried after %d days" % self.ICON_FAIL_DAYS}
            query = {"query": {"status": {"option": "any"}, "name": name}}
            if base and base != name:
                query["query"]["type"] = base
            # Standard has every unique ever — league items may not exist yet
            search = self._http(TRADE_BASE + "/search/Standard", query, background=True)
            ids = search.get("result", [])[:1]
            if not ids:
                raise RuntimeError("no listings found")
            fetched = self._http("%s/fetch/%s?query=%s" % (TRADE_BASE, ids[0], search["id"]),
                                 background=True)
            for r in fetched.get("result", []):
                icon = (r or {}).get("item", {}).get("icon", "")
                if icon:
                    self._remember_icon(name, icon)
                    return {"ok": True, "icon": icon}
            raise RuntimeError("no icon in listing")
        except Exception as e:
            _debug_log("unique_icon(%r): %s" % (name, e))
            if not _refresh:
                self._remember_failure(name, e)
            return {"ok": False, "error": str(e)}

    def gem_icon(self, name, disc_type=None, disc=None, _refresh=False):
        """Proper single-frame gem art via one trade lookup (RePoE gem art is
        often a multi-frame atlas). Cached forever alongside unique icons.
        Transfigured gems are a discriminated base type on the trade API —
        pass disc_type/disc (e.g. "Frostblink", "alt_x") for those."""
        try:
            key = "gem::" + name
            cached = self._unique_icons.get(key)
            if cached and not _refresh:
                self._maybe_recheck(key, lambda: self.gem_icon(name, disc_type, disc, True))
                return {"ok": True, "icon": cached}
            if not cached and self._failed_recently(key):
                return {"ok": False, "error": "lookup failed recently — retried after %d days" % self.ICON_FAIL_DAYS}
            qtype = {"option": disc_type, "discriminator": disc} if (disc_type and disc) else name
            search = self._http(TRADE_BASE + "/search/Standard",
                                {"query": {"status": {"option": "any"}, "type": qtype}},
                                background=True)
            ids = search.get("result", [])[:1]
            if not ids:
                raise RuntimeError("no listings")
            fetched = self._http("%s/fetch/%s?query=%s" % (TRADE_BASE, ids[0], search["id"]),
                                 background=True)
            for r in fetched.get("result", []):
                icon = (r or {}).get("item", {}).get("icon", "")
                if icon:
                    self._remember_icon(key, icon)
                    return {"ok": True, "icon": icon}
            raise RuntimeError("no icon")
        except Exception as e:
            if not _refresh:
                self._remember_failure(key, e)
            return {"ok": False, "error": str(e)}

    # -- currency -> chaos rates via GGG's own bulk exchange ---------------------
    # -- timeless jewel finder (lookup tables from Path of Building, see timeless.py) --
    def timeless_sockets(self, nodes_json):
        """Allocated jewel sockets with the allocated notables in timeless radius."""
        try:
            alloc = set(int(n) for n in json.loads(nodes_json))
            out = []
            for s in self._timeless.sockets():
                if s not in alloc:
                    continue
                near = [n for n, k in self._timeless.in_radius(s) if k == 1 and n in alloc]
                out.append({"socket": s, "notables": near})
            return {"ok": True, "sockets": out}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def timeless_info(self, jewel_type, socket_id, nodes_json):
        try:
            return dict(ok=True, **self._timeless.info(int(jewel_type), int(socket_id), json.loads(nodes_json)))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def timeless_seed(self, jewel_type, socket_id, nodes_json, seed, include_unallocated=False):
        try:
            r = self._timeless.seed_outcomes(int(jewel_type), int(socket_id), json.loads(nodes_json),
                                             int(seed), bool(include_unallocated))
            return dict(ok=True, **r)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def timeless_search(self, jewel_type, socket_id, nodes_json, weights_json, include_unallocated=False,
                        mins_json="{}"):
        try:
            r = self._timeless.search(int(jewel_type), int(socket_id), json.loads(nodes_json),
                                      json.loads(weights_json), bool(include_unallocated),
                                      mins=json.loads(mins_json or "{}"))
            return dict(ok=True, **r)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _divine_rate(self, league):
        try:
            meta = self._currency_map["divine"]["id"]
            return self._feed.rates(league, [meta])[0].get(meta)
        except Exception:
            return None

    def exchange_rates(self, league, currencies_json):
        """Chaos rate for each currency. Primary source: GGG's public hourly
        currency-exchange feed (no trade-API quota). Fallback for anything the
        feed lacks: median of live trade exchange offers, cached 30 min.
        Returns {'ok', 'rates': {cur: chaos}, 'source': {cur: 'feed'|'trade'}}"""
        try:
            wanted = [c for c in json.loads(currencies_json) if c and c != "chaos"]
            rates = {"chaos": 1.0}
            source = {}
            ids = {c: self._currency_map[c]["id"] for c in wanted if c in self._currency_map}
            if ids:
                try:
                    fed, _ = self._feed.rates(league, list(ids.values()))
                    for cur, meta in ids.items():
                        if meta in fed:
                            rates[cur] = fed[meta]
                            source[cur] = "feed"
                except Exception:
                    pass  # feed unreachable — the trade fallback below covers it
            wanted = [c for c in wanted if c not in rates]
            now = time.time()
            cache = self._rate_cache.setdefault(league, {})
            for cur in wanted[:12]:
                hit = cache.get(cur)
                if hit and now - hit[1] < 1800:
                    rates[cur] = hit[0]
                    continue
                try:
                    # many items (fossils, essences) are sold mostly for divines —
                    # accept both, converting divine offers at the feed's rate
                    div = rates.get("divine") or self._divine_rate(league)
                    res = self._http(
                        "%s/exchange/%s" % (TRADE_BASE, urllib.request.quote(league)),
                        {"query": {"status": {"option": "online"},
                                   "want": [cur], "have": ["chaos", "divine"] if div else ["chaos"]},
                         "sort": {"have": "asc"}})
                    result = res.get("result") or {}
                    entries = list(result.values()) if isinstance(result, dict) else []
                    ratios = []
                    for entry in entries[:20]:
                        for off in (entry.get("listing") or {}).get("offers", [])[:1]:
                            ex = off.get("exchange") or {}
                            it = off.get("item") or {}
                            if not it.get("amount"):
                                continue
                            per = {"chaos": 1.0, "divine": div}.get(ex.get("currency"))
                            if per:
                                ratios.append(float(ex["amount"]) * per / float(it["amount"]))
                    if ratios:
                        ratios.sort()
                        rate = ratios[len(ratios) // 2]  # median beats troll offers
                        rates[cur] = rate
                        source[cur] = "trade"
                        cache[cur] = (rate, now)
                except Exception:
                    pass  # currency without offers — skip
            return {"ok": True, "rates": rates, "source": source}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def cx_history(self, league, currencies_json, days=7):
        """Price history (chaos) per trade currency code from the hourly feed:
        {'ok', 'hour', 'series': {code: [[unix hour, chaos, volume], ...]},
         'names': {code: name}}. First call downloads ~1 MB per missing point
        (cached forever after) — call it off the critical path."""
        try:
            codes = [c for c in json.loads(currencies_json) if c in self._currency_map][:20]
            days = max(1, min(int(days), 30))
            ids = [self._currency_map[c]["id"] for c in codes]
            series, hour = self._feed.history(league, ids, days=days, step_hours=self.cx_step(days))
            return {"ok": True, "hour": hour, "step": self.cx_step(days),
                    "series": {c: series.get(self._currency_map[c]["id"], []) for c in codes},
                    "names": {c: self._currency_map[c]["name"] for c in codes}}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def cx_step(days):
        """History sampling: 2-hourly for a day, 6-hourly for a week, daily beyond.
        The grids nest, so a finer view reuses the coarser views' cached hours."""
        return 2 if days <= 1 else 6 if days <= 7 else 24

    def anoint_oils(self, league):
        """Anoint helper (Cheat sheets → Blight): every oil with its icon and chaos price from GGG's
        hourly exchange feed only (no trade-site calls). {'ok', 'oils': {name: {img, chaos}},
        'divine', 'hour'}; a price is missing when the feed has none."""
        try:
            oils = {m["name"]: m for m in self._currency_map.values()
                    if (m.get("name") or "").endswith(" Oil") and m.get("id")}
            div_id = (self._currency_map.get("divine") or {}).get("id")
            want = [m["id"] for m in oils.values()] + ([div_id] if div_id else [])
            try:
                rates, hour = self._feed.rates(league, want)
            except Exception:
                rates, hour = {}, None  # offline: icons still show, prices don't
            remote = {name: ("https://web.poecdn.com" + m["img"]) if (m.get("img") or "").startswith("/") else None
                      for name, m in oils.items()}
            try:  # the icons through the art cache: a local copy, so they show offline too
                art = self._art.cache([u for u in remote.values() if u][:40]) if getattr(self, "_art", None) else {}
            except Exception:
                art = {}
            out = {}
            for name, m in oils.items():
                u = remote[name]
                out[name] = {"img": (art.get(u) or u) if u else None, "chaos": rates.get(m["id"])}
            return {"ok": True, "oils": out, "divine": rates.get(div_id) if div_id else None, "hour": hour}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # Mechanic tools (Cheat sheets → scarab hub, price boards, profit calculator): which
    # currency-exchange items each group covers, matched on the currencymap name and category.
    MECH_GROUPS = {
        "scarabs": lambda n, c: c == "Fragments, Scarabs & Mapping" and "Scarab" in n and "Chisel" not in n,
        "fossils": lambda n, c: c == "Fossils & Resonators",
        "essences": lambda n, c: c == "Essences",
        "lifeforce": lambda n, c: n.endswith("Crystallised Lifeforce"),
        "oils": lambda n, c: c == "Oils & Extractor",
        "catalysts": lambda n, c: c == "Catalysts",
        "delirium": lambda n, c: c == "Delirium Orbs",
        "fragments": lambda n, c: c == "Fragments, Scarabs & Mapping" and "Scarab" not in n,
        "expedition": lambda n, c: c == "Expedition Currency",
        "embers": lambda n, c: c == "Allflame Embers",
        "currency": lambda n, c: c == "Currency",
    }

    def mech_prices(self, league, groups_json):
        """Icons and chaos prices for whole item groups (MECH_GROUPS keys), from GGG's hourly
        exchange feed only — no trade-site calls. {'ok', 'hour', 'divine', 'items': {code: {name,
        cat, group, img, chaos}}}. img is the local art-cache copy when there is one, else the CDN
        URL (the rest are cached in the background, so the next open works offline); chaos is
        None when the feed has no price for it this hour."""
        try:
            groups = [g for g in json.loads(groups_json or "[]") if g in self.MECH_GROUPS][:12]
            seen, picked = set(), {}
            for code, m in sorted(self._currency_map.items(), key=lambda kv: len(kv[0])):
                name, cat, mid = m.get("name") or "", m.get("cat") or "", m.get("id")
                if not mid or mid in seen:
                    continue  # duplicate rows for one item: keep the shortest code
                for g in groups:
                    if self.MECH_GROUPS[g](name, cat):
                        seen.add(mid)
                        picked[code] = (m, g)
                        break
            div_id = (self._currency_map.get("divine") or {}).get("id")
            want = [m["id"] for m, _ in picked.values()] + ([div_id] if div_id else [])
            try:
                rates, hour = self._feed.rates(league, want)
            except Exception:
                rates, hour = {}, None  # offline: icons still show, prices don't
            try:
                manifest = self._art.manifest() if getattr(self, "_art", None) else {}
            except Exception:
                manifest = {}
            items, missing = {}, []
            for code, (m, g) in picked.items():
                img = m.get("img") or ""
                url = ("https://web.poecdn.com" + img) if img.startswith("/") else None
                if url and url not in manifest:
                    missing.append(url)
                items[code] = {"name": m["name"], "cat": m.get("cat", ""), "group": g,
                               "img": (manifest.get(url) or url) if url else None,
                               "chaos": rates.get(m["id"])}
            if missing and getattr(self, "_art", None):
                threading.Thread(target=self._art.cache, args=(missing[:300],), daemon=True).start()
            return {"ok": True, "hour": hour, "divine": rates.get(div_id) if div_id else None,
                    "items": items}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def cx_overview(self, league):
        """Every currency-exchange item priced in the latest hour, with 7 days of
        6-hourly history: {'ok', 'hour', 'items': {code: {name, cat, img, s: [[unix hour,
        chaos, chaos volume], ...]}}}. One feed read covers all items (~28 cached hours)."""
        try:
            series, hour = self._feed.history(league, None, days=7, step_hours=self.cx_step(7))
            by_id = {}
            for code, m in self._currency_map.items():
                prev = by_id.get(m["id"])
                if prev is None or len(code) < len(prev):  # duplicate rows: shortest code
                    by_id[m["id"]] = code
            items = {}
            for mid, pts in series.items():
                code = by_id.get(mid)
                if not code or not pts:
                    continue
                m = self._currency_map[code]
                items[code] = {"name": m["name"], "cat": m.get("cat", ""), "img": m.get("img", ""),
                               "s": [[h, float("%.4g" % v), int(vol)] for h, v, vol in pts]}
            return {"ok": True, "hour": hour, "items": items}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- quick prices: no trade-site call ------------------------------------------------
    def _ninja_prices(self, league):
        """The backend's poe.ninja snapshot for a league, kept for PRICES_TTL in memory."""
        cache = getattr(self, "_ninja_cache", None)
        if cache is None:
            cache = self._ninja_cache = {}
        hit = cache.get(league)
        if hit and time.time() - hit[0] < PRICES_TTL:
            return hit[1]
        req = urllib.request.Request(PRICES_API + "?" + urllib.parse.urlencode({"league": league}),
                                     headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        cache[league] = (time.time(), data)
        return data

    def _divcard_drops(self):
        """Drop data: the backend's copy (newest), else the last one downloaded, else the one
        shipped with the app. Kept in memory for DIVCARDS_TTL."""
        hit = getattr(self, "_divcards_cache", None)
        if hit and time.time() - hit[0] < DIVCARDS_TTL:
            return hit[1]
        disk = os.path.join(DATA_DIR, "divcards_cache.json")
        data = None
        try:
            req = urllib.request.Request(DIVCARDS_API, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=40) as r:
                data = json.loads(r.read().decode("utf-8"))
            if len(data.get("cards") or []) < 100:
                raise ValueError("incomplete drop data")
            try:
                with open(disk, "w", encoding="utf-8") as f:
                    json.dump(data, f)
            except OSError:
                pass
        except Exception:
            for path in (disk, os.path.join(DATA_DIR, "divcards.json")):  # offline
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    data["stale"] = True
                    break
                except (OSError, ValueError):
                    continue
            if data is None:
                raise RuntimeError("no drop data (offline and none shipped)")
        self._divcards_cache = (time.time(), data)
        return data

    @staticmethod
    def _cheatsheets_ok(data):
        """The app shows whatever this returns: only a complete, well-formed copy counts."""
        try:
            acts, mech = data.get("acts") or {}, data.get("mechanics") or []
            return (isinstance(data.get("version"), int) and len(acts) >= 10 and isinstance(mech, list)
                    and all(isinstance(m.get("id"), str) and isinstance(m.get("sections"), list) for m in mech))
        except AttributeError:
            return False

    def cheatsheets_data(self):
        """Cheat sheets: the server's copy (newest), else the last one downloaded. The page
        compares its version with the copy shipped in data/cheatsheets.js and keeps the newer."""
        try:
            hit = getattr(self, "_cheatsheets_cache", None)
            if hit and time.time() - hit[0] < CHEATSHEETS_TTL:
                return {"ok": True, "data": hit[1]}
            disk = os.path.join(DATA_DIR, "cheatsheets_cache.json")
            data = None
            try:
                req = urllib.request.Request(CHEATSHEETS_API, headers={"User-Agent": UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read().decode("utf-8"))
                if not self._cheatsheets_ok(data):
                    raise ValueError("incomplete cheat sheets")
                try:
                    with open(disk, "w", encoding="utf-8") as f:
                        json.dump(data, f)
                except OSError:
                    pass
            except Exception:
                try:
                    with open(disk, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (OSError, ValueError):
                    data = None
                if not (data and self._cheatsheets_ok(data)):
                    return {"ok": False, "error": "offline: using the sheets shipped with the app"}
            self._cheatsheets_cache = (time.time(), data)
            return {"ok": True, "data": data}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _guides_ok(data):
        """Mechanic guides: only a complete, well-formed copy counts (the page draws what this returns)."""
        try:
            guides = data.get("guides") or {}
            return (isinstance(data.get("version"), int) and not isinstance(data.get("version"), bool)
                    and isinstance(guides, dict) and len(guides) >= 15
                    and all(isinstance(k, str) and isinstance(g, dict) and isinstance(g.get("title"), str)
                            and isinstance(g.get("summary"), str) and isinstance(g.get("readMore"), list)
                            and all(isinstance(r, dict) and str(r.get("url", "")).startswith(("https://", "http://"))
                                    for r in g["readMore"])
                            for k, g in guides.items())
                    and isinstance(data.get("sheets", []), list))
        except (AttributeError, TypeError):
            return False

    def guides_data(self):
        """Mechanic guides: the server's copy (newest), else the last one downloaded. The page
        compares its version with the copy shipped in data/guides.js and keeps the newer."""
        try:
            hit = getattr(self, "_guides_cache", None)
            if hit and time.time() - hit[0] < GUIDES_TTL:
                return {"ok": True, "data": hit[1]}
            disk = os.path.join(DATA_DIR, "guides_cache.json")
            data = None
            try:
                req = urllib.request.Request(GUIDES_API, headers={"User-Agent": UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = json.loads(r.read().decode("utf-8"))
                if not self._guides_ok(data):
                    raise ValueError("incomplete guides")
                try:
                    with open(disk, "w", encoding="utf-8") as f:
                        json.dump(data, f)
                except OSError:
                    pass
            except Exception:
                try:
                    with open(disk, "r", encoding="utf-8") as f:
                        data = json.load(f)
                except (OSError, ValueError):
                    data = None
                if not (data and self._guides_ok(data)):
                    return {"ok": False, "error": "offline: using the guides shipped with the app"}
            self._guides_cache = (time.time(), data)
            return {"ok": True, "data": data}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _guide_urls(self):
        """Every guide's written sources (Read more): the only other pages open_url may open. From
        the shipped data/guides.js and the server copy (memory, else the disk cache), read once."""
        urls = getattr(self, "_guide_url_set", None)
        if getattr(self, "_guides_cache", None) is not getattr(self, "_guide_url_src", None):
            urls = None  # a server copy arrived since the last read: read again
        if urls is None:
            urls = set()
            copies = []
            try:
                with open(os.path.join(DATA_DIR, "guides.js"), "r", encoding="utf-8") as f:
                    m = re.search(r"window\.POE_GUIDES\s*=\s*(\{.*\})\s*;\s*$", f.read(), re.S)
                copies.append(json.loads(m.group(1)) if m else None)
            except (OSError, ValueError):
                pass
            hit = getattr(self, "_guides_cache", None)
            if hit:
                copies.append(hit[1])
            else:
                try:
                    with open(os.path.join(DATA_DIR, "guides_cache.json"), "r", encoding="utf-8") as f:
                        copies.append(json.load(f))
                except (OSError, ValueError):
                    pass
            for d in copies:
                if d and self._guides_ok(d):
                    for g in d["guides"].values():
                        urls.update(r["url"] for r in g["readMore"])
            self._guide_url_set, self._guide_url_src = urls, hit
        return urls

    DIVCARDS_LAST = "divcards_last.json"  # last full answer per league, shown at once after a restart

    def div_cards(self, league, last=False):
        """Div cards tool: every card with where it drops (wiki, via the backend), its stack
        size and its price each from GGG's hourly exchange feed. last=True: no network, the
        last answer saved for this league (marked "cached"), so the view opens at once while
        the page asks again for fresh prices."""
        path = os.path.join(DATA_DIR, self.DIVCARDS_LAST)
        if last:
            try:
                with open(path, "r", encoding="utf-8") as f:
                    saved = (json.load(f) or {}).get(league)
                if not (saved and saved.get("cards")):
                    return {"ok": False, "error": "no saved copy"}
                return dict(saved, cached=True)
            except (OSError, ValueError, AttributeError):
                return {"ok": False, "error": "no saved copy"}
        out = self._div_cards_fresh(league)
        if out.get("ok"):
            try:
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        keep = json.load(f)
                    keep = keep if isinstance(keep, dict) else {}
                except (OSError, ValueError):
                    keep = {}
                keep.pop(league, None)
                keep = dict(list(keep.items())[-3:])  # this league + the 3 most recent others
                keep[league] = out
                tmp = path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(keep, f, separators=(",", ":"))
                os.replace(tmp, path)
            except OSError:
                pass
        return out

    def _div_cards_fresh(self, league):
        try:
            data = self._divcard_drops()
            ids = {m["name"]: (code, m["id"]) for code, m in self._currency_map.items() if m.get("cat") == "Cards"}
            div_id = (self._currency_map.get("divine") or {}).get("id")
            want = [v[1] for v in ids.values()] + ([div_id] if div_id else [])
            rates, hour = self._feed.rates(league, want)
            cards = []
            for c in data.get("cards", []):
                o = dict(c)
                code_id = ids.get(c.get("n"))
                if code_id:
                    o["code"] = code_id[0]
                    if rates.get(code_id[1]) is not None:
                        o["c"] = rates[code_id[1]]
                cards.append(o)
            return {"ok": True, "source": data.get("source"), "fetchedAt": data.get("fetchedAt"),
                    "stale": bool(data.get("stale")), "areas": data.get("areas", []), "cards": cards,
                    "divine": rates.get(div_id) if div_id else None, "priceHour": hour}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def unique_prices(self, league):
        """Dust explorer: the cheapest plain copy of every unique (not 5/6-linked, not
        corrupted, no variant unless that's all there is) from the backend's poe.ninja
        snapshot: [[name, base, chaos, listings, poe.ninja type], ...], plus chaos per divine."""
        try:
            data = self._ninja_prices(league)
            best = {}
            for k, t in ((data or {}).get("types") or {}).items():
                if not k.startswith("Unique"):
                    continue
                for l in t.get("lines", []):
                    if (l.get("l") or 0) >= 5 or l.get("cr"):
                        continue
                    key = (l.get("n"), l.get("b") or "")
                    old = best.get(key)
                    if old is None or (bool(l.get("v")), l.get("c", 0)) < (bool(old[1].get("v")), old[1].get("c", 0)):
                        best[key] = (k, l)
            div_id = (self._currency_map.get("divine") or {}).get("id")
            rates, _ = self._feed.rates(league, [div_id]) if div_id else ({}, None)
            return {"ok": True, "divine": rates.get(div_id) if div_id else None,
                    "items": [[n, b, l.get("c", 0), l.get("lc"), k] for (n, b), (k, l) in best.items()]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def beast_prices(self, league):
        """Search text → Beasts: every captured beast poe.ninja prices, from the backend's
        snapshot: [[name, chaos, listings], ...], plus chaos per divine."""
        try:
            data = self._ninja_prices(league)
            lines = (((data or {}).get("types") or {}).get("Beast") or {}).get("lines") or []
            best = {}
            for l in lines:
                n = l.get("n")
                if n and (n not in best or (l.get("c") or 0) < (best[n].get("c") or 0)):
                    best[n] = l
            div_id = (self._currency_map.get("divine") or {}).get("id")
            rates, _ = self._feed.rates(league, [div_id]) if div_id else ({}, None)
            return {"ok": True, "divine": rates.get(div_id) if div_id else None,
                    "items": [[n, l.get("c", 0), l.get("lc")] for n, l in best.items()]}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _ninja_match(data, item):
        """Best poe.ninja line for a pasted item: uniques by name (+ links), gems by name,
        level, quality and corruption. None when there's no confident match."""
        name, rarity = item.get("name") or "", (item.get("rarity") or "").upper()
        types = (data or {}).get("types") or {}
        if rarity == "GEM":
            lines = [l for l in (types.get("SkillGem") or {}).get("lines", []) if l.get("n") == name]
            lvl, q, cr = item.get("gemLevel") or 1, item.get("quality") or 0, 1 if item.get("corrupted") else 0
            lines = [l for l in lines if l.get("gl", 1) == lvl and l.get("cr", 0) == cr and l.get("gq", 0) <= q]
            return max(lines, key=lambda l: l.get("gq", 0), default=None)
        if rarity in ("UNIQUE", "RELIC"):
            links = item.get("links") or 0
            cands = [l for k, t in types.items() if k.startswith("Unique") or k == "ForbiddenJewel"
                     for l in t.get("lines", []) if l.get("n") == name]
            wanted = links if links >= 5 else 0
            exact = [l for l in cands if (l.get("l") or 0) == wanted]
            pool = exact or cands
            # several variants: the cheapest is the honest floor
            return min(pool, key=lambda l: l.get("c", 0), default=None)
        return None

    def quick_price(self, league, item_json):
        """Instant price for a pasted / Ctrl+D item without a trade search: exchange items
        (currency, fragments, scarabs, cards…) from GGG's hourly feed, uniques and gems from
        poe.ninja via the app's backend. {'ok', 'source', 'chaos', 'divine', 'listings',
        'stack', 'stackChaos'}; ok False when nothing matches."""
        try:
            item = json.loads(item_json)
            name = (item.get("name") or "").strip()
            by_name, code_by_name = {}, {}
            for code, m in self._currency_map.items():
                key = m["name"].lower()
                by_name.setdefault(key, m["id"])
                if key not in code_by_name or len(code) < len(code_by_name[key]):
                    code_by_name[key] = code  # duplicate rows: shortest trade code
            div_id = (self._currency_map.get("divine") or {}).get("id")
            key = name.lower() if name.lower() in by_name else (item.get("base") or "").lower()
            mid = by_name.get(key)
            if mid:
                rates, hour = self._feed.rates(league, [mid, div_id] if div_id else [mid])
                if rates.get(mid) is not None:
                    each = rates[mid]
                    code = code_by_name.get(key)
                    out = {"ok": True, "source": "GGG currency exchange", "chaos": each, "code": code,
                           "cat": (self._currency_map.get(code) or {}).get("cat"),  # e.g. "Currency", "Cards"
                           "divine": each / rates[div_id] if rates.get(div_id) else None}
                    stack = int(item.get("stackSize") or 0)
                    if stack > 1:
                        out["stack"], out["stackChaos"] = stack, stack * each
                    return out
            line = self._ninja_match(self._ninja_prices(league), item)
            if line:
                return {"ok": True, "source": "poe.ninja", "chaos": line.get("c"), "divine": line.get("d"),
                        "listings": line.get("lc")}
            return {"ok": False, "error": "no quick price for this item"}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def bulk_exchange(self, league, code):
        """Live bulk-exchange offers for one exchange item (one trade request, made when the
        user presses the button): who sells it for chaos or divines right now, cheapest first.
        {'ok', 'offers': [{seller, online, afk, pay, payCurrency, get, stock, chaosEach}], 'total'}"""
        try:
            if code not in self._currency_map:
                return {"ok": False, "error": "not an exchange item"}
            div = self._divine_rate(league)
            res = self._http("%s/exchange/%s" % (TRADE_BASE, urllib.request.quote(league)),
                             {"query": {"status": {"option": "online"}, "want": [code],
                                        "have": ["chaos", "divine"] if div else ["chaos"]},
                              "sort": {"have": "asc"}})
            result = res.get("result") or {}
            offers = []
            for entry in (result.values() if isinstance(result, dict) else []):
                li = entry.get("listing") or {}
                acct = li.get("account") or {}
                online = acct.get("online")
                for off in (li.get("offers") or [])[:1]:
                    ex, it = off.get("exchange") or {}, off.get("item") or {}
                    if not it.get("amount") or not ex.get("amount"):
                        continue
                    per = {"chaos": 1.0, "divine": div}.get(ex.get("currency"))
                    offers.append({"seller": acct.get("name", ""), "online": bool(online),
                                   "afk": isinstance(online, dict) and online.get("status") == "afk",
                                   "pay": ex["amount"], "payCurrency": ex.get("currency"), "get": it["amount"],
                                   "stock": it.get("stock"),
                                   "chaosEach": float(ex["amount"]) * per / float(it["amount"]) if per else None})
            offers.sort(key=lambda o: o["chaosEach"] if o["chaosEach"] is not None else float("inf"))
            return {"ok": True, "offers": offers[:20], "total": res.get("total", len(offers))}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _codes_by_id(self):
        by_id = {}
        for code, m in self._currency_map.items():
            prev = by_id.get(m["id"])
            if prev is None or len(code) < len(prev):  # duplicate rows: shortest code
                by_id[m["id"]] = code
        return by_id

    def cx_flips(self, league):
        """Items that traded against BOTH chaos and divines in the latest hour, with the
        price in each market (chaos; the divine side converted at that hour's divine rate):
        {'ok', 'hour', 'div', 'rows': [{code, name, cat, img, viaChaos, viaDiv, divEach, gap,
        buyWith: 'chaos'|'divine', volume, cRange, dRange}]}. gap = how much more the dearer
        market paid (0.05 = 5%); volume = the thinner market's chaos traded that hour."""
        try:
            digest, hour = self._feed.pairs(league)
            div = digest.get("div")
            by_id = self._codes_by_id()
            rows = []
            for mid, mk in (digest.get("items") or {}).items():
                c, d, code = mk.get("c"), mk.get("d"), by_id.get(mid)
                if not (c and d and code and div):
                    continue
                via_chaos, via_div = c[0], d[0] * div
                if via_chaos <= 0 or via_div <= 0:
                    continue
                m = self._currency_map[code]
                rows.append({"code": code, "name": m["name"], "cat": m.get("cat", ""), "img": m.get("img", ""),
                             "viaChaos": round(via_chaos, 4), "viaDiv": round(via_div, 4), "divEach": d[0],
                             "gap": round(max(via_chaos, via_div) / min(via_chaos, via_div) - 1, 4),
                             "buyWith": "chaos" if via_chaos < via_div else "divine",
                             "volume": min(c[1], d[1]), "cRange": c[2:4], "dRange": d[2:4]})
            rows.sort(key=lambda r: -r["gap"])
            return {"ok": True, "hour": hour, "div": div, "rows": rows}
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

    @staticmethod
    def _pc_leagues(data):
        seen, out = set(), []
        for l in (data or {}).get("result", []):
            if l.get("realm", "pc") == "pc" and l.get("id") and l["id"] not in seen:
                seen.add(l["id"])
                out.append({"id": l["id"], "text": l.get("text") or l["id"]})
        return out

    def league_check(self):
        """Live PC trade leagues vs the bundled list, so the app can offer the new league
        on launch day: {'ok', 'leagues': [{id, text}], 'new': [ids missing from bundled data]}.
        One background call — skipped during any rate-limit cooldown."""
        try:
            live = self._pc_leagues(self._http(TRADE_BASE + "/data/leagues", background=True))
            if not live:
                return {"ok": False, "error": "unexpected API response"}
            try:
                with open(os.path.join(DATA_DIR, "leagues.json"), encoding="utf-8") as f:
                    bundled = {l["id"] for l in self._pc_leagues(json.load(f))}
            except Exception:
                bundled = set()
            return {"ok": True, "leagues": live, "new": [l["id"] for l in live if l["id"] not in bundled]}
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
        # typed ctypes prototypes live in price_hotkey (64-bit safe handles)
        price_hotkey.set_clipboard_text(text)

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

    # -- in-game price-check hotkey + overlay ----------------------------------------
    # Hotkey (default Ctrl+D) is held only while Path of Exile is the foreground
    # window. On press: Ctrl+C the hovered item, restore the clipboard, push the
    # item into the always-on-top overlay window, which prices it through this
    # same Api instance — so the overlay shares the global GGG rate limiter.
    def _destroy_once(self, window):
        """Close a window exactly once. pywebview's WinForms backend deletes the window's
        uid from its registry in the form's Closed event; a second close of the same
        window raises KeyError('child_…') inside that .NET event, which Windows shows as
        an "Unhandled exception" dialog (seen on Install & restart, which closed the
        overlay twice: directly and via main_closed)."""
        with self._destroy_lock:
            if window.uid in self._destroyed:
                return
            self._destroyed.add(window.uid)
        try:
            window.destroy()
        except Exception:
            pass

    def _attach_windows(self, main_window, overlay):
        self._overlay = overlay

        def main_closed():
            # the hidden overlay would otherwise keep the app alive
            _debug_log("main window closed: app exiting")
            self._quitting = True
            self._destroy_once(overlay)

        def overlay_closing():
            _debug_log("price check: close requested (app quitting=%s)" % self._quitting)
            if self._quitting:
                return True
            # the overlay's own close box only hides it (it is reused on every press)
            threading.Thread(target=self._hide_overlay, daemon=True).start()
            return False

        main_window.events.closed += main_closed
        overlay.events.closing += overlay_closing

    def _attach_trades(self, main_window, trades, overlays):
        self._main = main_window
        self._trades = trades
        self._overlay_windows = overlays

        def main_closing():
            # ✕ on the main window: to the tray (Settings → "Close to tray"), like other tray apps
            if self._quitting or not self._close_to_tray():
                _debug_log("main window: close requested, quitting")
                return True
            _debug_log("main window: close requested, hiding to the tray")
            threading.Thread(target=self._hide_main_to_tray, daemon=True).start()
            return False

        def main_closed():
            self._quitting = True
            if self._tail:
                self._tail.stop()
            if self._tray:
                self._tray.stop()
            for w in overlays.values():
                self._destroy_once(w)

        def overlay_closing():
            _debug_log("overlay: close requested (app quitting=%s)" % self._quitting)
            return bool(self._quitting)  # Alt+F4 on an overlay must not end the app

        main_window.events.closing += main_closing
        main_window.events.closed += main_closed
        for w in overlays.values():
            w.events.closing += overlay_closing
        threading.Thread(target=self._follow_game, daemon=True, name="overlay-follow").start()
        if sys.platform == "win32":
            threading.Thread(target=self._watch_foreground, daemon=True, name="foreground-hook").start()

    # -- tray icon + main window over the game ----------------------------------------
    def _main_hwnd(self):
        """The main window's handle, asked from its form: over the game its title is cleared
        (that's how the title bar goes away) and WinForms re-creates the window for that (new
        handle), so neither an old handle nor a title search would find it then. Kept while it
        is still a window (this runs on every overlay tick)."""
        return self._form_hwnd("_main_hwnd_cache", self._main_form() if self._main else None, MAIN_TITLE)

    def _form_hwnd(self, cache, form, title):
        h = getattr(self, cache, 0)
        if h and sys.platform == "win32":
            import ctypes
            if ctypes.windll.user32.IsWindow(h):
                return h
        h = 0
        if form is not None:
            try:
                h = int(self._on_ui(lambda: form.Handle.ToInt64(), form) or 0)
            except Exception:
                h = 0
        h = h or price_hotkey.find_window(title)
        setattr(self, cache, h)
        return h

    def _main_form(self):
        """pywebview's WinForms form for the main window (changes to it must run on its UI thread)."""
        try:
            from webview.platforms.winforms import BrowserView
            return BrowserView.instances.get(self._main.uid)
        except Exception:
            return None

    def _price_form(self):
        """pywebview's WinForms form for the price check (None off Windows / before it exists)."""
        try:
            from webview.platforms.winforms import BrowserView
            return BrowserView.instances.get(self._overlay.uid) if self._overlay else None
        except Exception:
            return None

    def _price_hwnd(self):
        """The price-check window's handle. Asked from its form: dropping the title bar makes
        WinForms re-create the window (new handle) and clears the title, so neither a cached
        handle nor a title search would find it afterwards."""
        return self._form_hwnd("_price_hwnd_cache", self._price_form(), OVERLAY_TITLE)

    def _price_frameless(self):
        """The price check is always an overlay, so it has no title bar: drag its banner to move
        it, its edges still resize it. Same WinForms change as the app over the game (no title
        text + no control box), made once on the window's own UI thread."""
        if sys.platform != "win32" or getattr(self, "_price_frame_done", False):
            return
        form = self._price_form()
        if form is None:
            return

        def apply():
            form.ControlBox = False
            form.Text = ""
        self._on_ui(apply, form)
        self._price_frame_done = True

    def price_overlay_move(self, phase, dx=0, dy=0):
        """Price-check banner drag: start / move by (dx, dy) CSS px / end. The next press
        places it beside the hovered item again."""
        try:
            import ctypes
            u = ctypes.windll.user32
            hwnd = self._price_hwnd()
            r = price_hotkey.window_rect(hwnd)
            if not r:
                return {"ok": False}
            if phase == "start" or not getattr(self, "_price_drag_from", None):
                self._price_drag_from = (r[0], r[1])
                if phase == "start":
                    return {"ok": True}
            scale = u.GetDpiForWindow(hwnd) / 96.0 if hasattr(u, "GetDpiForWindow") else 1.0
            x = int(self._price_drag_from[0] + float(dx) * scale)
            y = int(self._price_drag_from[1] + float(dy) * scale)
            u.SetWindowPos(hwnd, 0, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010)  # NOSIZE | NOZORDER | NOACTIVATE
            if phase == "end":
                self._price_drag_from = None
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _on_ui(self, fn, form=None):
        """Run fn on the main window's WinForms UI thread and wait for it (WinForms only behaves
        when its forms are changed from their own thread)."""
        form = form or self._main_form()
        if form is None:
            return fn()
        from System import Func, Type
        if not form.InvokeRequired:
            return fn()
        box = {}

        def call():
            box["r"] = fn()

        form.Invoke(Func[Type](call))
        return box.get("r")

    def _start_tray(self):
        """Notification-area icon: click opens the app; right-click menu like other tray apps."""
        if sys.platform != "win32" or self._tray:
            return
        try:
            import tray
            self._tray = tray.TrayIcon(
                "PoB Trade Finder", icon_path=os.path.join(APP_DIR, "icon.ico"), log=_debug_log,
                on_click=lambda: self._show_main(),
                menu=[("Open PoB Trade Finder", lambda: self._show_main()),
                      ("Trade helper", lambda: self._show_trades(activate=True)),
                      ("Settings", lambda: self._show_main(settings=True)),
                      None,
                      ("Quit", self._quit)])
            if not self._tray.start():
                _debug_log("tray icon unavailable")
                self._tray = None
        except Exception as e:
            _debug_log("tray icon unavailable: %s" % e)
            self._tray = None

    def _quit(self):
        """Tray → Quit: really exit (closing the main window only hides it to the tray)."""
        _debug_log("quit from the tray")
        self._quitting = True
        if self._tray:
            self._tray.stop()
        self._destroy_once(self._main)

    def quit_app(self):
        try:
            threading.Thread(target=self._quit, daemon=True).start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _prefs(self):
        try:
            return json.loads(self._storage.get("pobtf-prefs") or "{}")
        except Exception:
            return {}

    def _close_to_tray(self):
        return bool(self._tray and self._tray.running and self._prefs().get("closeToTray", True) is not False)

    def _hide_main_to_tray(self):
        if self._app_overlay:
            self._set_app_overlay(False, refocus=True)
        self._main.hide()
        if not self._storage.get("pobtf-tray-told"):
            self.storage_set("pobtf-tray-told", "1")
            self._tray.notify("PoB Trade Finder is still running",
                              "It's in the tray. Right-click the icon to open it or quit.")

    def _show_main(self, settings=False, over_game=False):
        main = self._main
        if not main:
            return
        main.show()
        hwnd = self._main_hwnd()
        if hwnd and sys.platform == "win32":
            import ctypes
            u = ctypes.windll.user32
            if u.IsIconic(hwnd):
                u.ShowWindow(hwnd, 9)  # SW_RESTORE
            if over_game:  # frameless, on top and sized over the game first, then focused
                self._overlay_frame(True)
            price_hotkey.focus_window(hwnd)
        if settings:
            self._eval_in(main, "window.openSettings && openSettings()")

    def _set_app_overlay(self, on, refocus=True):
        """App hotkey: the main window over the game (trades, gear, settings without alt-tab);
        again, or Esc, puts it back and returns to the game."""
        self._app_overlay = bool(on)
        self._app_overlay_at = time.time()
        self._eval_in(self._main, "window.__appOverlay && window.__appOverlay(%s)" % ("true" if on else "false"))
        if on:
            self._show_main(over_game=True)
            return
        self._overlay_frame(False)
        if self._close_to_tray() and self._main_was_hidden:
            self._main.hide()
        game = self._find_poe_window()
        if refocus and game:
            price_hotkey.focus_window(game)

    OVER_GAME_POS = "pobtf-overgame-rect"  # where the app sits over the game, as fractions of it
    OVER_GAME_DEFAULT = (0.11, 0.07, 0.78, 0.86)

    def _over_game_rect(self, g):
        """Screen rect for the app over the game: your last size/spot (fractions of the game
        window, so it follows resolution and screens), else centred at 78% x 86%."""
        try:
            fx, fy, fw, fh = json.loads(self._storage.get(self.OVER_GAME_POS) or "null") or self.OVER_GAME_DEFAULT
        except Exception:
            fx, fy, fw, fh = self.OVER_GAME_DEFAULT
        fw, fh = max(0.3, min(1.0, fw)), max(0.3, min(1.0, fh))
        fx, fy = max(0.0, min(1.0 - fw, fx)), max(0.0, min(1.0 - fh, fy))
        return int(g[0] + fx * g[2]), int(g[1] + fy * g[3]), int(fw * g[2]), int(fh * g[3])

    def _remember_over_game_rect(self, hwnd=None):
        game = self._find_poe_window()
        g = trade_helper.game_client_rect(game) if game else None
        r = price_hotkey.window_rect(hwnd or self._main_hwnd())
        if not g or not r or not g[2] or not g[3]:
            return
        frac = [(r[0] - g[0]) / g[2], (r[1] - g[1]) / g[3], (r[2] - r[0]) / g[2], (r[3] - r[1]) / g[3]]
        self.storage_set(self.OVER_GAME_POS, json.dumps([round(v, 4) for v in frac]))

    def _overlay_frame(self, on):
        """Over the game the main window drops its title bar (an overlay, not a desktop window)
        but keeps resizable edges; drag the banner to move it, − / + to resize. Its size and
        spot are remembered relative to the game. Off puts the window back exactly as it was.
        Done through WinForms on its UI thread (no title text + no control box = no title bar),
        so WinForms doesn't put its own frame and size back later."""
        if sys.platform != "win32":
            return
        form = self._main_form()
        if form is None:
            return
        from System.Drawing import Rectangle
        from System.Windows.Forms import FormWindowState
        if on:
            game = self._find_poe_window()
            g = trade_helper.game_client_rect(game) if game else None
            if not g:
                return
            x, y, w, h = self._over_game_rect(g)
            pct = int(self._prefs().get("overGameOpacity", 100))

            def apply():
                if getattr(self, "_frame_saved", None) is None:
                    if form.WindowState != FormWindowState.Normal:
                        form.WindowState = FormWindowState.Normal
                    b = form.Bounds
                    self._frame_saved = (form.Text, form.ControlBox, (b.X, b.Y, b.Width, b.Height), form.Opacity)
                form.ControlBox = False
                form.Text = ""
                form.TopMost = True
                form.Bounds = Rectangle(x, y, w, h)
                if pct < 100:  # see-through only when asked for (WebView2 + layered windows varies by GPU/driver)
                    form.Opacity = max(60, pct) / 100.0
            self._on_ui(apply)
            self._debug_frame("on")
            return
        if getattr(self, "_frame_saved", None) is None:
            return
        self._remember_over_game_rect(self._main_hwnd())  # keeps a resize done with the window edges
        text, box, r, opacity = self._frame_saved
        self._frame_saved = None

        def restore():
            form.TopMost = False
            form.Opacity = opacity
            form.ControlBox = box
            form.Text = text or MAIN_TITLE
            form.Bounds = Rectangle(*r)
        self._on_ui(restore)
        self._debug_frame("off")

    def _debug_frame(self, what):
        r = price_hotkey.window_rect(self._main_hwnd())
        _debug_log("app over game %s: window %s" % (what, r))

    def app_overlay_move(self, phase, dx=0, dy=0):
        """Banner drag over the game: start / move by (dx, dy) CSS px / end (remembered)."""
        try:
            import ctypes
            u = ctypes.windll.user32
            hwnd = self._main_hwnd()
            r = price_hotkey.window_rect(hwnd)
            if not self._app_overlay or not r:
                return {"ok": False}
            if phase == "start" or not getattr(self, "_app_drag_from", None):
                self._app_drag_from = (r[0], r[1])
                if phase == "start":
                    return {"ok": True}
            scale = u.GetDpiForWindow(hwnd) / 96.0 if hasattr(u, "GetDpiForWindow") else 1.0
            x = int(self._app_drag_from[0] + float(dx) * scale)
            y = int(self._app_drag_from[1] + float(dy) * scale)
            u.SetWindowPos(hwnd, 0, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010)  # NOSIZE | NOZORDER | NOACTIVATE
            if phase == "end":
                self._app_drag_from = None
                self._remember_over_game_rect(hwnd)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def app_overlay_size(self, step):
        """Banner − / +: 10% of the game smaller / larger, kept centred where it is."""
        try:
            import ctypes
            u = ctypes.windll.user32
            hwnd = self._main_hwnd()
            game = self._find_poe_window()
            g = trade_helper.game_client_rect(game) if game else None
            r = price_hotkey.window_rect(hwnd)
            if not self._app_overlay or not g or not r:
                return {"ok": False}
            d = 0.1 if float(step) > 0 else -0.1
            w = int(max(0.3, min(1.0, (r[2] - r[0]) / g[2] + d)) * g[2])
            h = int(max(0.3, min(1.0, (r[3] - r[1]) / g[3] + d)) * g[3])
            cx, cy = (r[0] + r[2]) // 2, (r[1] + r[3]) // 2
            x = max(g[0], min(g[0] + g[2] - w, cx - w // 2))
            y = max(g[1], min(g[1] + g[3] - h, cy - h // 2))
            u.SetWindowPos(hwnd, 0, x, y, w, h, 0x0004 | 0x0010)
            self._remember_over_game_rect(hwnd)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def app_overlay(self, on):
        """Esc / ✕ in the in-game app banner."""
        try:
            self._set_app_overlay(bool(on))
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _on_app_hotkey(self, hwnd):
        if self._app_overlay:
            self._set_app_overlay(False)
            return
        main = self._main_hwnd()
        import ctypes
        self._main_was_hidden = not (main and ctypes.windll.user32.IsWindowVisible(main))
        self._set_app_overlay(True)

    def _on_trades_hotkey(self, hwnd):
        self.overlay_toggle_cards()

    def _on_sheet_hotkey(self, hwnd):
        self.overlay_toggle_sheet()

    def _hotkey_target(self):
        """Hotkeys work while the game, one of our overlays, or the app over the game is in front."""
        fg = price_hotkey.foreground_game_window()
        if fg:
            return fg
        import ctypes
        cur = ctypes.windll.user32.GetForegroundWindow()
        ours = {price_hotkey.find_window(o["title"]) for o in OVERLAYS.values()}
        if self._app_overlay:
            ours.add(self._main_hwnd())
        return cur if cur and cur in ours else None

    def _start_hotkey(self):
        if sys.platform != "win32" or self._hotkeys:
            return
        fire = {"price": self._on_price_hotkey, "app": self._on_app_hotkey, "trades": self._on_trades_hotkey,
                "sheet": self._on_sheet_hotkey, "filter": self._on_filter_hotkey}
        for name, fn in fire.items():
            try:
                w = price_hotkey.HotkeyWatcher(fn, self._hotkey_specs[name], log=_debug_log,
                                               is_target=None if name in GAME_ONLY_HOTKEYS else self._hotkey_target)
                w.start()
                self._hotkeys[name] = w
            except Exception as e:
                _debug_log("%s hotkey unavailable: %s" % (name, e))
        self._hotkey = self._hotkeys.get("price")
        self._start_macro_hotkeys()

    def _stop_hotkey(self):
        for w in self._hotkeys.values():
            w.stop()
        for w in self._macro_watchers:
            w.stop()

    # -- chat macros: one press (button or hotkey) = one chat command, nothing else --------
    MACRO_RE = re.compile(r"^/[A-Za-z_]{1,40}( [^\r\n]{1,200})?$")
    MAX_MACROS = 12

    def _clean_macros(self, macros):
        """Validated macro list [{label, command, hotkey}] and a list of problems."""
        out, errors, used = [], [], {s for s in self._hotkey_specs.values() if s not in price_hotkey.OFF}
        for m in list(macros)[:self.MAX_MACROS]:
            if not isinstance(m, dict):
                continue
            cmd = str(m.get("command") or "").strip()
            if not self.MACRO_RE.fullmatch(cmd):
                errors.append("%r isn't a chat command (start with /, one line)" % cmd[:40])
                continue
            hk = str(m.get("hotkey") or "off").strip().lower().replace(" ", "")
            try:
                price_hotkey.parse_hotkey(hk)
            except ValueError as e:
                errors.append(str(e))
                hk = "off"
            if hk not in price_hotkey.OFF:
                if hk in used:
                    errors.append("%s is already used for another hotkey" % price_hotkey.hotkey_label(hk))
                    hk = "off"
                else:
                    used.add(hk)
            out.append({"label": str(m.get("label") or cmd)[:40], "command": cmd, "hotkey": hk})
        return out, errors

    def _start_macro_hotkeys(self):
        if sys.platform != "win32":
            return
        for w in self._macro_watchers:
            w.stop()
        self._macro_watchers = []
        for m in self._macros:
            if m["hotkey"] in price_hotkey.OFF:
                continue
            try:  # default target: only while the game itself is the foreground window
                w = price_hotkey.HotkeyWatcher(lambda hwnd, cmd=m["command"]: self.chat_macro(cmd), m["hotkey"],
                                               log=_debug_log)
                w.start()
                self._macro_watchers.append(w)
            except Exception as e:
                _debug_log("macro hotkey %s unavailable: %s" % (m["hotkey"], e))

    def set_macros(self, macros_json):
        """Settings → In game → Chat macros saved: re-register their hotkeys."""
        try:
            macros, errors = self._clean_macros(json.loads(macros_json or "[]"))
            self._macros = macros
            self._start_macro_hotkeys()
            return {"ok": True, "macros": macros, "errors": errors}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def chat_macro(self, command):
        """One chat command (/kingsmarch, /delve, /exit, your own) for one press."""
        cmd = str(command or "").strip()
        if not self.MACRO_RE.fullmatch(cmd):
            return {"ok": False, "error": "A macro must be one chat command starting with /"}
        try:
            if not self._sender:
                self._sender = trade_helper.ChatSender(find_game=self._find_poe_window)
            return self._sender.send(cmd)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_hotkey(self, name, spec):
        """Settings → In game: change one hotkey (price | app | trades) at runtime."""
        try:
            if name not in HOTKEY_DEFAULTS:
                return {"ok": False, "error": "unknown hotkey"}
            spec = (spec or "off").strip().lower().replace(" ", "")
            price_hotkey.parse_hotkey(spec)
            taken = [n for n, s in self._hotkey_specs.items() if n != name and s == spec and spec not in price_hotkey.OFF]
            taken += [m["label"] for m in self._macros if m["hotkey"] == spec and spec not in price_hotkey.OFF]
            if taken:
                return {"ok": False, "error": "%s is already used for another hotkey" % price_hotkey.hotkey_label(spec)}
            self._hotkey_specs[name] = spec
            if name == "price":
                self._hotkey_spec = spec
            if name in self._hotkeys:
                self._hotkeys[name].set_spec(spec)
            return self.hotkeys_status()
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    def hotkeys_status(self):
        out = {}
        for name, spec in self._hotkey_specs.items():
            w = self._hotkeys.get(name)
            st = w.status() if w else {"hotkey": spec, "label": price_hotkey.hotkey_label(spec), "active": False,
                                       "error": None if sys.platform == "win32" else "Windows only"}
            out[name] = st
        return {"ok": True, "hotkeys": out}

    def _on_price_hotkey(self, game_hwnd):
        text = price_hotkey.copy_item_text()
        if text:
            self._show_overlay(text, game_hwnd)

    def _show_overlay(self, text, game_hwnd=None):
        ov = self._overlay
        if not ov:
            return False
        # JSON-encoded: the item text reaches JS as a string literal, never as code
        ov.evaluate_js("window.__overlayItem ? (window.__overlayItem(%s), true) : false"
                       % json.dumps(text))
        self._price_frameless()
        hwnd = self._price_hwnd()
        game = price_hotkey.window_rect(game_hwnd)
        own = price_hotkey.window_rect(hwnd)
        if hwnd and game and own:
            size = (own[2] - own[0], own[3] - own[1])
            if getattr(self, "_filter_mode", False) and getattr(self, "_price_size", None):
                size = self._price_size  # back from the filter editor: the price check's own size
            x, y = price_hotkey.overlay_position(price_hotkey.cursor_x(), game, size)
            if size != (own[2] - own[0], own[3] - own[1]):
                self._resize_window(hwnd, x, y, size)
            else:
                price_hotkey.place_window(hwnd, x, y)
        self._filter_mode = False
        ov.show()
        # the hotkey press gives this process foreground rights; claim them so
        # Esc works straight away (on_top keeps it visible even if this fails)
        price_hotkey.focus_window(hwnd)
        return True

    # -- in-game loot filter editor (js/app/32-filter-editor.js) -------------------------
    # Ctrl+Shift+D over an item: the price-check window switches to the filter editor for that
    # item, docked beside the inventory (item on the right half) or the stash (left half).
    def _on_filter_hotkey(self, game_hwnd):
        # the advanced copy (Ctrl+Alt+C): affix names for HasExplicitMod, like Scalpel; a plain copy if that fails
        text = price_hotkey.copy_item_text(advanced=True) or price_hotkey.copy_item_text()
        if text:
            self._show_filter_editor(text, game_hwnd)

    def _show_filter_editor(self, text, game_hwnd=None):
        ov = self._overlay
        if not ov:
            return False
        # JSON-encoded: the item text and zone reach JS as literals, never as code
        ov.evaluate_js("window.__filterEditItem ? (window.__filterEditItem(%s, %s), true) : false"
                       % (json.dumps(text), json.dumps(self._zone)))
        self._price_frameless()
        hwnd = self._price_hwnd()
        game = price_hotkey.window_rect(game_hwnd)
        own = price_hotkey.window_rect(hwnd)
        if hwnd and game and own:
            size = (own[2] - own[0], own[3] - own[1])
            if not getattr(self, "_filter_mode", False):
                self._price_size = size  # the price check gets its own size back afterwards
            # Scalpel's panel: as tall as the game (8 px margins), the price check's width
            size = (size[0], max(300, (game[3] - game[1]) - 16))
            x, y = price_hotkey.dock_position(price_hotkey.cursor_x(), game, size)
            self._resize_window(hwnd, x, y, size)
        self._filter_mode = True
        ov.show()
        price_hotkey.focus_window(hwnd)
        return True

    @staticmethod
    def _resize_window(hwnd, x, y, size):
        try:
            import ctypes
            ctypes.windll.user32.SetWindowPos(hwnd, -1, int(x), int(y), int(size[0]), int(size[1]), 0x0010)  # TOPMOST, NOACTIVATE
        except Exception:
            price_hotkey.place_window(hwnd, x, y)

    def filter_zone(self):
        """The zone the editor uses for AreaLevel (None until Client.txt shows one)."""
        return {"ok": True, "zone": self._zone}

    def _hide_overlay(self):
        ov = self._overlay
        if not ov:
            return
        try:
            ov.evaluate_js("window.__overlayHidden && window.__overlayHidden()")
        except Exception:
            pass
        ov.hide()
        game = self._find_poe_window()
        if game:
            price_hotkey.focus_window(game)  # hand the keyboard back to the game

    def overlay_hide(self):
        """Hide the price-check overlay (Esc / ✕ in the overlay) and refocus the game."""
        try:
            self._hide_overlay()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- trade helper (js/app/19-trades.js) -------------------------------------------
    # Reads Client.txt once the user switches it on; log events become cards in the
    # in-game overlay. GGG's rules: game commands go out only from a button press
    # (trade_send, one command per call), never from a log event or a timer.
    def _on_trade_event(self, ev):
        # cards live in the in-game overlay, which shows whenever the game is focused; the
        # cheat sheet follows the act from the area / zone lines
        self._eval_in(self._overlay_windows.get("cards"), "window.__tradeEvent && window.__tradeEvent(%s)" % json.dumps(ev))
        if ev.get("type") == "area" and not ev.get("test"):
            self._zone = {"level": ev.get("level"), "id": ev.get("id"), "time": ev.get("time")}
        if ev.get("type") in ("area", "zone"):
            for name in ("sheet", "hint"):  # the hint suggests a mechanic's sheet for the area
                self._eval_in(self._overlay_windows.get(name), "window.__sheetEvent && window.__sheetEvent(%s)" % json.dumps(ev))

    def trade_test(self, kind, league=None, act=None, area=None):
        """Trade helper → Setup → Test mode: made-up log lines through the real parser, shown
        in the overlays as test events (their buttons send nothing, nothing is saved).
        'full' plays a whole trade over ~12 s; 'clear' removes the test cards."""
        try:
            league = str(league or "Standard")[:60]
            if kind == "clear":
                self._on_trade_event({"type": "clear_tests", "test": True})
                return {"ok": True}
            steps = ([(0, "whisper"), (3, "joined"), (8, "accepted"), (11, "left")] if kind == "full"
                     else [(0, kind)])
            if any(k not in trade_helper.TEST_SCENARIOS for _, k in steps):
                return {"ok": False, "error": "unknown test"}

            def play():
                start = time.time()
                for at, k in steps:
                    time.sleep(max(0, at - (time.time() - start)))
                    for line in trade_helper.test_lines(k, league, act, area):
                        ev = trade_helper.parse_line(line)
                        if ev:
                            ev["test"] = True
                            self._on_trade_event(ev)

            threading.Thread(target=play, name="trade-test", daemon=True).start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _eval_in(self, win, js):
        if not win:
            return
        try:
            win.evaluate_js(js)
        except Exception as e:
            _debug_log("evaluate_js: %s" % e)

    # -- in-game overlays: icon + trade cards ---------------------------------------
    # Separate see-through windows (OVERLAYS), each shown only while Path of Exile (or one
    # of our windows) is the foreground window, like Awakened Trade's widget. Display only.
    # Each one can be dragged anywhere; its spot is kept relative to the game window, and
    # one placed in the lower half grows upwards (cards above the XP bar).
    def _overlay_pref(self, name):
        try:
            p = json.loads(self._storage.get("pobtf-trade-prefs") or "{}")
        except Exception:
            p = {}
        return p.get("icon", True) is not False if name == "icon" else True

    def _follow_game(self):
        import ctypes
        u = ctypes.windll.user32
        game, found_at = 0, 0.0
        while not self._quitting:
            time.sleep(0.3)
            try:
                now = time.time()
                if now - found_at > 2 or (game and not u.IsWindow(game)):
                    game, found_at = self._find_poe_window() or 0, now
                fg = u.GetForegroundWindow()
                # app over the game + a click back in the game: put it away (Settings can turn this off)
                if (self._app_overlay and game and fg == game and now - self._app_overlay_at > 1.0
                        and self._prefs().get("closeOnGameClick", True) is not False):
                    self._set_app_overlay(False, refocus=False)
                hwnds = {n: price_hotkey.find_window(o["title"]) for n, o in OVERLAYS.items()}
                ours = set(hwnds.values()) | {self._price_hwnd()}
                if self._app_overlay:
                    ours.add(self._main_hwnd())
                game_up = bool(game) and not u.IsIconic(game) and (fg == game or fg in ours)
                lbutton = u.GetAsyncKeyState(0x01) & 0x8000
                for name, hwnd in hwnds.items():
                    if hwnd:
                        self._follow_one(u, name, hwnd, game, game_up and self._overlay_pref(name)
                                         and self._ov[name]["content"], lbutton, now)
            except Exception as e:
                _debug_log("overlay follow: %s" % e)
                time.sleep(2)

    def _watch_foreground(self):
        """Windows tells us each time the foreground window changes (SetWinEventHook): a click
        back in the game while the app is over it puts the app away straight away, even if
        something activates the app again a moment later (polling could miss that)."""
        import ctypes
        from ctypes import wintypes
        u = ctypes.windll.user32
        EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT = 0x0003, 0x0000
        proc_t = ctypes.WINFUNCTYPE(None, wintypes.HANDLE, wintypes.DWORD, wintypes.HWND, wintypes.LONG,
                                    wintypes.LONG, wintypes.DWORD, wintypes.DWORD)

        def on_event(hook, event, hwnd, obj, child, thread, ms):
            try:
                if not self._app_overlay or not hwnd:
                    return
                title = price_hotkey.window_title(hwnd)
                _debug_log("app over game: foreground -> %r" % title)
                if (title == price_hotkey.GAME_TITLE and time.time() - self._app_overlay_at > 0.5
                        and self._prefs().get("closeOnGameClick", True) is not False):
                    threading.Thread(target=self._set_app_overlay, args=(False, False), daemon=True).start()
            except Exception as e:
                _debug_log("foreground hook: %s" % e)

        self._fg_proc = proc_t(on_event)  # keep a reference: Windows calls it for as long as we run
        u.SetWinEventHook.restype = wintypes.HANDLE
        hook = u.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, None, self._fg_proc, 0, 0,
                                 WINEVENT_OUTOFCONTEXT)
        if not hook:
            _debug_log("foreground hook unavailable")
            return
        msg = wintypes.MSG()
        while not self._quitting and u.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
            u.TranslateMessage(ctypes.byref(msg))
            u.DispatchMessageW(ctypes.byref(msg))
        u.UnhookWinEvent(hook)

    def _follow_one(self, u, name, hwnd, game, want, lbutton, now):
        st = self._ov[name]
        # check the real window state each tick (cheap, and robust to anything else
        # showing or hiding the window)
        vis = bool(u.IsWindowVisible(hwnd))
        if st["replace"]:  # Setup → Reset position
            st["replace"], st["placed"] = False, None
        if not want:
            if vis:
                u.ShowWindow(hwnd, 0)  # SW_HIDE
            st["placed"], st["dragging"] = None, False  # placed again on the next show
            return
        g = trade_helper.game_client_rect(game)
        if not vis or st["placed"] is None or (g and g != st.get("game") and not st["dragging"]):
            # first show, or the game window moved / resized / went to another screen: the
            # overlay goes with it, to the same spot relative to the game
            st["placed"], st["placed_at"], st["game"] = self._place_overlay(name, game, hwnd), now, g
            if not vis:
                u.ShowWindow(hwnd, 4)  # SW_SHOWNOACTIVATE
            return
        r = price_hotkey.window_rect(hwnd)
        if lbutton:
            # a drag is the mouse held down on this overlay; anything else that moves it isn't
            if not st["dragging"] and r:
                from ctypes import wintypes, byref
                pt = wintypes.POINT()
                if u.GetCursorPos(byref(pt)) and r[0] <= pt.x < r[2] and r[1] <= pt.y < r[3]:
                    st["dragging"] = True
            return
        if not r or (r[0], r[1]) == st["placed"]:
            st["dragging"] = False
            return
        if not st["dragging"]:
            if now - st["placed_at"] < 2:  # moved by Windows/pywebview right after showing
                st["placed"] = self._place_overlay(name, game, hwnd)
            else:
                st["placed"] = (r[0], r[1])
            return
        if g:  # dropped: remember the spot relative to the game window
            self.storage_set(OVERLAYS[name]["pos"], json.dumps({"dx": r[0] - g[0], "dy": r[1] - g[1],
                                                                 "bottom": r[3] - g[1]}))
        st["placed"], st["dragging"] = (r[0], r[1]), False

    def _overlay_saved(self, name):
        try:
            return json.loads(self._storage.get(OVERLAYS[name]["pos"]) or "{}")
        except Exception:
            return {}

    def _place_overlay(self, name, game, hwnd):
        g = trade_helper.game_client_rect(game)
        r = price_hotkey.window_rect(hwnd)
        if not g or not r:
            return None
        w, h = r[2] - r[0], r[3] - r[1]
        pos = self._overlay_saved(name)
        fx, fy = OVERLAYS[name]["default"]  # fraction of the game window (top-left of the overlay)
        dx = pos.get("dx", int(g[2] * fx - (w / 2 if name in CENTRED_OVERLAYS else 0)))
        if self._grows_up(name, g):
            bottom = pos.get("bottom", int(g[3] * fy))
            dy = bottom - h
        else:
            dy = pos.get("dy", int(g[3] * fy))
        x = max(g[0], min(g[0] + g[2] - w, g[0] + dx))  # keep it on the game window
        y = max(g[1], min(g[1] + g[3] - min(h, 40), g[1] + dy))
        price_hotkey.place_window(hwnd, x, y)
        return (x, y)

    def _grows_up(self, name, g):
        """An overlay whose bottom edge sits in the lower half of the game grows upwards."""
        pos = self._overlay_saved(name)
        if "bottom" in pos:
            return pos["bottom"] > g[3] / 2
        return OVERLAYS[name]["default"][1] > 0.5

    def overlay_fit(self, name, width, height):
        """Size an overlay window to its content (CSS px from the page)."""
        try:
            import ctypes
            u = ctypes.windll.user32
            if name not in OVERLAYS:
                return {"ok": False}
            hwnd = price_hotkey.find_window(OVERLAYS[name]["title"])
            r = price_hotkey.window_rect(hwnd)
            if not hwnd or not r:
                return {"ok": False}
            scale = u.GetDpiForWindow(hwnd) / 96.0 if hasattr(u, "GetDpiForWindow") else 1.0
            w = int(max(24, min(2400, float(width))) * scale)
            h = int(max(24, min(1200, float(height))) * scale)
            game = self._find_poe_window()
            g = trade_helper.game_client_rect(game) if game else None
            if g and self._grows_up(name, g):  # keep the bottom edge where it is
                u.SetWindowPos(hwnd, 0, r[0], r[3] - h, w, h, 0x0004 | 0x0010)  # NOZORDER | NOACTIVATE
                if self._ov[name]["placed"]:
                    self._ov[name]["placed"] = (r[0], r[3] - h)
            else:
                u.SetWindowPos(hwnd, 0, 0, 0, w, h, 0x0002 | 0x0004 | 0x0010)  # + NOMOVE
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def overlay_status(self):
        """What the overlay icon shows: hotkeys and log reader state."""
        st = {"ok": True, "logWatching": bool(self._tail and self._tail.running), "hotkeys": {}}
        for name, w in self._hotkeys.items():
            try:
                s = w.status()
                st["hotkeys"][name] = s.get("label") if s.get("hotkey") not in price_hotkey.OFF else None
            except Exception:
                pass
        st["hotkey"] = st["hotkeys"].get("price")
        return st

    def overlay_visible(self, name, on, count=None):
        """An overlay page says whether it has anything to show; the cards also report how
        many trades are open, for the icon's badge."""
        if name in self._ov:
            self._ov[name]["content"] = bool(on)
        if name == "cards" and count is not None:
            self._eval_in(self._overlay_windows.get("icon"), "window.__ovCount && window.__ovCount(%d, %s)"
                          % (int(count), "true" if on else "false"))
        return {"ok": True}

    def overlay_shape(self, name, shapes):
        """Clip an overlay window to what its page draws: [[x, y, w, h, radius], ...] in CSS
        px. Outside them the window is gone (see-through, clicks reach the game); WebView2
        can't be made transparent, so the window is cut to shape instead."""
        try:
            if name not in OVERLAYS or sys.platform != "win32":
                return {"ok": False}
            import ctypes
            u, gdi = ctypes.windll.user32, ctypes.windll.gdi32
            hwnd = price_hotkey.find_window(OVERLAYS[name]["title"])
            if not hwnd:
                return {"ok": False}
            scale = u.GetDpiForWindow(hwnd) / 96.0 if hasattr(u, "GetDpiForWindow") else 1.0
            gdi.CreateRectRgn.restype = gdi.CreateRoundRectRgn.restype = ctypes.c_void_p
            gdi.CombineRgn.argtypes = [ctypes.c_void_p] * 3 + [ctypes.c_int]
            gdi.DeleteObject.argtypes = [ctypes.c_void_p]
            u.SetWindowRgn.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_bool]
            rgn = gdi.CreateRectRgn(0, 0, 0, 0)
            for s in (shapes or [])[:60]:
                x, y, w, h = (int(round(float(v) * scale)) for v in s[:4])
                rad = int(round(float(s[4]) * scale)) if len(s) > 4 else 0
                part = gdi.CreateRoundRectRgn(x, y, x + w + 1, y + h + 1, 2 * rad + 1, 2 * rad + 1)
                gdi.CombineRgn(rgn, rgn, part, 2)  # RGN_OR
                gdi.DeleteObject(part)
            u.SetWindowRgn(hwnd, rgn, True)  # the system owns rgn from here
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def overlay_drag(self, name, phase, dx, dy):
        """The overlay's ⠿ grip: start / move by (dx, dy) CSS px from where the drag began /
        end (saves the spot relative to the game)."""
        try:
            if name not in OVERLAYS or sys.platform != "win32":
                return {"ok": False}
            import ctypes
            u = ctypes.windll.user32
            st = self._ov[name]
            hwnd = price_hotkey.find_window(OVERLAYS[name]["title"])
            r = price_hotkey.window_rect(hwnd)
            if not hwnd or not r:
                return {"ok": False}
            if phase == "start" or "drag_from" not in st:
                st["drag_from"], st["dragging"] = (r[0], r[1]), True
                if phase == "start":
                    return {"ok": True}
            scale = u.GetDpiForWindow(hwnd) / 96.0 if hasattr(u, "GetDpiForWindow") else 1.0
            x = int(st["drag_from"][0] + float(dx) * scale)
            y = int(st["drag_from"][1] + float(dy) * scale)
            u.SetWindowPos(hwnd, 0, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010)  # NOSIZE | NOZORDER | NOACTIVATE
            st["placed"] = (x, y)
            if phase == "end":
                st.pop("drag_from", None)
                st["dragging"] = False
                game = self._find_poe_window()
                g = trade_helper.game_client_rect(game) if game else None
                if g:
                    h = r[3] - r[1]
                    self.storage_set(OVERLAYS[name]["pos"], json.dumps({"dx": x - g[0], "dy": y - g[1],
                                                                         "bottom": y + h - g[1]}))
                    st["game"] = g
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def overlay_toggle_cards(self):
        """Icon click (or the trade cards hotkey): show / hide the trade cards."""
        self._eval_in(self._overlay_windows.get("cards"), "window.__ovToggle && window.__ovToggle()")
        return {"ok": True}

    def overlay_toggle_sheet(self):
        """The cheat sheet hotkey (or "Show in game" in the Cheat sheets view): show / hide it."""
        self._eval_in(self._overlay_windows.get("sheet"), "window.__sheetToggle && window.__sheetToggle()")
        return {"ok": True}

    def overlay_sheet_open(self, sheet_id):
        """The hint's Open (or a sheet picked in the app): show that sheet (an act number or a
        mechanic id) in the cheat sheet overlay."""
        sid = str(sheet_id or "")[:40]
        if not re.fullmatch(r"[\w-]+", sid):
            return {"ok": False, "error": "bad sheet id"}
        self._eval_in(self._overlay_windows.get("sheet"), "window.__sheetOpen && window.__sheetOpen(%s)" % json.dumps(sid))
        return {"ok": True}

    def overlay_reset_pos(self, name=None):
        """Setup → Reset position: back to the default spot on the next show."""
        for n in ([name] if name in OVERLAYS else OVERLAYS):
            self._storage.pop(OVERLAYS[n]["pos"], None)
            self.storage_set(OVERLAYS[n]["pos"], "{}")
            self._ov[n]["replace"] = True
        return {"ok": True}

    def trade_prefs_changed(self):
        """Settings changed in the Trade helper window: the overlays re-read them."""
        for win in self._overlay_windows.values():
            self._eval_in(win, "window.__tradePrefsChanged && window.__tradePrefsChanged();"
                               "window.__sheetPrefsChanged && window.__sheetPrefsChanged()")
        return {"ok": True}

    def open_main(self, settings=False):
        """Overlay ⌂ / ⚙ buttons: the app over the game (Esc goes back), or just forward."""
        try:
            if self._find_poe_window() and not self._app_overlay:
                import ctypes
                main = self._main_hwnd()
                self._main_was_hidden = not (main and ctypes.windll.user32.IsWindowVisible(main))
                self._set_app_overlay(True)
                if settings:
                    self._eval_in(self._main, "window.openSettings && openSettings()")
            else:
                self._show_main(settings=settings)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _show_trades(self, activate=True):
        """The Trade helper is a view of the main window: over the game when the game is up."""
        if not self._main:
            return False
        if self._find_poe_window() and not self._app_overlay:
            import ctypes
            main = self._main_hwnd()
            self._main_was_hidden = not (main and ctypes.windll.user32.IsWindowVisible(main))
            self._set_app_overlay(True)
        elif not self._app_overlay:
            self._show_main()
        self._eval_in(self._main, "window.__openTradeHelper && window.__openTradeHelper()")
        return True

    def _trade_status(self, path=None, error=None):
        st = {"ok": True, "watching": bool(self._tail and self._tail.running), "logPath": path,
              "logName": os.path.basename(path) if path else None, "error": error}
        try:
            vk = trade_helper.read_chat_key()
            st["chatKey"] = vk
            st["chatKeyName"] = CHAT_KEY_NAMES.get(vk, "key code %d" % vk)
        except Exception:
            pass
        game = self._find_poe_window() if sys.platform == "win32" else None
        st["gameRunning"] = bool(game)
        st["elevationMismatch"] = bool(game and trade_helper.elevation_mismatch(game))
        return st

    def trade_enable(self, on, path=None):
        """Start (on) or stop reading Client.txt. path: the user's chosen file, else found
        from the running game / usual install folders."""
        try:
            with self._trade_lock:
                if self._tail:
                    self._tail.stop()
                    self._tail = None
                if not on:
                    return self._trade_status()
                if not (path and os.path.isfile(path)):
                    game = self._find_poe_window() if sys.platform == "win32" else None
                    path = trade_helper.find_client_log(game)
                if not path:
                    return self._trade_status(error="Client.txt not found yet. Start Path of Exile, or choose the "
                                                    "file in Setup (Path of Exile folder → logs).")

                def on_error(msg):
                    _debug_log("trade log: %s" % msg)

                self._tail = trade_helper.LogTail(path, self._on_trade_event, on_error=on_error)
                self._tail.start()
                self._tail_path = path
                return self._trade_status(path)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trade_status(self):
        """Current reader state, without restarting it (Trade helper window)."""
        try:
            running = bool(self._tail and self._tail.running)
            return self._trade_status(getattr(self, "_tail_path", None) if running else None)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trade_send(self, action, name, text=None):
        """One chat command for one button press (invite, trade, kick, whisper, ...)."""
        try:
            cmd = trade_helper.command_for(action, name, text)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        try:
            if not self._sender:
                self._sender = trade_helper.ChatSender(find_game=self._find_poe_window)
            return self._sender.send(cmd)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def game_search_paste(self, text):
        """Search text builder: one press fills the game's open stash / vendor search box."""
        try:
            if not self._sender:
                self._sender = trade_helper.ChatSender(find_game=self._find_poe_window)
            return self._sender.paste_search(str(text or ""))
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trade_highlight(self, left, top, tab=""):
        """Outline a stash cell over the game for a few seconds (display only)."""
        try:
            game = self._find_poe_window()
            rect = trade_helper.game_client_rect(game) if game else None
            if not rect:
                return {"ok": False, "error": "Path of Exile isn't running"}
            if not self._highlight:
                self._highlight = trade_helper.StashHighlight()
            left, top = int(left), int(top)
            ok = self._highlight.show(trade_helper.stash_cell_rect(rect, left, top))  # amber
            # the whisper can't say whether it's a quad tab: up to 12,12 outline the quad-tab
            # cell too, in blue (beyond 12 it can only be a quad tab, outlined above)
            if left <= 12 and top <= 12:
                if not getattr(self, "_highlight_quad", None):
                    self._highlight_quad = trade_helper.StashHighlight()
                self._highlight_quad.show(trade_helper.stash_cell_rect(rect, left, top, quad=True), color=0xFFA040)
            return {"ok": bool(ok), "both": left <= 12 and top <= 12}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trades_show(self):
        try:
            return {"ok": self._show_trades(activate=True)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trades_hide(self):
        try:
            if self._trades:
                self._trades.hide()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def trade_pick_log(self):
        try:
            win = self._main or webview.windows[0]
            res = win.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False,
                                         file_types=("Path of Exile log (*.txt)", "All files (*.*)"))
            path = res[0] if res else None
            return {"ok": True, "path": path}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    SOUND_KINDS = ("new", "joined")
    SOUND_TYPES = (".mp3", ".wav", ".ogg", ".m4a")
    SOUND_MAX = 3 * 1024 * 1024

    def pick_sound(self, kind):
        """Trade helper → Setup → Sound → your own: pick an audio file for a new trade or for
        the buyer arriving. It's copied into data/sounds/ so the overlay page can play it."""
        try:
            if kind not in self.SOUND_KINDS:
                return {"ok": False, "error": "unknown sound"}
            win = self._main or webview.windows[0]
            res = win.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False,
                                         file_types=("Sounds (*.mp3;*.wav;*.ogg;*.m4a)",))
            src = res[0] if res else None
            if not src:
                return {"ok": True, "file": None}
            ext = os.path.splitext(src)[1].lower()
            if ext not in self.SOUND_TYPES:
                return {"ok": False, "error": "use an mp3, wav, ogg or m4a file"}
            if os.path.getsize(src) > self.SOUND_MAX:
                return {"ok": False, "error": "that file is over 3 MB: pick a short sound"}
            folder = os.path.join(DATA_DIR, "sounds")
            os.makedirs(folder, exist_ok=True)
            for old in os.listdir(folder):  # one file per kind
                if old.startswith(kind + "."):
                    os.remove(os.path.join(folder, old))
            shutil.copyfile(src, os.path.join(folder, kind + ext))
            # relative to index.html (data/ sits next to it); ?v= so a replaced file isn't cached
            return {"ok": True, "file": "data/sounds/%s%s?v=%d" % (kind, ext, int(time.time())),
                    "name": os.path.basename(src)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    SHEET_IMAGE_TYPES = (".png", ".jpg", ".jpeg", ".gif", ".webp")
    SHEET_IMAGE_MAX = 8 << 20

    def pick_sheet_image(self):
        """Cheat sheets → your sheet → Add image: copied into data/cheatsheets/ so the overlay
        page can show it (relative to index.html)."""
        try:
            win = self._main or webview.windows[0]
            res = win.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=False,
                                         file_types=("Images (*.png;*.jpg;*.jpeg;*.gif;*.webp)",))
            src = res[0] if res else None
            if not src:
                return {"ok": True, "file": None}
            ext = os.path.splitext(src)[1].lower()
            if ext not in self.SHEET_IMAGE_TYPES:
                return {"ok": False, "error": "use a png, jpg, gif or webp image"}
            if os.path.getsize(src) > self.SHEET_IMAGE_MAX:
                return {"ok": False, "error": "that image is over 8 MB"}
            folder = os.path.join(DATA_DIR, "cheatsheets")
            os.makedirs(folder, exist_ok=True)
            name = "%d-%s%s" % (int(time.time() * 1000), uuid.uuid4().hex[:6], ext)
            shutil.copyfile(src, os.path.join(folder, name))
            return {"ok": True, "file": "data/cheatsheets/" + name, "name": os.path.basename(src)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def delete_sheet_image(self, file):
        """Remove an image this app copied for a cheat sheet (only inside data/cheatsheets/)."""
        try:
            name = os.path.basename(str(file or "").split("?")[0])
            if not re.fullmatch(r"[\w.\-]+", name) or os.path.splitext(name)[1].lower() not in self.SHEET_IMAGE_TYPES:
                return {"ok": False, "error": "not a cheat sheet image"}
            path = os.path.join(DATA_DIR, "cheatsheets", name)
            if os.path.isfile(path):
                os.remove(path)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def save_text_file(self, name, text):
        """Save dialog for an export (CSV); UTF-8 with BOM so Excel reads it right."""
        try:
            win = self._main or webview.windows[0]
            safe = re.sub(r"[^\w.\- ]", "_", str(name or "export.txt"))
            res = win.create_file_dialog(webview.SAVE_DIALOG, save_filename=safe)
            path = res[0] if isinstance(res, (list, tuple)) else res
            if not path:
                return {"ok": False, "error": None}
            with open(path, "w", encoding="utf-8-sig", newline="") as f:
                f.write(str(text))
            return {"ok": True, "path": path}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def set_price_hotkey(self, spec):
        """Change the price-check hotkey at runtime: ctrl+d | ctrl+shift+d | alt+d | off."""
        try:
            r = self.set_hotkey("price", spec)
            return self.hotkey_status() if r.get("ok") else r
        except ValueError as e:
            return {"ok": False, "error": str(e)}

    def hotkey_status(self):
        if self._hotkey:
            st = self._hotkey.status()
        else:
            st = {"hotkey": self._hotkey_spec, "label": price_hotkey.hotkey_label(self._hotkey_spec),
                  "running": False, "active": False,
                  "error": None if sys.platform == "win32" else "Windows only"}
        st["ok"] = True
        return st

    # -- desktop notifications (live-search hits while the app is in the background) --
    # Windows toast via PowerShell's built-in WinRT bindings — no extra dependency.
    # Text travels in environment variables and is XML-escaped inside the script,
    # so listing text can never become script or markup.
    NOTIFY_MIN_GAP = 4.0
    _TOAST_PS = (
        "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime];"
        "[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime];"
        "$t=[Security.SecurityElement]::Escape($env:PTF_TITLE);$b=[Security.SecurityElement]::Escape($env:PTF_BODY);"
        "$x=New-Object Windows.Data.Xml.Dom.XmlDocument;"
        "$x.LoadXml(\"<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual></toast>\");"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
        "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')"
        ".Show([Windows.UI.Notifications.ToastNotification]::new($x))"
    )

    def notify(self, title, body):
        try:
            now = time.time()
            if now - getattr(self, "_last_notify", 0.0) < self.NOTIFY_MIN_GAP:
                return {"ok": False, "error": "throttled"}
            self._last_notify = now
            env = dict(os.environ, PTF_TITLE=str(title)[:120], PTF_BODY=str(body)[:240])
            subprocess.Popen(["powershell", "-NoProfile", "-NonInteractive", "-Command", self._TOAST_PS],
                             env=env, creationflags=0x08000000,  # CREATE_NO_WINDOW
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- rate-limit visibility -------------------------------------------------------
    # -- official login (OAuth, see oauth.py) + stash value -------------------------------
    def oauth_status(self):
        try:
            return dict(ok=True, **self._oauth.status())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def oauth_login(self):
        try:
            return dict(ok=True, **self._oauth.login())
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def oauth_logout(self):
        self._oauth.logout()
        return {"ok": True}

    def _oauth_state_text(self):
        oa = getattr(self, "_oauth", None)
        st = oa.status() if oa else {"enabled": False}
        return "not available yet" if not st["enabled"] else "signed in" if st["signedIn"] else "signed out"

    def _api_get(self, path):
        """GET on api.pathofexile.com with the official token and the OAuth User-Agent the
        docs require; same rate-limit handling as every other call."""
        token = self._oauth.access_token()
        if not token:
            raise RuntimeError("not signed in")
        try:
            return self._http(oauth.API_BASE + path, extra_headers={
                "Authorization": "Bearer " + token, "User-Agent": self._oauth.user_agent})
        except RuntimeError as e:
            if str(e).startswith("HTTP 401"):
                self._oauth.token_rejected()
                raise RuntimeError("your official login expired — sign in again")
            raise

    def stash_value(self, league):
        """Value every stash tab in a league with the official API (scope account:stashes):
        exchange items (currency, fragments, scarabs, essences, cards…) at the currency
        feed's chaos prices; other items are counted, not guessed. One click = one run."""
        try:
            q = urllib.parse.quote(league, safe="")
            tabs = self._api_get("/stash/%s" % q).get("stashes") or []
            by_name, ids = {}, set()
            for code, m in self._currency_map.items():
                by_name.setdefault(m["name"].lower(), m["id"])
                ids.add(m["id"])
            rates, hour = self._feed.rates(league, sorted(ids))
            out_tabs, all_items = [], []
            for tab in tabs:
                if (tab.get("metadata") or {}).get("folder") or tab.get("children"):
                    continue  # folders and container tabs: their sub-tabs are listed separately
                path = "/stash/%s/%s" % (q, tab["parent"] + "/" + tab["id"] if tab.get("parent") else tab["id"])
                stash = self._api_get(path).get("stash") or {}
                if tab.get("parent"):  # a sub-tab comes back wrapped in its parent
                    stash = next((c for c in stash.get("children") or [] if c.get("id") == tab["id"]), stash)
                items = stash.get("items") or []
                total, lines, unvalued = oauth.value_items(items, by_name, rates)
                all_items.extend(items)
                out_tabs.append({"name": tab.get("name", ""), "type": tab.get("type", ""), "total": round(total, 1),
                                 "items": len(items), "unvalued": unvalued})
            total, lines, unvalued = oauth.value_items(all_items, by_name, rates)
            return {"ok": True, "hour": hour, "total": round(total, 1), "divine": rates.get(
                        self._currency_map.get("divine", {}).get("id")),
                    "tabs": sorted(out_tabs, key=lambda t: -t["total"]), "top": lines[:40], "unvalued": unvalued}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def rate_status(self):
        hold = max(0.0, self._blocked_until - time.time())
        return {"ok": True, "cooldownSeconds": int(hold)}

    # -- bug-report diagnostics ----------------------------------------------------------
    @staticmethod
    def _tail(path, n):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                return [l.rstrip("\n") for l in f.readlines()[-n:]]
        except Exception:
            return []

    def _redact(self, text):
        """Never hand out the session cookie, OAuth tokens, other 32-hex tokens or the Windows user name."""
        if self._poesessid:
            text = text.replace(self._poesessid, "<POESESSID>")
        oa = getattr(self, "_oauth", None)
        for secret in (oa.secrets() if oa else []):
            text = text.replace(secret, "<token>")
        text = re.sub(r"\b[0-9a-fA-F]{32}\b", "<redacted>", text)
        return re.sub(r"(?i)([a-z]:\\users\\)[^\\/\s]+", r"\1<user>", text)

    @staticmethod
    def _display_lines():
        """Each screen with its real scaling, for bug reports. The app is "system DPI aware"
        (pywebview), so on a screen scaled differently from the main one Windows stretches the
        overlays: if a report says they're offset or blurry, this shows whether that's the
        setup. The real per-screen DPI needs a per-monitor-aware thread, so this thread is
        switched for the read and straight back; the app's own awareness doesn't change."""
        if sys.platform != "win32":
            return []
        import ctypes
        from ctypes import wintypes
        u, sh = ctypes.windll.user32, ctypes.windll.shcore
        u.SetThreadDpiAwarenessContext.restype = ctypes.c_void_p
        u.SetThreadDpiAwarenessContext.argtypes = [ctypes.c_void_p]
        old = u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2

        class MONITORINFOEXW(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                        ("dwFlags", wintypes.DWORD), ("szDevice", ctypes.c_wchar * 32)]
        screens = []
        proc = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

        def each(hmon, hdc, rect, lp):
            mi = MONITORINFOEXW()
            mi.cbSize = ctypes.sizeof(MONITORINFOEXW)
            dx, dy = wintypes.UINT(), wintypes.UINT()
            if u.GetMonitorInfoW(hmon, ctypes.byref(mi)) and sh.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy)) == 0:
                r = mi.rcMonitor
                screens.append((mi.szDevice.replace("\\\\.\\", ""), r.right - r.left, r.bottom - r.top, r.left, r.top,
                                round(dx.value * 100 / 96), bool(mi.dwFlags & 1)))
            return 1
        try:
            u.EnumDisplayMonitors(None, None, proc(each), 0)
        finally:
            if old:
                u.SetThreadDpiAwarenessContext(ctypes.c_void_p(old))
        lines = ["Display %s: %dx%d at %d,%d, %d%%%s" % (s[0], s[1], s[2], s[3], s[4], s[5], " (main)" if s[6] else "")
                 for s in screens]
        if len({s[5] for s in screens}) > 1:
            lines.append("Mixed scaling: yes (overlays on a screen scaled differently from the main one may be "
                         "stretched or offset)")
        return lines

    def diagnostics(self):
        """Plain-text app/environment summary + log tails for bug reports (Settings →
        Copy diagnostics). Redacted: no cookie, tokens or user name."""
        try:
            import platform
            try:
                from importlib.metadata import version as pkg_version
                pywebview_v = pkg_version("pywebview")
            except Exception:
                pywebview_v = "?"
            lines = ["PoB Trade Finder v%s (%s)" % (VERSION, "exe" if getattr(sys, "frozen", False) else "source"),
                     "OS: %s" % platform.platform(),
                     "Python %s · pywebview %s" % (platform.python_version(), pywebview_v),
                     "App folder writable: %s" % os.access(APP_DIR, os.W_OK),
                     "POESESSID saved: %s" % ("yes" if self._poesessid else "no"),
                     "Official login: %s" % self._oauth_state_text(),
                     "Rate-limit cooldown: %ds" % max(0, int(self._blocked_until - time.time()))]
            for name in ("stats.json", "leagues.json", "currencymap.json"):
                p = os.path.join(DATA_DIR, name)
                lines.append("data/%s: %s" % (name, time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p)))
                                              if os.path.exists(p) else "missing"))
            try:
                hk = self.hotkey_status()
                lines.append("Hotkey: %s%s" % (hk.get("hotkey"), " — " + hk["error"] if hk.get("error") else ""))
            except Exception as e:
                lines.append("Hotkey: unavailable (%s)" % e)
            try:
                lines += self._display_lines()
            except Exception as e:
                lines.append("Displays: unavailable (%s)" % e)
            for title, path, n in (("debug.log", os.path.join(DATA_DIR, "debug.log"), 40),
                                   ("_update.log", os.path.join(APP_DIR, "_update.log"), 15)):
                tail = self._tail(path, n)
                if tail:
                    lines += ["", "--- %s (last %d lines) ---" % (title, len(tail))] + tail
            return {"ok": True, "text": self._redact("\n".join(lines))}
        except Exception as e:
            return {"ok": False, "error": str(e)}

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

    def session_validate(self):
        """Check the saved POESESSID against GGG and, when valid, return the
        account's own characters (no account name needed) plus the account
        name recovered from the /my-account redirect."""
        if not self._poesessid:
            return {"ok": True, "valid": False, "error": "no POESESSID set"}
        headers = {"User-Agent": UA, "Cookie": "POESESSID=" + self._poesessid}
        try:
            req = urllib.request.Request(
                "https://www.pathofexile.com/character-window/get-characters",
                headers=headers)
            with urllib.request.urlopen(req, timeout=20) as r:
                body = r.read().decode("utf-8", "replace")
            if body.lstrip().startswith("<"):
                return {"ok": True, "valid": False, "error": "session rejected (login page returned)"}
            chars = json.loads(body)
            if not isinstance(chars, list):
                return {"ok": True, "valid": False, "error": "unexpected response"}
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                return {"ok": True, "valid": False, "error": "session invalid or expired"}
            return {"ok": False, "error": "HTTP %s" % e.code}
        except Exception as e:
            return {"ok": False, "error": str(e)}

        account = ""
        try:
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            opener = urllib.request.build_opener(NoRedirect)
            req2 = urllib.request.Request("https://www.pathofexile.com/my-account",
                                          headers=headers)
            try:
                opener.open(req2, timeout=20)
            except urllib.error.HTTPError as e2:
                loc = e2.headers.get("Location", "")
                m = re.search(r"/account/view-profile/([^/?#]+)", loc)
                if m:
                    account = urllib.parse.unquote(m.group(1))
                    # profile URLs write the discriminator as -1234
                    account = re.sub(r"-(\d{4})$", r"#\1", account)
        except Exception:
            pass

        return {"ok": True, "valid": True, "account": account,
                "characters": [
                    {"name": c.get("name"), "league": c.get("league"),
                     "level": c.get("level"), "class": c.get("class")}
                    for c in chars if isinstance(c, dict)]}

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
                    "page": rel.get("html_url") or None,  # "What's new" in the banner
                    "url": asset.get("browser_download_url") if asset else None}
        except Exception as e:
            return {"ok": False, "current": VERSION, "error": str(e)}

    @staticmethod
    def _update_script(staged, app_dir, exe_path, pid):
        """The swap script apply_update hands over to, run once this copy (pid) has exited.
        Windows tools by full path: a "find" (or "ping"…) from Git or another toolkit earlier
        on PATH answered differently, so "still running?" always said no."""
        sys32 = '"%SystemRoot%\\System32\\'
        tasklist, find, taskkill = sys32 + 'tasklist.exe"', sys32 + 'find.exe"', sys32 + 'taskkill.exe"'
        ping, robocopy = sys32 + 'PING.EXE"', sys32 + 'Robocopy.exe"'
        lines = [
            "@echo off",
            'cd /d "%~dp0"',
            'echo update started %date% %time% > "_update.log"',
            # wait until this copy has really exited (not a fixed delay: a slow close left
            # files locked and the swap half done), up to ~30 s, then end it. 'timeout'
            # needs a console stdin and dies when run windowless: ping is the reliable
            # console-free delay
            "set n=0",
            ":wait",
            tasklist + ' /FI "PID eq ' + str(pid) + '" /NH 2>nul | ' + find + ' "' + str(pid) + '" >nul || goto gone',
            "set /a n+=1",
            "if %n% geq 30 (",
            '  echo old copy still running after 30 s: ending it >> "_update.log"',
            "  " + taskkill + " /PID " + str(pid) + " /F >nul 2>&1",
            "  goto gone",
            ")",
            ping + " -n 2 127.0.0.1 >nul",
            "goto wait",
            ":gone",
            ping + " -n 2 127.0.0.1 >nul",
            # /R:60 /W:1: retry a (briefly locked) file every second instead of robocopy's
            # default 30 s waits
            robocopy + ' "' + staged + '" "' + app_dir + '" /E /MOVE /R:60 /W:1 /NFL /NDL /NJH /NJS >> "_update.log" 2>&1',
        ]
        if exe_path:
            # brief pause before relaunch: antivirus rescans the freshly written exe, and
            # launching into that scan can fail. --after-update: the new copy waits for this
            # one to finish closing instead of seeing it as "already running" (single_instance.py)
            lines += [ping + " -n 4 127.0.0.1 >nul", 'start "" "' + exe_path + '" --after-update']
        lines += ['echo update finished %date% %time% >> "_update.log"', 'del "%~f0"']
        return "\n".join(lines) + "\n"

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
            pid = os.getpid()
            with open(bat, "w", encoding="ascii") as f:
                f.write(self._update_script(staged, APP_DIR, exe_path, pid))
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
            # a real exit, the same as tray → Quit: not "close to tray", no tray icon left
            # behind (it made the app look still open), hotkeys and log reader released
            self._quitting = True
            _debug_log("update: exiting for the swap (pid %d)" % pid)
            for stop in (lambda: self._tray and self._tray.stop(), lambda: self._tail and self._tail.stop(),
                         self._stop_hotkey):
                try:
                    stop()
                except Exception as e:
                    _debug_log("update: cleanup: %s" % e)
            # overlay first, then the main window (whose closed event would close the
            # overlay again) — each exactly once
            for w in sorted(webview.windows, key=lambda w: w is not self._overlay):
                self._destroy_once(w)
            threading.Timer(1.0, lambda: os._exit(0)).start()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- loot filter tools (js/app/29-lootfilter.js): files + checkpoints only; the filter logic is js/filter.js
    # Files live in Documents\My Games\Path of Exile (filter_files.filter_dir()); checkpoints in
    # data/filter_checkpoints/. Nothing here sends input to the game or reloads its filter: the
    # user does that in game.
    @staticmethod
    def _filter_error(e):
        import filter_files
        out = {"ok": False, "error": str(e) or e.__class__.__name__}
        if isinstance(e, filter_files.FilterConflict):
            out["conflict"] = True
        return out

    def filter_list(self):
        import filter_files
        try:
            folder = filter_files.filter_dir()
            return {"ok": True, "dir": folder, "exists": os.path.isdir(folder),
                    "filters": filter_files.list_filters(folder)}
        except Exception as e:
            return self._filter_error(e)

    def filter_read(self, name):
        import filter_files
        try:
            r = filter_files.read_filter(name)
            r.update(ok=True, name=name)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_write(self, name, text, expect_mtime=None, bom=False, label=None):
        import filter_files
        try:
            r = filter_files.write_filter(name, text, expect_mtime=expect_mtime, bom=bool(bom),
                                          label=label, data_dir=DATA_DIR)
            _debug_log("filter: saved %s (checkpoint %s)" % (name, r.get("checkpoint")))
            r.update(ok=True, name=name)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_checkpoints(self, name):
        import filter_files
        try:
            return {"ok": True, "name": name, "checkpoints": filter_files.list_checkpoints(name, data_dir=DATA_DIR)}
        except Exception as e:
            return self._filter_error(e)

    def filter_restore(self, name, id):
        import filter_files
        try:
            r = filter_files.restore_checkpoint(name, id, data_dir=DATA_DIR)
            _debug_log("filter: restored %s to %s (current kept as %s)" % (name, id, r.get("checkpoint")))
            r.update(ok=True, name=name)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_checkpoint(self, name, label=None):
        import filter_files
        try:
            r = filter_files.checkpoint(name, label, data_dir=DATA_DIR)
            r.update(ok=True, name=name)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_open_folder(self):
        """Explorer on the game's filter folder (only that folder; no path from the page)."""
        import filter_files
        try:
            folder = filter_files.filter_dir()
            if not os.path.isdir(folder):
                return {"ok": False, "error": "the filter folder doesn't exist yet: %s" % folder}
            os.startfile(folder)
            return {"ok": True, "dir": folder}
        except Exception as e:
            return self._filter_error(e)

    # online filters (OnlineFilters\, written by the game): read only; edits go to a -local copy
    def filter_online_list(self):
        import filter_files
        try:
            return {"ok": True, "filters": filter_files.list_online(data_dir=DATA_DIR)}
        except Exception as e:
            return self._filter_error(e)

    def filter_online_read(self, id):
        import filter_files
        try:
            r = filter_files.read_online(id)
            r.update(ok=True, id=id)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_online_import(self, id, overwrite=False):
        import filter_files
        try:
            r = filter_files.import_online(id, overwrite=bool(overwrite), data_dir=DATA_DIR)
            _debug_log("filter: imported online filter %s as %s" % (id, r.get("local")))
            r.update(ok=True)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_online_status(self, name):
        import filter_files
        try:
            r = filter_files.online_status(name, data_dir=DATA_DIR)
            r.update(ok=True, name=name)
            return r
        except Exception as e:
            return self._filter_error(e)

    def filter_online_mark(self, name, id, version):
        """The local copy now holds this online version (after an update was replayed + saved)."""
        import filter_files
        try:
            b = filter_files.set_baseline(name, id, version, data_dir=DATA_DIR)
            return {"ok": True, "name": name, "baseline": b}
        except Exception as e:
            return self._filter_error(e)

    # game commands for the filter editor: each is one chat command for one button press
    # (Save sends /reloaditemfilter when Settings → In game says so)
    FILTER_NAME_RE = re.compile(r"^[^\r\n\x00-\x1f/\\]{1,120}$")

    def _chat(self, cmd):
        if not self._sender:
            self._sender = trade_helper.ChatSender(find_game=self._find_poe_window)
        return self._sender.send(cmd)

    def filter_reload(self):
        try:
            return self._chat("/reloaditemfilter")
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def filter_switch(self, name):
        """/itemfilter <name>: a local filter's file name without .filter, or an online filter's name."""
        name = str(name or "").strip()
        if name.lower().endswith(".filter"):
            name = name[:-7]
        if not self.FILTER_NAME_RE.fullmatch(name):
            return {"ok": False, "error": "not a filter name: %r" % name[:40]}
        try:
            return self._chat("/itemfilter " + name)
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # the filter editor's game-like extras, fetched once into data/filter_assets/ (not shipped):
    # the Fontin SmallCaps label font and the 16 built-in alert sounds for preview playback
    FILTER_ASSET_URL = "https://raw.githubusercontent.com/scalpelpoe/scalpel/main/src/renderer/src/assets/"
    FILTER_ASSETS = {"font": {"Fontin-SmallCaps.woff"},
                     "sound": {"AlertSound_%02d.ogg" % i for i in range(1, 17)}}
    SOUND_EXT = (".mp3", ".wav", ".ogg")

    def filter_asset(self, kind, name):
        try:
            if kind not in self.FILTER_ASSETS or name not in self.FILTER_ASSETS[kind]:
                return {"ok": False, "error": "unknown asset"}
            folder = os.path.join(DATA_DIR, "filter_assets")
            path = os.path.join(folder, name)
            if not os.path.isfile(path):
                os.makedirs(folder, exist_ok=True)
                url = self.FILTER_ASSET_URL + ("fonts/" if kind == "font" else "sounds/") + name
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read(2 * 1024 * 1024 + 1)
                if len(data) > 2 * 1024 * 1024:
                    return {"ok": False, "error": "asset too big"}
                tmp = path + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, path)
            return {"ok": True, "path": "data/filter_assets/" + name}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def _filter_sounds(self):
        import filter_files
        folder = filter_files.filter_dir()
        out = []
        for sub in ("", "sounds"):
            d = os.path.join(folder, sub) if sub else folder
            try:
                names = sorted(os.listdir(d), key=str.lower)
            except OSError:
                continue
            for n in names:
                if n.lower().endswith(self.SOUND_EXT) and os.path.isfile(os.path.join(d, n)):
                    out.append((sub + "/" + n) if sub else n)
        return out

    def filter_sound_list(self):
        """Custom alert sounds a filter can name: .mp3 / .wav / .ogg in the filter folder and sounds/."""
        try:
            return {"ok": True, "files": self._filter_sounds()}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def filter_sound_file(self, name):
        """One custom sound as a data URL for the preview button (only names filter_sound_list gives)."""
        import base64
        import filter_files
        try:
            if name not in self._filter_sounds():
                return {"ok": False, "error": "no such sound"}
            path = os.path.join(filter_files.filter_dir(), *name.split("/"))
            if os.path.getsize(path) > 4 * 1024 * 1024:
                return {"ok": False, "error": "sound file too big"}
            with open(path, "rb") as f:
                data = f.read()
            mime = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg"}[os.path.splitext(name)[1].lower()]
            return {"ok": True, "url": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    # -- open in system browser --------------------------------------------------
    OPEN_URL_PREFIXES = ("https://www.pathofexile.com/",
                         "https://vilsol.github.io/timeless-jewels/",  # timeless seed calculator
                         "https://www.poewiki.net/wiki/", "https://poedb.tw/us/",  # item reference pages
                         "https://poe.ninja/poe1/economy/")  # price history pages

    def open_url(self, url):
        if url.startswith(self.OPEN_URL_PREFIXES):
            webbrowser.open(url)
            return {"ok": True}
        # a guide's Read more source: only the exact pages the guide data lists
        if isinstance(url, str) and url.startswith(("https://", "http://")) and url in self._guide_urls():
            webbrowser.open(url)
            return {"ok": True}
        return {"ok": False, "error": "refusing to open that URL"}


def _unblock_app_files():
    """Drop Windows' "downloaded from the internet" mark (the Zone.Identifier stream) from
    the app's own files. A zip unzipped from a browser download passes the mark to every
    file, and .NET then refuses to load pythonnet's Python.Runtime.dll ("Failed to resolve
    Python.Runtime.Loader.Initialize"). Must run before webview.start() imports clr."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return 0
    n = 0
    for base, _dirs, files in os.walk(APP_DIR):
        if os.path.abspath(base).startswith(os.path.abspath(DATA_DIR)):
            continue
        for name in files:
            try:
                os.remove(os.path.join(base, name) + ":Zone.Identifier")
                n += 1
            except OSError:
                pass  # not marked (the usual case) or not NTFS
    if n:
        _debug_log("removed the download mark from %d app files" % n)
    return n


def main():
    index = os.path.join(APP_DIR, "index.html")
    if not os.path.exists(index):
        sys.exit("index.html not found next to gui.py")
    # one copy at a time: a second launch brings the running one forward instead (two
    # copies fight over the update swap, hotkeys, tray, overlays and storage.json).
    # --multi skips the check (development only).
    instance = single_instance.SingleInstance()
    if "--multi" not in sys.argv and not instance.acquire(wait=30 if "--after-update" in sys.argv else 0):
        _debug_log("PoB Trade Finder is already running: bringing that window forward")
        instance.ask_running_copy_to_show()
        return
    _unblock_app_files()
    api = Api()
    main_window = webview.create_window(
        "PoB Trade Finder",
        index,
        js_api=api,
        width=1280,  # sidebar + slot list + item card side by side (narrower windows stack)
        height=900,
        min_size=(760, 560),
        background_color="#0f0e0c",  # css/tokens.css --bg (dark)
    )
    # in-game price-check overlay: same page in overlay mode, same Api instance
    # (one rate limiter for both windows), created hidden and reused per press
    overlay = webview.create_window(
        OVERLAY_TITLE,
        index + "?overlay=1",
        js_api=api,
        width=OVERLAY_SIZE[0],
        height=OVERLAY_SIZE[1],
        min_size=(380, 300),
        hidden=True,
        on_top=True,
        background_color="#0f0e0c",
    )
    # the Trade helper (sales, buyers, setup) is a view of the main window: no extra window
    trades = None
    # in-game overlays (icon, trade cards): see-through, never take focus from the game,
    # each dragged and placed on its own
    overlays = {}
    for name, o in OVERLAYS.items():
        overlays[name] = webview.create_window(
            o["title"],
            index + o["query"],
            js_api=api,
            width=o["size"][0],
            height=o["size"][1],
            hidden=True,
            on_top=True,
            frameless=True,
            easy_drag=False,
            # not pywebview's transparent=True: on Windows it leaves the window's grey
            # background showing and Show()+Activate()s the window when its page loads
            # (stealing focus from the game). The window is clipped to its content instead
            # (overlay_shape), on a dark background for the edges.
            background_color="#0f0e0c",
            focus=False,
            shadow=False,
            resizable=False,
            min_size=(24, 24),
        )
    api._attach_windows(main_window, overlay)
    api._attach_trades(main_window, trades, overlays)
    api._start_hotkey()
    api._start_tray()
    # another launch while this copy runs (often hidden in the tray): show this one
    instance.listen_for_show(lambda: api._show_main(), lambda: api._quitting)
    try:
        webview.start()
    except BaseException as e:
        _debug_log("app crashed: %r" % e)
        raise
    finally:
        _debug_log("app exit")
        api._stop_hotkey()


if __name__ == "__main__":
    main()
