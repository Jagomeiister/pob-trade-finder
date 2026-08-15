"""Build a distributable release of PoB Trade Finder.

Steps: PyInstaller onefile exe -> stage exe + web app + data into dist/release
-> zip as dist/PoBTradeFinder-v{VERSION}.zip (the auto-updater consumes this
zip from GitHub Releases).

Run: python tools/build_release.py
Then release: gh release create v{VERSION} "dist/PoBTradeFinder-v{VERSION}.zip" --title "v{VERSION}" --notes "..."
"""
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# files/dirs shipped in the release zip (paths relative to project root)
SHIP = [
    "index.html",
    "README.md",
    "LICENSE",
    "icon.ico",
    "js/pob.js",
    "js/matcher.js",
    "js/app.js",
    "data/stats.js",
    "data/leagues.js",
    "data/ranges.js",
    "data/baseicons.js",
    "data/eldritch.js",
    "data/uniquenames.js",
    "data/uniqueranges.js",
    "data/gemtypes.js",
    "data/stats.json",
    "data/leagues.json",
]


def version():
    src = open(os.path.join(ROOT, "gui.py"), encoding="utf-8").read()
    return re.search(r'VERSION = "([^"]+)"', src).group(1)


def main():
    v = version()
    print("Building PoB Trade Finder v%s" % v)

    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pyinstaller", "pywebview", "websocket-client"], check=True)
    # onedir, NOT onefile: onefile self-extracts to %TEMP%\_MEI... on every
    # launch, and antivirus scanning a freshly-updated exe races that
    # extraction ("Failed to load Python DLL"). Onedir ships _internal next
    # to the exe — no extraction, no race, faster startup.
    subprocess.run([
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--windowed",
        "--icon", os.path.join(ROOT, "icon.ico"),
        "--name", "PoB Trade Finder",
        "--collect-all", "webview",
        "--collect-all", "websocket",
        os.path.join(ROOT, "gui.py"),
    ], check=True, cwd=ROOT)

    stage = os.path.join(ROOT, "dist", "release")
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    appdir = os.path.join(ROOT, "dist", "PoB Trade Finder")
    shutil.copy2(os.path.join(appdir, "PoB Trade Finder.exe"), stage)
    shutil.copytree(os.path.join(appdir, "_internal"), os.path.join(stage, "_internal"))
    for rel in SHIP:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(stage, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)

    zpath = os.path.join(ROOT, "dist", "PoBTradeFinder-v%s.zip" % v)
    if os.path.exists(zpath):
        os.remove(zpath)
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(stage):
            for fn in files:
                full = os.path.join(base, fn)
                z.write(full, os.path.relpath(full, stage))
    print("Release zip:", zpath, "(%.1f MB)" % (os.path.getsize(zpath) / 1e6))


if __name__ == "__main__":
    main()
