"""Natural-language strategy editing via OpenAI."""

from __future__ import annotations

import json
import logging
import os
import re
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

from bot.config import ROOT
from bot.strategy_ai_memory import append_turn, clear_memory, load_turns, merge_histories
from bot.strategy_market import build_market_context
from bot.strategy_research import looks_like_research_request, research_strategies
from bot.strategy_schema import (
    StrategySettings,
    clamp_numeric_fields,
    entry_rules_have_signals,
    strategy_slots_have_signals,
)

logger = logging.getLogger(__name__)

OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
_runtime_api_key: str | None = None
# Per-request key for multi-user isolation (overrides process/.env for that call).
_request_api_key: ContextVar[str | None] = ContextVar("request_api_key", default=None)
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
- stopLossPct (0.1-50), takeProfitPct (0.1-100), useStopLoss (bool, default true), allowShort (bool)
- leverage (1-125), riskPerTradePct, maxAccountLossPct, pollSeconds

ExitRule:
{
  "stopLoss": { "type": "candle_extreme", "field": "low"|"high", "offset": 1 }
             OR { "type": "atr", "period": 14, "mult": 1.5 },
  "takeProfit": { "type": "risk_reward", "ratio": 1.5 }
}
- candle_extreme offset 1 = candle immediately before entry bar (재진입 직전 봉)
- atr stop = entry -/+ ATR(period) * mult (변동성 기반 손절)
- risk_reward ratio 1.5 = net TP/SL after round-trip fee 0.1%
  (engine sets TP so (reward-fee)/(risk+fee)=ratio; risk sizing also adds 0.1% fee to SL%)

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
6) fvg — Fair Value Gap (3-candle imbalance)
   { "type":"fvg", "side":"bullish"|"bearish", "state":"present"|"in_zone"|"filled", "lookback":30 }
   bullish = gap up (candle[i-2].high < candle[i].low); bearish = gap down
   present = unfilled gap exists; in_zone = price inside open gap; filled = most recent gap was filled
7) divergence — price vs RSI/MACD pivot mismatch
   { "type":"divergence", "kind":"bullish"|"bearish", "indicator":"rsi"|"macd", "lookback":40, "period":14 }
   bullish = price lower low + indicator higher low; bearish = price higher high + indicator lower high
8) swing_break — close breaks the last CONFIRMED swing high/low
   { "type":"swing_break", "side":"long"|"short", "pivotBars":5, "lookback":60 }
   long = close crosses above last confirmed swing high (전 고점 돌파); short = below last swing low (전 저점 이탈)
9) swing_near — close within tolerancePct of the last confirmed swing level (support/resistance)
   { "type":"swing_near", "side":"long"|"short", "pivotBars":5, "lookback":60, "tolerancePct":0.5 }
   long = near swing low (전 저점 지지); short = near swing high (전 고점 저항)

SWING HIGH/LOW (전 고점/전 저점) — CRITICAL (most common AI mistake):
- WRONG: "이전 캔들이 더 낮으니 지금/직전 봉이 전고점" — NEVER do this.
- RIGHT: candle[i] is a swing high ONLY if pivotBars (default 5) candles BEFORE and AFTER
  all have strictly lower highs. Same for lows with higher lows. Both sides required.
- The most recent pivotBars candles can NEVER be confirmed swings (right side incomplete).
- market_context.recentHigh / recentLow are ONLY the max/min of the last ~24 bars —
  they are NOT swing pivots. Do not call them 전고점/전저점.
- market_context.structure.swings is the ONLY source of truth for 전고점/전저점:
  lastSwingHigh, lastSwingLow, recentHighs/recentLows (price + barsAgo),
  priceVsLastHighPct / priceVsLastLowPct, relation.aboveLastHigh / belowLastLow.
- ALWAYS read structure.swings when the user mentions 전고점, 전저점, 지지, 저항, 돌파, 스윙.
- Strategies: 전고점 돌파 / 전저점 이탈 → swing_break; 지지/저항 반등 → swing_near.
  Prefer pivotBars:5 (not 1 or 2). Do NOT fake swings with compare high[offset:1].

Operand:
- overlay-band fields (boll/env/kc/dc): upper, middle, lower
  band params: boll/kc use mult, env uses pct, dc uses period only
- literal: { "source":"value", "value": 30 }
- price: { "source":"price", "field": "close"|"open"|"high"|"low"|"volume", "offset":0 }
  offset 1 = previous candle
- candle metric: { "source":"candle", "metric":"body_pct"|"upper_wick_pct"|"lower_wick_pct"|"change_pct"|"is_bullish", "offset":0 }
  Geometry: upper_wick = high-max(open,close); lower_wick = min(open,close)-low; body = |close-open|.
  body_pct/upper_wick_pct/lower_wick_pct are % of (high-low) and sum ≈ 100.
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
- FVG bullish long: { type:"fvg", side:"bullish", state:"in_zone", lookback:30 }
- RSI bullish divergence long: { type:"divergence", kind:"bullish", indicator:"rsi", lookback:40 }
- FVG + divergence combo: logic "all" with fvg in_zone AND divergence bullish
- 전고점 돌파 롱: { type:"swing_break", side:"long", pivotBars:5, lookback:60 }
- 전저점 이탈 숏: { type:"swing_break", side:"short", pivotBars:5, lookback:60 }
- 전저점 지지 롱: { type:"swing_near", side:"long", pivotBars:5, lookback:60, tolerancePct:0.5 }
- 전고점 저항 숏: { type:"swing_near", side:"short", pivotBars:5, lookback:60, tolerancePct:0.5 }
- Hammer + RSI: candle_pattern hammer AND rsi <= 30
- Bullish candle: { type:"candle_pattern", pattern:"bullish" } or compare is_bullish == 1
- Simple bullish long (양봉/캔들 상승 롱): entryRules.long = compare is_bullish == 1 OR close > open; set short.enabled=false
- Body > 60%: compare candle.body_pct > 60
- Long lower wick (긴 아랫꼬리): compare lower_wick_pct >= 60 AND body_pct <= 25
  OR candle_pattern hammer / pin_bar_bull
- Long upper wick (긴 윗꼬리): compare upper_wick_pct >= 60 AND body_pct <= 25
  OR candle_pattern shooting_star / pin_bar_bear
- Bullish trend-reversal long (하락→상승 전환 캔들 롱):
  entry = candle_pattern engulfing_bull OR hammer OR pin_bar_bull
  (optionally AND swing_near long / divergence bullish). Prefer when trendReversal.phase
  is potential_reversal|structure_break and signals.side=bullish.
- Bearish trend-reversal short (상승→하락 전환 캔들 숏):
  entry = candle_pattern engulfing_bear OR shooting_star OR pin_bar_bear
- Structure break after reversal (CHOCH 확인): combine reversal candle with swing_break
  in the new direction — do NOT treat every swing_break as a reversal candle.
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
- You receive market_context with OHLC candle tape and precomputed structure — NOT a chart image.
- recentCandles15: last 15 candles oldest→newest with o,h,l,c, dir, bodyPct, upperWickPct, lowerWickPct, shape, offset.
  ALWAYS read these wick fields for "꼬리/윗꼬리/아랫꼬리/핀바/해머/슈팅스타" or visual candle questions.
  Do NOT recompute wicks from OHLC alone — trust upperWickPct/lowerWickPct/shape.
  shape meanings: long_lower_wick (긴 아랫꼬리), long_upper_wick (긴 윗꼬리),
  lower_rejection / upper_rejection, full_body, balanced.
  Example: lowerWickPct=72, bodyPct=18, upperWickPct=10 → long lower wick (hammer/pin-bar style), NOT a full-body candle.
- structure.swings: CONFIRMED 전고점/전저점 (pivotBars=5 both sides). Quote lastSwingHigh/lastSwingLow
  prices and barsAgo in answers. Never invent swings from a single candle or from recentHigh/recentLow.
- structure.fvg / structure.divergence: FVG zones and RSI/MACD divergence flags.
- structure.trend: direction (bullish/bearish/sideways), HH/HL structure, EMA7/25/99 stack, ADX14.
  Use trend.direction + structure for trend questions — not recentHigh/recentLow alone.
- structure.trendReversal (CRITICAL for 추세전환 / 전환 캔들 / BoS / CHOCH):
  priorBias = prior trend from structure/MA (NOT a single candle direction).
  phase = continuation | early_warning | potential_reversal | bos | choch | unclear.
  bos[] = Break of Structure (with-trend swing break — continuation).
  choch[] = Change of Character (against-trend swing break — reversal).
  signals[] = BoS/CHOCH + against-trend reversal candles with offset, patterns, strength, reason.
  latest.againstTrend = true when the current bar is a reversal candle opposing priorBias.
  ALWAYS read trendReversal + strategyLog for "추세전환", "BoS", "CHOCH", "전환 캔들", "반전".
  Do NOT call a random opposite-color candle a trend reversal — need against priorBias +
  (engulfing/hammer/shooting/pin OR shape long_*_wick) ideally near swing high/low, OR CHOCH.
  BoS: bullish prior + close above lastSwingHigh, OR bearish prior + close below lastSwingLow.
  CHOCH: bullish prior + close below lastSwingLow, OR bearish prior + close above lastSwingHigh.
- strategyLog (CRITICAL human digest — same text shown in UI 전략 로그):
  lines/text summarize ALL recent candle patterns, BoS, CHOCH, reversal candles, and indicators.
  indicators block: rsi14, ema7/25/99, macd, atr14, adx14, stoch, active chart indicators.
  Prefer strategyLog.lines + indicators over recomputing from raw OHLC.
- recommendedStrategies (UI 추천 전략, winRate measured on THIS chart):
  When user says "추천전략 <id> 적용" or picks a recommended strategy, copy settings from
  recommendedStrategies.items[].settings EXACTLY into the patch (entryRules/exitRules/allowShort).
  Prefer items with ok:true (winRate >= 50%, trades >= 5). Do not invent different rules.
- For FVG/divergence/swing strategies use types fvg, divergence, swing_break, swing_near — do NOT fake with compare/cross alone.

CONDITION TYPE MAPPING (user request ALWAYS beats market_context — most common GPT mistake):
- NEVER auto-apply structure.fvg or structure.divergence from market_context unless the user EXPLICITLY asks for FVG/갭/페어밸류 or divergence/다이버전스.
- 볼린저/Bollinger/BB/밴드/Envelope/Keltner/Donchian + 진입/재진입/이탈/터치/하단/상단
  → type:"band_reentry" with the matching indicator (boll/env/kc/dc). NEVER type:"fvg".
- FVG/페어밸류/갭/gap/imbalance mentioned by user → type:"fvg" ONLY. NEVER band_reentry or swing for FVG requests.
- divergence/다이버전스 mentioned by user → type:"divergence" ONLY.
- 전고점/전저점/스윙/지지/저항/돌파 (swing pivots, NOT band touch) → swing_break or swing_near. NOT fvg, NOT band_reentry.
- 추세전환/전환 캔들/반전/장악형/해머·슈팅으로 전환 → candle_pattern (+ optional swing_near/divergence).
  Read structure.trendReversal first. NOT automatic fvg. NOT "any opposite candle".
- RSI/과매수/과매도/MACD/EMA cross → compare/cross_above/cross_below. NOT fvg unless user also asks for FVG.
- "이탈" alone does NOT mean swing — 볼린저 하단 이탈 = band_reentry long, 전저점 이탈 = swing_break short.
- hoveredCandle (optional): the exact candle the user is pointing at on the chart with full stats
  (o/h/l/c, changePct, rangePct=volatility, bodyPct, upperWickPct/lowerWickPct, volumeVsAvg20, barsAgo).
  When the user says "이 캔들", "지금 가리키는 봉", "커서에 있는 캔들" — answer about hoveredCandle, not the latest bar.
- timeframe: interval conversion math — minutesPerCandle, candlesPerHour, candlesPerDay.
  ALWAYS use it to convert time expressions to candle counts, e.g. on 15m chart "지난 1시간" = 4 candles,
  "지난 3시간" = 12 candles, on 5m chart "1시간" = 12 candles. Never assume 1 candle = 1 hour.
- Use market_context to calibrate thresholds: e.g. if rsi14 is 68, "과매수 롱" should use rsi >= 65-70 not <= 30.
- If recentTrend is bullish and volatility high (atrPct > 2), prefer wider stopLossPct or ATR-based exits.
- backtest_snapshot.current = performance of ACTIVE strategy on recent candles (Worker replay).
- If winRate < 40% with trades >= 10, suggest tightening entry filters.
- If trades < 5, strategy may be too strict — suggest loosening one filter.
- Mention market_insight and backtest_insight (1 sentence each) in JSON response.

Respond with JSON only — extended shape:
{
  "settings": { /* changed fields only — NEVER empty when user asks to create/apply a strategy */ },
  "changed_fields": ["entryRules"],
  "chart_interval": "1m"|"5m"|"15m"|"1h"|"4h"|"1d"|null,
  "summary": "Korean 1-3 sentences — what changed and why",
  "rules": "Korean HTML bullets",
  "market_insight": "Korean 1 sentence on current market vs strategy fit",
  "backtest_insight": "Korean 1 sentence on backtest result / expected improvement"
}

TIMEFRAME (봉 주기):
- If the user mentions 1분봉/5분봉/1시간봉 etc., set chart_interval to the matching id (1m, 5m, 15m, 1h, 4h, 1d).
- The system switches the chart to that interval automatically — do NOT leave settings empty just because of timeframe.
- ALWAYS return entryRules (and exitRules if needed) for strategy requests like "롱 진입", even when a timeframe is mentioned.

- If you cannot translate the user's strategy into valid entryRules, do NOT return empty settings — explain the problem in summary and still omit settings (the server will reject empty strategy applies).
- Never return entryRules with zero valid conditions when the user asked to create or change entry rules.
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
    if _request_api_key.get():
        return "user"
    if _runtime_api_key:
        return "runtime"
    if os.getenv("OPENAI_API_KEY", "").strip():
        return "env"
    return "none"


def _openai_models() -> tuple[str, str, str]:
    req = (_request_api_key.get() or "").strip().strip('"').strip("'")
    api_key = (req or _runtime_api_key or os.getenv("OPENAI_API_KEY", "")).strip().strip('"').strip("'")
    default_model = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
    complex_model = os.getenv("OPENAI_MODEL_COMPLEX", "gpt-4o").strip() or "gpt-4o"
    return api_key, default_model, complex_model


def _openai_config() -> tuple[str, str]:
    api_key, default_model, _complex_model = _openai_models()
    return api_key, default_model


def _model_routing_mode() -> str:
    return os.getenv("OPENAI_MODEL_ROUTING", "hybrid").strip().lower() or "hybrid"


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
    found_complex = False
    found_routing = False
    for line in lines:
        if line.startswith(f"{key_name}="):
            updated.append(f'{key_name}="{value}"')
            found_key = True
        elif line.startswith("OPENAI_MODEL="):
            found_model = True
            updated.append(line)
        elif line.startswith("OPENAI_MODEL_COMPLEX="):
            found_complex = True
            updated.append(line)
        elif line.startswith("OPENAI_MODEL_ROUTING="):
            found_routing = True
            updated.append(line)
        else:
            updated.append(line)

    if not found_key:
        if updated and updated[-1].strip():
            updated.append("")
        if not found_model:
            updated.append("OPENAI_MODEL=gpt-4o-mini")
        if not found_complex:
            updated.append("OPENAI_MODEL_COMPLEX=gpt-4o")
        if not found_routing:
            updated.append("OPENAI_MODEL_ROUTING=hybrid")
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


def ai_available(
    *,
    verify: bool = False,
    api_key: str | None = None,
    key_source: str | None = None,
    include_env_path: bool = False,
) -> dict[str, Any]:
    """Status for a specific key (per-user) or process/.env fallback."""
    if api_key is None:
        _reload_env()
        resolved, default_model, complex_model = _openai_models()
        source = key_source or _key_source()
    else:
        resolved = api_key.strip()
        _api, default_model, complex_model = _openai_models()
        # Prefer models from env even when using a user key
        source = key_source or "user"
    routing = _model_routing_mode()
    configured = bool(resolved)
    status = {
        "available": False,
        "configured": configured,
        "verified": False,
        "authenticated": configured,
        "chatReady": False,
        "model": default_model,
        "modelComplex": complex_model,
        "modelRouting": routing,
        "keyPreview": mask_api_key(resolved) if configured else None,
        "keySource": source if configured else "none",
        "envPath": str(_env_path()) if include_env_path else None,
        "checkedAt": None,
        "message": "이 계정에 OpenAI API Key가 없습니다." if not configured else "키가 저장되어 있습니다.",
        "errorCode": None,
    }

    if verify and configured:
        test_result = test_openai_api_key(resolved)
        status.update(
            {
                "available": test_result["verified"],
                "verified": test_result["verified"],
                "authenticated": test_result.get("errorCode") != "invalid_api_key",
                "chatReady": test_result["verified"],
                "message": test_result["message"],
                "errorCode": test_result.get("errorCode"),
                "checkedAt": test_result.get("checkedAt"),
            }
        )
    elif configured:
        status["available"] = True
        status["verified"] = True
        status["chatReady"] = True
        status["message"] = "이 계정에 OpenAI API Key가 저장되어 있습니다."

    return status


def configure_openai_api_key(api_key: str, *, persist_env: bool = True) -> dict[str, Any]:
    validate_api_key_format(api_key)
    test_result = test_openai_api_key(api_key)
    if not test_result["verified"]:
        raise ValueError(test_result["message"])

    if persist_env:
        persist_openai_api_key(api_key)
        status = ai_available(api_key=api_key, key_source="env", include_env_path=True)
    else:
        status = ai_available(api_key=api_key, key_source="user", include_env_path=False)
    status["message"] = "OpenAI API 키가 저장되고 인증되었습니다."
    status["verified"] = True
    status["available"] = True
    status["chatReady"] = True
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


_STRATEGY_RULE_MARKERS = (
    "진입", "조건", "entryrules", "entry", "롱", "숏", "long", "short",
    "rsi", "macd", "ema", "sma", "볼린저", "bollinger", "boll", "스토캐스틱", "stoch",
    "크로스", "cross", "재진입", "이탈", "밴드", "band", "패턴", "pattern",
    "candle", "봉", "지표", "indicator", "슬롯", "전략", "strategy",
    "과매수", "과매도", "골든", "데드", "다이버", "삭제", "제거", "비활성",
    "kdj", "cci", "atr", "adx", "envelope", "keltner", "donchian", "해머", "장악",
    "fvg", "갭", "페어밸류", "다이버",
)

_RISK_ONLY_MARKERS = (
    "손절", "익절", "레버리지", "leverage", "stoploss", "takeprofit",
    "손익비", "riskpertrade", "maxaccountloss", "pollseconds",
)

_APPLY_MARKERS = ("적용", "apply", "설정해", "만들어", "추가해", "넣어", "바꿔줘", "변경해")
_RULE_PATCH_KEYS = frozenset({"entryRules", "exitRules", "strategySlots"})
_DELETE_MARKERS = ("삭제", "제거", "비활성", "없애", "초기화", "지워", "없애줘", "빼줘")

_STRATEGY_APPLY_ERROR = (
    "전략을 이해하지 못했습니다. 진입 조건을 더 구체적으로 설명해 주세요.\n"
    "예: RSI 30 이하 롱, 양봉일 때 롱, EMA 12가 26 상향 돌파 시 롱"
)
_ENTRY_RULES_INVALID_ERROR = (
    "진입 조건이 비어 있거나 시스템이 이해할 수 없는 형식입니다.\n"
    "지표·캔들·롱/숏 방향과 수치를 포함해 다시 설명해 주세요."
)
_STRATEGY_NOT_IN_PATCH_ERROR = (
    "요청하신 진입 조건이 설정에 반영되지 않았습니다.\n"
    "롱/숏 진입 조건을 조금 더 구체적으로 다시 설명해 주세요."
)


def _looks_like_strategy_delete_request(prompt: str) -> bool:
    lower = (prompt or "").lower()
    return any(m in lower for m in _DELETE_MARKERS)


def _looks_like_strategy_apply_request(prompt: str) -> bool:
    if _looks_like_question_only(prompt):
        return False
    if _looks_like_risk_only_edit(prompt):
        return False
    if _looks_like_strategy_delete_request(prompt):
        return False
    lower = (prompt or "").lower()
    return any(m in lower for m in _STRATEGY_RULE_MARKERS) or any(m in lower for m in _APPLY_MARKERS)


def _validate_strategy_apply_or_raise(
    prompt: str,
    patch: dict[str, Any],
    merged: StrategySettings,
    *,
    strategy_slot_target: str | None = None,
) -> None:
    """Reject strategy-apply prompts that would produce empty or invalid rules."""
    if not _looks_like_strategy_apply_request(prompt):
        return

    if not patch:
        raise ValueError(_STRATEGY_APPLY_ERROR)

    patch_keys = set(patch.keys())
    if not patch_keys.intersection(_RULE_PATCH_KEYS):
        raise ValueError(_STRATEGY_NOT_IN_PATCH_ERROR)

    if "entryRules" in patch and not entry_rules_have_signals(patch.get("entryRules")):
        raise ValueError(_ENTRY_RULES_INVALID_ERROR)

    if "strategySlots" in patch:
        slots = patch.get("strategySlots")
        if isinstance(slots, list) and slots:
            if not strategy_slots_have_signals(slots) and "entryRules" not in patch:
                raise ValueError(_ENTRY_RULES_INVALID_ERROR)

    if strategy_slot_target == "__new__":
        slot_rules_ok = strategy_slots_have_signals(merged.strategySlots)
        top_ok = entry_rules_have_signals(merged.entryRules)
        if not slot_rules_ok and not top_ok:
            raise ValueError(_ENTRY_RULES_INVALID_ERROR)


def _looks_like_question_only(prompt: str) -> bool:
    text = (prompt or "").strip()
    lower = text.lower()
    if looks_like_research_request(prompt) and not any(m in lower for m in _APPLY_MARKERS):
        return True
    question_hints = ("?", "뭐야", "무엇", "설명", "알려줘", "추천", "일까", "할까", "인가요")
    if any(h in lower for h in question_hints):
        if not any(m in lower for m in _STRATEGY_RULE_MARKERS):
            if not any(m in lower for m in ("손절", "익절", "적용", "바꿔", "설정", "만들")):
                return True
    return False


def _looks_like_risk_only_edit(prompt: str) -> bool:
    lower = (prompt or "").lower()
    has_risk = any(m in lower for m in _RISK_ONLY_MARKERS)
    has_strategy = any(m in lower for m in _STRATEGY_RULE_MARKERS)
    if has_risk and not has_strategy:
        return True
    if _looks_like_follow_up_edit(prompt) and has_risk and not has_strategy:
        return True
    return False


def select_openai_model(
    prompt: str,
    *,
    current_settings: dict[str, Any] | None = None,
    web_research: list[dict[str, Any]] | None = None,
    force_mini: bool = False,
) -> tuple[str, str]:
    """Return (model_name, route_reason). Uses mini by default; 4o for hard strategy edits."""
    _api_key, default_model, complex_model = _openai_models()
    if force_mini:
        return default_model, "free_tier_mini"
    routing = _model_routing_mode()
    if routing in {"off", "false", "0", "single", "mini", "default"}:
        return default_model, "single"
    if routing in {"complex", "4o", "all", "always"}:
        return complex_model, "all_complex"

    text = (prompt or "").lower()

    if _looks_like_question_only(prompt):
        return default_model, "question"

    if web_research and looks_like_research_request(prompt):
        if any(m in text for m in _APPLY_MARKERS) or any(m in text for m in _STRATEGY_RULE_MARKERS):
            return complex_model, "research_apply"
        return default_model, "research_question"

    if _looks_like_risk_only_edit(prompt):
        return default_model, "risk_only"

    if any(m in text for m in _STRATEGY_RULE_MARKERS):
        return complex_model, "strategy_rules"

    if _looks_like_follow_up_edit(prompt):
        return complex_model, "follow_up"

    settings = current_settings or {}
    if settings.get("entryRules") or settings.get("strategySlots"):
        if len((prompt or "").strip()) > 8:
            return complex_model, "existing_strategy"

    return default_model, "default"


def _call_openai(
    prompt: str,
    current: StrategySettings,
    indicator_catalog: str = "",
    history: list[dict[str, str]] | None = None,
    market_context: dict[str, Any] | None = None,
    backtest_snapshot: dict[str, Any] | None = None,
    web_research: list[dict[str, Any]] | None = None,
    *,
    model: str | None = None,
    strategy_slot_target: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any]:
    token = None
    if api_key:
        token = _request_api_key.set(api_key.strip())
    try:
        resolved, default_model, _complex_model = _openai_models()
        if not resolved:
            raise ValueError(
                "OPENAI_API_KEY가 설정되지 않았습니다. OpenAI API Key 입력란에서 키를 저장하세요."
            )
        chosen_model = model or default_model
        return _call_openai_with_key(
            prompt,
            current,
            indicator_catalog,
            history,
            market_context,
            backtest_snapshot,
            web_research,
            model=chosen_model,
            strategy_slot_target=strategy_slot_target,
            api_key=resolved,
        )
    finally:
        if token is not None:
            _request_api_key.reset(token)


def _call_openai_with_key(
    prompt: str,
    current: StrategySettings,
    indicator_catalog: str,
    history: list[dict[str, str]] | None,
    market_context: dict[str, Any] | None,
    backtest_snapshot: dict[str, Any] | None,
    web_research: list[dict[str, Any]] | None,
    *,
    model: str,
    strategy_slot_target: str | None,
    api_key: str,
) -> dict[str, Any]:
    chosen_model = model

    user_content = json.dumps(
        {
            "current_settings": current.model_dump(),
            "strategy_slot_target": strategy_slot_target,
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
        "model": chosen_model,
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


_VALID_CHART_INTERVALS = frozenset({"1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"})

_INTERVAL_ALIASES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("1m", ("1분봉", "1분", "1m")),
    ("3m", ("3분봉", "3분", "3m")),
    ("5m", ("5분봉", "5분", "5m")),
    ("15m", ("15분봉", "15분", "15m")),
    ("30m", ("30분봉", "30분", "30m")),
    ("1h", ("1시간봉", "1시간", "한시간", "1h")),
    ("4h", ("4시간봉", "4시간", "4h")),
    ("1d", ("1일봉", "일봉", "1일", "1d")),
)


def _parse_chart_interval(prompt: str) -> str | None:
    text = (prompt or "").lower()
    for key, aliases in _INTERVAL_ALIASES:
        if any(alias in text for alias in aliases):
            return key
    return None


def _normalize_chart_interval(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip().lower()
    return cleaned if cleaned in _VALID_CHART_INTERVALS else None


_BAND_INDICATOR_MARKERS: tuple[tuple[str, str], ...] = (
    ("boll", ("볼린저", "bollinger", "boll", "bb", "볼밴")),
    ("env", ("envelope", "엔벨로프", "엔벨")),
    ("kc", ("keltner", "켈트너", "켈트")),
    ("dc", ("donchian", "돈치안", "돈치")),
)
_FVG_MARKERS = ("fvg", "페어밸류", "fair value", "fairvalue", "갭", "gap", "공정가치", "imbalance")
_DIVERGENCE_MARKERS = ("다이버", "divergence", "diver")
_SWING_MARKERS = (
    "전고점", "전저점", "전고", "전저", "스윙", "swing",
    "지지", "저항", "돌파", "피봇", "pivot",
)
_STRATEGY_CONTEXT_MARKERS = (
    "진입", "롱", "숏", "long", "short", "매수", "매도", "전략", "조건",
    "재진입", "이탈", "터치", "밴드", "하단", "상단", "들어", "안으로", "적용", "설정",
)


def _prompt_text(prompt: str) -> str:
    return (prompt or "").lower()


def _prompt_mentions_band(prompt: str) -> bool:
    text = _prompt_text(prompt)
    return any(k in text for markers in _BAND_INDICATOR_MARKERS for k in markers[1])


def _prompt_band_indicator(prompt: str) -> str:
    text = _prompt_text(prompt)
    for indicator, markers in _BAND_INDICATOR_MARKERS:
        if any(k in text for k in markers):
            return indicator
    return "boll"


def _prompt_wants_band_strategy(prompt: str) -> bool:
    text = _prompt_text(prompt)
    if not _prompt_mentions_band(prompt):
        return False
    return any(k in text for k in _STRATEGY_CONTEXT_MARKERS)


def _prompt_wants_fvg(prompt: str) -> bool:
    text = _prompt_text(prompt)
    return any(k in text for k in _FVG_MARKERS)


def _prompt_wants_divergence(prompt: str) -> bool:
    text = _prompt_text(prompt)
    return any(k in text for k in _DIVERGENCE_MARKERS)


def _prompt_wants_swing(prompt: str) -> bool:
    if _prompt_wants_band_strategy(prompt) or _prompt_wants_fvg(prompt) or _prompt_wants_divergence(prompt):
        return False
    text = _prompt_text(prompt)
    swing_kw = any(k in text for k in _SWING_MARKERS)
    apply_kw = any(k in text for k in _STRATEGY_CONTEXT_MARKERS)
    return swing_kw and apply_kw


def _prompt_side(prompt: str) -> str | None:
    text = _prompt_text(prompt)
    long_kw = any(k in text for k in ("롱", "long", "매수"))
    short_kw = any(k in text for k in ("숏", "short", "매도"))
    if long_kw and not short_kw:
        return "long"
    if short_kw and not long_kw:
        return "short"
    return None


def _parse_risk_reward_ratio(prompt: str, default: float = 1.5) -> float:
    text = _prompt_text(prompt)
    if re.search(r"1\.5\s*배|1\.5\s*:?\s*1|손절.*?1\.5|1\.5\s*배", text):
        return 1.5
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:배|:1|r\b)", text)
    if match:
        try:
            return float(match.group(1))
        except ValueError:
            pass
    return default


def _entry_condition_types(rules: Any) -> set[str]:
    types: set[str] = set()
    if not isinstance(rules, dict):
        return types
    for side in ("long", "short"):
        group = rules.get(side)
        if not isinstance(group, dict):
            continue
        for cond in group.get("conditions") or []:
            if isinstance(cond, dict) and cond.get("type"):
                types.add(str(cond["type"]))
    return types


def _has_condition_type(rules: Any, cond_type: str) -> bool:
    return cond_type in _entry_condition_types(rules)


def _looks_like_strategy_type_change(prompt: str) -> bool:
    text = _prompt_text(prompt)
    return any(k in text for k in ("으로 바꿔", "로 바꿔", "전략으로", "진입 조건", "새 전략", "처음부터"))


def _bullish_candle_long_patch() -> dict[str, Any]:
    return {
        "allowShort": False,
        "entryRules": {
            "long": {
                "enabled": True,
                "logic": "all",
                "conditions": [{
                    "type": "compare",
                    "left": {"source": "candle", "metric": "is_bullish", "offset": 0},
                    "op": "==",
                    "right": {"source": "value", "value": 1},
                }],
            },
            "short": {"enabled": False, "logic": "all", "conditions": []},
        },
    }


def _looks_like_bullish_candle_long(prompt: str) -> bool:
    text = (prompt or "").lower()
    long_side = any(k in text for k in ("롱", "long", "매수", "진입"))
    candle_kw = any(k in text for k in ("캔들", "봉", "양봉", "상승", "bullish", "올라"))
    return long_side and candle_kw


def _has_bullish_entry(rules: Any) -> bool:
    if not isinstance(rules, dict):
        return False
    long_group = rules.get("long")
    if not isinstance(long_group, dict):
        return False
    for cond in long_group.get("conditions") or []:
        if not isinstance(cond, dict):
            continue
        if cond.get("type") == "candle_pattern" and str(cond.get("pattern", "")).lower() in {
            "bullish", "engulfing_bull",
        }:
            return True
        left = cond.get("left")
        if isinstance(left, dict) and left.get("metric") == "is_bullish":
            return True
        if cond.get("type") == "compare" and isinstance(left, dict):
            if left.get("source") == "price" and left.get("field") == "close":
                right = cond.get("right")
                if isinstance(right, dict) and right.get("field") == "open":
                    return True
    return False


def _band_reentry_patch(
    *,
    side: str = "long",
    indicator: str = "boll",
    ratio: float = 1.5,
    long_only: bool | None = None,
) -> dict[str, Any]:
    side = "short" if side == "short" else "long"
    indicator = indicator if indicator in {"boll", "env", "kc", "dc"} else "boll"
    params: dict[str, Any] = {"period": 20, "mult": 2}
    if indicator == "env":
        params = {"period": 20, "pct": 0.1}
    elif indicator == "dc":
        params = {"period": 20}

    if long_only is True:
        enable_long, enable_short = True, False
    elif side == "short":
        enable_long, enable_short = False, True
    else:
        enable_long, enable_short = True, False

    patch: dict[str, Any] = {
        "allowShort": enable_short,
        "entryRules": {
            "long": {
                "enabled": enable_long,
                "logic": "all",
                "conditions": [{
                    "type": "band_reentry",
                    "side": "long",
                    "indicator": indicator,
                    "params": params,
                }] if enable_long else [],
            },
            "short": {
                "enabled": enable_short,
                "logic": "all",
                "conditions": [{
                    "type": "band_reentry",
                    "side": "short",
                    "indicator": indicator,
                    "params": params,
                }] if enable_short else [],
            },
        },
        "exitRules": {},
    }

    if enable_long:
        patch["exitRules"]["long"] = {
            "stopLoss": {"type": "candle_extreme", "field": "low", "offset": 1},
            "takeProfit": {"type": "risk_reward", "ratio": ratio},
        }
    if enable_short:
        patch["exitRules"]["short"] = {
            "stopLoss": {"type": "candle_extreme", "field": "high", "offset": 1},
            "takeProfit": {"type": "risk_reward", "ratio": ratio},
        }
    return patch


def _bollinger_reentry_long_patch(ratio: float = 1.5) -> dict[str, Any]:
    return _band_reentry_patch(side="long", indicator="boll", ratio=ratio, long_only=True)


def _fvg_entry_patch(prompt: str) -> dict[str, Any]:
    side = _prompt_side(prompt)
    long_enabled = side != "short"
    short_enabled = side != "long"
    state = "in_zone"
    text = _prompt_text(prompt)
    if any(k in text for k in ("채워", "filled", "메움")):
        state = "filled"
    elif any(k in text for k in ("존재", "present", "있을")):
        state = "present"

    return {
        "allowShort": short_enabled,
        "entryRules": {
            "long": {
                "enabled": long_enabled,
                "logic": "all",
                "conditions": [{
                    "type": "fvg",
                    "side": "bullish" if long_enabled else "bearish",
                    "state": state,
                    "lookback": 30,
                }] if long_enabled else [],
            },
            "short": {
                "enabled": short_enabled,
                "logic": "all",
                "conditions": [{
                    "type": "fvg",
                    "side": "bearish" if short_enabled else "bullish",
                    "state": state,
                    "lookback": 30,
                }] if short_enabled else [],
            },
        },
        "exitRules": {
            "long": {
                "stopLoss": {"type": "candle_extreme", "field": "low", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
            "short": {
                "stopLoss": {"type": "candle_extreme", "field": "high", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
        },
    }


def _divergence_entry_patch(prompt: str) -> dict[str, Any]:
    side = _prompt_side(prompt)
    long_enabled = side != "short"
    short_enabled = side != "long"
    text = _prompt_text(prompt)
    kind = "bearish" if "bear" in text or "숏" in text or "하락" in text else "bullish"
    if side == "short":
        kind = "bearish"
    elif side == "long":
        kind = "bullish"
    indicator = "macd" if "macd" in text else "rsi"

    return {
        "allowShort": short_enabled,
        "entryRules": {
            "long": {
                "enabled": long_enabled,
                "logic": "all",
                "conditions": [{
                    "type": "divergence",
                    "kind": "bullish",
                    "indicator": indicator,
                    "lookback": 40,
                    "period": 14,
                }] if long_enabled else [],
            },
            "short": {
                "enabled": short_enabled,
                "logic": "all",
                "conditions": [{
                    "type": "divergence",
                    "kind": "bearish",
                    "indicator": indicator,
                    "lookback": 40,
                    "period": 14,
                }] if short_enabled else [],
            },
        },
        "exitRules": {
            "long": {
                "stopLoss": {"type": "candle_extreme", "field": "low", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
            "short": {
                "stopLoss": {"type": "candle_extreme", "field": "high", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
        },
    }


def _looks_like_bb_reentry_long(prompt: str) -> bool:
    return _prompt_wants_band_strategy(prompt)


def _has_band_reentry(rules: Any) -> bool:
    return _has_condition_type(rules, "band_reentry")


def _has_swing_entry(rules: Any) -> bool:
    if not isinstance(rules, dict):
        return False
    for side in ("long", "short"):
        group = rules.get(side)
        if not isinstance(group, dict):
            continue
        for cond in group.get("conditions") or []:
            if isinstance(cond, dict) and cond.get("type") in {"swing_break", "swing_near"}:
                return True
    return False


def _looks_like_swing_strategy(prompt: str) -> bool:
    return _prompt_wants_swing(prompt)


def _looks_like_swing_breakout(prompt: str) -> bool:
    text = _prompt_text(prompt)
    return any(k in text for k in ("돌파", "breakout", "break", "깨", "뚫", "이탈"))


def _swing_breakout_patch() -> dict[str, Any]:
    """전고점 돌파 롱 / 전저점 이탈 숏 — confirmed pivots only (pivotBars=5)."""
    return {
        "allowShort": True,
        "entryRules": {
            "long": {
                "enabled": True,
                "logic": "all",
                "conditions": [{
                    "type": "swing_break",
                    "side": "long",
                    "pivotBars": 5,
                    "lookback": 60,
                }],
            },
            "short": {
                "enabled": True,
                "logic": "all",
                "conditions": [{
                    "type": "swing_break",
                    "side": "short",
                    "pivotBars": 5,
                    "lookback": 60,
                }],
            },
        },
        "exitRules": {
            "long": {
                "stopLoss": {"type": "candle_extreme", "field": "low", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
            "short": {
                "stopLoss": {"type": "candle_extreme", "field": "high", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
        },
    }


def _swing_bounce_patch() -> dict[str, Any]:
    """전저점 지지 롱 / 전고점 저항 숏 — touch confirmed swing within 0.5%."""
    return {
        "allowShort": True,
        "entryRules": {
            "long": {
                "enabled": True,
                "logic": "all",
                "conditions": [{
                    "type": "swing_near",
                    "side": "long",
                    "pivotBars": 5,
                    "lookback": 60,
                    "tolerancePct": 0.5,
                }],
            },
            "short": {
                "enabled": True,
                "logic": "all",
                "conditions": [{
                    "type": "swing_near",
                    "side": "short",
                    "pivotBars": 5,
                    "lookback": 60,
                    "tolerancePct": 0.5,
                }],
            },
        },
        "exitRules": {
            "long": {
                "stopLoss": {"type": "candle_extreme", "field": "low", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
            "short": {
                "stopLoss": {"type": "candle_extreme", "field": "high", "offset": 1},
                "takeProfit": {"type": "risk_reward", "ratio": 1.5},
            },
        },
    }


def _merge_template_patch(
    merged: dict[str, Any],
    tmpl: dict[str, Any],
    *,
    overwrite_exit: bool = False,
) -> dict[str, Any]:
    out = dict(merged)
    if tmpl.get("entryRules"):
        out["entryRules"] = tmpl["entryRules"]
    if tmpl.get("exitRules") and (overwrite_exit or not out.get("exitRules")):
        out["exitRules"] = tmpl["exitRules"]
    if "allowShort" in tmpl:
        out["allowShort"] = tmpl["allowShort"]
    return out


def _reconcile_patch_intent(
    prompt: str,
    patch: dict[str, Any],
    *,
    follow_up: bool,
) -> dict[str, Any]:
    """Replace GPT output when user intent clearly conflicts with condition types."""
    if follow_up and not _looks_like_strategy_type_change(prompt):
        return patch

    entry_rules = patch.get("entryRules")
    types = _entry_condition_types(entry_rules)
    ratio = _parse_risk_reward_ratio(prompt)

    if _prompt_wants_band_strategy(prompt):
        indicator = _prompt_band_indicator(prompt)
        side = _prompt_side(prompt) or "long"
        long_only = _prompt_side(prompt) == "long" or (
            _prompt_side(prompt) is None and any(k in _prompt_text(prompt) for k in ("롱", "long", "매수"))
        )
        wrong = types & {"fvg", "divergence", "swing_break", "swing_near"}
        if wrong or not _has_band_reentry(entry_rules):
            tmpl = _band_reentry_patch(
                side=side,
                indicator=indicator,
                ratio=ratio,
                long_only=True if long_only else None,
            )
            logger.info(
                "Intent reconcile: band strategy requested but GPT returned %s — applying band_reentry",
                sorted(types) or "empty",
            )
            return _merge_template_patch(patch, tmpl, overwrite_exit=True)

    if _prompt_wants_fvg(prompt):
        wrong = types & {"band_reentry", "divergence", "swing_break", "swing_near"}
        if wrong or not _has_condition_type(entry_rules, "fvg"):
            logger.info(
                "Intent reconcile: FVG requested but GPT returned %s — applying fvg",
                sorted(types) or "empty",
            )
            return _merge_template_patch(patch, _fvg_entry_patch(prompt), overwrite_exit=True)

    if _prompt_wants_divergence(prompt):
        wrong = types & {"band_reentry", "fvg", "swing_break", "swing_near"}
        if wrong or not _has_condition_type(entry_rules, "divergence"):
            logger.info(
                "Intent reconcile: divergence requested but GPT returned %s — applying divergence",
                sorted(types) or "empty",
            )
            return _merge_template_patch(patch, _divergence_entry_patch(prompt), overwrite_exit=True)

    if _prompt_wants_swing(prompt):
        wrong = types & {"fvg", "divergence", "band_reentry"}
        if wrong or not _has_swing_entry(entry_rules):
            tmpl = (
                _swing_breakout_patch()
                if _looks_like_swing_breakout(prompt)
                else _swing_bounce_patch()
            )
            logger.info(
                "Intent reconcile: swing requested but GPT returned %s — applying swing template",
                sorted(types) or "empty",
            )
            return _merge_template_patch(patch, tmpl, overwrite_exit=True)

    return patch


_RECOMMENDED_ID_RE = re.compile(r"추천전략\s+([a-z0-9\-]+)", re.IGNORECASE)


def _recommended_preset_patch(
    prompt: str,
    market_context: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Return exact settings from client-measured recommendedStrategies when id is named."""
    match = _RECOMMENDED_ID_RE.search(prompt or "")
    if not match:
        return None
    rid = match.group(1).strip().lower()
    block = (market_context or {}).get("recommendedStrategies") or {}
    for item in block.get("items") or []:
        if not isinstance(item, dict):
            continue
        if str(item.get("id", "")).strip().lower() != rid:
            continue
        settings = item.get("settings")
        if isinstance(settings, dict) and settings:
            out = {
                k: v for k, v in settings.items()
                if k in {
                    "entryRules", "exitRules", "allowShort",
                    "stopLossPct", "takeProfitPct",
                    "rsiPeriod", "rsiOversold", "rsiOverbought",
                    "leverage", "riskPerTradePct",
                }
            }
            return out or None
    return None


def _apply_rule_templates(
    prompt: str,
    patch: dict[str, Any],
    history: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    merged = dict(patch)
    follow_up = bool(history and _looks_like_follow_up_edit(prompt))
    type_change = _looks_like_strategy_type_change(prompt)

    if _looks_like_bullish_candle_long(prompt) and (not follow_up or type_change):
        if not _has_bullish_entry(merged.get("entryRules")):
            tmpl = _bullish_candle_long_patch()
            merged["entryRules"] = tmpl["entryRules"]
            if "allowShort" not in merged:
                merged["allowShort"] = False

    if _looks_like_bb_reentry_long(prompt) and (not follow_up or type_change):
        ratio = _parse_risk_reward_ratio(prompt)
        side = _prompt_side(prompt) or "long"
        indicator = _prompt_band_indicator(prompt)
        long_only = _prompt_side(prompt) == "long" or (
            _prompt_side(prompt) is None
            and any(k in _prompt_text(prompt) for k in ("롱", "long", "매수"))
            and not any(k in _prompt_text(prompt) for k in ("숏", "short", "매도"))
        )
        tmpl = _band_reentry_patch(
            side=side,
            indicator=indicator,
            ratio=ratio,
            long_only=True if long_only else None,
        )
        if not _has_band_reentry(merged.get("entryRules")):
            merged["entryRules"] = tmpl["entryRules"]
        if not merged.get("exitRules"):
            merged["exitRules"] = tmpl["exitRules"]
        if "allowShort" not in merged:
            merged["allowShort"] = tmpl.get("allowShort", False)

    if _looks_like_swing_strategy(prompt) and (not follow_up or type_change):
        tmpl = (
            _swing_breakout_patch()
            if _looks_like_swing_breakout(prompt)
            else _swing_bounce_patch()
        )
        if not _has_swing_entry(merged.get("entryRules")):
            merged["entryRules"] = tmpl["entryRules"]
            if not merged.get("exitRules"):
                merged["exitRules"] = tmpl["exitRules"]
            if "allowShort" not in merged:
                merged["allowShort"] = tmpl.get("allowShort", True)

    if _prompt_wants_fvg(prompt) and (not follow_up or type_change):
        if not _has_condition_type(merged.get("entryRules"), "fvg"):
            merged = _merge_template_patch(merged, _fvg_entry_patch(prompt))

    if _prompt_wants_divergence(prompt) and (not follow_up or type_change):
        if not _has_condition_type(merged.get("entryRules"), "divergence"):
            merged = _merge_template_patch(merged, _divergence_entry_patch(prompt))

    return _reconcile_patch_intent(prompt, merged, follow_up=follow_up)


def interpret_strategy(
    prompt: str,
    current_settings: dict[str, Any] | None = None,
    history: list[dict[str, Any]] | None = None,
    *,
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    market_context: dict[str, Any] | None = None,
    backtest_snapshot: dict[str, Any] | None = None,
    api_key: str | None = None,
    user_id: int | None = None,
    force_mini: bool = False,
) -> dict[str, Any]:
    raw_settings = dict(current_settings or {})
    indicator_catalog = str(raw_settings.pop("indicatorCatalog", "") or "")
    strategy_slot_target = raw_settings.pop("strategySlotTarget", None)
    current = StrategySettings.model_validate(clamp_numeric_fields(raw_settings))

    merged_history = merge_histories(history, load_turns(user_id), user_id=user_id)
    market = build_market_context(
        symbol=symbol,
        interval=interval,
        client_context=market_context,
        use_testnet=True,
    )

    append_turn(role="user", content=prompt.strip(), user_id=user_id)

    web_research: list[dict[str, Any]] = []
    if looks_like_research_request(prompt):
        try:
            web_research = research_strategies(prompt.strip())
        except Exception:
            logger.exception("Web strategy research failed — continuing without it")

    chosen_model, route_reason = select_openai_model(
        prompt.strip(),
        current_settings=raw_settings,
        web_research=web_research,
        force_mini=force_mini,
    )
    logger.info("Strategy AI route: model=%s reason=%s user=%s", chosen_model, route_reason, user_id)

    raw = _call_openai(
        prompt.strip(),
        current,
        indicator_catalog,
        merged_history,
        market,
        backtest_snapshot,
        web_research,
        model=chosen_model,
        strategy_slot_target=strategy_slot_target,
        api_key=api_key,
    )

    patch = raw.get("settings") or {}
    if not isinstance(patch, dict):
        patch = {}

    chart_interval = _normalize_chart_interval(raw.get("chart_interval")) or _parse_chart_interval(prompt.strip())

    changed_fields = raw.get("changed_fields")
    if not isinstance(changed_fields, list):
        changed_fields = list(patch.keys())

    # Rule templates also run on empty patches — e.g. "1분봉 캔들 상승시 롱 진입".
    patch = _apply_rule_templates(prompt.strip(), patch, merged_history)
    # UI recommended strategies: force exact settings when user names an id.
    rec_patch = _recommended_preset_patch(prompt.strip(), market)
    if rec_patch:
        patch = {**patch, **rec_patch}
        rec_match = _RECOMMENDED_ID_RE.search(prompt.strip())
        rec_id = rec_match.group(1).lower() if rec_match else ""
        rec_name = next(
            (
                str(it.get("name"))
                for it in ((market.get("recommendedStrategies") or {}).get("items") or [])
                if isinstance(it, dict) and str(it.get("id", "")).lower() == rec_id
            ),
            rec_id or "추천 전략",
        )
        summary_hint = f"추천 전략 «{rec_name}» 적용"
        if not str(raw.get("summary") or "").strip():
            raw["summary"] = summary_hint
        elif "추천" not in str(raw.get("summary")):
            raw["summary"] = f"{summary_hint}. {raw.get('summary')}"
    if patch and not changed_fields:
        changed_fields = list(patch.keys())
    changed_fields = [f for f in changed_fields if isinstance(f, str) and f in patch]

    if patch:
        merged = current.merged(patch)
        if not changed_fields:
            changed_fields = list(patch.keys())
    else:
        merged = current

    _validate_strategy_apply_or_raise(
        prompt.strip(),
        patch,
        merged,
        strategy_slot_target=strategy_slot_target,
    )

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
        user_id=user_id,
        meta={
            "changed_fields": changed_fields,
            "backtest": bt_meta,
            "patch_keys": list(patch.keys()),
            "model": chosen_model,
            "route_reason": route_reason,
        },
    )

    logger.info("Strategy AI applied patch: %s (model=%s)", patch, chosen_model)

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
        "model": chosen_model,
        "route_reason": route_reason,
        "chart_interval": chart_interval,
    }


_reload_env()
if os.getenv("OPENAI_API_KEY", "").strip():
    test_openai_api_key()
