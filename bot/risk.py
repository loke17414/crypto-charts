"""Position sizing from max loss as % of account equity."""



from __future__ import annotations





def calc_trade_margin(

    equity: float,

    *,

    risk_per_trade_pct: float,

    leverage: int,

    stop_loss_pct: float,

    min_margin: float = 5.0,

) -> float:

    """

    Size margin so that hitting stop-loss loses at most risk_per_trade_pct of equity.



    loss_at_sl = margin * leverage * (stop_loss_pct / 100)

    target loss = equity * (risk_per_trade_pct / 100)

    """

    if equity <= 0 or stop_loss_pct <= 0 or leverage <= 0 or risk_per_trade_pct <= 0:

        return min_margin



    margin = equity * risk_per_trade_pct / (leverage * stop_loss_pct)

    margin = min(margin, equity * 0.95)

    return max(round(margin, 2), min_margin)





def is_account_loss_limit_hit(

    equity: float,

    reference_equity: float,

    max_account_loss_pct: float,

) -> bool:

    if reference_equity <= 0 or max_account_loss_pct <= 0:

        return False

    drawdown_pct = ((reference_equity - equity) / reference_equity) * 100

    return drawdown_pct >= max_account_loss_pct

