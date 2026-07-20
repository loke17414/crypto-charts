"""Per-user OpenAI API keys stored encrypted in the DB."""

from __future__ import annotations

from sqlalchemy.orm import Session

from bot.crypto_vault import decrypt_secret, encrypt_secret
from bot.models import OpenAiCredential


def has_openai_key(db: Session, user_id: int) -> bool:
    return (
        db.query(OpenAiCredential.id)
        .filter(OpenAiCredential.user_id == user_id)
        .first()
        is not None
    )


def save_openai_key(db: Session, user_id: int, api_key: str) -> OpenAiCredential:
    key = api_key.strip()
    if not key:
        raise ValueError("OpenAI API Key가 비어 있습니다.")
    enc = encrypt_secret(key)
    row = db.query(OpenAiCredential).filter(OpenAiCredential.user_id == user_id).one_or_none()
    if row:
        row.api_key_encrypted = enc
    else:
        row = OpenAiCredential(user_id=user_id, api_key_encrypted=enc)
        db.add(row)
    db.commit()
    db.refresh(row)
    return row


def load_openai_key(db: Session, user_id: int) -> str | None:
    row = db.query(OpenAiCredential).filter(OpenAiCredential.user_id == user_id).one_or_none()
    if not row:
        return None
    return decrypt_secret(row.api_key_encrypted)


def delete_openai_key(db: Session, user_id: int) -> bool:
    row = db.query(OpenAiCredential).filter(OpenAiCredential.user_id == user_id).one_or_none()
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True
