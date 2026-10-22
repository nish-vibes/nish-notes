"""The notebook on disk.

Every folder in the menu is a real folder and every page is a plain .txt file inside it,
so the notes can be read (and backed up) without the app. A small index file,
``_nishnotes.json``, remembers the things a file system can't: the order of folders and
pages, folder colours and which folders are open.

Folders and files that appear on disk while the app is closed are picked up on the next
start; pages whose file has disappeared are dropped from the index. Deleted pages and
folders are moved to ``_Trash`` inside the notes folder, never erased.
"""
import datetime
import json
import os
import re
import shutil
import threading
import uuid
from pathlib import Path

INDEX = "_nishnotes.json"
TRASH = "_Trash"
TEXT_EXT = (".txt", ".md")
COLORS = ["#E3A93E", "#6A9BD1", "#D97B63", "#79AE7F", "#A58BD6", "#8C8A84"]
_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def safe_name(name, fallback="Untitled"):
    """A name Windows accepts as a file or folder name."""
    name = re.sub(r"\s+", " ", _BAD.sub("", str(name or ""))).strip().lstrip("_. ")
    name = name[:80].rstrip(". ")
    if not name:
        return fallback
    if name.upper().split(".")[0].strip() in _RESERVED:
        name = name + "_"
    return name


def _new_id(prefix):
    return prefix + uuid.uuid4().hex[:10]


def _write_atomic(path, text):
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Notebook:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()
        self.data = {"version": 1, "folders": []}
        self.load()

    # ---------- index ----------
    def _index_path(self):
        return self.root / INDEX

    def _save_index(self):
        _write_atomic(self._index_path(), json.dumps(self.data, indent=1, ensure_ascii=False))

    def load(self):
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            try:
                data = json.loads(self._index_path().read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("folders"), list):
                    self.data = data
            except Exception:
                pass
            first_run = not self._index_path().exists()
            self._reconcile()
            if first_run and not self.data["folders"]:
                f = self._add_folder("Inbox")
                p = self._add_page(f, "Welcome")
                self._file(f, p).write_text(WELCOME, encoding="utf-8")
            self._save_index()
            return self.snapshot()

    def _reconcile(self):
        """Match the index with what is really on disk."""
        known_dirs = set()
        folders = []
        for f in self.data["folders"]:
            d = self.root / f.get("dir", "")
            if not f.get("dir") or not d.is_dir():
                continue
            known_dirs.add(f["dir"].lower())
            f.setdefault("id", _new_id("f"))
            f.setdefault("name", f["dir"])
            f.setdefault("color", COLORS[len(folders) % len(COLORS)])
            f.setdefault("open", True)
            pages, seen = [], set()
            for p in f.get("pages", []):
                if p.get("file") and (d / p["file"]).is_file() and p["file"].lower() not in seen:
                    seen.add(p["file"].lower())
                    p.setdefault("id", _new_id("p"))
                    p.setdefault("title", Path(p["file"]).stem)
                    p.setdefault("created", now())
                    p.setdefault("updated", p["created"])
                    pages.append(p)
            for file in sorted(d.iterdir(), key=lambda x: x.stat().st_mtime):
                if file.is_file() and file.suffix.lower() in TEXT_EXT and file.name.lower() not in seen:
                    stamp = datetime.datetime.fromtimestamp(file.stat().st_mtime).astimezone().isoformat(timespec="seconds")
                    pages.append({"id": _new_id("p"), "title": file.stem, "file": file.name,
                                  "created": stamp, "updated": stamp})
            f["pages"] = pages
            folders.append(f)
        for d in sorted(self.root.iterdir(), key=lambda x: x.name.lower()):
            if d.is_dir() and not d.name.startswith(("_", ".")) and d.name.lower() not in known_dirs:
                folders.append({"id": _new_id("f"), "name": d.name, "dir": d.name,
                                "color": COLORS[len(folders) % len(COLORS)], "open": True, "pages": []})
                self._reconcile_one(folders[-1])
        self.data["folders"] = folders

    def _reconcile_one(self, f):
        d = self.root / f["dir"]
        for file in sorted(d.iterdir(), key=lambda x: x.stat().st_mtime):
            if file.is_file() and file.suffix.lower() in TEXT_EXT:
                stamp = datetime.datetime.fromtimestamp(file.stat().st_mtime).astimezone().isoformat(timespec="seconds")
                f["pages"].append({"id": _new_id("p"), "title": file.stem, "file": file.name,
                                   "created": stamp, "updated": stamp})

    def snapshot(self):
        with self.lock:
            return {"root": str(self.root), "folders": [
                {"id": f["id"], "name": f["name"], "color": f["color"], "open": f["open"],
                 "pages": [{"id": p["id"], "title": p["title"], "created": p["created"],
                            "updated": p["updated"]} for p in f["pages"]]}
                for f in self.data["folders"]]}

    # ---------- lookups ----------
    def _folder(self, folder_id):
        for f in self.data["folders"]:
            if f["id"] == folder_id:
                return f
        raise KeyError("No such folder")

    def _page(self, page_id):
        for f in self.data["folders"]:
            for p in f["pages"]:
                if p["id"] == page_id:
                    return f, p
        raise KeyError("No such page")

    def _file(self, f, p):
        return self.root / f["dir"] / p["file"]

    def _unique(self, directory, stem, ext="", taken_ok=None):
        n = 1
        while True:
            name = stem + (f" ({n})" if n > 1 else "") + ext
            target = directory / name
            if (taken_ok and name.lower() == taken_ok.lower()) or not target.exists():
                return name
            n += 1

    # ---------- folders ----------
    def _add_folder(self, name, index=None):
        d = self._unique(self.root, safe_name(name, "Folder"))
        (self.root / d).mkdir(parents=True)
        f = {"id": _new_id("f"), "name": d, "dir": d,
             "color": COLORS[len(self.data["folders"]) % len(COLORS)], "open": True, "pages": []}
        folders = self.data["folders"]
        folders.insert(len(folders) if index is None else max(0, min(index, len(folders))), f)
        return f

    def create_folder(self, name="New folder", index=None):
        with self.lock:
            f = self._add_folder(name, index)
            self._save_index()
            return f["id"]

    def rename_folder(self, folder_id, name):
        with self.lock:
            f = self._folder(folder_id)
            new = self._unique(self.root, safe_name(name, f["name"]), taken_ok=f["dir"])
            if new != f["dir"]:
                if new.lower() == f["dir"].lower():   # only the letter case changed
                    tmp = self.root / (f["dir"] + "." + uuid.uuid4().hex[:6])
                    os.replace(self.root / f["dir"], tmp)
                    os.replace(tmp, self.root / new)
                else:
                    os.replace(self.root / f["dir"], self.root / new)
                f["dir"] = new
            f["name"] = new
            self._save_index()
            return new

    def set_folder(self, folder_id, color=None, open=None):
        with self.lock:
            f = self._folder(folder_id)
            if color:
                f["color"] = str(color)[:20]
            if open is not None:
                f["open"] = bool(open)
            self._save_index()

    def move_folder(self, folder_id, index):
        with self.lock:
            f = self._folder(folder_id)
            folders = self.data["folders"]
            folders.remove(f)
            folders.insert(max(0, min(int(index), len(folders))), f)
            self._save_index()

    def delete_folder(self, folder_id):
        with self.lock:
            f = self._folder(folder_id)
            trash = self.root / TRASH
            trash.mkdir(exist_ok=True)
            stamp = datetime.datetime.now().strftime("%Y-%m-%d %H.%M.%S")
            shutil.move(str(self.root / f["dir"]), str(trash / self._unique(trash, f"{f['dir']} ({stamp})")))
            self.data["folders"].remove(f)
            self._save_index()

    # ---------- pages ----------
    def _add_page(self, f, title, index=None):
        t = now()
        name = self._unique(self.root / f["dir"], safe_name(title), ".txt")
        p = {"id": _new_id("p"), "title": str(title or "Untitled").strip()[:120] or "Untitled",
             "file": name, "created": t, "updated": t}
        _write_atomic(self.root / f["dir"] / name, "")
        f["pages"].insert(len(f["pages"]) if index is None else max(0, min(index, len(f["pages"]))), p)
        return p

    def create_page(self, folder_id, title="Untitled", index=None):
        with self.lock:
            f = self._folder(folder_id)
            p = self._add_page(f, title, index)
            f["open"] = True
            self._save_index()
            return p["id"]

    def read_page(self, page_id):
        with self.lock:
            f, p = self._page(page_id)
            try:
                with open(self._file(f, p), "r", encoding="utf-8-sig", newline="") as fh:
                    return fh.read()
            except UnicodeDecodeError:
                return self._file(f, p).read_text(encoding="cp1252", errors="replace")

    def save_page(self, page_id, text):
        with self.lock:
            f, p = self._page(page_id)
            _write_atomic(self._file(f, p), str(text))
            p["updated"] = now()
            self._save_index()
            return p["updated"]

    def rename_page(self, page_id, title):
        with self.lock:
            f, p = self._page(page_id)
            title = str(title or "").strip()[:120] or "Untitled"
            ext = Path(p["file"]).suffix or ".txt"
            new = self._unique(self.root / f["dir"], safe_name(title), ext, taken_ok=p["file"])
            if new != p["file"]:
                if new.lower() == p["file"].lower():
                    tmp = self.root / f["dir"] / (p["file"] + "." + uuid.uuid4().hex[:6])
                    os.replace(self._file(f, p), tmp)
                    os.replace(tmp, self.root / f["dir"] / new)
                else:
                    os.replace(self._file(f, p), self.root / f["dir"] / new)
                p["file"] = new
            p["title"] = title
            self._save_index()
            return title

    def move_page(self, page_id, folder_id, index):
        with self.lock:
            src, p = self._page(page_id)
            dst = self._folder(folder_id)
            if dst is not src:
                ext = Path(p["file"]).suffix or ".txt"
                new = self._unique(self.root / dst["dir"], Path(p["file"]).stem, ext)
                shutil.move(str(self._file(src, p)), str(self.root / dst["dir"] / new))
                p["file"] = new
            src["pages"].remove(p)
            dst["pages"].insert(max(0, min(int(index), len(dst["pages"]))), p)
            self._save_index()

    def delete_page(self, page_id):
        with self.lock:
            f, p = self._page(page_id)
            trash = self.root / TRASH
            trash.mkdir(exist_ok=True)
            stem, ext = Path(p["file"]).stem, Path(p["file"]).suffix
            shutil.move(str(self._file(f, p)), str(trash / self._unique(trash, f"{f['dir']} - {stem}", ext)))
            f["pages"].remove(p)
            self._save_index()

    def search(self, query):
        """Ids of the pages whose title or text contains every word of the query."""
        words = [w for w in str(query or "").lower().split() if w]
        if not words:
            return []
        hits = []
        with self.lock:
            for f in self.data["folders"]:
                for p in f["pages"]:
                    try:
                        text = self._file(f, p).read_text(encoding="utf-8-sig", errors="replace")
                    except OSError:
                        text = ""
                    hay = (p["title"] + "\n" + text).lower()
                    if all(w in hay for w in words):
                        hits.append(p["id"])
        return hits


WELCOME = """Welcome to NiSH Notes!

Everything you write here is saved automatically.

On the right you have your folders:
  – Click a folder to open or close it.
  – Drag pages to sort them, or drop them on another folder.
  – Drag a folder by its name to move it up or down.
  – Right-click a folder or a page to rename, recolour or delete it.

Shortcuts: Ctrl+N new page · Ctrl+Shift+N new folder · Ctrl+F search

Your pages are ordinary .txt files, so you can also open them in any editor.
"""
