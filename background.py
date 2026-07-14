"""Background trading bot — no browser, no web UI. Reads settings from .env."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def ensure_single_instance() -> None:
    lock_path = app_dir() / "bot.lock"
    if lock_path.exists():
        try:
            old_pid = int(lock_path.read_text(encoding="utf-8").strip())
        except ValueError:
            old_pid = 0
        if old_pid > 0:
            try:
                os.kill(old_pid, 0)
            except OSError:
                pass
            else:
                print(f"  [오류] 봇이 이미 실행 중입니다 (PID {old_pid}).")
                print(f"  종료: stop-background.ps1 또는 작업 관리자에서 CryptoChartsBot 종료")
                raise SystemExit(1)
    lock_path.write_text(str(os.getpid()), encoding="utf-8")


def remove_lock() -> None:
    lock_path = app_dir() / "bot.lock"
    if lock_path.exists():
        try:
            if int(lock_path.read_text(encoding="utf-8").strip()) == os.getpid():
                lock_path.unlink(missing_ok=True)
        except ValueError:
            lock_path.unlink(missing_ok=True)


def main() -> None:
    os.chdir(app_dir())
    ensure_single_instance()
    try:
        from bot.bot import main as run_bot

        run_bot()
    finally:
        remove_lock()


if __name__ == "__main__":
    main()
