/* GPT-powered natural language strategy editor (trading page) */

const StrategyAI = (() => {
  const HISTORY_KEY = 'crypto-charts-strategy-ai-history';
  const MAX_HISTORY = 24;

  const $ = (sel) => document.querySelector(sel);

  let conversationHistory = [];

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
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
      localStorage.setItem(HISTORY_KEY, JSON.stringify(conversationHistory.slice(-MAX_HISTORY)));
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
      if (!serverTurns.length) return;

      const merged = [...conversationHistory];
      for (const turn of serverTurns) {
        if (!turn?.role || !turn?.content) continue;
        const exists = merged.some((m) => m.role === turn.role && m.content === turn.content);
        if (!exists) merged.push({ role: turn.role, content: turn.content, meta: turn.meta });
      }
      conversationHistory = merged.slice(-MAX_HISTORY);
      saveHistory();
      restoreHistoryToUi();
    } catch {
      /* ignore */
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
    if (!input) return;

    const configured = Boolean(status?.configured);
    const preview = status?.keyPreview;

    if (configured && preview) {
      input.value = '';
      input.placeholder = `서버에 저장됨 (${preview}) — 변경할 때만 입력`;
      if (group) group.classList.add('strategy-ai-key--saved');
      if (hint) {
        hint.textContent = '키는 서버 .env에 저장됩니다. PC·브라우저를 바꿔도 다시 입력할 필요 없습니다.';
      }
      if (saveBtn) saveBtn.textContent = '키 변경·저장';
    } else {
      input.placeholder = 'sk-proj-... (최초 1회 입력 → 서버 .env 저장)';
      if (group) group.classList.remove('strategy-ai-key--saved');
      if (hint) {
        hint.textContent = "키는 sk-로 시작합니다. '검증 후 저장'하면 서버에 영구 저장됩니다.";
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

    const rows = [
      ['API 서버', '온라인'],
      ['키 설정', status?.configured ? '완료' : '미설정'],
      ['키 인증', status?.authenticated ? '성공' : '실패/미검사'],
      ['GPT 호출', status?.chatReady || status?.verified ? '가능' : '불가'],
      ['키 미리보기', status?.keyPreview || '—'],
      ['모델', status?.model || 'gpt-4o-mini'],
      ['키 출처', status?.keySource || 'none'],
      ['.env 경로', status?.envPath || '—'],
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

    el.textContent = `GPT: 사용 가능 (${status.model})`;
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
    addMessage('user', trimmed, { persist: true });
    setThinking(true, '차트·백테스트 데이터 분석 후 GPT 전략 적용 중...');

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

      const current = FuturesBotApp.getFormStateForAi();
      const marketContext = FuturesBotApp.getMarketContextForAi?.() || null;
      const backtestSnapshot = FuturesBotApp.getBacktestSnapshotForAi?.() || null;

      const result = await FuturesApiClient.interpretStrategy(trimmed, current, priorHistory, {
        symbol: current.symbol,
        interval: current.interval,
        marketContext,
        backtestSnapshot,
      });

      const changedFields = result.changed_fields || result.changedFields || [];

      // Question/research mode returns an answer without touching settings —
      // applying would needlessly recompute the backtest and spam logs.
      if (changedFields.length) {
        FuturesBotApp.applyStrategySettings(result.settings, {
          rulesHtml: result.rules,
          summary: result.summary,
          changedFields,
        });
      }

      const changed = changedFields.join(', ');
      const parts = [result.summary];
      if (result.market_insight) parts.push(`📊 ${result.market_insight}`);
      if (result.backtest_insight) parts.push(`📈 ${result.backtest_insight}`);
      if (changed) parts.push(`(변경: ${changed})`);
      if (Array.isArray(result.sources) && result.sources.length) {
        parts.push(`🔗 출처:\n${result.sources.map((u) => `· ${u}`).join('\n')}`);
      }

      const reply = parts.join('\n');
      addMessage('assistant', reply, {
        persist: true,
        meta: {
          changed_fields: result.changed_fields || result.changedFields || [],
          backtest: backtestSnapshot?.current || null,
        },
      });
    } catch (err) {
      console.error(err);
      addMessage('assistant', err.message || '전략 적용에 실패했습니다. 다시 시도해 주세요.', { persist: true });
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
  }

  async function init() {
    loadHistory();
    bindEvents();
    const status = await refreshStatus({ verify: true });
    await syncHistoryFromServer();

    if (conversationHistory.length) {
      restoreHistoryToUi();
    } else if (status?.configured && status?.verified) {
      addMessage(
        'assistant',
        `서버에 OpenAI 키가 저장되어 있습니다 (${status.keyPreview}). 차트·백테스트 데이터를 분석해 전략을 적용합니다. 이전 대화는 서버에 기억됩니다.`,
        { persist: false },
      );
    } else if (status?.configured) {
      addMessage(
        'assistant',
        `서버에 키가 있지만 인증에 실패했습니다. '저장된 키 재검사'를 누르거나 키를 다시 저장하세요.`,
        { persist: false },
      );
    } else {
      addMessage(
        'assistant',
        '1) OpenAI API Key 입력 → 2) 검증 후 저장 (서버 .env에 1회 저장) → 3) 전략을 자연어로 설명하세요.\n이후에는 키를 다시 입력할 필요 없습니다.',
        { persist: true },
      );
    }
  }

  return { init, refreshStatus, testApiKey, clearHistory };
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
