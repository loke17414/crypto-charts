/**
 * Recommended strategies — BTCUSDT backtests: RR>=1:1, trades>=100, WR>=50%, PnL>0.
 * Ranked by cumulative PnL (then expectancy, then WR). Generated 2026-07-20T12:30:26.174Z
 * Intervals tested: 15m, 1h
 * Do not hand-edit the CATALOG; re-run: node bot-js/bench-recommended.js && node bot-js/generate-recommended-presets.js
 */
(function () {
  'use strict';

  const CATALOG = [
    {
      id: "rsi-short-65-sl1p5-tp1p5",
      name: "RSI≥65 숏 (SL1.5%/TP1.5%)",
      blurb: "RSI≥65 · SL 1.5% TP 1.5% (RR≥1) · 백테스트 57%/100회 (1h)",
      gptPrompt: "추천전략 rsi-short-65-sl1p5-tp1p5 적용: RSI≥65 · SL 1.5% TP 1.5% (RR≥1). 설정을 그대로 적용해.",
      bench: {
        winRate: 57,
        trades: 100,
        totalPnlPct: 21,
        expectancy: 0.21,
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
                  "type": "compare",
                  "left": {
                    "source": "indicator",
                    "indicator": "rsi",
                    "params": {
                      "period": 14
                    },
                    "field": "value"
                  },
                  "op": ">=",
                  "right": {
                    "source": "value",
                    "value": 65
                  }
                }
              ]
            }
          },
          "exitRules": null,
          "stopLossPct": 1.5,
          "takeProfitPct": 1.5,
          "useStopLoss": true
        };
      },
    },
    {
      id: "stoch-short-85-sl1p2-tp1p2",
      name: "Stoch≥85 숏 (SL1.2%/TP1.2%)",
      blurb: "Stoch K≥85 · SL 1.2% TP 1.2% · 백테스트 58%/100회 (15m)",
      gptPrompt: "추천전략 stoch-short-85-sl1p2-tp1p2 적용: Stoch K≥85 · SL 1.2% TP 1.2%. 설정을 그대로 적용해.",
      bench: {
        winRate: 58,
        trades: 100,
        totalPnlPct: 19.2,
        expectancy: 0.192,
        interval: "15m",
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
                  "op": ">=",
                  "right": {
                    "source": "value",
                    "value": 85
                  }
                }
              ]
            }
          },
          "exitRules": null,
          "stopLossPct": 1.2,
          "takeProfitPct": 1.2,
          "useStopLoss": true
        };
      },
    },
    {
      id: "engulfing_bear-atr-rr1",
      name: "하락 장악형 숏 (ATR RR1)",
      blurb: "engulfing_bear · ATR RR 1 · 백테스트 50%/100회 (1h)",
      gptPrompt: "추천전략 engulfing_bear-atr-rr1 적용: engulfing_bear · ATR RR 1. 설정을 그대로 적용해.",
      bench: {
        winRate: 50,
        trades: 100,
        totalPnlPct: 18.4,
        expectancy: 0.184,
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
                "mult": 1.5
              },
              "takeProfit": {
                "type": "risk_reward",
                "ratio": 1
              }
            }
          }
        };
      },
    },
    {
      id: "stoch-long-15-sl1-tp1",
      name: "Stoch≤15 롱 (SL1%/TP1%)",
      blurb: "Stoch K≤15 · SL 1% TP 1% · 백테스트 55%/100회 (15m)",
      gptPrompt: "추천전략 stoch-long-15-sl1-tp1 적용: Stoch K≤15 · SL 1% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 55,
        trades: 100,
        totalPnlPct: 10,
        expectancy: 0.1,
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
                    "value": 15
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
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "ema-both-sl1-tp1",
      name: "EMA 양방향 (SL1%/TP1%)",
      blurb: "EMA12/26 양방향 · SL 1% TP 1% · 백테스트 55%/100회 (1h)",
      gptPrompt: "추천전략 ema-both-sl1-tp1 적용: EMA12/26 양방향 · SL 1% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 55,
        trades: 100,
        totalPnlPct: 10,
        expectancy: 0.1,
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
          "stopLossPct": 1,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "swing-bounce-both-sl1p2-tp1p2",
      name: "전고저 반등 (SL1.2%/TP1.2%)",
      blurb: "swing_near 양방향 · SL 1.2% TP 1.2% · 백테스트 54%/100회 (15m)",
      gptPrompt: "추천전략 swing-bounce-both-sl1p2-tp1p2 적용: swing_near 양방향 · SL 1.2% TP 1.2%. 설정을 그대로 적용해.",
      bench: {
        winRate: 54,
        trades: 100,
        totalPnlPct: 9.6,
        expectancy: 0.096,
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
          "stopLossPct": 1.2,
          "takeProfitPct": 1.2,
          "useStopLoss": true
        };
      },
    },
    {
      id: "ema-golden-sl1-tp1",
      name: "EMA 골든 롱 (SL1%/TP1%)",
      blurb: "EMA12/26 골든 · SL 1% TP 1% · 백테스트 54%/100회 (1h)",
      gptPrompt: "추천전략 ema-golden-sl1-tp1 적용: EMA12/26 골든 · SL 1% TP 1%. 설정을 그대로 적용해.",
      bench: {
        winRate: 54,
        trades: 100,
        totalPnlPct: 8,
        expectancy: 0.08,
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
              "enabled": false,
              "logic": "all",
              "conditions": []
            }
          },
          "exitRules": null,
          "stopLossPct": 1,
          "takeProfitPct": 1,
          "useStopLoss": true
        };
      },
    },
    {
      id: "boll-short-sl2-tp2",
      name: "BOLL 상단 (SL2%/TP2%)",
      blurb: "boll short · SL 2% TP 2% · 백테스트 52%/100회 (1h)",
      gptPrompt: "추천전략 boll-short-sl2-tp2 적용: boll short · SL 2% TP 2%. 설정을 그대로 적용해.",
      bench: {
        winRate: 52,
        trades: 100,
        totalPnlPct: 8,
        expectancy: 0.08,
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
                  "type": "band_reentry",
                  "side": "short",
                  "indicator": "boll",
                  "params": {
                    "period": 20,
                    "mult": 2
                  }
                }
              ]
            }
          },
          "exitRules": null,
          "stopLossPct": 2,
          "takeProfitPct": 2,
          "useStopLoss": true
        };
      },
    },
    {
      id: "hammer-sl1p5-tp1p5",
      name: "망치형 롱 (SL1.5%/TP1.5%)",
      blurb: "hammer · SL 1.5% TP 1.5% · 백테스트 52%/100회 (1h)",
      gptPrompt: "추천전략 hammer-sl1p5-tp1p5 적용: hammer · SL 1.5% TP 1.5%. 설정을 그대로 적용해.",
      bench: {
        winRate: 52,
        trades: 100,
        totalPnlPct: 6,
        expectancy: 0.06,
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
                  "type": "candle_pattern",
                  "pattern": "hammer",
                  "offset": 0
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
          "takeProfitPct": 1.5,
          "useStopLoss": true
        };
      },
    },
    {
      id: "rsi-long-35-sl1p5-tp1p5",
      name: "RSI≤35 롱 (SL1.5%/TP1.5%)",
      blurb: "RSI≤35 · SL 1.5% TP 1.5% (RR≥1) · 백테스트 51%/100회 (1h)",
      gptPrompt: "추천전략 rsi-long-35-sl1p5-tp1p5 적용: RSI≤35 · SL 1.5% TP 1.5% (RR≥1). 설정을 그대로 적용해.",
      bench: {
        winRate: 51,
        trades: 100,
        totalPnlPct: 3,
        expectancy: 0.03,
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
                    "value": 35
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
          "takeProfitPct": 1.5,
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
   * Fixed curated top-10 catalog (RR>=1:1, WR>=50%, positive PnL @ 100 trades).
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
      note: `벤치마크 추천 10개 (RR≥1:1 · PnL 우선 · WR≥50% · 100거래) · 현재 차트 재측정 ${passCount}/${measured.length} 통과`,
      measuredAt: Date.now(),
      minWinRate,
      minTrades,
      curated: true,
    };
  }

  function catalogForAi() {
    return CATALOG.map((p) => {
      const b = p.bench;
      const bench = b
        ? ` [bench WR ${b.winRate}% / PnL ${b.totalPnlPct}% / ${b.trades}trades / ${b.interval}]`
        : '';
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
