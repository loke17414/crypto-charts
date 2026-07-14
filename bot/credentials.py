"""Persist Binance API credentials in .env for server-side auto-connect."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

from bot.config import ROOT

ENV_PATH = ROOT / ".env"


def _reload_env() -> None:
    load_dotenv(ENV_PATH, override=True)


def persist_binance_credentials(api_key: str, api_secret: str) -> Path:
    key = api_key.strip()
    secret = api_secret.strip()
    if not key or not secret:
        raise ValueError("API Key와 Secret이 비어 있습니다.")

    lines: list[str] = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()

    updated: list[str] = []
    found_key = False
    found_secret = False
    for line in lines:
        if line.startswith("BINANCE_API_KEY="):
            updated.append(f'BINANCE_API_KEY="{key}"')
            found_key = True
        elif line.startswith("BINANCE_API_SECRET="):
            updated.append(f'BINANCE_API_SECRET="{secret}"')
            found_secret = True
        else:
            updated.append(line)

    if not found_key:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append(f'BINANCE_API_KEY="{key}"')
    if not found_secret:
        updated.append(f'BINANCE_API_SECRET="{secret}"')
    if not any(line.startswith("BINANCE_TESTNET=") for line in updated):
        updated.append("BINANCE_TESTNET=true")

    ENV_PATH.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    _reload_env()
    os.environ["BINANCE_API_KEY"] = key
    os.environ["BINANCE_API_SECRET"] = secret
    return ENV_PATH


def clear_binance_credentials() -> None:
    if not ENV_PATH.exists():
        return

    lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    updated = [
        line
        for line in lines
        if not line.startswith("BINANCE_API_KEY=") and not line.startswith("BINANCE_API_SECRET=")
    ]
    ENV_PATH.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    _reload_env()
    os.environ.pop("BINANCE_API_KEY", None)
    os.environ.pop("BINANCE_API_SECRET", None)


def credentials_configured() -> bool:
    _reload_env()
    key = os.getenv("BINANCE_API_KEY", "").strip().strip('"').strip("'")
    secret = os.getenv("BINANCE_API_SECRET", "").strip().strip('"').strip("'")
    return bool(key and secret)


def load_binance_credentials() -> tuple[str, str] | None:
    _reload_env()
    key = os.getenv("BINANCE_API_KEY", "").strip().strip('"').strip("'")
    secret = os.getenv("BINANCE_API_SECRET", "").strip().strip('"').strip("'")
    if not key or not secret:
        return None
    return key, secret
