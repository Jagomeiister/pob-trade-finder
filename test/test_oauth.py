"""Official login (oauth.py) + stash value — run: python test/test_oauth.py

GGG hasn't issued a client id yet, so everything here runs against stubs: PKCE against
the RFC 7636 test vector, the authorize URL GGG's docs specify, code exchange, refresh
rotation, a full sign-in round trip through the real 127.0.0.1:8080 callback server,
and stash valuation. No network."""
import os
import sys
import tempfile
import threading
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import oauth  # noqa: E402

failures = 0


def check(name, cond, detail=""):
    global failures
    failures += not cond
    print(("PASS " if cond else "FAIL ") + name + (" — " + str(detail) if detail else ""))


# PKCE: RFC 7636 appendix B
check("S256 challenge matches RFC 7636 appendix B",
      oauth.challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
v, c = oauth.pkce_pair()
check("verifier from 32 random bytes (43 base64url chars)", len(v) == 43 and "=" not in v, v)
check("pair is consistent", oauth.challenge_for(v) == c)

# authorize URL: every parameter GGG's docs list
u = urllib.parse.urlsplit(oauth.authorize_url("myapp", "st8", "chal"))
q = dict(urllib.parse.parse_qsl(u.query))
check("authorize endpoint", u.scheme + "://" + u.netloc + u.path == "https://www.pathofexile.com/oauth/authorize")
check("authorize parameters", q == {"client_id": "myapp", "response_type": "code",
                                    "scope": "account:profile account:stashes account:characters", "state": "st8",
                                    "redirect_uri": "http://127.0.0.1:8080/callback", "code_challenge": "chal",
                                    "code_challenge_method": "S256"}, q)

# token exchange + refresh rotation (stubbed token endpoint, controllable clock)
tmp = tempfile.mkdtemp()
clock = [1_000_000.0]
posts = []


def post(url, form):
    posts.append((url, dict(form)))
    if form["grant_type"] == "authorization_code":
        return {"access_token": "AT1", "expires_in": 36000, "token_type": "bearer", "scope": form["scope"],
                "username": "Exile#1234", "sub": "u1", "refresh_token": "RT1"}
    if form["grant_type"] == "refresh_token" and form["refresh_token"] == "RT1":
        return {"access_token": "AT2", "expires_in": 36000, "refresh_token": "RT2", "scope": "account:stashes"}
    return {"error": "invalid_grant"}


off = oauth.OAuth("", "2.0.5", "c", os.path.join(tmp, "off.json"), post=post, now=lambda: clock[0])
check("no client id = switched off", not off.enabled and off.status()["enabled"] is False)
try:
    off.login()
    check("login refused without a client id", False)
except oauth.OAuthError as e:
    check("login refused without a client id", "client id" in str(e), e)

oa = oauth.OAuth("myapp", "2.0.5", "https://example/issues", os.path.join(tmp, "oauth.json"),
                 post=post, now=lambda: clock[0])
check("OAuth User-Agent format from the docs", oa.user_agent == "OAuth myapp/2.0.5 (contact: https://example/issues)",
      oa.user_agent)
oa.exchange_code("CODE", "VER")
url, form = posts[-1]
check("code exchange goes to the token endpoint", url == "https://www.pathofexile.com/oauth/token")
check("code exchange body (public client: no secret)", form == {
    "client_id": "myapp", "grant_type": "authorization_code", "code": "CODE",
    "redirect_uri": "http://127.0.0.1:8080/callback", "scope": "account:profile account:stashes account:characters",
    "code_verifier": "VER"}, form)
st = oa.status()
check("signed in with username", st["signedIn"] and st["username"] == "Exile#1234", st)
check("token served while fresh", oa.access_token() == "AT1" and len(posts) == 1)
refresh_until = oa._tok["refresh_expires_at"]
clock[0] += 11 * 3600  # access token (10 h) expired, refresh (7 days) still good
check("expired token refreshes", oa.access_token() == "AT2")
check("refresh request body", posts[-1][1] == {"client_id": "myapp", "grant_type": "refresh_token",
                                               "refresh_token": "RT1"}, posts[-1][1])
check("rotation keeps the original refresh expiry", oa._tok["refresh_token"] == "RT2" and
      oa._tok["refresh_expires_at"] == refresh_until)
check("tokens persist on disk", oauth.OAuth("myapp", "x", "c", os.path.join(tmp, "oauth.json"),
                                             now=lambda: clock[0]).status()["signedIn"])
check("tokens listed for diagnostics scrubbing", set(oa.secrets()) == {"AT2", "RT2"})
clock[0] += 8 * 86400  # past the refresh window
check("past the refresh window: signed out", oa.access_token() is None and not oa.status()["signedIn"]
      and not os.path.exists(os.path.join(tmp, "oauth.json")))

# full sign-in round trip through the real local callback server
posts.clear()
clock[0] = 2_000_000.0


def fake_browser(url):
    """Stands in for the user signing in on pathofexile.com: GGG redirects to the callback."""
    st8 = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["state"]

    def hit():
        urllib.request.urlopen(oauth.REDIRECT_URI + "?" + urllib.parse.urlencode({"code": "C2", "state": st8}),
                               timeout=10).read()
    threading.Thread(target=hit, daemon=True).start()


oa2 = oauth.OAuth("myapp", "2.0.5", "c", os.path.join(tmp, "oauth2.json"), open_url=fake_browser, post=post,
                  now=lambda: clock[0])
try:
    s = oa2.login()
    check("sign-in round trip via 127.0.0.1:8080", s["signedIn"] and posts and posts[-1][1]["code"] == "C2", s)
    check("code exchanged with the verifier whose challenge was sent",
          posts[-1][1]["code_verifier"] and len(posts[-1][1]["code_verifier"]) == 43)
except oauth.OAuthError as e:
    if "busy" in str(e):
        print("SKIP sign-in round trip: port 8080 is in use on this machine")
    else:
        check("sign-in round trip via 127.0.0.1:8080", False, e)


def wrong_state(url):
    def hit():
        urllib.request.urlopen(oauth.REDIRECT_URI + "?code=C3&state=forged", timeout=10).read()
    threading.Thread(target=hit, daemon=True).start()


oa3 = oauth.OAuth("myapp", "2.0.5", "c", os.path.join(tmp, "oauth3.json"), open_url=wrong_state, post=post)
try:
    oa3.login()
    check("forged state rejected", False)
except oauth.OAuthError as e:
    check("forged state rejected", "state" in str(e) or "busy" in str(e), e)

# stash valuation: exchange items by name, everything else counted
by_name = {"chaos orb": "C", "divine orb": "D", "the doctor": "DOC"}
rates = {"C": 1.0, "D": 200.0, "DOC": 1500.0}
items = [{"typeLine": "Chaos Orb", "stackSize": 150}, {"typeLine": "Divine Orb", "stackSize": 3},
         {"typeLine": "Chaos Orb", "stackSize": 50}, {"typeLine": "The Doctor", "stackSize": 1},
         {"typeLine": "Vaal Regalia", "baseType": "Vaal Regalia"}, {"typeLine": "Mystery Scarab", "stackSize": 4}]
total, lines, unvalued = oauth.value_items(items, by_name, rates)
check("total = 200c + 3 div + The Doctor", total == 200 + 600 + 1500, total)
check("stacks of the same item merge", [(l["name"], l["qty"]) for l in lines] ==
      [("The Doctor", 1), ("Divine Orb", 3), ("Chaos Orb", 200)], lines)
check("gear and unknown items counted, not guessed", unvalued == 2, unvalued)

# bridge: Api.stash_value walks the official stash API (stubbed replies, docs' shapes)
import gui  # noqa: E402

api = gui.Api.__new__(gui.Api)
api._oauth = oauth.OAuth("myapp", "2.0.5", "c", os.path.join(tmp, "o4.json"), post=post)
api._oauth.exchange_code("CODE", "VER")
api._currency_map = {"chaos": {"id": "C", "name": "Chaos Orb"}, "divine": {"id": "D", "name": "Divine Orb"},
                     "doc": {"id": "DOC", "name": "The Doctor"}}


class Feed:
    def rates(self, league, ids):
        return {"C": 1.0, "D": 200.0, "DOC": 1500.0}, 1793448000


api._feed = Feed()
calls = []
STASH = {
    "/stash/My%20League": {"stashes": [
        {"id": "a1", "name": "Currency", "type": "CurrencyStash", "metadata": {}},
        {"id": "f1", "name": "Folder", "type": "Folder", "metadata": {"folder": True}},
        {"id": "m1", "name": "Maps", "type": "MapStash", "metadata": {}, "children": [{"id": "m1c"}]},
        {"id": "m1c", "parent": "m1", "name": "Tier 16", "type": "MapStash", "metadata": {}},
        {"id": "d1", "name": "Cards", "type": "DivinationCardStash", "metadata": {}}]},
    "/stash/My%20League/a1": {"stash": {"id": "a1", "items": [{"typeLine": "Chaos Orb", "stackSize": 500},
                                                             {"typeLine": "Divine Orb", "stackSize": 4}]}},
    "/stash/My%20League/m1/m1c": {"stash": {"id": "m1", "children": [
        {"id": "m1c", "items": [{"typeLine": "Strand Map"}, {"typeLine": "Strand Map"}]}]}},
    "/stash/My%20League/d1": {"stash": {"id": "d1", "items": [{"typeLine": "The Doctor", "stackSize": 2}]}},
}


def fake_http(url, payload=None, background=False, extra_headers=None):
    path = url[len(oauth.API_BASE):]
    calls.append((path, extra_headers))
    if path not in STASH:
        raise RuntimeError("HTTP 404: " + path)
    return STASH[path]


api._http = fake_http
r = api.stash_value("My League")
check("stash value ok", r.get("ok"), r)
check("folders and container tabs skipped, sub-tab fetched via its parent",
      [c[0] for c in calls] == ["/stash/My%20League", "/stash/My%20League/a1", "/stash/My%20League/m1/m1c",
                                "/stash/My%20League/d1"], [c[0] for c in calls])
check("official token + OAuth User-Agent on every call",
      all(h["Authorization"] == "Bearer AT1" and h["User-Agent"].startswith("OAuth myapp/") for _, h in calls))
check("total across tabs", r["total"] == 500 + 800 + 3000, r["total"])
check("per-tab totals, richest first", [(t["name"], t["total"]) for t in r["tabs"]] ==
      [("Cards", 3000), ("Currency", 1300), ("Tier 16", 0)], r["tabs"])
check("maps counted as not valued", r["unvalued"] == 2 and r["tabs"][2]["unvalued"] == 2, r)


def http_401(url, payload=None, background=False, extra_headers=None):
    raise RuntimeError("HTTP 401: unauthorized")


api._http = http_401
r = api.stash_value("My League")
check("401 signs out and says so", not r["ok"] and "sign in again" in r["error"] and not api._oauth.status()["signedIn"],
      r)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
