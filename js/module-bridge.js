/* 모듈 경계 (Module Bridge)
 *
 * trading.html 은 서로 독립적인 세 그룹으로 나뉜다:
 *
 *   [1] 차트 + 백테스팅 표시
 *       app.js (window.CryptoCharts) — 캔들/오버레이/마커 렌더링
 *       futures-bot-app.js — 전략 UI·봇·GPT (차트는 ModuleBridge.chart 포트)
 *       backtest-client.js / backtest.worker.js — 백테스트 (Worker 격리)
 *   [2] API 서버 + 키 저장
 *       futures-api-client.js (window.FuturesApiClient) — 서버 통신, 키는 서버에만 저장
 *   [3] 전략 설정 + 봇 + GPT + 리스크 관리 + 진입조건 목록
 *       futures-bot-app.js, strategy-ai.js, risk-sizing.js (window.FuturesBotApp)
 *
 * 그룹 사이의 정보 전달 규칙:
 *   - [3] → [1] : 반드시 ModuleBridge.chart 포트를 통해서만 호출한다.
 *                 차트 코드에 버그가 있어도 오류가 포트 안에서 격리되어
 *                 전략/봇 로직은 절대 중단되지 않는다 (콘솔에만 기록).
 *   - [1] → [3] : DOM CustomEvent('chart-candles-updated', 'chart-candle-tick')와
 *                 드래그 콜백으로만 전달한다. 리스너/콜백 오류는 차트로 전파되지 않는다.
 *   - [3] → [2] : FuturesApiClient 를 직접 호출한다. 통신 오류는 의미 있는 정보라서
 *                 삼키지 않고 호출한 쪽의 try/catch 가 사용자에게 보여준다.
 *
 * 새 크로스-그룹 연결을 추가할 때는 반드시 위 규칙을 따를 것.
 */
const ModuleBridge = (() => {
  // resolveTarget()로 대상 모듈을 호출 시점에 찾는 프록시 포트.
  // 대상이 아직 없거나 메서드가 던져도 호출한 쪽은 계속 실행된다.
  function createPort(label, resolveTarget) {
    const wrappers = new Map();
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'available') return () => Boolean(resolveTarget());
        if (typeof prop !== 'string') return undefined;
        if (wrappers.has(prop)) return wrappers.get(prop);
        const fn = (...args) => {
          const target = resolveTarget();
          const method = target?.[prop];
          if (typeof method !== 'function') return undefined;
          try {
            const out = method.apply(target, args);
            if (out && typeof out.then === 'function') {
              return out.catch((err) => {
                console.error(`[모듈경계:${label}] ${prop}() 비동기 오류 (호출측은 계속 실행):`, err);
                return undefined;
              });
            }
            return out;
          } catch (err) {
            console.error(`[모듈경계:${label}] ${prop}() 오류 (호출측은 계속 실행):`, err);
            return undefined;
          }
        };
        wrappers.set(prop, fn);
        return fn;
      },
    });
  }

  // 반대 방향 콜백([1]→[3] 드래그 핸들러 등)을 격리할 때 사용.
  function guard(label, fn) {
    return (...args) => {
      try {
        return fn(...args);
      } catch (err) {
        console.error(`[모듈경계:${label}] 콜백 오류 (호출측은 계속 실행):`, err);
        return undefined;
      }
    };
  }

  return {
    chart: createPort('차트', () => window.CryptoCharts),
    strategy: createPort('전략봇', () => window.FuturesBotApp),
    guard,
  };
})();

window.ModuleBridge = ModuleBridge;
