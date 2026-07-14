/* Extended Binance / TradingView-style indicators */
(() => {
  const c = (x) => x.map((i) => i.close);
  const h = (x) => x.map((i) => i.high);
  const l = (x) => x.map((i) => i.low);
  const v = (x) => x.map((i) => i.volume);

  function emaArr(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) continue;
      if (prev == null) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        prev = s / period;
      } else prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  // EMA that tolerates leading nulls (for EMA-of-EMA chaining) so early bars
  // are not corrupted by zero-filling. Seeds from the first `period` non-nulls.
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

  function smaArr(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function toSeries(candles, values) {
    return candles.map((cd, i) => (values[i] == null ? null : { time: cd.time, value: values[i] })).filter(Boolean);
  }

  Object.assign(TA, {
    trima(candles, period = 20) {
      const s1 = smaArr(c(candles), period);
      const s2 = smaArr(s1.map((x) => x ?? 0), period);
      return toSeries(candles, s2);
    },

    hma(candles, period = 20) {
      const half = Math.max(1, Math.floor(period / 2));
      const sqrt = Math.max(1, Math.floor(Math.sqrt(period)));
      const closes = c(candles);
      const wma = (vals, p) => {
        const out = new Array(vals.length).fill(null);
        const denom = (p * (p + 1)) / 2;
        for (let i = p - 1; i < vals.length; i++) {
          let sum = 0;
          for (let j = 0; j < p; j++) sum += vals[i - j] * (p - j);
          out[i] = sum / denom;
        }
        return out;
      };
      const raw = closes.map((_, i) => {
        const a = wma(closes, half)[i];
        const b = wma(closes, period)[i];
        return a != null && b != null ? 2 * a - b : null;
      });
      return toSeries(candles, wma(raw.map((x) => x ?? 0), sqrt));
    },

    vwap(candles) {
      // Anchored VWAP that resets every session (UTC day), matching
      // TradingView's default "Session" VWAP rather than an all-time cumulative.
      let cumVol = 0;
      let cumPV = 0;
      let curDay = null;
      const out = candles.map((cd) => {
        const day = Math.floor(cd.time / 86400);
        if (curDay === null || day !== curDay) {
          curDay = day;
          cumVol = 0;
          cumPV = 0;
        }
        const tp = (cd.high + cd.low + cd.close) / 3;
        cumVol += cd.volume;
        cumPV += tp * cd.volume;
        return cumVol ? cumPV / cumVol : tp;
      });
      return toSeries(candles, out);
    },

    keltner(candles, period = 20, mult = 2) {
      const closes = c(candles);
      const mid = emaArr(closes, period);
      const atrVals = TA.atr(candles, period);
      const atrMap = new Map(atrVals.map((x) => [x.time, x.value]));
      const upper = [];
      const lower = [];
      candles.forEach((cd, i) => {
        const m = mid[i];
        const a = atrMap.get(cd.time);
        if (m == null || a == null) {
          upper.push(null);
          lower.push(null);
        } else {
          upper.push(m + mult * a);
          lower.push(m - mult * a);
        }
      });
      return {
        upper: toSeries(candles, upper),
        middle: toSeries(candles, mid),
        lower: toSeries(candles, lower),
      };
    },

    donchian(candles, period = 20) {
      const highs = h(candles);
      const lows = l(candles);
      const upper = [];
      const lower = [];
      const middle = [];
      for (let i = 0; i < candles.length; i++) {
        if (i < period - 1) {
          upper.push(null);
          lower.push(null);
          middle.push(null);
          continue;
        }
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - period + 1; j <= i; j++) {
          hh = Math.max(hh, highs[j]);
          ll = Math.min(ll, lows[j]);
        }
        upper.push(hh);
        lower.push(ll);
        middle.push((hh + ll) / 2);
      }
      return {
        upper: toSeries(candles, upper),
        middle: toSeries(candles, middle),
        lower: toSeries(candles, lower),
      };
    },

    ichimoku(candles, tenkan = 9, kijun = 26, senkou = 52) {
      const highs = h(candles);
      const lows = l(candles);
      const closes = c(candles);
      const n = candles.length;
      // TradingView default displacement for the leading spans / lagging span.
      const displacement = kijun;
      const mid = (i, p) => {
        if (i < p - 1) return null;
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - p + 1; j <= i; j++) {
          hh = Math.max(hh, highs[j]);
          ll = Math.min(ll, lows[j]);
        }
        return (hh + ll) / 2;
      };
      const tenkanV = candles.map((_, i) => mid(i, tenkan));
      const kijunV = candles.map((_, i) => mid(i, kijun));
      const spanA = tenkanV.map((t, i) => (t != null && kijunV[i] != null ? (t + kijunV[i]) / 2 : null));
      const spanB = candles.map((_, i) => mid(i, senkou));

      // Bar interval (seconds) used to project timestamps into the future for
      // the leading spans and into the past for the lagging span.
      const interval = n > 1 ? candles[n - 1].time - candles[n - 2].time : 60;
      const shiftedTime = (i, offset) => {
        const t = i + offset;
        if (t >= 0 && t < n) return candles[t].time;
        if (t >= n) return candles[n - 1].time + (t - (n - 1)) * interval;
        return candles[0].time + t * interval;
      };

      // Senkou (leading) spans A & B are displaced +displacement bars forward.
      const senkouA = [];
      const senkouB = [];
      for (let i = 0; i < n; i++) {
        if (spanA[i] != null) senkouA.push({ time: shiftedTime(i, displacement), value: spanA[i] });
        if (spanB[i] != null) senkouB.push({ time: shiftedTime(i, displacement), value: spanB[i] });
      }

      // Chikou (lagging) span is the close displaced -displacement bars back.
      const chikou = [];
      for (let i = displacement; i < n; i++) {
        chikou.push({ time: candles[i - displacement].time, value: closes[i] });
      }

      return {
        tenkan: toSeries(candles, tenkanV),
        kijun: toSeries(candles, kijunV),
        senkouA,
        senkouB,
        chikou,
      };
    },

    mike(candles, period = 12) {
      const highs = h(candles);
      const lows = l(candles);
      const typ = candles.map((_, i) => (highs[i] + lows[i] + c(candles)[i]) / 3);
      const out = { wr: [], mr: [], sr: [], ws: [], ms: [], ss: [] };
      for (let i = 0; i < candles.length; i++) {
        if (i < period - 1) {
          ['wr', 'mr', 'sr', 'ws', 'ms', 'ss'].forEach((k) => out[k].push(null));
          continue;
        }
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - period + 1; j <= i; j++) {
          hh = Math.max(hh, highs[j]);
          ll = Math.min(ll, lows[j]);
        }
        const t = typ[i];
        out.wr.push(t + (t - ll));
        out.mr.push(t + (hh - ll) * 0.5);
        out.sr.push(t + (hh - ll) * 2);
        out.ws.push(t - (hh - t));
        out.ms.push(t - (hh - ll) * 0.5);
        out.ss.push(t - (hh - ll) * 2);
      }
      return Object.fromEntries(Object.entries(out).map(([k, arr]) => [k, toSeries(candles, arr)]));
    },

    pbx(candles) {
      const closes = c(candles);
      const periods = [4, 6, 9, 13, 18, 24];
      const colors = periods.map((p) => TA.emaLine(candles, p));
      return {
        e4: colors[0], e6: colors[1], e9: colors[2],
        e13: colors[3], e18: colors[4], e24: colors[5],
      };
    },

    trix(candles, period = 12) {
      const closes = c(candles);
      const e1 = emaArr(closes, period);
      const e2 = emaChain(e1, period);
      const e3 = emaChain(e2, period);
      const out = e3.map((val, i) => {
        if (i === 0 || val == null || e3[i - 1] == null || e3[i - 1] === 0) return null;
        return ((val - e3[i - 1]) / e3[i - 1]) * 100;
      });
      return toSeries(candles, out);
    },

    dma(candles, short = 10, long = 50, m = 10) {
      const closes = c(candles);
      const d = closes.map((_, i) => {
        const s = smaArr(closes, short)[i];
        const lg = smaArr(closes, long)[i];
        return s != null && lg != null ? s - lg : null;
      });
      const ama = smaArr(d.map((x) => x ?? 0), m);
      return { dma: toSeries(candles, d), ama: toSeries(candles, ama) };
    },

    dpo(candles, period = 20) {
      const closes = c(candles);
      const shift = Math.floor(period / 2) + 1;
      const ma = smaArr(closes, period);
      const out = closes.map((val, i) => (ma[i] == null ? null : val - ma[i - shift]));
      return toSeries(candles, out);
    },

    cr(candles, period = 26, m = 10) {
      const highs = h(candles);
      const lows = l(candles);
      const out = new Array(candles.length).fill(null);
      for (let i = period; i < candles.length; i++) {
        let p1 = 0;
        let p2 = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const mid = (highs[j] + lows[j]) / 2;
          p1 += Math.max(0, highs[j] - mid);
          p2 += Math.max(0, mid - lows[j]);
        }
        out[i] = p2 === 0 ? 100 : (p1 / p2) * 100;
      }
      const ma = smaArr(out.map((x) => x ?? 0), m);
      return { cr: toSeries(candles, out), ma: toSeries(candles, ma) };
    },

    brar(candles, period = 26) {
      const highs = h(candles);
      const lows = l(candles);
      const opens = candles.map((x) => x.open);
      const ar = new Array(candles.length).fill(null);
      const br = new Array(candles.length).fill(null);
      for (let i = period; i < candles.length; i++) {
        let ho = 0;
        let ol = 0;
        let hc = 0;
        let cl = 0;
        for (let j = i - period + 1; j <= i; j++) {
          ho += highs[j] - opens[j];
          ol += opens[j] - lows[j];
          hc += highs[j] - c(candles)[j - 1];
          cl += c(candles)[j - 1] - lows[j];
        }
        ar[i] = ol === 0 ? 100 : (ho / ol) * 100;
        br[i] = cl === 0 ? 100 : (hc / cl) * 100;
      }
      return { ar: toSeries(candles, ar), br: toSeries(candles, br) };
    },

    asi(candles, m = 6) {
      const highs = h(candles);
      const lows = l(candles);
      const closes = c(candles);
      const opens = candles.map((x) => x.open);
      const si = [0];
      for (let i = 1; i < candles.length; i++) {
        const a = Math.abs(highs[i] - closes[i - 1]);
        const b = Math.abs(lows[i] - closes[i - 1]);
        const c1 = Math.abs(highs[i] - lows[i - 1]);
        const d = Math.abs(closes[i - 1] - opens[i - 1]);
        const k = Math.max(a, b);
        const r = a + 0.5 * b + 0.25 * d;
        const x = closes[i] - closes[i - 1] + 0.5 * (closes[i] - opens[i]) + 0.25 * (closes[i - 1] - opens[i - 1]);
        const sh = r === 0 || k === 0 ? 0 : (x / r) * k;
        si.push(sh);
      }
      const asi = si.reduce((acc, val, i) => {
        acc.push((acc[i - 1] ?? 0) + val);
        return acc;
      }, []);
      const ma = smaArr(asi, m);
      return { asi: toSeries(candles, asi), ma: toSeries(candles, ma) };
    },

    wvad(candles) {
      const closes = c(candles);
      const opens = candles.map((x) => x.open);
      const vols = v(candles);
      let cum = 0;
      const out = candles.map((cd, i) => {
        const range = cd.high - cd.low;
        cum += range ? ((closes[i] - opens[i]) / range) * vols[i] : 0;
        return cum;
      });
      return toSeries(candles, out);
    },

    ad(candles) {
      const closes = c(candles);
      const vols = v(candles);
      let cum = 0;
      const out = candles.map((cd, i) => {
        const range = cd.high - cd.low;
        const mfm = range ? ((cd.close - cd.low) - (cd.high - cd.close)) / range : 0;
        cum += mfm * vols[i];
        return cum;
      });
      return toSeries(candles, out);
    },

    cmf(candles, period = 20) {
      const closes = c(candles);
      const vols = v(candles);
      const mfv = candles.map((cd, i) => {
        const range = cd.high - cd.low;
        const mfm = range ? ((cd.close - cd.low) - (cd.high - cd.close)) / range : 0;
        return mfm * vols[i];
      });
      const out = new Array(candles.length).fill(null);
      for (let i = period - 1; i < candles.length; i++) {
        let sumMfv = 0;
        let sumVol = 0;
        for (let j = i - period + 1; j <= i; j++) {
          sumMfv += mfv[j];
          sumVol += vols[j];
        }
        out[i] = sumVol ? sumMfv / sumVol : 0;
      }
      return toSeries(candles, out);
    },

    cho(candles, fast = 3, slow = 10) {
      const adLine = TA.ad(candles).map((x) => x.value);
      const ef = emaArr(adLine, fast);
      const es = emaArr(adLine, slow);
      const out = adLine.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
      return toSeries(candles, out);
    },

    pvt(candles) {
      const closes = c(candles);
      const vols = v(candles);
      let cum = 0;
      const out = closes.map((val, i) => {
        if (i === 0) return 0;
        cum += vols[i] * (val - closes[i - 1]) / closes[i - 1];
        return cum;
      });
      return toSeries(candles, out);
    },

    vroc(candles, period = 12) {
      const vols = v(candles);
      const out = vols.map((val, i) => (i < period ? null : ((val - vols[i - period]) / vols[i - period]) * 100));
      return toSeries(candles, out);
    },

    cmo(candles, period = 14) {
      const closes = c(candles);
      const out = new Array(closes.length).fill(null);
      for (let i = period; i < closes.length; i++) {
        let up = 0;
        let down = 0;
        for (let j = i - period + 1; j <= i; j++) {
          const d = closes[j] - closes[j - 1];
          if (d > 0) up += d;
          else down -= d;
        }
        out[i] = up + down === 0 ? 0 : ((up - down) / (up + down)) * 100;
      }
      return toSeries(candles, out);
    },

    ppo(candles, fast = 12, slow = 26) {
      const closes = c(candles);
      const ef = emaArr(closes, fast);
      const es = emaArr(closes, slow);
      const out = closes.map((_, i) => (ef[i] != null && es[i] != null && es[i] !== 0 ? ((ef[i] - es[i]) / es[i]) * 100 : null));
      return toSeries(candles, out);
    },

    uo(candles, p1 = 7, p2 = 14, p3 = 28) {
      const highs = h(candles);
      const lows = l(candles);
      const closes = c(candles);
      const bp = closes.map((_, i) => closes[i] - Math.min(lows[i], closes[i - 1] ?? lows[i]));
      const tr = closes.map((_, i) => {
        const prev = closes[i - 1] ?? closes[i];
        return Math.max(highs[i] - lows[i], Math.abs(highs[i] - prev), Math.abs(lows[i] - prev));
      });
      const avg = (len) => {
        const out = new Array(closes.length).fill(null);
        for (let i = len - 1; i < closes.length; i++) {
          let sBp = 0;
          let sTr = 0;
          for (let j = i - len + 1; j <= i; j++) {
            sBp += bp[j];
            sTr += tr[j];
          }
          out[i] = sTr ? sBp / sTr : null;
        }
        return out;
      };
      const a1 = avg(p1);
      const a2 = avg(p2);
      const a3 = avg(p3);
      const out = closes.map((_, i) => {
        if ([a1[i], a2[i], a3[i]].some((x) => x == null)) return null;
        return ((a1[i] * 4 + a2[i] * 2 + a3[i]) / 7) * 100;
      });
      return toSeries(candles, out);
    },

    aroon(candles, period = 25) {
      const highs = h(candles);
      const lows = l(candles);
      const up = new Array(candles.length).fill(null);
      const down = new Array(candles.length).fill(null);
      for (let i = period; i < candles.length; i++) {
        let hi = i - period;
        let lo = i - period;
        for (let j = i - period + 1; j <= i; j++) {
          if (highs[j] >= highs[hi]) hi = j;
          if (lows[j] <= lows[lo]) lo = j;
        }
        up[i] = ((period - (i - hi)) / period) * 100;
        down[i] = ((period - (i - lo)) / period) * 100;
      }
      const osc = up.map((u, i) => (u != null && down[i] != null ? u - down[i] : null));
      return { up: toSeries(candles, up), down: toSeries(candles, down), osc: toSeries(candles, osc) };
    },

    stochRsi(candles, period = 14, k = 3, d = 3) {
      const rsiVals = TA.rsi(candles, period).map((x) => x.value);
      const st = new Array(candles.length).fill(null);
      for (let i = period; i < rsiVals.length; i++) {
        const slice = rsiVals.slice(i - period + 1, i + 1);
        const mn = Math.min(...slice);
        const mx = Math.max(...slice);
        st[i] = mx === mn ? 50 : ((rsiVals[i] - mn) / (mx - mn)) * 100;
      }
      const kLine = smaArr(st.map((x) => x ?? 0), k);
      const dLine = smaArr(kLine.map((x) => x ?? 0), d);
      return { k: toSeries(candles, kLine), d: toSeries(candles, dLine) };
    },

    sroc(candles, period = 13, smooth = 21) {
      const closes = c(candles);
      const roc = closes.map((val, i) => (i < period ? null : ((val - closes[i - period]) / closes[i - period]) * 100));
      const out = emaArr(roc.map((x) => x ?? 0), smooth);
      return toSeries(candles, out);
    },

    mass(candles, period = 9) {
      const highs = h(candles);
      const lows = l(candles);
      const hl = highs.map((x, i) => x - lows[i]);
      const e1 = emaArr(hl, period);
      const e2 = emaArr(e1.map((x) => x ?? 0), period);
      const ratio = e1.map((x, i) => (x != null && e2[i] ? x / e2[i] : null));
      const out = new Array(candles.length).fill(null);
      for (let i = 24; i < candles.length; i++) {
        let sum = 0;
        for (let j = i - 24 + 1; j <= i; j++) sum += ratio[j] ?? 0;
        out[i] = sum;
      }
      return toSeries(candles, out);
    },

    priceOsc(candles, short = 12, long = 26) {
      const closes = c(candles);
      const s = smaArr(closes, short);
      const lg = smaArr(closes, long);
      const out = closes.map((_, i) => (s[i] != null && lg[i] != null && lg[i] !== 0 ? ((s[i] - lg[i]) / lg[i]) * 100 : null));
      return toSeries(candles, out);
    },

    nvi(candles) {
      const closes = c(candles);
      const vols = v(candles);
      let nvi = 1000;
      const out = [nvi];
      for (let i = 1; i < candles.length; i++) {
        if (vols[i] < vols[i - 1]) nvi += ((closes[i] - closes[i - 1]) / closes[i - 1]) * nvi;
        out.push(nvi);
      }
      return toSeries(candles, out);
    },

    pvi(candles) {
      const closes = c(candles);
      const vols = v(candles);
      let pvi = 1000;
      const out = [pvi];
      for (let i = 1; i < candles.length; i++) {
        if (vols[i] > vols[i - 1]) pvi += ((closes[i] - closes[i - 1]) / closes[i - 1]) * pvi;
        out.push(pvi);
      }
      return toSeries(candles, out);
    },

    adtm(candles, period = 23) {
      const opens = candles.map((x) => x.open);
      const highs = h(candles);
      const lows = l(candles);
      const stm = candles.map((_, i) => {
        const dtm = highs[i] - opens[i];
        const dbm = opens[i] - lows[i];
        if (dtm > dbm && dtm > 0) return dtm;
        if (dbm > dtm && dbm > 0) return -dbm;
        return 0;
      });
      const out = new Array(candles.length).fill(null);
      for (let i = period - 1; i < candles.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += stm[j];
        out[i] = sum;
      }
      return toSeries(candles, out);
    },

    tapi(candles, period = 6) {
      const closes = c(candles);
      const vols = v(candles);
      const out = closes.map((val, i) => {
        const ma = smaArr(vols, period)[i];
        return ma ? val / ma : null;
      });
      return toSeries(candles, out);
    },

    avl(candles, period = 20) {
      return TA.volMa(candles, period);
    },

    vwma(candles, period = 20) {
      const closes = c(candles);
      const vols = v(candles);
      const out = new Array(candles.length).fill(null);
      for (let i = period - 1; i < candles.length; i++) {
        let sumPV = 0;
        let sumV = 0;
        for (let j = i - period + 1; j <= i; j++) {
          sumPV += closes[j] * vols[j];
          sumV += vols[j];
        }
        out[i] = sumV ? sumPV / sumV : null;
      }
      return toSeries(candles, out);
    },

    kama(candles, period = 10, fast = 2, slow = 30) {
      const closes = c(candles);
      const out = new Array(closes.length).fill(null);
      const fastSC = 2 / (fast + 1);
      const slowSC = 2 / (slow + 1);
      let kama = closes[0];
      out[0] = kama;
      for (let i = 1; i < closes.length; i++) {
        if (i < period) {
          out[i] = null;
          continue;
        }
        let change = Math.abs(closes[i] - closes[i - period]);
        let volatility = 0;
        for (let j = i - period + 1; j <= i; j++) volatility += Math.abs(closes[j] - closes[j - 1]);
        const er = volatility ? change / volatility : 0;
        const sc = (er * (fastSC - slowSC) + slowSC) ** 2;
        kama = kama + sc * (closes[i] - kama);
        out[i] = kama;
      }
      return toSeries(candles, out);
    },

    adx(candles, period = 14) {
      return TA.dmi(candles, period).adx;
    },

    natr(candles, period = 14) {
      const closes = c(candles);
      return TA.atr(candles, period).map((pt) => {
        const idx = candles.findIndex((x) => x.time === pt.time);
        if (idx < 0 || !closes[idx]) return null;
        return { time: pt.time, value: (pt.value / closes[idx]) * 100 };
      }).filter(Boolean);
    },

    trange(candles) {
      const highs = h(candles);
      const lows = l(candles);
      const closes = c(candles);
      const out = candles.map((_, i) => {
        const prev = closes[i - 1] ?? closes[i];
        return Math.max(highs[i] - lows[i], Math.abs(highs[i] - prev), Math.abs(lows[i] - prev));
      });
      return toSeries(candles, out);
    },

    bop(candles) {
      const out = candles.map((cd) => {
        const range = cd.high - cd.low;
        return range ? (cd.close - cd.open) / range : 0;
      });
      return toSeries(candles, out);
    },

    wad(candles, period = 20) {
      const closes = c(candles);
      const highs = h(candles);
      const lows = l(candles);
      let cum = 0;
      const wad = [0];
      for (let i = 1; i < candles.length; i++) {
        const gain = closes[i] > closes[i - 1] ? closes[i] - Math.min(lows[i], closes[i - 1]) : 0;
        const loss = closes[i] < closes[i - 1] ? closes[i] - Math.max(highs[i], closes[i - 1]) : 0;
        cum += gain + loss;
        wad.push(cum);
      }
      const ma = smaArr(wad, period);
      return { wad: toSeries(candles, wad), ma: toSeries(candles, ma) };
    },

    mi(candles, period = 12) {
      const closes = c(candles);
      const a = closes.map((val, i) => (i < period ? null : val - closes[i - period]));
      const b = a.map((val, i) => (i < period || val == null ? null : a[i - period]));
      const out = a.map((v, i) => (v != null && b[i] != null && b[i] !== 0 ? v / b[i] : null));
      return toSeries(candles, out);
    },

    rc(candles, period = 50) {
      const closes = c(candles);
      const out = closes.map((val, i) => (i < period ? null : val / closes[i - period]));
      return toSeries(candles, out);
    },

    stdDev(candles, period = 20) {
      const closes = c(candles);
      const out = new Array(closes.length).fill(null);
      for (let i = period - 1; i < closes.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += closes[j];
        const mean = sum / period;
        let sq = 0;
        for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - mean) ** 2;
        out[i] = Math.sqrt(sq / period);
      }
      return toSeries(candles, out);
    },

    pivotClassic(candles) {
      const out = { p: [], r1: [], s1: [], r2: [], s2: [] };
      candles.forEach((cd, i) => {
        if (i === 0) {
          ['p', 'r1', 's1', 'r2', 's2'].forEach((k) => out[k].push(null));
          return;
        }
        const prev = candles[i - 1];
        const p = (prev.high + prev.low + prev.close) / 3;
        out.p.push(p);
        out.r1.push(2 * p - prev.low);
        out.s1.push(2 * p - prev.high);
        out.r2.push(p + (prev.high - prev.low));
        out.s2.push(p - (prev.high - prev.low));
      });
      return Object.fromEntries(Object.entries(out).map(([k, arr]) => [k, toSeries(candles, arr)]));
    },
  });
})();
