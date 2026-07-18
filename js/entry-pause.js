/* Entry-pause module — SINGLE owner of the browser-side auto-entry pause state.
 *
 * Owns two pieces of state that used to live as loose variables inside
 * futures-bot-app.js (autoEntryPausedUntil + manualCloseBlock). Every gate
 * decision goes through this module so future edits to the bot app cannot
 * accidentally overwrite or duplicate pause logic.
 *
 * Pure state — no DOM access, no logging, no network. The bot app decides
 * what to log and when to call.
 */
const EntryPause = (() => {
  // Hard pause: all auto entries blocked until this ms-epoch.
  let pausedUntilMs = 0;
  // Manual-close block: same bar + same signal stays blocked even after the
  // hard pause expires (prevents instant re-entry into the trade just closed).
  let manualBlock = null; // { barTime, signal, until }

  function pauseUntil(ms) {
    if (Number.isFinite(ms) && ms > pausedUntilMs) pausedUntilMs = ms;
    return pausedUntilMs;
  }

  function isPaused(nowMs = Date.now()) {
    return nowMs < pausedUntilMs;
  }

  function blockManualClose({ barTime, signal, until }) {
    manualBlock = { barTime, signal, until };
    pauseUntil(until);
  }

  function getBlock() {
    return manualBlock;
  }

  /**
   * True when the manual-close block still applies.
   * - While hard pause is active: block ALL entry signals.
   * - After hard pause: still block the same signal on the same bar.
   * Clears itself once the bar has moved on (or a different signal appears
   * after the hard pause).
   */
  function isBlocked(signal, barTime, nowMs = Date.now()) {
    if (!manualBlock) return false;

    // Hard pause window — block every direction so a flip-flop signal cannot
    // reopen immediately after the user closed.
    if (nowMs < manualBlock.until) return true;

    // Pause expired. Drop the block once we are on a newer bar.
    if (barTime != null && barTime !== manualBlock.barTime) {
      manualBlock = null;
      pausedUntilMs = 0;
      return false;
    }

    // Same bar still forming: keep blocking the closed-side signal.
    if (
      (signal === 'LONG' || signal === 'SHORT')
      && signal === manualBlock.signal
      && (barTime == null || barTime === manualBlock.barTime)
    ) {
      return true;
    }

    // Same bar but opposite / no signal — release.
    manualBlock = null;
    return false;
  }

  function clear() {
    pausedUntilMs = 0;
    manualBlock = null;
  }

  return { pauseUntil, isPaused, blockManualClose, getBlock, isBlocked, clear };
})();

window.EntryPause = EntryPause;
