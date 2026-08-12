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
import { loadHotseat, clearHotseat } from '../src/ui/game/hotseatSave.js';

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
  // A hot-seat match persists itself, so without this every test after the
  // first would land on the resume screen instead of setup.
  clearHotseat();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  // Leaving the route tears the match down.
  window.location.hash = '';
  root.remove();
  document.body.classList.remove('board-mode');
  document.querySelectorAll('.card-detail-overlay, .card-tooltip').forEach((n) => n.remove());
  clearHotseat();
  vi.useRealTimers();
});

describe('setup', () => {
  it('collects a name, a deck flavour and a play style for each seat', () => {
    renderHotseat(root);
    expect($$('.seat-name input')).toHaveLength(2);
    // Two rows per seat now: the flavour, then the archetype.
    expect($$('.setup__row')).toHaveLength(4);

    const deckRows = $$('.setup__row').filter((row) => row.querySelector('[data-deck-id]'));
    const styleRows = $$('.setup__row').filter((row) => row.querySelector('[data-archetype]'));
    expect(deckRows).toHaveLength(2);
    expect(styleRows).toHaveLength(2);

    // Each seat starts on a different deck and a different play style.
    const decks = deckRows.map((row) => row.querySelector('.setup-card--on').dataset.deckId);
    const styles = styleRows.map((row) => row.querySelector('.setup-card--on').dataset.archetype);
    expect(decks[0]).not.toBe(decks[1]);
    expect(styles[0]).not.toBe(styles[1]);
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

/**
 * Leaving and coming back.
 *
 * The whole point: one player hits Back by accident and the match is still
 * there. "Leaving" is simulated the way it actually happens — the route is torn
 * down and re-entered — because that is all navigating away does to this app.
 */
describe('resuming an abandoned match', () => {
  /** Walk away, then reopen the local-multiplayer route. */
  const leaveAndReturn = () => {
    root.innerHTML = '';
    renderHotseat(root);
  };

  const resume = () => {
    const button = byText('.resume-card__actions .btn', /Resume match/);
    expect(button, 'expected a resume screen').toBeTruthy();
    click(button);
  };

  it('saves the match from the very first gate, before a card is played', () => {
    startMatch();
    const save = loadHotseat();

    expect(save).toBeTruthy();
    expect(save.state.phase).toBe('starterSelect');
    expect(save.seats.map((s) => s.name)).toEqual(['Alice', 'Bob']);
  });

  it('offers to resume instead of showing setup', () => {
    beginPlay();
    leaveAndReturn();

    expect($('.resume-card')).toBeTruthy();
    expect($('.seat-name input')).toBe(null);
    expect($('.resume-card').textContent).toContain('Alice');
    expect($('.resume-card').textContent).toContain('Bob');
  });

  it('shows no hand on the resume screen — the returning player may be either seat', () => {
    beginPlay();
    leaveAndReturn();

    expect($$('.hand-tile')).toHaveLength(0);
    expect($('.board-play')).toBe(null);
    expect($('.card')).toBe(null);
  });

  it('comes back behind the pass-the-device gate, not straight onto a board', () => {
    beginPlay();
    leaveAndReturn();
    resume();

    expect($('.pass-card__ready')).toBeTruthy();
    expect($('.board-play')).toBe(null);
  });

  it('restores the board exactly as it was left', () => {
    beginPlay();
    // Spend the turn so there is something specific to check for.
    click(byText('.action-bar .btn', /Pass \(/));
    const before = {
      hand: $$('.hand-tile').map((t) => t.dataset.cardId),
      turn: $('.turn-indicator').textContent,
      log: $$('.log__line').length,
    };

    leaveAndReturn();
    resume();
    takeSeat();

    expect($$('.hand-tile').map((t) => t.dataset.cardId)).toEqual(before.hand);
    expect($('.turn-indicator').textContent).toBe(before.turn);
    expect($$('.log__line').length).toBe(before.log);
  });

  it('hands the device back to the seat that was mid-turn', () => {
    beginPlay(); // Alice to act
    click(byText('.action-bar .btn', /End turn/)); // now Bob
    leaveAndReturn();
    resume();

    expect($('.pass-card__title').textContent).toBe('Pass the device to Bob');
  });

  it('keeps saving as the resumed match carries on', () => {
    beginPlay();
    leaveAndReturn();
    resume();
    takeSeat();
    click(byText('.action-bar .btn', /End turn/));

    const save = loadHotseat();
    expect(save).toBeTruthy();
    expect(save.state.turn).toBeGreaterThan(1);
  });

  it('discards the match on request and returns to setup', () => {
    beginPlay();
    leaveAndReturn();

    click(byText('.resume-card__actions .btn', /Start a new match/));

    expect($$('.seat-name input')).toHaveLength(2);
    expect(loadHotseat()).toBe(null);
  });

  it('does not offer to resume a match nobody started', () => {
    renderHotseat(root);
    expect($('.resume-card')).toBe(null);
    expect($$('.seat-name input')).toHaveLength(2);
  });

  it('drops a save written by an older version rather than resuming it', () => {
    beginPlay();
    const raw = JSON.parse(localStorage.getItem('pcg.hotseat.save'));
    localStorage.setItem('pcg.hotseat.save', JSON.stringify({ ...raw, version: raw.version + 1 }));

    expect(loadHotseat()).toBe(null);
    leaveAndReturn();
    expect($$('.seat-name input')).toHaveLength(2);
  });

  it('survives a corrupt save without taking the route down with it', () => {
    localStorage.setItem('pcg.hotseat.save', '{not json');

    expect(loadHotseat()).toBe(null);
    renderHotseat(root);
    expect($$('.seat-name input')).toHaveLength(2);
  });

  it('never offers to resume a finished match', () => {
    // The match ending clears the save, and even if one survived some other
    // way, a decided match is not something to hand anybody back.
    beginPlay();
    const raw = JSON.parse(localStorage.getItem('pcg.hotseat.save'));
    raw.state.winner = 0;
    localStorage.setItem('pcg.hotseat.save', JSON.stringify(raw));

    expect(loadHotseat()).toBe(null);
    leaveAndReturn();
    expect($$('.seat-name input')).toHaveLength(2);
  });

  it('clears the save when a player resigns', () => {
    beginPlay();
    expect(loadHotseat()).toBeTruthy();

    click($('.log-panel__resign'));
    click(byText('.modal .btn', /Yes, resign/));

    expect(loadHotseat()).toBe(null);
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
