/**
 * Local multiplayer (hot-seat).
 *
 * Two players share one device. Between seats a full-screen privacy gate goes
 * up; while it is up the board is **unmounted entirely**, not merely covered,
 * so the incoming player cannot see the previous player's hand by any means.
 */
import { createMatch } from '../../engine/index.js';
import { DECKS } from '../../data/cards.js';
import { ARCHETYPES } from '../../data/archetypes.js';
import { renderArchetypeRow, ARCHETYPE_HEADING } from '../archetypeRow.js';
import { getProfileName } from '../profile.js';
import { createController } from './controller.js';
import { mountBoard } from './board.js';
import { applyThemeFor } from '../theme.js';
import { saveHotseat, loadHotseat, clearHotseat } from './hotseatSave.js';

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
  if (teardown) {
    teardown();
    teardown = null;
  }
}

/** Which seat is expected to act right now. */
export function seatToAct(state) {
  if (state.phase === 'starterSelect') {
    const index = state.players.findIndex((p) => p.field.length === 0);
    return index === -1 ? state.activePlayer : index;
  }
  return state.activePlayer;
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

function renderSetup(root, { onStart, onExit }) {
  const seats = [
    { name: getProfileName(), deckId: DECKS[0].id, archetype: ARCHETYPES[0].id },
    { name: 'Player 2', deckId: DECKS[1].id, archetype: ARCHETYPES[1].id },
  ];
  root.innerHTML = '';

  const topbar = el('div', 'topbar');
  topbar.appendChild(button('← Menu', 'btn btn--ghost', onExit));
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Local Multiplayer'));
  titles.appendChild(el('div', 'topbar__sub', 'Hot-seat · one device, two players'));
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup');
  wrap.appendChild(
    el('p', 'setup__note',
      'Take turns on the same device. Between turns a pass-the-device screen hides the board so nobody sees the other hand.')
  );

  seats.forEach((seat, index) => {
    wrap.appendChild(el('h2', 'setup__heading', `Player ${index + 1}`));

    const nameRow = el('label', 'seat-name');
    nameRow.appendChild(el('span', null, 'Name'));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = seat.name;
    input.maxLength = 20;
    input.addEventListener('input', () => {
      seat.name = input.value.trim() || `Player ${index + 1}`;
    });
    nameRow.appendChild(input);
    wrap.appendChild(nameRow);

    const row = el('div', 'setup__row');
    const buttons = new Map();
    for (const deck of DECKS) {
      const node = el('button', 'setup-card');
      node.type = 'button';
      node.dataset.deckId = deck.id;
      node.appendChild(el('span', 'setup-card__icon', DECK_SYMBOL[deck.id] || '🃏'));
      node.appendChild(el('span', 'setup-card__title', deck.name));
      node.appendChild(el('span', 'setup-card__tag', deck.game.toUpperCase()));
      node.appendChild(el('span', 'setup-card__desc', deck.playstyle || deck.tagline));
      node.addEventListener('click', () => {
        seat.deckId = deck.id;
        for (const [id, btn] of buttons) btn.classList.toggle('setup-card--on', id === deck.id);
      });
      buttons.set(deck.id, node);
      row.appendChild(node);
    }
    buttons.get(seat.deckId).classList.add('setup-card--on');
    wrap.appendChild(row);

    wrap.appendChild(el('p', 'setup__note', ARCHETYPE_HEADING));
    wrap.appendChild(
      renderArchetypeRow({
        value: seat.archetype,
        onPick: (id) => {
          seat.archetype = id;
        },
      })
    );
  });

  wrap.appendChild(button('Start match', 'btn btn--primary setup__start', () => onStart(seats.map((s) => ({ ...s })))));
  root.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * Privacy gate
 * ------------------------------------------------------------------ */

function renderGate(root, { state, seat, onReady, onExit }) {
  root.innerHTML = '';
  const player = state.players[seat];
  const other = state.players[seat === 0 ? 1 : 0];

  const screen = el('div', 'pass-screen');

  const topbar = el('div', 'topbar topbar--game');
  topbar.appendChild(button('← Menu', 'btn btn--ghost btn--small', onExit));
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Local Multiplayer'));
  titles.appendChild(el('div', 'topbar__sub', 'Hot-seat'));
  topbar.appendChild(titles);
  screen.appendChild(topbar);

  const card = el('div', 'pass-card');
  card.appendChild(el('div', 'pass-card__icon', '🤝'));
  card.appendChild(el('h2', 'pass-card__title', `Pass the device to ${player.name}`));
  card.appendChild(
    el('p', 'pass-card__sub',
      state.phase === 'starterSelect'
        ? 'Time to choose your starting Persona.'
        : `Turn ${state.turn + 1} · ${other.name}'s turn is over.`)
  );
  card.appendChild(el('p', 'pass-card__warn', `${other.name}: look away. The board stays hidden until ${player.name} is ready.`));

  // Public information only — nothing here reveals a hand.
  const score = el('div', 'pass-card__score');
  for (const p of state.players) {
    const row = el('div', 'pass-card__score-row');
    row.appendChild(el('span', null, p.name));
    row.appendChild(el('span', null, `${p.koCount}/${state.config.KO_TARGET} Personas lost`));
    score.appendChild(row);
  }
  card.appendChild(score);

  const ready = button(`I'm ${player.name} — Ready`, 'btn btn--primary pass-card__ready', onReady);
  card.appendChild(ready);
  screen.appendChild(card);

  root.appendChild(screen);
  ready.focus?.();
}

/* ------------------------------------------------------------------ *
 * Match
 * ------------------------------------------------------------------ */

/**
 * @param resume a state from a previous session to pick up, or null to deal a
 *               fresh match. The seats are passed either way — they carry the
 *               names, decks and styles the setup screen collected, and a
 *               resumed match needs them for the theme and for Rematch.
 */
function startMatch(root, seats, { onExit, onRematch, resume = null }) {
  cleanup();
  // ONE theme for the whole hot-seat match: the Settings choice, else player 1's
  // deck. Flipping themes between seats every turn would be unreadable.
  applyThemeFor({ deckId: seats[0].deckId });

  const seed = Math.floor(Date.now() % 2147483647) || 1;
  const state =
    resume ??
    createMatch({
      seed,
      players: seats.map((seat) => ({
        name: seat.name,
        deckId: seat.deckId,
        archetype: seat.archetype,
        controller: 'human',
      })),
    });

  // Written before anything is played, so a match abandoned on the very first
  // gate is still there to come back to.
  saveHotseat({ state, seats });

  // No bot: both seats are driven by whoever is holding the device.
  const controller = createController({ state, botPlayer: null });

  let boardUnmount = null;
  let shownSeat = null; // the seat the board is currently rendered for
  let gated = true; // start behind the gate: player 1 has to take the device

  const unmountBoard = () => {
    if (boardUnmount) {
      boardUnmount();
      boardUnmount = null;
    }
  };

  function showBoard(seat) {
    unmountBoard();
    shownSeat = seat;
    boardUnmount = mountBoard(root, {
      controller,
      // The viewpoint follows the seat that took the device, so the board keeps
      // showing their hand for the whole of their turn — including after they
      // end it, right up until the gate replaces it.
      viewer: () => shownSeat,
      title: 'Local Multiplayer',
      subtitle: `${state.players[0].name} vs ${state.players[1].name}`,
      neutralResult: true,
      onExit,
      onRematch,
    });
  }

  function showGate(seat) {
    unmountBoard();
    gated = true;
    renderGate(root, {
      state: controller.getState(),
      seat,
      onExit,
      onReady: () => {
        gated = false;
        showBoard(seat);
      },
    });
  }

  const unsubscribe = controller.subscribe((next) => {
    // Persisted on EVERY action, not on turn boundaries: the Back button does
    // not wait for a convenient moment. This runs before the gate check below,
    // which returns early, so it must come first.
    if (next.winner !== null) clearHotseat();
    else saveHotseat({ state: next, seats });

    if (gated) return; // the gate owns the screen; nothing to sync
    if (next.winner !== null) return; // let the board show the result to both
    const seat = seatToAct(next);
    if (seat !== shownSeat) showGate(seat);
  });

  showGate(seatToAct(controller.getState()));

  teardown = () => {
    unsubscribe();
    unmountBoard();
    controller.destroy();
  };

  return controller;
}

/* ------------------------------------------------------------------ *
 * Resume
 * ------------------------------------------------------------------ */

/**
 * The screen a returning player lands on when a match was left unfinished.
 *
 * It shows the same public-only information the pass-the-device gate does —
 * names and KO tallies, never a hand. Resuming goes back behind that gate, so
 * whoever picks the device up has to say who they are before a board appears.
 */
function renderResume(root, { save, onResume, onDiscard, onExit }) {
  root.innerHTML = '';
  const { state } = save;

  const topbar = el('div', 'topbar');
  topbar.appendChild(button('← Menu', 'btn btn--ghost', onExit));
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Local Multiplayer'));
  titles.appendChild(el('div', 'topbar__sub', 'Hot-seat · one device, two players'));
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup resume');
  const card = el('div', 'pass-card resume-card');
  card.appendChild(el('div', 'pass-card__icon', '⏸️'));
  card.appendChild(el('h2', 'pass-card__title', 'Match in progress'));
  card.appendChild(
    el('p', 'pass-card__sub',
      state.phase === 'starterSelect'
        ? 'Nobody has chosen a starting Persona yet.'
        : `${state.players[0].name} vs ${state.players[1].name} · turn ${state.turn}`)
  );

  const score = el('div', 'pass-card__score');
  for (const player of state.players) {
    const row = el('div', 'pass-card__score-row');
    row.appendChild(el('span', null, player.name));
    row.appendChild(el('span', null, `${player.koCount}/${state.config.KO_TARGET} Personas lost`));
    score.appendChild(row);
  }
  card.appendChild(score);

  const actions = el('div', 'resume-card__actions');
  actions.appendChild(button('Resume match', 'btn btn--primary', onResume));
  actions.appendChild(button('Start a new match', 'btn btn--ghost', onDiscard));
  card.appendChild(actions);
  card.appendChild(
    el('p', 'pass-card__warn', 'Starting a new match discards this one. It cannot be brought back.')
  );

  wrap.appendChild(card);
  root.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

export function renderHotseat(root) {
  cleanup();
  const goMenu = () => {
    cleanup();
    window.location.hash = '#/';
  };

  const play = (seats, resume = null) =>
    startMatch(root, seats, {
      onExit: goMenu,
      onRematch: () => play(seats),
      resume,
    });

  const showSetup = () => {
    cleanup();
    renderSetup(root, { onExit: goMenu, onStart: (seats) => play(seats) });
  };

  // An unfinished match outranks the setup screen: somebody left mid-game and
  // the most likely reason they are back is to carry on with it.
  const save = loadHotseat();
  if (save) {
    renderResume(root, {
      save,
      onExit: goMenu,
      onResume: () => play(save.seats, save.state),
      onDiscard: () => {
        clearHotseat();
        showSetup();
      },
    });
    return;
  }

  showSetup();
}

export { startMatch as startHotseatMatch, renderGate as renderPassScreen, renderResume as renderResumeScreen };
