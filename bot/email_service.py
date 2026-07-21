"""Transactional email via SMTP (optional). When unset, verification is auto-skipped in dev."""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr
from typing import Any

from bot.platform_config import (
    app_origin,
    resend_api_key,
    resend_from_email,
    smtp_configured,
    smtp_profiles,
)

logger = logging.getLogger(__name__)

__all__ = [
    "send_email",
    "send_reset_email",
    "send_verify_email",
    "smtp_configured",
    "diagnose_smtp",
    "safe_smtp_error",
]


def _origin() -> str:
    origin = app_origin().rstrip("/")
    if origin == "*" or not origin.startswith("http"):
        return "http://127.0.0.1:8765"
    return origin


def safe_smtp_error(exc: BaseException) -> str:
    """Short operator-facing SMTP error (never includes credentials)."""
    text = str(exc) or type(exc).__name__
    text = " ".join(text.split())
    lower = text.lower()
    if "535" in text or "not accepted" in lower or "badcredentials" in lower:
        return (
            "SMTPAuthenticationError: 앱 비밀번호가 거부됨(535). "
            "네이버 SMTP 사용함 + 새 앱 비밀번호, 또는 Gmail 앱 비밀번호를 다시 발급하세요."
        )
    if len(text) > 180:
        text = text[:177] + "..."
    for bad in ("password", "passwd", "secret"):
        if bad in lower and "535" not in text:
            return type(exc).__name__
    return f"{type(exc).__name__}: {text}"


def _header_and_envelope(from_email: str, user: str) -> tuple[str, str]:
    name, addr = parseaddr((from_email or "").strip())
    if not addr or "@" not in addr:
        addr = (user or "").strip()
    if not addr or "@" not in addr:
        raw = (from_email or user or "").strip()
        if "@" in raw and "<" not in raw:
            addr = raw
            name = ""
        else:
            raise ValueError("SMTP From 주소가 올바르지 않습니다. SMTP_FROM 또는 SMTP_USER에 이메일을 넣으세요.")
    # Providers (esp. Naver) often require From == authenticated user.
    user_addr = (user or "").strip()
    if user_addr and "@" in user_addr and addr.lower() != user_addr.lower():
        logger.warning("SMTP From %s differs from login %s — using login as From", addr, user_addr)
        addr = user_addr
        name = "Orbinex"
    header = formataddr((name or "Orbinex", addr))
    return header, addr


def _login_candidates(host: str, user: str) -> list[str]:
    """Naver sometimes accepts id-only; Gmail wants full address. Try both."""
    u = (user or "").strip()
    out: list[str] = []
    if u:
        out.append(u)
    if "@" in u:
        local = u.split("@", 1)[0]
        if local and local not in out and "naver.com" in host.lower():
            out.append(local)
    return out


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
    recipients = [addr for _, addr in [parseaddr(msg["To"])] if addr]
    if not recipients:
        raise ValueError("수신 이메일이 없습니다.")
    payload = msg.as_bytes()
    users = _login_candidates(host, user)
    last_exc: Exception | None = None

    for login_user in users:
        try:
            if use_tls:
                context = ssl.create_default_context()
                with smtplib.SMTP(host, port, timeout=45) as server:
                    server.ehlo()
                    server.starttls(context=context)
                    server.ehlo()
                    server.login(login_user, password)
                    server.sendmail(envelope_from, recipients, payload)
            else:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(host, port, timeout=45, context=context) as server:
                    server.ehlo()
                    server.login(login_user, password)
                    server.sendmail(envelope_from, recipients, payload)
            return
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "SMTP login/send failed host=%s user=%s — %s",
                host,
                login_user,
                safe_smtp_error(exc),
            )
    assert last_exc is not None
    raise last_exc


def _attempts_for(host: str, port: int, use_tls: bool) -> list[tuple[int, bool]]:
    attempts: list[tuple[int, bool]] = [(port, use_tls)]
    host_l = host.lower()
    if "naver.com" in host_l:
        for candidate in ((587, True), (465, False)):
            if candidate not in attempts:
                attempts.append(candidate)
    elif "gmail.com" in host_l or "google.com" in host_l:
        for candidate in ((587, True), (465, False)):
            if candidate not in attempts:
                attempts.append(candidate)
    elif use_tls and port == 587:
        attempts.append((465, False))
    return attempts


def _send_via_profile(profile: dict[str, Any], msg: EmailMessage) -> None:
    host = str(profile["host"])
    port = int(profile["port"])
    user = str(profile.get("user") or "")
    password = str(profile.get("password") or "")
    use_tls = bool(profile.get("use_tls", True))
    if not password:
        raise smtplib.SMTPAuthenticationError(535, b"SMTP password empty - check .env SMTP_PASSWORD")

    header_from, envelope_from = _header_and_envelope(str(profile.get("from_email") or ""), user)
    if "From" in msg:
        msg.replace_header("From", header_from)
    else:
        msg["From"] = header_from

    last_exc: Exception | None = None
    for try_port, try_tls in _attempts_for(host, port, use_tls):
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
            logger.info("SMTP OK via %s:%s tls=%s user=%s", host, try_port, try_tls, user)
            return
        except Exception as exc:
            last_exc = exc
            logger.warning(
                "SMTP attempt failed %s:%s tls=%s user=%s — %s",
                host,
                try_port,
                try_tls,
                user,
                safe_smtp_error(exc),
            )
    assert last_exc is not None
    raise last_exc


def _send_via_resend(*, to: str, subject: str, text_body: str, html_body: str | None) -> bool:
    key = resend_api_key()
    if not key:
        return False
    import requests

    payload: dict[str, Any] = {
        "from": resend_from_email(),
        "to": [to],
        "subject": subject,
        "text": text_body,
    }
    if html_body:
        payload["html"] = html_body
    res = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"Resend HTTP {res.status_code}: {res.text[:200]}")
    logger.info("Email sent to %s (%s) via Resend", to, subject)
    return True


def send_email(*, to: str, subject: str, text_body: str, html_body: str | None = None) -> bool:
    # Prefer Resend API when configured — more reliable than consumer SMTP from a VPS.
    if resend_api_key():
        try:
            return _send_via_resend(to=to, subject=subject, text_body=text_body, html_body=html_body)
        except Exception:
            logger.exception("Resend send failed for %s — falling back to SMTP if any", to)

    profiles = smtp_profiles()
    if not profiles:
        if resend_api_key():
            raise RuntimeError("Resend 발송 실패 (SMTP 폴백 없음)")
        logger.warning("Mail not configured — email to %s skipped (%s)", to, subject)
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
                "SMTP %s (%s) failed for %s — %s",
                profile.get("name"),
                profile.get("host"),
                to,
                safe_smtp_error(exc),
            )

    if last_exc:
        raise last_exc
    return False


def diagnose_smtp(*, to: str | None = None) -> dict[str, Any]:
    """Test Resend + SMTP login. No secrets returned."""
    out: dict[str, Any] = {
        "ok": False,
        "configured": smtp_configured(),
        "resend": {"configured": bool(resend_api_key()), "ok": False, "error": None},
        "profiles": [],
        "message": "",
    }
    if resend_api_key():
        try:
            target = (to or "").strip() or "delivered@resend.dev"
            _send_via_resend(
                to=target,
                subject="[Orbinex] Resend 진단",
                text_body="Resend 진단 메일입니다.",
                html_body=None,
            )
            out["resend"]["ok"] = True
        except Exception as exc:
            out["resend"]["error"] = safe_smtp_error(exc)

    profiles = smtp_profiles()
    results: list[dict[str, Any]] = []
    target = (to or "").strip()
    for profile in profiles:
        host = str(profile["host"])
        port = int(profile["port"])
        user = str(profile.get("user") or "")
        password = str(profile.get("password") or "")
        use_tls = bool(profile.get("use_tls", True))
        entry: dict[str, Any] = {
            "name": profile.get("name"),
            "host": host,
            "user": user,
            "passwordSet": bool(password),
            "passwordLen": len(password),
            "ok": False,
            "error": None,
            "mode": None,
            "hint": None,
        }
        if not password:
            entry["error"] = "password empty"
            results.append(entry)
            continue
        last_err = None
        for try_port, try_tls in _attempts_for(host, port, use_tls):
            try:
                if try_tls:
                    context = ssl.create_default_context()
                    with smtplib.SMTP(host, try_port, timeout=45) as server:
                        server.ehlo()
                        server.starttls(context=context)
                        server.ehlo()
                        server.login(user, password)
                else:
                    context = ssl.create_default_context()
                    with smtplib.SMTP_SSL(host, try_port, timeout=45, context=context) as server:
                        server.ehlo()
                        server.login(user, password)
                entry["ok"] = True
                entry["mode"] = f"{try_port}/{'starttls' if try_tls else 'ssl'}"
                if target:
                    msg = EmailMessage()
                    msg["Subject"] = "[Orbinex] SMTP 진단"
                    msg["From"] = user
                    msg["To"] = target
                    msg.set_content("Orbinex SMTP 진단 메일입니다. 수신되면 설정이 정상입니다.")
                    _smtp_connect_and_send(
                        host=host,
                        port=try_port,
                        user=user,
                        password=password,
                        use_tls=try_tls,
                        msg=msg,
                        envelope_from=user,
                    )
                    entry["sent"] = True
                break
            except Exception as exc:
                last_err = safe_smtp_error(exc)
        if not entry["ok"]:
            entry["error"] = last_err or "unknown"
            if last_err and "535" in last_err:
                entry["hint"] = (
                    "앱 비밀번호가 틀렸거나 폐기됨. SMTP 사용함이 꺼져 있을 수도 있음. "
                    "새 앱 비밀번호 발급 후 .env 갱신."
                )
        results.append(entry)

    out["profiles"] = results
    out["ok"] = bool(out["resend"]["ok"] or any(r.get("ok") for r in results))
    if out["ok"]:
        out["message"] = "메일 발송 경로 OK"
    elif not out["configured"]:
        out["message"] = "메일 미설정"
    else:
        out["message"] = "모든 메일 경로 실패 — 앱 비밀번호/Resend 확인"
    return out


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
