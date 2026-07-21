"""Transactional email via SMTP (optional). When unset, verification is auto-skipped in dev."""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage

from bot.platform_config import (
    app_origin,
    smtp_from_email,
    smtp_host,
    smtp_password,
    smtp_port,
    smtp_user,
    smtp_use_tls,
)

logger = logging.getLogger(__name__)


def smtp_configured() -> bool:
    return bool(smtp_host() and smtp_from_email())


def _origin() -> str:
    origin = app_origin().rstrip("/")
    if origin == "*" or not origin.startswith("http"):
        return "http://127.0.0.1:8765"
    return origin


def send_email(*, to: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
    if not smtp_configured():
        logger.warning("SMTP not configured — email to %s skipped (%s)", to, subject)
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = smtp_from_email()
    msg["To"] = to
    msg.set_content(text_body)
    if html_body:
        msg.add_alternative(html_body, subtype="html")

    host = smtp_host()
    port = smtp_port()
    user = smtp_user()
    password = smtp_password()
    try:
        if smtp_use_tls():
            context = ssl.create_default_context()
            with smtplib.SMTP(host, port, timeout=30) as server:
                server.starttls(context=context)
                if user:
                    server.login(user, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP_SSL(host, port, timeout=30) as server:
                if user:
                    server.login(user, password)
                server.send_message(msg)
    except Exception:
        logger.exception("Failed to send email to %s", to)
        raise
    logger.info("Email sent to %s (%s)", to, subject)
    return True


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
        "<p>링크는 1시간 동안 유효합니다.</p>"
    )
    return send_email(to=to, subject=subject, text_body=text, html_body=html)
