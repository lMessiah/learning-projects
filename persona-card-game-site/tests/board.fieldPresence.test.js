/**
 * @vitest-environment jsdom
 *
 * The field-presence rules are the only ones that can end a match without a
 * single knockout, so they have to be visible with a mouse and not merely true
 * in the engine: the countdown and the combo chip. There is deliberately NO
 * forced-play prompt — an empty field is a legal position a player may choose,
 * so the countdown is the whole of the enforcement.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, applyAction, CONFIG } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { setField, setHand } from './helpers.js';

let root;
let unmount;
let controller;

function boot(prepare, { viewer = 0 } = {}) {
  let state = createMatch({
    seed: 24,
    players: [
      { name: 'You', deckId: 'p5', controller: 'human' },
      { name: 'Them', deckId: 'p4', controller: 'human' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  prepare?.(state);

  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer, title: 'Test', onExit() {} });
  return controller;
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const byText = (sel, re) => $$(sel).find((n) => re.test(n.textContent));

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
  vi.useRealTimers();
});

describe('the empty-field countdown', () => {
  const emptySeat0 = (state) => {
    setField(state, 0, []);
    setHand(state, 0, ['medicine']);
    state.players[0].emptyFieldTurns = 1;
  };

  it('is not drawn at all while both players have a board', () => {
    boot();
    expect($('.field-timer')).toBe(null);
  });

  it('appears on the side of the player who is on the clock', () => {
    boot(emptySeat0);
    const timers = $$('.field-timer');
    expect(timers.length).toBe(1);
    expect($('.side--you .field-timer')).toBeTruthy();
    expect($('.side--enemy .field-timer')).toBe(null);
  });

  it('shows one pip per turn of the countdown, filled as it runs down', () => {
    boot(emptySeat0);
    const pips = $$('.field-timer__pips .pip');
    expect(pips.length).toBe(CONFIG.EMPTY_FIELD_LOSS_TURNS);
    expect(pips.filter((p) => p.classList.contains('pip--on')).length).toBe(1);
    expect($('.field-timer__count').textContent).toMatch(/3 turns left/);
  });

  it('goes critical on the last turn', () => {
    boot((state) => {
      emptySeat0(state);
      state.players[0].emptyFieldTurns = CONFIG.EMPTY_FIELD_LOSS_TURNS;
    });
    expect($('.field-timer').classList.contains('field-timer--critical')).toBe(true);
    expect($('.field-timer__count').textContent).toMatch(/last chance/i);
  });

  it("is visible on the opponent's side too — an empty board is public", () => {
    boot((state) => {
      setField(state, 1, []);
      state.players[1].emptyFieldTurns = 2;
    });
    expect($('.side--enemy .field-timer')).toBeTruthy();
    expect($('.side--you .field-timer')).toBe(null);
  });

  it('reads the same from the other seat — hot-seat sees one board, not two', () => {
    boot((state) => {
      setField(state, 0, []);
      state.players[0].emptyFieldTurns = 2;
    }, { viewer: 1 });
    // Seat 0 is the one on the clock, so from seat 1 it is the ENEMY side.
    expect($('.side--enemy .field-timer')).toBeTruthy();
    expect($$('.field-timer').length).toBe(1);
  });
});

describe('no forced-play prompt', () => {
  it('never opens a modal, however obviously you should play the Persona', () => {
    boot((state) => {
      setField(state, 0, []);
      setHand(state, 0, ['pixie']);
      state.players[0].emptyFieldTurns = CONFIG.EMPTY_FIELD_LOSS_TURNS;
    });
    expect($('.modal-overlay')).toBe(null);
    // The board is fully playable and the countdown is doing the talking.
    expect($('.action-bar')).toBeTruthy();
    expect($('.field-timer')).toBeTruthy();
  });

  it('leaves the Persona in hand where the player put it', () => {
    boot((state) => {
      setField(state, 0, []);
      setHand(state, 0, ['pixie']);
    });
    expect(controller.getState().players[0].hand.some((c) => c.cardId === 'pixie')).toBe(true);
  });
});

describe('the combo chip', () => {
  it('is absent until a knockdown lands', () => {
    boot();
    expect(byText('.allowance', /Combo/)).toBeFalsy();
  });

  it('shows the stack count and what it is worth', () => {
    boot((state) => {
      state.turnState.comboStacks = 3;
    });
    const chip = byText('.allowance', /Combo/);
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('×3');
    expect(chip.textContent).toContain(`+${Math.round(3 * CONFIG.COMBO_DAMAGE_STEP * 100)}%`);
  });

  it('lives in the fixed-height allowance strip, so it cannot move the board', () => {
    boot((state) => {
      state.turnState.comboStacks = 2;
    });
    expect(byText('.allowance', /Combo/).parentElement.classList.contains('allowances')).toBe(true);
  });
});
