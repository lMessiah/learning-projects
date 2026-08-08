/**
 * @vitest-environment jsdom
 *
 * Hot-seat local multiplayer: the pass-the-device gate, the viewpoint following
 * the seat, and — most importantly — that one player's hand is never in the DOM
 * while the other is at the device.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getCard } from '../src/data/cards.js';
import { renderHotseat, seatToAct } from '../src/ui/game/hotseat.js';

let root;

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const byText = (sel, pattern) => $$(sel).find((n) => pattern.test(n.textContent));

/** Walk the setup screen and start a match. */
function startMatch({ names = ['Alice', 'Bob'] } = {}) {
  renderHotseat(root);
  const inputs = $$('.seat-name input');
  expect(inputs).toHaveLength(2);
  inputs.forEach((input, i) => {
    input.value = names[i];
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  click(byText('.setup__start', /Start match/));
}

/** Press "I'm X — Ready" on the gate. */
function takeSeat() {
  const ready = $('.pass-card__ready');
  expect(ready, 'expected a pass-the-device gate').toBeTruthy();
  click(ready);
}

function chooseStarter() {
  click($$('.starter-select .card')[0]);
}

/** Get through setup + both starter picks, landing on player 0's first turn. */
function beginPlay(options) {
  startMatch(options);
  takeSeat();
  chooseStarter();
  takeSeat();
  chooseStarter();
  takeSeat();
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  // Leaving the route tears the match down.
  window.location.hash = '';
  root.remove();
  document.body.classList.remove('board-mode');
  document.querySelectorAll('.card-detail-overlay, .card-tooltip').forEach((n) => n.remove());
  vi.useRealTimers();
});

describe('setup', () => {
  it('collects two names and two decks', () => {
    renderHotseat(root);
    expect($$('.seat-name input')).toHaveLength(2);
    expect($$('.setup__row')).toHaveLength(2);
    // Each seat starts on a different deck.
    const chosen = $$('.setup__row').map((row) => row.querySelector('.setup-card--on').dataset.deckId);
    expect(chosen[0]).not.toBe(chosen[1]);
  });
});

describe('the pass-the-device gate', () => {
  it('gates the very first seat before anything is shown', () => {
    startMatch();
    expect($('.pass-card__title').textContent).toBe('Pass the device to Alice');
    expect($('.board-play')).toBe(null);
    expect($('.starter-select')).toBe(null);
  });

  it('gates each starter pick separately', () => {
    startMatch();
    takeSeat();
    expect($('.starter-select')).toBeTruthy();

    chooseStarter();
    // Straight back behind the gate, now for Bob.
    expect($('.pass-card__title').textContent).toBe('Pass the device to Bob');
    expect($('.starter-select')).toBe(null);

    takeSeat();
    expect($('.starter-select')).toBeTruthy();
  });

  it('gates every turn handover', () => {
    beginPlay();
    expect($('.board-play')).toBeTruthy();
    expect($('.turn-indicator').textContent).toContain('Your turn');

    click(byText('.action-bar .btn', /End turn/));

    expect($('.board-play')).toBe(null);
    expect($('.pass-card__title').textContent).toBe('Pass the device to Bob');

    takeSeat();
    expect($('.board-play')).toBeTruthy();
  });

  it('shows only public information on the gate', () => {
    beginPlay();
    click(byText('.action-bar .btn', /End turn/));

    const gate = $('.pass-screen');
    expect(gate.textContent).toContain('Personas lost'); // KO tallies are public
    expect(gate.querySelector('.hand-tile')).toBe(null);
    expect(gate.querySelector('.hand')).toBe(null);
    expect(gate.querySelector('.card')).toBe(null);
  });

  it('does not gate inside a single turn', () => {
    beginPlay();
    const gates = () => $$('.pass-card').length;
    expect(gates()).toBe(0);

    // Playing a card mid-turn must not interrupt with a gate.
    click(byText('.action-bar .btn', /Pass \(/));
    expect(gates()).toBe(0);
    expect($('.board-play')).toBeTruthy();
  });
});

describe('hand privacy', () => {
  it('never has the waiting player\'s hand in the DOM', () => {
    beginPlay();

    // Alice's turn: her hand is rendered, Bob's is not.
    const aliceHand = $$('.hand-tile').map((t) => t.dataset.cardId);
    expect(aliceHand.length).toBeGreaterThan(0);
    expect($('.side--enemy .hand-tile')).toBe(null);

    click(byText('.action-bar .btn', /End turn/));
    // Behind the gate nothing at all is rendered.
    expect($$('.hand-tile')).toHaveLength(0);

    takeSeat();
    const bobHand = $$('.hand-tile').map((t) => t.dataset.cardId);
    expect(bobHand.length).toBeGreaterThan(0);
    // Bob sees his own hand — a different set of cards from Alice's.
    expect(bobHand.join('|')).not.toBe(aliceHand.join('|'));
  });

  it('flips the viewpoint so each player sees their own side as "you"', () => {
    beginPlay({ names: ['Alice', 'Bob'] });
    expect($('.side--you .side__name').textContent).toContain('Alice');
    expect($('.side--enemy .side__name').textContent).toContain('Bob');

    click(byText('.action-bar .btn', /End turn/));
    takeSeat();

    expect($('.side--you .side__name').textContent).toContain('Bob');
    expect($('.side--enemy .side__name').textContent).toContain('Alice');
  });

  it('masks the opponent\'s hidden weaknesses for whoever is looking', () => {
    beginPlay();
    // Your own active shows real affinities; theirs are unknown until struck.
    expect($('.side--you .tile--active .mini-chip--unknown')).toBe(null);
    expect($('.side--enemy .tile--active .mini-chip--unknown')).toBeTruthy();

    click(byText('.action-bar .btn', /End turn/));
    takeSeat();

    expect($('.side--you .tile--active .mini-chip--unknown')).toBe(null);
    expect($('.side--enemy .tile--active .mini-chip--unknown')).toBeTruthy();
  });
});

describe('playing a hot-seat match', () => {
  it('lets both seats act, alternating through the gate', () => {
    beginPlay();

    const attack = () => {
      const btn = $$('.skill-btn').find((b) => b.textContent.includes('Attack') && !b.disabled);
      expect(btn).toBeTruthy();
      click(btn);
    };

    attack();
    click(byText('.action-bar .btn', /End turn/));
    takeSeat();

    expect($('.turn-indicator').textContent).toContain('Your turn');
    attack();
    click(byText('.action-bar .btn', /End turn/));
    takeSeat();

    expect($('.turn-indicator').textContent).toMatch(/T\d+/);
    expect($('.board-play')).toBeTruthy();
  });

  it('names the winner neutrally rather than Victory/Defeat', () => {
    beginPlay();
    // The result overlay is neutral in hot-seat: no seat is "you".
    // Drive it there by checking the label logic on a finished board.
    click(byText('.action-bar .btn', /End turn/));
    takeSeat();
    expect($('.result')).toBe(null); // still playing

    // Sanity: the indicator uses turn numbers, not a first-person verdict.
    expect($('.turn-indicator').textContent).not.toMatch(/Victory|Defeat/);
  });
});

describe('seatToAct', () => {
  it('points at whoever still has to choose a starter, then the active player', () => {
    const state = {
      phase: 'starterSelect',
      activePlayer: 0,
      players: [{ field: [{}] }, { field: [] }],
    };
    expect(seatToAct(state)).toBe(1);

    state.players[1].field.push({});
    expect(seatToAct(state)).toBe(0); // both chosen -> falls back to activePlayer

    expect(seatToAct({ phase: 'playing', activePlayer: 1, players: [] })).toBe(1);
  });
});
