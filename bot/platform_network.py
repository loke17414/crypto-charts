"""Platform network helpers — outbound IP for Binance API whitelist (Phase 2-E prep)."""

from __future__ import annotations

import logging
import os
import re
from functools import lru_cache

import requests

logger = logging.getLogger(__name__)

_REQUEST_IP_RE = re.compile(r"request ip:\s*([0-9a-fA-F.:]+)", re.IGNORECASE)


def parse_binance_request_ip(message: str) -> str | None:
    """Extract 'request ip: …' from a Binance HTTP error body."""
    match = _REQUEST_IP_RE.search(message or "")
    return match.group(1).strip() if match else None


@lru_cache(maxsize=1)
def get_outbound_ip() -> str:
    """Public IPv4/IPv6 seen by the internet (same path Binance uses for whitelist checks)."""
    configured = os.getenv("PLATFORM_OUTBOUND_IP", "").strip()
    if configured:
        return configured

    for url in (
        "https://api.ipify.org",
        "https://ifconfig.me/ip",
        "https://icanhazip.com",
    ):
        try:
            resp = requests.get(url, timeout=6)
            resp.raise_for_status()
            ip = resp.text.strip()
            if ip:
                return ip
        except requests.RequestException as exc:
            logger.debug("Outbound IP lookup failed (%s): %s", url, exc)
    return ""


def binance_ip_whitelist_hint(*, request_ip: str | None = None, use_testnet: bool = False) -> str:
    """Actionable Korean hint when Binance rejects key/IP/permissions."""
    ip = (request_ip or get_outbound_ip() or "").strip()
    env = "테스트넷" if use_testnet else "실거래"
    lines = [
        f"Binance {env} API 키 설정을 확인하세요.",
        "① API Management → 해당 키 → 「Enable Futures(USDⓈ-M)」 켜기",
        "② 「Restrict access to trusted IPs only」 → 아래 **서버 IP** 추가 (집/회사 IP 아님)",
    ]
    if ip:
        lines.append(f"   등록할 IP: {ip}")
    lines.append("③ 저장 후 1~2분 뒤 다시 「연결」")
    return "\n".join(lines)
