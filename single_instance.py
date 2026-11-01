"""One PoB Trade Finder per Windows user.

Two copies fight over the same things: the update swap (one copy keeps the files locked
while the other replaces them), the global hotkeys, the tray icon, the in-game overlays and
data/storage.json. So the first copy holds a named mutex; a second launch asks the running
copy to show itself (a named event) and exits.

Windows frees the mutex when its owner exits, even on a crash, so a stale lock can't block
the app. After an update the relaunched exe waits for the old copy to finish closing
(acquire(wait=...)) instead of giving up.
"""
import ctypes
import sys
import threading

MUTEX_NAME = "Local\\PoBTradeFinder.Running"
SHOW_EVENT_NAME = "Local\\PoBTradeFinder.Show"
ERROR_ALREADY_EXISTS = 183
WAIT_OBJECT_0, WAIT_ABANDONED, WAIT_TIMEOUT = 0x0, 0x80, 0x102


def _kernel32():
    from ctypes import wintypes
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    k.CreateMutexW.restype = wintypes.HANDLE
    k.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
    k.CreateEventW.restype = wintypes.HANDLE
    k.SetEvent.argtypes = [wintypes.HANDLE]
    k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k.WaitForSingleObject.restype = wintypes.DWORD
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.ReleaseMutex.argtypes = [wintypes.HANDLE]
    return k


class SingleInstance:
    def __init__(self, mutex_name=MUTEX_NAME, show_event_name=SHOW_EVENT_NAME):
        self.mutex_name = mutex_name
        self.show_event_name = show_event_name
        self._mutex = None
        self._win = sys.platform == "win32"

    def acquire(self, wait=0.0):
        """True when this is the only copy (or Windows can't tell us: never lock the user
        out). wait: seconds to wait for another copy to exit first (after an update)."""
        if not self._win:
            return True
        k = _kernel32()
        h = k.CreateMutexW(None, True, self.mutex_name)
        err = ctypes.get_last_error()
        if not h:
            return True
        if err != ERROR_ALREADY_EXISTS:
            self._mutex = h
            return True
        if wait > 0:
            r = k.WaitForSingleObject(h, int(wait * 1000))
            if r in (WAIT_OBJECT_0, WAIT_ABANDONED):  # the other copy closed (or crashed)
                self._mutex = h
                return True
        k.CloseHandle(h)
        return False

    def release(self):
        if self._mutex and self._win:
            k = _kernel32()
            k.ReleaseMutex(self._mutex)
            k.CloseHandle(self._mutex)
        self._mutex = None

    @property
    def owned(self):
        return bool(self._mutex) or not self._win

    def ask_running_copy_to_show(self):
        """The second launch: tell the running copy to bring its window forward."""
        if not self._win:
            return False
        k = _kernel32()
        h = k.CreateEventW(None, False, False, self.show_event_name)
        if not h:
            return False
        ok = bool(k.SetEvent(h))
        k.CloseHandle(h)
        return ok

    def listen_for_show(self, on_show, stopped, poll=0.5):
        """The running copy: call on_show() each time another launch asks. Daemon thread."""
        if not self._win:
            return None
        k = _kernel32()
        h = k.CreateEventW(None, False, False, self.show_event_name)  # auto-reset
        if not h:
            return None

        def run():
            try:
                while not stopped():
                    if k.WaitForSingleObject(h, int(poll * 1000)) == WAIT_OBJECT_0:
                        try:
                            on_show()
                        except Exception:
                            pass
            finally:
                k.CloseHandle(h)

        t = threading.Thread(target=run, name="single-instance", daemon=True)
        t.start()
        return t
