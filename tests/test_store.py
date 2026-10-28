"""Tests for the notebook on disk. Run:  python tests/test_store.py"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import store  # noqa: E402


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "notes"
        self.nb = store.Notebook(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def folder(self, name):
        return next(f for f in self.nb.snapshot()["folders"] if f["name"] == name)

    def save(self, pid, text, margin="", ink=None, nb=None):
        return (nb or self.nb).save_page(pid, {"text": text, "margin": margin, "ink": ink or []})

    def text(self, pid, nb=None):
        return (nb or self.nb).read_page(pid)["text"]

    def test_first_run_has_welcome_page(self):
        snap = self.nb.snapshot()
        self.assertEqual([f["name"] for f in snap["folders"]], ["Inbox"])
        doc = self.nb.read_page(self.nb.snapshot()["folders"][0]["pages"][0]["id"])
        self.assertIn("<h1>Welcome to NiSH Notes!</h1>", doc["text"])
        self.assertTrue(doc["margin"])
        self.assertTrue((self.root / "Inbox" / "Welcome.html").is_file())

    def test_page_lifecycle(self):
        fid = self.nb.create_folder("School")
        pid = self.nb.create_page(fid, "Lesson ideas")
        self.save(pid, "<div>Line one</div><div>Line två – åäö</div>")
        self.assertEqual(self.text(pid), "<div>Line one</div><div>Line två – åäö</div>")
        self.assertTrue((self.root / "School" / "Lesson ideas.html").is_file())
        self.nb.rename_page(pid, 'What: "next" week?')
        self.assertEqual(self.nb.snapshot()["folders"][1]["pages"][0]["title"], 'What: "next" week?')
        self.assertTrue((self.root / "School" / "What next week.html").is_file())
        self.assertEqual(self.text(pid), "<div>Line one</div><div>Line två – åäö</div>")
        self.nb.delete_page(pid)
        self.assertEqual(self.folder("School")["pages"], [])
        self.assertEqual(len(list((self.root / store.TRASH).glob("*.html"))), 1)

    def test_same_titles_get_unique_files(self):
        fid = self.folder("Inbox")["id"]
        a = self.nb.create_page(fid, "Todo")
        b = self.nb.create_page(fid, "Todo")
        self.save(a, "A")
        self.save(b, "B")
        self.assertEqual((self.text(a), self.text(b)), ("A", "B"))
        self.assertTrue((self.root / "Inbox" / "Todo (2).html").is_file())
        self.nb.rename_page(b, "todo")    # clash with a's file only by letter case
        self.assertEqual(self.text(b), "B")
        self.nb.rename_page(a, "TODO")    # only the case of its own file changes
        self.assertEqual(self.text(a), "A")

    def test_move_and_sort(self):
        inbox = self.folder("Inbox")["id"]
        school = self.nb.create_folder("School")
        p1 = self.nb.create_page(inbox, "One")
        p2 = self.nb.create_page(inbox, "Two")
        self.save(p1, "first")
        self.nb.move_page(p2, inbox, 0)
        self.assertEqual([p["title"] for p in self.folder("Inbox")["pages"]], ["Two", "Welcome", "One"])
        self.nb.move_page(p1, school, 0)
        self.assertEqual([p["title"] for p in self.folder("School")["pages"]], ["One"])
        self.assertEqual(self.text(p1), "first")
        self.assertTrue((self.root / "School" / "One.html").is_file())
        self.nb.move_folder(school, 0)
        self.assertEqual([f["name"] for f in self.nb.snapshot()["folders"]], ["School", "Inbox"])
        # the order survives a restart
        again = store.Notebook(self.root)
        self.assertEqual([f["name"] for f in again.snapshot()["folders"]], ["School", "Inbox"])
        self.assertEqual([p["title"] for p in again.snapshot()["folders"][1]["pages"]], ["Two", "Welcome"])

    def test_moving_into_folder_with_same_file_name(self):
        a = self.nb.create_folder("A")
        b = self.nb.create_folder("B")
        pa = self.nb.create_page(a, "Notes")
        pb = self.nb.create_page(b, "Notes")
        self.save(pa, "from A")
        self.save(pb, "from B")
        self.nb.move_page(pa, b, 5)
        self.assertEqual(self.text(pa), "from A")
        self.assertEqual(self.text(pb), "from B")

    def test_folder_rename_color_delete(self):
        fid = self.nb.create_folder("Music")
        pid = self.nb.create_page(fid, "Setlist")
        self.save(pid, "1. Opener")
        self.assertEqual(self.nb.rename_folder(fid, "Gigs"), "Gigs")
        self.assertTrue((self.root / "Gigs" / "Setlist.html").is_file())
        self.assertEqual(self.text(pid), "1. Opener")
        self.assertEqual(self.nb.rename_folder(fid, "gigs"), "gigs")
        self.assertEqual(self.text(pid), "1. Opener")
        self.nb.set_folder(fid, color="#79AE7F", open=False)
        f = self.folder("gigs")
        self.assertEqual((f["color"], f["open"]), ("#79AE7F", False))
        self.assertEqual(self.nb.rename_folder(fid, "Inbox"), "Inbox (2)")
        self.nb.delete_folder(fid)
        self.assertEqual([f["name"] for f in self.nb.snapshot()["folders"]], ["Inbox"])
        self.assertTrue(any((self.root / store.TRASH).iterdir()))

    def test_picks_up_files_added_outside_the_app(self):
        (self.root / "Recipes").mkdir()
        (self.root / "Recipes" / "Pancakes.txt").write_text("eggs, milk", encoding="utf-8")
        (self.root / "Inbox" / "From Notepad.md").write_text("# hi", encoding="utf-8")
        (self.root / "Inbox" / "Welcome.html").unlink()
        nb = store.Notebook(self.root)
        snap = nb.snapshot()
        self.assertEqual([f["name"] for f in snap["folders"]], ["Inbox", "Recipes"])
        self.assertEqual([p["title"] for p in snap["folders"][0]["pages"]], ["From Notepad"])
        pid = snap["folders"][1]["pages"][0]["id"]
        self.assertEqual(self.text(pid, nb), "<div>eggs, milk</div>")
        self.assertNotIn(store.TRASH, [f["name"] for f in snap["folders"]])

    def test_broken_index_is_rebuilt(self):
        (self.root / store.INDEX).write_text("{not json", encoding="utf-8")
        nb = store.Notebook(self.root)
        self.assertEqual([p["title"] for p in nb.snapshot()["folders"][0]["pages"]], ["Welcome"])
        json.loads((self.root / store.INDEX).read_text(encoding="utf-8"))

    def test_windows_file_names(self):
        self.assertEqual(store.safe_name('a<b>c:d"e/f\\g|h?i*j'), "abcdefghij")
        self.assertEqual(store.safe_name("   "), "Untitled")
        self.assertEqual(store.safe_name("_Trash"), "Trash")
        self.assertEqual(store.safe_name("CON"), "CON_")
        self.assertEqual(store.safe_name("dots..."), "dots")
        fid = self.folder("Inbox")["id"]
        pid = self.nb.create_page(fid, "???")
        self.save(pid, "x")
        self.assertEqual(self.text(pid), "x")

    def test_search(self):
        fid = self.folder("Inbox")["id"]
        pid = self.nb.create_page(fid, "Shopping")
        self.save(pid, "<div>Oat <b>milk</b></div><div>Coffee&nbsp;beans</div>", margin="<div>Tuesday</div>")
        self.assertEqual(self.nb.search("coffee MILK"), [pid])
        self.assertEqual(self.nb.search("shopping"), [pid])
        self.assertEqual(self.nb.search("tea"), [])
        self.assertEqual(self.nb.search("tuesday"), [pid])
        self.assertEqual(self.nb.search("milk coffee"), [pid])
        self.assertEqual(self.nb.search("div"), [])        # tags are not text
        self.assertEqual(self.nb.search("  "), [])

    def test_reads_old_ansi_files(self):
        (self.root / "Inbox" / "Old.txt").write_bytes("Gammal fil: åäö".encode("cp1252"))
        nb = store.Notebook(self.root)
        pid = next(p["id"] for p in nb.snapshot()["folders"][0]["pages"] if p["title"] == "Old")
        self.assertEqual(self.text(pid, nb), "<div>Gammal fil: åäö</div>")

    def test_old_txt_page_becomes_html_when_saved(self):
        (self.root / "Inbox" / "Plans.txt").write_text("Line 1\n\n<b>not bold</b> & co", encoding="utf-8")
        nb = store.Notebook(self.root)
        pid = next(p["id"] for p in nb.snapshot()["folders"][0]["pages"] if p["title"] == "Plans")
        self.assertEqual(self.text(pid, nb), "<div>Line 1</div><div><br></div><div>&lt;b&gt;not bold&lt;/b&gt; &amp; co</div>")
        self.save(pid, "<div>Line 1</div><div><b>bold now</b></div>", nb=nb)
        self.assertFalse((self.root / "Inbox" / "Plans.txt").exists())
        self.assertTrue((self.root / "Inbox" / "Plans.html").is_file())
        again = store.Notebook(self.root)
        self.assertEqual(self.text(pid, again), "<div>Line 1</div><div><b>bold now</b></div>")
        self.assertEqual([p["title"] for p in again.snapshot()["folders"][0]["pages"]].count("Plans"), 1)

    def test_margin_and_drawing_round_trip(self):
        fid = self.folder("Inbox")["id"]
        pid = self.nb.create_page(fid, "Sketch")
        ink = [{"t": "pen", "c": "#22304A", "w": 3, "p": [10, 20, 30.25, 40, 50, 60]},
               {"t": "marker", "c": "#F2C200", "w": 18, "p": [5, 5]}]
        self.save(pid, "<div>Hi</div>", margin="<div>Mon</div>", ink=ink)
        doc = store.Notebook(self.root).read_page(pid)
        self.assertEqual(doc["margin"], "<div>Mon</div>")
        self.assertEqual(doc["ink"][0]["p"], [10, 20, 30.2, 40, 50, 60])
        self.assertEqual(len(doc["ink"]), 2)
        raw = (self.root / "Inbox" / "Sketch.html").read_text(encoding="utf-8")
        self.assertIn("<svg", raw)          # the drawing also shows when the file is opened in a browser

    def test_bad_strokes_are_dropped(self):
        bad = [{"t": "pen", "c": "red", "w": 3, "p": [1, 2]}, {"t": "laser", "c": "#000000", "w": 3, "p": [1, 2]},
               {"t": "pen", "c": "#000000", "w": 3, "p": [1, 2, 3]}, {"t": "pen", "c": "#000000", "w": 999, "p": [1, 2]},
               "nonsense", {"t": "pen", "c": "#000000\"><script>", "w": 3, "p": [1, 2]},
               {"t": "pen", "c": "#000000", "w": 2, "p": [1, 2]}]
        self.assertEqual(len(store.clean_ink(bad)), 1)
        self.assertEqual(store.clean_ink("x"), [])

    def test_page_text_cannot_break_out_of_its_part(self):
        fid = self.folder("Inbox")["id"]
        pid = self.nb.create_page(fid, '</title><script>alert(1)</script>')
        self.save(pid, "a<!--/nn:text-->b", margin="m</script>")
        raw = next((self.root / "Inbox").glob("*.html"), None)
        doc = self.nb.read_page(pid)
        self.assertEqual(doc["text"], "a&lt;!--/nn:text-->b")
        self.assertNotIn("<script>alert", (self.root / "Inbox" / self.nb.data["folders"][0]["pages"][-1]["file"]).read_text(encoding="utf-8"))

    def test_web_page_from_elsewhere(self):
        (self.root / "Inbox" / "Saved.html").write_text("<html><body><p>Hello</p></body></html>", encoding="utf-8")
        nb = store.Notebook(self.root)
        pid = next(p["id"] for p in nb.snapshot()["folders"][0]["pages"] if p["title"] == "Saved")
        self.assertEqual(self.text(pid, nb), "<p>Hello</p>")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
