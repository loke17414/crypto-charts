/* GPT-powered natural language strategy editor (trading page) */

const StrategyAI = (() => {
  const HISTORY_KEY = 'crypto-charts-strategy-ai-history';
  const MAX_HISTORY = 24;

  const STRATEGY_APPLY_HINT = (
    '전략을 이해하지 못했습니다. 진입 조건을 더 구체적으로 설명해 주세요.\n'
    + '예: RSI 30 이하 롱, 양봉일 때 롱, EMA 12가 26 상향 돌파 시 롱'
  );

  function looksLikeStrategyApply(text) {
    const t = (text || '').trim();
    if (!t) return false;
    if (/(\?|뭐야|무엇|설명해|알려줘|추천해|일까|할까|인가요)/.test(t)) {
      if (!/(진입|만들|설정해|적용|바꿔|추가해|넣어)/.test(t)) return false;
    }
    if (/^(손절|익절|레버리지만)/.test(t.replace(/\s/g, ''))) return false;
    return /진입|조건|롱|숏|long|short|rsi|macd|ema|캔들|봉|양봉|상승|전략|패턴|크로스|볼린저|해머|장악|매수|매도/.test(t);
  }

  function formatAiError(message) {
    const msg = String(message || '전략 적용에 실패했습니다. 다시 시도해 주세요.').trim();
    return msg.startsWith('⚠️') ? msg : `⚠️ ${msg}`;
  }

  const $ = (sel) => document.querySelector(sel);

  let conversationHistory = [];
  let aiPopupOpen = false;

  function openAiPopup() {
    aiPopupOpen = true;
    $('#strategyAiPopup')?.classList.remove('hidden');
    $('#strategyAiToggleBtn')?.classList.add('is-active');
    $('#strategyAiInput')?.focus();
    refreshRecommendedStrategies();
  }

  function getChartCandles() {
    return window.FuturesBotApp?.getLastCandles?.()
      || window.CryptoCharts?.getCandles?.()
      || [];
  }

  function refreshRecommendedStrategies() {
    const list = $('#strategyRecommendList');
    const note = $('#strategyRecommendNote');
    if (!list) return;
    if (!window.StrategyPresets?.recommend) {
      if (note) note.textContent = '추천 전략 모듈을 불러오지 못했습니다.';
      return;
    }
    list.innerHTML = '<div class="api-hint">현재 차트에서 승률 측정 중…</div>';
    if (note) note.textContent = '측정 중…';

    // Yield to UI so the popup paints before heavy replay work.
    requestAnimationFrame(() => {
      const candles = getChartCandles();
      const result = StrategyPresets.recommend(candles, {
        minWinRate: 50,
        minTrades: 5,
        limit: 10,
        maxTrades: 50,
      });
      window.__lastRecommendedStrategies = result;
      if (note) note.textContent = result.note || '';
      list.innerHTML = '';
      if (!result.items?.length) {
        list.innerHTML = '<div class="api-hint">추천할 전략이 없습니다. 차트를 불러온 뒤 새로고침하세요.</div>';
        return;
      }
      result.items.forEach((item, index) => {
        const row = document.createElement('div');
        row.className = `strategy-recommend__item ${item.ok ? 'is-pass' : 'is-fail'}`;
        row.innerHTML = `
          <div>
            <strong>${index + 1}. ${item.name}</strong>
            <div class="strategy-recommend__meta">${item.blurb || ''}</div>
            <div class="strategy-recommend__meta">승률 ${item.winRate}% · ${item.trades}회 · PnL ${item.totalPnlPct}%</div>
          </div>
          <div class="strategy-recommend__actions">
            <button type="button" class="btn btn--simple-primary btn--sm" data-rec-apply="${item.id}" ${item.trades < 3 ? 'disabled' : ''}>적용</button>
            <button type="button" class="btn btn--ghost btn--sm" data-rec-gpt="${item.id}">GPT</button>
          </div>
        `;
        list.appendChild(row);
      });
    });
  }

  function applyRecommendedDirect(id) {
    const pack = window.__lastRecommendedStrategies?.items?.find((x) => x.id === id)
      || (() => {
        const preset = StrategyPresets.getPreset(id);
        if (!preset) return null;
        return StrategyPresets.measurePreset(getChartCandles(), preset);
      })();
    if (!pack?.settings) {
      addMessage('assistant', '추천 전략을 찾을 수 없습니다. 새로고침 후 다시 시도하세요.', { persist: false });
      return;
    }
    const targetSlotId = $('#strategyAiTargetSlot')?.value || '__new__';
    const result = FuturesBotApp.applyStrategySettings(pack.settings, {
      patch: pack.settings,
      changedFields: Object.keys(pack.settings),
      targetSlotId,
      summary: `추천 전략 적용: ${pack.name} (승률 ${pack.winRate}%)`,
    });
    if (result?.applied !== false) {
      addMessage(
        'assistant',
        `✅ 추천 전략 «${pack.name}» 적용 완료 — 승률 ${pack.winRate}% · ${pack.trades}거래 (현재 차트 백테스트). GPT 대화에서도 이 전략을 기준으로 수정할 수 있습니다.`,
      );
    } else {
      addMessage('assistant', formatAiError(result?.reason || '추천 전략 적용에 실패했습니다.'), { persist: false });
    }
  }

  function applyRecommendedViaGpt(id) {
    const pack = window.__lastRecommendedStrategies?.items?.find((x) => x.id === id);
    const preset = StrategyPresets.getPreset(id);
    const prompt = pack?.gptPrompt || preset?.gptPrompt
      || `추천전략 ${id} 적용해줘`;
    handlePrompt(
      `${prompt}\n(현재 차트 백테스트 승률 ${pack?.winRate ?? '—'}%, ${pack?.trades ?? 0}거래. 설정을 그대로 적용하고 summary에 전략명을 적어줘.)`,
    );
  }

  function closeAiPopup() {
    aiPopupOpen = false;
    $('#strategyAiPopup')?.classList.add('hidden');
    $('#strategyAiToggleBtn')?.classList.remove('is-active');
  }

  function toggleAiPopup() {
    if (aiPopupOpen) closeAiPopup();
    else openAiPopup();
  }

  function historyStorageKey() {
    const id = typeof AppAuth !== 'undefined' ? AppAuth.getUser?.()?.id : null;
    return id ? `${HISTORY_KEY}-u${id}` : `${HISTORY_KEY}-anon`;
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(historyStorageKey());
      const parsed = JSON.parse(raw || '[]');
      conversationHistory = Array.isArray(parsed) ? parsed : [];
    } catch {
      conversationHistory = [];
    }
    conversationHistory = conversationHistory
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
      .slice(-MAX_HISTORY);
  }

  function saveHistory() {
    try {
      localStorage.setItem(historyStorageKey(), JSON.stringify(conversationHistory.slice(-MAX_HISTORY)));
    } catch {
      /* ignore quota errors */
    }
  }

  function rememberTurn(role, content, meta = null) {
    const text = String(content || '').trim();
    if (!text) return;
    const entry = { role, content: text.slice(0, 2000) };
    if (meta && typeof meta === 'object') entry.meta = meta;
    conversationHistory.push(entry);
    saveHistory();
  }

  async function syncHistoryFromServer() {
    try {
      const serverOk = await FuturesApiClient.checkServer();
      if (!serverOk) return;
      const data = await FuturesApiClient.getStrategyAiHistory();
      const serverTurns = Array.isArray(data?.turns) ? data.turns : [];
      // Replace (do not merge) so a previous account's local chat never leaks in.
      conversationHistory = serverTurns
        .filter((turn) => turn?.role && turn?.content && (turn.role === 'user' || turn.role === 'assistant'))
        .map((turn) => ({
          role: turn.role,
          content: String(turn.content).slice(0, 2000),
          ...(turn.meta && typeof turn.meta === 'object' ? { meta: turn.meta } : {}),
        }))
        .slice(-MAX_HISTORY);
      saveHistory();
      restoreHistoryToUi();
    } catch {
      conversationHistory = [];
      saveHistory();
      restoreHistoryToUi();
    }
  }

  function restoreHistoryToUi() {
    const box = $('#strategyAiMessages');
    if (!box) return;
    box.innerHTML = '';
    for (const msg of conversationHistory) {
      addMessage(msg.role, msg.content, { persist: false });
    }
  }

  function addMessage(role, text, { persist = false, meta = null } = {}) {
    const box = $('#strategyAiMessages');
    if (!box) return;

    const el = document.createElement('div');
    el.className = `ai-msg ai-msg--${role}`;
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;

    if (persist) rememberTurn(role, text, meta);
  }

  function setThinking(on, text = 'GPT가 전략을 분석하는 중...') {
    const btn = $('#strategyAiSendBtn');
    const input = $('#strategyAiInput');
    if (btn) btn.disabled = on;
    if (input) input.disabled = on;
    if (on) {
      const el = document.createElement('div');
      el.className = 'ai-msg ai-msg--assistant ai-msg--thinking';
      el.id = 'strategyAiThinking';
      el.textContent = text;
      $('#strategyAiMessages')?.appendChild(el);
    } else {
      $('#strategyAiThinking')?.remove();
    }
  }

  function formatCheckedAt(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('ko-KR');
    } catch {
      return iso;
    }
  }

  function updateKeyField(status) {
    const input = $('#openaiApiKey');
    const group = $('#openaiApiKeyGroup');
    const hint = $('#openaiApiKeyHint');
    const saveBtn = $('#strategyAiKeySaveBtn');
    const testBtn = $('#strategyAiTestBtn');
    const hosted = status?.hosted === true || status?.keySource === 'platform';

    // Platform-hosted GPT: end users never enter an OpenAI key.
    if (hosted) {
      if (group) group.classList.add('hidden');
      if (saveBtn) saveBtn.classList.add('hidden');
      if (testBtn) testBtn.classList.add('hidden');
      if (hint) {
        hint.textContent = status?.configured
          ? 'Orbinex 플랫폼 GPT를 사용합니다. 별도 API 키 입력이 필요 없습니다.'
          : '플랫폼 GPT 키가 아직 설정되지 않았습니다. 운영자에게 문의하세요.';
      }
      return;
    }

    if (group) group.classList.remove('hidden');
    if (saveBtn) saveBtn.classList.remove('hidden');
    if (testBtn) testBtn.classList.remove('hidden');
    if (!input) return;

    const configured = Boolean(status?.configured);
    const preview = status?.keyPreview;

    if (configured && preview) {
      input.value = '';
      input.placeholder = `서버에 저장됨 (${preview}) — 변경할 때만 입력`;
      if (group) group.classList.add('strategy-ai-key--saved');
      if (hint) {
        hint.textContent = '키는 서버 .env에 저장됩니다 (로컬/단일 운영 모드).';
      }
      if (saveBtn) saveBtn.textContent = '키 변경·저장';
    } else {
      input.placeholder = 'sk-proj-... (서버 .env 저장)';
      if (group) group.classList.remove('strategy-ai-key--saved');
      if (hint) {
        hint.textContent = "키는 sk-로 시작합니다. '검증 후 저장'하면 서버에 저장됩니다.";
      }
      if (saveBtn) saveBtn.textContent = '검증 후 저장';
    }
  }

  function renderDetails(status, serverOnline) {
    const el = $('#strategyAiDetails');
    if (!el) return;

    if (!serverOnline) {
      el.innerHTML = [
        '<div class="strategy-ai-detail-row"><span>API 서버</span><strong class="negative">오프라인</strong></div>',
        '<div class="strategy-ai-detail-row"><span>조치</span><strong>launch.py 또는 run-server.ps1 실행</strong></div>',
      ].join('');
      return;
    }

    const routing = status?.modelRouting || 'hybrid';
    const routingLabel = routing === 'hybrid'
      ? '하이브리드 (전략→4o, 나머지→mini)'
      : routing;

    const hosted = status?.hosted === true || status?.keySource === 'platform';
    const rows = [
      ['API 서버', '온라인'],
      ['GPT 제공', hosted ? '플랫폼 호스팅' : '직접 키 입력'],
      ['키 설정', status?.configured ? '완료' : '미설정'],
      ['키 인증', status?.authenticated ? '성공' : '실패/미검사'],
      ['GPT 호출', status?.chatReady || status?.verified ? '가능' : '불가'],
      ...(hosted ? [] : [['키 미리보기', status?.keyPreview || '—']]),
      ['모델 (기본)', status?.model || 'gpt-4o-mini'],
      ['모델 (복잡)', status?.modelComplex || 'gpt-4o'],
      ['라우팅', routingLabel],
      ['키 출처', hosted ? 'platform' : (status?.keySource || 'none')],
      ...(hosted || !status?.envPath ? [] : [['.env 경로', status.envPath]]),
      ['마지막 검사', formatCheckedAt(status?.checkedAt)],
    ];

    el.innerHTML = rows.map(([label, value]) => (
      `<div class="strategy-ai-detail-row"><span>${label}</span><strong>${value}</strong></div>`
    )).join('');

    const note = $('#strategyAiNote');
    if (note) {
      const message = status?.message || '';
      note.textContent = message;
      note.className = `strategy-ai-note ${
        status?.verified ? 'strategy-ai-note--ok' : status?.configured ? 'strategy-ai-note--warn' : 'strategy-ai-note--muted'
      }`;
    }

    updateKeyField(status);
  }

  function setStatus(status, serverOnline) {
    const el = $('#strategyAiStatus');
    if (!el) return;

    renderDetails(status, serverOnline);

    if (!serverOnline) {
      el.textContent = 'GPT: API 서버 오프라인';
      el.className = 'strategy-ai-status strategy-ai-status--offline';
      return;
    }

    if (!status?.configured) {
      el.textContent = 'GPT: API Key 미설정';
      el.className = 'strategy-ai-status strategy-ai-status--offline';
      return;
    }

    if (!status?.verified) {
      el.textContent = status?.authenticated ? 'GPT: 키 유효 · 호출 불가' : 'GPT: API Key 인증 실패';
      el.className = 'strategy-ai-status strategy-ai-status--offline';
      return;
    }

    const routing = status?.modelRouting || 'hybrid';
    const modelLine = routing === 'hybrid'
      ? `${status.model} + ${status.modelComplex || 'gpt-4o'}`
      : (status.model || 'gpt-4o-mini');
    el.textContent = `GPT: 사용 가능 (${modelLine})`;
    el.className = 'strategy-ai-status strategy-ai-status--ready';
  }

  async function refreshStatus({ verify = false } = {}) {
    const serverOk = await FuturesApiClient.checkServer();
    if (!serverOk) {
      setStatus(null, false);
      return null;
    }

    try {
      const data = await FuturesApiClient.getStrategyAiStatus(verify);
      setStatus(data, true);
      return data;
    } catch (err) {
      setStatus({ configured: false, verified: false, message: err.message }, true);
      return null;
    }
  }

  async function handlePrompt(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;

    const priorHistory = conversationHistory.slice(-20);
    const wantsStrategyApply = looksLikeStrategyApply(trimmed);
    addMessage('user', trimmed, { persist: true });
    setThinking(
      true,
      wantsStrategyApply
        ? '차트·백테스트 분석 후 전략 적용 중...'
        : 'GPT와 대화 중...',
    );

    try {
      const serverOk = await FuturesApiClient.checkServer();
      if (!serverOk) {
        addMessage('assistant', 'API 서버가 실행 중이 아닙니다. launch.py 또는 run-server.ps1을 실행해 주세요.', { persist: true });
        return;
      }

      const status = await refreshStatus({ verify: true });
      if (!status?.verified) {
        addMessage('assistant', status?.message || 'OpenAI API Key 인증에 실패했습니다. 키를 다시 저장하거나 연결 테스트를 실행하세요.', { persist: true });
        return;
      }

      const targetSlotId = $('#strategyAiTargetSlot')?.value || null;
      const current = FuturesBotApp.getFormStateForAi(targetSlotId);
      const marketContext = FuturesBotApp.getMarketContextForAi?.() || null;
      const backtestSnapshot = FuturesBotApp.getBacktestSnapshotForAi?.() || null;

      const result = await FuturesApiClient.interpretStrategy(trimmed, current, priorHistory, {
        symbol: current.symbol,
        interval: current.interval,
        marketContext,
        backtestSnapshot,
      });

      const changedFields = result.changed_fields || result.changedFields || [];
      const patch = result.patch && typeof result.patch === 'object' ? result.patch : null;
      const patchKeys = patch ? Object.keys(patch) : [];

      if (!patchKeys.length && wantsStrategyApply) {
        addMessage('assistant', formatAiError(result.summary || STRATEGY_APPLY_HINT), { persist: true });
        return;
      }

      let applyResult = { applied: false };
      if (patchKeys.length) {
        applyResult = FuturesBotApp.applyStrategySettings(result.settings, {
          rulesHtml: result.rules,
          summary: result.summary,
          changedFields,
          targetSlotId,
          patch,
        }) || { applied: false };
      }

      if (applyResult.applied === false && applyResult.reason) {
        addMessage('assistant', formatAiError(applyResult.reason), { persist: true });
        return;
      }

      if (applyResult.applied && result.chart_interval && FuturesBotApp.applyChartInterval) {
        await FuturesBotApp.applyChartInterval(result.chart_interval);
      }

      const changed = changedFields.join(', ');
      const parts = [result.summary || '응답을 받았습니다.'];
      if (result.model) {
        parts.push(`🤖 ${result.model}${result.route_reason ? ` (${result.route_reason})` : ''}`);
      }
      if (result.market_insight) parts.push(`📊 ${result.market_insight}`);
      if (result.backtest_insight) parts.push(`📈 ${result.backtest_insight}`);
      if (changed) parts.push(`(변경: ${changed})`);
      if (Array.isArray(result.sources) && result.sources.length) {
        parts.push(`🔗 출처:\n${result.sources.map((u) => `· ${u}`).join('\n')}`);
      }

      const reply = parts.filter(Boolean).join('\n');
      addMessage('assistant', reply, {
        persist: true,
        meta: {
          changed_fields: result.changed_fields || result.changedFields || [],
          backtest: backtestSnapshot?.current || null,
        },
      });
    } catch (err) {
      console.error(err);
      addMessage('assistant', formatAiError(err.message), { persist: true });
      await refreshStatus({ verify: true });
    } finally {
      setThinking(false);
    }
  }

  async function testApiKey({ fromInput = false } = {}) {
    const input = $('#openaiApiKey');
    const candidate = fromInput ? (input?.value || '').trim() : '';
    const testBtn = $('#strategyAiTestBtn');
    const saveBtn = $('#strategyAiKeySaveBtn');

    if (fromInput && !candidate) {
      addMessage('assistant', '테스트할 OpenAI API Key를 입력해 주세요.', { persist: true });
      return;
    }

    if (testBtn) testBtn.disabled = true;
    if (saveBtn) saveBtn.disabled = true;
    setThinking(true, 'OpenAI API Key 연결을 테스트하는 중...');

    try {
      const serverOk = await FuturesApiClient.checkServer();
      if (!serverOk) {
        addMessage('assistant', 'API 서버가 실행 중이 아닙니다.', { persist: true });
        return;
      }

      const result = await FuturesApiClient.testOpenAiKey(candidate || null);
      addMessage('assistant', `${result.message}\n키: ${result.keyPreview || '—'} · 모델: ${result.model}`, { persist: true });
      await refreshStatus({ verify: false });
    } catch (err) {
      addMessage('assistant', err.message || '연결 테스트에 실패했습니다.', { persist: true });
      await refreshStatus({ verify: false });
    } finally {
      setThinking(false);
      if (testBtn) testBtn.disabled = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function saveApiKey() {
    const input = $('#openaiApiKey');
    const key = (input?.value || '').trim();
    if (!key) {
      addMessage('assistant', 'OpenAI API Key를 입력해 주세요.', { persist: true });
      return;
    }

    if (!key.startsWith('sk-')) {
      addMessage('assistant', "키는 'sk-'로 시작해야 합니다. platform.openai.com/api-keys 에서 전체 키를 복사하세요.", { persist: true });
      return;
    }

    const saveBtn = $('#strategyAiKeySaveBtn');
    const testBtn = $('#strategyAiTestBtn');
    if (saveBtn) saveBtn.disabled = true;
    if (testBtn) testBtn.disabled = true;
    setThinking(true, 'OpenAI API Key를 검증하고 저장하는 중...');

    try {
      const serverOk = await FuturesApiClient.checkServer();
      if (!serverOk) {
        addMessage('assistant', 'API 서버가 실행 중이 아닙니다. launch.py 또는 run-server.ps1을 실행해 주세요.', { persist: true });
        return;
      }

      const result = await FuturesApiClient.configureOpenAiKey(key);
      if (input) input.value = '';
      addMessage(
        'assistant',
        `${result.message}\n키: ${result.keyPreview || '—'} · 모델: ${result.model}\n.env: ${result.envPath || '—'}`,
        { persist: true },
      );
      await refreshStatus({ verify: false });
    } catch (err) {
      console.error(err);
      addMessage('assistant', err.message || 'API 키 저장에 실패했습니다.', { persist: true });
      await refreshStatus({ verify: true });
    } finally {
      setThinking(false);
      if (saveBtn) saveBtn.disabled = false;
      if (testBtn) testBtn.disabled = false;
    }
  }

  async function clearHistory() {
    conversationHistory = [];
    saveHistory();
    restoreHistoryToUi();
    try {
      await FuturesApiClient.clearStrategyAiHistory();
    } catch { /* ignore */ }
    addMessage(
      'assistant',
      '대화 기록을 초기화했습니다 (브라우저 + 서버). 이전 맥락 없이 새 전략을 설명해 주세요.',
      { persist: true },
    );
  }

  function resetForAccountSwitch() {
    conversationHistory = [];
    const box = $('#strategyAiMessages');
    if (box) box.innerHTML = '';
    updateKeyField({ configured: false, keyPreview: null });
  }

  async function reloadForUser() {
    resetForAccountSwitch();
    loadHistory();
    const status = await refreshStatus({ verify: false });
    await syncHistoryFromServer();
    if (!conversationHistory.length) {
      if (status?.configured) {
        addMessage(
          'assistant',
          '플랫폼 GPT 준비됨. 전략을 입력해 주세요.',
          { persist: false },
        );
      } else {
        addMessage(
          'assistant',
          '플랫폼 GPT가 아직 없습니다. 운영자에게 문의하세요.',
          { persist: false },
        );
      }
    }
    return status;
  }

  function bindEvents() {
    $('#strategyAiKeySaveBtn')?.addEventListener('click', saveApiKey);
    $('#strategyAiTestBtn')?.addEventListener('click', () => testApiKey({ fromInput: true }));
    $('#strategyAiRetestBtn')?.addEventListener('click', () => testApiKey({ fromInput: false }));
    $('#strategyAiClearHistoryBtn')?.addEventListener('click', clearHistory);

    $('#openaiApiKey')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveApiKey();
      }
    });

    $('#strategyAiSendBtn')?.addEventListener('click', () => {
      const input = $('#strategyAiInput');
      const text = input?.value || '';
      if (input) input.value = '';
      handlePrompt(text);
    });

    $('#strategyAiInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#strategyAiSendBtn')?.click();
      }
    });

    document.querySelectorAll('[data-strategy-ai-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => handlePrompt(btn.dataset.strategyAiCmd));
    });

    $('#strategyRecommendRefresh')?.addEventListener('click', () => refreshRecommendedStrategies());
    $('#strategyRecommendList')?.addEventListener('click', (e) => {
      const applyBtn = e.target.closest('[data-rec-apply]');
      if (applyBtn) {
        applyRecommendedDirect(applyBtn.getAttribute('data-rec-apply'));
        return;
      }
      const gptBtn = e.target.closest('[data-rec-gpt]');
      if (gptBtn) applyRecommendedViaGpt(gptBtn.getAttribute('data-rec-gpt'));
    });

    $('#strategyAiToggleBtn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAiPopup();
    });
    $('#strategyAiPopupClose')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAiPopup();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && aiPopupOpen) closeAiPopup();
    });
  }

  async function init() {
    loadHistory();
    bindEvents();
    const status = await refreshStatus({ verify: true });
    await syncHistoryFromServer();

    if (conversationHistory.length) {
      restoreHistoryToUi();
    } else if (status?.configured && (status?.verified || status?.hosted)) {
      addMessage(
        'assistant',
        'Orbinex 플랫폼 GPT를 사용할 수 있습니다. 차트·백테스트 데이터를 분석해 전략을 적용합니다. API 키는 입력할 필요 없습니다.',
        { persist: false },
      );
    } else if (status?.configured) {
      addMessage(
        'assistant',
        '플랫폼 GPT 키가 설정돼 있지만 인증에 실패했습니다. 운영자에게 문의하세요.',
        { persist: false },
      );
    } else {
      addMessage(
        'assistant',
        '플랫폼 GPT가 아직 준비되지 않았습니다. 운영자가 서버에 OPENAI_API_KEY를 설정하면 바로 사용할 수 있습니다.',
        { persist: false },
      );
    }
  }

  return {
    init,
    refreshStatus,
    testApiKey,
    clearHistory,
    resetForAccountSwitch,
    reloadForUser,
    refreshRecommendedStrategies,
    handlePrompt,
  };
})();

window.StrategyAI = StrategyAI;

function bootStrategyAI() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => StrategyAI.init());
  } else {
    StrategyAI.init();
  }
}

bootStrategyAI();
