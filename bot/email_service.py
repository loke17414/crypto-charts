"""Transactional email via SMTP (optional). When unset, verification is auto-skipped in dev."""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from typing import Any

from bot.platform_config import app_origin, smtp_configured, smtp_profiles

logger = logging.getLogger(__name__)

__all__ = [
    "send_email",
    "send_reset_email",
    "send_verify_email",
    "smtp_configured",
]


def _origin() -> str:
    origin = app_origin().rstrip("/")
    if origin == "*" or not origin.startswith("http"):
        return "http://127.0.0.1:8765"
    return origin


def _header_and_envelope(from_email: str, user: str) -> tuple[str, str]:
    """
    Return (From header, envelope MAIL FROM).
    Bare address is safer for Naver/Gmail; display name is optional.
    """
    name, addr = parseaddr((from_email or "").strip())
    if not addr or "@" not in addr:
        addr = (user or "").strip()
    if not addr or "@" not in addr:
        # last resort: raw string if it looks like an email
        raw = (from_email or user or "").strip()
        if "@" in raw and "<" not in raw:
            addr = raw
            name = ""
        else:
            raise ValueError("SMTP From 주소가 올바르지 않습니다. SMTP_FROM 또는 SMTP_USER에 이메일을 넣으세요.")
    header = formataddr((name or "Orbinex", addr)) if name else addr
    return header, addr


def _smtp_connect_and_send(
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    use_tls: bool,
    msg: EmailMessage,
    envelope_from: str,
) -> None:
    if use_tls:
        context = ssl.create_default_context()
        with smtplib.SMTP(host, port, timeout=30) as server:
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
            if user:
                server.login(user, password)
            server.send_message(msg, from_addr=envelope_from)
    else:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, timeout=30, context=context) as server:
            if user:
                server.login(user, password)
            server.send_message(msg, from_addr=envelope_from)


def _send_via_profile(profile: dict[str, Any], msg: EmailMessage) -> None:
    host = str(profile["host"])
    port = int(profile["port"])
    user = str(profile.get("user") or "")
    password = str(profile.get("password") or "")
    use_tls = bool(profile.get("use_tls", True))
    header_from, envelope_from = _header_and_envelope(str(profile.get("from_email") or ""), user)
    if "From" in msg:
        msg.replace_header("From", header_from)
    else:
        msg["From"] = header_from

    attempts: list[tuple[int, bool]] = [(port, use_tls)]
    # Common provider fallback: 587 STARTTLS failed → 465 SSL
    host_l = host.lower()
    if use_tls and port == 587 and ("naver.com" in host_l or "gmail.com" in host_l):
        attempts.append((465, False))

    last_exc: Exception | None = None
    for try_port, try_tls in attempts:
        try:
            _smtp_connect_and_send(
                host=host,
                port=try_port,
                user=user,
                password=password,
                use_tls=try_tls,
                msg=msg,
                envelope_from=envelope_from,
            )
            return
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "SMTP attempt failed %s:%s tls=%s — %s",
                host,
                try_port,
                try_tls,
                exc,
            )
    assert last_exc is not None
    raise last_exc


def send_email(*, to: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
    profiles = smtp_profiles()
    if not profiles:
        logger.warning("SMTP not configured — email to %s skipped (%s)", to, subject)
        return False

    last_exc: Exception | None = None
    for profile in profiles:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["To"] = to
        msg.set_content(text_body)
        if html_body:
            msg.add_alternative(html_body, subtype="html")
        try:
            _send_via_profile(profile, msg)
            logger.info(
                "Email sent to %s (%s) via %s/%s",
                to,
                subject,
                profile.get("name"),
                profile.get("host"),
            )
            return True
        except Exception as exc:
            last_exc = exc
            logger.exception(
                "SMTP %s (%s) failed for %s — trying next if any",
                profile.get("name"),
                profile.get("host"),
                to,
            )

    if last_exc:
        raise last_exc
    return False


def send_verify_email(to: str, token: str) -> bool:
    link = f"{_origin()}/verify.html?token={token}"
    subject = "[Orbinex] 이메일 인증"
    text = (
        "Orbinex 가입을 환영합니다.\n\n"
        f"아래 링크를 열어 이메일을 인증해 주세요 (24시간 유효):\n{link}\n\n"
        "본인이 요청하지 않았다면 이 메일을 무시하세요.\n"
    )
    html = (
        "<p>Orbinex 가입을 환영합니다.</p>"
        f'<p><a href="{link}">이메일 인증하기</a></p>'
        f"<p>링크가 열리지 않으면 아래 주소를 복사해 브라우저에 붙여넣으세요:<br>"
        f"<code>{link}</code></p>"
        "<p>링크는 24시간 동안 유효합니다.</p>"
    )
    return send_email(to=to, subject=subject, text_body=text, html_body=html)


def send_reset_email(to: str, token: str) -> bool:
    link = f"{_origin()}/reset-password.html?token={token}"
    subject = "[Orbinex] 비밀번호 재설정"
    text = (
        "비밀번호 재설정을 요청하셨습니다.\n\n"
        f"아래 링크에서 새 비밀번호를 설정하세요 (1시간 유효):\n{link}\n\n"
        "본인이 요청하지 않았다면 이 메일을 무시하세요.\n"
    )
    html = (
        "<p>비밀번호 재설정을 요청하셨습니다.</p>"
        f'<p><a href="{link}">새 비밀번호 설정</a></p>'
        f"<p>링크가 열리지 않으면:<br><code>{link}</code></p>"
        "<p>링크는 1시간 동안 유효합니다.</p>"
    )
    return send_email(to=to, subject=subject, text_body=text, html_body=html)
