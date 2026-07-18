"""Per-user Binance API credentials stored encrypted in the DB."""

from __future__ import annotations

from sqlalchemy.orm import Session

from bot.crypto_vault import decrypt_secret, encrypt_secret
from bot.models import ExchangeCredential


def has_credentials(db: Session, user_id: int) -> bool:
    return (
        db.query(ExchangeCredential.id)
        .filter(ExchangeCredential.user_id == user_id)
        .first()
        is not None
    )


def save_credentials(
    db: Session,
    user_id: int,
    api_key: str,
    api_secret: str,
    *,
    use_testnet: bool = True,
) -> ExchangeCredential:
    key = api_key.strip()
    secret = api_secret.strip()
    if not key or not secret:
        raise ValueError("API Key와 Secret이 비어 있습니다.")

    row = db.query(ExchangeCredential).filter(ExchangeCredential.user_id == user_id).one_or_none()
    enc_key = encrypt_secret(key)
    enc_secret = encrypt_secret(secret)
    if row:
        row.api_key_encrypted = enc_key
        row.api_secret_encrypted = enc_secret
        row.use_testnet = use_testnet
    else:
        row = ExchangeCredential(
            user_id=user_id,
            api_key_encrypted=enc_key,
            api_secret_encrypted=enc_secret,
            use_testnet=use_testnet,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return row


def load_credentials(db: Session, user_id: int) -> tuple[str, str, bool] | None:
    row = db.query(ExchangeCredential).filter(ExchangeCredential.user_id == user_id).one_or_none()
    if not row:
        return None
    return (
        decrypt_secret(row.api_key_encrypted),
        decrypt_secret(row.api_secret_encrypted),
        bool(row.use_testnet),
    )


def delete_credentials(db: Session, user_id: int) -> bool:
    row = db.query(ExchangeCredential).filter(ExchangeCredential.user_id == user_id).one_or_none()
    if not row:
        return False
    db.delete(row)
    db.commit()
    return True
