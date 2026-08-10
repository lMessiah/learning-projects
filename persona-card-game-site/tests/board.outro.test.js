/**
 * @vitest-environment jsdom
 *
 * The end-of-match outro: one beat between the last blow and the scoreboard.
 *
 * It has to be skippable, it has to respect the animation-speed setting, and it
 * must always hand over to the stats screen rather than becoming a place a
 * player can get stuck.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, applyAction } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { setField } from './helpers.js';
import { setSetting, resetSettings } from '../src/ui/settings.js';

let root;
let unmount;
let controller;

/**
 * A live match that then ENDS in front of the mounted board, because that is
 * the only thing the outro reacts to. Ending it by resignation keeps the setup
 * to one dispatch; the outro reads `state.winner` and never the reason.
 */
function boot({ winner = 0, viewer = 0, neutralResult = false, speed = 'normal' } = {}) {
  setSetting('animationSpeed', speed);

  let state = createMatch({
    seed: 24,
    players: [
      { name: 'You', deckId: 'p5', controller: 'human' },
      { name: 'Them', deckId: 'p4', controller: 'human' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  setField(state, 0, [{ cardId: 'pixie', level: 12, active: true }]);
  setField(state, 1, [{ cardId: 'silky', level: 12, active: true }]);
  // Give both sides an MVP-worthy contribution so the card has something to show.
  state.players[0].field[0].dmgDealt = 210;
  state.players[0].field[0].kos = 3;
  state.players[1].field[0].dmgDealt = 140;
  state.players[1].field[0].kos = 2;
  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer, title: 'Test', neutralResult, onExit() {} });
  // The loser resigns, so `winner` takes it.
  controller.dispatch({ type: 'RESIGN', player: 1 - winner });
  return controller;
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  root?.remove();
  unmount = null;
  controller = null;
  root = null;
  resetSettings();
  vi.useRealTimers();
});

describe('the victory outro', () => {
  it('does not replay when the board is mounted onto an already-finished match', () => {
    // A reload, or a spectator arriving late: the flourish belongs to the
    // moment the match ended, not to the state it left behind.
    boot({ winner: 0, viewer: 0 });
    click($('.match-outro'));
    const finished = controller.getState();

    unmount();
    root.innerHTML = '';
    const remounted = createController({ state: finished, botPlayer: null });
    unmount = mountBoard(root, { controller: remounted, viewer: 0, title: 'Test', onExit() {} });

    expect($('.match-outro')).toBe(null);
    expect($('.modal-overlay--result')).toBeTruthy();
    remounted.destroy();
  });

  it('plays before the scoreboard rather than alongside it', () => {
    boot({ winner: 0, viewer: 0 });
    expect($('.match-outro--win')).toBeTruthy();
    expect($('.modal-overlay--result')).toBe(null);
  });

  it('names the result and shows the winning side\'s MVP', () => {
    boot({ winner: 0, viewer: 0 });
    expect($('.match-outro__word').textContent).toBe('VICTORY');
    expect($('.match-outro__card')).toBeTruthy();
    expect($('.match-outro__mvp').textContent).toMatch(/Pixie/);
    expect($('.match-outro__mvp').textContent).toMatch(/3 KOs/);
  });

  it('throws a particle burst, each spark on its own angle', () => {
    boot({ winner: 0, viewer: 0 });
    const sparks = $$('.match-outro__spark');
    expect(sparks.length).toBeGreaterThan(6);
    const angles = new Set(sparks.map((s) => s.style.getPropertyValue('--angle')));
    expect(angles.size).toBe(sparks.length);
  });

  it('has a shine on the card, which the defeat variant does not', () => {
    boot({ winner: 0, viewer: 0 });
    expect($('.match-outro__shine')).toBeTruthy();
  });

  it('auto-advances to the stats screen', () => {
    boot({ winner: 0, viewer: 0 });
    vi.advanceTimersByTime(4000);
    expect($('.match-outro')).toBe(null);
    expect($('.modal-overlay--result')).toBeTruthy();
  });

  it('is skippable with a click, without waiting out the timer', () => {
    boot({ winner: 0, viewer: 0 });
    click($('.match-outro'));
    expect($('.match-outro')).toBe(null);
    expect($('.modal-overlay--result')).toBeTruthy();
  });

  it('stays on the stats screen once it has advanced', () => {
    boot({ winner: 0, viewer: 0 });
    click($('.match-outro'));
    vi.advanceTimersByTime(8000);
    expect($('.match-outro')).toBe(null);
    expect($('.modal-overlay--result')).toBeTruthy();
  });
});

describe('the defeat outro', () => {
  it('is the quieter variant, with a desaturation sweep and no burst', () => {
    boot({ winner: 1, viewer: 0 });
    expect($('.match-outro--lose')).toBeTruthy();
    expect($('.match-outro__word').textContent).toBe('DEFEAT');
    expect($('.match-outro__sweep')).toBeTruthy();
    expect($('.match-outro__particles')).toBe(null);
    expect($('.match-outro__shine')).toBe(null);
  });

  it('shows the winner\'s Persona — the honest answer to what beat you', () => {
    boot({ winner: 1, viewer: 0 });
    expect($('.match-outro__mvp').textContent).toMatch(/Silky/);
  });

  it('advances to the stats screen exactly like the victory variant', () => {
    boot({ winner: 1, viewer: 0 });
    vi.advanceTimersByTime(4000);
    expect($('.modal-overlay--result')).toBeTruthy();
  });
});

describe('resignation', () => {
  it('shows the resigner the defeat variant', () => {
    // Seat 0 resigned, so seat 1 won and seat 0 is watching from the losing end.
    boot({ winner: 1, viewer: 0 });
    expect($('.match-outro--lose')).toBeTruthy();
  });

  it('shows the other side the victory variant', () => {
    boot({ winner: 1, viewer: 1 });
    expect($('.match-outro--win')).toBeTruthy();
  });
});

describe('hot-seat', () => {
  it('announces the winner by name, because there is no "you"', () => {
    boot({ winner: 1, viewer: 0, neutralResult: true });
    expect($('.match-outro--win')).toBeTruthy();
    expect($('.match-outro__word').textContent).toBe('THEM');
  });
});

describe('the animation setting', () => {
  it('is skipped entirely when animations are off', () => {
    boot({ winner: 0, viewer: 0, speed: 'off' });
    expect($('.match-outro')).toBe(null);
    expect($('.modal-overlay--result')).toBeTruthy();
  });

  it('runs shorter on the fast setting than on normal', () => {
    boot({ winner: 0, viewer: 0, speed: 'fast' });
    // Fast halves every duration, so 1400ms is past the end of a 2600ms outro.
    vi.advanceTimersByTime(1400);
    expect($('.modal-overlay--result')).toBeTruthy();

    unmount();
    controller.destroy();
    root.innerHTML = '';

    boot({ winner: 0, viewer: 0, speed: 'normal' });
    vi.advanceTimersByTime(1400);
    expect($('.match-outro')).toBeTruthy();
  });
});
