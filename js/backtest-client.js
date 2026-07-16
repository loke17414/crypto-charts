/* Main-thread backtest client — Worker orchestration, abort, result cache.
 * Streams progress events (phase: loading | compute | done). */
const BacktestClient = (() => {
  let worker = null;
  let jobSeq = 0;
  let activeJobId = null;
  let lastResult = null;
  let lastCacheKey = null;
  const listeners = new Set();

  function workerUrl() {
    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src || '';
      if (src.includes('backtest-client.js')) {
        return src.replace(/backtest-client\.js.*$/, 'backtest.worker.js');
      }
    }
    return new URL('js/backtest.worker.js', window.location.href).href;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(workerUrl());
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.jobId != null && msg.jobId !== activeJobId) return;

      if (msg.type === 'progress') {
        emit({ type: 'progress', jobId: msg.jobId, progress: msg.progress });
        return;
      }
      if (msg.type === 'done') {
        activeJobId = null;
        lastResult = msg.result;
        emit({ type: 'done', jobId: msg.jobId, result: msg.result });
        return;
      }
      if (msg.type === 'cancelled') {
        activeJobId = null;
        emit({ type: 'cancelled', jobId: msg.jobId });
        return;
      }
      if (msg.type === 'error') {
        activeJobId = null;
        emit({ type: 'error', jobId: msg.jobId, error: msg.error });
      }
    };
    worker.onerror = (err) => {
      activeJobId = null;
      emit({ type: 'error', error: err?.message || 'Worker error' });
    };
    return worker;
  }

  function emit(event) {
    listeners.forEach((fn) => {
      try { fn(event); } catch (err) { console.error('[BacktestClient]', err); }
    });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function cancel() {
    if (activeJobId == null || !worker) return;
    worker.postMessage({ type: 'cancel', jobId: activeJobId });
    activeJobId = null;
  }

  function isRunning() {
    return activeJobId != null;
  }

  function getLastResult() {
    return lastResult;
  }

  function getLastCacheKey() {
    return lastCacheKey;
  }

  function run(payload, { cacheKey = null, force = false } = {}) {
    if (!force && cacheKey && cacheKey === lastCacheKey && lastResult?.ok) {
      emit({ type: 'done', jobId: null, result: lastResult, fromCache: true });
      return Promise.resolve(lastResult);
    }

    cancel();
    const jobId = ++jobSeq;
    activeJobId = jobId;
    lastCacheKey = cacheKey;
    ensureWorker().postMessage({ type: 'run', jobId, payload });

    return new Promise((resolve) => {
      const unsub = subscribe((event) => {
        if (event.jobId != null && event.jobId !== jobId) return;
        if (event.type === 'done') {
          unsub();
          resolve(event.result);
        } else if (event.type === 'cancelled') {
          unsub();
          resolve({ ok: false, cancelled: true });
        } else if (event.type === 'error') {
          unsub();
          resolve({ ok: false, error: event.error });
        }
      });
    });
  }

  function dispose() {
    cancel();
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return {
    run,
    cancel,
    subscribe,
    isRunning,
    getLastResult,
    getLastCacheKey,
    dispose,
  };
})();

window.BacktestClient = BacktestClient;
