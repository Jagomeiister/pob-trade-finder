"""Unit tests for currency_feed.distill — run: python test/test_currency_feed.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from currency_feed import CHAOS, DIVINE, distill  # noqa: E402

EX = "Metadata/Items/Currency/CurrencyAddModToRare"
MIRROR = "Metadata/Items/Currency/CurrencyDuplicate"
THIN = "Metadata/Items/Currency/CurrencyCorrupt"


def market(league, a, b, vol, lo=None, hi=None):
    return {"league": league, "market_id": a + "|" + b, "market_pair": [a, b],
            "volume_traded": vol, "lowest_ratio": lo or vol, "highest_ratio": hi or vol}


RAW = {"markets": [
    # 3000 chaos for 10 divine -> 300c
    market("L", CHAOS, DIVINE, {CHAOS: 3000, DIVINE: 10}),
    # exalted vs chaos: 300 chaos for 100 ex (3c); vs divine: 2 div (600c) for 300 ex (2c)
    market("L", CHAOS, EX, {CHAOS: 300, EX: 100}),
    market("L", DIVINE, EX, {DIVINE: 2, EX: 300}),
    # mirror only trades vs divine: 1100 div for 1 mirror
    market("L", MIRROR, DIVINE, {MIRROR: 1, DIVINE: 1100}),
    # no trades this hour: ratio range 1 chaos for 2..4 vaal -> mid 0.375c
    market("L", THIN, CHAOS, {THIN: 0, CHAOS: 0}, lo={THIN: 2, CHAOS: 1}, hi={THIN: 4, CHAOS: 1}),
    # another league must not leak in
    market("Other", CHAOS, DIVINE, {CHAOS: 100, DIVINE: 1}),
]}

failures = 0


def check(name, got, want, tol=1e-3):
    global failures
    ok = got is not None and abs(got - want) <= tol
    failures += not ok
    print(("PASS " if ok else "FAIL ") + name + ": got %s, want %s" % (got, want))


snap = distill(RAW)
L = snap["L"]
check("chaos is 1", L[CHAOS][0], 1.0)
check("divine = chaos volume / divine volume", L[DIVINE][0], 300.0)
# combined VWAP: (300c + 2div*300c) / (100 + 300) = 900 / 400
check("exalted VWAP across both markets", L[EX][0], 2.25)
check("exalted chaos-equivalent volume", L[EX][1], 900)
check("divine-only item converted via divine rate", L[MIRROR][0], 330000.0)
check("no-trade hour falls back to ratio mid", L[THIN][0], 0.375)
check("no-trade hour has zero volume", L[THIN][1], 0)
check("leagues kept separate", snap["Other"][DIVINE][0], 100.0)

# history grids: aligned, oldest first, latest last; finer grids contain the coarser ones,
# so the 1-day / 7-day / 30-day views reuse each other's cached hours
from currency_feed import CurrencyFeed, HOUR  # noqa: E402
latest = 1793437200 + 5 * HOUR  # not on a 6h boundary
g7 = CurrencyFeed.grid(latest, 7, 6)
g1 = CurrencyFeed.grid(latest, 1, 2)
g30 = CurrencyFeed.grid(latest, 30, 24)
check("7-day grid: 28 six-hourly points + latest", len(g7), 29, 0)
check("grid ends at the latest hour", g7[-1], latest, 0)
check("grid is oldest first", 1 if g7 == sorted(g7) else 0, 1, 0)
check("6h points sit on 6h boundaries", sum(h % (6 * HOUR) for h in g7[:-1]), 0, 0)
check("daily grid is a subset of the 6-hourly one", len(set(g30[-8:-1]) - set(g7)), 0, 0)
check("6-hourly grid (last day) is a subset of the 2-hourly one", len(set(g7[-5:-1]) - set(g1)), 0, 0)

print("\nALL TESTS PASSED" if not failures else "\n%d FAILED" % failures)
sys.exit(1 if failures else 0)
