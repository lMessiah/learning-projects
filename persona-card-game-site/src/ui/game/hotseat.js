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

function startMatch(root, seats, { onExit, onRematch }) {
  cleanup();
  // ONE theme for the whole hot-seat match: the Settings choice, else player 1's
  // deck. Flipping themes between seats every turn would be unreadable.
  applyThemeFor({ deckId: seats[0].deckId });

  const seed = Math.floor(Date.now() % 2147483647) || 1;
  const state = createMatch({
    seed,
    players: seats.map((seat) => ({
      name: seat.name,
      deckId: seat.deckId,
      archetype: seat.archetype,
      controller: 'human',
    })),
  });

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
 * Route
 * ------------------------------------------------------------------ */

export function renderHotseat(root) {
  cleanup();
  const goMenu = () => {
    cleanup();
    window.location.hash = '#/';
  };

  const showSetup = () => {
    cleanup();
    renderSetup(root, {
      onExit: goMenu,
      onStart: (seats) =>
        startMatch(root, seats, { onExit: goMenu, onRematch: () => startMatch(root, seats, { onExit: goMenu, onRematch: showSetup }) }),
    });
  };

  showSetup();
}

export { startMatch as startHotseatMatch, renderGate as renderPassScreen };
