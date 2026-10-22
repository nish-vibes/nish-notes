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

    def test_first_run_has_welcome_page(self):
        snap = self.nb.snapshot()
        self.assertEqual([f["name"] for f in snap["folders"]], ["Inbox"])
        self.assertTrue((self.root / "Inbox" / "Welcome.txt").read_text(encoding="utf-8").startswith("Welcome"))

    def test_page_lifecycle(self):
        fid = self.nb.create_folder("School")
        pid = self.nb.create_page(fid, "Lesson ideas")
        self.nb.save_page(pid, "Line one\nLine två – åäö\n")
        self.assertEqual(self.nb.read_page(pid), "Line one\nLine två – åäö\n")
        self.assertTrue((self.root / "School" / "Lesson ideas.txt").is_file())
        self.nb.rename_page(pid, 'What: "next" week?')
        self.assertEqual(self.nb.snapshot()["folders"][1]["pages"][0]["title"], 'What: "next" week?')
        self.assertTrue((self.root / "School" / "What next week.txt").is_file())
        self.assertEqual(self.nb.read_page(pid), "Line one\nLine två – åäö\n")
        self.nb.delete_page(pid)
        self.assertEqual(self.folder("School")["pages"], [])
        self.assertEqual(len(list((self.root / store.TRASH).glob("*.txt"))), 1)

    def test_same_titles_get_unique_files(self):
        fid = self.folder("Inbox")["id"]
        a = self.nb.create_page(fid, "Todo")
        b = self.nb.create_page(fid, "Todo")
        self.nb.save_page(a, "A")
        self.nb.save_page(b, "B")
        self.assertEqual((self.nb.read_page(a), self.nb.read_page(b)), ("A", "B"))
        self.assertTrue((self.root / "Inbox" / "Todo (2).txt").is_file())
        self.nb.rename_page(b, "todo")    # clash with a's file only by letter case
        self.assertEqual(self.nb.read_page(b), "B")
        self.nb.rename_page(a, "TODO")    # only the case of its own file changes
        self.assertEqual(self.nb.read_page(a), "A")

    def test_move_and_sort(self):
        inbox = self.folder("Inbox")["id"]
        school = self.nb.create_folder("School")
        p1 = self.nb.create_page(inbox, "One")
        p2 = self.nb.create_page(inbox, "Two")
        self.nb.save_page(p1, "first")
        self.nb.move_page(p2, inbox, 0)
        self.assertEqual([p["title"] for p in self.folder("Inbox")["pages"]], ["Two", "Welcome", "One"])
        self.nb.move_page(p1, school, 0)
        self.assertEqual([p["title"] for p in self.folder("School")["pages"]], ["One"])
        self.assertEqual(self.nb.read_page(p1), "first")
        self.assertTrue((self.root / "School" / "One.txt").is_file())
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
        self.nb.save_page(pa, "from A")
        self.nb.save_page(pb, "from B")
        self.nb.move_page(pa, b, 5)
        self.assertEqual(self.nb.read_page(pa), "from A")
        self.assertEqual(self.nb.read_page(pb), "from B")

    def test_folder_rename_color_delete(self):
        fid = self.nb.create_folder("Music")
        pid = self.nb.create_page(fid, "Setlist")
        self.nb.save_page(pid, "1. Opener")
        self.assertEqual(self.nb.rename_folder(fid, "Gigs"), "Gigs")
        self.assertTrue((self.root / "Gigs" / "Setlist.txt").is_file())
        self.assertEqual(self.nb.read_page(pid), "1. Opener")
        self.assertEqual(self.nb.rename_folder(fid, "gigs"), "gigs")
        self.assertEqual(self.nb.read_page(pid), "1. Opener")
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
        (self.root / "Inbox" / "Welcome.txt").unlink()
        nb = store.Notebook(self.root)
        snap = nb.snapshot()
        self.assertEqual([f["name"] for f in snap["folders"]], ["Inbox", "Recipes"])
        self.assertEqual([p["title"] for p in snap["folders"][0]["pages"]], ["From Notepad"])
        pid = snap["folders"][1]["pages"][0]["id"]
        self.assertEqual(nb.read_page(pid), "eggs, milk")
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
        self.nb.save_page(pid, "x")
        self.assertEqual(self.nb.read_page(pid), "x")

    def test_search(self):
        fid = self.folder("Inbox")["id"]
        pid = self.nb.create_page(fid, "Shopping")
        self.nb.save_page(pid, "Oat milk\nCoffee beans")
        self.assertEqual(self.nb.search("coffee MILK"), [pid])
        self.assertEqual(self.nb.search("shopping"), [pid])
        self.assertEqual(self.nb.search("tea"), [])
        self.assertEqual(self.nb.search("  "), [])

    def test_reads_old_ansi_files(self):
        (self.root / "Inbox" / "Old.txt").write_bytes("Gammal fil: åäö".encode("cp1252"))
        nb = store.Notebook(self.root)
        pid = next(p["id"] for p in nb.snapshot()["folders"][0]["pages"] if p["title"] == "Old")
        self.assertEqual(nb.read_page(pid), "Gammal fil: åäö")


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    sys.exit(0 if result.wasSuccessful() else 1)
