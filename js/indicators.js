/* Binance-style indicator registry & chart manager */
const INDICATOR_REGISTRY = [
  { id: 'ma7', baseName: 'MA', group: '메인', type: 'overlay',
    defaults: { period: 7, color: '#f7931a', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.ma(c, p.period) },
  { id: 'ma25', baseName: 'MA', group: '메인', type: 'overlay',
    defaults: { period: 25, color: '#e91e63', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.ma(c, p.period) },
  { id: 'ma99', baseName: 'MA', group: '메인', type: 'overlay',
    defaults: { period: 99, color: '#9c27b0', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.ma(c, p.period) },
  { id: 'ema7', baseName: 'EMA', group: '메인', type: 'overlay',
    defaults: { period: 7, color: '#ffeb3b', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.emaLine(c, p.period) },
  { id: 'ema25', baseName: 'EMA', group: '메인', type: 'overlay',
    defaults: { period: 25, color: '#00bcd4', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.emaLine(c, p.period) },
  { id: 'ema99', baseName: 'EMA', group: '메인', type: 'overlay',
    defaults: { period: 99, color: '#8bc34a', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.emaLine(c, p.period) },
  { id: 'wma', baseName: 'WMA', group: '메인', type: 'overlay',
    defaults: { period: 20, color: '#ff9800', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.wmaLine(c, p.period) },
  { id: 'dema', baseName: 'DEMA', group: '메인', type: 'overlay',
    defaults: { period: 20, color: '#cddc39', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.dema(c, p.period) },
  { id: 'tema', baseName: 'TEMA', group: '메인', type: 'overlay',
    defaults: { period: 20, color: '#795548', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 500 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.tema(c, p.period) },
  { id: 'bbi', baseName: 'BBI', group: '메인', type: 'overlay',
    defaults: { color: '#607d8b', lineWidth: 1 },
    params: [
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c) => TA.bbi(c) },
  { id: 'boll', baseName: 'BOLL', group: '메인', type: 'overlay-band',
    defaults: { period: 20, mult: 2, color: '#2962ff', lineWidth: 1.5, fillOpacity: 0.1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 200 },
      { key: 'mult', label: '표준편차 배수', type: 'number', min: 0.5, max: 5, step: 0.1 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
      { key: 'fillOpacity', label: '채움 투명도', type: 'number', min: 0, max: 0.4, step: 0.02 },
    ],
    compute: (c, p) => TA.bollinger(c, p.period, p.mult), bandFill: true },
  { id: 'env', baseName: 'ENV', group: '메인', type: 'overlay-band',
    defaults: { period: 20, pct: 0.1, color: '#ab47bc', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 200 },
      { key: 'pct', label: '밴드 비율', type: 'number', min: 0.01, max: 0.5, step: 0.01 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.envelopes(c, p.period, p.pct) },
  { id: 'sar', baseName: 'SAR', group: '메인', type: 'overlay',
    defaults: { step: 0.02, max: 0.2, color: '#26a69a', lineWidth: 1 },
    params: [
      { key: 'step', label: '가속 계수', type: 'number', min: 0.01, max: 0.2, step: 0.01 },
      { key: 'max', label: '최대 가속', type: 'number', min: 0.05, max: 0.5, step: 0.01 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.psar(c, p.step, p.max) },
  { id: 'vol', baseName: 'VOL', group: '서브', type: 'sub-vol',
    defaults: {}, params: [], compute: (c) => c },
  { id: 'volma', baseName: 'VOL MA', group: '서브', type: 'sub-vol-line',
    defaults: { period: 5, color: '#f7931a', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 200 },
      { key: 'color', label: 'MA 색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.volMa(c, p.period) },
  { id: 'macd', baseName: 'MACD', group: '서브', type: 'sub-macd',
    defaults: {
      fast: 12, slow: 26, signal: 9, lineWidth: 1.5,
      colorMacd: '#F0B90B', colorSignal: '#FFFFFF',
      histUpStrong: '#0ECB81', histUpWeak: 'rgba(14, 203, 129, 0.45)',
      histDownStrong: '#F6465D', histDownWeak: 'rgba(246, 70, 93, 0.45)',
    },
    params: [
      { key: 'fast', label: 'Fast', type: 'number', min: 1, max: 100 },
      { key: 'slow', label: 'Slow', type: 'number', min: 1, max: 200 },
      { key: 'signal', label: 'Signal', type: 'number', min: 1, max: 50 },
      { key: 'colorMacd', label: 'DIF 색상', type: 'color' },
      { key: 'colorSignal', label: 'DEA 색상', type: 'color' },
      { key: 'histUpStrong', label: '히스토그램↑강', type: 'color' },
      { key: 'histUpWeak', label: '히스토그램↑약', type: 'color' },
      { key: 'histDownStrong', label: '히스토그램↓강', type: 'color' },
      { key: 'histDownWeak', label: '히스토그램↓약', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.macd(c, p.fast, p.slow, p.signal, {
      upStrong: p.histUpStrong, upWeak: p.histUpWeak,
      downStrong: p.histDownStrong, downWeak: p.histDownWeak,
    }), subHeight: 120, subMargins: { top: 0.22, bottom: 0.22 }, rightOffset: 12 },
  { id: 'rsi', baseName: 'RSI', group: '서브', type: 'sub-rsi',
    defaults: { period: 14, color: '#B388FF', lineWidth: 1.5 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.rsi(c, p.period), range: [0, 100] },
  { id: 'kdj', baseName: 'KDJ', group: '서브', type: 'sub-multi',
    defaults: { n: 9, m1: 3, m2: 3, colorK: '#2962ff', colorD: '#f7931a', colorJ: '#e91e63', lineWidth: 1 },
    params: [
      { key: 'n', label: 'N', type: 'number', min: 1, max: 100 },
      { key: 'm1', label: 'M1', type: 'number', min: 1, max: 50 },
      { key: 'm2', label: 'M2', type: 'number', min: 1, max: 50 },
      { key: 'colorK', label: 'K 색상', type: 'color' },
      { key: 'colorD', label: 'D 색상', type: 'color' },
      { key: 'colorJ', label: 'J 색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.kdj(c, p.n, p.m1, p.m2), range: [0, 100],
    lines: [
      { key: 'k', colorParam: 'colorK' },
      { key: 'd', colorParam: 'colorD' },
      { key: 'j', colorParam: 'colorJ' },
    ] },
  { id: 'obv', baseName: 'OBV', group: '서브', type: 'sub-line',
    defaults: { color: '#00bcd4', lineWidth: 1 },
    params: [
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c) => TA.obv(c) },
  { id: 'cci', baseName: 'CCI', group: '서브', type: 'sub-line',
    defaults: { period: 20, color: '#ff9800', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.cci(c, p.period) },
  { id: 'wr', baseName: 'WR', group: '서브', type: 'sub-line',
    defaults: { period: 14, color: '#ef5350', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.williamsR(c, p.period), range: [-100, 0] },
  { id: 'dmi', baseName: 'DMI', group: '서브', type: 'sub-multi',
    defaults: { period: 14, colorPdi: '#26a69a', colorMdi: '#ef5350', colorAdx: '#ffeb3b', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'colorPdi', label: '+DI 색상', type: 'color' },
      { key: 'colorMdi', label: '-DI 색상', type: 'color' },
      { key: 'colorAdx', label: 'ADX 색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.dmi(c, p.period), range: [0, 100],
    lines: [
      { key: 'pdi', colorParam: 'colorPdi' },
      { key: 'mdi', colorParam: 'colorMdi' },
      { key: 'adx', colorParam: 'colorAdx' },
    ] },
  { id: 'bias', baseName: 'BIAS', group: '서브', type: 'sub-line',
    defaults: { period: 6, color: '#8bc34a', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.bias(c, p.period) },
  { id: 'roc', baseName: 'ROC', group: '서브', type: 'sub-line',
    defaults: { period: 12, color: '#ffeb3b', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.roc(c, p.period) },
  { id: 'mtm', baseName: 'MTM', group: '서브', type: 'sub-line',
    defaults: { period: 12, color: '#795548', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.mtm(c, p.period) },
  { id: 'emv', baseName: 'EMV', group: '서브', type: 'sub-line',
    defaults: { period: 14, color: '#607d8b', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 1, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.emv(c, p.period) },
  { id: 'mfi', baseName: 'MFI', group: '서브', type: 'sub-line',
    defaults: { period: 14, color: '#ab47bc', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.mfi(c, p.period), range: [0, 100] },
  { id: 'ao', baseName: 'AO', group: '서브', type: 'sub-line',
    defaults: { color: '#26a69a', lineWidth: 1 },
    params: [
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c) => TA.ao(c) },
  { id: 'vr', baseName: 'VR', group: '서브', type: 'sub-line',
    defaults: { period: 26, color: '#2962ff', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.vr(c, p.period) },
  { id: 'psy', baseName: 'PSY', group: '서브', type: 'sub-line',
    defaults: { period: 12, color: '#f7931a', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.psy(c, p.period), range: [0, 100] },
  { id: 'atr', baseName: 'ATR', group: '서브', type: 'sub-line',
    defaults: { period: 14, color: '#787b86', lineWidth: 1 },
    params: [
      { key: 'period', label: '기간', type: 'number', min: 2, max: 100 },
      { key: 'color', label: '색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.atr(c, p.period) },
  { id: 'stoch', baseName: 'Stoch', group: '서브', type: 'sub-multi',
    defaults: { kPeriod: 14, dPeriod: 3, colorK: '#2962ff', colorD: '#f7931a', lineWidth: 1 },
    params: [
      { key: 'kPeriod', label: '%K 기간', type: 'number', min: 1, max: 100 },
      { key: 'dPeriod', label: '%D 기간', type: 'number', min: 1, max: 50 },
      { key: 'colorK', label: '%K 색상', type: 'color' },
      { key: 'colorD', label: '%D 색상', type: 'color' },
      { key: 'lineWidth', label: '선 두께', type: 'number', min: 1, max: 4 },
    ],
    compute: (c, p) => TA.stochastic(c, p.kPeriod, p.dPeriod), range: [0, 100],
    lines: [
      { key: 'k', colorParam: 'colorK' },
      { key: 'd', colorParam: 'colorD' },
    ] },
  ...(typeof INDICATOR_REGISTRY_EXTRA !== 'undefined' ? INDICATOR_REGISTRY_EXTRA : []),
];

const SETTINGS_KEY = 'crypto-charts-indicator-settings';

const IndicatorManager = (() => {
  const SUB_HEIGHT = 88;
  const MAIN_CHART_MAX = 280;
  const IN_CHART_VOL_BAND = 0.16;
  const IN_CHART_SUB_BAND = 0.11;

  function useInChartSubScales() {
    return panesEl?.classList.contains('indicator-panes--in-chart');
  }

  function subScaleId(id) {
    return `ind-${id}`;
  }

  function subSeriesOpts(sc) {
    if (!sc?.inChart || !sc.scaleId) return {};
    return { priceScaleId: sc.scaleId };
  }

  function listInChartSubs() {
    return [...active]
      .filter((id) => {
        const def = getDef(id);
        if (!def || def.group !== '서브') return false;
        if (id === 'vol' || id === 'volma') return false;
        return true;
      })
      .sort((a, b) => subPaneSortKey(a) - subPaneSortKey(b));
  }

  function layoutInChartSubScales() {
    if (!mainChart || !useInChartSubScales()) return;
    const subs = listInChartSubs();
    let bottom = IN_CHART_VOL_BAND;
    subs.forEach((id) => {
      const scaleId = subScaleId(id);
      const h = getDef(id)?.inChartBand || IN_CHART_SUB_BAND;
      mainChart.priceScale(scaleId).applyOptions({
        visible: true,
        borderColor: TV.border,
        scaleMargins: { top: 1 - bottom - h, bottom },
      });
      bottom += h;
    });
    mainChart.priceScale('right').applyOptions({
      scaleMargins: { top: 0.05, bottom: bottom + 0.02 },
    });
    mainChart.priceScale('volume').applyOptions({
      scaleMargins: { top: 1 - IN_CHART_VOL_BAND, bottom: 0 },
    });
  }

  function ensureInChartSub(id) {
    if (subCharts[id]?.inChart) {
      layoutInChartSubScales();
      return subCharts[id];
    }
    const scaleId = subScaleId(id);
    mainChart.priceScale(scaleId).applyOptions({
      visible: true,
      borderColor: TV.border,
    });
    subCharts[id] = {
      chart: mainChart,
      wrap: null,
      series: {},
      scaleId,
      inChart: true,
      el: null,
      ro: null,
    };
    layoutInChartSubScales();
    return subCharts[id];
  }
  const softUi = document.body.classList.contains('trading-page--simple');
  const TV = {
    bg: softUi ? '#16181d' : '#131722',
    text: softUi ? '#eceef2' : '#d1d4dc',
    grid: softUi ? '#22262e' : '#1e222d',
    border: softUi ? '#2a2e36' : '#2a2e39',
    up: '#26a69a',
    down: '#ef5350',
  };

  let mainChart = null;
  let candleSeries = null;
  let overlaySeries = {};
  let subCharts = {};
  let active = new Set(['ma7', 'ma25', 'ma99']);
  let userSettings = {};
  let settingsId = null;
  let panesEl = null;
  let syncLock = false;
  let settingsModalReady = false;

  const BINANCE_MACD_COLORS = {
    colorMacd: '#F0B90B',
    colorSignal: '#FFFFFF',
    histUpStrong: '#0ECB81',
    histUpWeak: 'rgba(14, 203, 129, 0.45)',
    histDownStrong: '#F6465D',
    histDownWeak: 'rgba(246, 70, 93, 0.45)',
  };

  const OUTDATED_MACD_COLORS = {
    colorMacd: ['#2962FF', '#2962ff', '#FFFFFF', '#ffffff'],
    colorSignal: ['#FF6D00', '#f7931a', '#E8EAED', '#e8eaed'],
    histUpStrong: ['#26A69A', '#26a69a', '#6EE7A8', '#6ee7a8'],
    histUpWeak: ['rgba(38, 166, 154, 0.45)', 'rgba(38,166,154,0.45)', 'rgba(38, 166, 154, 0.6)', 'rgba(110, 231, 168, 0.5)'],
    histDownStrong: ['#EF5350', '#ef5350', '#FCA5A5', '#fca5a5'],
    histDownWeak: ['rgba(239, 83, 80, 0.45)', 'rgba(239,83,80,0.45)', 'rgba(239, 83, 80, 0.6)', 'rgba(252, 165, 165, 0.5)'],
  };

  function migrateMacdColors() {
    const macd = userSettings.macd;
    if (!macd) return;
    let changed = false;
    Object.entries(OUTDATED_MACD_COLORS).forEach(([key, outdated]) => {
      if (outdated.includes(macd[key])) {
        macd[key] = BINANCE_MACD_COLORS[key];
        changed = true;
      }
    });
    if (changed) saveSettings();
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) userSettings = JSON.parse(raw);
    } catch {
      userSettings = {};
    }
    migrateMacdColors();
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings));
    } catch { /* ignore */ }
  }

  function getDef(id) {
    return INDICATOR_REGISTRY.find((d) => d.id === id);
  }

  function getParams(id) {
    const def = getDef(id);
    if (!def) return {};
    return { ...def.defaults, ...(userSettings[id] || {}) };
  }

  function getDisplayName(id) {
    const def = getDef(id);
    if (!def) return id;
    const p = getParams(id);
    if (p.period != null && ['MA', 'EMA', 'WMA', 'DEMA', 'TEMA', 'TRIMA', 'HMA', 'RSI', 'CCI', 'WR', 'BIAS', 'ROC', 'MTM', 'EMV', 'MFI', 'VR', 'PSY', 'ATR', 'TRIX', 'DPO', 'CMO', 'CMF', 'VROC', 'SROC', 'MASS', 'ADTM', 'TAPI', 'AVL'].includes(def.baseName)) {
      return `${def.baseName}(${p.period})`;
    }
    if (def.id === 'kc') return `KC(${p.period})`;
    if (def.id === 'dc') return `DC(${p.period})`;
    if (def.id === 'ichimoku') return `Ichimoku(${p.tenkan}/${p.kijun})`;
    if (def.id === 'mike') return `MIKE(${p.period})`;
    if (def.id === 'dma') return `DMA(${p.short},${p.long})`;
    if (def.id === 'cr') return `CR(${p.period})`;
    if (def.id === 'brar') return `BRAR(${p.period})`;
    if (def.id === 'aroon') return `Aroon(${p.period})`;
    if (def.id === 'stochrsi') return `StochRSI(${p.period})`;
    if (def.id === 'uo') return `UO(${p.p1}/${p.p2}/${p.p3})`;
    if (def.id === 'ppo') return `PPO(${p.fast},${p.slow})`;
    if (def.id === 'priceosc') return `PriceOsc(${p.short},${p.long})`;
    if (def.id === 'cho') return `CHO(${p.fast},${p.slow})`;
    if (def.id === 'boll') return `BOLL(${p.period},${p.mult})`;
    if (def.id === 'env') return `ENV(${p.period})`;
    if (def.id === 'macd') return `MACD(${p.fast},${p.slow},${p.signal})`;
    if (def.id === 'kdj') return `KDJ(${p.n},${p.m1},${p.m2})`;
    if (def.id === 'stoch') return `Stoch(${p.kPeriod},${p.dPeriod})`;
    if (def.id === 'dmi') return `DMI(${p.period})`;
    if (def.id === 'volma') return `VOL MA(${p.period})`;
    if (def.id === 'sar') return `SAR(${p.step})`;
    return def.baseName;
  }

  function autoscaleOff() {
    return () => ({ priceRange: null });
  }

  function hexToRgba(hex, alpha) {
    const h = (hex || '#2962ff').replace('#', '');
    if (h.length < 6) return `rgba(41, 98, 255, ${alpha})`;
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function bandLineOptions(color, lw) {
    return {
      color,
      lineWidth: lw,
      lineStyle: LightweightCharts.LineStyle.Solid,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
      autoscaleInfoProvider: autoscaleOff(),
    };
  }

  function createOverlaySeries(id, params) {
    if (overlaySeries[id]) {
      overlaySeries[id].applyOptions({ color: params.color, lineWidth: params.lineWidth || 1 });
      return overlaySeries[id];
    }
    const s = mainChart.addLineSeries({
      color: params.color,
      lineWidth: params.lineWidth || 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: autoscaleOff(),
    });
    overlaySeries[id] = s;
    return s;
  }

  function createBandSeries(id, params, def) {
    const lw = params.lineWidth || 1.5;
    const midColor = hexToRgba(params.color, 0.65);
    const lineColors = [params.color, midColor, params.color];
    const withFill = def?.bandFill;

    if (overlaySeries[id] && withFill && !overlaySeries[id].fillLower) {
      Object.values(overlaySeries[id]).forEach((s) => mainChart.removeSeries(s));
      delete overlaySeries[id];
    }

    if (overlaySeries[id]) {
      ['upper', 'middle', 'lower'].forEach((k, i) => {
        overlaySeries[id][k]?.applyOptions(bandLineOptions(lineColors[i], lw));
      });
      if (withFill) {
        const fillColor = hexToRgba(params.color, params.fillOpacity ?? 0.1);
        overlaySeries[id].fillLower?.applyOptions({ topColor: fillColor });
        overlaySeries[id].fillUpper?.applyOptions({ topColor: TV.bg });
      }
      return;
    }

    overlaySeries[id] = {};

    if (withFill) {
      const fillColor = hexToRgba(params.color, params.fillOpacity ?? 0.1);
      overlaySeries[id].fillLower = mainChart.addAreaSeries({
        lineColor: 'transparent',
        topColor: fillColor,
        bottomColor: 'transparent',
        invertFilledArea: true,
        lineWidth: 0,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        autoscaleInfoProvider: autoscaleOff(),
      });
      overlaySeries[id].fillUpper = mainChart.addAreaSeries({
        lineColor: 'transparent',
        topColor: TV.bg,
        bottomColor: 'transparent',
        invertFilledArea: true,
        lineWidth: 0,
        crosshairMarkerVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        autoscaleInfoProvider: autoscaleOff(),
      });
    }

    ['upper', 'middle', 'lower'].forEach((k, i) => {
      overlaySeries[id][k] = mainChart.addLineSeries(bandLineOptions(lineColors[i], lw));
    });
  }

  function fixedRangeProvider(min, max) {
    return () => ({ priceRange: { minValue: min, maxValue: max } });
  }

  function ensureRsiSeries(sc, params, lw, range) {
    const [minR, maxR] = range;
    const rp = fixedRangeProvider(minR, maxR);
    const scaleOpts = subSeriesOpts(sc);
    const base = {
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: rp,
      ...scaleOpts,
    };
    const levelColor = 'rgba(209, 212, 220, 0.45)';
    const zoneFill = 'rgba(128, 138, 163, 0.16)';

    if (!sc.series.fillLower) {
      sc.series.fillLower = sc.chart.addAreaSeries({
        lineColor: 'transparent',
        topColor: zoneFill,
        bottomColor: 'transparent',
        invertFilledArea: true,
        lineWidth: 0,
        ...base,
      });
      sc.series.fillUpper = sc.chart.addAreaSeries({
        lineColor: 'transparent',
        topColor: TV.bg,
        bottomColor: 'transparent',
        invertFilledArea: true,
        lineWidth: 0,
        ...base,
      });
      sc.series.level70 = sc.chart.addLineSeries({
        color: levelColor,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        ...base,
      });
      sc.series.level30 = sc.chart.addLineSeries({
        color: levelColor,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        ...base,
      });
    }

    if (!sc.series.main) {
      sc.series.main = sc.chart.addLineSeries({
        color: params.color,
        lineWidth: lw,
        ...base,
        lastValueVisible: true,
      });
    } else {
      sc.series.main.applyOptions({ color: params.color, lineWidth: lw, autoscaleInfoProvider: rp });
    }
  }

  function applySubRsi(sc, candles, data, params, lw, range) {
    ensureRsiSeries(sc, params, lw, range);
    const level70 = candles.map((c) => ({ time: c.time, value: 70 }));
    const level30 = candles.map((c) => ({ time: c.time, value: 30 }));
    sc.series.fillLower.setData(level30);
    sc.series.fillUpper.setData(level70);
    sc.series.level70.setData(level70);
    sc.series.level30.setData(level30);
    sc.series.main.setData(Array.isArray(data) ? data : []);

    const last = data?.at(-1)?.value;
    const label = sc.wrap?.querySelector('.indicator-pane__label');
    if (label) {
      label.innerHTML = `<span class="indicator-pane__title">${getDisplayName('rsi')}</span>
      <span class="indicator-pane__values">
        <span style="color:${params.color}">RSI ${last != null ? last.toFixed(2) : '—'}</span>
      </span>`;
    }
  }

  function getSubChartOptions(def) {
    return {
      rightPriceScale: {
        borderColor: TV.border,
        scaleMargins: def?.subMargins || { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: TV.border,
        visible: false,
        rightOffset: def?.rightOffset ?? 5,
      },
    };
  }

  function subPaneSortKey(id) {
    if (id === 'vol') return 0;
    if (id === 'volma') return 1;
    const idx = INDICATOR_REGISTRY.findIndex((d) => d.id === id);
    return 100 + (idx >= 0 ? idx : 999);
  }

  function reorderSubPanes() {
    if (useInChartSubScales()) {
      layoutInChartSubScales();
      resizeMainChart();
      return;
    }
    if (!panesEl) return;
    const subs = [...active].filter((id) => getDef(id)?.group === '서브');
    subs.sort((a, b) => subPaneSortKey(a) - subPaneSortKey(b));
    subs.forEach((id) => {
      const wrap = subCharts[id]?.wrap;
      if (wrap) panesEl.appendChild(wrap);
    });
    resizeMainChart();
  }

  function createSubChart(id) {
    if (useInChartSubScales()) {
      return ensureInChartSub(id);
    }

    const def = getDef(id);
    const height = def?.subHeight || SUB_HEIGHT;
    const chartOpts = getSubChartOptions(def);

    if (subCharts[id]) {
      subCharts[id].el.style.height = `${height}px`;
      subCharts[id].chart.applyOptions({ height, ...chartOpts });
      reorderSubPanes();
      return subCharts[id];
    }

    const wrap = document.createElement('div');
    wrap.className = 'indicator-pane';
    if (def?.type === 'sub-macd') wrap.classList.add('indicator-pane--macd');
    wrap.dataset.id = id;
    wrap.innerHTML = `<div class="indicator-pane__label"></div><div class="indicator-pane__chart"></div>`;
    panesEl.appendChild(wrap);

    const el = wrap.querySelector('.indicator-pane__chart');
    el.style.height = `${height}px`;
    const sub = LightweightCharts.createChart(el, {
      layout: { background: { type: 'solid', color: TV.bg }, textColor: TV.text, fontSize: 10 },
      grid: { vertLines: { color: TV.grid }, horzLines: { color: TV.grid } },
      ...chartOpts,
      handleScroll: false,
      handleScale: false,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      width: el.clientWidth,
      height: height,
    });

    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) sub.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);

    subCharts[id] = { chart: sub, el, wrap, series: {}, ro };
    syncTimeScale(sub);
    reorderSubPanes();
    return subCharts[id];
  }

  function syncTimeScale(subChart) {
    if (!mainChart) return;
    const mainTs = mainChart.timeScale();
    const subTs = subChart.timeScale();
    mainTs.subscribeVisibleLogicalRangeChange((range) => {
      if (syncLock || !range) return;
      syncLock = true;
      subTs.setVisibleLogicalRange(range);
      syncLock = false;
    });
    subTs.subscribeVisibleLogicalRangeChange((range) => {
      if (syncLock || !range) return;
      syncLock = true;
      mainTs.setVisibleLogicalRange(range);
      syncLock = false;
    });
  }

  function removeOverlay(id) {
    const def = getDef(id);
    const entry = overlaySeries[id];
    if (!def || !entry) return;
    if (def.type === 'overlay-band' || def.type === 'overlay-multi') {
      Object.values(entry).forEach((s) => mainChart.removeSeries(s));
    } else {
      mainChart.removeSeries(entry);
    }
    delete overlaySeries[id];
  }

  function removeSub(id) {
    const sc = subCharts[id];
    if (!sc) return;
    if (sc.inChart) {
      Object.values(sc.series).forEach((series) => {
        if (series && mainChart) {
          try { mainChart.removeSeries(series); } catch { /* ignore */ }
        }
      });
      delete subCharts[id];
      layoutInChartSubScales();
      resizeMainChart();
      return;
    }
    sc.ro.disconnect();
    sc.chart.remove();
    sc.wrap.remove();
    delete subCharts[id];
    reorderSubPanes();
  }

  function applyOverlayLines(id, data, params, lines) {
    if (!overlaySeries[id]) overlaySeries[id] = {};
    lines.forEach(({ key, colorParam }) => {
      const color = params[colorParam] || params.color || '#2962ff';
      const lw = params.lineWidth || 1;
      if (!overlaySeries[id][key]) {
        overlaySeries[id][key] = mainChart.addLineSeries({
          color,
          lineWidth: lw,
          priceLineVisible: false,
          lastValueVisible: false,
          autoscaleInfoProvider: autoscaleOff(),
        });
      } else {
        overlaySeries[id][key].applyOptions({ color, lineWidth: lw });
      }
      overlaySeries[id][key].setData(data[key] || []);
    });
  }

  function applyOverlay(id, candles) {
    const def = getDef(id);
    if (!def) return;
    const params = getParams(id);
    const data = def.compute(candles, params);

    if (def.type === 'overlay-band') {
      createBandSeries(id, params, def);
      if (def.bandFill && overlaySeries[id].fillLower) {
        overlaySeries[id].fillLower.setData(data.lower || []);
        overlaySeries[id].fillUpper.setData(data.upper || []);
      }
      overlaySeries[id].upper.setData(data.upper || []);
      overlaySeries[id].middle.setData(data.middle || []);
      overlaySeries[id].lower.setData(data.lower || []);
      return;
    }

    if (def.type === 'overlay-multi' && def.lines) {
      applyOverlayLines(id, data, params, def.lines);
      return;
    }

    const series = createOverlaySeries(id, params);
    const points = Array.isArray(data) ? data : data.upper || [];
    series.setData(points);
  }

  function applySubLines(sc, data, params, lines) {
    const lw = params.lineWidth || 1;
    const scaleOpts = subSeriesOpts(sc);
    lines.forEach(({ key, colorParam }) => {
      const color = params[colorParam] || params.color || '#2962ff';
      if (!sc.series[key]) {
        sc.series[key] = sc.chart.addLineSeries({
          color, lineWidth: lw, priceLineVisible: false, lastValueVisible: false,
          ...scaleOpts,
        });
      } else {
        sc.series[key].applyOptions({ color, lineWidth: lw });
      }
      sc.series[key].setData(data[key] || []);
    });
  }

  function applySub(id, candles) {
    const def = getDef(id);
    if (!def) return;
    const params = getParams(id);

    if (useInChartSubScales() && (def.type === 'sub-vol' || def.type === 'sub-vol-line')) {
      document.dispatchEvent(new CustomEvent('indicators-changed'));
      return;
    }

    const sc = createSubChart(id);
    if (sc.wrap) {
      sc.wrap.querySelector('.indicator-pane__label').textContent = getDisplayName(id);
    }
    const data = def.compute(candles, params);
    const lw = params.lineWidth || 1;
    const scaleOpts = subSeriesOpts(sc);

    if (def.type === 'sub-vol') {
      if (!sc.series.vol) {
        sc.series.vol = sc.chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
      const volData = candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      }));
      sc.series.vol.setData(volData);
      return;
    }

    if (def.type === 'sub-vol-line') {
      if (!sc.series.vol) {
        sc.series.vol = sc.chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceLineVisible: false,
          lastValueVisible: false,
        });
      }
      if (!sc.series.line) {
        sc.series.line = sc.chart.addLineSeries({
          color: params.color, lineWidth: lw, priceLineVisible: false, lastValueVisible: false,
        });
      } else {
        sc.series.line.applyOptions({ color: params.color, lineWidth: lw });
      }
      const volData = candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      }));
      sc.series.vol.setData(volData);
      sc.series.line.setData(data);
      return;
    }

    if (def.type === 'sub-rsi') {
      if (sc.series.main && !sc.series.fillLower) {
        removeSub(id);
        sc = createSubChart(id);
      }
      applySubRsi(sc, candles, data, params, lw, def.range || [0, 100]);
      return;
    }

    if (def.type === 'sub-macd') {
      if (!sc.inChart) sc.chart.applyOptions(getSubChartOptions(def));

      if (!sc.series.hist) {
        sc.series.hist = sc.chart.addHistogramSeries({
          priceFormat: { type: 'price', precision: 4, minMove: 0.0001 },
          priceLineVisible: false,
          lastValueVisible: false,
          ...scaleOpts,
        });
        sc.series.macd = sc.chart.addLineSeries({
          color: params.colorMacd, lineWidth: lw, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
          ...scaleOpts,
        });
        sc.series.signal = sc.chart.addLineSeries({
          color: params.colorSignal, lineWidth: lw, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
          ...scaleOpts,
        });
        sc.series.zero = sc.chart.addLineSeries({
          color: 'rgba(209, 212, 220, 0.25)',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...scaleOpts,
        });
      } else {
        sc.series.macd.applyOptions({ color: params.colorMacd, lineWidth: lw });
        sc.series.signal.applyOptions({ color: params.colorSignal, lineWidth: lw });
      }
      sc.series.hist.setData(data.histogram || []);
      sc.series.macd.setData(data.macd || []);
      sc.series.signal.setData(data.signal || []);
      sc.series.zero.setData(candles.map((c) => ({ time: c.time, value: 0 })));

      const fmt = (v) => (v != null ? v.toFixed(4) : '—');
      const lastMacd = data.macd?.at(-1)?.value;
      const lastSignal = data.signal?.at(-1)?.value;
      const lastHist = data.histogram?.at(-1)?.value;
      const histColor = lastHist >= 0 ? params.histUpStrong : params.histDownStrong;
      const label = sc.wrap?.querySelector('.indicator-pane__label');
      if (label) {
        label.innerHTML = `<span class="indicator-pane__title">${getDisplayName(id)}</span>
        <span class="indicator-pane__values">
          <span style="color:${params.colorMacd}">DIF ${fmt(lastMacd)}</span>
          <span style="color:${params.colorSignal}">DEA ${fmt(lastSignal)}</span>
          <span style="color:${histColor}">MACD ${fmt(lastHist)}</span>
        </span>`;
      }
      return;
    }

    if (def.type === 'sub-multi') {
      const lines = def.lines || [];
      if (lines.length) {
        applySubLines(sc, data, params, lines);
        return;
      }
    }

    if (!sc.series.main) {
      sc.series.main = sc.chart.addLineSeries({
        color: params.color, lineWidth: lw, priceLineVisible: false, lastValueVisible: false,
        ...scaleOpts,
      });
    } else {
      sc.series.main.applyOptions({ color: params.color, lineWidth: lw });
    }
    sc.series.main.setData(Array.isArray(data) ? data : []);
  }

  function getIndicatorColor(id) {
    const p = getParams(id);
    return p.color || p.colorMacd || p.colorK || p.colorTenkan || getDef(id)?.defaults?.color || '#2962ff';
  }

  function renderTagHtml(id) {
    const def = getDef(id);
    if (!def) return '';
    const gear = def.params?.length
      ? `<button type="button" class="indicator-tag__gear" data-settings="${id}" title="설정">⚙</button>`
      : '';
    return `<span class="indicator-tag" data-id="${id}">
      <span class="indicator-tag__dot" style="background:${getIndicatorColor(id)}"></span>
      <span class="indicator-tag__name">${getDisplayName(id)}</span>${gear}
      <button type="button" class="indicator-tag__remove" aria-label="제거">×</button>
    </span>`;
  }

  function bindTagEvents(el) {
    el.querySelectorAll('.indicator-tag__remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('.indicator-tag')?.dataset.id;
        if (!id) return;
        active.delete(id);
        const def = getDef(id);
        if (def?.type.startsWith('overlay')) removeOverlay(id);
        else removeSub(id);
        const inp = document.querySelector(`input[data-indicator="${id}"]`);
        if (inp) inp.checked = false;
        resizeMainChart();
        if (window.__lastCandles?.length) update(window.__lastCandles);
        renderActiveTags();
        document.dispatchEvent(new CustomEvent('indicators-changed'));
      });
    });
    el.querySelectorAll('.indicator-tag__gear').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings(btn.dataset.settings);
      });
    });
  }

  function calcMainChartHeight(workspace) {
    const embedded = panesEl?.classList.contains('indicator-panes--in-chart');
    if (!embedded) return Math.min(workspace.clientHeight, MAIN_CHART_MAX);
    if (useInChartSubScales()) {
      const container = workspace.closest('.chart-container');
      const base = Math.max(container?.clientHeight || 0, workspace.clientHeight);
      return Math.max(180, Math.round(base));
    }
    const subH = panesEl?.clientHeight || 0;
    return Math.max(180, workspace.clientHeight - subH);
  }

  function resizeMainChart() {
    const area = document.getElementById('chartArea');
    const workspace = document.querySelector('.chart-workspace');
    if (!area || !mainChart || !workspace) return;
    const h = calcMainChartHeight(workspace);
    mainChart.applyOptions({ height: h });
    area.style.height = `${h}px`;
    if (panesEl?.classList.contains('indicator-panes--in-chart')) {
      requestAnimationFrame(() => {
        if (!mainChart || !workspace) return;
        const next = calcMainChartHeight(workspace);
        if (next !== h) {
          mainChart.applyOptions({ height: next });
          area.style.height = `${next}px`;
        }
      });
    }
  }

  function openSettings(id) {
    const def = getDef(id);
    if (!def || !def.params?.length) return;
    settingsId = id;
    const modal = document.getElementById('indicatorSettingsModal');
    const form = document.getElementById('indicatorSettingsForm');
    const title = document.getElementById('indicatorSettingsTitle');
    if (!modal || !form) return;

    title.textContent = `${def.baseName} 설정`;
    const params = getParams(id);
    form.innerHTML = def.params.map((field) => {
      const val = params[field.key];
      if (field.type === 'color') {
        return `<label class="indicator-settings__field">
          <span>${field.label}</span>
          <input type="color" name="${field.key}" value="${val}">
        </label>`;
      }
      const step = field.step ? ` step="${field.step}"` : '';
      const min = field.min != null ? ` min="${field.min}"` : '';
      const max = field.max != null ? ` max="${field.max}"` : '';
      return `<label class="indicator-settings__field">
        <span>${field.label}</span>
        <input type="number" name="${field.key}" value="${val}"${min}${max}${step}>
      </label>`;
    }).join('');

    modal.classList.remove('hidden');
    document.getElementById('indicatorMenu')?.classList.add('hidden');
  }

  function closeSettings() {
    settingsId = null;
    document.getElementById('indicatorSettingsModal')?.classList.add('hidden');
  }

  function applySettingsFromForm() {
    if (!settingsId) return;
    const def = getDef(settingsId);
    const form = document.getElementById('indicatorSettingsForm');
    if (!def || !form) return;

    const next = { ...getParams(settingsId) };
    def.params.forEach((field) => {
      const inp = form.elements[field.key];
      if (!inp) return;
      next[field.key] = field.type === 'color' ? inp.value : parseFloat(inp.value);
    });
    userSettings[settingsId] = next;
    saveSettings();

    if (active.has(settingsId) && window.__lastCandles?.length) {
      update(window.__lastCandles);
    }
    renderMenu();
    renderActiveTags();
    closeSettings();
    document.dispatchEvent(new CustomEvent('indicators-changed'));
  }

  function resetSettingsForm() {
    if (!settingsId) return;
    delete userSettings[settingsId];
    saveSettings();
    openSettings(settingsId);
    if (active.has(settingsId) && window.__lastCandles?.length) {
      update(window.__lastCandles);
    }
    renderMenu();
    renderActiveTags();
    document.dispatchEvent(new CustomEvent('indicators-changed'));
  }

  function setupSettingsModal() {
    if (settingsModalReady) return;
    settingsModalReady = true;
    document.getElementById('indicatorSettingsClose')?.addEventListener('click', closeSettings);
    document.getElementById('indicatorSettingsBackdrop')?.addEventListener('click', closeSettings);
    document.getElementById('indicatorSettingsApply')?.addEventListener('click', applySettingsFromForm);
    document.getElementById('indicatorSettingsReset')?.addEventListener('click', resetSettingsForm);
    document.getElementById('indicatorSettingsForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      applySettingsFromForm();
    });
  }

  function renderMenu(filter = '') {
    const menu = document.getElementById('indicatorMenuList');
    if (!menu) return;
    const q = filter.trim().toLowerCase();
    const groups = {};
    INDICATOR_REGISTRY.forEach((d) => {
      const name = getDisplayName(d.id).toLowerCase();
      if (q && !name.includes(q) && !d.baseName.toLowerCase().includes(q) && !d.id.includes(q)) return;
      if (!groups[d.group]) groups[d.group] = [];
      groups[d.group].push(d);
    });
    menu.innerHTML = Object.entries(groups).map(([g, items]) => `
      <div class="indicator-menu__group">
        <div class="indicator-menu__title">${g} 차트 (${items.length})</div>
        ${items.map((d) => `
          <div class="indicator-menu__item">
            <label class="indicator-menu__check">
              <input type="checkbox" data-indicator="${d.id}" ${active.has(d.id) ? 'checked' : ''}>
              <span>${getDisplayName(d.id)}</span>
            </label>
            ${d.params?.length ? `<button type="button" class="indicator-menu__gear" data-settings="${d.id}" title="설정">⚙</button>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('') || '<div class="indicator-menu__empty">검색 결과 없음</div>';

    menu.querySelectorAll('input[data-indicator]').forEach((inp) => {
      inp.addEventListener('change', () => toggle(inp.dataset.indicator, inp.checked));
    });
    menu.querySelectorAll('[data-settings]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openSettings(btn.dataset.settings);
      });
    });
  }

  function toggle(id, on) {
    const def = getDef(id);
    if (!def) return;
    if (on) active.add(id);
    else {
      active.delete(id);
      if (def.type.startsWith('overlay')) removeOverlay(id);
      else removeSub(id);
    }
    resizeMainChart();
    if (window.__lastCandles?.length) update(window.__lastCandles);
    renderActiveTags();
    reorderSubPanes();
    document.dispatchEvent(new CustomEvent('indicators-changed'));
  }

  function renderActiveTags() {
    const el = document.getElementById('activeIndicators');
    if (!el) return;

    if (!active.size) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }

    el.classList.remove('hidden');
    const mainIds = [...active].filter((id) => getDef(id)?.group === '메인');
    const subIds = [...active].filter((id) => getDef(id)?.group === '서브');
    const groupHtml = (title, ids) => (ids.length ? `
      <div class="indicator-overview__group">
        <div class="indicator-overview__group-title">${title} (${ids.length})</div>
        <div class="indicator-overview__tags">${ids.map(renderTagHtml).join('')}</div>
      </div>
    ` : '');

    el.innerHTML = `
      <div class="indicator-overview__header">
        <span>활성 지표</span>
        <span class="indicator-overview__count">${active.size}개</span>
      </div>
      <div class="indicator-overview__groups">
        ${groupHtml('메인 차트', mainIds)}
        ${groupHtml('서브 차트', subIds)}
      </div>
    `;
    bindTagEvents(el);
  }

  function update(candles) {
    if (!mainChart || !candles?.length) return;
    window.__lastCandles = candles;
    active.forEach((id) => {
      const def = getDef(id);
      if (!def) return;
      if (def.type.startsWith('overlay')) applyOverlay(id, candles);
      else applySub(id, candles);
    });
    resizeMainChart();
  }

  function pushSeriesTail(series, points, tail = 1) {
    if (!series || !points?.length) return;
    const start = Math.max(0, points.length - tail);
    for (let i = start; i < points.length; i++) {
      series.update(points[i]);
    }
  }

  function updateLiveOverlay(id, candles, newBar) {
    const def = getDef(id);
    const entry = overlaySeries[id];
    if (!def || !entry) return;

    const params = getParams(id);
    const data = def.compute(candles, params);
    const tail = newBar ? 2 : 1;

    if (def.type === 'overlay-band') {
      pushSeriesTail(entry.upper, data.upper, tail);
      pushSeriesTail(entry.middle, data.middle, tail);
      pushSeriesTail(entry.lower, data.lower, tail);
      if (entry.fillLower) pushSeriesTail(entry.fillLower, data.lower, tail);
      if (entry.fillUpper) pushSeriesTail(entry.fillUpper, data.upper, tail);
      return;
    }

    if (def.type === 'overlay-multi' && def.lines) {
      def.lines.forEach(({ key }) => pushSeriesTail(entry[key], data[key], tail));
      return;
    }

    const points = Array.isArray(data) ? data : data.upper || [];
    pushSeriesTail(entry, points, tail);
  }

  function updateLiveSubRsi(sc, candles, data, params, lw, range) {
    const tail = 1;
    const lastCandle = candles.at(-1);
    if (!lastCandle) return;

    pushSeriesTail(sc.series.main, data, tail);
    const levelPoint = { time: lastCandle.time, value: 70 };
    const levelPointLow = { time: lastCandle.time, value: 30 };
    pushSeriesTail(sc.series.level70, [levelPoint], 1);
    pushSeriesTail(sc.series.level30, [levelPointLow], 1);
    pushSeriesTail(sc.series.fillLower, [levelPointLow], 1);
    pushSeriesTail(sc.series.fillUpper, [levelPoint], 1);

    const last = data?.at(-1)?.value;
    const label = sc.wrap.querySelector('.indicator-pane__label');
    if (label) {
      label.innerHTML = `<span class="indicator-pane__title">${getDisplayName('rsi')}</span>
        <span class="indicator-pane__values">
          <span style="color:${params.color}">RSI ${last != null ? last.toFixed(2) : '—'}</span>
        </span>`;
    }
  }

  function updateLiveSub(id, candles, newBar) {
    const def = getDef(id);
    const sc = subCharts[id];
    if (!def || !sc) return;

    const params = getParams(id);
    const data = def.compute(candles, params);
    const lw = params.lineWidth || 1;
    const tail = newBar ? 2 : 1;
    const lastCandle = candles.at(-1);
    if (!lastCandle) return;

    if (def.type === 'sub-vol') {
      if (!sc.series.vol) return;
      sc.series.vol.update({
        time: lastCandle.time,
        value: lastCandle.volume,
        color: lastCandle.close >= lastCandle.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
      });
      return;
    }

    if (def.type === 'sub-vol-line') {
      if (sc.series.vol) {
        sc.series.vol.update({
          time: lastCandle.time,
          value: lastCandle.volume,
          color: lastCandle.close >= lastCandle.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
        });
      }
      pushSeriesTail(sc.series.line, data, tail);
      return;
    }

    if (def.type === 'sub-rsi') {
      updateLiveSubRsi(sc, candles, data, params, lw, def.range || [0, 100]);
      return;
    }

    if (def.type === 'sub-macd') {
      pushSeriesTail(sc.series.hist, data.histogram, tail);
      pushSeriesTail(sc.series.macd, data.macd, tail);
      pushSeriesTail(sc.series.signal, data.signal, tail);
      pushSeriesTail(sc.series.zero, [{ time: lastCandle.time, value: 0 }], 1);

      const fmt = (v) => (v != null ? v.toFixed(4) : '—');
      const lastMacd = data.macd?.at(-1)?.value;
      const lastSignal = data.signal?.at(-1)?.value;
      const lastHist = data.histogram?.at(-1)?.value;
      const histColor = lastHist >= 0 ? params.histUpStrong : params.histDownStrong;
      const label = sc.wrap.querySelector('.indicator-pane__label');
      if (label) {
        label.innerHTML = `<span class="indicator-pane__title">${getDisplayName(id)}</span>
          <span class="indicator-pane__values">
            <span style="color:${params.colorMacd}">DIF ${fmt(lastMacd)}</span>
            <span style="color:${params.colorSignal}">DEA ${fmt(lastSignal)}</span>
            <span style="color:${histColor}">MACD ${fmt(lastHist)}</span>
          </span>`;
      }
      return;
    }

    if (def.type === 'sub-multi' && def.lines?.length) {
      def.lines.forEach(({ key }) => pushSeriesTail(sc.series[key], data[key], tail));
      return;
    }

    pushSeriesTail(sc.series.main, Array.isArray(data) ? data : [], tail);
  }

  function updateLive(candles, { newBar = false } = {}) {
    if (!mainChart || !candles?.length || !active.size) return;
    window.__lastCandles = candles;

    active.forEach((id) => {
      const def = getDef(id);
      if (!def) return;
      if (def.type.startsWith('overlay')) updateLiveOverlay(id, candles, newBar);
      else updateLiveSub(id, candles, newBar);
    });
  }

  function init(chart, series) {
    loadSettings();
    mainChart = chart;
    candleSeries = series;
    panesEl = document.getElementById('indicatorPanes');
    setupSettingsModal();
    renderMenu();
    document.getElementById('indicatorSearch')?.addEventListener('input', (e) => {
      renderMenu(e.target.value);
    });
    renderActiveTags();
    layoutInChartSubScales();
    resizeMainChart();
    reorderSubPanes();
  }

  function onResize() {
    resizeMainChart();
    Object.values(subCharts).forEach((sc) => {
      if (sc.inChart || !sc.el) return;
      if (sc.el.clientWidth > 0) sc.chart.applyOptions({ width: sc.el.clientWidth });
    });
    layoutInChartSubScales();
  }

  function clear() {
    [...active].forEach((id) => {
      const def = getDef(id);
      if (def?.type.startsWith('overlay')) removeOverlay(id);
      else removeSub(id);
    });
  }

  function setParams(id, partial) {
    const def = getDef(id);
    if (!def || !partial) return false;
    userSettings[id] = { ...(userSettings[id] || {}), ...partial };
    saveSettings();
    if (active.has(id) && window.__lastCandles?.length) {
      if (def.type.startsWith('overlay')) applyOverlay(id, window.__lastCandles);
      else applySub(id, window.__lastCandles);
    }
    renderMenu();
    renderActiveTags();
    document.dispatchEvent(new CustomEvent('indicators-changed'));
    return true;
  }

  return { init, update, updateLive, toggle, onResize, clear, openSettings, setParams, active, getParams, getDisplayName, INDICATOR_REGISTRY, count: () => INDICATOR_REGISTRY.length };
})();
