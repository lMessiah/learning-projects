/**
 * The knockout note — the visible half of the custom messages (ui/flair.js).
 *
 * A small box that appears for a few seconds when a Persona goes down. Two
 * things can put it on screen, and they are deliberately separate:
 *
 *   YOURS    you knocked out one of theirs, and you have written a knockout
 *            message. It is shown here and, in an online match, sent across.
 *   THEIRS   the opponent knocked out one of yours and had a message of their
 *            own. It arrives over the wire; nothing local decides to show it.
 *
 * The note carries the sender's display name, because a line of text appearing
 * on its own mid-match is a puzzle rather than a joke.
 *
 * ── Why this is an overlay and not part of the board ──────────────────────
 *
 * The same two rules presenceOverlay.js is built around, for the same reasons:
 *
 * 1. It never re-renders the board. `mountBoard`'s `rerender` throws the whole
 *    screen away and rebuilds it, which is right for a move and absurd for a
 *    fade-out.
 * 2. It never reflows the board. This is a fixed-viewport layout; anything
 *    entering the document flow mid-match shoves every tile down the page.
 *
 * So it mounts as a SIBLING of the board screen and owns its own node. The
 * unmount returned here drops the subscription, clears the timers and removes
 * the box, so a note cannot outlive the match it was sent in.
 *
 * ── What arrives from the network is not trusted ──────────────────────────
 *
 * An incoming note is whatever the peer's copy of the app chose to send, which
 * in the general case means whatever they typed into their console. It is run
 * through `cleanFlairText` before being displayed — one line, plain text, 80
 * characters — and a peer sending them faster than a person could is ignored
 * rather than allowed to strobe the screen. It is set with `textContent` and
 * has never been anything but text.
 */
import { cleanFlairText, getFlair } from '../flair.js';

/** How long a note stays up before it starts to leave. */
export const FLAIR_LINGER_MS = 3400;

/** Matches the opacity transition on `.flair-note` in board.css. */
export const FLAIR_FADE_MS = 180;

/** Notes arriving from the peer faster than this are dropped on the floor. */
export const FLAIR_MIN_GAP_MS = 1200;

const opponentOf = (seat) => (seat === 0 ? 1 : 0);

/**
 * @param container   the board's parent, so a board rebuild cannot destroy it
 * @param controller  the match: `subscribe`, `getState`, and — online only —
 *                    `sendFlair` / `onFlair`
 * @param viewer      which seat is looking; the note is written from here
 * @param now         clock seam, so tests can drive the rate limit
 * @param read        storage seam; defaults to the saved messages
 */
export function mountFlairOverlay(container, { controller, viewer, now = () => Date.now(), read = getFlair }) {
  if (!controller?.subscribe || viewer == null) return () => {};

  const note = document.createElement('div');
  note.className = 'flair-note';
  note.hidden = true;
  // Polite, not assertive: it is decoration arriving mid-match, and it must not
  // interrupt a screen reader in the middle of the move that caused it.
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const who = document.createElement('span');
  who.className = 'flair-note__who';
  const body = document.createElement('span');
  body.className = 'flair-note__text';
  note.appendChild(who);
  note.appendChild(body);
  container.appendChild(note);

  let previous = controller.getState();
  // Two timers, because leaving is two steps: fade the box out, then take the
  // node out of the layout once it has actually gone.
  let lingerTimer = null;
  let fadeTimer = null;
  let lastIncomingAt = -Infinity;

  const clearTimers = () => {
    if (lingerTimer !== null) clearTimeout(lingerTimer);
    if (fadeTimer !== null) clearTimeout(fadeTimer);
    lingerTimer = null;
    fadeTimer = null;
  };

  const hide = () => {
    lingerTimer = null;
    note.classList.remove('flair-note--in');
    fadeTimer = setTimeout(() => {
      fadeTimer = null;
      note.hidden = true;
    }, FLAIR_FADE_MS);
    fadeTimer?.unref?.();
  };

  const nameOf = (seat) => controller.getState()?.players?.[seat]?.name ?? '';

  const show = (text, seat, mine) => {
    clearTimers();
    who.textContent = nameOf(seat);
    body.textContent = text;
    note.classList.toggle('flair-note--mine', mine);
    note.classList.toggle('flair-note--theirs', !mine);
    note.hidden = false;
    // Restarted rather than left running, so a second note animates in again
    // instead of appearing fully formed. Reading offsetWidth is the flush that
    // makes the browser notice the class was ever absent.
    note.classList.remove('flair-note--in');
    void note.offsetWidth;
    note.classList.add('flair-note--in');
    lingerTimer = setTimeout(hide, FLAIR_LINGER_MS);
    lingerTimer?.unref?.();
  };

  const onState = (state, meta) => {
    const before = previous;
    previous = state;
    // A resync is not something that HAPPENED — it is the same match handed
    // over again after a reconnect. Diffing it against a view from before the
    // drop would re-announce every knockout scored while we were away.
    // board.js skips its animations for exactly the same reason.
    if (meta?.resync || !before) return;

    const foe = opponentOf(viewer);
    // The opponent's own KO counter going up is the knockout you just scored:
    // `koCount` is how many of that player's Personas have been lost.
    const scored = (state?.players?.[foe]?.koCount ?? 0) > (before?.players?.[foe]?.koCount ?? 0);
    if (!scored) return;

    const text = cleanFlairText(read()?.knockout ?? '', 'knockout');
    if (!text) return;

    show(text, viewer, true);
    // Cosmetic, so a link that has gone away must not turn into an error on a
    // screen the player is still using. Offline modes have no `sendFlair` at
    // all and simply skip this.
    try {
      controller.sendFlair?.(text);
    } catch {
      /* the note did not make it across; the match is unaffected */
    }
  };

  const unsubscribe = controller.subscribe(onState);

  // Online only. The board has no idea whether the session it was handed can do
  // this, which is the point: everything else here works the same either way.
  const offFlair = controller.onFlair?.((payload) => {
    const at = now();
    if (at - lastIncomingAt < FLAIR_MIN_GAP_MS) return;
    const text = cleanFlairText(payload?.text ?? '', 'knockout');
    if (!text) return;
    lastIncomingAt = at;
    show(text, opponentOf(viewer), false);
  });

  return () => {
    unsubscribe?.();
    offFlair?.();
    clearTimers();
    note.remove();
  };
}
