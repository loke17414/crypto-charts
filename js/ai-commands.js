/* Natural language command parser & executor (Korean) */
const AICommands = (() => {
  const INDICATOR_ALIASES = {
    ma7: ['ma7', 'ma 7', '이평7', '이동평균7'],
    ma25: ['ma25', 'ma 25', '이평25', '이동평균25'],
    ma99: ['ma99', 'ma 99', '이평99', '이동평균99'],
    ema7: ['ema7', 'ema 7', '지수이평7'],
    ema25: ['ema25', 'ema 25'],
    ema99: ['ema99', 'ema 99'],
    boll: ['boll', 'bollinger', '볼린저', '볼밴', '볼린저밴드', '볼린저 밴드'],
    macd: ['macd', '맥디', 'macd지표'],
    rsi: ['rsi', '알에스아이', '상대강도', '상대강도지수'],
    kdj: ['kdj', '스토캐스틱kdj'],
    vol: ['vol', 'volume', '거래량'],
    sar: ['sar', '파라볼릭', 'sar지표'],
    ichimoku: ['ichimoku', '일목', '일목균형표'],
    kc: ['kc', '켈트너', 'keltner'],
    dc: ['dc', '돈치안', 'donchian'],
    atr: ['atr', '평균진폭'],
    obv: ['obv'],
    cci: ['cci'],
    stoch: ['stoch', '스토캐스틱'],
    mfi: ['mfi'],
  };

  const COIN_ALIASES = {
    bitcoin: ['비트코인', '비트', 'btc', 'bitcoin'],
    ethereum: ['이더리움', '이더', 'eth', 'ethereum'],
    solana: ['솔라나', '솔', 'sol', 'solana'],
    ripple: ['리플', 'xrp', 'ripple'],
    dogecoin: ['도지', '도지코인', 'doge', 'dogecoin'],
    cardano: ['에이다', '카르다노', 'ada', 'cardano'],
    binancecoin: ['bnb', '바이낸스코인', 'binancecoin'],
  };

  const INTERVAL_MAP = {
    '1m': ['1분', '1분봉', '1m', '1분 차트'],
    '5m': ['5분', '5분봉', '5m'],
    '15m': ['15분', '15분봉', '15m'],
    '1h': ['1시간', '1시간봉', '1h', '한시간'],
    '4h': ['4시간', '4시간봉', '4h'],
    '1d': ['1일', '일봉', '1d', '하루', '일간'],
  };

  const SHOW_WORDS = ['켜', '추가', '표시', '보여', '넣어', '올려', '써', '적용', '깔아'];
  const HIDE_WORDS = ['꺼', '제거', '삭제', '없애', '빼', '해제', '지워'];
  const BUY_WORDS = ['매수', '롱', '사줘', '구매', '매수해', '들어가', '진입'];
  const SELL_WORDS = ['매도', '숏', '팔아', '팔아줘', '청산', '전량매도', '다팔아'];
  const ANALYZE_WORDS = ['분석', '어때', '상황', '판단', '의견', '추천', '신호', '어떻게'];

  function normalize(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function matchAny(text, words) {
    return words.some((w) => text.includes(w));
  }

  function findIndicators(text) {
    const found = new Set();
    const bridge = window.CryptoCharts;
    if (!bridge) return [];

    for (const [id, aliases] of Object.entries(INDICATOR_ALIASES)) {
      if (aliases.some((a) => text.includes(a))) found.add(id);
    }

    if (text.includes('이동평균') || text.includes('이평') || text.match(/\bma\b/)) {
      if (text.includes('7')) found.add('ma7');
      if (text.includes('25')) found.add('ma25');
      if (text.includes('99')) found.add('ma99');
      if (![...found].some((id) => id.startsWith('ma'))) {
        ['ma7', 'ma25', 'ma99'].forEach((id) => found.add(id));
      }
    }

    if (text.includes('지표') && found.size === 0) {
      const registry = bridge.registry?.() || [];
      for (const d of registry) {
        const name = d.baseName.toLowerCase();
        if (text.includes(name)) found.add(d.id);
      }
    }

    return [...found];
  }

  function findCoin(text) {
    for (const [id, aliases] of Object.entries(COIN_ALIASES)) {
      if (aliases.some((a) => text.includes(a))) return id;
    }
    const m = text.match(/([a-z]{2,10})차트/);
    if (m) return m[1];
    return null;
  }

  function findInterval(text) {
    for (const [iv, aliases] of Object.entries(INTERVAL_MAP)) {
      if (aliases.some((a) => text.includes(a))) return iv;
    }
    return null;
  }

  function parseAmount(text, price) {
    const usdtMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:usdt|달러|\$|원)/i);
    if (usdtMatch) return parseFloat(usdtMatch[1]) / price;

    const pctMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch && window.PaperTrading) {
      const pct = parseFloat(pctMatch[1]) / 100;
      const wallet = window.PaperTrading.getWallet();
      if (matchAny(text, BUY_WORDS)) return (wallet.usdt * pct) / price;
      if (matchAny(text, SELL_WORDS)) {
        const sym = window.CryptoCharts?.getState()?.symbol;
        if (sym) {
          const pos = wallet.positions[sym];
          if (pos) return pos.qty * pct;
        }
      }
    }

    const qtyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:개|코인|수량)?/);
    if (qtyMatch && !text.includes('분') && !text.includes('시간') && !text.includes('일')) {
      const n = parseFloat(qtyMatch[1]);
      if (n > 0 && n < 10000) return n;
    }

    return null;
  }

  function parse(text) {
    const t = normalize(text);
    if (!t) return { intent: 'empty' };

    if (t.includes('도움') || t === 'help' || t === '?') return { intent: 'help' };
    if (t.includes('지표') && (t.includes('다') || t.includes('전부') || t.includes('모두')) && matchAny(t, HIDE_WORDS)) {
      return { intent: 'indicator_clear' };
    }
    if (t.includes('잔고') || t.includes('포지션') || t.includes('모의매매') && t.includes('상태')) {
      return { intent: 'trade_status' };
    }
    if (t.includes('초기화') && (t.includes('잔고') || t.includes('모의'))) return { intent: 'trade_reset' };

    const indicators = findIndicators(t);
    const coin = findCoin(t);
    const interval = findInterval(t);

    if (matchAny(t, ANALYZE_WORDS)) return { intent: 'analyze', indicators };

    if (matchAny(t, BUY_WORDS) || matchAny(t, SELL_WORDS)) {
      const side = matchAny(t, SELL_WORDS) && !matchAny(t, BUY_WORDS) ? 'sell' : 'buy';
      const sellAll = t.includes('전량') || t.includes('다 팔') || t.includes('다팔') || t.includes('청산');
      return { intent: 'trade', side, sellAll, amount: null, coin, interval };
    }

    if (indicators.length) {
      const hide = matchAny(t, HIDE_WORDS) && !matchAny(t, SHOW_WORDS);
      const show = !hide;
      return { intent: 'indicators', ids: indicators, show };
    }

    if (coin) return { intent: 'coin', coin, interval };
    if (interval) return { intent: 'interval', interval };

    if (t.includes('캔들')) return { intent: 'chart_type', type: 'candlestick' };
    if (t.includes('라인')) return { intent: 'chart_type', type: 'line' };

    return { intent: 'unknown', raw: text };
  }

  function analyzeMarket() {
    const bridge = window.CryptoCharts;
    const candles = bridge?.getCandles?.() || [];
    if (candles.length < 30) return '분석할 캔들 데이터가 부족합니다.';

    const st = bridge.getState();
    const price = bridge.getPrice();
    const lines = [`📈 ${st.coin?.name || '코인'} (${st.interval}) 현재가 $${price?.toFixed(2) ?? '—'}`];

    if (typeof TA !== 'undefined') {
      const rsiData = TA.rsi(candles, 14);
      const lastRsi = rsiData.at(-1)?.value;
      if (lastRsi != null) {
        let rsiMsg = `RSI(14): ${lastRsi.toFixed(1)}`;
        if (lastRsi >= 70) rsiMsg += ' → 과매수 구간 ⚠️';
        else if (lastRsi <= 30) rsiMsg += ' → 과매도 구간 ⚠️';
        else rsiMsg += ' → 중립 구간';
        lines.push(rsiMsg);
      }

      const macdData = TA.macd(candles);
      const lastHist = macdData.histogram?.at(-1)?.value;
      const lastDif = macdData.macd?.at(-1)?.value;
      const lastDea = macdData.signal?.at(-1)?.value;
      if (lastHist != null) {
        lines.push(`MACD: DIF ${lastDif?.toFixed(4)} / DEA ${lastDea?.toFixed(4)} / Hist ${lastHist.toFixed(4)} (${lastHist >= 0 ? '양수↑' : '음수↓'})`);
      }

      const ma7 = TA.ma(candles, 7).at(-1)?.value;
      const ma25 = TA.ma(candles, 25).at(-1)?.value;
      if (ma7 != null && ma25 != null && price) {
        if (price > ma7 && ma7 > ma25) lines.push('이동평균: 정배열 (상승 추세)');
        else if (price < ma7 && ma7 < ma25) lines.push('이동평균: 역배열 (하락 추세)');
        else lines.push('이동평균: 혼조세');
      }
    }

    const active = bridge.getActiveIndicators?.() || [];
    if (active.length) {
      lines.push(`활성 지표: ${active.map((i) => i.name).join(', ')}`);
    }

    lines.push('※ 참고용 분석이며 투자 조언이 아닙니다.');
    return lines.join('\n');
  }

  const HELP = `🤖 AI 어시스턴트 명령 예시:

📊 지표
· "MACD랑 RSI 켜줘"
· "볼린저 밴드 추가"
· "지표 다 지워"

📈 차트
· "비트코인 차트"
· "이더리움 4시간봉"
· "캔들 차트로 바꿔"

💰 모의매매 (실제 거래 아님)
· "100달러 매수"
· "50% 매도"
· "전량 청산"
· "잔고 보여줘"

🔍 분석
· "지금 상황 분석해줘"
· "매수해도 될까?"`;

  async function execute(cmd, text) {
    const bridge = window.CryptoCharts;
    if (!bridge) return { ok: false, message: '차트가 아직 준비되지 않았습니다.' };

    switch (cmd.intent) {
      case 'help':
        return { ok: true, message: HELP };

      case 'indicator_clear':
        bridge.clearIndicators();
        return { ok: true, message: '모든 지표를 제거했습니다.' };

      case 'indicators': {
        const results = [];
        for (const id of cmd.ids) {
          const ok = bridge.toggleIndicator(id, cmd.show);
          const def = bridge.registry().find((d) => d.id === id);
          const name = def?.baseName || id;
          if (ok) results.push(`${name} ${cmd.show ? '추가' : '제거'}`);
        }
        if (!results.length) return { ok: false, message: '인식된 지표가 없습니다. 다시 말씀해 주세요.' };
        return { ok: true, message: results.join(', ') + ' 완료.' };
      }

      case 'coin': {
        const ok = await bridge.selectCoin(cmd.coin);
        if (!ok) return { ok: false, message: `"${cmd.coin}" 코인을 찾지 못했습니다.` };
        let msg = `${cmd.coin} 차트로 전환했습니다.`;
        if (cmd.interval) {
          await bridge.setInterval(cmd.interval);
          msg += ` (${cmd.interval} 봉)`;
        }
        return { ok: true, message: msg };
      }

      case 'interval': {
        const ok = await bridge.setInterval(cmd.interval);
        return ok
          ? { ok: true, message: `${cmd.interval} 봉으로 변경했습니다.` }
          : { ok: false, message: '지원하지 않는 시간봉입니다.' };
      }

      case 'chart_type': {
        bridge.setChartType(cmd.type);
        return { ok: true, message: `${cmd.type === 'candlestick' ? '캔들' : '라인'} 차트로 변경했습니다.` };
      }

      case 'analyze':
        return { ok: true, message: analyzeMarket() };

      case 'trade_status':
        return {
          ok: true,
          message: PaperTrading.getStatus(bridge.getState().symbol, bridge.getPrice()),
        };

      case 'trade_reset':
        PaperTrading.reset();
        return { ok: true, message: '모의매매 잔고를 $10,000 USDT로 초기화했습니다.' };

      case 'trade': {
        const price = bridge.getPrice();
        if (!price) return { ok: false, message: '현재 가격을 가져올 수 없습니다.' };

        const st = bridge.getState();
        const symbol = st.symbol;
        if (!symbol) return { ok: false, message: '코인을 먼저 선택해 주세요.' };

        if (cmd.coin) await bridge.selectCoin(cmd.coin);
        if (cmd.interval) await bridge.setInterval(cmd.interval);

        const t = normalize(text);
        if (cmd.side === 'sell' && (cmd.sellAll || t.includes('전량') || t.includes('청산'))) {
          const res = PaperTrading.sellAll(symbol, price);
          return { ok: res.ok, message: res.message };
        }

        let qty = parseAmount(t, price);
        if (!qty || qty <= 0) {
          if (cmd.side === 'buy') qty = 100 / price;
          else {
            const pos = PaperTrading.getWallet().positions[symbol];
            if (!pos?.qty) return { ok: false, message: '보유 수량이 없습니다. 매도 수량을 말씀해 주세요. (예: "50% 매도")' };
            qty = pos.qty * 0.5;
          }
        }

        const res = cmd.side === 'buy'
          ? PaperTrading.buy(symbol, qty, price, st.coin?.name)
          : PaperTrading.sell(symbol, qty, price, st.coin?.name);

        return { ok: res.ok, message: res.message + '\n⚠️ 모의매매입니다. 실제 주문이 아닙니다.' };
      }

      case 'empty':
        return { ok: false, message: '명령을 입력해 주세요.' };

      default:
        return {
          ok: false,
          message: '명령을 이해하지 못했습니다. "도움말"을 입력해 보세요.\n예: "RSI 켜줘", "비트코인 1시간봉", "100달러 매수"',
        };
    }
  }

  async function run(text) {
    const cmd = parse(text);
    return execute(cmd, text);
  }

  return { parse, execute, run, HELP };
})();
