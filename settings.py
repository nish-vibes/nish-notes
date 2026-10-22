"""Small settings kept in %LOCALAPPDATA%\\NiSH Notes\\settings.json (window size, font, last page,
where the notes live). They sit outside the app, so a new version of the .exe keeps them."""
import json
import os
import sys
from pathlib import Path

APP_NAME = "NiSH Notes"


def data_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(Path.home(), ".local", "share")
    return Path(base) / APP_NAME


FILE = data_dir() / "settings.json"


def _load():
    try:
        return json.loads(FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(data):
    try:
        FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, FILE)
    except Exception:
        pass


def get(key, default=None):
    return _load().get(key, default)


def put(key, value):
    data = _load()
    data[key] = value
    _save(data)


def app_dir():
    """The folder the .exe (or app.py) is in."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def documents():
    """The user's real Documents folder (also when Windows has moved it into OneDrive)."""
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            class GUID(ctypes.Structure):
                _fields_ = [("a", wintypes.DWORD), ("b", wintypes.WORD), ("c", wintypes.WORD),
                            ("d", ctypes.c_ubyte * 8)]
            # FOLDERID_Documents {FDD39AD0-238F-46AF-ADB4-6C85480369C7}
            fid = GUID(0xFDD39AD0, 0x238F, 0x46AF, (ctypes.c_ubyte * 8)(0xAD, 0xB4, 0x6C, 0x85, 0x48, 0x03, 0x69, 0xC7))
            out = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(out)) == 0:
                path = out.value
                ctypes.windll.ole32.CoTaskMemFree(out)
                if path and Path(path).is_dir():
                    return Path(path)
        except Exception:
            pass
    return Path.home() / "Documents"


def notes_dir():
    """Where the notebook lives.

    1. A "Notes" folder next to the .exe (portable mode, e.g. on a USB stick).
    2. A folder the user picked in the app.
    3. Documents\\NiSH Notes.
    """
    portable = app_dir() / "Notes"
    if portable.is_dir():
        return portable
    chosen = get("notes_dir")
    if chosen:
        try:
            Path(chosen).mkdir(parents=True, exist_ok=True)
            return Path(chosen)
        except OSError:
            pass
    return documents() / APP_NAME
