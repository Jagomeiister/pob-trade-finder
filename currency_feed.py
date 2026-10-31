"""GGG's public currency-exchange feed — hourly market digests, no auth.

    GET https://web.poecdn.com/api/currency-exchange/<unix hour>

Each hour is an immutable snapshot of every in-game Currency Exchange market
(all leagues, ~0.9 MB). A market is a pair of metadata ids with that hour's
traded volumes and ratio range; {A: a, B: b} reads "a of A traded for b of B".
The current hour 404s until GGG publishes it, so "latest" is usually now - 1h.

Snapshots are distilled to {league: {metadata id: [chaos value, chaos volume]}}
and cached on disk forever (they never change), so history costs one download
per hour-point, ever. Not the trade API: none of this touches its rate limits.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request

FEED = "https://web.poecdn.com/api/currency-exchange"
CHAOS = "Metadata/Items/Currency/CurrencyRerollRare"
DIVINE = "Metadata/Items/Currency/CurrencyModValues"
HOUR = 3600


def _ratio(m, num, den):
    """Mid of the hour's ratio range, as num per den (e.g. chaos per divine)."""
    vals = []
    for key in ("lowest_ratio", "highest_ratio"):
        r = m.get(key) or {}
        a, b = r.get(num) or 0, r.get(den) or 0
        if a > 0 and b > 0:
            vals.append(a / b)
    return sum(vals) / len(vals) if vals else None


def _price(m, num, den):
    """num-per-den price: volume-weighted when the hour saw trades, else ratio mid.
    Returns (price, volume of num traded)."""
    vol = m.get("volume_traded") or {}
    vn, vd = vol.get(num) or 0, vol.get(den) or 0
    if vn > 0 and vd > 0:
        return vn / vd, vn
    return _ratio(m, num, den), 0


def distill(raw):
    """Raw snapshot -> {league: {metadata id: [chaos value, chaos-equivalent volume]}}."""
    by_league = {}
    for m in raw.get("markets") or []:
        pair = m.get("market_pair") or []
        if len(pair) == 2 and m.get("league"):
            by_league.setdefault(m["league"], []).append(m)

    out = {}
    for league, markets in by_league.items():
        div_rate, div_vol = None, 0
        for m in markets:
            if set(m["market_pair"]) == {CHAOS, DIVINE}:
                div_rate, div_vol = _price(m, CHAOS, DIVINE)
        # volume-weighted across BOTH markets (vs chaos and vs divine): cheap
        # currencies trade in bulk against divines, so either market alone flips
        # between thin and thick hour to hour and the series jitters
        paid = {}    # id -> chaos-equivalent paid
        bought = {}  # id -> units traded
        fallback = {}  # id -> ratio-mid chaos value for hours with no trades
        for m in markets:
            a, b = m["market_pair"]
            if CHAOS in (a, b) and DIVINE not in (a, b):
                quote, other, to_chaos = CHAOS, (b if a == CHAOS else a), 1.0
            elif DIVINE in (a, b) and CHAOS not in (a, b) and div_rate:
                quote, other, to_chaos = DIVINE, (b if a == DIVINE else a), div_rate
            else:
                continue
            vol = m.get("volume_traded") or {}
            vq, vo = vol.get(quote) or 0, vol.get(other) or 0
            if vq > 0 and vo > 0:
                paid[other] = paid.get(other, 0) + vq * to_chaos
                bought[other] = bought.get(other, 0) + vo
            elif other not in fallback:
                mid = _ratio(m, quote, other)
                if mid:
                    fallback[other] = mid * to_chaos
        league_out = {}
        for item in set(paid) | set(fallback):
            if bought.get(item):
                league_out[item] = [round(paid[item] / bought[item], 4), round(paid[item])]
            else:
                league_out[item] = [round(fallback[item], 4), 0]
        league_out[CHAOS] = [1.0, 0]
        if div_rate:
            league_out[DIVINE] = [round(div_rate, 4), round(div_vol)]
        out[league] = league_out
    return out


class CurrencyFeed:
    PACE = 1.0          # seconds between feed downloads (a CDN, but be polite)
    LATEST_TTL = 600    # re-probe for a newer hour every 10 minutes
    KEEP_DAYS = 45

    def __init__(self, cache_dir, user_agent):
        self.cache_dir = cache_dir
        self.ua = user_agent
        self._net_lock = threading.Lock()
        self._last_call = 0.0
        self._mem = {}            # hour -> distilled (or None = unpublished)
        self._latest = (0, 0.0)   # (hour, checked_at)

    # -- network ------------------------------------------------------------------
    def _download(self, hour):
        with self._net_lock:
            wait = self.PACE - (time.time() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            self._last_call = time.time()
            req = urllib.request.Request("%s/%d" % (FEED, hour), headers={"User-Agent": self.ua})
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    return None  # not published yet (or never)
                raise

    # -- snapshots ----------------------------------------------------------------
    FORMAT = 2  # bump when distill() changes — old cache files are re-derived

    def _path(self, hour):
        return os.path.join(self.cache_dir, "%d.v%d.json" % (hour, self.FORMAT))

    def snapshot(self, hour):
        """Distilled snapshot for an hour, from memory, disk, or the feed.
        None when the hour isn't published."""
        if hour in self._mem and self._mem[hour] is not None:
            return self._mem[hour]
        try:
            with open(self._path(hour), "r", encoding="utf-8") as f:
                snap = json.load(f)
            self._mem[hour] = snap
            return snap
        except (OSError, ValueError):
            pass
        raw = self._download(hour)
        if raw is None:
            return None
        snap = distill(raw)
        os.makedirs(self.cache_dir, exist_ok=True)
        tmp = self._path(hour) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(snap, f, separators=(",", ":"))
        os.replace(tmp, self._path(hour))
        self._mem[hour] = snap
        return snap

    def latest_hour(self):
        hour, checked = self._latest
        if hour and time.time() - checked < self.LATEST_TTL:
            return hour
        now = int(time.time()) // HOUR * HOUR
        for back in range(0, 7):
            h = now - back * HOUR
            if h == hour or self.snapshot(h) is not None:
                self._latest = (h, time.time())
                return h
        raise RuntimeError("currency feed has no snapshot in the last 6 hours")

    # -- queries --------------------------------------------------------------------
    LOOKBACK_HOURS = 48      # thin markets (some fossils, essences) skip hours
    LOOKBACK_DOWNLOADS = 6   # hours we'll fetch for that; older ones only if cached

    def rates(self, league, ids):
        """{metadata id: chaos value} from the latest hour; anything that didn't
        trade that hour takes its most recent price from earlier hours. Ids with
        no price in the lookback window are omitted. Returns (rates, hour)."""
        hour = self.latest_hour()
        snap = (self.snapshot(hour) or {}).get(league) or {}
        out = {i: snap[i][0] for i in ids if i in snap}
        missing = [i for i in ids if i not in out]
        downloads = 0
        for back in range(1, self.LOOKBACK_HOURS + 1):
            if not missing:
                break
            h = hour - back * HOUR
            cached = h in self._mem or os.path.exists(self._path(h))
            if not cached:
                if downloads >= self.LOOKBACK_DOWNLOADS:
                    continue
                downloads += 1
            older = (self.snapshot(h) or {}).get(league) or {}
            for i in list(missing):
                if i in older:
                    out[i] = older[i][0]
                    missing.remove(i)
        return out, hour

    def history(self, league, ids, days=7, step_hours=12):
        """{metadata id: [[hour, chaos value, volume], ...]} oldest first, on an
        aligned grid (so cached points are reused across sessions) plus the latest
        hour. Points the feed lacks are skipped."""
        latest = self.latest_hour()
        step = step_hours * HOUR
        hours = [latest]
        h = latest // step * step
        if h == latest:
            h -= step
        while h > latest - days * 24 * HOUR:
            hours.append(h)
            h -= step
        series = {i: [] for i in ids}
        for h in sorted(hours):
            snap = (self.snapshot(h) or {}).get(league) or {}
            for i in ids:
                if i in snap:
                    series[i].append([h, snap[i][0], snap[i][1]])
        return series, latest

    def prune(self):
        """Drop snapshots past KEEP_DAYS and any from an older distill FORMAT."""
        cutoff = time.time() - self.KEEP_DAYS * 86400
        current = ".v%d.json" % self.FORMAT
        try:
            for fn in os.listdir(self.cache_dir):
                stem = fn.split(".")[0]
                if stem.isdigit() and (int(stem) < cutoff or not fn.endswith(current)):
                    os.remove(os.path.join(self.cache_dir, fn))
        except OSError:
            pass
