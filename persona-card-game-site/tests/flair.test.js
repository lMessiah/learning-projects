/**
 * @vitest-environment jsdom
 *
 * Custom messages — the two things a full trophy shelf unlocks.
 *
 * Four layers, tested where each one lives:
 *
 *   the store      what a player types is cleaned, capped and kept (ui/flair.js)
 *   the gate       who is allowed to type it at all, and what the Trophy Shelf
 *                  shows to everybody else (ui/story/trophyScreen.js)
 *   the board      the victory line on the result screen, and the knockout note
 *                  (ui/game/board.js, ui/game/flairOverlay.js)
 *   the wire       a note crossing a real host/guest pair (net/onlineMatch.js)
 *
 * And one promise underneath all of it: neither message changes a rule. The
 * last section is the one that fails loudly if that ever stops being true.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createMatch, applyAction, getLegalActions } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { mountFlairOverlay, FLAIR_LINGER_MS, FLAIR_MIN_GAP_MS } from '../src/ui/game/flairOverlay.js';
import {
  FLAIR_FIELDS,
  FLAIR_LIMITS,
  cleanFlairText,
  clearFlair,
  getFlair,
  hasFlair,
  reloadFlair,
  setFlair,
} from '../src/ui/flair.js';
import { TROPHIES, TROPHY_IDS, SHELF_TROPHY_ID } from '../src/ui/story/trophies.js';
import { awardTrophies, resetTrophies } from '../src/ui/story/trophyStore.js';
import { renderTrophies, isFlairUnlocked, hasEveryTrophy } from '../src/ui/story/trophyScreen.js';
import { activateAdmin, deactivateAdmin, reloadAdmin } from '../src/ui/admin.js';
import { renderHowTo } from '../src/ui/tutorial/index.js';
import { setField } from './helpers.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { createHostSession, createGuestSession, HOST_SEAT, GUEST_SEAT } from '../src/net/onlineMatch.js';

const REPO = resolvePath(__dirname, '..');

let root;
let unmount;
let controller;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  window.location.hash = '';
  localStorage.clear();
  resetTrophies();
  clearFlair();
  deactivateAdmin();
  reloadAdmin();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  unmount = null;
  controller = null;
  document.body.innerHTML = '';
  root = null;
  vi.useRealTimers();
});

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

function change(input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

describe('what a player types', () => {
  it('keeps an ordinary line exactly as written', () => {
    expect(setFlair({ win: 'Better luck next time!' }).win).toBe('Better luck next time!');
    expect(getFlair().win).toBe('Better luck next time!');
  });

  it('starts empty, and knows it', () => {
    expect(getFlair()).toEqual({ win: '', knockout: '' });
    expect(hasFlair()).toBe(false);
    setFlair({ knockout: 'gg' });
    expect(hasFlair()).toBe(true);
  });

  it('collapses newlines and tabs, because both places it lands are one line', () => {
    expect(cleanFlairText('two\nlines\there')).toBe('two lines here');
    expect(setFlair({ knockout: '  spaced   out  ' }).knockout).toBe('spaced out');
  });

  it('strips control characters rather than putting them in the DOM', () => {
    expect(cleanFlairText('be\u0007ware')).toBe('be ware');
    expect(cleanFlairText('tab\there')).toBe('tab here');
  });

  it('cuts each field to its own limit', () => {
    const long = 'x'.repeat(200);
    expect(setFlair({ win: long }).win).toHaveLength(FLAIR_LIMITS.win);
    expect(setFlair({ knockout: long }).knockout).toHaveLength(FLAIR_LIMITS.knockout);
    // The knockout note has more room than the heading, which has to stay a
    // heading. If that ever inverts, the result screen is the thing that breaks.
    expect(FLAIR_LIMITS.knockout).toBeGreaterThan(FLAIR_LIMITS.win);
  });

  it('leaves the other field alone when only one is written', () => {
    setFlair({ win: 'Mine', knockout: 'Down' });
    setFlair({ win: 'Yours' });
    expect(getFlair()).toEqual({ win: 'Yours', knockout: 'Down' });
  });

  it('survives a reload, and cleans what it finds there', () => {
    setFlair({ win: 'Saved' });
    expect(reloadFlair().win).toBe('Saved');

    // Hand-edited storage: over-long, multi-line, and not to be trusted.
    localStorage.setItem(
      'pcg.flair',
      JSON.stringify({ version: 1, win: `a\nb${'!'.repeat(200)}`, knockout: 'ok' })
    );
    const loaded = reloadFlair();
    expect(loaded.win).toHaveLength(FLAIR_LIMITS.win);
    expect(loaded.win).not.toContain('\n');
    expect(loaded.knockout).toBe('ok');
  });

  it('ignores a save written by some other version', () => {
    localStorage.setItem('pcg.flair', JSON.stringify({ version: 99, win: 'from the future' }));
    expect(reloadFlair()).toEqual({ win: '', knockout: '' });
  });

  it('throws both away on demand', () => {
    setFlair({ win: 'a', knockout: 'b' });
    expect(clearFlair()).toEqual({ win: '', knockout: '' });
    expect(reloadFlair()).toEqual({ win: '', knockout: '' });
  });

  it('has a limit for every field it offers', () => {
    for (const field of FLAIR_FIELDS) expect(FLAIR_LIMITS[field]).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

describe('who is allowed to write one', () => {
  const awardAll = () => awardTrophies([...TROPHY_IDS]);

  it('stays locked while a single trophy is missing', () => {
    awardTrophies(TROPHY_IDS.slice(0, -1));
    expect(hasEveryTrophy()).toBe(false);
    expect(isFlairUnlocked()).toBe(false);
  });

  it('opens on the last trophy', () => {
    awardAll();
    expect(hasEveryTrophy()).toBe(true);
    expect(isFlairUnlocked()).toBe(true);
  });

  it('opens for admin even with the shelf wiped', () => {
    activateAdmin();
    resetTrophies(); // admin awards every trophy; this takes them straight back
    expect(hasEveryTrophy()).toBe(false);
    expect(isFlairUnlocked()).toBe(true);
  });

  it('shows the locked line, and no inputs, on a part-full shelf', () => {
    awardTrophies([SHELF_TROPHY_ID]);
    renderTrophies(root);
    expect($('.flair-editor__locked')).toBeTruthy();
    expect($$('input[data-flair]')).toHaveLength(0);
  });

  it('offers one input per message once the shelf is full', () => {
    awardAll();
    renderTrophies(root);
    expect($('.flair-editor__locked')).toBeFalsy();
    expect($$('input[data-flair]').map((i) => i.dataset.flair)).toEqual([...FLAIR_FIELDS]);
  });

  it('saves what is typed, and shows it back cleaned', () => {
    awardAll();
    renderTrophies(root);
    const win = $('input[data-flair="win"]');
    change(win, '   Not even close   ');

    expect(win.value).toBe('Not even close');
    expect(reloadFlair().win).toBe('Not even close');
  });

  it('caps the input in the browser as well as on the way in', () => {
    awardAll();
    renderTrophies(root);
    for (const field of FLAIR_FIELDS) {
      expect($(`input[data-flair="${field}"]`).maxLength).toBe(FLAIR_LIMITS[field]);
    }
  });

  it('shows what was written last time the screen is opened again', () => {
    awardAll();
    setFlair({ knockout: 'Down you go' });
    renderTrophies(root);
    expect($('input[data-flair="knockout"]').value).toBe('Down you go');
  });

  it('clears both from one button', () => {
    awardAll();
    setFlair({ win: 'a', knockout: 'b' });
    renderTrophies(root);
    click([...root.querySelectorAll('.flair-editor button')].find((b) => /clear/i.test(b.textContent)));

    expect(reloadFlair()).toEqual({ win: '', knockout: '' });
    expect($$('input[data-flair]').every((i) => i.value === '')).toBe(true);
  });

  it('is reached from the shelf, which is itself still gated', () => {
    // No trophies at all: the shelf bounces to the menu, so there is nothing to
    // edit and no hint that there is anything to unlock.
    renderTrophies(root);
    expect(window.location.hash).toBe('#/');
    expect($('.flair-editor')).toBeFalsy();
  });
});

/* ------------------------------------------------------------------ *
 * The victory line
 * ------------------------------------------------------------------ */

describe('the victory line', () => {
  /** A live match that then ends in front of the mounted board. */
  function boot({ winner = 0, viewer = 0, neutralResult = false } = {}) {
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
    controller = createController({ state, botPlayer: null });
    unmount = mountBoard(root, {
      controller,
      viewer: neutralResult ? () => 0 : viewer,
      title: 'Test',
      neutralResult,
      onExit() {},
    });
    controller.dispatch({ type: 'RESIGN', player: 1 - winner });
    // Past the outro, which is a separate screen with its own test file.
    vi.advanceTimersByTime(4000);
    return controller;
  }

  const heading = () => $('.result h2');

  it('says Victory when nothing has been written', () => {
    boot({ winner: 0 });
    expect(heading().textContent).toBe('Victory');
    expect(heading().className).toBe('');
  });

  it('says what the player wrote when they win', () => {
    setFlair({ win: 'Told you.' });
    boot({ winner: 0 });
    expect(heading().textContent).toBe('Told you.');
    expect(heading().className).toContain('result__title--custom');
  });

  it('does not use it on a defeat — it is a victory line', () => {
    setFlair({ win: 'Told you.' });
    boot({ winner: 1 });
    expect(heading().textContent).toBe('Defeat');
  });

  it('keeps the factual reason underneath it', () => {
    setFlair({ win: 'Told you.' });
    boot({ winner: 0 });
    expect($('.result__reason').textContent).toMatch(/resigned/i);
  });

  it('stays out of a shared-screen result, where only one of the two wrote it', () => {
    setFlair({ win: 'Told you.' });
    boot({ winner: 0, neutralResult: true });
    expect(heading().textContent).toBe('You wins');
  });

  it('is capped before it is ever a heading', () => {
    setFlair({ win: 'y'.repeat(500) });
    boot({ winner: 0 });
    expect(heading().textContent).toHaveLength(FLAIR_LIMITS.win);
  });
});

/* ------------------------------------------------------------------ *
 * The knockout note
 * ------------------------------------------------------------------ */

describe('the knockout note', () => {
  /** A controller-shaped stub: enough for the overlay, and nothing else. */
  function fakeController({ online = false } = {}) {
    const listeners = new Set();
    const flairListeners = new Set();
    let state = {
      players: [
        { id: 0, name: 'You', koCount: 0 },
        { id: 1, name: 'Them', koCount: 0 },
      ],
      winner: null,
    };
    return {
      sent: [],
      getState: () => state,
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      ...(online
        ? {
            sendFlair(text) {
              this.sent.push(text);
              return true;
            },
            onFlair(fn) {
              flairListeners.add(fn);
              return () => flairListeners.delete(fn);
            },
          }
        : {}),
      /** Move the match on: `kos` is [player0Losses, player1Losses]. */
      push(kos, meta) {
        state = {
          ...state,
          players: state.players.map((p, i) => ({ ...p, koCount: kos[i] })),
        };
        for (const fn of listeners) fn(state, meta);
      },
      /** Pretend the peer sent one. */
      receive(payload) {
        for (const fn of flairListeners) fn(payload);
      },
    };
  }

  function mount(ctrl, options = {}) {
    unmount = mountFlairOverlay(root, { controller: ctrl, viewer: 0, ...options });
    return $('.flair-note');
  }

  it('appears when you knock one of theirs out', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController();
    const note = mount(ctrl);

    expect(note.hidden).toBe(true);
    ctrl.push([0, 1]);

    expect(note.hidden).toBe(false);
    expect(note.querySelector('.flair-note__text').textContent).toBe('Sit down.');
    expect(note.querySelector('.flair-note__who').textContent).toBe('You');
    expect(note.classList.contains('flair-note--mine')).toBe(true);
  });

  it('stays away when they knock one of yours out', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController();
    const note = mount(ctrl);
    ctrl.push([1, 0]);
    expect(note.hidden).toBe(true);
  });

  it('says nothing at all when nothing was written', () => {
    const ctrl = fakeController();
    const note = mount(ctrl);
    ctrl.push([0, 1]);
    expect(note.hidden).toBe(true);
  });

  it('goes away on its own', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController();
    const note = mount(ctrl);
    ctrl.push([0, 1]);

    vi.advanceTimersByTime(FLAIR_LINGER_MS + 500);
    expect(note.hidden).toBe(true);
  });

  it('sends it to the opponent when there is one to send it to', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController({ online: true });
    mount(ctrl);
    ctrl.push([0, 1]);
    expect(ctrl.sent).toEqual(['Sit down.']);
  });

  it('survives a send that fails — a lost note is not a lost match', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController({ online: true });
    ctrl.sendFlair = () => {
      throw new Error('connection lost');
    };
    const note = mount(ctrl);
    expect(() => ctrl.push([0, 1])).not.toThrow();
    expect(note.hidden).toBe(false);
  });

  it('shows theirs when it arrives, attributed to them', () => {
    const ctrl = fakeController({ online: true });
    const note = mount(ctrl);
    ctrl.receive({ from: 1, text: 'Was that it?' });

    expect(note.hidden).toBe(false);
    expect(note.querySelector('.flair-note__text').textContent).toBe('Was that it?');
    expect(note.querySelector('.flair-note__who').textContent).toBe('Them');
    expect(note.classList.contains('flair-note--theirs')).toBe(true);
  });

  it('cleans what arrives from the wire rather than trusting it', () => {
    const ctrl = fakeController({ online: true });
    const note = mount(ctrl);
    ctrl.receive({ text: `spam\nspam${'!'.repeat(400)}` });

    const shown = note.querySelector('.flair-note__text').textContent;
    expect(shown).toHaveLength(FLAIR_LIMITS.knockout);
    expect(shown).not.toContain('\n');
  });

  it('ignores a peer sending them faster than a person could', () => {
    let clock = 0;
    const ctrl = fakeController({ online: true });
    unmount = mountFlairOverlay(root, { controller: ctrl, viewer: 0, now: () => clock });
    const note = $('.flair-note');

    ctrl.receive({ text: 'first' });
    clock += FLAIR_MIN_GAP_MS - 1;
    ctrl.receive({ text: 'second' });
    expect(note.querySelector('.flair-note__text').textContent).toBe('first');

    clock += FLAIR_MIN_GAP_MS;
    ctrl.receive({ text: 'third' });
    expect(note.querySelector('.flair-note__text').textContent).toBe('third');
  });

  it('says nothing about a reconnect, which is not a knockout happening', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController();
    const note = mount(ctrl);
    ctrl.push([0, 3], { resync: true });
    expect(note.hidden).toBe(true);
  });

  it('takes itself apart on unmount', () => {
    setFlair({ knockout: 'Sit down.' });
    const ctrl = fakeController();
    mount(ctrl);
    unmount();
    unmount = null;

    expect($('.flair-note')).toBeFalsy();
    // And the subscription really went with it.
    expect(() => ctrl.push([0, 1])).not.toThrow();
    expect($('.flair-note')).toBeFalsy();
  });

  it('is inert without a controller', () => {
    expect(() => mountFlairOverlay(root, { controller: null, viewer: 0 })()).not.toThrow();
    expect($('.flair-note')).toBeFalsy();
  });
});

/* ------------------------------------------------------------------ *
 * The board mounts it — except where there is no "you"
 * ------------------------------------------------------------------ */

describe('where the note is mounted', () => {
  function bootBoard(viewer) {
    const state = createMatch({
      seed: 7,
      players: [
        { name: 'You', deckId: 'p3', controller: 'human' },
        { name: 'Them', deckId: 'p4', controller: 'human' },
      ],
    });
    controller = createController({ state, botPlayer: null });
    unmount = mountBoard(root, { controller, viewer, title: 'Test', onExit() {} });
  }

  it('mounts beside the board in a normal match', () => {
    bootBoard(0);
    expect($('.flair-note')).toBeTruthy();
  });

  it('sits out hot-seat, where one screen is two players', () => {
    // Hot-seat passes a function: the viewpoint follows whoever is holding the
    // device, so there is no seat the note could be written from.
    bootBoard(() => 0);
    expect($('.flair-note')).toBeFalsy();
  });

  it("takes the caller's opt-out", () => {
    const state = createMatch({
      seed: 7,
      players: [
        { name: 'You', deckId: 'p3', controller: 'human' },
        { name: 'Them', deckId: 'p4', controller: 'human' },
      ],
    });
    controller = createController({ state, botPlayer: null });
    unmount = mountBoard(root, { controller, viewer: 0, title: 'Test', flair: false, onExit() {} });
    expect($('.flair-note')).toBeFalsy();
  });

  it('is opted out by the tutorial, whose coach owns that corner', () => {
    setFlair({ knockout: 'Sit down.' });
    renderHowTo(root, { lessonId: 'basics' });

    expect(root.querySelector('.board-screen')).toBeTruthy();
    expect(root.querySelector('.flair-note')).toBeFalsy();
    // And the coach is still the board's immediate neighbour, which is what
    // keeps it beside the board rather than over it.
    const coach = root.querySelector('.coach');
    expect(coach.previousElementSibling).toBe(root.querySelector('.board-screen'));

    renderHowTo(root, {}); // tear the lesson's controller down
  });
});

/* ------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------ */

describe('a note crossing a real connection', () => {
  function pair() {
    const [hostLink, guestLink] = createLoopbackPair();
    const host = createHostSession(hostLink, { seed: 3, autoTick: false });
    const guest = createGuestSession(guestLink, { name: 'Guest', autoTick: false });
    host.start();
    return { host, guest };
  }

  it('goes host to guest', () => {
    const { host, guest } = pair();
    const seen = [];
    guest.onFlair((payload) => seen.push(payload));

    host.sendFlair('Sit down.');
    expect(seen).toEqual([{ from: HOST_SEAT, text: 'Sit down.' }]);

    host.destroy();
    guest.destroy();
  });

  it('goes guest to host', () => {
    const { host, guest } = pair();
    const seen = [];
    host.onFlair((payload) => seen.push(payload));

    guest.sendFlair('Was that it?');
    expect(seen).toEqual([{ from: GUEST_SEAT, text: 'Was that it?' }]);

    host.destroy();
    guest.destroy();
  });

  it('changes nothing about the match it travels through', () => {
    const { host, guest } = pair();
    const before = JSON.stringify(host.getState());
    const legalBefore = getLegalActions(host.getState(), HOST_SEAT).length;

    guest.sendFlair('anything at all');
    host.sendFlair('anything at all');

    expect(JSON.stringify(host.getState())).toBe(before);
    expect(getLegalActions(host.getState(), HOST_SEAT)).toHaveLength(legalBefore);

    host.destroy();
    guest.destroy();
  });

  it('reports failure quietly rather than throwing at the player', () => {
    const { host, guest } = pair();
    host.destroy();
    guest.destroy();

    expect(() => guest.sendFlair('into the void')).not.toThrow();
    expect(guest.sendFlair('into the void')).toBe(false);
    expect(() => host.sendFlair('into the void')).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * The promise
 * ------------------------------------------------------------------ */

describe('they change no rules', () => {
  it('is never mentioned anywhere in the engine', () => {
    const dir = resolvePath(REPO, 'src/engine');
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(resolvePath(dir, name), 'utf8');
      expect(source.toLowerCase(), `src/engine/${name}`).not.toContain('flair');
    }
  });

  it('gives every trophy a reason to exist — the reward needs all of them', () => {
    // Guards the guard: if a trophy were ever unearnable, this unlock would be
    // unreachable, and that is a content bug rather than a code one.
    expect(TROPHIES.length).toBeGreaterThan(1);
    expect(TROPHY_IDS).toContain(SHELF_TROPHY_ID);
  });

  it('leaves the legal moves alone whatever is written', () => {
    let state = createMatch({
      seed: 11,
      players: [
        { name: 'You', deckId: 'p3' },
        { name: 'Them', deckId: 'p4' },
      ],
    });
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
    const before = JSON.stringify(getLegalActions(state, 0));

    setFlair({ win: 'anything', knockout: 'at all' });
    expect(JSON.stringify(getLegalActions(state, 0))).toBe(before);
  });
});
