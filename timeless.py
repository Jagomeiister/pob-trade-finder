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
    def _fetch_part(self, info, jname):
        """One downloaded file, cached and sha256-checked."""
        path = os.path.join(self.cache_dir, info["file"])
        if os.path.exists(path):
            with open(path, "rb") as f:
                blob = f.read()
            if hashlib.sha256(blob).hexdigest() == info["sha256"]:
                return blob
        if not info["url"].startswith(LUT_URL_PREFIX):
            raise RuntimeError("refusing to download timeless data from " + info["url"])
        req = urllib.request.Request(info["url"], headers={"User-Agent": self.ua})
        with urllib.request.urlopen(req, timeout=180) as r:
            blob = r.read()
        if hashlib.sha256(blob).hexdigest() != info["sha256"]:
            raise RuntimeError("timeless data for %s failed its checksum" % jname)
        os.makedirs(self.cache_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(blob)
        os.replace(tmp, path)
        return blob

    def lut(self, jtype):
        jtype = str(jtype)
        with self._lock:
            if jtype in self._luts:
                return self._luts[jtype]
            j = self.d["jewels"][jtype]
            parts = j["lut"].get("parts") or [j["lut"]]  # Glorious Vanity ships in 5 parts
            blob = b"".join(self._fetch_part(p, j["name"]) for p in parts)
            self._luts[jtype] = zlib.decompress(blob)
            return self._luts[jtype]

    # -- Glorious Vanity: variable-length entries ---------------------------------
    # Layout (PoB DataLegionLookUpTableHelper): a sizes block of rows*seeds bytes
    # (entry length per row/seed), then each row's entries back to back, rows in
    # index order (row byte counts in gvRowBytes). Notable entries are 3 bytes
    # (replacement id + rolls) or 6/8 (Might/Legacy of the Vaal: addition ids then
    # their rolls); small passives are 2 bytes.
    GV = "1"
    MIGHT, LEGACY = 76, 77      # legion nodes "Might of the Vaal" / "Legacy of the Vaal"
    GV_OFFENCE_MAX = 21         # addition ids <= 21 are offensive (decides Might vs Legacy)

    def _gv(self):
        if getattr(self, "_gv_cache", None) is None:
            data = self.lut(self.GV)
            seeds = self.seed_count(self.GV)
            rows = self.d["gvRows"]
            start, pos = [], rows * seeds
            for b in self.d["gvRowBytes"]:
                start.append(pos)
                pos += b
            self._gv_cache = {"data": data, "seeds": seeds, "start": start, "offsets": {}}
        return self._gv_cache

    def _gv_entry(self, row, s):
        g = self._gv()
        offs = g["offsets"].get(row)
        if offs is None:
            sizes = g["data"][row * g["seeds"]:(row + 1) * g["seeds"]]
            offs = [0]
            for n in sizes:
                offs.append(offs[-1] + n)
            g["offsets"][row] = offs
        a = g["start"][row] + offs[s]
        return g["data"][a:a + offs[s + 1] - offs[s]]

    def outcomes_at(self, jtype, node_id, s):
        """What seed offset s does to a notable: [(outcome key, roll or None), ...]
        — one entry for most jewels; Might/Legacy of the Vaal adds its additions."""
        jtype = str(jtype)
        if jtype != self.GV:
            o = self.outcome(jtype, node_id, s)
            return [(o[0] + str(o[1]), None)] if o else []
        row = self.d["nodeIndex"].get(str(node_id))
        if row is None:
            return []
        e = self._gv_entry(row, s)
        l2g = self.d["localToGlobal"].get(self.GV, {})
        n_add = self.d["additionsCount"]
        if len(e) in (2, 3):
            rid = l2g.get(str(e[0]), e[0])
            if rid < n_add:
                return []
            rolls = list(e[1:])
            return [("n%d" % (rid - n_add), rolls[0] if len(rolls) == 1 else rolls)]
        if len(e) in (6, 8):
            half = len(e) // 2
            ids = [l2g.get(str(x), x) for x in e[:half]]
            bias = sum(1 if i <= self.GV_OFFENCE_MAX else -1 for i in ids)
            out = [("n%d" % (self.MIGHT if bias >= 0 else self.LEGACY), None)]
            summed = {}
            for i, roll in zip(ids, e[half:]):
                summed[i] = summed.get(i, 0) + roll
            out.extend(("a%d" % i, v) for i, v in summed.items())
            return out
        return []

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
                for key, _ in self.outcomes_at(jtype, nid, s):
                    counts[key] = counts.get(key, 0) + 1
        # share = how often a notable gets this, so Might/Legacy additions don't inflate
        total = sum(c for k, c in counts.items()
                    if not (jtype == self.GV and k[0] == "a")) or 1
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
            entry = self._notable_entry(jtype, n, s, None)
            if entry:
                out.append(entry)
        return {"seed": int(seed), "notables": out}

    def _notable_entry(self, jtype, node, s, weights):
        """{node, key (primary), keys, rolls, weight} for display."""
        got = self.outcomes_at(jtype, node, s)
        if not got:
            return None
        weights = weights or {}
        return {"node": node, "key": got[0][0], "keys": [k for k, _ in got],
                "rolls": {k: r for k, r in got if r is not None},
                "weight": sum(weights.get(k, 0) for k, _ in got)}

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
        scored = []
        if jtype == self.GV:
            # variable-length entries: decode per (seed, notable); keys are strings
            wk = {k: float(v) for k, v in (weights or {}).items() if v}
            nk = {k: int(v) for k, v in (mins or {}).items() if int(v or 0) > 0}
            for s in range(seeds):
                score, counts = 0.0, {}
                for n, _ in rows:
                    for key, _ in self.outcomes_at(jtype, n, s):
                        score += wk.get(key, 0.0)
                        if key in nk:
                            counts[key] = counts.get(key, 0) + 1
                if any(counts.get(k, 0) < v for k, v in nk.items()):
                    continue
                if score > 0 or (nk and score >= 0):
                    scored.append((score, s))
        else:
            offsets = [r * seeds for _, r in rows]
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
            per, counts, totals = [], {}, {}
            for n, _ in rows:
                entry = self._notable_entry(jtype, n, s, weights)
                if not entry:
                    continue
                per.append(entry)
                for k in entry["keys"]:
                    counts[k] = counts.get(k, 0) + 1
                    r = entry["rolls"].get(k)
                    if isinstance(r, (int, float)):
                        totals[k] = totals.get(k, 0) + r
            out.append({"seed": seed, "score": round(score, 3), "notables": per, "counts": counts,
                        "rollTotals": totals})
        return {"results": out, "considered": [n for n, _ in rows], "matches": len(scored)}
