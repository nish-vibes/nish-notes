# PyInstaller build recipe. Run on Windows:  pyinstaller NiSHNotes.spec --noconfirm
# Builds one portable file, dist\NiSHNotes.exe. The GitHub workflow downloads the Kalam
# handwriting font into web/fonts first.
from PyInstaller.utils.hooks import collect_all

datas = [("web", "web"), ("VERSION", "."), ("assets/icon.ico", "assets")]
binaries, hiddenimports = [], ["store", "settings", "instance", "tray", "pystray._win32", "PIL.Image"]
# pywebview and the .NET bridge it uses to host Edge WebView2
for pkg in ("webview", "clr_loader", "pythonnet", "clr", "proxy_tools", "bottle", "pystray"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        pass

a = Analysis(
    ["app.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "numpy", "IPython", "pytest", "PyQt5", "PyQt6", "PySide2", "PySide6", "gi"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="NiSHNotes",
    console=False,
    icon="assets/icon.ico",
    upx=False,
    runtime_tmpdir=None,
)
