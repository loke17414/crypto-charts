/* AI Assistant UI + voice input */
const AIAssistant = (() => {
  let panelOpen = false;
  let listening = false;
  let recognition = null;

  const $ = (sel) => document.querySelector(sel);

  function initSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const r = new SR();
    r.lang = 'ko-KR';
    r.interimResults = false;
    r.maxAlternatives = 1;
    return r;
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text.replace(/[📊📈💰🔍⚠️🤖·]/g, '').slice(0, 200));
    u.lang = 'ko-KR';
    u.rate = 1.1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  function addMessage(role, text) {
    const box = $('#aiMessages');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `ai-msg ai-msg--${role}`;
    el.textContent = text;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function setThinking(on) {
    const btn = $('#aiSendBtn');
    const input = $('#aiInput');
    if (btn) btn.disabled = on;
    if (input) input.disabled = on;
    if (on) {
      const el = document.createElement('div');
      el.className = 'ai-msg ai-msg--assistant ai-msg--thinking';
      el.id = 'aiThinking';
      el.textContent = '생각 중...';
      $('#aiMessages')?.appendChild(el);
    } else {
      $('#aiThinking')?.remove();
    }
  }

  async function handleInput(text, { voice = false } = {}) {
    const trimmed = (text || '').trim();
    if (!trimmed) return;
    if (typeof GuestGate !== 'undefined' && !GuestGate.requireLogin('AI 어시스턴트')) return;

    addMessage('user', trimmed);
    setThinking(true);

    try {
      const result = await AICommands.run(trimmed);
      addMessage('assistant', result.message);
      if (voice && result.ok) speak(result.message.split('\n')[0]);
    } catch (err) {
      console.error(err);
      addMessage('assistant', '오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      setThinking(false);
    }
  }

  function togglePanel(open) {
    panelOpen = open ?? !panelOpen;
    const panel = $('#aiPanel');
    const btn = $('#aiToggleBtn');
    if (panel) panel.classList.toggle('ai-panel--open', panelOpen);
    if (btn) btn.classList.toggle('ai-toggle-btn--active', panelOpen);
    if (panelOpen) $('#aiInput')?.focus();
  }

  function toggleVoice() {
    if (!recognition) {
      recognition = initSpeech();
      if (!recognition) {
        addMessage('assistant', '이 브라우저는 음성 인식을 지원하지 않습니다. Chrome을 사용해 보세요.');
        return;
      }
      recognition.onresult = (e) => {
        const text = e.results[0][0].transcript;
        $('#aiInput').value = text;
        handleInput(text, { voice: true });
      };
      recognition.onerror = () => {
        listening = false;
        $('#aiVoiceBtn')?.classList.remove('ai-voice--active');
      };
      recognition.onend = () => {
        listening = false;
        $('#aiVoiceBtn')?.classList.remove('ai-voice--active');
      };
    }

    if (listening) {
      recognition.stop();
      return;
    }

    listening = true;
    $('#aiVoiceBtn')?.classList.add('ai-voice--active');
    recognition.start();
  }

  function bindEvents() {
    $('#aiToggleBtn')?.addEventListener('click', () => togglePanel());
    $('#aiPanelClose')?.addEventListener('click', () => togglePanel(false));

    $('#aiSendBtn')?.addEventListener('click', () => {
      const input = $('#aiInput');
      const text = input?.value || '';
      input.value = '';
      handleInput(text);
    });

    $('#aiInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        $('#aiSendBtn')?.click();
      }
    });

    $('#aiVoiceBtn')?.addEventListener('click', toggleVoice);

    document.querySelectorAll('[data-ai-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => handleInput(btn.dataset.aiCmd));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        togglePanel(true);
      }
    });
  }

  function init() {
    bindEvents();
    addMessage('assistant',
      '안녕하세요! 저는 CryptoCharts AI 어시스턴트입니다.\n\n'
      + '말하거나 글로 명령하면 지표를 자동으로 표시하고, 모의매매를 실행합니다.\n'
      + '예: "MACD랑 RSI 켜줘", "비트코인 1시간봉", "지금 상황 분석해줘", "100달러 매수"\n\n'
      + '⚠️ 매매는 모의거래입니다. 실제 바이낸스 주문은 실행되지 않습니다.\n'
      + '도움말은 "도움말"을 입력하세요. 단축키: /'
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { handleInput, togglePanel };
})();
