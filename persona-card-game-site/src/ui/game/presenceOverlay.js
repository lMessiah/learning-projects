/**
 * The connection overlays: "Opponent reconnecting…" and the turn-cap warning.
 *
 * TWO THINGS THIS FILE IS CAREFUL ABOUT.
 *
 * 1. IT DOES NOT RE-RENDER THE BOARD. `mountBoard`'s `rerender` throws away and
 *    rebuilds the entire screen, which is the right thing when the game state
 *    changes and completely the wrong thing four times a second for a ticking
 *    number. So these nodes are mounted as SIBLINGS of the board screen and
 *    update their own text in place. The board never learns that a countdown is
 *    running.
 *
 * 2. IT DOES NOT REFLOW THE BOARD. Everything here is an overlay positioned out
 *    of flow, for the same reason the log notes elsewhere in board.js: this is a
 *    fixed-viewport layout, and anything that inserts itself into the document
 *    flow mid-match shoves every tile down the screen.
 *
 * The countdowns are computed from ABSOLUTE deadlines supplied by the host, so
 * a tick that arrives late — a backgrounded tab, a long animation frame — shows
 * the right number rather than one that has drifted.
 */
import {
  TIMING,
  remainingMs,
  remainingSeconds,
  formatCountdown,
  turnWarningActive,
} from '../../net/presence.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param container  the board's parent; the overlays are appended here so that
 *                   the board rebuilding itself cannot destroy them
 * @param presence   the session: `presenceState()` and `onPresenceChange()`
 * @param controller the session again, for `getState()` — whose turn it is
 * @param viewer     which seat is looking
 */
export function mountPresenceOverlay(container, { presence, controller, viewer, timing = TIMING }) {
  if (!presence?.presenceState) return () => {};

  /* --- the reconnect overlay ------------------------------------------- */

  const overlay = el('div', 'net-pause');
  overlay.hidden = true;
  // Announced politely rather than assertively: it interrupts, but the player
  // has not lost anything yet.
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');

  const card = el('div', 'net-pause__card');
  const title = el('div', 'net-pause__title', 'Opponent reconnecting…');
  const count = el('div', 'net-pause__count', '60');
  const note = el(
    'div',
    'net-pause__note',
    'The match is paused. If they do not return, the match is awarded to you.',
  );
  card.appendChild(el('div', 'net-pause__spinner', '◐'));
  card.appendChild(title);
  card.appendChild(count);
  card.appendChild(note);
  overlay.appendChild(card);

  /* --- the turn-cap warning -------------------------------------------- */

  // Hidden for the overwhelming majority of every turn. The cap exists to stop
  // griefing; a permanent clock would pressure exactly the players it is not
  // aimed at, so nothing appears until the last thirty seconds.
  const warning = el('div', 'turn-warning');
  warning.hidden = true;
  warning.setAttribute('role', 'status');
  const warnLabel = el('span', 'turn-warning__label', 'Time to act');
  const warnCount = el('span', 'turn-warning__count', '30');
  warning.appendChild(warnLabel);
  warning.appendChild(warnCount);

  container.appendChild(overlay);
  container.appendChild(warning);

  let timer = null;

  const paint = () => {
    const state = presence.presenceState();
    const skew = state.skew ?? 0;
    const options = { skew, timing };

    /* --- reconnect --- */
    const graceLeft = remainingMs(state.graceDeadline, options);
    const linkDown = state.selfOnline === false;
    const showPause = graceLeft !== null && graceLeft > 0;

    if (showPause) {
      // Two different situations wear the same overlay, because from the
      // player's point of view they are the same situation — the match is not
      // moving — but the honest explanation differs.
      if (linkDown) {
        title.textContent = 'Reconnecting…';
        note.textContent = 'Your connection dropped. Trying to get you back into the match.';
      } else {
        title.textContent = 'Opponent reconnecting…';
        note.textContent =
          'The match is paused. If they do not return, the match is awarded to you.';
      }
      count.textContent = formatCountdown(graceLeft);
      // The last ten seconds get a visual nudge; before that the number is quiet.
      count.classList.toggle('net-pause__count--urgent', graceLeft <= 10_000);
      overlay.hidden = false;
    } else {
      overlay.hidden = true;
    }

    /* --- turn cap --- */
    const gameState = controller?.getState?.();
    const over = !gameState || gameState.winner !== null;
    // Deliberately still shown while the pause overlay is up: the turn cap does
    // not stop for a disconnect, and hiding it would misrepresent that.
    if (over || !turnWarningActive(state.turnDeadline, options)) {
      warning.hidden = true;
    } else {
      const yours =
        gameState.phase === 'starterSelect'
          ? (gameState.players?.[viewer]?.field?.length ?? 0) === 0
          : gameState.activePlayer === viewer;
      warnLabel.textContent = yours ? 'Time to act' : 'Opponent must act';
      warnCount.textContent = String(remainingSeconds(state.turnDeadline, options) ?? 0);
      warning.classList.toggle('turn-warning--yours', yours);
      warning.hidden = false;
    }
  };

  paint();
  const off = presence.onPresenceChange?.(paint) ?? (() => {});
  // Repainted on a timer as well as on change, because the deadlines themselves
  // change rarely — it is the number of seconds left that moves.
  timer = setInterval(paint, timing.TICK_MS);
  timer.unref?.();

  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    off();
    overlay.remove();
    warning.remove();
  };
}
