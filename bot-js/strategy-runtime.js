'use strict';

/*
 * Loads the strategy engine inside a headless Node vm sandbox so the server
 * bot makes decisions identical to the trading UI. The files are concatenated
 * and evaluated in one shared script scope (mirroring how classic <script>
 * tags share the global scope in a page).
 *
 * ISOLATION: the bot loads from its OWN snapshot (bot-js/strategy/), not the
 * live js/ tree the website serves. The snapshot is only replaced by
 * sync-strategy.js after the candidate code passes a validation gate, so a
 * broken js/ edit can never crash the running bot. If no snapshot exists yet
 * (first run), it falls back to js/ with a warning.
 *
 * The chart/DOM code (app.js, futures-bot-app.js, indicators.js IndicatorManager
 * rendering) is intentionally NOT loaded; only the pure decision layer is:
 *   ta-math → ta-extended → indicator-catalog → indicators → candle-patterns
 *   → risk-sizing → strategy-engine → futures-strategy
 * These reference the DOM only inside functions we never call (e.g. init()),
 * so loading them headless is safe.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load order matters: each file's top-level `const` must be defined before the
// next file references it (same constraint as the browser's script order).
const LOAD_ORDER = [
  'ta-math.js',
  'ta-extended.js',
  'indicator-catalog.js',
  'indicators.js',
  'candle-patterns.js',
  'chart-structure.js',
  'risk-sizing.js',
  'strategy-engine.js',
  'futures-strategy.js',
];

const SNAPSHOT_DIR = path.join(__dirname, 'strategy');

function defaultDir() {
  const complete = LOAD_ORDER.every((f) => fs.existsSync(path.join(SNAPSHOT_DIR, f)));
  if (complete) return SNAPSHOT_DIR;
  console.warn(
    '[strategy-runtime] No strategy snapshot found (bot-js/strategy/). '
    + 'Falling back to live js/ — run "node bot-js/sync-strategy.js" to isolate the bot.',
  );
  return path.join(__dirname, '..', 'js');
}

function buildRuntime(jsDir) {
  const dir = jsDir || defaultDir();

  const sources = LOAD_ORDER.map((file) => {
    const full = path.join(dir, file);
    return `\n/* ==== ${file} ==== */\n${fs.readFileSync(full, 'utf8')}\n`;
  });

  // Minimal browser shims. The decision layer only touches these inside
  // functions we do not call, but we stub them so any stray reference is inert.
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    Number,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    Array,
    Object,
    String,
    Boolean,
    Set,
    Map,
    WeakMap,
    Symbol,
    document: { createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, appendChild() {}, addEventListener() {} }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, dispatchEvent() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    LightweightCharts: { LineStyle: {}, CrosshairMode: {} },
    ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
    CustomEvent: function () {},
    requestAnimationFrame: () => 0,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);

  // Export the pure decision objects out of the sandbox once everything loaded.
  const exportTail = '\nwindow.__brain = { FuturesStrategy, StrategyEngine, RiskSizing };\n';
  const script = new vm.Script(sources.join('\n') + exportTail, {
    filename: 'crypto-charts-strategy-bundle.js',
  });
  script.runInContext(sandbox);

  const brain = sandbox.window.__brain;
  if (!brain || !brain.FuturesStrategy || !brain.StrategyEngine) {
    throw new Error('Strategy runtime failed to initialize (FuturesStrategy/StrategyEngine missing)');
  }
  return brain;
}

module.exports = { buildRuntime, LOAD_ORDER, SNAPSHOT_DIR };
