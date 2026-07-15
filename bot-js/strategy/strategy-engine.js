/* Rule-based entry engine — uses chart indicator registry (76 indicators) */
const StrategyEngine = (() => {
  const PRICE_FIELDS = new Set(['price', 'close', 'open', 'high', 'low', 'volume']);

  const GENERIC_COMPUTE = {
    ma: (c, p) => TA.ma(c, p.period),
    sma: (c, p) => TA.ma(c, p.period),
    ema: (c, p) => TA.emaLine(c, p.period),
    wma: (c, p) => TA.wmaLine(c, p.period),
    dema: (c, p) => TA.dema(c, p.period),
    tema: (c, p) => TA.tema(c, p.period),
    rsi: (c, p) => TA.rsi(c, p.period),
    macd: (c, p) => TA.macd(c, p.fast ?? 12, p.slow ?? 26, p.signal ?? 9),
    boll: (c, p) => TA.bollinger(c, p.period ?? 20, p.mult ?? 2),
    stoch: (c, p) => TA.stochastic(c, p.kPeriod ?? 14, p.dPeriod ?? 3),
    kdj: (c, p) => TA.kdj(c, p.period ?? 9, p.k ?? 3, p.d ?? 3),
    cci: (c, p) => TA.cci(c, p.period ?? 20),
    atr: (c, p) => TA.atr(c, p.period ?? 14),
    obv: (c) => TA.obv(c),
    mfi: (c, p) => TA.mfi(c, p.period ?? 14),
    wr: (c, p) => TA.williamsR(c, p.period ?? 14),
    roc: (c, p) => TA.roc(c, p.period ?? 12),
    psar: (c, p) => TA.psar(c, p.step ?? 0.02, p.max ?? 0.2),
    vwap: (c) => TA.vwap(c),
    hma: (c, p) => TA.hma(c, p.period ?? 20),
  };

  function registry() {
    if (typeof IndicatorManager !== 'undefined' && IndicatorManager.INDICATOR_REGISTRY) {
      return IndicatorManager.INDICATOR_REGISTRY;
    }
    if (typeof INDICATOR_REGISTRY !== 'undefined') return INDICATOR_REGISTRY;
    return [];
  }

  function getDef(id) {
    return registry().find((d) => d.id === id) || null;
  }

  function mergeParams(def, params = {}) {
    if (!def) return { ...params };
    return { ...def.defaults, ...params };
  }

  function outputFields(def) {
    if (!def) return ['value'];
    if (def.lines?.length) return def.lines.map((l) => l.key);
    if (def.type === 'overlay-band') return ['upper', 'middle', 'lower'];
    if (def.id === 'macd' || def.type === 'sub-macd') return ['macd', 'signal', 'histogram'];
    if (def.id === 'vol' || def.type === 'sub-vol') return ['volume'];
    if (def.id === 'rsi' || def.type === 'sub-rsi') return ['value'];
    return ['value'];
  }

  function buildCatalog() {
    return registry().map((def) => ({
      id: def.id,
      name: def.baseName,
      group: def.group,
      type: def.type,
      fields: outputFields(def),
      params: (def.params || []).map((p) => p.key),
    }));
  }

  function catalogForAi() {
    const lines = registry().map((def) => {
      const fields = outputFields(def);
      const fieldStr = fields.join(', ');
      const params = (def.params || [])
        .map((p) => p.key)
        .filter((k) => !['color', 'lineWidth', 'fillOpacity'].includes(k) && !/color/i.test(k))
        .join(', ') || '-';
      const multi = fields.length > 1 ? ' [MULTI: field REQUIRED]' : '';
      return `- ${def.id} (${def.baseName}): fields=[${fieldStr}], params=[${params}]${multi}`;
    });
    lines.push('- price refs: close, open, high, low, volume (source: price, offset: 0=current bar)');
    lines.push('- IMPORTANT: for MULTI-field indicators you MUST set operand.field to one of the listed fields.');
    lines.push('  macd → field: macd|signal|histogram · stoch → k|d · kdj → k|d|j · dmi → pdi|mdi|adx');
    lines.push('- use the EXACT param names shown above (e.g. macd fast/slow/signal, kdj n/m1/m2, stoch kPeriod/dPeriod).');
    lines.push('- generic aliases: ma, ema, rsi, macd, boll, stoch, kdj, cci, atr, obv, mfi, wr, roc, psar, vwap, hma');
    lines.push('- cross_above/cross_below: use for line crossovers (e.g. macd field:macd crosses field:signal; ema fast vs slow).');
    lines.push('- compare: { left: operand, op:"<|<=|>|>=|==|!=", right: operand } — operand can be indicator, price, value, or candle metric.');
    lines.push('- band_reentry: price left a band then closed back inside — works for ANY overlay-band indicator');
    lines.push('  { type:"band_reentry", side:"long"|"short", indicator:"boll"|"env"|"kc"|"dc", params:{...} }');
    lines.push('  params by indicator: boll{period,mult} · env{period,pct} · kc{period,mult} · dc{period}');
    lines.push('  long = closed back above lower band; short = closed back below upper band');
    lines.push('- exitRules: dynamic SL/TP — candle_extreme (field low|high, offset 1=prev bar) OR atr (period, mult); takeProfit risk_reward (ratio 1.5)');
    if (window.CandlePatterns) lines.push(CandlePatterns.catalogForAi());
    return lines.join('\n');
  }

  const INDICATOR_ALIASES = {
    sma: 'ma',
    bb: 'boll',
    bbands: 'boll',
    bollinger: 'boll',
    envelope: 'env',
    envelopes: 'env',
    keltner: 'kc',
    donchian: 'dc',
    williamsr: 'wr',
    williams_r: 'wr',
    sar: 'psar',
    parabolicsar: 'psar',
    parabolic_sar: 'psar',
  };

  // Overlay-band indicators output upper/middle/lower but take different params.
  // Centralized here so band_reentry (and future band logic) works for ANY band
  // indicator, not just Bollinger — this is what prevents the BB-only bug class.
  function isBandIndicator(id) {
    const resolved = INDICATOR_ALIASES[id] || id;
    const def = getDef(resolved);
    if (def) return def.type === 'overlay-band';
    return ['boll', 'env', 'kc', 'dc'].includes(resolved);
  }

  const BAND_FALLBACK_DEFAULTS = {
    boll: { period: 20, mult: 2 },
    env: { period: 20, pct: 0.1 },
    kc: { period: 20, mult: 2 },
    dc: { period: 20 },
  };

  function resolveBandParams(id, params = {}) {
    const resolved = INDICATOR_ALIASES[id] || id;
    const def = getDef(resolved);
    const defaults = def?.defaults || BAND_FALLBACK_DEFAULTS[resolved] || { period: 20 };
    const merged = {};
    Object.keys(defaults).forEach((key) => {
      if (['color', 'lineWidth', 'fillOpacity'].includes(key)) return;
      merged[key] = defaults[key];
    });
    Object.entries(params).forEach(([key, value]) => {
      if (value == null || value === '') return;
      const num = Number(value);
      merged[key] = Number.isFinite(num) ? num : value;
    });
    return merged;
  }

  // Per-indicator param name synonyms. GPT often emits natural names
  // (period, fast, length, stddev...) that differ from the registry's actual
  // param keys. Without this mapping the param is silently ignored and the
  // indicator falls back to defaults — the same silent-failure class as the BB bug.
  const PARAM_SYNONYMS = {
    macd: { fastperiod: 'fast', slowperiod: 'slow', signalperiod: 'signal', fastlength: 'fast', slowlength: 'slow', signallength: 'signal' },
    kdj: { period: 'n', length: 'n', k: 'm1', d: 'm2', kperiod: 'n', dperiod: 'm1', signal: 'm2' },
    stoch: { period: 'kPeriod', length: 'kPeriod', k: 'kPeriod', d: 'dPeriod', kperiod: 'kPeriod', dperiod: 'dPeriod', smooth: 'dPeriod' },
    boll: { length: 'period', stddev: 'mult', std: 'mult', deviation: 'mult', dev: 'mult', k: 'mult', multiplier: 'mult' },
    env: { length: 'period', percent: 'pct', percentage: 'pct', deviation: 'pct' },
    kc: { length: 'period', atr: 'mult', multiplier: 'mult', deviation: 'mult' },
    dc: { length: 'period' },
    psar: { acceleration: 'step', af: 'step', maximum: 'max', maxaf: 'max' },
    ichimoku: { conversion: 'tenkan', base: 'kijun', span: 'senkou', spanb: 'senkou' },
  };

  // Field name synonyms per indicator (or type). Multi-line indicators fail
  // silently if the field key does not match the compute output shape.
  const FIELD_SYNONYMS = {
    macd: { dif: 'macd', dea: 'signal', line: 'macd', hist: 'histogram', value: 'macd', main: 'macd' },
    kdj: { value: 'k', '%k': 'k', '%d': 'd' },
    stoch: { value: 'k', '%k': 'k', '%d': 'd', slowk: 'k', slowd: 'd' },
    dmi: { '+di': 'pdi', '-di': 'mdi', di_plus: 'pdi', di_minus: 'mdi', value: 'adx', trend: 'adx' },
  };

  function normalizeParamNames(id, params) {
    const synonyms = PARAM_SYNONYMS[id];
    const genericSynonyms = { length: 'period' };
    const out = {};
    Object.entries(params).forEach(([rawKey, value]) => {
      const key = String(rawKey).toLowerCase();
      const mapped = (synonyms && synonyms[key]) || genericSynonyms[key] || rawKey;
      if (out[mapped] == null) out[mapped] = value;
    });
    return out;
  }

  function correctField(id, def, requestedField) {
    const valid = outputFields(def || getDef(id));
    if (!requestedField) {
      if (def?.type === 'overlay-band' && valid.includes('middle')) return 'middle';
      return valid[0] || 'value';
    }
    const raw = String(requestedField).toLowerCase();
    if (valid.includes(requestedField)) return requestedField;
    if (valid.includes(raw)) return raw;
    const syn = FIELD_SYNONYMS[id];
    if (syn && syn[raw] && valid.includes(syn[raw])) return syn[raw];
    // Price fields are valid on any indicator operand (rare but allowed).
    if (PRICE_FIELDS.has(raw)) return raw;
    // Unknown field → snap to the indicator's primary output to avoid null.
    if (def?.type === 'overlay-band' && valid.includes('middle')) return 'middle';
    return valid[0] || 'value';
  }

  function resolveIndicatorSpec(spec) {
    if (!spec?.indicator) return spec;

    let id = String(spec.indicator).toLowerCase().trim();
    id = INDICATOR_ALIASES[id] || id;

    let params = { ...(spec.params || {}) };

    const numbered = id.match(/^(ema|ma|sma|wma|rsi|hma|dema|tema|mfi|cci|atr|roc|psy|vr|bias|mtm|emv)(\d+)$/);
    if (numbered) {
      const base = numbered[1] === 'sma' ? 'ma' : numbered[1];
      id = INDICATOR_ALIASES[base] || base;
      if (params.period == null && params.length == null) params.period = parseInt(numbered[2], 10);
    }

    params = normalizeParamNames(id, params);
    Object.entries(params).forEach(([k, v]) => {
      const n = parseFloat(v);
      if (Number.isFinite(n) && String(v).trim() !== '') {
        params[k] = Number.isInteger(n) ? parseInt(v, 10) : n;
      }
    });

    const def = getDef(id);
    if (def?.compute) {
      return {
        ...spec,
        source: 'indicator',
        indicator: id,
        params: mergeParams(def, params),
        field: correctField(id, def, spec.field),
        offset: parseInt(spec.offset, 10) || 0,
      };
    }

    const genericId = INDICATOR_ALIASES[id] || id;
    if (GENERIC_COMPUTE[genericId]) {
      return {
        ...spec,
        source: 'indicator',
        indicator: genericId,
        params,
        field: spec.field || 'value',
        offset: parseInt(spec.offset, 10) || 0,
      };
    }

    return {
      ...spec,
      source: 'indicator',
      indicator: id,
      params,
      field: spec.field || 'value',
      offset: parseInt(spec.offset, 10) || 0,
    };
  }

  function isKnownIndicator(id) {
    if (!id) return false;
    let resolved = String(id).toLowerCase().trim();
    resolved = INDICATOR_ALIASES[resolved] || resolved;
    const numbered = resolved.match(/^(ema|ma|sma|wma|rsi|hma|dema|tema|mfi|cci|atr|roc|psy|vr|bias|mtm|emv)(\d+)$/);
    if (numbered) return true;
    return Boolean(getDef(resolved)) || Boolean(GENERIC_COMPUTE[resolved]);
  }

  // Validate that every indicator referenced by the rules is computable.
  // Returns human-readable warnings so the UI / GPT layer can surface silent
  // failures instead of the strategy quietly never triggering.
  function validateEntryRules(rules) {
    const warnings = [];
    const seen = new Set();
    walkOperands(rules, (op, side, cond) => {
      if (!op?.indicator) return;
      if (!isKnownIndicator(op.indicator)) {
        const key = `${op.indicator}`;
        if (!seen.has(key)) {
          seen.add(key);
          warnings.push(`알 수 없는 지표 '${op.indicator}' — 조건이 항상 거짓이 됩니다.`);
        }
      }
      if (cond?.type === 'band_reentry' && !isBandIndicator(op.indicator)) {
        const key = `band:${op.indicator}`;
        if (!seen.has(key)) {
          seen.add(key);
          warnings.push(`'${op.indicator}'은(는) 밴드 지표가 아니어서 밴드 재진입에 사용할 수 없습니다.`);
        }
      }
    });
    return { ok: warnings.length === 0, warnings };
  }

  function walkOperands(rules, visitor) {
    ['long', 'short'].forEach((side) => {
      (rules?.[side]?.conditions || []).forEach((cond) => {
        if (cond.type === 'candle_pattern') {
          visitor(cond, side);
          return;
        }
        if (cond.type === 'band_reentry') {
          visitor(
            {
              source: 'indicator',
              indicator: cond.indicator || 'boll',
              params: cond.params || {},
              field: 'lower',
            },
            side,
            cond,
          );
          return;
        }
        [cond.left, cond.right].forEach((op) => visitor(op, side, cond));
      });
    });
  }

  function rulesUseIndicator(rules, names) {
    const needles = (Array.isArray(names) ? names : [names]).map((n) => n.toLowerCase());
    let found = false;
    walkOperands(rules, (op) => {
      if (!op?.indicator || found) return;
      const id = String(op.indicator).toLowerCase();
      if (needles.some((n) => id === n || id.startsWith(n))) found = true;
    });
    return found;
  }

  function indicatorsInRules(rules) {
    const ids = new Set();
    walkOperands(rules, (op) => {
      if (op?.indicator) ids.add(String(op.indicator).toLowerCase());
    });
    return [...ids];
  }

  function cacheKeyForOperand(operand) {
    if (!operand) return '';
    if (operand.source === 'indicator' || operand.indicator) {
      return JSON.stringify(resolveIndicatorSpec(operand));
    }
    return JSON.stringify(operand);
  }

  function resolveBarIndex(index, operand) {
    const offset = operand?.offset || 0;
    return index - offset;
  }

  function sanitizeOperand(op) {
    if (op == null) return null;
    if (typeof op === 'number' && Number.isFinite(op)) {
      return { source: 'value', value: op };
    }
    if (typeof op === 'string') {
      const n = parseFloat(op);
      if (Number.isFinite(n)) return { source: 'value', value: n };
      return { source: 'indicator', indicator: op.toLowerCase(), params: {}, field: 'value' };
    }
    if (typeof op !== 'object') return null;

    let operand = op;
    if (!operand.source && operand.indicator) operand = { ...operand, source: 'indicator' };
    if (!operand.source && operand.metric) operand = { ...operand, source: 'candle' };
    if (!operand.source && PRICE_FIELDS.has(operand.field) && !operand.indicator) {
      operand = { ...operand, source: 'price' };
    }

    if (operand.source === 'value' || (operand.value != null && !operand.indicator && !operand.metric)) {
      const v = typeof operand.value === 'string' ? parseFloat(operand.value) : operand.value;
      return { source: 'value', value: v };
    }

    if (operand.source === 'indicator' || operand.indicator) {
      const indicator = String(operand.indicator || '').toLowerCase();
      const params = {};
      if (operand.params && typeof operand.params === 'object') {
        Object.entries(operand.params).forEach(([k, v]) => {
          const n = parseInt(v, 10);
          params[k] = Number.isFinite(n) ? n : v;
        });
      }
      return resolveIndicatorSpec({
        source: 'indicator',
        indicator,
        params,
        field: operand.field || 'value',
        offset: parseInt(operand.offset, 10) || 0,
      });
    }

    if (operand.source === 'candle' || operand.metric) {
      return {
        source: 'candle',
        metric: operand.metric,
        offset: parseInt(operand.offset, 10) || 0,
      };
    }

    if (operand.source === 'price' || PRICE_FIELDS.has(operand.field)) {
      return {
        source: 'price',
        field: operand.field || 'close',
        offset: parseInt(operand.offset, 10) || 0,
      };
    }

    return operand;
  }

  function sanitizeCondition(cond) {
    if (!cond || typeof cond !== 'object') return null;
    const type = cond.type || 'compare';

    if (type === 'candle_pattern') {
      if (!cond.pattern) return null;
      return {
        type: 'candle_pattern',
        pattern: String(cond.pattern).toLowerCase(),
        offset: parseInt(cond.offset, 10) || 0,
        params: cond.params && typeof cond.params === 'object' ? cond.params : {},
      };
    }

    if (type === 'cross_above' || type === 'cross_below') {
      const left = sanitizeOperand(cond.left);
      const right = sanitizeOperand(cond.right);
      if (!left || !right) return null;
      return { type, left, right };
    }

    if (type === 'band_reentry') {
      const side = cond.side === 'short' ? 'short' : 'long';
      const rawId = String(cond.indicator || 'boll').toLowerCase();
      const indicator = INDICATOR_ALIASES[rawId] || rawId;
      const rawParams = cond.params && typeof cond.params === 'object' ? cond.params : {};
      return {
        type: 'band_reentry',
        side,
        indicator,
        params: resolveBandParams(indicator, rawParams),
      };
    }

    if (cond.indicator && cond.op != null) {
      const right = cond.value != null ? cond.value : cond.right;
      return {
        type: 'compare',
        left: sanitizeOperand({
          source: 'indicator',
          indicator: cond.indicator,
          params: cond.params || {},
          field: cond.field || 'value',
        }),
        op: cond.op,
        right: sanitizeOperand(right),
      };
    }

    const left = sanitizeOperand(cond.left);
    const right = sanitizeOperand(cond.right ?? cond.value);
    if (!left || right == null) return null;
    return { type: 'compare', left, op: cond.op || '==', right };
  }

  function sanitizeRuleGroup(group) {
    if (!group || typeof group !== 'object') {
      return { enabled: false, logic: 'all', conditions: [] };
    }
    const conditions = Array.isArray(group.conditions)
      ? group.conditions.map(sanitizeCondition).filter(Boolean)
      : [];
    const enabled = conditions.length > 0 && group.enabled !== false;
    return {
      enabled,
      logic: group.logic === 'any' ? 'any' : 'all',
      conditions,
    };
  }

  function sanitizeEntryRules(rules) {
    if (!rules || typeof rules !== 'object') {
      return {
        long: { enabled: false, logic: 'all', conditions: [] },
        short: { enabled: false, logic: 'all', conditions: [] },
      };
    }
    return {
      long: sanitizeRuleGroup(rules.long),
      short: sanitizeRuleGroup(rules.short),
    };
  }

  function normalizeRules(settings) {
    const raw = settings?.entryRules;
    // An explicit entryRules object is always respected — even with every
    // condition deleted/disabled (= "do not enter"). Falling back to the RSI
    // preset here silently revived a strategy the user just deleted.
    if (raw && typeof raw === 'object' && (raw.long || raw.short)) {
      return sanitizeEntryRules(raw);
    }
    return rsiPresetFromLegacy(settings);
  }

  function slotRulesHaveSignals(rules) {
    if (!rules) return false;
    const s = sanitizeEntryRules(rules);
    return (s.long.enabled && s.long.conditions.length > 0)
      || (s.short.enabled && s.short.conditions.length > 0);
  }

  // Multiple independent entry conditions ("slots"): each enabled slot is a
  // full entryRules set with an optional per-slot exitRules. A signal fires
  // when ANY enabled slot matches (first match wins, its name is reported).
  // Without settings.strategySlots this collapses to the single legacy rules,
  // so old strategy.json exports and bot-js keep working unchanged.
  function normalizeSlots(settings) {
    const raw = Array.isArray(settings?.strategySlots) ? settings.strategySlots : null;
    if (raw && raw.length) {
      const active = raw
        .filter((s) => s && s.enabled !== false && s.entryRules)
        .map((s, i) => ({
          id: s.id ?? i,
          name: s.name || `조건 ${i + 1}`,
          rules: sanitizeEntryRules(s.entryRules),
          exitRules: sanitizeExitRules(s.exitRules),
        }))
        .filter((s) => (s.rules.long.enabled && s.rules.long.conditions.length)
          || (s.rules.short.enabled && s.rules.short.conditions.length));
      if (active.length) return active;

      // Slots carry entryRules but all are off or empty → honor explicit off state.
      if (raw.some((s) => s?.entryRules)) return [];

      // Slot rows exist without rules (UI placeholder) — fall back to legacy entryRules.
      if (settings?.entryRules && slotRulesHaveSignals(settings.entryRules)) {
        return [{
          id: null,
          name: null,
          rules: sanitizeEntryRules(settings.entryRules),
          exitRules: sanitizeExitRules(settings?.exitRules),
        }];
      }
      return [];
    }
    return [{
      id: null,
      name: null,
      rules: normalizeRules(settings),
      exitRules: sanitizeExitRules(settings?.exitRules),
    }];
  }

  // Combined view of every slot's conditions — used for snapshots, indicator
  // detection, and warmup so all referenced indicators are computed.
  function mergedSlotRules(slots) {
    const merged = {
      long: { enabled: false, logic: 'any', conditions: [] },
      short: { enabled: false, logic: 'any', conditions: [] },
    };
    slots.forEach(({ rules }) => {
      ['long', 'short'].forEach((side) => {
        if (rules[side]?.conditions?.length) {
          merged[side].conditions.push(...rules[side].conditions);
          if (rules[side].enabled) merged[side].enabled = true;
        }
      });
    });
    return merged;
  }

  function rsiPresetFromLegacy(settings = {}) {
    const period = settings.rsiPeriod || 14;
    const oversold = settings.rsiOversold ?? 25;
    const overbought = settings.rsiOverbought ?? 70;
    const allowShort = settings.allowShort !== false;
    return {
      long: {
        enabled: true,
        logic: 'all',
        conditions: [{
          type: 'compare',
          left: { source: 'indicator', indicator: 'rsi', params: { period }, field: 'value' },
          op: '<=',
          right: { source: 'value', value: oversold },
        }],
      },
      short: {
        enabled: allowShort,
        logic: 'all',
        conditions: [{
          type: 'compare',
          left: { source: 'indicator', indicator: 'rsi', params: { period }, field: 'value' },
          op: '>=',
          right: { source: 'value', value: overbought },
        }],
      },
    };
  }

  function goldenCrossPreset(fast = 12, slow = 26) {
    return {
      long: {
        enabled: true,
        logic: 'all',
        conditions: [{
          type: 'cross_above',
          left: { source: 'indicator', indicator: 'ema', params: { period: fast }, field: 'value' },
          right: { source: 'indicator', indicator: 'ema', params: { period: slow }, field: 'value' },
        }],
      },
      short: {
        enabled: true,
        logic: 'all',
        conditions: [{
          type: 'cross_below',
          left: { source: 'indicator', indicator: 'ema', params: { period: fast }, field: 'value' },
          right: { source: 'indicator', indicator: 'ema', params: { period: slow }, field: 'value' },
        }],
      },
    };
  }

  function computeRaw(candles, spec) {
    const resolved = resolveIndicatorSpec(spec);
    const id = resolved?.indicator;
    if (!id) return null;

    const def = getDef(id);
    if (def?.compute) {
      return def.compute(candles, mergeParams(def, resolved.params || {}));
    }

    const generic = GENERIC_COMPUTE[id];
    if (generic) {
      return generic(candles, resolved.params || {});
    }

    return null;
  }

  function isTimeSeriesPoint(point) {
    return point != null && typeof point === 'object' && point.time != null;
  }

  const timeIndexMaps = new WeakMap();

  function getTimeMap(series) {
    if (!Array.isArray(series) || !series.length || !isTimeSeriesPoint(series[0])) return null;
    if (!timeIndexMaps.has(series)) {
      timeIndexMaps.set(series, new Map(series.map((p) => [p.time, p])));
    }
    return timeIndexMaps.get(series);
  }

  function valueFromPoint(point, field = 'value') {
    if (point == null) return null;
    if (typeof point === 'number') return point;
    if (field && field !== 'value' && point[field] != null) {
      const v = point[field];
      return typeof v === 'number' ? v : v.value ?? null;
    }
    if (typeof point.value === 'number') return point.value;
    return point.value ?? point.close ?? null;
  }

  function valueAtTimeSeries(series, time, field = 'value') {
    if (!series?.length || time == null) return null;
    const map = getTimeMap(series);
    if (map) return valueFromPoint(map.get(time), field);
    if (typeof series[0] === 'number') return null;
    let lo = 0;
    let hi = series.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const mt = series[mid].time;
      if (mt === time) return valueFromPoint(series[mid], field);
      if (mt < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  function rawAt(data, index, field, candles) {
    if (data == null || index < 0) return null;
    const candle = candles[index];
    if (!candle) return null;
    const time = candle.time;

    if (Array.isArray(data)) {
      if (data.length && data[0]?.volume != null && field === 'volume') {
        return candle.volume ?? null;
      }
      if (isTimeSeriesPoint(data[0])) {
        return valueAtTimeSeries(data, time, field);
      }
      const point = data[index];
      if (point == null) return null;
      return valueFromPoint(point, field);
    }

    if (typeof data === 'object') {
      if (field && data[field]) {
        const series = data[field];
        if (Array.isArray(series) && isTimeSeriesPoint(series[0])) {
          return valueAtTimeSeries(series, time, 'value');
        }
        const point = series[index];
        if (point == null) return null;
        return valueFromPoint(point, 'value');
      }
      if (data.upper || data.middle || data.lower) {
        const key = field || 'middle';
        const series = data[key];
        if (!series) return null;
        if (Array.isArray(series) && isTimeSeriesPoint(series[0])) {
          return valueAtTimeSeries(series, time, 'value');
        }
        const point = series[index];
        return point == null ? null : valueFromPoint(point, 'value');
      }
      if (Array.isArray(data.hist) && typeof data.hist[index] === 'number') {
        return data.hist[index];
      }
    }

    return null;
  }

  function priceAt(candles, index, field = 'close') {
    const candle = candles[index];
    if (!candle) return null;
    if (field === 'price' || field === 'close') return candle.close;
    if (field === 'open') return candle.open;
    if (field === 'high') return candle.high;
    if (field === 'low') return candle.low;
    if (field === 'volume') return candle.volume;
    return candle.close;
  }

  function ensureCacheEntry(candles, operand, cache) {
    const key = cacheKeyForOperand(operand);
    let entry = cache.get(key);
    if (!entry || typeof entry !== 'object' || !('series' in entry)) {
      const raw = entry?.raw ?? entry ?? computeRaw(candles, operand);
      entry = { raw, series: {} };
      cache.set(key, entry);
    }
    return { key, entry };
  }

  function indexedSeries(candles, operand, cache) {
    const field = operand.field || 'value';
    const { entry } = ensureCacheEntry(candles, operand, cache);
    if (!entry.series[field]) {
      const series = new Array(candles.length);
      for (let i = 0; i < candles.length; i++) {
        series[i] = rawAt(entry.raw, i, field, candles);
      }
      entry.series[field] = series;
    }
    return entry.series[field];
  }

  function warmupCache(candles, rules, cache) {
    ['long', 'short'].forEach((side) => {
      (rules?.[side]?.conditions || []).forEach((cond) => {
        if (cond?.type === 'band_reentry') {
          const indicator = cond.indicator || 'boll';
          const params = resolveBandParams(indicator, cond.params || {});
          ['lower', 'middle', 'upper'].forEach((field) => {
            indexedSeries(candles, { source: 'indicator', indicator, params, field }, cache);
          });
        }
      });
    });
    walkOperands(rules, (op) => {
      if (op?.indicator) indexedSeries(candles, op, cache);
    });
  }

  function createOperandCache() {
    return new Map();
  }

  function prepareBacktest(candles, settings) {
    const slots = normalizeSlots(settings);
    const merged = mergedSlotRules(slots);
    const cache = createOperandCache();
    slots.forEach((slot) => warmupCache(candles, slot.rules, cache));
    return {
      slots,
      rules: slots[0]?.rules ?? merged,
      cache,
      startIdx: Math.max(30, ...slots.map((s) => estimateMinBars(s.rules))),
    };
  }

  function matchEntryAt(candles, index, rules, cache, currentSide = null) {
    if (currentSide === 'LONG' || currentSide === 'SHORT') return null;
    if (index < 1) return null;
    if (evaluateGroup(candles, index, rules.long, cache)) return 'LONG';
    if (rules.short?.enabled && evaluateGroup(candles, index, rules.short, cache)) return 'SHORT';
    return null;
  }

  // Slot-aware entry matching: first enabled slot that fires wins; returns the
  // slot so its name/exitRules can be attached to the trade.
  function matchEntrySlotsAt(candles, index, slots, cache, currentSide = null) {
    if (currentSide === 'LONG' || currentSide === 'SHORT') return null;
    if (index < 1) return null;
    for (const slot of slots) {
      const side = matchEntryAt(candles, index, slot.rules, cache, currentSide);
      if (side) return { side, slot };
    }
    return null;
  }

  function resolveOperand(candles, index, operand, cache) {
    if (operand == null) return null;

    if (typeof operand === 'number') return operand;
    if (operand.source === 'value' || operand.value != null) {
      const v = operand.value;
      return typeof v === 'number' ? v : parseFloat(v);
    }

    const source = operand.source || (operand.indicator ? 'indicator' : operand.metric ? 'candle' : 'value');
    const barIdx = resolveBarIndex(index, operand);

    if (source === 'candle' && operand.metric && window.CandlePatterns) {
      return CandlePatterns.metric(candles, barIdx, operand.metric);
    }

    if (source === 'price' || (PRICE_FIELDS.has(operand.field) && !operand.indicator && !operand.metric)) {
      return priceAt(candles, barIdx, operand.field || 'close');
    }

    if (source === 'indicator' || operand.indicator) {
      const field = operand.field || 'value';
      if (PRICE_FIELDS.has(field) && !getDef(operand.indicator) && !GENERIC_COMPUTE[operand.indicator]) {
        return priceAt(candles, barIdx, field);
      }
      const series = indexedSeries(candles, operand, cache);
      if (barIdx < 0 || barIdx >= series.length) return null;
      return series[barIdx];
    }

    return null;
  }

  function compareValues(left, op, right) {
    if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right)) {
      return false;
    }
    switch (op) {
      case '<': return left < right;
      case '<=': return left <= right;
      case '>': return left > right;
      case '>=': return left >= right;
      case '==': return left === right;
      case '!=': return left !== right;
      default: return false;
    }
  }

  function evaluateBandReentry(candles, index, condition, cache) {
    if (index < 1) return false;
    const side = condition.side === 'short' ? 'short' : 'long';
    const indicator = condition.indicator || 'boll';
    const params = resolveBandParams(indicator, condition.params || {});
    const closeNow = resolveOperand(candles, index, { source: 'price', field: 'close' }, cache);
    const closePrev = resolveOperand(candles, index - 1, { source: 'price', field: 'close' }, cache);
    const lowerPrev = resolveOperand(
      candles,
      index - 1,
      { source: 'indicator', indicator, params, field: 'lower' },
      cache,
    );
    const lowerNow = resolveOperand(
      candles,
      index,
      { source: 'indicator', indicator, params, field: 'lower' },
      cache,
    );
    const upperPrev = resolveOperand(
      candles,
      index - 1,
      { source: 'indicator', indicator, params, field: 'upper' },
      cache,
    );
    const upperNow = resolveOperand(
      candles,
      index,
      { source: 'indicator', indicator, params, field: 'upper' },
      cache,
    );

    if (side === 'long') {
      if (![closeNow, closePrev, lowerPrev, lowerNow].every(Number.isFinite)) return false;
      return closePrev < lowerPrev && closeNow >= lowerNow;
    }
    if (![closeNow, closePrev, upperPrev, upperNow].every(Number.isFinite)) return false;
    return closePrev > upperPrev && closeNow <= upperNow;
  }

  function evaluateCondition(candles, index, condition, cache) {
    const type = condition.type || 'compare';

    if (type === 'band_reentry') {
      return evaluateBandReentry(candles, index, condition, cache);
    }

    if (type === 'compare') {
      const left = resolveOperand(candles, index, condition.left, cache);
      const right = resolveOperand(candles, index, condition.right, cache);
      return compareValues(left, condition.op, right);
    }

    if (type === 'cross_above' || type === 'cross_below') {
      if (index < 1) return false;
      const leftNow = resolveOperand(candles, index, condition.left, cache);
      const leftPrev = resolveOperand(candles, index - 1, condition.left, cache);
      const rightNow = resolveOperand(candles, index, condition.right, cache);
      const rightPrev = resolveOperand(candles, index - 1, condition.right, cache);
      if ([leftNow, leftPrev, rightNow, rightPrev].some((v) => v == null || !Number.isFinite(v))) return false;
      if (type === 'cross_above') return leftPrev <= rightPrev && leftNow > rightNow;
      return leftPrev >= rightPrev && leftNow < rightNow;
    }

    if (type === 'candle_pattern' && window.CandlePatterns) {
      const barIdx = resolveBarIndex(index, condition);
      return CandlePatterns.match(candles, barIdx, condition.pattern, condition.params || {});
    }

    return false;
  }

  function evaluateGroup(candles, index, group, cache) {
    if (group?.enabled === false || !Array.isArray(group?.conditions) || !group.conditions.length) {
      return false;
    }
    const logic = group.logic === 'any' ? 'any' : 'all';
    const results = group.conditions.map((c) => {
      if (!c) return false;
      try {
        return evaluateCondition(candles, index, c, cache);
      } catch (err) {
        console.warn('StrategyEngine condition error:', err, c);
        return false;
      }
    });
    return logic === 'any' ? results.some(Boolean) : results.every(Boolean);
  }

  function estimateMinBars(rules) {
    let maxPeriod = 30;
    const visit = (operand) => {
      if (!operand || typeof operand !== 'object') return;
      const params = operand.params || {};
      Object.values(params).forEach((v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > maxPeriod) maxPeriod = n;
      });
      if (operand.indicator === 'macd') maxPeriod = Math.max(maxPeriod, (params.slow || 26) + (params.signal || 9));
      if (operand.indicator === 'ichimoku') {
        maxPeriod = Math.max(maxPeriod, params.senkou || 52, params.kijun || 26);
      }
    };

    ['long', 'short'].forEach((side) => {
      (rules[side]?.conditions || []).forEach((cond) => {
        if (cond.type === 'candle_pattern' && window.CandlePatterns) {
          const need = CandlePatterns.minBarsForPattern(cond.pattern) + (cond.offset || 0);
          if (need > maxPeriod) maxPeriod = need;
        }
        if (cond.type === 'band_reentry') {
          const period = cond.params?.period || 20;
          if (period > maxPeriod) maxPeriod = period;
        }
        if (cond.type === 'cross_above' || cond.type === 'cross_below' || cond.type === 'compare') {
          visit(cond.left);
          visit(cond.right);
        }
      });
    });

    return Math.min(maxPeriod + 5, 300);
  }

  function snapshotRsi(snapshot) {
    if (!snapshot) return null;
    if (snapshot.rsi != null && Number.isFinite(snapshot.rsi)) return snapshot.rsi;
    for (const [key, value] of Object.entries(snapshot)) {
      if (typeof key === 'string' && /^rsi/i.test(key) && typeof value === 'number') return value;
    }
    return null;
  }

  function formatOperandLabel(operand) {
    if (!operand) return '?';
    if (operand.source === 'value' || operand.value != null) return String(operand.value);
    const offset = operand.offset ? `[${operand.offset}봉전]` : '';
    if (operand.source === 'candle' && operand.metric) {
      const label = window.CandlePatterns?.metricLabel(operand.metric) || operand.metric;
      return `캔들.${label}${offset}`;
    }
    if (operand.source === 'price' || (PRICE_FIELDS.has(operand.field) && !operand.indicator && !operand.metric)) {
      return `${operand.field || 'close'}${offset}`;
    }
    const id = operand.indicator || '?';
    const field = operand.field && operand.field !== 'value' ? `.${operand.field}` : '';
    const params = operand.params ? `(${Object.entries(operand.params).map(([k, v]) => `${k}=${v}`).join(',')})` : '';
    return `${id}${params}${field}${offset}`;
  }

  function formatCondition(cond) {
    const type = cond.type || 'compare';
    if (type === 'band_reentry') {
      const side = cond.side === 'short' ? '숏' : '롱';
      const id = (cond.indicator || 'boll').toUpperCase();
      const params = cond.params
        ? Object.entries(cond.params).map(([k, v]) => `${k}=${v}`).join(',')
        : '';
      const paramLabel = params ? ` ${params}` : '';
      return `${id} ${side} 밴드 재진입 (${id}${paramLabel})`;
    }
    if (type === 'candle_pattern') {
      const label = window.CandlePatterns?.patternLabel(cond.pattern) || cond.pattern;
      const offset = cond.offset ? ` (${cond.offset}봉전)` : '';
      return `캔들 ${label}${offset}`;
    }
    const left = formatOperandLabel(cond.left);
    if (type === 'cross_above') return `${left} 골든크로스 ${formatOperandLabel(cond.right)}`;
    if (type === 'cross_below') return `${left} 데드크로스 ${formatOperandLabel(cond.right)}`;
    return `${left} ${cond.op} ${formatOperandLabel(cond.right)}`;
  }

  function rulesSummary(rules) {
    const parts = [];
    if (rules.long?.enabled && rules.long.conditions?.length) {
      const joiner = rules.long.logic === 'any' ? ' OR ' : ' AND ';
      parts.push(`롱: ${rules.long.conditions.map(formatCondition).join(joiner)}`);
    }
    if (rules.short?.enabled && rules.short.conditions?.length) {
      const joiner = rules.short.logic === 'any' ? ' OR ' : ' AND ';
      parts.push(`숏: ${rules.short.conditions.map(formatCondition).join(joiner)}`);
    }
    return parts.join(' · ') || '진입 조건 없음';
  }

  function buildSnapshot(candles, index, rules, cache) {
    const snap = { price: priceAt(candles, index, 'close') };
    const seen = new Set();

    if (window.CandlePatterns) {
      const p = CandlePatterns.parts(candles[index]);
      if (p) {
        snap.candle = p.bullish ? '양봉' : p.bearish ? '음봉' : '도지';
        snap.body_pct = Math.round(p.bodyPct * 1000) / 10;
      }
    }

    ['long', 'short'].forEach((side) => {
      (rules[side]?.conditions || []).forEach((cond) => {
        if (cond.type === 'candle_pattern' && window.CandlePatterns) {
          const key = `pattern:${cond.pattern}`;
          if (!seen.has(key)) {
            seen.add(key);
            snap[key] = CandlePatterns.match(candles, index - (cond.offset || 0), cond.pattern, cond.params || {});
          }
        }
        [cond.left, cond.right].forEach((operand) => {
          if (!operand) return;
          if (operand.source === 'candle' && operand.metric) {
            const key = cacheKeyForOperand(operand);
            if (seen.has(key)) return;
            seen.add(key);
            snap[formatOperandLabel(operand)] = resolveOperand(candles, index, operand, cache);
            return;
          }
          if (!operand.indicator) return;
          const key = cacheKeyForOperand(operand);
          if (seen.has(key)) return;
          seen.add(key);
          snap[formatOperandLabel(operand)] = resolveOperand(candles, index, operand, cache);
        });
      });
    });

    const rsi = snapshotRsi(snap);
    if (rsi != null) snap.rsi = rsi;
    return snap;
  }

  function bollingerReentryLongPreset(period = 20, mult = 2) {
    return {
      long: {
        enabled: true,
        logic: 'all',
        conditions: [{
          type: 'band_reentry',
          side: 'long',
          indicator: 'boll',
          params: { period, mult },
        }],
      },
      short: { enabled: false, logic: 'all', conditions: [] },
    };
  }

  function bollingerReentryLongExitRules(ratio = 1.5) {
    return {
      long: {
        stopLoss: { type: 'candle_extreme', field: 'low', offset: 1 },
        takeProfit: { type: 'risk_reward', ratio },
      },
    };
  }

  // Generic band re-entry preset — works for boll/env/kc/dc, long or short.
  function bandReentryPreset(indicator = 'boll', side = 'long', params = {}) {
    const resolved = INDICATOR_ALIASES[indicator] || indicator;
    const group = {
      enabled: true,
      logic: 'all',
      conditions: [{
        type: 'band_reentry',
        side: side === 'short' ? 'short' : 'long',
        indicator: resolved,
        params: resolveBandParams(resolved, params),
      }],
    };
    const empty = { enabled: false, logic: 'all', conditions: [] };
    return side === 'short'
      ? { long: empty, short: group }
      : { long: group, short: empty };
  }

  function sanitizeExitRules(rules) {
    if (!rules || typeof rules !== 'object') return null;
    const out = {};
    ['long', 'short'].forEach((side) => {
      const rule = rules[side];
      if (!rule || typeof rule !== 'object') return;
      const clean = {};

      const sl = rule.stopLoss;
      if (sl?.type === 'candle_extreme') {
        clean.stopLoss = {
          type: 'candle_extreme',
          field: sl.field === 'high' ? 'high' : 'low',
          offset: Math.max(1, parseInt(sl.offset, 10) || 1),
        };
      } else if (sl?.type === 'atr') {
        const mult = parseFloat(sl.mult);
        clean.stopLoss = {
          type: 'atr',
          period: Math.max(1, parseInt(sl.period, 10) || 14),
          mult: Number.isFinite(mult) && mult > 0 ? mult : 1.5,
        };
      }

      const tp = rule.takeProfit;
      if (tp?.type === 'risk_reward') {
        const ratio = parseFloat(tp.ratio);
        clean.takeProfit = {
          type: 'risk_reward',
          ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1.5,
        };
      }

      if (clean.stopLoss || clean.takeProfit) out[side] = clean;
    });
    return Object.keys(out).length ? out : null;
  }

  function slotsSummary(slots) {
    if (!slots.length) return '진입 조건 없음 (모두 꺼짐)';
    if (slots.length === 1 && !slots[0].name) return rulesSummary(slots[0].rules);
    return slots
      .map((s) => `[${s.name}] ${rulesSummary(s.rules)}`)
      .join(' · ');
  }

  function evaluateEntry(candles, settings, currentSide = null) {
    const slots = normalizeSlots(settings);
    const merged = mergedSlotRules(slots);
    const rules = slots[0]?.rules ?? merged;
    const i = candles.length - 1;
    if (i < 1) {
      return { matched: null, rules, reason: '데이터 부족', snapshot: null };
    }

    if (currentSide === 'LONG' || currentSide === 'SHORT') {
      return {
        matched: null,
        rules,
        reason: `${currentSide === 'LONG' ? '롱' : '숏'} 보유 중`,
        snapshot: buildSnapshot(candles, i, merged, new Map()),
      };
    }

    const cache = new Map();
    const snapshot = buildSnapshot(candles, i, merged, cache);

    const hit = matchEntrySlotsAt(candles, i, slots, cache, currentSide);
    if (hit) {
      const label = hit.slot.name ? `[${hit.slot.name}] ` : '';
      const sideRules = hit.side === 'LONG'
        ? { long: hit.slot.rules.long }
        : { short: hit.slot.rules.short };
      return {
        matched: hit.side,
        rules: hit.slot.rules,
        reason: `${hit.side === 'LONG' ? '롱' : '숏'} 진입 — ${label}${rulesSummary(sideRules)}`,
        snapshot,
        slotName: hit.slot.name,
        slotId: hit.slot.id,
        slotExitRules: hit.slot.exitRules,
      };
    }

    return {
      matched: null,
      rules,
      reason: `대기 — ${slotsSummary(slots)}`,
      snapshot,
    };
  }

  function minBars(settings) {
    const slots = normalizeSlots(settings);
    if (!slots.length) return 30;
    return Math.max(...slots.map((s) => estimateMinBars(s.rules)));
  }

  return {
    buildCatalog,
    catalogForAi,
    normalizeRules,
    normalizeSlots,
    slotRulesHaveSignals,
    mergedSlotRules,
    matchEntrySlotsAt,
    slotsSummary,
    sanitizeEntryRules,
    resolveIndicatorSpec,
    rulesUseIndicator,
    indicatorsInRules,
    rsiPresetFromLegacy,
    goldenCrossPreset,
    bollingerReentryLongPreset,
    bollingerReentryLongExitRules,
    bandReentryPreset,
    sanitizeExitRules,
    isBandIndicator,
    isKnownIndicator,
    validateEntryRules,
    resolveBandParams,
    evaluateEntry,
    matchEntryAt,
    prepareBacktest,
    createOperandCache,
    warmupCache,
    rulesSummary,
    minBars,
    estimateMinBars,
    snapshotRsi,
    getDef,
    outputFields,
  };
})();

window.StrategyEngine = StrategyEngine;
