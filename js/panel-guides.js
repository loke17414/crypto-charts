/* Right-panel section guides — click "?" to open a modal. */
const PanelGuides = (() => {
  const GUIDES = {
    bot: {
      title: '봇 제어',
      body: [
        '봇 시작/정지로 자동매매를 켜고 끕니다. 서버에 연결된 경우 VPS에서도 같은 전략이 돌아갑니다.',
        '상태·자산·가용·손익은 현재 잔고와 포지션 요약입니다.',
        '수동 청산은 열린 포지션을 즉시 닫습니다. (봇 신호와 별개)',
        '봇 진입 분봉은 신호를 볼 봉 주기입니다. 차트와 다르게 두면 시작 시 차트가 그 봉으로 맞춰질 수 있습니다.',
        '모의 초기화는 브라우저 모의매매 잔고/포지션만 리셋합니다. 실거래·테스트넷 잔고는 건드리지 않습니다.',
        'Free 플랜은 주간 봇 가동 시간이 제한됩니다. 남은 시간은 계정 패널·상단 안내에서 확인하세요.',
      ],
    },
    account: {
      title: '계정',
      body: [
        'Orbinex 로그인 계정입니다. 봇·AI·결제·저장된 API 키는 이 계정에 묶입니다.',
        '회원가입 후 이메일 인증이 필요합니다. 메일이 안 오면 스팸함을 확인하세요.',
        'Free는 주간 봇 시간·AI 횟수·전략 슬롯이 제한됩니다. Pro는 봇 무제한·AI 주 100회·멀티슬롯·추천 전략이 가능합니다.',
        '요금제 · 결제에서 Toss로 Pro를 구독하거나 해지할 수 있습니다.',
      ],
    },
    api: {
      title: 'API 연결',
      body: [
        'Binance Futures API Key / Secret을 입력해 테스트넷 또는 실거래에 연결합니다.',
        '거래 환경을 키와 맞게 고르세요. 실거래 키로 테스트넷을 고르면 연결이 실패합니다.',
        '서버 IP를 Binance API 설정의 Trusted IPs에 반드시 추가하세요. (집/회사 IP가 아님)',
        '키는 계정에 암호화 저장되며, 브라우저에 평문으로 남기지 않는 것을 권장합니다.',
        '출금 권한이 없는 Futures 전용 키를 쓰는 것이 안전합니다.',
      ],
    },
    strategy: {
      title: '전략',
      body: [
        '진입 조건 슬롯에 롱/숏 규칙을 넣습니다. AI 전략 대화로 조건을 만들거나 수정할 수 있습니다.',
        'Free는 슬롯 1개까지, Pro는 여러 슬롯(멀티 조건)을 쓸 수 있습니다. + 추가가 막히면 Pro 업그레이드가 필요합니다.',
        '손절(SL)·익절(TP)은 전략/AI 설정에 따라 자동으로 잡히는 경우가 많습니다.',
        '차트 위 AI 추천 전략은 Free에서도 목록을 볼 수 있지만, 적용은 Pro에서만 가능합니다.',
      ],
    },
    risk: {
      title: '리스크 관리',
      body: [
        '1회 거래 리스크(%)는 한 번의 손절에서 감수할 계좌 비중입니다. 포지션 크기 계산에 쓰입니다.',
        '레버리지는 증거금 대비 포지션 배율입니다. 높을수록 손익 변동이 커집니다.',
        '손익비·포지션 크기 계산에는 왕복 수수료 약 0.1%가 반영됩니다.',
        '리스크를 낮게 두고 테스트넷에서 충분히 검증한 뒤 실거래를 권장합니다.',
      ],
    },
    strategyLog: {
      title: '전략 로그',
      body: [
        '캔들 패턴, BoS/CHOCH, 지표 요약 등 전략이 보는 시장 맥락이 기록됩니다.',
        '이 내용은 AI 전략 대화에도 함께 전달되어, AI가 현재 차트를 참고하게 합니다.',
        '신호가 왜 나왔는지·왜 쉬는지 확인할 때 이 로그를 보세요.',
      ],
    },
    tradeLog: {
      title: '거래 로그',
      body: [
        '봇 시작/정지, 진입·청산, 오류, API 연결 등 실행 기록이 쌓입니다.',
        '주문이 거부되거나 SL/TP가 갱신되면 여기에 이유가 표시됩니다.',
        '문제 발생 시 이 로그를 기준으로 설정을 점검하세요.',
      ],
    },
  };

  function $(sel) {
    return document.querySelector(sel);
  }

  function open(id) {
    const guide = GUIDES[id];
    if (!guide) return;
    const modal = $('#panelGuideModal');
    const title = $('#panelGuideTitle');
    const body = $('#panelGuideBody');
    if (!modal || !title || !body) return;
    title.textContent = guide.title;
    body.innerHTML = guide.body.map((p) => `<p>${p}</p>`).join('');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    $('#panelGuideClose')?.focus();
  }

  function close() {
    const modal = $('#panelGuideModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }

  function onGuideClick(e) {
    const btn = e.target.closest('[data-panel-guide]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    open(btn.getAttribute('data-panel-guide'));
  }

  function init() {
    document.querySelector('.bot-control-panel')?.addEventListener('click', onGuideClick);
    $('#panelGuideClose')?.addEventListener('click', close);
    $('#panelGuideBackdrop')?.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#panelGuideModal')?.classList.contains('hidden')) {
        close();
      }
    });
  }

  return { init, open, close };
})();

window.PanelGuides = PanelGuides;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => PanelGuides.init());
} else {
  PanelGuides.init();
}
