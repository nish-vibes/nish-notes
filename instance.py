"""One NiSH Notes at a time.

The running app listens on a local socket (127.0.0.1 only). Starting NiSH Notes again, for example
by double-clicking the .exe while the window is hidden in the tray, asks the running app to show its
window and then quits, so two copies never write to the same notebook.
"""
import socket
import threading

import settings

PORT_FILE = settings.data_dir() / "instance.port"
MAGIC = b"NISHNOTES1 SHOW\n"


def hand_off(timeout=2.0):
    """Ask a running NiSH Notes to show its window. True if one answered."""
    try:
        port = int(PORT_FILE.read_text().strip())
    except Exception:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
            s.sendall(MAGIC)
            s.shutdown(socket.SHUT_WR)
            return s.recv(16) == b"OK"
    except OSError:
        return False


def serve(on_show):
    """Listen for later starts of the app. on_show() is called from a worker thread."""
    try:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(4)
        PORT_FILE.parent.mkdir(parents=True, exist_ok=True)
        PORT_FILE.write_text(str(srv.getsockname()[1]))
    except OSError:
        return None

    def loop():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            with conn:
                try:
                    conn.settimeout(3)
                    if conn.recv(64).startswith(MAGIC):
                        conn.sendall(b"OK")
                        on_show()
                except Exception:
                    pass

    threading.Thread(target=loop, daemon=True).start()
    return srv


def stop(srv):
    try:
        if srv is not None:
            if PORT_FILE.exists() and PORT_FILE.read_text().strip() == str(srv.getsockname()[1]):
                PORT_FILE.unlink()
            srv.close()
    except OSError:
        pass
