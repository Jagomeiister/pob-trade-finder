"""Timeless jewel seed search (Lethal Pride, Brutal Restraint, Militant Faith,
Elegant Hubris, Heroic Tragedy).

A timeless jewel's seed decides what happens to every NOTABLE in its radius;
small passives get a fixed bonus per jewel type and keystones depend only on
the conqueror. Path of Building ships the game's outcomes as lookup tables:
one byte per (notable row, seed). This module reads them exactly as PoB's
DataLegionLookUpTableHelper.readLUT does:

    byte = lut[row * seedCount + (seed - seedMin)]      (Elegant Hubris seeds / 20)
    byte = localToGlobal[type].get(byte, byte)
    byte >= 337 -> notable REPLACED by legion node  nodes[byte - 337]
    byte <  337 -> notable GAINS legion addition    additions[byte]

Data: data/timeless.json (tools/make_timeless.py). The LUTs are downloaded on
first use from the pinned PoB commit and verified against their sha256.
"""
import hashlib
import json
import os
import threading
import urllib.request
import zlib

LUT_URL_PREFIX = "https://raw.githubusercontent.com/PathOfBuildingCommunity/PathOfBuilding/"


class TimelessData:
    def __init__(self, data_dir, user_agent):
        self.data_dir = data_dir
        self.ua = user_agent
        self.cache_dir = os.path.join(data_dir, "timeless_cache")
        self._d = None
        self._luts = {}
        self._lock = threading.Lock()

    @property
    def d(self):
        if self._d is None:
            with open(os.path.join(self.data_dir, "timeless.json"), "r", encoding="utf-8") as f:
                self._d = json.load(f)
        return self._d

    # -- lookup tables ------------------------------------------------------------
    def lut(self, jtype):
        jtype = str(jtype)
        with self._lock:
            if jtype in self._luts:
                return self._luts[jtype]
            info = self.d["jewels"][jtype]["lut"]
            path = os.path.join(self.cache_dir, info["file"])
            blob = None
            if os.path.exists(path):
                with open(path, "rb") as f:
                    blob = f.read()
                if hashlib.sha256(blob).hexdigest() != info["sha256"]:
                    blob = None  # stale or corrupt — fetch again
            if blob is None:
                if not info["url"].startswith(LUT_URL_PREFIX):
                    raise RuntimeError("refusing to download timeless data from " + info["url"])
                req = urllib.request.Request(info["url"], headers={"User-Agent": self.ua})
                with urllib.request.urlopen(req, timeout=120) as r:
                    blob = r.read()
                if hashlib.sha256(blob).hexdigest() != info["sha256"]:
                    raise RuntimeError("timeless data for %s failed its checksum" % self.d["jewels"][jtype]["name"])
                os.makedirs(self.cache_dir, exist_ok=True)
                tmp = path + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(blob)
                os.replace(tmp, path)
            self._luts[jtype] = zlib.decompress(blob)
            return self._luts[jtype]

    def seed_count(self, jtype):
        j = self.d["jewels"][str(jtype)]
        return j["seedMax"] - j["seedMin"] + 1

    def outcome(self, jtype, node_id, seed_index):
        """('a'|'n', index) for a notable at seed offset seed_index, else None."""
        row = self.d["nodeIndex"].get(str(node_id))
        if row is None or row >= self.d["sizeNotable"]:
            return None
        data = self.lut(jtype)
        pos = row * self.seed_count(jtype) + seed_index
        if pos >= len(data):
            return None
        b = data[pos]
        b = self.d["localToGlobal"].get(str(jtype), {}).get(str(b), b)
        n_add = self.d["additionsCount"]
        return ("n", b - n_add) if b >= n_add else ("a", b)

    def describe(self, key):
        kind, idx = key[0], int(key[1:])
        e = (self.d["nodes"] if kind == "n" else self.d["additions"])[idx]
        return {"key": key, "replace": kind == "n", "dn": e["dn"], "sd": e["sd"], "id": e["id"]}

    # -- geometry -------------------------------------------------------------------
    def in_radius(self, socket_id):
        geo = self.d["geometry"]
        s = geo.get(str(socket_id))
        if not s or s[2] != 3:
            raise ValueError("node %s is not a jewel socket on this tree" % socket_id)
        r2 = self.d["radius"] ** 2
        out = []
        for nid, (x, y, kind) in geo.items():
            if nid == str(socket_id) or kind == 3:
                continue
            if (x - s[0]) ** 2 + (y - s[1]) ** 2 <= r2:
                out.append((int(nid), kind))
        return out

    def sockets(self):
        return [int(n) for n, v in self.d["geometry"].items() if v[2] == 3]

    # -- search ---------------------------------------------------------------------
    def info(self, jtype, socket_id, allocated):
        """Radius summary plus every outcome the seed can produce on these notables."""
        jtype = str(jtype)
        alloc = set(int(a) for a in allocated)
        nodes = self.in_radius(socket_id)
        notables = [n for n, k in nodes if k == 1]
        counts = {}
        seeds = self.seed_count(jtype)
        for nid in notables:
            row = self.d["nodeIndex"].get(str(nid))
            if row is None or row >= self.d["sizeNotable"]:
                continue
            for s in range(seeds):
                o = self.outcome(jtype, nid, s)
                if o:
                    key = o[0] + str(o[1])
                    counts[key] = counts.get(key, 0) + 1
        total = sum(counts.values()) or 1
        outcomes = []
        for key, c in sorted(counts.items(), key=lambda kv: -kv[1]):
            o = self.describe(key)
            o["share"] = round(c / total, 4)
            outcomes.append(o)
        return {
            "jewel": self.d["jewels"][jtype]["name"],
            "seedMin": self.d["jewels"][jtype]["seedMin"], "seedMax": self.d["jewels"][jtype]["seedMax"],
            "seedStep": self.d["jewels"][jtype]["seedStep"], "small": self.d["jewels"][jtype]["small"],
            "conquerors": self.d["jewels"][jtype]["conquerors"],
            "notables": [{"id": n, "allocated": n in alloc} for n in notables],
            "keystones": [n for n, k in nodes if k == 2],
            "smalls": [{"id": n, "allocated": n in alloc} for n, k in nodes if k == 0],
            "outcomes": outcomes,
        }

    def seed_outcomes(self, jtype, socket_id, allocated, seed, include_unallocated=False):
        """What one seed does to the notables at a socket (for a jewel you already own)."""
        jtype = str(jtype)
        j = self.d["jewels"][jtype]
        s = int(seed) // j["seedStep"] - j["seedMin"]
        if not 0 <= s < self.seed_count(jtype) or int(seed) % j["seedStep"]:
            raise ValueError("seed %s is outside %s's range" % (seed, j["name"]))
        alloc = set(int(a) for a in allocated)
        out = []
        for n, k in self.in_radius(socket_id):
            if k != 1 or not (include_unallocated or n in alloc):
                continue
            o = self.outcome(jtype, n, s)
            if o:
                out.append({"node": n, "key": o[0] + str(o[1])})
        return {"seed": int(seed), "notables": out}

    def _byte_key(self, key):
        kind, idx = key[0], int(key[1:])
        return (self.d["additionsCount"] + idx) if kind == "n" else idx

    def search(self, jtype, socket_id, allocated, weights, include_unallocated=False, top=30, mins=None):
        """Rank every seed by what it does to the notables in radius.
        weights: {outcome key: weight} — negative weights mean "avoid".
        mins:    {outcome key: n} — the seed must give that outcome to at least n
                 notables (e.g. Minion Damage x2 AND Aura Effect x1), else it's dropped.
        Each result carries per-outcome counts and the per-notable outcomes."""
        jtype = str(jtype)
        alloc = set(int(a) for a in allocated)
        notables = [n for n, k in self.in_radius(socket_id) if k == 1 and (include_unallocated or n in alloc)]
        rows = [(n, self.d["nodeIndex"].get(str(n))) for n in notables]
        rows = [(n, r) for n, r in rows if r is not None and r < self.d["sizeNotable"]]
        data = self.lut(jtype)
        seeds = self.seed_count(jtype)
        l2g = {int(k): v for k, v in self.d["localToGlobal"].get(jtype, {}).items()}
        n_add = self.d["additionsCount"]
        w = {}
        for k, v in (weights or {}).items():
            try:
                v = float(v)
            except (TypeError, ValueError):
                continue
            if v:
                w[self._byte_key(k)] = v
        need = {}
        for k, v in (mins or {}).items():
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
            if v > 0:
                need[self._byte_key(k)] = v
        offsets = [r * seeds for _, r in rows]
        scored = []
        for s in range(seeds):
            score = 0.0
            counts = {}
            for off in offsets:
                b = data[off + s]
                b = l2g.get(b, b)
                score += w.get(b, 0.0)
                if b in need:
                    counts[b] = counts.get(b, 0) + 1
            if any(counts.get(b, 0) < n for b, n in need.items()):
                continue
            if score > 0 or (need and score >= 0):
                scored.append((score, s))
        scored.sort(key=lambda t: (-t[0], t[1]))
        j = self.d["jewels"][jtype]
        out = []
        for score, s in scored[:top]:
            seed = (j["seedMin"] + s) * j["seedStep"]
            per, counts = [], {}
            for n, _ in rows:
                o = self.outcome(jtype, n, s)
                if o:
                    key = o[0] + str(o[1])
                    counts[key] = counts.get(key, 0) + 1
                    per.append({"node": n, "key": key, "weight": (weights or {}).get(key, 0)})
            out.append({"seed": seed, "score": round(score, 3), "notables": per, "counts": counts})
        return {"results": out, "considered": [n for n, _ in rows], "matches": len(scored)}
