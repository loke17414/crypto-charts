/* Backtest Web Worker — runs FuturesStrategy.runReplay off the UI thread. */
/* eslint-disable no-restricted-globals */
'use strict';

self.window = self;
self.document = {
  body: { classList: { contains: () => false, add() {}, remove() {}, toggle() {} } },
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    appendChild() {},
    addEventListener() {},
  }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  dispatchEvent() {},
};
self.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
self.CustomEvent = function CustomEvent() {};
self.requestAnimationFrame = () => 0;
self.LightweightCharts = { LineStyle: {}, CrosshairMode: {} };
self.ResizeObserver = function ResizeObserver() {
  return { observe() {}, disconnect() {} };
};

const SCRIPTS = [
  'ta-math.js',
  'ta-extended.js',
  'indicator-catalog.js',
  'indicators.js',
  'candle-patterns.js',
  'chart-structure.js',
  'risk-sizing.js',
  'strategy-engine.js',
  'futures-strategy.js',
  'backtest-engine.js',
];

try {
  importScripts(...SCRIPTS);
} catch (err) {
  self.postMessage({ type: 'error', error: `Worker script load failed: ${err.message}` });
}

if (!self.BacktestEngine?.runBacktestJob) {
  self.postMessage({
    type: 'error',
    error: 'BacktestEngine failed to initialize in worker',
  });
}

const cancelled = new Set();

self.onmessage = async (event) => {
  const msg = event.data || {};
  const { type, jobId } = msg;

  if (type === 'cancel') {
    if (jobId != null) cancelled.add(jobId);
    return;
  }

  if (type !== 'run') return;

  if (!self.BacktestEngine?.runBacktestJob) {
    self.postMessage({
      type: 'error',
      jobId,
      error: 'BacktestEngine is not available in worker',
    });
    return;
  }

  const shouldStop = () => cancelled.has(jobId);
  const onProgress = (progress) => {
    if (shouldStop()) return;
    self.postMessage({ type: 'progress', jobId, progress });
  };

  try {
    cancelled.delete(jobId);
    const result = await self.BacktestEngine.runBacktestJob(msg.payload, {
      shouldStop,
      onProgress,
    });
    if (shouldStop() || result.cancelled) {
      self.postMessage({ type: 'cancelled', jobId });
      return;
    }
    self.postMessage({ type: 'done', jobId, result });
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId,
      error: err?.message || String(err),
    });
  } finally {
    cancelled.delete(jobId);
  }
};
