# CryptoCharts

암호화폐 실시간 차트를 보여주는 웹 대시보드입니다.

## 기능

- 시가총액 상위 30개 코인 목록
- 캔들스틱 / 라인 차트 전환
- 기간 선택: 1일, 7일, 30일, 90일, 1년
- 코인 검색
- 24시간 가격 변동, 거래량, 시가총액 표시

## 실행 방법

```powershell
.\start.ps1
```

브라우저에서 http://localhost:8080 을 엽니다.

### 자동매매 페이지

- **로컬**: http://localhost:8080/trading.html
- **배포 후**: https://crypto-charts-kr.netlify.app/trading.html

```powershell
.\deploy.ps1   # Netlify Drop용 ZIP 생성
```

## 기술 스택

- HTML / CSS / JavaScript
- [TradingView Lightweight Charts](https://www.tradingview.com/lightweight-charts/)
- [CoinGecko API](https://www.coingecko.com/en/api) (무료, API 키 불필요)

---

## 바이낸스 선물 자동매매 봇

`bot/` 폴더에 **USDT-M 무기한 선물** BTCUSDT 레버리지 자동매매 봇이 포함되어 있습니다.

### 전략

- **롱 진입**: EMA(12) 골든크로스 + RSI(14) 중립 구간
- **숏 진입**: EMA(12) 데드크로스 + RSI(14) 중립 구간
- **청산**: 반대 크로스, RSI 과매수/과매도, 손절/익절
- **레버리지**: `.env`의 `LEVERAGE` 설정 (기본 5x)

### 사전 준비

1. [Python 3.10+](https://www.python.org/downloads/) 설치
2. 테스트용 API 키 발급: [Binance Futures Testnet](https://testnet.binancefuture.com/)
3. 실거래 전 반드시 **테스트넷 + DRY RUN**으로 검증

### 실행

```powershell
.\run-bot.ps1
```

첫 실행 시 `.env.example`이 `.env`로 복사됩니다. 설정 후 다시 실행하세요.

### 주요 설정 (`.env`)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `BINANCE_TESTNET` | `true` | 선물 테스트넷 사용 |
| `DRY_RUN` | `true` | 실제 주문 없이 시뮬레이션 |
| `SYMBOL` | `BTCUSDT` | USDT-M 선물 페어 |
| `INTERVAL` | `1h` | 캔들 간격 |
| `LEVERAGE` | `5` | 레버리지 배수 |
| `MARGIN_TYPE` | `ISOLATED` | 격리(`ISOLATED`) / 교차(`CROSSED`) |
| `TRADE_MARGIN_USDT` | `20` | 1회 거래 증거금 (USDT) |
| `MAX_POSITION_USDT` | `200` | 최대 포지션 명목가 |
| `ALLOW_SHORT` | `true` | 숏 포지션 허용 |
| `STOP_LOSS_PCT` | `1.5` | 가격 변동 % 손절 (ROE ≈ ×레버리지) |
| `TAKE_PROFIT_PCT` | `3.0` | 가격 변동 % 익절 |

> 예: 5x 레버리지, `STOP_LOSS_PCT=1.5` → 가격 1.5% 하락 시 ROE 약 -7.5%

### 실거래 전환 (주의)

1. `BINANCE_TESTNET=false`
2. `DRY_RUN=false`
3. 바이낸스에서 **Futures** API 키 생성 (출금 권한 **비활성화**)
4. 격리 마진 + 낮은 레버리지로 소액 테스트

> **경고**: 레버리지 선물 거래는 원금 전액 손실 위험이 있습니다. 본인 책임 하에 사용하세요.
