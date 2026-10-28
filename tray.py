"""The notification-area (tray) icon, shown while "Keep running when closed" is on.

Click the icon to open NiSH Notes; right-click for Open, the setting itself, and Quit.
"""
import threading


class Tray:
    def __init__(self, icon_path, on_open, on_quit, on_toggle, is_on):
        self.icon_path = icon_path
        self.on_open, self.on_quit, self.on_toggle, self.is_on = on_open, on_quit, on_toggle, is_on
        self.icon = None
        self.lock = threading.Lock()

    def start(self):
        with self.lock:
            if self.icon is not None:
                return True
            try:
                import pystray
                from PIL import Image
                image = Image.open(self.icon_path)
                menu = pystray.Menu(
                    pystray.MenuItem("Open NiSH Notes", lambda *a: self.on_open(), default=True),
                    pystray.MenuItem("Keep running when closed", lambda *a: self.on_toggle(),
                                     checked=lambda item: self.is_on()),
                    pystray.Menu.SEPARATOR,
                    pystray.MenuItem("Quit NiSH Notes", lambda *a: self.on_quit()),
                )
                self.icon = pystray.Icon("NiSH Notes", image, "NiSH Notes", menu)
                self.icon.run_detached()
                return True
            except Exception:
                self.icon = None
                return False

    def stop(self):
        with self.lock:
            icon, self.icon = self.icon, None
        if icon is not None:
            try:
                icon.stop()
            except Exception:
                pass

    def notify(self, text):
        try:
            if self.icon is not None and getattr(self.icon, "HAS_NOTIFICATION", False):
                self.icon.notify(text, "NiSH Notes")
        except Exception:
            pass

    def refresh(self):
        try:
            if self.icon is not None:
                self.icon.update_menu()
        except Exception:
            pass

    @property
    def running(self):
        return self.icon is not None
