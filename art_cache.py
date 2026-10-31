"""On-disk cache for item/gem art from GGG's CDN.

The app's WebView runs in private mode, so its HTTP cache is wiped on exit and
every launch would download all art again. Instead images are stored under
data/art_cache/ and the page loads them from there (the app is served from its
own folder, so "data/art_cache/<file>" is a same-origin URL).

Cache key = the exact CDN URL. GGG's art URLs encode the art itself, so when
art changes the URL changes too: a new URL is simply a new download, and an
unchanged URL never needs fetching again.
"""
import hashlib
import json
import os
import threading
import urllib.request

ALLOWED_PREFIXES = ("https://web.poecdn.com/",)
MAX_BYTES = 2 * 1024 * 1024
EXT = {"image/png": ".png", "image/webp": ".webp", "image/jpeg": ".jpg", "image/gif": ".gif"}


class ArtCache:
    def __init__(self, data_dir, user_agent):
        self.dir = os.path.join(data_dir, "art_cache")
        self.rel = "data/art_cache/"
        self.ua = user_agent
        self._lock = threading.Lock()
        self._index_path = os.path.join(self.dir, "index.json")
        try:
            with open(self._index_path, "r", encoding="utf-8") as f:
                self._index = json.load(f)  # url -> file name
        except (OSError, ValueError):
            self._index = {}
        # drop entries whose file was deleted
        self._index = {u: fn for u, fn in self._index.items() if os.path.exists(os.path.join(self.dir, fn))}

    def manifest(self):
        """{url: relative path} for every cached image."""
        with self._lock:
            return {u: self.rel + fn for u, fn in self._index.items()}

    def _save_index(self):
        tmp = self._index_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._index, f, separators=(",", ":"))
        os.replace(tmp, self._index_path)

    def cache(self, urls):
        """Download any not-yet-cached URLs. Returns {url: relative path} for the
        ones now cached; URLs outside the CDN allowlist or that fail are skipped."""
        out = {}
        for url in urls:
            if not isinstance(url, str) or not url.startswith(ALLOWED_PREFIXES):
                continue
            with self._lock:
                fn = self._index.get(url)
            if fn:
                out[url] = self.rel + fn
                continue
            try:
                req = urllib.request.Request(url, headers={"User-Agent": self.ua})
                with urllib.request.urlopen(req, timeout=20) as r:
                    ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                    if ctype not in EXT:
                        continue
                    data = r.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES or not data:
                    continue
            except Exception:
                continue
            fn = hashlib.sha1(url.encode("utf-8")).hexdigest()[:24] + EXT[ctype]
            os.makedirs(self.dir, exist_ok=True)
            tmp = os.path.join(self.dir, fn + ".tmp")
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, os.path.join(self.dir, fn))
            with self._lock:
                self._index[url] = fn
                self._save_index()
            out[url] = self.rel + fn
        return out
