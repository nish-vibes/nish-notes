"""The window without the Windows title bar (three dots, like on a Mac, are drawn by the page).

The caption is removed but the sizing frame is kept, so Windows still resizes the window from
its edges, snaps it to the sides of the screen and minimizes and maximizes it with its usual
animations. Dragging the desk around the page moves the window: the page asks for it and
Windows runs its own move loop (so Aero Snap and Win+arrow keys keep working).

Everything here runs on the window's own thread (through Form.Invoke). If anything fails, the
window keeps its normal Windows frame and the page shows no dots.
"""
import os

GWL_STYLE = -16
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_SYSMENU = 0x00080000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER, SWP_NOMOVE, SWP_NOSIZE = 0x20, 0x10, 0x4, 0x2, 0x1
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE


def _user32():
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    u.GetWindowLongW.restype = ctypes.c_long
    u.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    u.SetWindowLongW.restype = ctypes.c_long
    u.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
    u.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    u.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    u.IsZoomed.argtypes = [wintypes.HWND]
    return u


def on_ui(window, fn):
    """Run fn on the window's thread and return its result."""
    form = window.native
    if form is None:
        raise RuntimeError("the window is not ready")
    from System import Func, Object
    box = {}

    def run():
        box["r"] = fn(form, int(form.Handle.ToInt64()))
        return None
    if form.InvokeRequired:
        form.Invoke(Func[Object](run))
    else:
        run()
    return box.get("r")


def _set_style(hwnd, caption):
    u = _user32()
    style = u.GetWindowLongW(hwnd, GWL_STYLE) & 0xFFFFFFFF
    keep = WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME
    new = (style | keep | WS_CAPTION) if caption else ((style & ~WS_CAPTION) | keep)
    if new != style:
        if new >= 0x80000000:
            new -= 0x100000000
        u.SetWindowLongW(hwnd, GWL_STYLE, new)
        u.SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE)
    try:   # Windows 11: no thin coloured line around the window
        import ctypes
        color = ctypes.c_uint(0xFFFFFFFF if caption else DWMWA_COLOR_NONE)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ctypes.byref(color), 4)
    except Exception:
        pass
    return not (u.GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION) if not caption else True


def set_caption(window, caption):
    """caption=False hides the Windows title bar. Returns True when the window looks as asked."""
    if os.name != "nt":
        return False
    return bool(on_ui(window, lambda form, hwnd: _set_style(hwnd, caption)))


def has_caption(window):
    if os.name != "nt":
        return True
    return bool(on_ui(window, lambda form, hwnd: _user32().GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION))


def start_move(window):
    """Called while the mouse button is down on the desk: Windows moves the window from here."""
    def run(form, hwnd):
        u = _user32()
        u.ReleaseCapture()
        u.PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)
    if os.name == "nt":
        on_ui(window, run)


def is_maximized(window):
    if os.name != "nt":
        return False
    return bool(on_ui(window, lambda form, hwnd: _user32().IsZoomed(hwnd)))


_mic_handler = None


def allow_microphone(window):
    """Voice memos: let the page use the microphone without WebView2 asking every time.
    Only the microphone is allowed; every other permission keeps WebView2's own answer."""
    global _mic_handler
    if os.name != "nt" or _mic_handler is not None:
        return False

    def run(form, hwnd):
        global _mic_handler
        from Microsoft.Web.WebView2.Core import CoreWebView2PermissionKind, CoreWebView2PermissionState
        core = form.browser.webview.CoreWebView2

        def on_permission(sender, args):
            if args.PermissionKind == CoreWebView2PermissionKind.Microphone:
                args.State = CoreWebView2PermissionState.Allow
        _mic_handler = on_permission
        core.PermissionRequested += on_permission
        return True
    try:
        return bool(on_ui(window, run))
    except Exception:
        return False


# ---------- filling the screen without covering the taskbar ----------
# Without a title bar, Windows would maximize the window over the whole monitor, taskbar
# included. Answering WM_GETMINMAXINFO with the monitor's work area keeps the taskbar visible
# (also for Win+Up and dragging the window to the top edge).
WM_GETMINMAXINFO = 0x0024
_subclass_proc = None


def keep_taskbar(window):
    global _subclass_proc
    if os.name != "nt" or _subclass_proc is not None:
        return _subclass_proc is not None
    import ctypes
    from ctypes import wintypes

    class POINT(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

    class MINMAXINFO(ctypes.Structure):
        _fields_ = [("ptReserved", POINT), ("ptMaxSize", POINT), ("ptMaxPosition", POINT),
                    ("ptMinTrackSize", POINT), ("ptMaxTrackSize", POINT)]

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    user32, comctl = ctypes.windll.user32, ctypes.windll.comctl32
    LRESULT = ctypes.c_ssize_t
    SUBCLASSPROC = ctypes.WINFUNCTYPE(LRESULT, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                      ctypes.c_size_t, ctypes.c_size_t)
    comctl.DefSubclassProc.restype = LRESULT
    comctl.DefSubclassProc.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    comctl.SetWindowSubclass.argtypes = [wintypes.HWND, SUBCLASSPROC, ctypes.c_size_t, ctypes.c_size_t]
    user32.MonitorFromWindow.restype = wintypes.HMONITOR
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]

    def proc(hwnd, msg, wparam, lparam, uid, ref):
        result = comctl.DefSubclassProc(hwnd, msg, wparam, lparam)   # WinForms sets the smallest size first
        if msg == WM_GETMINMAXINFO and lparam:
            try:
                if user32.GetWindowLongW(hwnd, GWL_STYLE) & WS_CAPTION:
                    return result                                    # the normal title bar: Windows knows best
                mi = MONITORINFO()
                mi.cbSize = ctypes.sizeof(MONITORINFO)
                if user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(mi)):
                    border = user32.GetSystemMetrics(32) + user32.GetSystemMetrics(92)   # sizing frame + padding
                    w, m = mi.rcWork, mi.rcMonitor
                    info = MINMAXINFO.from_address(lparam)
                    info.ptMaxPosition.x = w.left - m.left - border
                    info.ptMaxPosition.y = w.top - m.top
                    info.ptMaxSize.x = (w.right - w.left) + 2 * border
                    info.ptMaxSize.y = (w.bottom - w.top) + border
            except Exception:
                pass
        return result

    def run(form, hwnd):
        global _subclass_proc
        cb = SUBCLASSPROC(proc)
        if comctl.SetWindowSubclass(hwnd, cb, 0x4E4E, 0):
            _subclass_proc = cb                                  # keep it alive as long as the window
            return True
        return False
    try:
        return bool(on_ui(window, run))
    except Exception:
        return False


def taskbar_visible(window):
    """For the smoke test: when the window fills the screen, its bottom stays above the taskbar."""
    if os.name != "nt":
        return True
    import ctypes
    from ctypes import wintypes

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

    def run(form, hwnd):
        user32 = ctypes.windll.user32
        user32.MonitorFromWindow.restype = wintypes.HMONITOR
        user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
        user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFO)]
        mi = MONITORINFO(); mi.cbSize = ctypes.sizeof(MONITORINFO)
        user32.GetMonitorInfoW(user32.MonitorFromWindow(hwnd, 2), ctypes.byref(mi))
        rc = wintypes.RECT(); user32.GetClientRect(hwnd, ctypes.byref(rc))
        pt = wintypes.POINT(0, rc.bottom); user32.ClientToScreen(hwnd, ctypes.byref(pt))
        return pt.y <= mi.rcWork.bottom
    return bool(on_ui(window, run))
