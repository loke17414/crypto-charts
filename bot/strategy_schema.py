"""Pydantic schema for futures entry strategy settings (web UI + GPT)."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


# Alias map kept in sync with js/strategy-engine.js INDICATOR_ALIASES so GPT
# output normalizes identically on both sides (prevents JS/Python drift).
INDICATOR_ALIASES: dict[str, str] = {
    "sma": "ma",
    "bb": "boll",
    "bbands": "boll",
    "bollinger": "boll",
    "envelope": "env",
    "envelopes": "env",
    "keltner": "kc",
    "donchian": "dc",
    "stochrsi": "stoch",
    "williamsr": "wr",
    "williams_r": "wr",
    "sar": "psar",
    "parabolicsar": "psar",
    "parabolic_sar": "psar",
}

# Overlay-band indicators share upper/middle/lower outputs but differ in params.
BAND_PARAM_DEFAULTS: dict[str, dict[str, float]] = {
    "boll": {"period": 20, "mult": 2},
    "env": {"period": 20, "pct": 0.1},
    "kc": {"period": 20, "mult": 2},
    "dc": {"period": 20},
}


def _resolve_indicator_id(indicator: Any) -> str:
    raw = str(indicator or "").lower().strip()
    return INDICATOR_ALIASES.get(raw, raw)


# Per-indicator param name synonyms — kept in sync with js/strategy-engine.js
# PARAM_SYNONYMS so GPT's natural param names map to the real compute keys.
PARAM_SYNONYMS: dict[str, dict[str, str]] = {
    "macd": {"fastperiod": "fast", "slowperiod": "slow", "signalperiod": "signal", "fastlength": "fast", "slowlength": "slow", "signallength": "signal"},
    "kdj": {"period": "n", "length": "n", "k": "m1", "d": "m2", "kperiod": "n", "dperiod": "m1", "signal": "m2"},
    "stoch": {"period": "kPeriod", "length": "kPeriod", "k": "kPeriod", "d": "dPeriod", "kperiod": "kPeriod", "dperiod": "dPeriod", "smooth": "dPeriod"},
    "boll": {"length": "period", "stddev": "mult", "std": "mult", "deviation": "mult", "dev": "mult", "k": "mult", "multiplier": "mult"},
    "env": {"length": "period", "percent": "pct", "percentage": "pct", "deviation": "pct"},
    "kc": {"length": "period", "atr": "mult", "multiplier": "mult", "deviation": "mult"},
    "dc": {"length": "period"},
    "psar": {"acceleration": "step", "af": "step", "maximum": "max", "maxaf": "max"},
    "ichimoku": {"conversion": "tenkan", "base": "kijun", "span": "senkou", "spanb": "senkou"},
}

FIELD_SYNONYMS: dict[str, dict[str, str]] = {
    "macd": {"dif": "macd", "dea": "signal", "line": "macd", "hist": "histogram", "value": "macd", "main": "macd"},
    "kdj": {"value": "k", "%k": "k", "%d": "d"},
    "stoch": {"value": "k", "%k": "k", "%d": "d", "slowk": "k", "slowd": "d"},
    "dmi": {"+di": "pdi", "-di": "mdi", "di_plus": "pdi", "di_minus": "mdi", "value": "adx", "trend": "adx"},
}

# Valid output fields per multi-line indicator (single-line ones use "value").
MULTI_FIELDS: dict[str, list[str]] = {
    "macd": ["macd", "signal", "histogram"],
    "kdj": ["k", "d", "j"],
    "stoch": ["k", "d"],
    "dmi": ["pdi", "mdi", "adx"],
    "boll": ["upper", "middle", "lower"],
    "env": ["upper", "middle", "lower"],
    "kc": ["upper", "middle", "lower"],
    "dc": ["upper", "middle", "lower"],
}


def _normalize_param_names(indicator: str, params: Any) -> dict[str, Any]:
    if not isinstance(params, dict):
        return {}
    synonyms = PARAM_SYNONYMS.get(indicator, {})
    out: dict[str, Any] = {}
    for raw_key, value in params.items():
        key = str(raw_key).lower()
        mapped = synonyms.get(key) or ("period" if key == "length" else raw_key)
        if mapped not in out:
            out[mapped] = value
    return out


def _correct_field(indicator: str, field: Any) -> str:
    valid = MULTI_FIELDS.get(indicator)
    if not valid:
        return str(field) if field else "value"
    raw = str(field or "").lower()
    if field in valid:
        return field
    if raw in valid:
        return raw
    syn = FIELD_SYNONYMS.get(indicator, {})
    if raw in syn and syn[raw] in valid:
        return syn[raw]
    return "middle" if "middle" in valid else valid[0]


def _resolve_band_params(indicator: str, params: Any) -> dict[str, float]:
    defaults = BAND_PARAM_DEFAULTS.get(indicator, {"period": 20})
    merged: dict[str, float] = dict(defaults)
    if isinstance(params, dict):
        for key, value in params.items():
            if value is None or value == "":
                continue
            try:
                num = float(value)
                merged[key] = int(num) if num.is_integer() else num
            except (TypeError, ValueError):
                continue
    return merged


def _sanitize_operand(op: Any) -> dict[str, Any] | None:
    if op is None:
        return None
    if isinstance(op, (int, float)):
        return {"source": "value", "value": op}
    if isinstance(op, str):
        try:
            return {"source": "value", "value": float(op)}
        except ValueError:
            return {"source": "indicator", "indicator": _resolve_indicator_id(op), "params": {}, "field": "value"}
    if not isinstance(op, dict):
        return None

    operand = dict(op)
    if not operand.get("source") and operand.get("indicator"):
        operand["source"] = "indicator"
    if not operand.get("source") and operand.get("metric"):
        operand["source"] = "candle"

    source = operand.get("source")
    if source == "value" or (operand.get("value") is not None and not operand.get("indicator")):
        return {"source": "value", "value": operand.get("value")}
    if source == "indicator" or operand.get("indicator"):
        indicator = _resolve_indicator_id(operand.get("indicator", ""))
        params = _normalize_param_names(indicator, operand.get("params") or {})
        clean_params: dict[str, Any] = {}
        for key, val in params.items():
            try:
                num = float(val)
                clean_params[key] = int(num) if num.is_integer() else num
            except (TypeError, ValueError):
                clean_params[key] = val
        return {
            "source": "indicator",
            "indicator": indicator,
            "params": clean_params,
            "field": _correct_field(indicator, operand.get("field")),
            "offset": int(operand.get("offset") or 0),
        }
    if source == "candle" or operand.get("metric"):
        return {
            "source": "candle",
            "metric": operand.get("metric"),
            "offset": int(operand.get("offset") or 0),
        }
    if source == "price" or operand.get("field") in {"close", "open", "high", "low", "volume"}:
        return {
            "source": "price",
            "field": operand.get("field") or "close",
            "offset": int(operand.get("offset") or 0),
        }
    return operand


def _sanitize_condition(cond: Any) -> dict[str, Any] | None:
    if not isinstance(cond, dict):
        return None
    cond_type = cond.get("type") or "compare"

    if cond_type == "candle_pattern":
        pattern = cond.get("pattern")
        if not pattern:
            return None
        return {
            "type": "candle_pattern",
            "pattern": str(pattern).lower(),
            "offset": int(cond.get("offset") or 0),
            "params": cond.get("params") if isinstance(cond.get("params"), dict) else {},
        }

    if cond_type in {"cross_above", "cross_below"}:
        left = _sanitize_operand(cond.get("left"))
        right = _sanitize_operand(cond.get("right"))
        if not left or not right:
            return None
        return {"type": cond_type, "left": left, "right": right}

    if cond_type in {"band_reentry", "band_breakout"}:
        side = "short" if cond.get("side") == "short" else "long"
        indicator = _resolve_indicator_id(cond.get("indicator") or "boll")
        params = cond.get("params") if isinstance(cond.get("params"), dict) else {}
        return {
            "type": cond_type,
            "side": side,
            "indicator": indicator,
            "params": _resolve_band_params(indicator, params),
        }

    if cond_type == "fvg":
        side = "bearish" if cond.get("side") == "bearish" else "bullish"
        state = cond.get("state") or "present"
        if state not in {"present", "in_zone", "filled"}:
            state = "present"
        lookback = int(cond.get("lookback") or 30)
        return {
            "type": "fvg",
            "side": side,
            "state": state,
            "lookback": max(5, lookback),
        }

    if cond_type == "divergence":
        kind = "bearish" if cond.get("kind") == "bearish" else "bullish"
        indicator = "macd" if cond.get("indicator") == "macd" else "rsi"
        lookback = int(cond.get("lookback") or 40)
        period = int(cond.get("period") or 14)
        return {
            "type": "divergence",
            "kind": kind,
            "indicator": indicator,
            "lookback": max(15, lookback),
            "period": max(2, period),
        }

    if cond_type == "swing_break":
        side = "short" if cond.get("side") == "short" else "long"
        pivot_bars = max(2, int(cond.get("pivotBars") or 5))
        lookback = max(pivot_bars * 3, int(cond.get("lookback") or 60))
        return {
            "type": "swing_break",
            "side": side,
            "pivotBars": pivot_bars,
            "lookback": lookback,
        }

    if cond_type == "swing_near":
        side = "short" if cond.get("side") == "short" else "long"
        pivot_bars = max(2, int(cond.get("pivotBars") or 5))
        lookback = max(pivot_bars * 3, int(cond.get("lookback") or 60))
        try:
            tolerance = float(cond.get("tolerancePct") or 0.5)
        except (TypeError, ValueError):
            tolerance = 0.5
        return {
            "type": "swing_near",
            "side": side,
            "pivotBars": pivot_bars,
            "lookback": lookback,
            "tolerancePct": max(0.05, tolerance),
        }

    if cond_type == "line_touch":
        indicator = _resolve_indicator_id(cond.get("indicator") or "ma")
        if indicator == "sma":
            indicator = "ma"
        params = cond.get("params") if isinstance(cond.get("params"), dict) else {}
        try:
            period = max(2, int(params.get("period") or 20))
        except (TypeError, ValueError):
            period = 20
        mode = "body" if str(cond.get("mode") or "").lower() == "body" else "wick"
        try:
            offset = max(0, int(cond.get("offset") or 0))
        except (TypeError, ValueError):
            offset = 0
        return {
            "type": "line_touch",
            "indicator": indicator,
            "params": {**params, "period": period},
            "mode": mode,
            "offset": offset,
            "field": cond.get("field") or "value",
        }

    if cond.get("indicator") and cond.get("op") is not None:
        right_val = cond.get("value") if cond.get("value") is not None else cond.get("right")
        left = _sanitize_operand(
            {
                "source": "indicator",
                "indicator": cond.get("indicator"),
                "params": cond.get("params") or {},
                "field": cond.get("field") or "value",
            }
        )
        right = _sanitize_operand(right_val)
        if not left or right is None:
            return None
        return {"type": "compare", "left": left, "op": cond.get("op"), "right": right}

    left = _sanitize_operand(cond.get("left"))
    right = _sanitize_operand(cond.get("right") if cond.get("right") is not None else cond.get("value"))
    if not left or right is None:
        return None
    return {"type": "compare", "left": left, "op": cond.get("op") or "==", "right": right}


def _sanitize_rule_group(group: Any) -> dict[str, Any]:
    if not isinstance(group, dict):
        return {"enabled": False, "logic": "all", "conditions": []}
    raw_conditions = group.get("conditions")
    conditions = []
    if isinstance(raw_conditions, list):
        for item in raw_conditions:
            cleaned = _sanitize_condition(item)
            if cleaned:
                conditions.append(cleaned)
    enabled = bool(conditions) and group.get("enabled") is not False
    return {
        "enabled": enabled,
        "logic": "any" if group.get("logic") == "any" else "all",
        "conditions": conditions,
    }


def sanitize_entry_rules(rules: Any) -> dict[str, Any] | None:
    if not isinstance(rules, dict):
        return None
    # Keep the structure even when every condition was deleted: an explicitly
    # empty entryRules means "do not enter". Returning None here made the
    # engine fall back to the legacy RSI preset, reviving a deleted strategy.
    return {
        "long": _sanitize_rule_group(rules.get("long")),
        "short": _sanitize_rule_group(rules.get("short")),
    }


def entry_rules_have_signals(rules: Any) -> bool:
    cleaned = sanitize_entry_rules(rules)
    if not cleaned:
        return False
    for side in ("long", "short"):
        group = cleaned.get(side) or {}
        if group.get("enabled") and group.get("conditions"):
            return True
    return False


def strategy_slots_have_signals(slots: Any) -> bool:
    if not isinstance(slots, list):
        return False
    for item in slots:
        slot = _slot_dict(item)
        if not slot or slot.get("enabled") is False:
            continue
        raw_rules = slot.get("entryRules") or slot.get("rules")
        if entry_rules_have_signals(raw_rules):
            return True
    return False


def _deep_merge_entry_rules(current: Any, patch: Any) -> dict[str, Any] | None:
    if not isinstance(patch, dict):
        return current if isinstance(current, dict) else None
    base: dict[str, Any] = dict(current) if isinstance(current, dict) else {}
    for side in ("long", "short"):
        if side not in patch:
            continue
        patch_group = patch.get(side)
        if not isinstance(patch_group, dict):
            continue
        if side not in base or not isinstance(base.get(side), dict):
            base[side] = patch_group
            continue
        merged_group = dict(base[side])
        for key, value in patch_group.items():
            if key == "conditions" and value is not None:
                merged_group["conditions"] = value
            elif value is not None:
                merged_group[key] = value
        base[side] = merged_group
    return base or None


def _sanitize_absolute_price(spec: Any) -> float | None:
    if not isinstance(spec, dict):
        return None
    raw = spec.get("price", spec.get("value"))
    try:
        px = float(raw)
    except (TypeError, ValueError):
        return None
    return px if px > 0 else None


def _sanitize_exit_side(rule: Any) -> dict[str, Any] | None:
    if not isinstance(rule, dict):
        return None
    clean: dict[str, Any] = {}

    sl = rule.get("stopLoss")
    if isinstance(sl, dict):
        sl_type = str(sl.get("type") or "").lower()
        if sl_type == "candle_extreme":
            field = "high" if sl.get("field") == "high" else "low"
            clean["stopLoss"] = {
                "type": "candle_extreme",
                "field": field,
                "offset": max(1, int(sl.get("offset") or 1)),
            }
        elif sl_type == "atr":
            try:
                mult = float(sl.get("mult") or 1.5)
            except (TypeError, ValueError):
                mult = 1.5
            clean["stopLoss"] = {
                "type": "atr",
                "period": max(1, int(sl.get("period") or 14)),
                "mult": mult if mult > 0 else 1.5,
            }
        elif sl_type in {"price", "fixed", "absolute"}:
            px = _sanitize_absolute_price(sl)
            if px is not None:
                clean["stopLoss"] = {"type": "price", "price": px}

    tp = rule.get("takeProfit")
    if isinstance(tp, dict):
        tp_type = str(tp.get("type") or "").lower()
        if tp_type == "risk_reward":
            try:
                ratio = float(tp.get("ratio") or 1.5)
            except (TypeError, ValueError):
                ratio = 1.5
            clean["takeProfit"] = {"type": "risk_reward", "ratio": ratio if ratio > 0 else 1.5}
        elif tp_type in {"price", "fixed", "absolute"}:
            px = _sanitize_absolute_price(tp)
            if px is not None:
                clean["takeProfit"] = {"type": "price", "price": px}

    return clean or None


def sanitize_exit_rules(rules: Any) -> dict[str, Any] | None:
    if not isinstance(rules, dict):
        return None
    out: dict[str, Any] = {}
    for side in ("long", "short"):
        cleaned = _sanitize_exit_side(rules.get(side))
        if cleaned:
            out[side] = cleaned
    return out or None


def _slot_dict(item: Any) -> dict[str, Any] | None:
    if isinstance(item, dict):
        out = dict(item)
    elif hasattr(item, "model_dump"):
        out = item.model_dump()
    else:
        return None
    if out.get("entryRules") is None and isinstance(out.get("rules"), dict):
        out["entryRules"] = out["rules"]
    return out


def _deep_merge_strategy_slots(current: Any, patch: Any) -> list[dict[str, Any]] | None:
    """Merge slot patches by id; append unknown ids. Never drop unmentioned slots."""
    if not isinstance(patch, list):
        return None

    base: list[dict[str, Any]] = []
    if isinstance(current, list):
        for item in current:
            slot = _slot_dict(item)
            if slot:
                base.append(slot)

    index_by_id = {s["id"]: i for i, s in enumerate(base) if s.get("id")}

    for raw in patch[:10]:
        incoming = _slot_dict(raw)
        if not incoming:
            continue

        sid = incoming.get("id")
        if sid and sid in index_by_id:
            idx = index_by_id[sid]
            prev = base[idx]
            merged_slot = dict(prev)
            if incoming.get("name") is not None:
                merged_slot["name"] = incoming["name"]
            if incoming.get("enabled") is not None:
                merged_slot["enabled"] = incoming["enabled"]
            if incoming.get("entryRules") is not None:
                merged_rules = _deep_merge_entry_rules(prev.get("entryRules"), incoming["entryRules"])
                merged_slot["entryRules"] = sanitize_entry_rules(merged_rules) or merged_rules
            if incoming.get("exitRules") is not None:
                merged_exit = _deep_merge_exit_rules(prev.get("exitRules"), incoming["exitRules"])
                merged_slot["exitRules"] = sanitize_exit_rules(merged_exit) or merged_exit
            base[idx] = merged_slot
            continue

        if not sid:
            incoming["id"] = f"slot-{uuid.uuid4().hex[:12]}"
        base.append(incoming)
        index_by_id[incoming["id"]] = len(base) - 1

    return base or None


def _deep_merge_exit_rules(current: Any, patch: Any) -> dict[str, Any] | None:
    if not isinstance(patch, dict):
        return current if isinstance(current, dict) else None
    base: dict[str, Any] = dict(current) if isinstance(current, dict) else {}
    for side in ("long", "short"):
        if side not in patch:
            continue
        patch_side = patch.get(side)
        if not isinstance(patch_side, dict):
            continue
        if side not in base or not isinstance(base.get(side), dict):
            base[side] = patch_side
            continue
        merged_side = dict(base[side])
        for key, value in patch_side.items():
            if isinstance(value, dict) and isinstance(merged_side.get(key), dict):
                merged_side[key] = {**merged_side[key], **value}
            elif value is not None:
                merged_side[key] = value
        base[side] = merged_side
    return base or None


class StrategySlot(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str | None = None
    name: str | None = None
    enabled: bool = True
    entryRules: dict[str, Any] | None = None
    exitRules: dict[str, Any] | None = None

    @field_validator("entryRules")
    @classmethod
    def normalize_slot_entry_rules(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return sanitize_entry_rules(value)

    @field_validator("exitRules")
    @classmethod
    def normalize_slot_exit_rules(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return sanitize_exit_rules(value)


# Numeric bounds — kept identical to the trading.html form limits so a GPT
# strategy is CLAMPED to what the UI itself allows instead of being rejected
# by schema validation (the user's strategy must apply as-is whenever legal).
NUMERIC_BOUNDS: dict[str, tuple[float, float]] = {
    "rsiPeriod": (2, 100),
    "rsiOversold": (1, 99),
    "rsiOverbought": (1, 99),
    "stopLossPct": (0.1, 50),
    "takeProfitPct": (0.1, 100),
    "leverage": (1, 125),
    "riskPerTradePct": (0.1, 10),
    "maxAccountLossPct": (1, 50),
    "pollSeconds": (10, 600),
}


def clamp_numeric_fields(data: dict[str, Any]) -> dict[str, Any]:
    """Clamp numeric strategy fields to UI form limits (never reject)."""
    for key, (lo, hi) in NUMERIC_BOUNDS.items():
        if key not in data or data[key] is None:
            continue
        try:
            num = float(data[key])
        except (TypeError, ValueError):
            continue
        data[key] = min(hi, max(lo, num))
    return data


class StrategySettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    rsiPeriod: int = Field(default=14, ge=2, le=100)
    rsiOversold: float = Field(default=25, ge=1, le=99)
    rsiOverbought: float = Field(default=70, ge=1, le=99)
    stopLossPct: float = Field(default=1.5, ge=0.1, le=50)
    takeProfitPct: float = Field(default=3.0, ge=0.1, le=100)
    useStopLoss: bool = True
    allowShort: bool = True
    leverage: int = Field(default=5, ge=1, le=125)
    riskPerTradePct: float = Field(default=1.0, ge=0.1, le=10)
    maxAccountLossPct: float = Field(default=5.0, ge=1, le=50)
    pollSeconds: int = Field(default=60, ge=10, le=600)
    entryRules: dict[str, Any] | None = None
    exitRules: dict[str, Any] | None = None
    strategySlots: list[StrategySlot] | None = None

    @field_validator("rsiOversold", "rsiOverbought")
    @classmethod
    def round_rsi(cls, value: float) -> float:
        return round(float(value), 2)

    @field_validator("stopLossPct", "takeProfitPct", "riskPerTradePct", "maxAccountLossPct")
    @classmethod
    def round_pct(cls, value: float) -> float:
        return round(float(value), 2)

    @field_validator("entryRules")
    @classmethod
    def normalize_entry_rules(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return sanitize_entry_rules(value)

    @field_validator("exitRules")
    @classmethod
    def normalize_exit_rules(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        return sanitize_exit_rules(value)

    @field_validator("strategySlots")
    @classmethod
    def normalize_strategy_slots(cls, value: list[Any] | None) -> list[StrategySlot] | None:
        if value is None:
            return None
        if not isinstance(value, list):
            return None
        out: list[StrategySlot] = []
        for item in value[:10]:
            slot = _slot_dict(item)
            if slot:
                out.append(StrategySlot.model_validate(slot))
        return out or None

    def merged(self, patch: dict[str, Any]) -> StrategySettings:
        data = self.model_dump()
        for key, value in patch.items():
            if key == "entryRules" and value is not None:
                merged_rules = _deep_merge_entry_rules(data.get("entryRules"), value)
                data["entryRules"] = sanitize_entry_rules(merged_rules) or merged_rules
                continue
            if key == "exitRules" and value is not None:
                merged_exit = _deep_merge_exit_rules(data.get("exitRules"), value)
                data["exitRules"] = sanitize_exit_rules(merged_exit) or merged_exit
                continue
            if key == "strategySlots" and value is not None:
                merged_slots = _deep_merge_strategy_slots(data.get("strategySlots"), value)
                if merged_slots is not None:
                    data["strategySlots"] = merged_slots
                continue
            if key in data and value is not None:
                data[key] = value
        # Clamp instead of raising: an out-of-range number from GPT (e.g. SL
        # 0.05%) must not reject the whole strategy — apply the closest legal
        # value, exactly like typing it into the form would.
        merged = StrategySettings.model_validate(clamp_numeric_fields(data))
        if not merged.entryRules and merged.rsiOversold >= merged.rsiOverbought:
            raise ValueError("과매도(롱) 기준은 과매수(숏) 기준보다 낮아야 합니다.")
        return merged

    def rules_text(self) -> str:
        if self.strategySlots:
            lines = []
            for slot in self.strategySlots:
                badge = "ON" if slot.enabled else "OFF"
                name = slot.name or "조건"
                if slot.entryRules:
                    lines.append(f"· <strong>[{badge}] {name}</strong>: entryRules 기반")
                else:
                    lines.append(f"· <strong>[{badge}] {name}</strong>: 비어 있음")
            lines.append(
                f"· 손절 -{self.stopLossPct:g}% · 익절 +{self.takeProfitPct:g}% (진입가 기준)"
            )
            return "<br>\n".join(lines)
        if self.entryRules:
            return (
                "· <strong>롱/숏 조건</strong>: 차트 지표 규칙 기반 (entryRules)<br>\n"
                f"· 손절 -{self.stopLossPct:g}% · 익절 +{self.takeProfitPct:g}% (진입가 기준)"
            )
        short_line = (
            f"· <strong>숏</strong>: RSI ≥ {self.rsiOverbought:g} (과매수)"
            if self.allowShort
            else "· <strong>숏</strong>: 비활성"
        )
        return (
            f"· <strong>롱</strong>: RSI ≤ {self.rsiOversold:g} (과매도)<br>\n"
            f"{short_line}<br>\n"
            f"· 손절 -{self.stopLossPct:g}% · 익절 +{self.takeProfitPct:g}% (진입가 기준)"
        )


class StrategyChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)
    meta: dict[str, Any] | None = None


class StrategyInterpretRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    current_settings: dict[str, Any] = Field(default_factory=dict)
    history: list[StrategyChatMessage] = Field(default_factory=list, max_length=30)
    symbol: str = "BTCUSDT"
    interval: str = "1h"
    market_context: dict[str, Any] | None = None
    backtest_snapshot: dict[str, Any] | None = None


class StrategyInterpretResponse(BaseModel):
    ok: bool = True
    settings: StrategySettings
    summary: str
    rules: str
    patch: dict[str, Any] = Field(default_factory=dict)
    changed_fields: list[str] = Field(default_factory=list)
    market_insight: str = ""
    backtest_insight: str = ""
    sources: list[str] = Field(default_factory=list)
    chart_interval: str | None = None
