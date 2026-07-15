/* Technical analysis calculations — Binance-compatible indicators */
const TA = (() => {
  const closes = (c) => c.map((x) => x.close);
  const highs = (c) => c.map((x) => x.high);
  const lows = (c) => c.map((x) => x.low);
  const volumes = (c) => c.map((x) => x.volume);
  const times = (c) => c.map((x) => x.time);

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1 || !values.length) return out;
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) continue;
      if (prev == null) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        prev = s / period;
      } else {
        prev = values[i] * k + prev * (1 - k);
      }
      out[i] = prev;
    }
    return out;
  }

  // Wilder's moving average (a.k.a. RMA / SMMA) — the smoothing TradingView
  // uses for RSI, ATR, DMI/ADX etc. Seeds with the SMA of the first `period`
  // non-null values, then rma = (prev*(period-1) + value) / period.
  function rma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1) return out;
    let prev = null;
    let count = 0;
    let seed = 0;
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (val == null) continue;
      if (prev == null) {
        seed += val;
        count += 1;
        if (count === period) {
          prev = seed / period;
          out[i] = prev;
        }
      } else {
        prev = (prev * (period - 1) + val) / period;
        out[i] = prev;
      }
    }
    return out;
  }

  // EMA that tolerates leading nulls (for chaining EMA-of-EMA without polluting
  // the seed with zeros). Seeds from the first `period` non-null values.
  function emaChain(values, period) {
    const out = new Array(values.length).fill(null);
    if (period < 1) return out;
    const k = 2 / (period + 1);
    let prev = null;
    let count = 0;
    let seed = 0;
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (val == null) continue;
      if (prev == null) {
        seed += val;
        count += 1;
        if (count === period) {
          prev = seed / period;
          out[i] = prev;
        }
      } else {
        prev = val * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  function wma(values, period) {
    const out = new Array(values.length).fill(null);
    const denom = (period * (period + 1)) / 2;
    for (let i = period - 1; i < values.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += values[i - j] * (period - j);
      out[i] = sum / denom;
    }
    return out;
  }

  function dema(values, period) {
    const e1 = ema(values, period);
    const e2 = emaChain(e1, period);
    return e1.map((v, i) => (v != null && e2[i] != null ? 2 * v - e2[i] : null));
  }

  function tema(values, period) {
    const e1 = ema(values, period);
    const e2 = emaChain(e1, period);
    const e3 = emaChain(e2, period);
    return e1.map((v, i) =>
      v != null && e2[i] != null && e3[i] != null ? 3 * v - 3 * e2[i] + e3[i] : null
    );
  }

  function toSeries(candles, values) {
    return candles
      .map((c, i) => (values[i] == null ? null : { time: c.time, value: values[i] }))
      .filter(Boolean);
  }

  function ma(candles, period = 7) {
    return toSeries(candles, sma(closes(candles), period));
  }

  function emaLine(candles, period = 7) {
    return toSeries(candles, ema(closes(candles), period));
  }

  function wmaLine(candles, period = 7) {
    return toSeries(candles, wma(closes(candles), period));
  }

  function bollinger(candles, period = 20, mult = 2) {
    const c = closes(candles);
    const mid = sma(c, period);
    const upper = [];
    const lower = [];
    for (let i = 0; i < c.length; i++) {
      if (mid[i] == null) {
        upper.push(null);
        lower.push(null);
        continue;
      }
      let sq = 0;
      for (let j = i - period + 1; j <= i; j++) sq += (c[j] - mid[i]) ** 2;
      const std = Math.sqrt(sq / period);
      upper.push(mid[i] + mult * std);
      lower.push(mid[i] - mult * std);
    }
    const upperS = toSeries(candles, upper);
    const lowerS = toSeries(candles, lower);
    const middleS = toSeries(candles, mid);
    const fill = candles.map((cd, i) => {
      if (upper[i] == null || lower[i] == null) return null;
      return { time: cd.time, upper: upper[i], lower: lower[i], mid: mid[i] };
    }).filter(Boolean);
    return {
      upper: upperS,
      middle: middleS,
      lower: lowerS,
      fill,
    };
  }

  function psar(candles, step = 0.02, max = 0.2) {
    const h = highs(candles);
    const l = lows(candles);
    const out = new Array(candles.length).fill(null);
    if (candles.length < 2) return toSeries(candles, out);

    let af = step;
    let ep = h[0];
    let bull = true;
    let sar = l[0];
    out[0] = sar;

    for (let i = 1; i < candles.length; i++) {
      sar = sar + af * (ep - sar);
      if (bull) {
        if (l[i] < sar) {
          bull = false;
          sar = ep;
          ep = l[i];
          af = step;
        } else {
          if (h[i] > ep) {
            ep = h[i];
            af = Math.min(af + step, max);
          }
        }
      } else {
        if (h[i] > sar) {
          bull = true;
          sar = ep;
          ep = h[i];
          af = step;
        } else {
          if (l[i] < ep) {
            ep = l[i];
            af = Math.min(af + step, max);
          }
        }
      }
      sar = Math.min(sar, i > 1 ? Math.min(l[i - 1], l[i - 2] || l[i - 1]) : l[i - 1]);
      if (!bull) sar = Math.max(sar, i > 1 ? Math.max(h[i - 1], h[i - 2] || h[i - 1]) : h[i - 1]);
      out[i] = sar;
    }
    return toSeries(candles, out);
  }

  function macd(candles, fast = 12, slow = 26, signal = 9, histColors = {}) {
    const c = closes(candles);
    const ef = ema(c, fast);
    const es = ema(c, slow);
    const line = c.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
    const sig = emaChain(line, signal);
    const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));

    const upStrong = histColors.upStrong || '#0ECB81';
    const upWeak = histColors.upWeak || 'rgba(14, 203, 129, 0.45)';
    const downStrong = histColors.downStrong || '#F6465D';
    const downWeak = histColors.downWeak || 'rgba(246, 70, 93, 0.45)';

    const histogram = candles
      .map((cd, i) => {
        if (hist[i] == null) return null;
        const cur = hist[i];
        const prev = hist[i - 1] ?? 0;
        let color;
        if (cur >= 0) {
          color = cur >= prev ? upStrong : upWeak;
        } else {
          color = cur <= prev ? downStrong : downWeak;
        }
        return { time: cd.time, value: cur, color };
      })
      .filter(Boolean);

    return {
      macd: toSeries(candles, line),
      signal: toSeries(candles, sig),
      histogram,
      hist,
    };
  }

  function rsi(candles, period = 14) {
    const c = closes(candles);
    const out = new Array(c.length).fill(null);
    if (c.length <= period) return toSeries(candles, out);
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = c[i] - c[i - 1];
      if (d >= 0) gain += d;
      else loss -= d;
    }
    let avgGain = gain / period;
    let avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return toSeries(candles, out);
  }

  function stochastic(candles, kPeriod = 14, dPeriod = 3) {
    const h = highs(candles);
    const l = lows(candles);
    const c = closes(candles);
    const k = new Array(candles.length).fill(null);
    for (let i = kPeriod - 1; i < candles.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        hh = Math.max(hh, h[j]);
        ll = Math.min(ll, l[j]);
      }
      k[i] = hh === ll ? 50 : ((c[i] - ll) / (hh - ll)) * 100;
    }
    const d = sma(k.map((v) => v ?? 0), dPeriod);
    return { k: toSeries(candles, k), d: toSeries(candles, d) };
  }

  function kdj(candles, n = 9, m1 = 3, m2 = 3) {
    const { k, d } = stochastic(candles, n, m1);
    const kVals = candles.map((_, i) => k.find((x) => x.time === candles[i].time)?.value ?? null);
    const dVals = candles.map((_, i) => d.find((x) => x.time === candles[i].time)?.value ?? null);
    const j = kVals.map((kv, i) => (kv != null && dVals[i] != null ? 3 * kv - 2 * dVals[i] : null));
    return {
      k,
      d,
      j: toSeries(candles, j),
    };
  }

  function obv(candles) {
    const c = closes(candles);
    const v = volumes(candles);
    const out = [0];
    for (let i = 1; i < candles.length; i++) {
      if (c[i] > c[i - 1]) out.push(out[i - 1] + v[i]);
      else if (c[i] < c[i - 1]) out.push(out[i - 1] - v[i]);
      else out.push(out[i - 1]);
    }
    return toSeries(candles, out);
  }

  function cci(candles, period = 20) {
    const h = highs(candles);
    const l = lows(candles);
    const c = closes(candles);
    const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3);
    const out = new Array(candles.length).fill(null);
    for (let i = period - 1; i < candles.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += tp[j];
      const mean = sum / period;
      let dev = 0;
      for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - mean);
      const md = dev / period;
      out[i] = md === 0 ? 0 : (tp[i] - mean) / (0.015 * md);
    }
    return toSeries(candles, out);
  }

  function williamsR(candles, period = 14) {
    const h = highs(candles);
    const l = lows(candles);
    const c = closes(candles);
    const out = new Array(candles.length).fill(null);
    for (let i = period - 1; i < candles.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        hh = Math.max(hh, h[j]);
        ll = Math.min(ll, l[j]);
      }
      out[i] = hh === ll ? -50 : ((hh - c[i]) / (hh - ll)) * -100;
    }
    return toSeries(candles, out);
  }

  function atr(candles, period = 14) {
    const h = highs(candles);
    const l = lows(candles);
    const c = closes(candles);
    const tr = [h[0] - l[0]];
    for (let i = 1; i < candles.length; i++) {
      tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    }
    return toSeries(candles, rma(tr, period));
  }

  function dmi(candles, period = 14) {
    const h = highs(candles);
    const l = lows(candles);
    const c = closes(candles);
    const plusDM = [0];
    const minusDM = [0];
    const tr = [h[0] - l[0]];
    for (let i = 1; i < candles.length; i++) {
      const up = h[i] - h[i - 1];
      const down = l[i - 1] - l[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
      tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    }
    const trR = rma(tr, period);
    const plusR = rma(plusDM, period);
    const minusR = rma(minusDM, period);
    const pdi = trR.map((t, i) => (t && plusR[i] != null ? (100 * plusR[i]) / t : null));
    const mdi = trR.map((t, i) => (t && minusR[i] != null ? (100 * minusR[i]) / t : null));
    const dx = pdi.map((v, i) =>
      v != null && mdi[i] != null && v + mdi[i] !== 0 ? (100 * Math.abs(v - mdi[i])) / (v + mdi[i]) : null
    );
    const adx = rma(dx, period);
    return {
      pdi: toSeries(candles, pdi),
      mdi: toSeries(candles, mdi),
      adx: toSeries(candles, adx),
    };
  }

  function roc(candles, period = 12) {
    const c = closes(candles);
    const out = c.map((v, i) => (i < period ? null : ((v - c[i - period]) / c[i - period]) * 100));
    return toSeries(candles, out);
  }

  function mtm(candles, period = 12) {
    const c = closes(candles);
    const out = c.map((v, i) => (i < period ? null : v - c[i - period]));
    return toSeries(candles, out);
  }

  function bias(candles, period = 6) {
    const c = closes(candles);
    const maVals = sma(c, period);
    const out = c.map((v, i) => (maVals[i] ? ((v - maVals[i]) / maVals[i]) * 100 : null));
    return toSeries(candles, out);
  }

  function mfi(candles, period = 14) {
    const h = highs(candles);
    const l = lows(candles);
    const c = closes(candles);
    const v = volumes(candles);
    const tp = c.map((_, i) => (h[i] + l[i] + c[i]) / 3);
    const out = new Array(candles.length).fill(null);
    for (let i = period; i < candles.length; i++) {
      let pos = 0;
      let neg = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const flow = tp[j] * v[j];
        if (tp[j] > tp[j - 1]) pos += flow;
        else if (tp[j] < tp[j - 1]) neg += flow;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return toSeries(candles, out);
  }

  function ao(candles) {
    const h = highs(candles);
    const l = lows(candles);
    const mp = h.map((v, i) => (v + l[i]) / 2);
    const fast = sma(mp, 5);
    const slow = sma(mp, 34);
    const out = mp.map((_, i) => (fast[i] != null && slow[i] != null ? fast[i] - slow[i] : null));
    return toSeries(candles, out);
  }

  function emv(candles, period = 14) {
    const h = highs(candles);
    const l = lows(candles);
    const v = volumes(candles);
    const out = new Array(candles.length).fill(null);
    for (let i = 1; i < candles.length; i++) {
      const distance = ((h[i] + l[i]) / 2 - (h[i - 1] + l[i - 1]) / 2);
      const boxRatio = v[i] / Math.max(h[i] - l[i], 0.0001);
      out[i] = boxRatio ? distance / boxRatio : 0;
    }
    return toSeries(candles, sma(out.map((x) => x ?? 0), period));
  }

  function vr(candles, period = 26) {
    const c = closes(candles);
    const v = volumes(candles);
    const out = new Array(candles.length).fill(null);
    for (let i = period; i < candles.length; i++) {
      let upVol = 0;
      let downVol = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (c[j] >= c[j - 1]) upVol += v[j];
        else downVol += v[j];
      }
      out[i] = downVol === 0 ? 100 : (upVol / downVol) * 100;
    }
    return toSeries(candles, out);
  }

  function psy(candles, period = 12) {
    const c = closes(candles);
    const out = new Array(candles.length).fill(null);
    for (let i = period; i < candles.length; i++) {
      let up = 0;
      for (let j = i - period + 1; j <= i; j++) if (c[j] > c[j - 1]) up++;
      out[i] = (up / period) * 100;
    }
    return toSeries(candles, out);
  }

  function bbi(candles) {
    const c = closes(candles);
    const e3 = ema(c, 3);
    const e6 = ema(c, 6);
    const e12 = ema(c, 12);
    const e24 = ema(c, 24);
    const out = c.map((_, i) => {
      if ([e3[i], e6[i], e12[i], e24[i]].some((v) => v == null)) return null;
      return (e3[i] + e6[i] + e12[i] + e24[i]) / 4;
    });
    return toSeries(candles, out);
  }

  function envelopes(candles, period = 20, pct = 0.1) {
    const mid = sma(closes(candles), period);
    const upper = mid.map((v) => (v == null ? null : v * (1 + pct)));
    const lower = mid.map((v) => (v == null ? null : v * (1 - pct)));
    return {
      upper: toSeries(candles, upper),
      middle: toSeries(candles, mid),
      lower: toSeries(candles, lower),
    };
  }

  function volMa(candles, period = 5) {
    return toSeries(candles, sma(volumes(candles), period));
  }

  return {
    ma, emaLine, wmaLine, dema: (c, p) => toSeries(c, dema(closes(c), p)),
    tema: (c, p) => toSeries(c, tema(closes(c), p)),
    bollinger, psar, macd, rsi, stochastic, kdj, obv, cci, williamsR,
    atr, dmi, roc, mtm, bias, mfi, ao, emv, vr, psy, bbi, envelopes, volMa,
    times,
  };
})();

window.TA = TA;
