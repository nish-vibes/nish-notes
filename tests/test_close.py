"""What the window's X does, with and without "Keep running when closed".  python tests/test_close.py"""
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ["LOCALAPPDATA"] = tempfile.mkdtemp()
sys.modules.setdefault("webview", types.SimpleNamespace(FOLDER_DIALOG=20))
import app       # noqa: E402
import settings  # noqa: E402


class FakeWindow:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        return lambda *a: self.calls.append(name)


class FakeTray:
    def __init__(self, works=True):
        self.works, self.running, self.notes = works, False, []

    def start(self):
        self.running = self.works
        return self.works

    def stop(self):
        self.running = False

    def notify(self, text):
        self.notes.append(text)

    def refresh(self):
        pass


class CloseTest(unittest.TestCase):
    def setUp(self):
        settings.FILE = Path(tempfile.mkdtemp()) / "settings.json"
        self.window = FakeWindow()
        self.api = app.Api(Path(tempfile.mkdtemp()) / "notes")
        self.app = app.App(self.window, self.api)
        self.app.tray = FakeTray()

    def test_default_x_closes(self):
        self.assertTrue(self.app.closing())
        self.assertNotIn("hide", self.window.calls)

    def test_keep_running_hides_instead(self):
        self.assertTrue(self.api.set_pref("keep_running", True))
        self.assertFalse(self.app.closing())
        time.sleep(0.2)
        self.assertIn("hide", self.window.calls)
        self.assertEqual(len(self.app.tray.notes), 1)          # the hint, once
        self.app.closing(); time.sleep(0.2)
        self.assertEqual(len(self.app.tray.notes), 1)
        self.app.show()
        self.assertIn("show", self.window.calls)

    def test_quit_from_tray_really_quits(self):
        self.api.set_pref("keep_running", True)
        self.app.quit()
        self.assertIn("destroy", self.window.calls)
        self.assertTrue(self.app.closing())
        self.assertFalse(self.app.tray.running)

    def test_no_tray_means_the_x_still_closes(self):
        self.app.tray = FakeTray(works=False)
        self.assertFalse(self.api.set_pref("keep_running", True))
        self.assertFalse(settings.get("keep_running"))
        self.assertTrue(self.app.closing())

    def test_turning_off_from_tray_shows_a_hidden_window(self):
        self.api.set_pref("keep_running", True)
        self.app.closing(); time.sleep(0.2)
        self.app.toggle_keep_running()
        self.assertFalse(settings.get("keep_running"))
        self.assertIn("show", self.window.calls)
        self.assertTrue(self.app.closing())

    def test_window_size_is_remembered(self):
        self.app.resized(1000, 700)
        self.app.closing()
        self.assertEqual(settings.get("window"), [1000, 700])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
