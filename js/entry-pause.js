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
   * True when the manual-close block still applies to this signal/bar.
   * Clears itself once the bar has moved on or a different signal appears.
   */
  function isBlocked(signal, barTime, nowMs = Date.now()) {
    if (!manualBlock) return false;
    if (nowMs >= manualBlock.until && barTime !== manualBlock.barTime) {
      manualBlock = null;
      return false;
    }
    if (nowMs < manualBlock.until) return true;
    if (
      (signal === 'LONG' || signal === 'SHORT')
      && signal === manualBlock.signal
      && barTime === manualBlock.barTime
    ) {
      return true;
    }
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
