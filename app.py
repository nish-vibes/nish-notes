"""NiSH Notes - a lined notebook with a folder menu, for Windows, no admin rights needed.

The window is an Edge WebView2 page (web/), the notebook itself is plain files on disk (store.py).
Run:  python app.py            normal start
      python app.py --smoketest OUTDIR   opens the window, clicks through everything, writes a report
"""
import os
import sys
import time
from pathlib import Path

import webview

import settings
import store

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

    # notebook
    def init(self):
        return {"notebook": self._nb.snapshot(), "version": VERSION,
                "prefs": {"font": settings.get("font", "hand"), "lastPage": settings.get("last_page")}}

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


class WindowSize:
    """Remembers the last normal (not maximized) window size. Pages save themselves as you type,
    so closing the window needs no extra work."""

    def __init__(self):
        self.size = None
        self.maximized = False

    def resized(self, *args):
        width, height = args[-2], args[-1]   # some pywebview versions also pass the window first
        if not self.maximized and width >= 760 and height >= 520:
            self.size = [int(width), int(height)]

    def closing(self, *args):
        if self.size:
            settings.put("window", self.size)


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
        good = "Hello from the smoke test" in raw and "<b>" in raw and "Margin note" in raw and "<svg" in raw
        lines.append(("ok   " if good else "FAIL ") + "page saved (formatting, margin note, drawing), renamed and moved on disk")
        ok = ok and good
        trashed = any((root / store.TRASH).glob("*.html"))
        lines.append(("ok   " if trashed else "FAIL ") + "deleted page went to _Trash")
        ok = ok and trashed
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

    api = Api(notes)
    w, h = settings.get("window", [1200, 800])
    window = webview.create_window(
        settings.APP_NAME, url=str(resource("web", "index.html")), js_api=api,
        width=max(760, int(w)), height=max(520, int(h)), min_size=(760, 520),
        background_color="#2B303C", text_select=True)
    api._window = window
    size = WindowSize()
    window.events.resized += size.resized
    window.events.maximized += lambda *a: setattr(size, "maximized", True)
    window.events.restored += lambda *a: setattr(size, "maximized", False)
    if not smoke:
        window.events.closing += size.closing

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


if __name__ == "__main__":
    main()
