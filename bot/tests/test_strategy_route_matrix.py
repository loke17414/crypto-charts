# -*- coding: utf-8 -*-
"""Regression matrix: local routing + exit sanitize parity for strategy apply."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bot.strategy_ai import (  # noqa: E402
    _local_strategy_template,
    _needs_full_system,
    _prompt_unsupported_strategy_reason,
    should_skip_gpt_quota,
)
from bot.strategy_schema import sanitize_exit_rules  # noqa: E402

# (prompt, expect_local, allowed_routes|None)
CASES: list[tuple[str, bool, set[str] | None]] = [
    # Must stay local
    ("RSI 30 이하 롱", True, {"rsi_local_no_gpt"}),
    ("양봉일 때 롱", True, {"bullish_candle_local_no_gpt"}),
    ("음봉일 때 숏", True, {"bearish_candle_local_no_gpt"}),
    ("볼린저 하단 이탈 후 재진입 롱", True, {"band_reentry_local_no_gpt"}),
    ("돈치안 상단 돌파 롱 손절 전저점", True, {"band_breakout_local_no_gpt"}),
    ("전저점 지지에서 롱 진입", True, {"swing_local_no_gpt"}),
    ("FVG 존에서 롱", True, {"fvg_local_no_gpt"}),
    ("RSI 다이버전스 롱", True, {"divergence_local_no_gpt"}),
    ("MA20 터치 후 다음봉 양봉이면 롱, 손절 터치봉 저가, 익절 1:1", True, {"ma_touch_local_no_gpt"}),
    (
        "macd 매도모멘텀이 2개이상 연속으로 약화될떄 롱 진입 손절은 전저점 익절은 손익비 대비 1대1",
        True,
        {"indicator_series_local_no_gpt"},
    ),
    (
        "가격이 65888까지 오른후 하락캔들이 나올시 숏 진입 손절은 66000 익절은 손절대비 1대1",
        True,
        {"price_level_candle_local_no_gpt"},
    ),
    ("MACD 골든크로스 롱 진입 손절 전저점", True, {"indicator_cross_local_no_gpt"}),
    ("EMA 12가 26 상향 돌파 시 롱", True, {"indicator_cross_local_no_gpt"}),
    ("CCI -100 이하 롱", True, {"indicator_threshold_local_no_gpt"}),
    ("MFI 20 이하에서 롱", True, {"indicator_threshold_local_no_gpt"}),
    ("손절 1.5% 익절 3%", True, {"risk_local_no_gpt"}),
    ("과매도에서 롱", True, {"rsi_local_no_gpt"}),
    ("켈트너 상단 돌파 후 재진입 숏", True, {"band_reentry_local_no_gpt"}),
    ("볼린저 하단 터치 롱", True, {"band_touch_local_no_gpt"}),
    ("전고점 돌파 롱", True, {"swing_local_no_gpt"}),
    ("전저점 이탈 숏", True, {"swing_local_no_gpt"}),
    ("EMA 20 터치 롱", True, {"ma_touch_local_no_gpt"}),
    ("RSI 2연속 상승 롱 손절 전저점", True, {"indicator_series_local_no_gpt"}),
    ("스토캐스틱 골든크로스 롱", True, {"indicator_cross_local_no_gpt"}),
    ("Williams %R -80 이하 롱", True, {"indicator_threshold_local_no_gpt"}),
    ("엔벨로프 하단 터치 롱", True, {"band_touch_local_no_gpt"}),
    ("돈치안 하단 이탈 후 재진입 롱", True, {"band_reentry_local_no_gpt"}),
    ("MACD 다이버전스 롱 진입", True, {"divergence_local_no_gpt"}),
    ("손절 전저점 익절 손익비 1:1", True, {"risk_local_no_gpt"}),
    ("가격이 64000까지 내린후 상승캔들 롱 손절 63500 익절 1:1", True, {"price_level_candle_local_no_gpt"}),
    ("macd 매수모멘텀 2연속 약화 숏 손절 전고점 익절 1:1", True, {"indicator_series_local_no_gpt"}),
    ("RSI 30 이하이고 MACD 골든크로스면 롱, 손절 전저점", True, {"indicator_and_local_no_gpt"}),
    ("ATR 14가 증가할 때 롱 손절 전저점", False, None),
    ("슈퍼트렌드 상승 전환 롱 손절 전저점", False, None),
    ("파라볼릭 SAR 전환 롱 손절 전저점", False, None),
    # Must GPT (not hijacked by wrong local)
    ("해머 캔들 + RSI 30 이하 롱 손절 전저점", False, None),
    ("이치모쿠 전환선이 기준선 상향돌파 롱, 손절 전저점", False, None),
    ("갭 상승 후 롱", False, None),
]


def test_route_matrix() -> None:
    fails: list[str] = []
    for prompt, expect_local, allowed in CASES:
        local = _local_strategy_template(prompt)
        skip = should_skip_gpt_quota(prompt)
        if expect_local:
            if local is None:
                fails.append(f"EXPECT_LOCAL but GPT | {prompt}")
                continue
            route = local[1]
            if allowed and route not in allowed:
                fails.append(f"WRONG_ROUTE {route} not in {allowed} | {prompt}")
            if not skip:
                fails.append(f"EXPECT skip_gpt | {prompt}")
        else:
            if local is not None:
                fails.append(f"HIJACK {local[1]} | {prompt}")
            if skip:
                fails.append(f"EXPECT GPT but skip_gpt | {prompt}")
    assert not fails, "\n".join(fails)


def test_macd_sell_momentum_has_hist_zone() -> None:
    p = "macd 매도모멘텀이 2개이상 연속으로 약화될떄 롱 진입 손절은 전저점 익절은 손익비 대비 1대1"
    patch, route, _ = _local_strategy_template(p)
    assert route == "indicator_series_local_no_gpt"
    conds = patch["entryRules"]["long"]["conditions"]
    assert any(
        c.get("op") == "<" and c.get("right", {}).get("value") == 0
        for c in conds
    )


def test_price_level_absolute_sl_survives_schema() -> None:
    p = "가격이 65888까지 오른후 하락캔들이 나올시 숏 진입 손절은 66000 익절은 손절대비 1대1"
    patch, route, _ = _local_strategy_template(p)
    assert route == "price_level_candle_local_no_gpt"
    cleaned = sanitize_exit_rules(patch["exitRules"])
    assert cleaned is not None
    assert cleaned["short"]["stopLoss"]["type"] == "price"
    assert cleaned["short"]["stopLoss"]["price"] == 66000.0
    assert cleaned["short"]["takeProfit"]["type"] == "risk_reward"


def test_full_system_only_for_heavy_or_opt_in() -> None:
    prev = os.environ.pop("OPENAI_FULL_SYSTEM", None)
    try:
        # Default: simple GPT applies stay compact (avoid ~5k-token SYSTEM_PROMPT).
        assert _needs_full_system("single", "ATR 14가 증가할 때 롱") is False
        assert _needs_full_system("question", "지금 추세가 뭐야?") is False
        # Hard multi-condition / exotic → full
        assert _needs_full_system("single", "해머 캔들 + RSI 30 이하 롱") is True
        assert _needs_full_system("single", "이치모쿠 전환선이 기준선 상향돌파 롱") is True
        # Explicit opt-in
        os.environ["OPENAI_FULL_SYSTEM"] = "1"
        assert _needs_full_system("single", "ATR 14가 증가할 때 롱") is True
        os.environ["OPENAI_FULL_SYSTEM"] = "0"
        assert _needs_full_system("strategy_rules", "해머 캔들 + RSI 30 이하 롱") is False
    finally:
        if prev is None:
            os.environ.pop("OPENAI_FULL_SYSTEM", None)
        else:
            os.environ["OPENAI_FULL_SYSTEM"] = prev


def test_unsupported_mtf_detected() -> None:
    assert _prompt_unsupported_strategy_reason("4시간봉 필터 후 1분봉 롱") == "멀티타임프레임"
    assert _prompt_unsupported_strategy_reason("RSI 30 이하 롱") is None


def test_additive_macd_signal_filter_preserves_series() -> None:
    """Follow-up 'macd9선 ≥10일때만' must AND onto existing MACD series, not wipe it."""
    from bot.strategy_ai import (  # noqa: WPS433
        _looks_like_follow_up_edit,
        _macd_threshold_field,
        _parse_threshold_compare_condition,
    )

    base_prompt = (
        "macd 매도모멘텀이 2개이상 연속으로 약화될떄 롱 진입 "
        "손절은 전저점 익절은 손익비 대비 1대1"
    )
    base_patch, base_route, _ = _local_strategy_template(base_prompt)
    assert base_route == "indicator_series_local_no_gpt"
    base_conds = list(base_patch["entryRules"]["long"]["conditions"])
    assert len(base_conds) >= 3

    follow = "macd9선이 10이상일때만"
    assert _looks_like_follow_up_edit(follow)
    assert _macd_threshold_field(follow) == "signal"
    cond = _parse_threshold_compare_condition(follow)
    assert cond is not None
    assert cond["left"]["field"] == "signal"
    assert cond["op"] == ">="
    assert cond["right"]["value"] == 10.0

    add_patch, add_route, _ = _local_strategy_template(
        follow,
        {"entryRules": base_patch["entryRules"], "exitRules": base_patch.get("exitRules")},
    )
    assert add_route == "additive_threshold_filter_local_no_gpt"
    assert should_skip_gpt_quota(
        follow,
        {"entryRules": base_patch["entryRules"]},
    )
    new_conds = add_patch["entryRules"]["long"]["conditions"]
    assert len(new_conds) == len(base_conds) + 1
    # Prior series/zone compares preserved
    assert new_conds[:-1] == base_conds
    filt = new_conds[-1]
    assert filt["left"]["indicator"] == "macd"
    assert filt["left"]["field"] == "signal"
    assert filt["op"] == ">="
    assert filt["right"]["value"] == 10.0
    assert add_patch["entryRules"]["long"]["logic"] == "all"


def test_additive_filter_without_current_does_not_hijack() -> None:
    """Filter-only phrase with empty strategy must not invent a one-condition entry."""
    local = _local_strategy_template("macd9선이 10이상일때만")
    assert local is None
    local_rsi = _local_strategy_template("rsi 50이상일때만")
    assert local_rsi is None


if __name__ == "__main__":
    test_route_matrix()
    test_macd_sell_momentum_has_hist_zone()
    test_price_level_absolute_sl_survives_schema()
    test_full_system_only_for_heavy_or_opt_in()
    test_unsupported_mtf_detected()
    test_additive_macd_signal_filter_preserves_series()
    test_additive_filter_without_current_does_not_hijack()
    print(f"ok cases={len(CASES)}")
