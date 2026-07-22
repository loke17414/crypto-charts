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
    ("볼린저 하단 터치 롱", True, {"band_reentry_local_no_gpt"}),
    ("전고점 돌파 롱", True, {"swing_local_no_gpt"}),
    ("전저점 이탈 숏", True, {"swing_local_no_gpt"}),
    ("EMA 20 터치 롱", True, {"ma_touch_local_no_gpt"}),
    ("RSI 2연속 상승 롱 손절 전저점", True, {"indicator_series_local_no_gpt"}),
    ("스토캐스틱 골든크로스 롱", True, {"indicator_cross_local_no_gpt"}),
    ("Williams %R -80 이하 롱", True, {"indicator_threshold_local_no_gpt"}),
    ("엔벨로프 하단 터치 롱", True, {"band_reentry_local_no_gpt"}),
    ("돈치안 하단 이탈 후 재진입 롱", True, {"band_reentry_local_no_gpt"}),
    ("MACD 다이버전스 롱 진입", True, {"divergence_local_no_gpt"}),
    ("손절 전저점 익절 손익비 1:1", True, {"risk_local_no_gpt"}),
    ("가격이 64000까지 내린후 상승캔들 롱 손절 63500 익절 1:1", True, {"price_level_candle_local_no_gpt"}),
    ("macd 매수모멘텀 2연속 약화 숏 손절 전고점 익절 1:1", True, {"indicator_series_local_no_gpt"}),
    ("ATR 14가 증가할 때 롱 손절 전저점", False, None),
    ("슈퍼트렌드 상승 전환 롱 손절 전저점", False, None),
    ("파라볼릭 SAR 전환 롱 손절 전저점", False, None),
    # Must GPT (not hijacked by wrong local)
    ("RSI 30 이하이고 MACD 골든크로스면 롱, 손절 전저점", False, None),
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


def test_full_system_default_for_strategy_apply() -> None:
    prev = os.environ.pop("OPENAI_FULL_SYSTEM", None)
    try:
        assert _needs_full_system("single", "MACD 골든크로스 롱 진입") is True
        assert _needs_full_system("question", "지금 추세가 뭐야?") is False
        os.environ["OPENAI_FULL_SYSTEM"] = "0"
        assert _needs_full_system("strategy_rules", "MACD 골든크로스 롱 진입") is False
    finally:
        if prev is None:
            os.environ.pop("OPENAI_FULL_SYSTEM", None)
        else:
            os.environ["OPENAI_FULL_SYSTEM"] = prev


def test_unsupported_mtf_detected() -> None:
    assert _prompt_unsupported_strategy_reason("4시간봉 필터 후 1분봉 롱") == "멀티타임프레임"
    assert _prompt_unsupported_strategy_reason("RSI 30 이하 롱") is None


if __name__ == "__main__":
    test_route_matrix()
    test_macd_sell_momentum_has_hist_zone()
    test_price_level_absolute_sl_survives_schema()
    test_full_system_default_for_strategy_apply()
    test_unsupported_mtf_detected()
    print(f"ok cases={len(CASES)}")
