"""Minimal headless-Chrome + static-server harness for the e2e suite (stdlib + websocket-client).

- StaticServer: serves the project's front end (index.html, js/, css/, data/*.js) on a free
  127.0.0.1 port from a background thread. Anything else under the root (session.json,
  storage.json, logs) answers 404.
- Browser: launches Chrome headless with a throwaway profile, every hostname except
  127.0.0.1 unresolvable, and talks to the first page target over the DevTools protocol.
  A reader thread routes command replies and collects events (exceptions, console).
"""
import functools
import http.server
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request

import websocket  # websocket-client

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# what the page legitimately loads; everything else is refused
_ALLOWED_TOP = {"index.html", "icon.ico", "favicon.ico"}
_ALLOWED_DIRS = ("js/", "css/")


class _Handler(http.server.SimpleHTTPRequestHandler):
    def _allowed(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0].lstrip("/")
        if ".." in path:
            return False
        if path in _ALLOWED_TOP or path.startswith(_ALLOWED_DIRS):
            return True
        return path.startswith("data/") and path.endswith(".js") and path.count("/") == 1

    def do_GET(self):
        if not self._allowed():
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self._allowed():
            self.send_error(404)
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):  # quiet
        pass


class StaticServer:
    def __init__(self, root):
        handler = functools.partial(_Handler, directory=root)
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.origin = "http://127.0.0.1:%d" % self.port
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class CDPError(RuntimeError):
    pass


class Browser:
    """Headless Chrome driven over one page websocket."""

    def __init__(self, chrome=CHROME, width=1440, height=900):
        self.chrome = chrome
        self.size = (width, height)
        self.proc = None
        self.profile = None
        self.ws = None
        self._id = 0
        self._lock = threading.Lock()
        self._pending = {}
        self._events = []
        self._ev_lock = threading.Lock()
        self._reader = None
        self._closed = False

    # -- lifecycle -------------------------------------------------------------------
    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()

    def start(self):
        if not os.path.exists(self.chrome):
            raise CDPError("Chrome not found at " + self.chrome)
        self.profile = tempfile.mkdtemp(prefix="pobtf-e2e-")
        args = [
            self.chrome, "--headless=new", "--remote-debugging-port=0",
            "--remote-allow-origins=*", "--user-data-dir=" + self.profile,
            "--window-size=%d,%d" % self.size, "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-component-update", "--disable-sync",
            "--disable-default-apps", "--disable-extensions", "--disable-domain-reliability",
            "--metrics-recording-only", "--no-pings", "--mute-audio", "--disable-gpu",
            # offline guarantee: nothing but 127.0.0.1 resolves
            "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
            "about:blank",
        ]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     stdin=subprocess.DEVNULL)
        port = self._wait_port()
        ws_url = self._page_ws(port)
        self.ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True,
                                              enable_multithread=True)
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _wait_port(self):
        marker = os.path.join(self.profile, "DevToolsActivePort")
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise CDPError("Chrome exited early (code %s)" % self.proc.returncode)
            try:
                with open(marker, encoding="utf-8") as f:
                    first = f.readline().strip()
                if first.isdigit():
                    return int(first)
            except OSError:
                pass
            time.sleep(0.05)
        raise CDPError("Chrome DevTools port never appeared")

    @staticmethod
    def _page_ws(port):
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json/list" % port, timeout=2) as r:
                    targets = json.loads(r.read().decode("utf-8"))
                pages = [t for t in targets if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
                if pages:
                    return pages[0]["webSocketDebuggerUrl"]
            except OSError:
                pass
            time.sleep(0.1)
        raise CDPError("no page target")

    def stop(self):
        self._closed = True
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        if self.proc and self.proc.poll() is None:
            # only the Chrome we started (and its children)
            subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
        if self.profile:
            for _ in range(20):  # Chrome children can hold profile files briefly
                shutil.rmtree(self.profile, ignore_errors=True)
                if not os.path.exists(self.profile):
                    break
                time.sleep(0.25)

    # -- protocol --------------------------------------------------------------------
    def _read_loop(self):
        while not self._closed:
            try:
                raw = self.ws.recv()
            except Exception:
                break
            if not raw:
                continue
            msg = json.loads(raw)
            if "id" in msg:
                with self._lock:
                    slot = self._pending.get(msg["id"])
                if slot:
                    slot["msg"] = msg
                    slot["ev"].set()
            else:
                with self._ev_lock:
                    self._events.append(msg)
        with self._lock:  # wake anyone still waiting
            for slot in self._pending.values():
                slot["ev"].set()

    def send(self, method, params=None, timeout=30):
        with self._lock:
            self._id += 1
            mid = self._id
            slot = {"ev": threading.Event(), "msg": None}
            self._pending[mid] = slot
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        ok = slot["ev"].wait(timeout)
        with self._lock:
            self._pending.pop(mid, None)
        if not ok or slot["msg"] is None:
            raise CDPError("%s: no reply within %ss" % (method, timeout))
        if "error" in slot["msg"]:
            raise CDPError("%s: %s" % (method, slot["msg"]["error"].get("message")))
        return slot["msg"].get("result", {})

    def take_events(self):
        with self._ev_lock:
            ev, self._events = self._events, []
        return ev

    # -- helpers ---------------------------------------------------------------------
    def evaluate(self, expression, timeout=30):
        """Evaluate JS (awaiting promises) and return the value by JSON."""
        r = self.send("Runtime.evaluate", {"expression": expression, "awaitPromise": True,
                                           "returnByValue": True, "timeout": int(timeout * 1000)},
                      timeout=timeout + 5)
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            desc = (d.get("exception") or {}).get("description") or d.get("text")
            raise CDPError("evaluate threw: %s" % desc)
        return (r.get("result") or {}).get("value")

    def navigate(self, url, ready_js="document.readyState === 'complete'", timeout=20):
        self.send("Page.navigate", {"url": url})
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if self.evaluate("!!(%s)" % ready_js, timeout=5):
                    return
            except CDPError:
                pass  # context torn down mid-navigation
            time.sleep(0.05)
        raise CDPError("page not ready after %ss: %s" % (timeout, ready_js))

    def key(self, key, code=None, vk=0):
        base = {"key": key, "code": code or key, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
        self.send("Input.dispatchKeyEvent", dict(base, type="rawKeyDown"))
        self.send("Input.dispatchKeyEvent", dict(base, type="keyUp"))
