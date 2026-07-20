'use strict';

const fs = require('fs');
const path = require('path');

const data = require('./bench-recommended-top10.json');
const items = data.items.slice(0, 10);

function indent(json, spaces) {
  const pad = ' '.repeat(spaces);
  return JSON.stringify(json, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : pad + line))
    .join('\n');
}

const presets = items.map((it) => {
  const blurb = `${it.blurb} · 백테스트 ${it.winRate}%/${it.trades}회 (${it.interval})`;
  return `    {
      id: ${JSON.stringify(it.id)},
      name: ${JSON.stringify(it.name)},
      blurb: ${JSON.stringify(blurb)},
      gptPrompt: ${JSON.stringify(it.gptPrompt)},
      bench: {
        winRate: ${it.winRate},
        trades: ${it.trades},
        totalPnlPct: ${it.totalPnlPct},
        interval: ${JSON.stringify(it.interval)},
        symbol: ${JSON.stringify(it.symbol || 'BTCUSDT')},
      },
      build() {
        return ${indent(it.settings, 8)};
      },
    }`;
}).join(',\n');

const file = `/**
 * Recommended strategies — curated from BTCUSDT backtests (100 trades, WR>=50%).
 * Generated ${data.measuredAt}
 * Intervals tested: ${(data.intervals || []).join(', ')}
 * Do not hand-edit the CATALOG; re-run: node bot-js/bench-recommended.js && node bot-js/generate-recommended-presets.js
 */
(function () {
  'use strict';

  const CATALOG = [
${presets}
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
      note: \`벤치마크 추천 10개 (BTCUSDT 100거래 WR≥50%) · 현재 차트 재측정 \${passCount}/\${measured.length} 통과\`,
      measuredAt: Date.now(),
      minWinRate,
      minTrades,
      curated: true,
    };
  }

  function catalogForAi() {
    return CATALOG.map((p) => {
      const b = p.bench;
      const bench = b ? \` [bench WR \${b.winRate}% / \${b.trades}trades / \${b.interval}]\` : '';
      return \`\${p.id}: \${p.name} — \${p.blurb}\${bench}\`;
    }).join('\\n');
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
`;

const out = path.join(__dirname, '..', 'js', 'strategy-presets.js');
fs.writeFileSync(out, file);
console.log('Wrote', out);
items.forEach((it, i) => {
  console.log(`${i + 1}. ${it.id} WR=${it.winRate}% n=${it.trades} (${it.interval})`);
});
