"""The notebook on disk.

Every folder in the menu is a real folder and every page is a small .html file inside it
(text with formatting, margin notes and drawings), so the notes open in any web browser and
can be backed up without the app. Plain .txt and .md files work too: they show up as pages
and become .html the first time they are edited. A small index file,
``_nishnotes.json``, remembers the things a file system can't: the order of folders and
pages, folder colours and which folders are open.

Folders and files that appear on disk while the app is closed are picked up on the next
start; pages whose file has disappeared are dropped from the index. Deleted pages and
folders are moved to ``_Trash`` inside the notes folder, never erased.
"""
import datetime
import html
import json
import os
import re
import shutil
import threading
import uuid
from pathlib import Path

INDEX = "_nishnotes.json"
TRASH = "_Trash"
TEXT_EXT = (".html", ".htm", ".txt", ".md")
HTML_EXT = (".html", ".htm")
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


# ---------- the page file ----------
# A page file is an ordinary web page. The app finds its parts by the comment markers, so the
# rest of the file (styles, the drawing as SVG for browsers) can change between versions.
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
_PART = {k: re.compile(r"<!--nn:%s-->(.*?)<!--/nn:%s-->" % (k, k), re.S) for k in ("text", "margin")}
_INK = re.compile(r'<script type="application/json" id="nn-ink">(.*?)</script>', re.S)
_BODY = re.compile(r"<body[^>]*>(.*)</body>", re.S | re.I)
_TAG = re.compile(r"<[^>]+>")
_BLOCK_END = re.compile(r"</(p|div|h[1-6]|li|pre|tr|td)>|<br\s*/?>", re.I)
MAX_POINTS = 20000          # per stroke
MAX_STROKES = 5000

FILE_CSS = """
body{margin:0;background:#FFFEF8;color:#22304A;font:18px/32px "Segoe Print","Kalam","Comic Sans MS",cursive}
.nn-page{position:relative;display:grid;grid-template-columns:110px minmax(0,1fr);min-height:100vh;
 background-image:repeating-linear-gradient(to bottom,transparent 0,transparent 31px,#C5D5EC 31px,#C5D5EC 32px);background-position:0 8px}
.nn-margin{padding:8px 10px 64px 12px;border-right:2px solid #E7A3A3;font-size:15px;color:#4A5568;white-space:pre-wrap;overflow-wrap:anywhere}
.nn-text{padding:8px 32px 64px 16px;white-space:pre-wrap;overflow-wrap:anywhere}
.nn-page h1,.nn-page h2,.nn-page h3,.nn-page p,.nn-page pre,.nn-page ul,.nn-page ol{margin:0;line-height:32px}
.nn-page h1{font-size:28px}.nn-page h2{font-size:24px}.nn-page h3{font-size:20px}
.nn-page pre{font:15px/32px Consolas,monospace}
.nn-page ul,.nn-page ol{padding-left:28px}
ul.dashed{list-style:none}ul.dashed>li::before{content:"\\2013";display:inline-block;width:20px;margin-left:-20px}
ul.checklist{list-style:none}ul.checklist>li::before{content:"\\25CB";display:inline-block;width:24px;margin-left:-24px}
ul.checklist>li[data-checked]::before{content:"\\25C9"}ul.checklist>li[data-checked]{color:#8a8f98}
.nn-ink{position:absolute;left:0;top:0;pointer-events:none;overflow:visible}
.nn-page table{width:100%;table-layout:fixed;border-collapse:collapse;box-shadow:inset 1px 1px 0 #8FA6C7}
.nn-page td{padding:0 8px;line-height:32px;vertical-align:top;box-shadow:inset -1px -1px 0 #8FA6C7}
@media print{.nn-page{background:none}}
"""


def clean_ink(ink):
    """Only well-formed strokes are kept: {"t": "pen"|"marker", "c": "#rrggbb", "w": width, "p": [x, y, x, y, ...]}."""
    out = []
    if not isinstance(ink, list):
        return out
    for s in ink[:MAX_STROKES]:
        try:
            t = s.get("t")
            c = str(s.get("c", ""))
            w = float(s.get("w"))
            p = [round(float(v), 1) for v in s.get("p", [])[:MAX_POINTS * 2]]
        except (AttributeError, TypeError, ValueError):
            continue
        if t in ("pen", "marker") and _HEX.match(c) and 0.5 <= w <= 80 and len(p) >= 2 and len(p) % 2 == 0 \
                and all(-1e5 < v < 1e6 for v in p):
            out.append({"t": t, "c": c, "w": round(w, 1), "p": p})
    return out


def _svg(ink):
    if not ink:
        return ""
    xs = [v for s in ink for v in s["p"][0::2]]
    ys = [v for s in ink for v in s["p"][1::2]]
    w, h = max(xs) + 40, max(ys) + 40
    paths = []
    for s in ink:
        p = s["p"]
        d = "M%s %s" % (p[0], p[1]) + "".join(" L%s %s" % (p[i], p[i + 1]) for i in range(2, len(p), 2))
        if len(p) == 2:
            d += " l0.1 0"
        extra = ' opacity="0.35" style="mix-blend-mode:multiply"' if s["t"] == "marker" else ""
        paths.append('<path d="%s" stroke="%s" stroke-width="%s"%s/>' % (d, s["c"], s["w"], extra))
    return ('<svg class="nn-ink" width="%d" height="%d" fill="none" stroke-linecap="round" stroke-linejoin="round" '
            'xmlns="http://www.w3.org/2000/svg">%s</svg>' % (w, h, "".join(paths)))


def _part(s):
    """The app's sanitizer already removed comments; make sure no marker can end a part early."""
    return str(s or "").replace("<!--", "&lt;!--")


def render_page(title, text, margin, ink):
    ink = clean_ink(ink)
    data = json.dumps(ink, separators=(",", ":")).replace("</", "<\\/")
    return ("<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"generator\" content=\"NiSH Notes\">\n"
            "<title>%s</title>\n<style>%s</style>\n</head>\n<body>\n<div class=\"nn-page\">\n"
            "<aside class=\"nn-margin\"><!--nn:margin-->%s<!--/nn:margin--></aside>\n"
            "<article class=\"nn-text\"><!--nn:text-->%s<!--/nn:text--></article>\n%s\n</div>\n"
            "<script type=\"application/json\" id=\"nn-ink\">%s</script>\n</body>\n</html>\n"
            % (html.escape(str(title or "")), FILE_CSS, _part(margin), _part(text), _svg(ink), data))


def text_to_html(text):
    """Plain text (an old .txt page) as the editor's lines."""
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text:
        return ""
    return "".join("<div>%s</div>" % (html.escape(line, quote=False) or "<br>") for line in text.split("\n"))


def parse_page(raw, suffix):
    """{"text", "margin", "ink"} from a page file. The page sanitizes text and margin again before showing them."""
    if suffix.lower() not in HTML_EXT:
        return {"text": text_to_html(raw), "margin": "", "ink": []}
    parts = {}
    for k, rx in _PART.items():
        m = rx.search(raw)
        parts[k] = m.group(1) if m else ""
    if not _PART["text"].search(raw):          # a web page made by something else
        m = _BODY.search(raw)
        parts["text"] = m.group(1) if m else raw
    ink = []
    m = _INK.search(raw)
    if m:
        try:
            ink = clean_ink(json.loads(m.group(1)))
        except ValueError:
            ink = []
    return {"text": parts["text"], "margin": parts["margin"], "ink": ink}


def plain_text(fragment):
    """Readable text from an html fragment (for search)."""
    s = _BLOCK_END.sub("\n", str(fragment or ""))
    return html.unescape(_TAG.sub("", s))


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
                _write_atomic(self._file(f, p), render_page(p["title"], WELCOME, WELCOME_MARGIN, []))
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
        name = self._unique(self.root / f["dir"], safe_name(title), ".html")
        p = {"id": _new_id("p"), "title": str(title or "Untitled").strip()[:120] or "Untitled",
             "file": name, "created": t, "updated": t}
        _write_atomic(self.root / f["dir"] / name, render_page(p["title"], "", "", []))
        f["pages"].insert(len(f["pages"]) if index is None else max(0, min(index, len(f["pages"]))), p)
        return p

    def create_page(self, folder_id, title="Untitled", index=None):
        with self.lock:
            f = self._folder(folder_id)
            p = self._add_page(f, title, index)
            f["open"] = True
            self._save_index()
            return p["id"]

    def _raw(self, f, p):
        try:
            with open(self._file(f, p), "r", encoding="utf-8-sig", newline="") as fh:
                return fh.read()
        except UnicodeDecodeError:
            return self._file(f, p).read_text(encoding="cp1252", errors="replace")

    def read_page(self, page_id):
        """{"text": html, "margin": html, "ink": [strokes]}"""
        with self.lock:
            f, p = self._page(page_id)
            return parse_page(self._raw(f, p), Path(p["file"]).suffix)

    def save_page(self, page_id, doc):
        """doc = {"text": html, "margin": html, "ink": [strokes]}. A .txt or .md page becomes .html."""
        if isinstance(doc, str):
            doc = {"text": text_to_html(doc)}
        with self.lock:
            f, p = self._page(page_id)
            old = self._file(f, p)
            if old.suffix.lower() != ".html":
                p["file"] = self._unique(self.root / f["dir"], old.stem, ".html")
            _write_atomic(self._file(f, p), render_page(p["title"], doc.get("text"), doc.get("margin"), doc.get("ink")))
            if self._file(f, p) != old:
                try:
                    old.unlink()
                except OSError:
                    pass
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
                        doc = parse_page(self._raw(f, p), Path(p["file"]).suffix)
                        text = plain_text(doc["text"]) + "\n" + plain_text(doc["margin"])
                    except OSError:
                        text = ""
                    hay = (p["title"] + "\n" + text).lower()
                    if all(w in hay for w in words):
                        hits.append(p["id"])
        return hits


WELCOME = (
    "<h1>Welcome to NiSH Notes!</h1>"
    "<div>Everything you write is saved by itself.</div><div><br></div>"
    "<h3>Writing</h3>"
    "<ul><li>Click <b>Aa</b> at the top for titles, headings, <b>bold</b>, <i>italic</i>, "
    "<u>underline</u>, <s>strikethrough</s> and lists.</li>"
    "<li>The checklist button makes a to-do list. Click a circle to tick it off.</li>"
    "<li>Write in the narrow column left of the red line for margin notes.</li>"
    "<li><b>Scribble</b> lets you draw on the page with a pen, a marker and an eraser.</li></ul>"
    "<div><br></div><h3>Sorting</h3>"
    "<ul class=\"dashed\"><li>Hover over a folder or page and drag its handle to move it.</li>"
    "<li>Drop a page on a folder to move it there.</li>"
    "<li>Right-click a folder or page to rename, recolour or delete it.</li></ul>"
    "<div><br></div><h3>Try it</h3>"
    "<ul class=\"checklist\"><li data-checked=\"\">Open NiSH Notes</li><li>Make a folder</li><li>Write your first page</li></ul>"
)
WELCOME_MARGIN = "<div>Start</div><div>here</div>"
