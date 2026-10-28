"""NiSH Notes - a lined notebook with a folder menu, for Windows, no admin rights needed.

The window is an Edge WebView2 page (web/), the notebook itself is plain files on disk (store.py).
Run:  python app.py            normal start
      python app.py --smoketest OUTDIR   opens the window, clicks through everything, writes a report
"""
import os
import sys
import threading
import time
from pathlib import Path

import webview

import instance
import settings
import store
import tray

VERSION = "dev"


def resource(*parts):
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base.joinpath(*parts)


try:
    VERSION = resource("VERSION").read_text(encoding="utf-8").strip() or VERSION
except OSError:
    pass


class Api:
    """Everything the page may ask Python for. Only methods are exposed to JavaScript."""

    def __init__(self, notes_dir):
        self._nb = store.Notebook(notes_dir)
        self._window = None
        self._app = None

    # notebook
    def init(self):
        return {"notebook": self._nb.snapshot(), "version": VERSION,
                "prefs": {"font": settings.get("font", "hand"), "lastPage": settings.get("last_page"),
                          "keepRunning": bool(settings.get("keep_running", False)),
                          "trayAvailable": os.name == "nt"}}

    def reload(self):
        return self._nb.load()

    def read_page(self, page_id):
        return self._nb.read_page(page_id)

    def save_page(self, page_id, text):
        return self._nb.save_page(page_id, text)

    def create_page(self, folder_id, title="Untitled", index=None):
        return self._nb.create_page(folder_id, title, index)

    def rename_page(self, page_id, title):
        return self._nb.rename_page(page_id, title)

    def move_page(self, page_id, folder_id, index):
        self._nb.move_page(page_id, folder_id, index)

    def delete_page(self, page_id):
        self._nb.delete_page(page_id)

    def create_folder(self, name="New folder", index=None):
        return self._nb.create_folder(name, index)

    def rename_folder(self, folder_id, name):
        return self._nb.rename_folder(folder_id, name)

    def set_folder(self, folder_id, color=None, open=None):
        self._nb.set_folder(folder_id, color, open)

    def move_folder(self, folder_id, index):
        self._nb.move_folder(folder_id, index)

    def delete_folder(self, folder_id):
        self._nb.delete_folder(folder_id)

    def search(self, query):
        return self._nb.search(query)

    def snapshot(self):
        return self._nb.snapshot()

    # app
    def set_pref(self, key, value):
        if key in ("font", "last_page"):
            settings.put(key, value)
        elif key == "keep_running" and self._app:
            return self._app.set_keep_running(bool(value))

    def open_notes_folder(self):
        if os.name == "nt":
            os.startfile(str(self._nb.root))

    def choose_notes_folder(self):
        kind = webview.FileDialog.FOLDER if hasattr(webview, "FileDialog") else webview.FOLDER_DIALOG
        result = self._window.create_file_dialog(kind, directory=str(self._nb.root))
        if not result:
            return None
        folder = Path(result[0] if isinstance(result, (list, tuple)) else result)
        if (folder / store.INDEX).exists() or not any(folder.iterdir()):
            target = folder
        else:   # an ordinary folder full of other things: keep the notebook in its own subfolder
            target = folder / settings.APP_NAME
        self._nb = store.Notebook(target)
        settings.put("notes_dir", str(target))
        return self._nb.snapshot()


class App:
    """The window's life: its size, and what the X does.

    With "Keep running when closed" on, the X only hides the window. NiSH Notes stays in the tray
    (click it to open again, right-click to quit), and starting the .exe again shows the window.
    """

    def __init__(self, window, api):
        self.window, self.api = window, api
        self.size = None
        self.maximized = False
        self.quitting = False
        self.hidden = False
        self.tray = tray.Tray(str(resource("assets", "icon.ico")), self.show, self.quit, self.toggle_keep_running,
                              lambda: bool(settings.get("keep_running", False)))
        api._app = self

    # window size
    def resized(self, *args):
        width, height = args[-2], args[-1]   # some pywebview versions also pass the window first
        if not self.maximized and width >= 760 and height >= 520:
            self.size = [int(width), int(height)]

    def remember_size(self):
        if self.size:
            settings.put("window", self.size)

    # closing
    def closing(self, *args):
        """pywebview asks this before closing; returning False keeps the app running."""
        self.remember_size()
        if self.quitting or not settings.get("keep_running", False) or not self.tray.running:
            self.tray.stop()
            return True
        # hide from another thread: the window is busy asking us right now
        threading.Timer(0.05, self.hide).start()
        return False

    def hide(self):
        self.hidden = True
        try:
            self.window.hide()
        except Exception:
            pass
        if not settings.get("tray_hint_shown", False):
            settings.put("tray_hint_shown", True)
            self.tray.notify("NiSH Notes is still running. Click its icon here to open it again, "
                             "or right-click it to quit.")

    def show(self):
        self.hidden = False
        try:
            self.window.show()
            self.window.restore()
        except Exception:
            pass

    def quit(self):
        self.quitting = True
        self.tray.stop()
        try:
            self.window.destroy()
        except Exception:
            os._exit(0)

    # the setting
    def set_keep_running(self, on):
        settings.put("keep_running", on)
        ok = self.tray.start() if on else (self.tray.stop() or True)
        if on and not ok:
            settings.put("keep_running", False)
        return bool(settings.get("keep_running", False))

    def toggle_keep_running(self):
        on = not settings.get("keep_running", False)
        if not on and self.hidden:
            self.show()                      # never leave a hidden window with no way back
        self.set_keep_running(on)
        try:
            self.window.evaluate_js("window.NN && NN.setKeepRunning(%s)" % ("true" if on else "false"))
        except Exception:
            pass
        self.tray.refresh()


def smoketest(window, api, outdir):
    """Drive the real page through its own self-test, then check the files on disk."""
    lines, ok = [], True
    try:
        for _ in range(200):
            if window.evaluate_js("!!(window.NN && NN.ready)"):
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("the page never became ready")
        lines.append("ok   page loaded")
        window.evaluate_js("NN.selfTest()")
        result = None
        for _ in range(600):
            result = window.evaluate_js("window.NN_TEST || null")
            if result:
                break
            time.sleep(0.1)
        if not result:
            raise RuntimeError("the page self-test did not finish")
        for step in result.get("steps", []):
            lines.append(("ok   " if step["ok"] else "FAIL ") + step["name"])
            ok = ok and step["ok"]
        root = Path(api._nb.root)
        moved = root / "Smoke B" / "Renamed page.html"
        raw = moved.read_text(encoding="utf-8") if moved.is_file() else ""
        good = "<b>Hello</b> from the smoke test" in raw and "Margin note" in raw and "<svg" in raw and "data-checked" in raw
        lines.append(("ok   " if good else "FAIL ") + "page saved (formatting, margin note, drawing), renamed and moved on disk")
        ok = ok and good
        trashed = any((root / store.TRASH).glob("*.html"))
        lines.append(("ok   " if trashed else "FAIL ") + "deleted page went to _Trash")
        ok = ok and trashed
        app = api._app
        on = api.set_pref("keep_running", True)
        good = on and app.tray.running and app.closing() is False
        time.sleep(0.6)
        lines.append(("ok   " if good and app.hidden else "FAIL ") + "keep running: the X hides the window, tray icon shown")
        ok = ok and good and app.hidden
        app.show()
        time.sleep(0.3)
        good = window.evaluate_js("!!(window.NN && NN.ready)") and not app.hidden
        lines.append(("ok   " if good else "FAIL ") + "showing the window again from the tray")
        ok = ok and good
        api.set_pref("keep_running", False)
        good = not app.tray.running and app.closing() is True
        lines.append(("ok   " if good else "FAIL ") + "with the option off, the X closes the app")
        ok = ok and good
    except Exception as e:
        ok = False
        lines.append(f"FAIL {e!r}")
    lines.append("GUI SMOKETEST PASSED" if ok else "GUI SMOKETEST FAILED")
    Path(outdir).mkdir(parents=True, exist_ok=True)
    (Path(outdir) / "gui_smoketest.txt").write_text("\n".join(lines), encoding="utf-8")
    window.destroy()
    os._exit(0 if ok else 1)


def message_box(text, title=settings.APP_NAME):
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
    else:
        print(text)


def main():
    smoke = None
    if "--smoketest" in sys.argv:
        i = sys.argv.index("--smoketest")
        smoke = Path(sys.argv[i + 1] if len(sys.argv) > i + 1 else "smoketest-out").resolve()
        smoke.mkdir(parents=True, exist_ok=True)
        settings.FILE = smoke / "settings.json"
        notes = smoke / "notes"
    else:
        notes = settings.notes_dir()

    if not smoke and instance.hand_off():
        return                                   # already running: it shows its window instead
    api = Api(notes)
    w, h = settings.get("window", [1200, 800])
    window = webview.create_window(
        settings.APP_NAME, url=str(resource("web", "index.html")), js_api=api,
        width=max(760, int(w)), height=max(520, int(h)), min_size=(760, 520),
        background_color="#2B303C", text_select=True)
    api._window = window
    app = App(window, api)
    window.events.resized += app.resized
    window.events.maximized += lambda *a: setattr(app, "maximized", True)
    window.events.restored += lambda *a: setattr(app, "maximized", False)
    window.events.closing += app.closing
    srv = None
    if not smoke:
        srv = instance.serve(app.show)
        if settings.get("keep_running", False) and not app.tray.start():
            settings.put("keep_running", False)

    func, args = (smoketest, (window, api, smoke)) if smoke else (None, ())
    try:
        storage = settings.data_dir() / "webview"
        webview.start(func, args, gui="edgechromium" if os.name == "nt" else None,
                      private_mode=True, storage_path=str(storage))
    except Exception as e:
        message_box(
            "NiSH Notes needs Microsoft Edge WebView2, which is part of Windows 10 and 11.\n\n"
            "If it is missing, install the \"Evergreen Bootstrapper\" from\n"
            "https://developer.microsoft.com/microsoft-edge/webview2/\n"
            "(it installs for your user only, no admin rights needed).\n\n"
            f"Details: {e}")
        sys.exit(1)
    finally:
        app.tray.stop()
        instance.stop(srv)


if __name__ == "__main__":
    main()
