"""CryptoCharts desktop launcher — web UI + Binance testnet API server."""

from __future__ import annotations

import http.server
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

WEB_PORT = 8765
API_PORT = 8000
LISTEN_HOST = os.environ.get("LISTEN_HOST", "127.0.0.1").strip() or "127.0.0.1"
REMOTE_MODE = LISTEN_HOST not in ("127.0.0.1", "localhost", "::1")


def app_dir() -> Path:
    """Directory next to the exe (settings, logs) or project root in dev."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resource_root() -> Path:
    """Bundled static files (PyInstaller) or project root in dev."""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


def port_available(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def port_in_use_message(port: int) -> str:
    return (
        f"  [오류] 포트 {port}이(가) 이미 사용 중입니다.\n"
        f"  start.ps1, run-server.ps1 등 다른 서버를 종료한 뒤 다시 실행하세요."
    )


def chrome_paths() -> list[Path]:
    candidates = [
        Path(os.environ.get("PROGRAMFILES", r"C:\Program Files"))
        / "Google"
        / "Chrome"
        / "Application"
        / "chrome.exe",
        Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)"))
        / "Google"
        / "Chrome"
        / "Application"
        / "chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
    ]
    return [path for path in candidates if path.is_file()]


def open_in_chrome(url: str) -> bool:
    for chrome_exe in chrome_paths():
        try:
            subprocess.Popen(
                [str(chrome_exe), "--new-window", url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            return True
        except OSError:
            continue

    try:
        webbrowser.get("chrome").open(url, new=1)
        return True
    except webbrowser.Error:
        webbrowser.open(url, new=1)
        return False


def start_api_server() -> None:
    import uvicorn

    from bot.server import app

    uvicorn.run(app, host=LISTEN_HOST, port=API_PORT, log_level="info")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        pass

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.endswith((".js", ".html", ".css")):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()


def start_web_server(root: Path, port: int) -> None:
    os.chdir(root)
    handler = QuietHandler
    httpd = http.server.ThreadingHTTPServer((LISTEN_HOST, port), handler)
    httpd.serve_forever()


def main() -> int:
    os.chdir(app_dir())
    static_root = resource_root()

    print()
    print("  CryptoCharts 시작 중...")
    print()

    if not port_available(API_PORT, LISTEN_HOST):
        print(port_in_use_message(API_PORT))
        input("  Enter 키를 누르면 종료합니다...")
        return 1

    if not port_available(WEB_PORT, LISTEN_HOST):
        print(port_in_use_message(WEB_PORT))
        input("  Enter 키를 누르면 종료합니다...")
        return 1

    api_thread = threading.Thread(target=start_api_server, name="api-server", daemon=True)
    api_thread.start()
    time.sleep(1.2)

    web_thread = threading.Thread(
        target=start_web_server,
        args=(static_root, WEB_PORT),
        name="web-server",
        daemon=True,
    )
    web_thread.start()
    time.sleep(0.3)

    host_label = LISTEN_HOST if REMOTE_MODE else "localhost"
    trading_url = f"http://{host_label}:{WEB_PORT}/trading.html"
    chart_url = f"http://{host_label}:{WEB_PORT}/index.html"
    api_url = f"http://{host_label}:{API_PORT}"

    print("  웹 UI:        ", chart_url)
    print("  자동매매:     ", trading_url)
    print("  API 서버:     ", api_url)
    if REMOTE_MODE:
        print()
        print("  [원격 모드] 브라우저에서 http://<서버IP>:8765/trading.html 로 접속하세요.")
        print("  Vultr 방화벽: TCP 8765, 8000 허용 필요. headless 봇(docker)과 동시 실행 금지.")
    print()
    if REMOTE_MODE:
        print("  종료: Ctrl+C")
    else:
        print("  브라우저(Chrome)가 자동으로 열립니다. 종료: Ctrl+C")
    print()

    if not REMOTE_MODE:
        opened = open_in_chrome(trading_url)
        if not opened:
            print("  [안내] Chrome을 찾지 못해 기본 브라우저로 엽니다.")
            webbrowser.open(trading_url)

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n  종료합니다.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
