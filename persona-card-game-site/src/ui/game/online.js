/**
 * Online multiplayer route.
 *
 * Peer-to-peer: one player hosts (and runs the authoritative engine), the other
 * joins. They swap two codes to connect, then the ordinary board takes over —
 * it has no idea the opponent is remote.
 */
import { DECKS } from '../../data/cards.js';
import { ARCHETYPES } from '../../data/archetypes.js';
import { renderArchetypeRow, ARCHETYPE_NOTE } from '../archetypeRow.js';
import { getProfileName } from '../profile.js';
import { applyThemeFor } from '../theme.js';
import { mountBoard } from './board.js';
import { createHostSession, createGuestSession, HOST_SEAT, GUEST_SEAT } from '../../net/onlineMatch.js';
import { createHostConnection, createGuestConnection, webrtcSupported } from '../../net/webrtc.js';
import { createResilientTransport, relayAvailable, websocketSupported } from '../../net/websocket.js';
import { END_REASON } from '../../net/presence.js';
import {
  saveHostMatch,
  loadHostMatch,
  clearHostMatch,
  rememberOutcome,
  recallOutcome,
} from '../../net/matchSave.js';
import {
  createRendezvousClient,
  generateCode,
  normaliseCode,
  isValidCode,
  CODE_LENGTH,
} from '../../net/shortcode.js';
import { getRendezvousUrl, getRelayUrl } from '../settings.js';
import { mountRotatingTip } from '../tips.js';

const DECK_SYMBOL = { p3: '🌙', p4: '🌫️', p5: '🎭' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

let teardown = null;

function cleanup() {
  stopTips();
  if (teardown) {
    teardown();
    teardown = null;
  }
}

function topbar(subtitle, onExit) {
  const bar = el('div', 'topbar');
  bar.appendChild(button('← Menu', 'btn btn--ghost', onExit));
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Online Match'));
  titles.appendChild(el('div', 'topbar__sub', subtitle));
  bar.appendChild(titles);
  return bar;
}

/** A read-only code with a copy button — the whole handshake is copy-paste. */
function codeBlock(label, code, hint) {
  const wrap = el('div', 'code-block');
  wrap.appendChild(el('span', 'code-block__label', label));

  const area = document.createElement('textarea');
  area.className = 'code-block__code';
  area.readOnly = true;
  area.rows = 4;
  area.value = code;
  area.addEventListener('focus', () => area.select());
  wrap.appendChild(area);

  const row = el('div', 'code-block__row');
  const copy = button('📋 Copy code', 'btn btn--primary', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = '✅ Copied';
    } catch {
      area.select();
      copy.textContent = 'Press Ctrl/Cmd+C';
    }
    setTimeout(() => {
      copy.textContent = '📋 Copy code';
    }, 2000);
  });
  row.appendChild(copy);
  if (hint) row.appendChild(el('span', 'code-block__hint', hint));
  wrap.appendChild(row);
  return wrap;
}

function codeInput(label, placeholder, onSubmit) {
  const wrap = el('div', 'code-block');
  wrap.appendChild(el('span', 'code-block__label', label));

  const area = document.createElement('textarea');
  area.className = 'code-block__code';
  area.rows = 4;
  area.placeholder = placeholder;
  wrap.appendChild(area);

  const row = el('div', 'code-block__row');
  const status = el('span', 'code-block__hint');
  row.appendChild(
    button('Connect', 'btn btn--primary', async () => {
      status.textContent = 'Connecting…';
      status.className = 'code-block__hint';
      try {
        await onSubmit(area.value);
      } catch (error) {
        status.textContent = error.message;
        status.className = 'code-block__hint code-block__hint--error';
      }
    })
  );
  row.appendChild(status);
  wrap.appendChild(row);
  return wrap;
}

/** The six-character code, shown big because it is meant to be read aloud. */
function shortCodeBlock(label, code, hint) {
  const wrap = el('div', 'code-block');
  wrap.appendChild(el('span', 'code-block__label', label));

  const value = el('div', 'short-code');
  for (const char of code) value.appendChild(el('span', 'short-code__char', char));
  wrap.appendChild(value);

  const row = el('div', 'code-block__row');
  const copy = button('📋 Copy', 'btn btn--primary', async () => {
    try {
      await navigator.clipboard.writeText(code);
      copy.textContent = '✅ Copied';
    } catch {
      copy.textContent = code;
    }
    setTimeout(() => {
      copy.textContent = '📋 Copy';
    }, 2000);
  });
  row.appendChild(copy);
  if (hint) row.appendChild(el('span', 'code-block__hint', hint));
  wrap.appendChild(row);
  return wrap;
}

/** Short-code entry: uppercase, forgiving of spaces and dashes. */
function shortCodeInput(label, onSubmit) {
  const wrap = el('div', 'code-block');
  wrap.appendChild(el('span', 'code-block__label', label));

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'short-code-input';
  input.placeholder = 'ABC123';
  input.maxLength = CODE_LENGTH + 4;
  input.autocapitalize = 'characters';
  input.spellcheck = false;
  wrap.appendChild(input);

  const row = el('div', 'code-block__row');
  const status = el('span', 'code-block__hint');
  const submit = async () => {
    const code = normaliseCode(input.value);
    if (!isValidCode(code)) {
      status.textContent = `A code is ${CODE_LENGTH} characters, like ABC123.`;
      status.className = 'code-block__hint code-block__hint--error';
      return;
    }
    status.textContent = 'Connecting…';
    status.className = 'code-block__hint';
    try {
      await onSubmit(code);
    } catch (error) {
      status.textContent = error.message;
      status.className = 'code-block__hint code-block__hint--error';
    }
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  row.appendChild(button('Join', 'btn btn--primary', submit));
  row.appendChild(status);
  wrap.appendChild(row);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Shareable links
 * ------------------------------------------------------------------ */

/**
 * The link a host sends their opponent.
 *
 * The code lives in the HASH rather than a query string, which matters for two
 * reasons: this is a static site with a hash router, so a path the server has
 * never heard of would 404; and a fragment is never sent to the server at all,
 * so the match code stays between the two players even in access logs.
 */
export function shareLinkFor(code, location = globalThis.location) {
  const base = `${location?.origin ?? ''}${location?.pathname ?? '/'}`;
  return `${base}#/join/${String(code).toUpperCase()}`;
}

/** The match code in a `#/join/ABC234` hash, or '' for any other route. */
export function joinCodeFromHash(hash) {
  const match = String(hash ?? '').match(/^#\/join\/([^/?]+)/);
  return match ? normaliseCode(decodeURIComponent(match[1])) : '';
}

/** A link with a copy button, shown big — this is the thing being shared. */
function linkBlock(label, link, hint) {
  const wrap = el('div', 'code-block');
  wrap.appendChild(el('span', 'code-block__label', label));

  const area = document.createElement('input');
  area.type = 'text';
  area.className = 'code-block__code code-block__code--link';
  area.readOnly = true;
  area.value = link;
  area.addEventListener('focus', () => area.select());
  wrap.appendChild(area);

  const row = el('div', 'code-block__row');
  const copy = button('🔗 Copy link', 'btn btn--primary', async () => {
    try {
      await navigator.clipboard.writeText(link);
      copy.textContent = '✅ Copied';
    } catch {
      area.select();
      copy.textContent = 'Press Ctrl/Cmd+C';
    }
    setTimeout(() => {
      copy.textContent = '🔗 Copy link';
    }, 2000);
  });
  row.appendChild(copy);
  if (hint) row.appendChild(el('span', 'code-block__hint', hint));
  wrap.appendChild(row);
  return wrap;
}

/**
 * Is a relay reachable right now?
 *
 * Probed rather than assumed, so a relay that is configured but down falls back
 * to the copy-paste handshake instead of offering a link that cannot work.
 */
async function findRelay() {
  if (!websocketSupported()) return null;
  const url = getRelayUrl();
  if (!url) return null;
  return (await relayAvailable(url)) ? url : null;
}

/**
 * Rotating tips run on the connection screens, on BOTH sides — the handshake
 * is dead time on the host's screen as well as the guest's. One timer at a
 * time; starting a new panel stops the old one, and so does leaving the route.
 */
let tipRotation = null;

function stopTips() {
  tipRotation?.stop();
  tipRotation = null;
}

function statusPanel(message, detail, { tips = true } = {}) {
  const wrap = el('div', 'net-status');
  wrap.appendChild(el('div', 'net-status__spinner', '◐'));
  wrap.appendChild(el('div', 'net-status__text', message));
  if (detail) wrap.appendChild(el('div', 'net-status__detail', detail));
  if (tips) {
    stopTips();
    tipRotation = mountRotatingTip(wrap, { seed: Date.now() });
  }
  return wrap;
}

/* ------------------------------------------------------------------ *
 * Lobby
 * ------------------------------------------------------------------ */

function renderLobby(root, { onHost, onJoin, onExit }) {
  root.innerHTML = '';
  root.appendChild(topbar('Peer to peer · no server, no account', onExit));

  const wrap = el('section', 'setup');

  // Either route is enough on its own: a relay needs only WebSockets, and the
  // peer-to-peer path needs only WebRTC. Both missing is the dead end.
  if (!webrtcSupported() && !websocketSupported()) {
    wrap.appendChild(
      el('div', 'notice notice--error',
        'This browser supports neither WebSockets nor WebRTC, so online play is unavailable. Local multiplayer and the bot still work.')
    );
    root.appendChild(wrap);
    return;
  }

  wrap.appendChild(
    el('p', 'setup__note',
      'Play someone on another machine. With a relay server running you send them a link and that is the whole handshake; otherwise your browsers connect directly and you trade codes by hand.')
  );

  const row = el('div', 'setup__row');

  const host = el('button', 'setup-card');
  host.type = 'button';
  host.dataset.role = 'host';
  host.appendChild(el('span', 'setup-card__icon', '📡'));
  host.appendChild(el('span', 'setup-card__title', 'Host a match'));
  host.appendChild(el('span', 'setup-card__desc', 'You pick both decks, send an invite code, and your machine runs the match.'));
  host.addEventListener('click', onHost);
  row.appendChild(host);

  const join = el('button', 'setup-card');
  join.type = 'button';
  join.dataset.role = 'guest';
  join.appendChild(el('span', 'setup-card__icon', '🔗'));
  join.appendChild(el('span', 'setup-card__title', 'Join a match'));
  join.appendChild(el('span', 'setup-card__desc', 'Paste the invite code you were sent and reply with your own.'));
  join.addEventListener('click', onJoin);
  row.appendChild(join);

  wrap.appendChild(row);
  wrap.appendChild(
    el('div', 'notice',
      'The host is authoritative: their copy of the rules engine decides every action, and each side is only ever sent the information it is allowed to see — you cannot read your opponent\'s hand. Because the host is also a player, this is friendly-game protection, not tournament security.')
  );
  root.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * Host flow
 * ------------------------------------------------------------------ */

function renderHostSetup(root, { onStart, onExit }) {
  const choice = {
    hostDeckId: DECKS[0].id,
    guestDeckId: DECKS[1].id,
    hostArchetype: ARCHETYPES[0].id,
    guestArchetype: ARCHETYPES[1].id,
  };
  root.innerHTML = '';
  root.appendChild(topbar('Hosting', onExit));

  const wrap = el('section', 'setup');
  wrap.appendChild(el('p', 'setup__note', 'As host you choose both decks, so your opponent knows what they are getting.'));

  for (const [key, archetypeKey, label] of [
    ['hostDeckId', 'hostArchetype', 'Your deck'],
    ['guestDeckId', 'guestArchetype', "Your opponent's deck"],
  ]) {
    wrap.appendChild(el('h2', 'setup__heading', label));
    const row = el('div', 'setup__row');
    const buttons = new Map();
    for (const deck of DECKS) {
      const node = el('button', 'setup-card');
      node.type = 'button';
      node.dataset.deckId = deck.id;
      node.appendChild(el('span', 'setup-card__icon', DECK_SYMBOL[deck.id] || '🃏'));
      node.appendChild(el('span', 'setup-card__title', deck.name));
      node.appendChild(el('span', 'setup-card__desc', deck.playstyle || deck.tagline));
      node.addEventListener('click', () => {
        choice[key] = deck.id;
        for (const [id, btn] of buttons) btn.classList.toggle('setup-card--on', id === deck.id);
      });
      buttons.set(deck.id, node);
      row.appendChild(node);
    }
    buttons.get(choice[key]).classList.add('setup-card--on');
    wrap.appendChild(row);
    wrap.appendChild(
      renderArchetypeRow({
        value: choice[archetypeKey],
        onPick: (id) => {
          choice[archetypeKey] = id;
        },
      })
    );
  }

  wrap.appendChild(el('p', 'setup__note', ARCHETYPE_NOTE));
  wrap.appendChild(button('Create invite code', 'btn btn--primary setup__start', () => onStart({ ...choice })));
  root.appendChild(wrap);
}

/** Is a rendezvous server reachable? Decides short codes vs copy-paste. */
async function findRendezvous() {
  const url = getRendezvousUrl();
  if (!url) return null;
  const client = createRendezvousClient(url);
  return (await client.available()) ? client : null;
}

/**
 * Host over the relay: generate a code, show the link, wait for someone to open
 * it. No copy-paste handshake and no second code — the relay seats both players
 * itself, so the whole flow is one link.
 */
async function runHostViaRelay(root, choice, relay, { onExit, resumeCode = '', resumeState = null }) {
  const code = resumeCode || generateCode();
  // Resilient rather than plain: the transport re-dials into the same seat when
  // the socket dies, which is what the grace period is there to give it time to
  // do. See createResilientTransport.
  const connection = createResilientTransport('host', { url: relay, code });

  let cancelled = false;
  teardown = () => {
    cancelled = true;
    connection.cancel();
  };

  root.innerHTML = '';
  root.appendChild(topbar('Hosting', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel('Opening the match room…'));
  root.appendChild(wrap);

  // Nothing is shown until the relay confirms the room exists. A link built
  // from a code the relay refused looks identical to one that works.
  try {
    await connection.joined;
  } catch (error) {
    if (cancelled) return;
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'notice notice--error', error.message));
    wrap.appendChild(button('Try again', 'btn', () => runHost(root, choice, { onExit })));
    return;
  }
  if (cancelled) return;

  wrap.innerHTML = '';
  wrap.appendChild(el('h2', 'setup__heading', 'Send your opponent this link'));
  wrap.appendChild(linkBlock('Match link', shareLinkFor(code), 'Opening it drops them straight into the match.'));
  wrap.appendChild(
    el('p', 'setup__note', 'If a link is awkward to send, they can pick Join a match and type this code instead:')
  );
  wrap.appendChild(shortCodeBlock('Match code', code));
  const waiting = statusPanel('Waiting for them to join…', 'The match starts by itself the moment they do.');
  wrap.appendChild(waiting);

  try {
    await connection.connected;
    if (cancelled) return;
    startOnlineMatch(root, {
      transport: connection.transport,
      role: 'host',
      choice,
      onExit,
      code,
      resumeState,
    });
  } catch (error) {
    if (cancelled) return;
    waiting.remove();
    wrap.appendChild(el('div', 'notice notice--error', error.message));
    wrap.appendChild(button('Try again', 'btn', () => runHost(root, choice, { onExit })));
  }
}

async function runHost(root, choice, { onExit }) {
  root.innerHTML = '';
  root.appendChild(topbar('Hosting', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel('Preparing your code…', 'Gathering connection details. This takes a few seconds.'));
  root.appendChild(wrap);

  // A relay gives the simplest flow there is — one link — so it is tried first.
  // Everything below is the peer-to-peer path, unchanged, for when there is no
  // relay to be had.
  const relay = await findRelay();
  if (relay) {
    await runHostViaRelay(root, choice, relay, { onExit });
    return;
  }

  let connection;
  let rendezvous;
  try {
    [connection, rendezvous] = await Promise.all([createHostConnection(), findRendezvous()]);
  } catch (error) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'notice notice--error', `Could not start hosting: ${error.message}`));
    return;
  }

  let cancelled = false;
  teardown = () => {
    cancelled = true;
    connection.cancel();
  };

  const begin = async (replyCode) => {
    const transport = await connection.accept(replyCode);
    startOnlineMatch(root, { transport, role: 'host', choice, onExit });
  };

  wrap.innerHTML = '';

  if (rendezvous) {
    // Short-code mode: the server holds the blobs, the players trade six characters.
    let code;
    try {
      code = await rendezvous.publishOffer(connection.code);
    } catch (error) {
      wrap.appendChild(el('div', 'notice notice--error', `Could not reach the rendezvous server: ${error.message}`));
      return;
    }

    wrap.appendChild(el('h2', 'setup__heading', 'Give your opponent this code'));
    wrap.appendChild(shortCodeBlock('Match code', code, 'Valid for 10 minutes.'));
    const waiting = statusPanel('Waiting for them to join…', 'The match starts by itself the moment they do.');
    wrap.appendChild(waiting);

    try {
      const reply = await rendezvous.waitForAnswer(code);
      if (cancelled) return;
      waiting.remove();
      wrap.appendChild(statusPanel('They joined. Connecting…'));
      await begin(reply);
    } catch (error) {
      if (cancelled) return;
      waiting.remove();
      wrap.appendChild(el('div', 'notice notice--error', error.message));
    }
    return;
  }

  // Serverless fallback: the full connection details, pasted by hand.
  wrap.appendChild(
    el('div', 'notice',
      'No rendezvous server is configured, so this is the direct handshake: the code below IS the connection detail, which is why it is long. Set a rendezvous server in Settings → Online for six-character codes instead.')
  );
  wrap.appendChild(el('h2', 'setup__heading', 'Step 1 — send this to your opponent'));
  wrap.appendChild(codeBlock('Invite code', connection.code, 'Any chat will do. It contains no personal information.'));
  wrap.appendChild(el('h2', 'setup__heading', 'Step 2 — paste their reply'));
  wrap.appendChild(codeInput('Reply code', 'Paste the code they send back…', begin));
}

/* ------------------------------------------------------------------ *
 * Guest flow
 * ------------------------------------------------------------------ */

/**
 * Join over the relay. Reached two ways: by opening a shared link (the code
 * comes from the URL and this runs immediately), or by typing a code in the
 * lobby. Both land here.
 */
async function runJoinViaRelay(root, code, relay, { onExit, onFallback }) {
  root.innerHTML = '';
  root.appendChild(topbar('Joining', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel(`Joining match ${code}…`, 'Connecting to your opponent.'));
  root.appendChild(wrap);

  const connection = createResilientTransport('guest', { url: relay, code });
  let cancelled = false;
  teardown = () => {
    cancelled = true;
    connection.cancel();
  };

  try {
    await connection.connected;
    if (cancelled) return;
    startOnlineMatch(root, { transport: connection.transport, role: 'guest', onExit, code });
  } catch (error) {
    if (cancelled) return;

    // The room being gone is exactly what a player sees when they come back to
    // a match that finished without them. If this browser watched it end, say
    // how it ended instead of reporting a dead code.
    const outcome = recallOutcome(code);
    if (outcome) {
      renderMatchEnded(root, { outcome, code, onExit });
      return;
    }

    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'notice notice--error', error.message));
    wrap.appendChild(
      el('p', 'setup__note', 'Match links are good for as long as the host keeps the page open. Ask them for a fresh one.')
    );
    wrap.appendChild(button('Back to online menu', 'btn btn--primary', onFallback ?? onExit));
  }
}

async function renderJoin(root, { onExit }) {
  root.innerHTML = '';
  root.appendChild(topbar('Joining', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel('Looking for a server…'));
  root.appendChild(wrap);

  // The relay path takes a code and nothing else, so it is offered first.
  const relay = await findRelay();
  if (relay) {
    wrap.innerHTML = '';
    wrap.appendChild(
      el('p', 'setup__note', 'Open the link your opponent sent you, or type the six-character code here.')
    );
    wrap.appendChild(
      shortCodeInput('Match code', async (code) => {
        await runJoinViaRelay(root, code, relay, { onExit, onFallback: () => renderJoin(root, { onExit }) });
      })
    );
    return;
  }

  const rendezvous = await findRendezvous();
  wrap.innerHTML = '';

  /** Shared tail of both paths: swap descriptions and hand over to the board. */
  const finish = async (inviteBlob, publishReply) => {
    const connection = await createGuestConnection(inviteBlob);
    teardown = () => connection.cancel();

    wrap.innerHTML = '';
    await publishReply(connection.code, wrap);

    const transport = await connection.connected;
    startOnlineMatch(root, { transport, role: 'guest', onExit });
  };

  if (rendezvous) {
    wrap.appendChild(el('p', 'setup__note', 'Type the six-character code your opponent gave you.'));
    wrap.appendChild(
      shortCodeInput('Match code', async (code) => {
        const invite = await rendezvous.fetchOffer(code);
        await finish(invite, async (reply, host) => {
          await rendezvous.publishAnswer(code, reply);
          host.appendChild(statusPanel('Joined. Waiting for the host…', 'Keep this tab open.'));
        });
      })
    );
    return;
  }

  wrap.appendChild(
    el('div', 'notice',
      'No rendezvous server is configured, so this is the direct handshake. Set one in Settings → Online for six-character codes.')
  );
  wrap.appendChild(el('p', 'setup__note', 'Paste the invite code your opponent sent you. The host chooses both decks.'));
  wrap.appendChild(
    codeInput('Invite code', 'Paste the invite code you were sent…', async (value) => {
      await finish(value, async (reply, host) => {
        host.appendChild(el('h2', 'setup__heading', 'Send this back to the host'));
        host.appendChild(codeBlock('Reply code', reply, 'The match starts the moment they paste it.'));
        host.appendChild(statusPanel('Waiting for the host…', 'Keep this tab open.'));
      });
    })
  );
}

/* ------------------------------------------------------------------ *
 * The match
 * ------------------------------------------------------------------ */

/**
 * The screen for a match that is already over by the time you get here.
 *
 * Reached by a player who was away when the match resolved — their connection
 * died, or they closed the tab, and by the time they came back the grace period
 * had expired or the host had gone. Without this they would meet "that match
 * code is unknown or has expired", which is true and tells them nothing about
 * the match they were in the middle of.
 */
function renderMatchEnded(root, { outcome, code, onExit }) {
  root.innerHTML = '';
  root.appendChild(topbar('Match over', onExit));

  const wrap = el('section', 'setup');
  const won = outcome?.winner != null && outcome.winner === outcome.seat;

  wrap.appendChild(el('h2', 'setup__heading', won ? 'You won that match' : 'That match is over'));

  const reasons = {
    [END_REASON.DISCONNECT]: won
      ? 'Your opponent did not reconnect in time, so the match was awarded to you.'
      : 'You did not reconnect in time, so the match was awarded to your opponent.',
    [END_REASON.TIMEOUT_FORFEIT]: won
      ? 'Your opponent ran out of time too many times and forfeited.'
      : 'You ran out of time too many times and forfeited the match.',
  };
  wrap.appendChild(
    el(
      'p',
      'setup__note',
      reasons[outcome?.reason] ??
        (won ? 'You won.' : 'It finished while you were away.'),
    ),
  );

  if (code) wrap.appendChild(el('p', 'setup__note', `Match ${String(code).toUpperCase()}.`));

  wrap.appendChild(button('Back to the menu', 'btn btn--primary setup__start', onExit));
  root.appendChild(wrap);
}

/**
 * Record how a match finished, on BOTH sides, the moment it does.
 *
 * This is what makes the screen above possible: whichever player reloads later
 * is the one who needs it, and neither knows in advance which that will be.
 */
function watchForOutcome(session, { code, seat }) {
  if (!code) return () => {};
  let recorded = false;
  return session.subscribe((state) => {
    if (recorded || !state || state.winner == null) return;
    recorded = true;
    rememberOutcome({
      code,
      winner: state.winner,
      seat,
      reason: state.endReason,
      names: state.players?.map((player) => player.name) ?? null,
    });
  });
}

function startOnlineMatch(root, { transport, role, choice, onExit, code = '', resumeState = null }) {
  const name = getProfileName();
  const isHost = role === 'host';

  const session = isHost
    ? createHostSession(transport, {
        hostName: name,
        guestName: 'Opponent',
        hostDeckId: choice.hostDeckId,
        guestDeckId: choice.guestDeckId,
        hostArchetype: choice.hostArchetype,
        guestArchetype: choice.guestArchetype,
        seed: Math.floor(Date.now() % 2147483647) || 1,
        resumeState,
        // Written after every action so a reload can pick the match back up.
        // The host holds the only authoritative state; losing it loses the match.
        onPersist: (state) =>
          saveHostMatch({ state, code, token: transport.token ?? '' }),
      })
    : createGuestSession(transport, { name });

  applyThemeFor({ deckId: isHost ? choice?.hostDeckId : null });

  const seat = isHost ? HOST_SEAT : GUEST_SEAT;
  let unmount = null;

  const offOutcome = watchForOutcome(session, { code, seat });

  const mount = () => {
    if (unmount) return;
    stopTips(); // the waiting is over; nothing left to read tips on
    unmount = mountBoard(root, {
      controller: session,
      viewer: seat,
      title: 'Online Match',
      subtitle: isHost ? 'You are hosting' : 'Connected to host',
      onExit,
      // Drives the reconnect overlay and the turn-cap countdown. The board
      // itself stays unaware of either.
      presence: session,
    });
  };

  // The guest has no state until the host's first update lands.
  if (session.getState()) mount();
  else {
    root.innerHTML = '';
    root.appendChild(topbar('Connected', onExit));
    const wrap = el('section', 'setup');
    wrap.appendChild(statusPanel('Connected. Waiting for the host to deal…'));
    root.appendChild(wrap);
    const off = session.subscribe(() => {
      off();
      mount();
    });
  }

  session.onError((message) => {
    const toast = el('div', 'toast', message);
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  });

  session.start();

  teardown = () => {
    offOutcome();
    unmount?.();
    session.destroy();
    // Leaving on purpose ends the match for good; there is nothing to come back
    // to, so the save is dropped rather than offered on the next visit.
    if (isHost) clearHostMatch();
  };
}

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

/**
 * Offer a match back to a host whose page reloaded mid-game.
 *
 * The authoritative state is in storage (see matchSave.js) and the relay is
 * holding the seat, so this is genuinely resumable — but only for as long as
 * both of those remain true, which is why the save carries its own expiry.
 */
async function offerHostResume(root, saved, { onExit, onDecline }) {
  root.innerHTML = '';
  root.appendChild(topbar('Resume match', onExit));

  const wrap = el('section', 'setup');

  if (saved.resolved) {
    // Nothing to resume — but they should still see how it ended.
    clearHostMatch();
    renderMatchEnded(
      root,
      {
        outcome: { winner: saved.state.winner, seat: HOST_SEAT, reason: saved.state.endReason },
        code: saved.code,
        onExit,
      },
    );
    return;
  }

  wrap.appendChild(el('h2', 'setup__heading', 'You were hosting a match'));
  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'This page reloaded while a match was running. Your opponent may still be waiting — rejoining puts the match back exactly where it was.',
    ),
  );
  wrap.appendChild(shortCodeBlock('Match code', saved.code));

  const row = el('div', 'code-block__row');
  row.appendChild(
    button('Rejoin the match', 'btn btn--primary', async () => {
      const relay = await findRelay();
      if (!relay) {
        wrap.appendChild(
          el('div', 'notice notice--error', 'No relay is reachable, so the match cannot be rejoined.'),
        );
        return;
      }
      await runHostViaRelay(root, {}, relay, {
        onExit,
        resumeCode: saved.code,
        resumeState: saved.state,
      });
    }),
  );
  row.appendChild(
    button('Give it up', 'btn btn--ghost', () => {
      clearHostMatch();
      onDecline();
    }),
  );
  wrap.appendChild(row);
  root.appendChild(wrap);
}

export function renderOnline(root, { joinCode = '' } = {}) {
  cleanup();
  const goMenu = () => {
    cleanup();
    window.location.hash = '#/';
  };

  const lobby = () => {
    cleanup();
    // Arriving from a link puts the code in the hash; going back to the lobby
    // has to clear it, or the next hashchange would rejoin the same match.
    if (joinCodeFromHash(window.location.hash)) window.location.hash = '#/online';
    renderLobby(root, {
      onExit: goMenu,
      onHost: () =>
        renderHostSetup(root, {
          onExit: lobby,
          onStart: (choice) => runHost(root, choice, { onExit: goMenu }),
        }),
      onJoin: () => renderJoin(root, { onExit: lobby }),
    });
  };

  // A shared link skips the lobby entirely: the code is the whole decision.
  if (joinCode) {
    joinByLink(root, joinCode, { onExit: goMenu, onFallback: lobby });
    return;
  }

  // A host who reloaded mid-match is asked before anything else, because the
  // window in which their opponent is still waiting is a short one.
  const saved = loadHostMatch();
  if (saved) {
    offerHostResume(root, saved, { onExit: goMenu, onDecline: lobby });
    return;
  }

  lobby();
}

/** The `#/join/CODE` entry point: probe for the relay, then connect. */
async function joinByLink(root, code, { onExit, onFallback }) {
  root.innerHTML = '';
  root.appendChild(topbar('Joining', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel('Opening the match link…'));
  root.appendChild(wrap);

  if (!isValidCode(code)) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'notice notice--error', `"${code}" is not a valid match code.`));
    wrap.appendChild(button('Back to online menu', 'btn btn--primary', onFallback));
    return;
  }

  // Reopening the link to a match this browser already saw finish. Answer with
  // the result rather than dialling a room that is certainly gone.
  const finished = recallOutcome(code);
  if (finished) {
    renderMatchEnded(root, { outcome: finished, code, onExit });
    return;
  }

  const relay = await findRelay();
  if (!relay) {
    wrap.innerHTML = '';
    wrap.appendChild(
      el('div', 'notice notice--error',
        'This match link needs a relay server, and none is reachable. If you are running the game locally, start it with "npm run relay" and set the address in Settings → Online.')
    );
    wrap.appendChild(button('Back to online menu', 'btn btn--primary', onFallback));
    return;
  }

  await runJoinViaRelay(root, code, relay, { onExit, onFallback });
}
