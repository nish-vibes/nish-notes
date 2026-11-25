"""Remove the "downloaded from the internet" mark from the app's own files.

When the zip is unpacked with Windows Explorer, every file in it gets the mark (a hidden
Zone.Identifier stream). The .NET part that pywebview uses then refuses to load
Python.Runtime.dll ("Failed to resolve Python.Runtime.Loader.Initialize") and the app can't start.
The files belong to the user, so removing the mark needs no admin rights. This must run before
pywebview is imported.
"""
import os
import sys

STREAM = ":Zone.Identifier"


def _marked(path):
    try:
        with open(path + STREAM, "rb"):
            return True
    except OSError:
        return False


def app_files():
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return 0
    if os.environ.get("NN_NO_UNBLOCK"):                  # used by the build to show the problem
        return 0
    base = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    probe = os.path.join(base, "pythonnet", "runtime", "Python.Runtime.dll")
    if not (_marked(probe) or _marked(sys.executable)):
        return 0                                         # nothing to do: the usual, fast case
    done = 0
    for root in {os.path.dirname(sys.executable), base}:
        for folder, _dirs, files in os.walk(root):
            for name in files:
                try:
                    os.remove(os.path.join(folder, name) + STREAM)
                    done += 1
                except OSError:
                    pass
    return done
