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
import { createRendezvousClient, normaliseCode, isValidCode, CODE_LENGTH } from '../../net/shortcode.js';
import { getRendezvousUrl } from '../settings.js';
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

  if (!webrtcSupported()) {
    wrap.appendChild(
      el('div', 'notice notice--error',
        'This browser does not support WebRTC, so online play is unavailable. Local multiplayer and the bot still work.')
    );
    root.appendChild(wrap);
    return;
  }

  wrap.appendChild(
    el('p', 'setup__note',
      'Play someone on another machine. Your two browsers talk directly to each other. With a rendezvous server configured you trade one six-character code; without one you paste the connection details directly, which needs no infrastructure at all.')
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

async function runHost(root, choice, { onExit }) {
  root.innerHTML = '';
  root.appendChild(topbar('Hosting', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel('Preparing your code…', 'Gathering connection details. This takes a few seconds.'));
  root.appendChild(wrap);

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

async function renderJoin(root, { onExit }) {
  root.innerHTML = '';
  root.appendChild(topbar('Joining', onExit));
  const wrap = el('section', 'setup');
  wrap.appendChild(statusPanel('Looking for a rendezvous server…'));
  root.appendChild(wrap);

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

function startOnlineMatch(root, { transport, role, choice, onExit }) {
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
      })
    : createGuestSession(transport, { name });

  applyThemeFor({ deckId: isHost ? choice.hostDeckId : null });

  const seat = isHost ? HOST_SEAT : GUEST_SEAT;
  let unmount = null;

  const mount = () => {
    if (unmount) return;
    stopTips(); // the waiting is over; nothing left to read tips on
    unmount = mountBoard(root, {
      controller: session,
      viewer: seat,
      title: 'Online Match',
      subtitle: isHost ? 'You are hosting' : 'Connected to host',
      onExit,
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
    unmount?.();
    session.destroy();
  };
}

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

export function renderOnline(root) {
  cleanup();
  const goMenu = () => {
    cleanup();
    window.location.hash = '#/';
  };

  const lobby = () => {
    cleanup();
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

  lobby();
}
