'use strict';

/*
 * Entry-gate module — SINGLE owner of bot-entry-gate.json on the bot side.
 *
 * The gate file is written by the Python API (bot/server_bot.py
 * pause_bot_entry) when the user closes a position manually from the UI.
 * This module is the only bot-js code that reads/expires/deletes it, so
 * future edits to bot.js cannot accidentally change gate semantics.
 *
 * Gate payload: { pausedUntil, reason, blockedBarTime?, blockedSignal? }
 *  - pausedUntil    : ms epoch — hard pause for ALL entries until this time
 *  - reason         : 'manual_close' | 'external_close'
 *  - blockedBarTime : bar the manual close happened on — same bar + same
 *                     signal stays blocked even after pausedUntil passes
 *  - blockedSignal  : 'LONG' | 'SHORT'
 */

const fs = require('fs');

function createEntryGate({ gateFile, log = () => {} }) {
  function read() {
    try {
      if (!fs.existsSync(gateFile)) return null;
      return JSON.parse(fs.readFileSync(gateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function clear() {
    try {
      if (fs.existsSync(gateFile)) fs.unlinkSync(gateFile);
    } catch { /* ignore */ }
  }

  /**
   * Milliseconds-epoch until which ALL entries are paused (0 = not paused).
   * Deletes the file once it can no longer block anything.
   */
  function pausedUntil(nowMs = Date.now()) {
    const gate = read();
    if (!gate) return 0;
    const until = Number(gate.pausedUntil) || 0;
    if (until > nowMs) return until;
    // Expired. Keep manual_close gates only while the blocked bar is still
    // possibly forming — the same-bar/same-signal check needs the payload.
    if (gate.reason !== 'manual_close' || !gate.blockedBarTime) clear();
    return 0;
  }

  /**
   * True when a manual close on THIS bar blocks re-entering the SAME signal.
   * Clears the gate file once the block no longer applies.
   */
  function isManualReentryBlocked(signal, barTime, nowMs = Date.now()) {
    const gate = read();
    if (!gate || gate.reason !== 'manual_close') return false;

    if ((Number(gate.pausedUntil) || 0) > nowMs) return true;

    const blockedBar = Number(gate.blockedBarTime) || 0;
    if (
      blockedBar > 0
      && barTime === blockedBar
      && gate.blockedSignal
      && signal === gate.blockedSignal
    ) {
      return true;
    }

    clear();
    log('수동 청산 재진입 보류 해제 — 봉 종료/신호 변경', 'DEBUG');
    return false;
  }

  return { read, clear, pausedUntil, isManualReentryBlocked };
}

module.exports = { createEntryGate };
