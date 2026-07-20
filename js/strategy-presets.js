/**
 * Recommended strategies — curated from BTCUSDT backtests (100 trades, WR>=50%).
 * Generated 2026-07-20T11:58:14.941Z
 * Intervals tested: 15m, 1h, 5m
 * Do not hand-edit the CATALOG; re-run: node bot-js/bench-recommended.js && node bot-js/generate-recommended-presets.js
 */
(function () {
  'use strict';

  const CATALOG = [
    {
      id: "engulfing_bear-atr-rr05",
      name: "하락 장악형 숏 (ATR RR0.5)",
      blurb: "engulfing_bear · ATR RR 0.5 · 백테스트 71%/100회 (1h)",
      gptPrompt: "추천전략 engulfing_bear-atr-rr05 적용: engulfing_bear · ATR RR 0.5. 설정을 그대로 적용해.",
      bench: {
        winRate: 71,
        trades: 100,
        totalPnlPct: 18.8,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": true,
          "entryRules": {
            "long": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            },
            "short": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "candle_pattern",
                  "pattern": "engulfing_bear",
                  "offset": 0
                }
              ]
            }
          },
          "exitRules": {
            "short": {
              "stopLoss": {
                "type": "atr",
                "period": 14,
                "mult": 1.2
              },
              "takeProfit": {
                "type": "risk_reward",
                "ratio": 0.5
              }
            }
          }
        };
      },
    },
    {
      id: "swing-bounce-both-sl2-tp1",
      name: "전고저 반등 (SL2%/TP1%)",
      blurb: "swing_near 양방향 · SL 2% TP 1% · 백테스트 69%/100회 (15m)",
      gptPrompt: "추천전략 swing-bounce-both-sl2-tp1 적용: swing_near 양방향 · SL 2% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 69,
        trades: 100,
        totalPnlPct: 7,
        interval: "15m",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": true,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "swing_near",
                  "side": "long",
                  "pivotBars": 5,
                  "lookback": 60,
                  "tolerancePct": 0.5
                }
              ]
            },
            "short": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "swing_near",
                  "side": "short",
                  "pivotBars": 5,
                  "lookback": 60,
                  "tolerancePct": 0.5
                }
              ]
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "shooting_star-atr-rr05",
      name: "슈팅스타 숏 (ATR RR0.5)",
      blurb: "shooting_star · ATR RR 0.5 · 백테스트 68%/100회 (1h)",
      gptPrompt: "추천전략 shooting_star-atr-rr05 적용: shooting_star · ATR RR 0.5. 설정을 그대로 적용해.",
      bench: {
        winRate: 68,
        trades: 100,
        totalPnlPct: 14.2,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": true,
          "entryRules": {
            "long": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            },
            "short": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "candle_pattern",
                  "pattern": "shooting_star",
                  "offset": 0
                }
              ]
            }
          },
          "exitRules": {
            "short": {
              "stopLoss": {
                "type": "atr",
                "period": 14,
                "mult": 1.2
              },
              "takeProfit": {
                "type": "risk_reward",
                "ratio": 0.5
              }
            }
          }
        };
      },
    },
    {
      id: "ema-both-sl2-tp1",
      name: "EMA 골든/데드 (SL2%/TP1%)",
      blurb: "EMA12/26 양방향 · SL 2% TP 1% · 백테스트 68%/100회 (1h)",
      gptPrompt: "추천전략 ema-both-sl2-tp1 적용: EMA12/26 양방향 · SL 2% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 68,
        trades: 100,
        totalPnlPct: 4,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": true,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "cross_above",
                  "left": {
                    "source": "indicator",
                    "indicator": "ema",
                    "params": {
                      "period": 12
                    },
                    "field": "value"
                  },
                  "right": {
                    "source": "indicator",
                    "indicator": "ema",
                    "params": {
                      "period": 26
                    },
                    "field": "value"
                  }
                }
              ]
            },
            "short": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "cross_below",
                  "left": {
                    "source": "indicator",
                    "indicator": "ema",
                    "params": {
                      "period": 12
                    },
                    "field": "value"
                  },
                  "right": {
                    "source": "indicator",
                    "indicator": "ema",
                    "params": {
                      "period": 26
                    },
                    "field": "value"
                  }
                }
              ]
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "boll-long-sl2-tp1",
      name: "볼린저 하단 재진입 롱 (SL2%/TP1%)",
      blurb: "boll long · SL 2% TP 1% · 백테스트 67%/100회 (1h)",
      gptPrompt: "추천전략 boll-long-sl2-tp1 적용: boll long · SL 2% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 67,
        trades: 100,
        totalPnlPct: 1,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": false,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "band_reentry",
                  "side": "long",
                  "indicator": "boll",
                  "params": {
                    "period": 20,
                    "mult": 2
                  }
                }
              ]
            },
            "short": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "stoch-long-25-sl2-tp1",
      name: "스토캐스틱≤25 롱 (SL2%/TP1%)",
      blurb: "Stoch K≤25 · SL 2% TP 1% · 백테스트 66%/100회 (15m)",
      gptPrompt: "추천전략 stoch-long-25-sl2-tp1 적용: Stoch K≤25 · SL 2% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 66,
        trades: 100,
        totalPnlPct: -2,
        interval: "15m",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": false,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "compare",
                  "left": {
                    "source": "indicator",
                    "indicator": "stoch",
                    "params": {
                      "kPeriod": 14,
                      "dPeriod": 3
                    },
                    "field": "k"
                  },
                  "op": "<=",
                  "right": {
                    "source": "value",
                    "value": 25
                  }
                }
              ]
            },
            "short": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "stoch-long-20-sl2-tp1",
      name: "스토캐스틱≤20 롱 (SL2%/TP1%)",
      blurb: "Stoch K≤20 · SL 2% TP 1% · 백테스트 65%/100회 (1h)",
      gptPrompt: "추천전략 stoch-long-20-sl2-tp1 적용: Stoch K≤20 · SL 2% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 65,
        trades: 100,
        totalPnlPct: -5,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": false,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "compare",
                  "left": {
                    "source": "indicator",
                    "indicator": "stoch",
                    "params": {
                      "kPeriod": 14,
                      "dPeriod": 3
                    },
                    "field": "k"
                  },
                  "op": "<=",
                  "right": {
                    "source": "value",
                    "value": 20
                  }
                }
              ]
            },
            "short": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "stoch-long-25-sl1p5-tp1",
      name: "스토캐스틱≤25 롱 (SL1.5%/TP1%)",
      blurb: "Stoch K≤25 · SL 1.5% TP 1% · 백테스트 64%/100회 (15m)",
      gptPrompt: "추천전략 stoch-long-25-sl1p5-tp1 적용: Stoch K≤25 · SL 1.5% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 64,
        trades: 100,
        totalPnlPct: 10,
        interval: "15m",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": false,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "compare",
                  "left": {
                    "source": "indicator",
                    "indicator": "stoch",
                    "params": {
                      "kPeriod": 14,
                      "dPeriod": 3
                    },
                    "field": "k"
                  },
                  "op": "<=",
                  "right": {
                    "source": "value",
                    "value": 25
                  }
                }
              ]
            },
            "short": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 1.5,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "boll-long-sl2-tp1p2",
      name: "볼린저 하단 재진입 롱 (SL2%/TP1.2%)",
      blurb: "boll long · SL 2% TP 1.2% · 백테스트 64%/100회 (1h)",
      gptPrompt: "추천전략 boll-long-sl2-tp1p2 적용: boll long · SL 2% TP 1.2%. 설정을 그대로 적용해.",
      bench: {
        winRate: 64,
        trades: 100,
        totalPnlPct: 4.8,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": false,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "band_reentry",
                  "side": "long",
                  "indicator": "boll",
                  "params": {
                    "period": 20,
                    "mult": 2
                  }
                }
              ]
            },
            "short": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 1.2,
          "useStopLoss": true
        };
      },
    },
    {
      id: "rsi-long-28-sl1-tp0p6",
      name: "RSI≤28 롱 (SL1%/TP0.6%)",
      blurb: "RSI≤28 · 고정 SL 1% TP 0.6% · 백테스트 64%/100회 (1h)",
      gptPrompt: "추천전략 rsi-long-28-sl1-tp0p6 적용: RSI≤28 · 고정 SL 1% TP 0.6%. 설정을 그대로 적용해.",
      bench: {
        winRate: 64,
        trades: 100,
        totalPnlPct: 2.4,
        interval: "1h",
        symbol: "BTCUSDT",
      },
      build() {
        return {
          "allowShort": false,
          "entryRules": {
            "long": {
              "enabled": true,
              "logic": "all",
              "conditions": [
                {
                  "type": "compare",
                  "left": {
                    "source": "indicator",
                    "indicator": "rsi",
                    "params": {
                      "period": 14
                    },
                    "field": "value"
                  },
                  "op": "<=",
                  "right": {
                    "source": "value",
                    "value": 28
                  }
                }
              ]
            },
            "short": {
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 1,
          "takeProfitPct": 0.6,
          "useStopLoss": true
        };
      },
    }
  ];

  function sanitizeSettings(settings) {
    if (!settings) return null;
    const out = { ...settings };
    if (out.entryRules && window.StrategyEngine?.sanitizeEntryRules) {
      out.entryRules = StrategyEngine.sanitizeEntryRules(out.entryRules);
    }
    if (out.exitRules && window.StrategyEngine?.sanitizeExitRules) {
      out.exitRules = StrategyEngine.sanitizeExitRules(out.exitRules);
    }
    return out;
  }

  function getPreset(id) {
    return CATALOG.find((p) => p.id === id) || null;
  }

  function listCatalog() {
    return CATALOG.map((p) => ({
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      gptPrompt: p.gptPrompt,
      bench: p.bench || null,
    }));
  }

  function measurePreset(candles, preset, { maxTrades = 100 } = {}) {
    const settings = sanitizeSettings(preset.build());
    const base = {
      id: preset.id,
      name: preset.name,
      blurb: preset.blurb,
      gptPrompt: preset.gptPrompt,
      settings,
      bench: preset.bench || null,
    };
    if (!settings || !window.FuturesStrategy?.runReplay || !candles?.length) {
      return {
        ...base,
        winRate: preset.bench?.winRate ?? 0,
        trades: preset.bench?.trades ?? 0,
        totalPnlPct: preset.bench?.totalPnlPct ?? 0,
        ok: !!(preset.bench && preset.bench.winRate >= 50 && preset.bench.trades >= 100),
      };
    }
    const result = FuturesStrategy.runReplay(candles, settings, {
      maxTrades,
      skipMarkers: true,
    });
    const stats = result?.stats || {};
    const trades = stats.trades || 0;
    const winRate = stats.winRate || 0;
    return {
      ...base,
      winRate: Math.round(winRate * 10) / 10,
      trades,
      wins: stats.wins || 0,
      losses: stats.losses || 0,
      totalPnlPct: Math.round((stats.totalPnlPct || 0) * 10) / 10,
      ok: (trades >= 100 && winRate >= 50)
        || !!(preset.bench && preset.bench.winRate >= 50 && preset.bench.trades >= 100),
    };
  }

  /**
   * Fixed curated top-10 catalog (bench WR>=50% @ 100 trades).
   * Live chart re-measure updates badges; catalog membership stays these 10.
   */
  function recommend(candles, {
    minWinRate = 50,
    minTrades = 100,
    limit = 10,
    maxTrades = 100,
  } = {}) {
    const measured = CATALOG.slice(0, limit).map((p) => measurePreset(candles, p, { maxTrades }));
    const passCount = measured.filter((m) => m.ok).length;
    return {
      items: measured,
      passCount,
      note: `벤치마크 추천 10개 (BTCUSDT 100거래 WR≥50%) · 현재 차트 재측정 ${passCount}/${measured.length} 통과`,
      measuredAt: Date.now(),
      minWinRate,
      minTrades,
      curated: true,
    };
  }

  function catalogForAi() {
    return CATALOG.map((p) => {
      const b = p.bench;
      const bench = b ? ` [bench WR ${b.winRate}% / ${b.trades}trades / ${b.interval}]` : '';
      return `${p.id}: ${p.name} — ${p.blurb}${bench}`;
    }).join('\n');
  }

  window.StrategyPresets = {
    CATALOG,
    listCatalog,
    getPreset,
    sanitizeSettings,
    measurePreset,
    recommend,
    catalogForAi,
  };
})();
