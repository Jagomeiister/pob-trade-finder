"""League-day data refresh: regenerate every bundled data table, then run tests.

Run on each league launch (and after major patches), before building a release:
    python tools/refresh_all.py

Each step fetches fresh source data (GGG trade data endpoints, RePoE, PoB
Community) — none of them call the rate-limited trade search API.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STEPS = [
    ["node", "tools/make-data-js.js", "--fetch"],
    [sys.executable, "tools/make_ranges.py", "--fetch"],
    [sys.executable, "tools/make_baseicons.py", "--fetch"],  # also writes basetypes.js
    [sys.executable, "tools/make_eldritch.py", "--fetch"],
    [sys.executable, "tools/make_uniquenames.py"],
    [sys.executable, "tools/make_uniqueranges.py"],
    [sys.executable, "tools/make_gemtypes.py"],
    [sys.executable, "tools/make_currencymap.py"],  # after make_baseicons (needs base_items)
    [sys.executable, "tools/make_craftdata.py", "--fetch"],  # after currencymap + ranges
    [sys.executable, "tools/make_jeweldata.py", "--fetch"],  # tree export + gems
    [sys.executable, "tools/make_timeless.py", "--update"],  # re-pin PoB timeless data (after jeweldata: needs tree)
    ["node", "test/test.js"],
    [sys.executable, "test/test_currency_feed.py"],
    ["node", "test/test_craft.js"],
    ["node", "test/test_jewels.js"],
    ["node", "test/test_contrast.js"],
    [sys.executable, "test/test_price_hotkey.py"],
    [sys.executable, "test/test_timeless.py"],
    [sys.executable, "test/test_gui_windows.py"],
    [sys.executable, "test/test_league_check.py"],
    [sys.executable, "test/test_diagnostics.py"],
    [sys.executable, "test/test_icon_cache.py"],
    [sys.executable, "test/test_flips.py"],
    [sys.executable, "test/e2e/run_e2e.py"],  # headless Chrome, stubbed bridge, offline
]


def main():
    failed = []
    for cmd in STEPS:
        name = " ".join(os.path.basename(c) if i < 2 else c for i, c in enumerate(cmd))
        print("\n=== %s" % name, flush=True)
        r = subprocess.run(cmd, cwd=ROOT)
        if r.returncode != 0:
            failed.append(name)
    print("\n" + ("FAILED: " + ", ".join(failed) if failed else "All data tables refreshed and tests passed."))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
