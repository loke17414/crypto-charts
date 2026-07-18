"""Encrypt/decrypt secrets with Fernet (MASTER_ENCRYPTION_KEY)."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv

from bot.config import ROOT
from bot.platform_config import master_encryption_key

logger = logging.getLogger(__name__)
ENV_PATH = ROOT / ".env"
_fernet: Fernet | None = None


def _persist_master_key(key: str) -> None:
    lines: list[str] = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    updated: list[str] = []
    found = False
    for line in lines:
        if line.startswith("MASTER_ENCRYPTION_KEY="):
            updated.append(f'MASTER_ENCRYPTION_KEY="{key}"')
            found = True
        else:
            updated.append(line)
    if not found:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append(f'MASTER_ENCRYPTION_KEY="{key}"')
    ENV_PATH.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    load_dotenv(ENV_PATH, override=True)
    os.environ["MASTER_ENCRYPTION_KEY"] = key
    logger.info("MASTER_ENCRYPTION_KEY saved to .env")


def ensure_master_key() -> str:
    key = master_encryption_key()
    if key:
        return key
    generated = Fernet.generate_key().decode("utf-8")
    _persist_master_key(generated)
    return generated


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is not None:
        return _fernet
    key = ensure_master_key()
    try:
        _fernet = Fernet(key.encode("utf-8") if isinstance(key, str) else key)
    except Exception as exc:
        raise ValueError(
            "MASTER_ENCRYPTION_KEY가 유효한 Fernet 키가 아닙니다. "
            'python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" '
            "로 다시 생성하세요."
        ) from exc
    return _fernet


def encrypt_secret(plain: str) -> str:
    return _get_fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str:
    try:
        return _get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("저장된 키를 복호화할 수 없습니다. MASTER_ENCRYPTION_KEY가 바뀌었을 수 있습니다.") from exc


def vault_ready() -> bool:
    try:
        ensure_master_key()
        _get_fernet()
        return True
    except Exception:
        return False
