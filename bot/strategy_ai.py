"""Natural-language strategy editing via OpenAI."""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

from bot.config import ROOT
from bot.strategy_ai_memory import append_turn, clear_memory, load_turns, merge_histories
from bot.strategy_market import build_market_context
from bot.strategy_research import looks_like_research_request, research_strategies
from bot.strategy_schema import StrategySettings

logger = logging.getLogger(__name__)

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
_runtime_api_key: str | None = None
_last_test_result: dict[str, Any] = {
    "verified": False,
    "checkedAt": None,
    "message": "아직 연결 테스트를 하지 않았습니다.",
    "errorCode": None,
}

SYSTEM_PROMPT = """You edit BTC USDT-M futures entry strategy for a web trading bot.

The bot uses a rule engine with ALL chart indicators (76 ids). Entries are defined by entryRules JSON.
Indicators are computed internally from candle data — users do NOT need to add indicators on the chart.
Risk fields (leverage, stopLossPct, etc.) apply when exitRules omitted. Use exitRules for dynamic SL/TP.

Respond with JSON only:
{
  "settings": { /* changed fields only — omit unchanged keys */ },
  "changed_fields": ["stopLossPct"],
  "summary": "Korean 1-3 sentences",
  "rules": "Korean HTML bullets with <br>, may use <strong>"
}

MULTI-TURN INCREMENTAL EDITS:
- You may receive prior user/assistant messages. The latest user_request may refer to them ("그대로", "아까", "손절만", "롱은 유지").
- current_settings is the ACTIVE strategy after all prior edits were applied.
- Change ONLY what the latest request requires. Omit unchanged fields from settings.
- For entryRules / exitRules: patch ONLY the side (long or short) being edited when possible.
  Example: change long only → { "entryRules": { "long": { ... } } } — do NOT include short unless changing short.
- When strategySlots is present, change entryRules for the slot described by strategySlotTarget / current entryRules — do NOT wipe other slots unless the user asks to remove them.
- To add a new slot, return strategySlots with the new slot appended (enabled true, unique id).
- Do NOT replace the entire strategySlots array unless the user explicitly asks to reorganize slots.
- Do NOT disable, clear, or replace unmentioned sides/conditions.
- To DELETE entry conditions (진입 조건 삭제/제거/비활성화), return the side with
  { "enabled": false, "conditions": [] } — an explicitly empty entryRules means the bot will NOT enter.
  Never re-add an RSI preset or any other conditions the user did not ask for.
- If user adjusts risk only (손절/익절/레버리지), do not resend entryRules or exitRules.
- changed_fields must list top-level keys you changed in settings.

Settings keys:
- strategySlots: [ { id, name, enabled, entryRules, exitRules }, ... ] — multiple independent entry conditions; ANY enabled slot that matches triggers entry (first match wins). The UI may send strategySlotTarget to show which slot entryRules applies to for editing.
- entryRules: { long: RuleGroup, short: RuleGroup }  — rules for the TARGET slot being edited (see strategySlotTarget); also legacy single-strategy mode when strategySlots omitted
- exitRules: { long: ExitRule, short: ExitRule } — dynamic SL/TP (overrides stopLossPct/takeProfitPct when set)
- rsiPeriod, rsiOversold, rsiOverbought — legacy RSI preset (used only if entryRules omitted AND no strategySlots)
- stopLossPct (0.5-15), takeProfitPct (0.5-30), useStopLoss (bool, default true), allowShort (bool)
- leverage (1-125), riskPerTradePct, maxAccountLossPct, pollSeconds

ExitRule:
{
  "stopLoss": { "type": "candle_extreme", "field": "low"|"high", "offset": 1 }
             OR { "type": "atr", "period": 14, "mult": 1.5 },
  "takeProfit": { "type": "risk_reward", "ratio": 1.5 }
}
- candle_extreme offset 1 = candle immediately before entry bar (재진입 직전 봉)
- atr stop = entry -/+ ATR(period) * mult (변동성 기반 손절)
- risk_reward ratio 1.5 = TP distance is 1.5x SL distance from entry

RuleGroup:
{
  "enabled": true,
  "logic": "all" | "any",
  "conditions": [ Condition, ... ]
}

Condition types:
1) compare — { "type":"compare", "left": Operand, "op": "<"|"<="|">"|">="|"=="|"!=", "right": Operand }
2) cross_above — golden cross: left crosses above right
3) cross_below — dead cross
4) candle_pattern — boolean candle pattern on a bar
   { "type":"candle_pattern", "pattern":"<name>", "offset":0, "params":{} }
5) band_reentry — price left a band then closed back inside (works for ANY overlay-band indicator)
   { "type":"band_reentry", "side":"long"|"short", "indicator":"boll"|"env"|"kc"|"dc", "params":{...} }
   params by indicator: boll{period,mult} · env{period,pct} · kc{period,mult} · dc{period}
   long: prev close < lower band AND current close >= lower band
   short: prev close > upper band AND current close <= upper band
   Use the same structure for Bollinger, Envelope, Keltner, Donchian — only indicator + params change.

Operand:
- overlay-band fields (boll/env/kc/dc): upper, middle, lower
  band params: boll/kc use mult, env uses pct, dc uses period only
- literal: { "source":"value", "value": 30 }
- price: { "source":"price", "field": "close"|"open"|"high"|"low"|"volume", "offset":0 }
  offset 1 = previous candle
- candle metric: { "source":"candle", "metric":"body_pct"|"lower_wick_pct"|"change_pct"|"is_bullish", "offset":0 }
- indicator: { "source":"indicator", "indicator": "<id>", "params": {...}, "field": "<field>" }

MULTI-LINE INDICATORS (field is REQUIRED — pick from the indicator_catalog fields):
- macd → field: macd | signal | histogram   params: fast, slow, signal
- stoch → field: k | d                       params: kPeriod, dPeriod
- kdj → field: k | d | j                      params: n, m1, m2
- dmi → field: pdi | mdi | adx                params: period
Single-line indicators (rsi, cci, atr, mfi, wr, roc, obv, ...) use field "value".
ALWAYS use the exact param names from indicator_catalog; do NOT invent names like "length" or "fastPeriod".
Examples of correct multi-line usage:
- MACD golden cross: cross_above { indicator:"macd", field:"macd" } vs { indicator:"macd", field:"signal" }
- MACD histogram > 0: compare { indicator:"macd", field:"histogram" } > { value:0 }
- Stoch oversold long: compare { indicator:"stoch", field:"k" } < { value:20 }
- KDJ J > 100 short: compare { indicator:"kdj", field:"j" } > { value:100 }
- ADX trend filter: compare { indicator:"dmi", field:"adx" } > { value:25 }

Candle patterns (candle_pattern.pattern):
bullish, bearish, doji, hammer, inverted_hammer, shooting_star,
engulfing_bull, engulfing_bear, marubozu_bull, marubozu_bear,
pin_bar_bull, pin_bar_bear, inside_bar, outside_bar,
three_white_soldiers, three_black_crows

Examples:
- Golden cross long: cross_above ema(12) vs ema(26)
- RSI oversold long (과매도 롱): compare rsi >= rsiOversold OR rsi <= 25 for long
- RSI overbought long (과매수 롱): compare rsi >= rsiOverbought (e.g. >= 70) for long — use EXACTLY what user asks
- RSI overbought short (과매수 숏): compare rsi >= 70 for short
- Engulfing bull long: { type:"candle_pattern", pattern:"engulfing_bull" }
- Hammer + RSI: candle_pattern hammer AND rsi <= 30
- Bullish candle: { type:"candle_pattern", pattern:"bullish" } or compare is_bullish == 1
- Body > 60%: compare candle.body_pct > 60
- Bollinger lower re-entry long (볼린저 하단 이탈 후 재진입 롱):
  entryRules.long.conditions = [{ "type":"band_reentry", "side":"long", "indicator":"boll", "params":{"period":20,"mult":2} }]
  exitRules.long = { "stopLoss": { "type":"candle_extreme", "field":"low", "offset":1 }, "takeProfit": { "type":"risk_reward", "ratio":1.5 } }
  Set short.enabled=false for long-only
- Keltner / Donchian / Envelope re-entry: SAME structure, change indicator + params
  Keltner: { "type":"band_reentry", "side":"long", "indicator":"kc", "params":{"period":20,"mult":2} }
  Envelope: { "type":"band_reentry", "side":"long", "indicator":"env", "params":{"period":20,"pct":0.1} }
  Donchian: { "type":"band_reentry", "side":"long", "indicator":"dc", "params":{"period":20} }
- ATR stop long: exitRules.long.stopLoss = { "type":"atr", "period":14, "mult":1.5 }

Korean RSI terms:
- 과매수 = overbought = high RSI (typically >= 70)
- 과매도 = oversold = low RSI (typically <= 25)
- Follow the user's direction (long/short) literally; do not swap long/short unless they ask.

Rules:
- For "골든 크로스", "EMA 교차", use cross_above/cross_below with ema params.
- Combine multiple conditions with logic "all" (AND) or "any" (OR).
- Set short.enabled=false when user wants long-only.
- Change only what user asks; use partial entryRules/exitRules patches for follow-up edits.
- Keep summary and rules in Korean.

MARKET DATA & BACKTEST (critical for accuracy):
- You receive market_context (recent price, RSI, EMA trend, volatility ATR%, range) and backtest_snapshot.
- Use market_context to calibrate thresholds: e.g. if rsi14 is 68, "과매수 롱" should use rsi >= 65-70 not <= 30.
- If recentTrend is bullish and volatility high (atrPct > 2), prefer wider stopLossPct or ATR-based exits.
- backtest_snapshot.current = performance of ACTIVE strategy on recent candles.
- If winRate < 40% with trades >= 10, suggest tightening entry filters (add AND conditions, raise RSI thresholds).
- If trades < 5, strategy may be too strict — suggest loosening one filter.
- Mention market_insight (1 sentence on current market) and backtest_insight (1 sentence on backtest) in JSON response.

Respond with JSON only — extended shape:
{
  "settings": { /* changed fields only */ },
  "changed_fields": ["stopLossPct"],
  "summary": "Korean 1-3 sentences — what changed and why",
  "rules": "Korean HTML bullets",
  "market_insight": "Korean 1 sentence on current market vs strategy fit",
  "backtest_insight": "Korean 1 sentence on backtest result / expected improvement"
}

WEB RESEARCH / QUESTION MODE:
- You may receive web_research: a list of {title, url, content} scraped from the internet about trading strategies.
- Use web_research as your primary knowledge source when it is provided — it reflects what real traders publish about the strategy.
- If the user is ASKING a question (전략 설명/추천/비교/원리 등) rather than requesting a settings change:
  - Answer thoroughly in Korean in "summary" (up to ~8 sentences allowed in this mode).
  - Set "settings" to {} and "changed_fields" to [] — do NOT modify the strategy.
  - Cite which sources you used by listing their urls in "sources": ["url1", "url2"].
- If the user asks to APPLY a strategy found on the internet ("그 전략 적용해줘", "볼린저 전략으로 바꿔"),
  translate the researched strategy into entryRules/exitRules as usual and still fill "sources".
"""


def _env_path() -> Path:
    return ROOT / ".env"


def _reload_env() -> None:
    load_dotenv(_env_path(), override=True)


def _key_source() -> str:
    if _runtime_api_key:
        return "runtime"
    if os.getenv("OPENAI_API_KEY", "").strip():
        return "env"
    return "none"


def _openai_config() -> tuple[str, str]:
    api_key = (_runtime_api_key or os.getenv("OPENAI_API_KEY", "")).strip().strip('"').strip("'")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
    return api_key, model


def mask_api_key(api_key: str) -> str:
    cleaned = api_key.strip()
    if len(cleaned) <= 12:
        return "****"
    return f"{cleaned[:7]}...{cleaned[-4:]}"


def validate_api_key_format(api_key: str) -> None:
    cleaned = api_key.strip()
    if not cleaned:
        raise ValueError("OpenAI API 키가 비어 있습니다.")
    if not cleaned.startswith("sk-"):
        raise ValueError(
            "올바른 OpenAI API 키 형식이 아닙니다. 'sk-'로 시작하는 키를 입력하세요."
        )
    if len(cleaned) < 20:
        raise ValueError("OpenAI API 키가 너무 짧습니다. 전체 키를 다시 복사해 붙여넣으세요.")


def set_openai_api_key(api_key: str) -> None:
    global _runtime_api_key
    validate_api_key_format(api_key)
    cleaned = api_key.strip()
    _runtime_api_key = cleaned
    os.environ["OPENAI_API_KEY"] = cleaned


def persist_openai_api_key(api_key: str) -> Path:
    validate_api_key_format(api_key)
    env_path = _env_path()
    key_name = "OPENAI_API_KEY"
    value = api_key.strip()
    lines: list[str] = []

    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()

    updated: list[str] = []
    found_key = False
    found_model = False
    for line in lines:
        if line.startswith(f"{key_name}="):
            updated.append(f'{key_name}="{value}"')
            found_key = True
        elif line.startswith("OPENAI_MODEL="):
            found_model = True
            updated.append(line)
        else:
            updated.append(line)

    if not found_key:
        if updated and updated[-1].strip():
            updated.append("")
        if not found_model:
            updated.append("OPENAI_MODEL=gpt-4o-mini")
        updated.append(f'{key_name}="{value}"')

    env_path.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    _reload_env()
    set_openai_api_key(value)
    logger.info("OpenAI API key saved to %s (%s)", env_path, mask_api_key(value))
    return env_path


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _set_test_result(*, verified: bool, message: str, error_code: str | None = None) -> None:
    global _last_test_result
    _last_test_result = {
        "verified": verified,
        "checkedAt": _now_iso(),
        "message": message,
        "errorCode": error_code,
    }


def _parse_openai_error(status_code: int, body_text: str) -> tuple[str, str | None]:
    code: str | None = None
    message = body_text[:500]

    try:
        payload = json.loads(body_text)
        err = payload.get("error") or {}
        code = err.get("code") or err.get("type")
        message = err.get("message") or message
    except json.JSONDecodeError:
        pass

    if status_code == 401 or code == "invalid_api_key":
        return (
            "OpenAI API 키가 유효하지 않습니다. platform.openai.com/api-keys 에서 "
            "새 키를 발급한 뒤 전체 키를 다시 저장하세요.",
            code or "invalid_api_key",
        )
    if status_code == 403:
        return ("OpenAI API 접근이 거부되었습니다. 프로젝트 권한과 결제 상태를 확인하세요.", code)
    if status_code == 429 or code == "insufficient_quota":
        return ("OpenAI 사용 한도를 초과했습니다. 결제/크레딧 잔액을 확인하세요.", code or "rate_limit")
    if status_code == 404 or code == "model_not_found":
        return ("선택한 GPT 모델을 사용할 수 없습니다. OPENAI_MODEL 설정을 확인하세요.", code)
    return (f"OpenAI API 오류 ({status_code}): {message}", code)


def test_openai_api_key(api_key: str | None = None) -> dict[str, Any]:
    key = (api_key or _openai_config()[0]).strip()
    model = _openai_config()[1]

    if not key:
        result = {
            "ok": False,
            "verified": False,
            "message": "OpenAI API 키가 설정되지 않았습니다.",
            "errorCode": "missing_key",
            "keyPreview": None,
            "model": model,
        }
        _set_test_result(verified=False, message=result["message"], error_code="missing_key")
        return result

    validate_api_key_format(key)

    try:
        res = requests.get(
            OPENAI_MODELS_URL,
            headers={"Authorization": f"Bearer {key}"},
            timeout=20,
        )
    except requests.RequestException as exc:
        message = f"OpenAI 서버 연결 실패: {exc}"
        _set_test_result(verified=False, message=message, error_code="network_error")
        return {
            "ok": False,
            "verified": False,
            "message": message,
            "errorCode": "network_error",
            "keyPreview": mask_api_key(key),
            "model": model,
        }

    if res.status_code != 200:
        message, code = _parse_openai_error(res.status_code, res.text)
        _set_test_result(verified=False, message=message, error_code=code)
        return {
            "ok": False,
            "verified": False,
            "authenticated": False,
            "chatReady": False,
            "message": message,
            "errorCode": code,
            "keyPreview": mask_api_key(key),
            "model": model,
            "httpStatus": res.status_code,
        }

    chat_result = _test_chat_completion(key, model)
    if not chat_result["chatReady"]:
        _set_test_result(
            verified=False,
            message=chat_result["message"],
            error_code=chat_result.get("errorCode"),
        )
        return {
            "ok": False,
            "verified": False,
            "authenticated": True,
            "chatReady": False,
            "message": chat_result["message"],
            "errorCode": chat_result.get("errorCode"),
            "keyPreview": mask_api_key(key),
            "model": model,
            "checkedAt": _now_iso(),
            "httpStatus": chat_result.get("httpStatus"),
        }

    _set_test_result(
        verified=True,
        message="OpenAI API 키가 정상이며 GPT 호출이 가능합니다.",
        error_code=None,
    )
    return {
        "ok": True,
        "verified": True,
        "authenticated": True,
        "chatReady": True,
        "message": "OpenAI API 키가 정상이며 GPT 호출이 가능합니다.",
        "errorCode": None,
        "keyPreview": mask_api_key(key),
        "model": model,
        "checkedAt": _last_test_result["checkedAt"],
    }


def _test_chat_completion(api_key: str, model: str) -> dict[str, Any]:
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 8,
        "messages": [{"role": "user", "content": "reply ok"}],
    }

    try:
        res = requests.post(
            OPENAI_CHAT_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=30,
        )
    except requests.RequestException as exc:
        return {
            "chatReady": False,
            "message": f"GPT 호출 테스트 실패: {exc}",
            "errorCode": "network_error",
        }

    if res.status_code == 200:
        return {"chatReady": True, "message": "GPT 호출 가능"}

    message, code = _parse_openai_error(res.status_code, res.text)
    if code == "insufficient_quota" or res.status_code == 429:
        message = (
            "API 키는 유효하지만 GPT 사용 한도/크레딧이 부족합니다. "
            "platform.openai.com/settings/organization/billing 에서 결제와 잔액을 확인하세요."
        )
    return {
        "chatReady": False,
        "message": message,
        "errorCode": code,
        "httpStatus": res.status_code,
    }


def ai_available(*, verify: bool = False) -> dict[str, Any]:
    _reload_env()
    api_key, model = _openai_config()
    configured = bool(api_key)
    status = {
        "available": configured and _last_test_result["verified"],
        "configured": configured,
        "verified": _last_test_result["verified"] if configured else False,
        "authenticated": configured and _last_test_result.get("errorCode") != "invalid_api_key",
        "chatReady": _last_test_result["verified"] if configured else False,
        "model": model,
        "keyPreview": mask_api_key(api_key) if configured else None,
        "keySource": _key_source(),
        "envPath": str(_env_path()),
        "checkedAt": _last_test_result["checkedAt"],
        "message": _last_test_result["message"],
        "errorCode": _last_test_result["errorCode"],
    }

    if verify and configured:
        test_result = test_openai_api_key(api_key)
        status.update(
            {
                "available": test_result["verified"],
                "verified": test_result["verified"],
                "message": test_result["message"],
                "errorCode": test_result.get("errorCode"),
                "checkedAt": test_result.get("checkedAt") or _last_test_result["checkedAt"],
            }
        )

    return status


def configure_openai_api_key(api_key: str) -> dict[str, Any]:
    validate_api_key_format(api_key)
    test_result = test_openai_api_key(api_key)
    if not test_result["verified"]:
        raise ValueError(test_result["message"])

    persist_openai_api_key(api_key)
    status = ai_available()
    status["message"] = "OpenAI API 키가 저장되고 인증되었습니다."
    return status


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def _normalize_history(history: list[dict[str, Any]] | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in (history or [])[-12:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            out.append({"role": role, "content": content[:2000]})
    return out


def _looks_like_follow_up_edit(prompt: str) -> bool:
    text = prompt.lower()
    markers = (
        "그대로", "유지", "만 ", "만,", "만.", "바꿔", "변경", "손절", "익절", "레버",
        "아까", "이전", "빼고", "제외", "추가", "수정", "조정", "높여", "낮춰",
    )
    return any(m in text for m in markers)


def _call_openai(
    prompt: str,
    current: StrategySettings,
    indicator_catalog: str = "",
    history: list[dict[str, str]] | None = None,
    market_context: dict[str, Any] | None = None,
    backtest_snapshot: dict[str, Any] | None = None,
    web_research: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    api_key, model = _openai_config()
    if not api_key:
        raise ValueError(
            "OPENAI_API_KEY가 설정되지 않았습니다. OpenAI API Key 입력란에서 키를 저장하세요."
        )

    if not _last_test_result["verified"]:
        test_result = test_openai_api_key(api_key)
        if not test_result["verified"]:
            raise ValueError(test_result["message"])

    user_content = json.dumps(
        {
            "current_settings": current.model_dump(),
            "indicator_catalog": indicator_catalog,
            "market_context": market_context or {},
            "backtest_snapshot": backtest_snapshot or {},
            "web_research": web_research or [],
            "user_request": prompt,
        },
        ensure_ascii=False,
    )

    messages: list[dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in _normalize_history(history):
        messages.append(turn)
    messages.append({"role": "user", "content": user_content})
    payload = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": messages,
    }

    try:
        res = requests.post(
            OPENAI_CHAT_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
    except requests.RequestException as exc:
        raise ValueError(f"OpenAI API 연결 실패: {exc}") from exc

    if res.status_code != 200:
        message, code = _parse_openai_error(res.status_code, res.text)
        _set_test_result(verified=False, message=message, error_code=code)
        raise ValueError(message)

    data = res.json()
    content = data["choices"][0]["message"]["content"]
    return _extract_json(content)


def _bollinger_reentry_long_patch(ratio: float = 1.5) -> dict[str, Any]:
    return {
        "allowShort": False,
        "entryRules": {
            "long": {
                "enabled": True,
                "logic": "all",
                "conditions": [{
                    "type": "band_reentry",
                    "side": "long",
                    "indicator": "boll",
                    "params": {"period": 20, "mult": 2},
                }],
            },
            "short": {"enabled": False, "logic": "all", "conditions": []},
        },
        "exitRules": {
            "long": {
                "stopLoss": {"type": "candle_extreme", "field": "low", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": ratio},
            }
        },
    }


def _looks_like_bb_reentry_long(prompt: str) -> bool:
    text = prompt.lower()
    bb = any(k in text for k in ("볼린저", "bollinger", "boll", "bb", "볼밴"))
    reentry = any(k in text for k in ("재진입", "들어", "이탈", "안으로", "밴드"))
    long_only = any(k in text for k in ("롱", "long", "매수"))
    return bb and reentry and long_only


def _has_band_reentry(rules: Any) -> bool:
    if not isinstance(rules, dict):
        return False
    for side in ("long", "short"):
        group = rules.get(side)
        if not isinstance(group, dict):
            continue
        for cond in group.get("conditions") or []:
            if isinstance(cond, dict) and cond.get("type") == "band_reentry":
                return True
    return False


def _apply_rule_templates(
    prompt: str,
    patch: dict[str, Any],
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    if not _looks_like_bb_reentry_long(prompt):
        return patch
    if history and _looks_like_follow_up_edit(prompt):
        return patch
    ratio = 1.5
    match = re.search(r"1\.5\s*배|1\.5\s*:?\s*1|손절.*?1\.5|1\.5\s*배", prompt)
    if match:
        ratio = 1.5
    tmpl = _bollinger_reentry_long_patch(ratio)
    merged = dict(patch)
    if not _has_band_reentry(merged.get("entryRules")):
        merged["entryRules"] = tmpl["entryRules"]
    if not merged.get("exitRules"):
        merged["exitRules"] = tmpl["exitRules"]
    if "allowShort" not in merged:
        merged["allowShort"] = False
    return merged


def interpret_strategy(
    prompt: str,
    current_settings: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    *,
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    market_context: dict[str, Any] | None = None,
    backtest_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    raw_settings = dict(current_settings or {})
    indicator_catalog = str(raw_settings.pop("indicatorCatalog", "") or "")
    raw_settings.pop("strategySlotTarget", None)
    current = StrategySettings.model_validate(raw_settings)

    merged_history = merge_histories(history, load_turns())
    market = build_market_context(
        symbol=symbol,
        interval=interval,
        client_context=market_context,
        use_testnet=True,
    )

    append_turn(role="user", content=prompt.strip())

    web_research: list[dict[str, Any]] = []
    if looks_like_research_request(prompt):
        try:
            web_research = research_strategies(prompt.strip())
        except Exception:
            logger.exception("Web strategy research failed — continuing without it")

    raw = _call_openai(
        prompt.strip(),
        current,
        indicator_catalog,
        merged_history,
        market,
        backtest_snapshot,
        web_research,
    )

    patch = raw.get("settings") or {}
    if not isinstance(patch, dict):
        patch = {}

    changed_fields = raw.get("changed_fields")
    if not isinstance(changed_fields, list):
        changed_fields = list(patch.keys())
    # GPT가 changed_fields만 채우고 settings를 비우면(이해 못함/질문 모드)
    # 실제 변경 없이 프론트가 설정·백테스트를 건드리지 않게 한다.
    changed_fields = [f for f in changed_fields if isinstance(f, str) and f in patch]

    # 질문·조사 모드(빈 patch)에는 BB 템플릿을 주입하지 않는다 — 키워드만
    # 맞는 일반 질문에 전략이 바뀌어 백테스트가 깨지는 문제를 막는다.
    if patch:
        patch = _apply_rule_templates(prompt.strip(), patch, merged_history)
        merged = current.merged(patch)
        changed_fields = [f for f in changed_fields if f in patch]
    else:
        merged = current

    summary = str(raw.get("summary") or "전략 설정을 업데이트했습니다.").strip()
    rules = str(raw.get("rules") or merged.rules_text()).strip()
    market_insight = str(raw.get("market_insight") or "").strip()
    backtest_insight = str(raw.get("backtest_insight") or "").strip()

    sources = raw.get("sources")
    if not isinstance(sources, list):
        sources = []
    sources = [str(s) for s in sources if isinstance(s, str) and s.startswith("http")][:5]
    if web_research and not sources:
        sources = [src["url"] for src in web_research][:5]

    bt_meta = None
    if backtest_snapshot and isinstance(backtest_snapshot.get("current"), dict):
        bt_meta = backtest_snapshot["current"]

    assistant_text = summary
    if market_insight:
        assistant_text += f"\n📊 {market_insight}"
    if backtest_insight:
        assistant_text += f"\n📈 {backtest_insight}"

    append_turn(
        role="assistant",
        content=assistant_text,
        meta={
            "changed_fields": changed_fields,
            "backtest": bt_meta,
            "patch_keys": list(patch.keys()),
        },
    )

    logger.info("Strategy AI applied patch: %s", patch)

    return {
        "ok": True,
        "settings": merged.model_dump(),
        "summary": summary,
        "rules": rules,
        "patch": patch,
        "changed_fields": changed_fields,
        "market_insight": market_insight,
        "backtest_insight": backtest_insight,
        "sources": sources,
    }


_reload_env()
if os.getenv("OPENAI_API_KEY", "").strip():
    test_openai_api_key()
