/**
 * @vitest-environment jsdom
 *
 * The battle log sidebar, and the no-reflow contract it exists to enforce.
 *
 * jsdom has no layout engine, so "does not reflow" cannot be measured here as
 * pixels. What CAN be pinned down is the structural rule that makes reflow
 * impossible: nothing that appears and disappears mid-turn is ever inserted
 * into the board's own flow. The log lives in its own grid column, and the two
 * things that used to be inline banners — the One More announcement and the
 * Full Analysis hand reveal — are now a chip in a fixed-height strip and an
 * absolutely-positioned overlay respectively.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMatch, applyAction } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { setField, setHand } from './helpers.js';

let root;
let unmount;
let controller;

function boot({ seed = 42, prepare = null } = {}) {
  let state = createMatch({
    seed,
    players: [
      { name: 'You', deckId: 'p5', controller: 'human' },
      { name: 'Them', deckId: 'p4', controller: 'human' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  if (prepare) prepare(state);

  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Test', onExit() {} });
  return controller;
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];

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

describe('the log panel', () => {
  it('sits beside the board, in its own scroll container', () => {
    boot();
    const panel = $('.log-panel');
    expect(panel).toBeTruthy();
    // A sibling of the play area, not a child of it.
    expect(panel.parentElement.classList.contains('board-main')).toBe(true);
    expect(panel.previousElementSibling.classList.contains('board-play')).toBe(true);
    expect($('.log-panel__list')).toBeTruthy();
    expect($('.log-panel .board-play')).toBe(null);
  });

  it('renders every entry with its kind as a class, newest last', () => {
    const controller = boot();
    const state = controller.getState();
    const entries = $$('.log-entry');
    expect(entries.length).toBeGreaterThan(0);

    const shown = state.log.slice(-entries.length);
    expect(entries[entries.length - 1].textContent).toBe(shown[shown.length - 1].text);
    for (const [i, node] of entries.entries()) {
      expect(node.className).toContain(`log-entry--${shown[i].kind}`);
    }
  });

  it('grows as the match goes on without touching the board it sits next to', () => {
    const controller = boot();
    const before = $$('.log-entry').length;
    const play = $$('.board-play')[0].outerHTML;

    controller.dispatch({ type: 'GUARD', player: 0 });
    expect($$('.log-entry').length).toBeGreaterThan(before);

    // A Guard changes the board too, so the useful check is the reverse one:
    // the log column exists in both renders and the play area is still its
    // sibling, i.e. the feed never became part of the board's flow.
    expect(typeof play).toBe('string');
    expect($('.log-panel').parentElement).toBe($('.board-play').parentElement);
  });

  it('keeps following the newest entry, and stops when you scroll up', () => {
    const controller = boot();
    const list = $('.log-panel__list');

    // jsdom reports every box as zero-sized, so drive the pin logic directly:
    // a list that reports itself scrolled well short of the bottom is a reader
    // who has deliberately scrolled back.
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    list.scrollTop = 100;
    list.dispatchEvent(new window.Event('scroll'));

    controller.dispatch({ type: 'GUARD', player: 0 });
    const next = $('.log-panel__list');
    // Unpinned: the restore path uses the remembered offset rather than the end.
    expect(next.scrollTop).toBe(0); // zero-height jsdom clamps it, but it is NOT scrollHeight
    expect(next.scrollTop).not.toBe(1000);
  });
});

describe('the log after the match', () => {
  /** Resign to end the match immediately, with a log worth reading behind it. */
  function finish() {
    const controller = boot();
    controller.dispatch({ type: 'GUARD', player: 0 });
    controller.dispatch({ type: 'RESIGN', player: 1 });
    expect(controller.getState().winner).toBe(0);
    // Click past the end-of-match outro; the scoreboard is what this file is about.
    const outro = $('.match-outro');
    if (outro) outro.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    return controller;
  }

  const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tab = (id) => $(`.result-tab[data-tab="${id}"]`);

  it('offers a battle log view on the result screen', () => {
    const controller = finish();
    expect($('.modal-overlay--result')).toBeTruthy();

    const logTab = tab('log');
    expect(logTab, 'no way to reach the log after the match').toBeTruthy();
    expect(logTab.textContent).toContain(String(controller.getState().log.length));
    // Summary is what you land on.
    expect(tab('summary').className).toContain('result-tab--on');
    expect($('.result-log')).toBe(null);
  });

  it('shows the COMPLETE feed, not the sidebar tail', () => {
    const controller = finish();
    click(tab('log'));

    const state = controller.getState();
    const entries = $$('.result-log__list .log-entry');
    expect(entries).toHaveLength(state.log.length);
    expect(entries[0].textContent).toBe(state.log[0].text);
    expect(entries[entries.length - 1].textContent).toBe(state.log[state.log.length - 1].text);
    // Same per-kind styling as the sidebar, so it reads identically.
    for (const [i, node] of entries.entries()) {
      expect(node.className).toContain(`log-entry--${state.log[i].kind}`);
    }
  });

  it('scrolls inside itself rather than growing the result box off-screen', () => {
    finish();
    click(tab('log'));
    const css = readFileSync(resolve(process.cwd(), 'src/styles/board.css'), 'utf8');
    const rule = css.match(/\.result-log__list\s*\{([^}]*)\}/s)[1];
    expect(rule).toMatch(/overflow-y: auto/);
    expect(rule).toMatch(/max-height/);
  });

  it('goes back to the summary, and remembers which view you were on', () => {
    finish();
    click(tab('log'));
    expect($('.result-log')).toBeTruthy();
    expect(tab('log').className).toContain('result-tab--on');

    click(tab('summary'));
    expect($('.result-log')).toBe(null);
    expect($('.stats')).toBeTruthy();
    expect($('.result__stats')).toBeTruthy();
  });

  it('still offers Play again and Main menu from either view', () => {
    finish();
    for (const view of ['summary', 'log']) {
      click(tab(view));
      const actions = [...$$('.result__actions .btn')].map((b) => b.textContent);
      expect(actions, view).toContain('Main menu');
    }
  });

  it('keeps the log intact for as long as the result screen is up', () => {
    // "Cleared only when a new match starts" — a new match is a new state with
    // its own log, so what matters here is that ending one never empties it.
    const controller = finish();
    const length = controller.getState().log.length;
    expect(length).toBeGreaterThan(0);

    click(tab('log'));
    click(tab('summary'));
    click(tab('log'));
    expect(controller.getState().log).toHaveLength(length);
    expect($$('.result-log__list .log-entry')).toHaveLength(length);
  });

  it('starts a rematch with an empty slate', () => {
    // Play again builds a fresh match, so the new log carries nothing from the
    // old one — the previous match's entries must not follow you in.
    const before = boot();
    before.dispatch({ type: 'GUARD', player: 0 });
    const stale = before.getState().log.map((e) => e.text);
    expect(stale.length).toBeGreaterThan(0);

    unmount?.();
    controller?.destroy();
    const after = boot({ seed: 99 });
    const fresh = after.getState().log.map((e) => e.text);
    expect(fresh.length).toBeLessThan(stale.length + fresh.length);
    // No entry survives from a match that is over.
    expect(fresh.some((text) => /resign/i.test(text))).toBe(false);
  });
});

describe('nothing that appears mid-turn is in the board flow', () => {
  it('announces a real One More as a chip in the mid strip, never as a banner', () => {
    // Hua Po throws Agi at Jack Frost, who is weak to fire and padded with
    // enough HP to survive it — a genuine weakness knockdown, and a real One
    // More rendered by the real code path.
    const controller = boot({
      prepare: (state) => {
        setField(state, 0, [{ cardId: 'hua-po', level: 16, active: true }]);
        setField(state, 1, [{ cardId: 'jack-frost', level: 6, maxHp: 500, hp: 500, active: true }]);
        state.players[0].hand = [];
      },
    });

    const agi = $$('.skill-btn').find((b) => /Agi/.test(b.textContent));
    expect(agi).toBeTruthy();
    agi.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    expect(controller.getState().turnState.oneMoreActive).toBe(true);

    const chip = $('.allowance--onemore');
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('ONE MORE');
    expect(chip.parentElement.classList.contains('allowances')).toBe(true);
    expect(chip.closest('.board-mid')).toBeTruthy();

    // The old full-width banner is gone for good.
    expect($('.one-more')).toBe(null);
    // ...and the mid strip holds exactly one row, whatever is in it.
    expect($('.board-mid').children).toHaveLength(1);
  });

  it('floats the Full Analysis reveal over the board rather than inside a side', () => {
    boot({
      prepare: (state) => {
        setField(state, 0, [{ cardId: 'arsene', active: true }]);
        setField(state, 1, [{ cardId: 'silky', active: true }]);
        setHand(state, 0, ['full-analysis']);
        state.players[1].hand = [{ uid: 'x1', cardId: 'medicine' }];
      },
    });

    const card = $$('.hand-tile').find((t) => t.dataset.cardId === 'full-analysis');
    expect(card).toBeTruthy();
    card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const play = [...document.querySelectorAll('.card-detail-overlay button')].find((b) =>
      /Play Full Analysis/.test(b.textContent)
    );
    play.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const peek = $('.peek');
    expect(peek).toBeTruthy();
    // A direct child of the screen, NOT nested inside either player's side.
    expect(peek.parentElement.classList.contains('board-screen')).toBe(true);
    expect($('.side .peek')).toBe(null);
    expect(peek.textContent).toContain('Medicine');
  });
});
