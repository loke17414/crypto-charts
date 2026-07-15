"""Internet strategy research for the GPT strategy AI.

Searches the web (DuckDuckGo HTML — no API key needed) for trading-strategy
articles, fetches the top pages, strips them to plain text and returns compact
source documents that get injected into the GPT prompt as `web_research`.
"""

from __future__ import annotations

import html
import logging
import re
import time
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import requests

logger = logging.getLogger(__name__)

SEARCH_URL = "https://html.duckduckgo.com/html/"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)
MAX_SOURCES = 3
MAX_PAGE_CHARS = 3500
CACHE_TTL_SECONDS = 15 * 60

_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}

# Korean/English markers that indicate the user wants strategy knowledge from
# the internet (question / recommendation / explanation) rather than a pure
# settings edit.
_RESEARCH_MARKERS = (
    "인터넷", "검색", "찾아", "스캔", "알려줘", "알려 줘", "설명해", "설명 해",
    "추천", "어떤 전략", "무슨 전략", "전략이 뭐", "전략 뭐", "뭐가 좋", "what is",
    "explain", "recommend", "best strategy", "어떻게 작동", "원리", "장단점",
    "비교해", "괜찮아?", "유명한", "인기 있는", "인기있는",
)
_QUESTION_HINTS = ("?", "뭐야", "무엇", "인가요", "인가", "일까", "할까")


def looks_like_research_request(prompt: str) -> bool:
    text = (prompt or "").lower()
    if any(m in text for m in _RESEARCH_MARKERS):
        return True
    # A question about a strategy ("RSI 다이버전스 전략이 뭐야?")
    if any(h in text for h in _QUESTION_HINTS) and ("전략" in text or "strategy" in text):
        return True
    return False


def _strip_html(raw: str) -> str:
    text = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav|form)[^>]*>.*?</\1>", " ", raw)
    text = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>|</h[1-6]>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def _resolve_ddg_link(href: str) -> str:
    """DuckDuckGo wraps results in //duckduckgo.com/l/?uddg=<url> redirects."""
    if "duckduckgo.com/l/" in href:
        query = parse_qs(urlparse(href).query)
        target = query.get("uddg", [""])[0]
        if target:
            return unquote(target)
    if href.startswith("//"):
        return "https:" + href
    return href


def search_web(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """Return [{title, url, snippet}] from DuckDuckGo HTML search."""
    try:
        res = requests.post(
            SEARCH_URL,
            data={"q": query},
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
        res.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Web search failed for %r: %s", query, exc)
        return []

    results: list[dict[str, str]] = []
    pattern = re.compile(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    snippet_pattern = re.compile(
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )
    snippets = [_strip_html(s) for s in snippet_pattern.findall(res.text)]

    for i, match in enumerate(pattern.finditer(res.text)):
        url = _resolve_ddg_link(match.group(1))
        title = _strip_html(match.group(2))
        if not url.startswith("http") or not title:
            continue
        results.append({
            "title": title[:200],
            "url": url,
            "snippet": snippets[i][:400] if i < len(snippets) else "",
        })
        if len(results) >= max_results:
            break
    return results


def fetch_page_text(url: str, max_chars: int = MAX_PAGE_CHARS) -> str:
    try:
        res = requests.get(
            url,
            headers={"User-Agent": USER_AGENT},
            timeout=15,
            allow_redirects=True,
        )
        res.raise_for_status()
    except requests.RequestException as exc:
        logger.warning("Page fetch failed for %s: %s", url, exc)
        return ""

    content_type = res.headers.get("content-type", "")
    if "html" not in content_type and "text" not in content_type:
        return ""
    return _strip_html(res.text)[:max_chars]


def research_strategies(topic: str, max_sources: int = MAX_SOURCES) -> list[dict[str, Any]]:
    """Search the internet for the topic and return source documents for GPT."""
    key = topic.strip().lower()
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    query = topic if ("전략" in topic or "strategy" in topic.lower()) else f"{topic} trading strategy"
    hits = search_web(query, max_results=max_sources * 2)

    sources: list[dict[str, Any]] = []
    for hit in hits:
        content = fetch_page_text(hit["url"])
        if not content and not hit.get("snippet"):
            continue
        sources.append({
            "title": hit["title"],
            "url": hit["url"],
            "content": content or hit.get("snippet", ""),
        })
        if len(sources) >= max_sources:
            break

    _cache[key] = (time.time(), sources)
    logger.info("Web research for %r → %d sources", topic, len(sources))
    return sources
