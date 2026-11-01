"""Official Path of Exile login (OAuth 2, public client) — built to GGG's developer docs,
switched off until GGG issues this app a client id (they currently aren't accepting new
applications: https://www.pathofexile.com/developer/docs).

Desktop apps must be *public* clients (docs, /developer/docs/authorization):
- Authorization Code + PKCE only (S256), local redirect URI http://127.0.0.1:8080/callback
- no client secret, no service:* scopes; access tokens last 10 h, refresh tokens 7 days
- authorization codes expire after 30 s — exchanged as soon as the callback arrives
- refresh rotates: the used refresh token dies, the new one keeps the old expiry
- every request carries "User-Agent: OAuth {clientId}/{version} (contact: …)"
Tokens live only in data/oauth.json on this PC and are never logged or shown.
"""
import base64
import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

AUTHORIZE_URL = "https://www.pathofexile.com/oauth/authorize"
TOKEN_URL = "https://www.pathofexile.com/oauth/token"
API_BASE = "https://api.pathofexile.com"
REDIRECT_HOST, REDIRECT_PORT, REDIRECT_PATH = "127.0.0.1", 8080, "/callback"
REDIRECT_URI = "http://%s:%d%s" % (REDIRECT_HOST, REDIRECT_PORT, REDIRECT_PATH)
SCOPES = ("account:profile", "account:stashes", "account:characters")
LOGIN_TIMEOUT = 300  # seconds to finish signing in on pathofexile.com


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def pkce_pair():
    """(code_verifier, code_challenge): 32 random bytes as base64url (RFC 7636 §4.1),
    challenge = base64url(SHA-256(verifier)) — the docs' recipe."""
    verifier = b64url(secrets.token_bytes(32))
    return verifier, challenge_for(verifier)


def challenge_for(verifier):
    return b64url(hashlib.sha256(verifier.encode("ascii")).digest())


def authorize_url(client_id, state, challenge, scopes=SCOPES):
    return AUTHORIZE_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "response_type": "code", "scope": " ".join(scopes), "state": state,
        "redirect_uri": REDIRECT_URI, "code_challenge": challenge, "code_challenge_method": "S256"})


class OAuthError(RuntimeError):
    pass


class OAuth:
    def __init__(self, client_id, version, contact, token_path, open_url=None, post=None, now=time.time):
        self.client_id = client_id or ""
        self.user_agent = "OAuth %s/%s (contact: %s)" % (self.client_id or "unregistered", version, contact)
        self.token_path = token_path
        self._open_url = open_url
        self._post = post or self._http_post  # injectable for tests
        self._now = now
        self._lock = threading.Lock()
        self._tok = self._load()

    # -- state ---------------------------------------------------------------------------
    @property
    def enabled(self):
        return bool(self.client_id)

    def _load(self):
        try:
            with open(self.token_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return None

    def _save(self, tok):
        self._tok = tok
        if tok is None:
            try:
                os.remove(self.token_path)
            except OSError:
                pass
            return
        tmp = self.token_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(tok, f)
        os.replace(tmp, self.token_path)

    def secrets(self):
        """Token strings to scrub from diagnostics."""
        t = self._tok or {}
        return [v for v in (t.get("access_token"), t.get("refresh_token")) if v]

    def status(self):
        t = self._tok or {}
        now = self._now()
        signed_in = bool(t.get("access_token")) and (
            t.get("expires_at", 0) > now or t.get("refresh_expires_at", 0) > now)
        return {"enabled": self.enabled, "signedIn": self.enabled and signed_in,
                "username": t.get("username") if signed_in else None,
                "scope": t.get("scope", "") if signed_in else "",
                "refreshUntil": t.get("refresh_expires_at") if signed_in else None}

    def logout(self):
        with self._lock:
            self._save(None)

    # -- token endpoint ------------------------------------------------------------------
    def _http_post(self, url, form):
        req = urllib.request.Request(url, data=urllib.parse.urlencode(form).encode("ascii"), headers={
            "User-Agent": self.user_agent, "Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8", "replace"))
                msg = body.get("error_description") or body.get("error") or str(e.code)
            except Exception:
                msg = "HTTP %d" % e.code
            raise OAuthError(msg)

    def _store_token_response(self, resp, refresh_expires_at=None):
        if not resp.get("access_token"):
            raise OAuthError(resp.get("error_description") or resp.get("error") or "no access token in the reply")
        now = self._now()
        tok = {"access_token": resp["access_token"],
               "expires_at": now + int(resp.get("expires_in") or 36000) - 60,
               "scope": resp.get("scope", ""), "username": resp.get("username"), "sub": resp.get("sub")}
        if resp.get("refresh_token"):
            tok["refresh_token"] = resp["refresh_token"]
            # rotation keeps the original expiry (7 days for public clients)
            tok["refresh_expires_at"] = refresh_expires_at or now + 7 * 86400 - 60
        self._save(tok)
        return tok

    def exchange_code(self, code, verifier, scopes=SCOPES):
        resp = self._post(TOKEN_URL, {"client_id": self.client_id, "grant_type": "authorization_code",
                                      "code": code, "redirect_uri": REDIRECT_URI, "scope": " ".join(scopes),
                                      "code_verifier": verifier})
        return self._store_token_response(resp)

    def access_token(self):
        """A valid access token, refreshing (with rotation) when it has expired; None when
        signed out or the refresh window has passed."""
        with self._lock:
            t = self._tok
            if not t or not self.enabled:
                return None
            now = self._now()
            if t.get("expires_at", 0) > now:
                return t["access_token"]
            if t.get("refresh_token") and t.get("refresh_expires_at", 0) > now:
                try:
                    resp = self._post(TOKEN_URL, {"client_id": self.client_id, "grant_type": "refresh_token",
                                                  "refresh_token": t["refresh_token"]})
                    return self._store_token_response(resp, t["refresh_expires_at"])["access_token"]
                except OAuthError:
                    pass
            self._save(None)  # expired for good: sign in again
            return None

    def token_rejected(self):
        """The API answered 401: the token was revoked or expired early."""
        with self._lock:
            self._save(None)

    # -- sign-in flow ----------------------------------------------------------------------
    def login(self, scopes=SCOPES):
        """Open pathofexile.com's sign-in page, catch the redirect on 127.0.0.1:8080 and
        exchange the code. Blocks until done (or LOGIN_TIMEOUT); returns status()."""
        if not self.enabled:
            raise OAuthError("Official login isn't available yet: GGG hasn't issued this app a client id")
        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(24)
        result = {}
        done = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 (http.server API)
                u = urllib.parse.urlsplit(self.path)
                if u.path != REDIRECT_PATH:
                    self.send_response(404)
                    self.end_headers()
                    return
                q = dict(urllib.parse.parse_qsl(u.query))
                result.update(q)
                ok = q.get("state") == state and "code" in q
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(("<!doctype html><title>PoB Trade Finder</title><body style='font:16px sans-serif;"
                                  "padding:40px'>" + ("Signed in. You can close this tab and go back to PoB Trade Finder."
                                  if ok else "Sign-in didn't complete. Go back to PoB Trade Finder and try again.") +
                                  "</body>").encode("utf-8"))
                done.set()

            def log_message(self, *a):  # keep the console quiet
                pass

        try:
            server = HTTPServer((REDIRECT_HOST, REDIRECT_PORT), Handler)
        except OSError:
            raise OAuthError("port %d is busy, so the sign-in can't come back to the app. Close whatever uses it "
                             "and try again" % REDIRECT_PORT)
        server.timeout = 1
        try:
            if self._open_url:
                self._open_url(authorize_url(self.client_id, state, challenge, scopes))
            deadline = time.time() + LOGIN_TIMEOUT
            while not done.is_set() and time.time() < deadline:
                server.handle_request()
        finally:
            server.server_close()
        if not done.is_set():
            raise OAuthError("sign-in timed out")
        if result.get("state") != state:
            raise OAuthError("sign-in reply didn't match this request (state mismatch)")
        if "error" in result:
            raise OAuthError(result.get("error_description") or result["error"])
        self.exchange_code(result["code"], verifier, scopes)  # codes live 30 s: exchange now
        return self.status()


# -- stash valuation (pure: testable without the API) -----------------------------------------
def value_items(items, by_name, rates):
    """Value stackable exchange items (currency, fragments, scarabs, essences, cards…) by
    name: by_name maps a lower-cased item name to a currency-exchange metadata id, rates
    maps that id to chaos each. Returns (total chaos, valued lines, count of items not
    valued) — gear, gems and maps aren't on the exchange and are counted, not guessed."""
    total, lines, unvalued = 0.0, {}, 0
    for it in items or []:
        name = (it.get("typeLine") or it.get("baseType") or "").strip()
        mid = by_name.get(name.lower())
        each = rates.get(mid) if mid else None
        if each is None:
            unvalued += 1
            continue
        qty = int(it.get("stackSize") or 1)
        line = lines.setdefault(name, {"name": name, "qty": 0, "each": each, "icon": it.get("icon", "")})
        line["qty"] += qty
        total += qty * each
    for line in lines.values():
        line["total"] = line["qty"] * line["each"]
    return total, sorted(lines.values(), key=lambda l: -l["total"]), unvalued
