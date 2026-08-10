/**
 * @vitest-environment jsdom
 *
 * Resignation through the actual UI: the button beside the log, the pause-menu
 * entry, the confirmation in front of both, and what each mode shows afterwards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, applyAction, getLegalActions } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { createHostSession, createGuestSession, GUEST_SEAT } from '../src/net/onlineMatch.js';

let root;
let unmount;
let controller;

function boot({ botPlayer = 1, viewer = 0, neutralResult = false, started = true } = {}) {
  let state = createMatch({
    seed: 77,
    players: [
      { name: 'You', deckId: 'p3', controller: 'human' },
      { name: 'Rival', deckId: 'p4', controller: botPlayer === null ? 'human' : 'bot', difficulty: 'medium' },
    ],
  });
  if (started) {
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });
  }
  controller = createController({ state, botPlayer, difficulty: 'medium', botSeed: 5 });
  unmount = mountBoard(root, { controller, viewer, title: 'Test', neutralResult, onExit() {} });
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

describe('reaching it', () => {
  it('puts a small button beside the battle log', () => {
    boot();
    const resign = $('.log-panel__resign');
    expect(resign).toBeTruthy();
    expect(resign.textContent).toMatch(/Resign/);
  });

  it('offers it in the pause menu too', () => {
    boot();
    click(byText('.topbar--game .btn', /Menu/));
    expect(byText('.menu-list .btn', /Resign the match/)).toBeTruthy();
  });

  it('offers it during starter selection, before a single card is played', () => {
    boot({ started: false });
    expect($('.log-panel__resign')).toBeTruthy();
  });

  it('is available on the opponent\'s turn, which is when you most want it', () => {
    const controller = boot({ botPlayer: null, viewer: 0 });
    const endTurn = getLegalActions(controller.getState(), 0).find((a) => a.type === 'END_TURN');
    controller.dispatch(endTurn);

    expect(controller.getState().activePlayer).toBe(1);
    expect(getLegalActions(controller.getState(), 0).some((a) => a.type === 'RESIGN')).toBe(false);
    expect($('.log-panel__resign')).toBeTruthy(); // the UI offers it anyway
  });

  it('disappears once the match is over', () => {
    const controller = boot();
    controller.dispatch({ type: 'RESIGN', player: 0 });
    expect($('.log-panel__resign')).toBe(null);
  });
});

describe('confirming', () => {
  it('asks before doing anything', () => {
    const controller = boot();
    click($('.log-panel__resign'));

    expect($('.modal')).toBeTruthy();
    expect($('.modal__head h3').textContent).toMatch(/Resign the match\?/);
    expect(controller.getState().winner).toBe(null); // nothing has happened yet
  });

  it('backs out cleanly', () => {
    const controller = boot();
    click($('.log-panel__resign'));
    click(byText('.modal .btn', /Keep playing/));

    expect($('.modal')).toBe(null);
    expect(controller.getState().winner).toBe(null);
  });

  it('resigns on confirmation, and the viewer loses', () => {
    const controller = boot();
    click($('.log-panel__resign'));
    click(byText('.modal .btn', /Yes, resign/));

    const state = controller.getState();
    expect(state.winner).toBe(1);
    expect(state.endReason).toBe('resign');
  });
});

describe('what you see afterwards', () => {
  /**
   * The match now ends on a short outro before the scoreboard. It is skippable
   * with a click, which is what these tests do — they are about the result
   * screen, and the flourish in front of it has its own file.
   */
  const skipOutro = () => {
    const outro = $('.match-outro');
    if (outro) click(outro);
  };

  it('vs bot: an instant loss, with the reason, the tips and a way out', () => {
    const controller = boot();
    click($('.log-panel__resign'));
    click(byText('.modal .btn', /Yes, resign/));
    skipOutro();

    const result = $('.result');
    expect(result).toBeTruthy();
    expect($('.result h2').textContent).toBe('Defeat');
    expect($('.result__reason').textContent).toMatch(/You resigned/);
    expect($('.result .tips')).toBeTruthy(); // post-loss advice
    expect($('.result .stats')).toBeTruthy(); // ...and the scoreboard
    expect(byText('.result__actions .btn', /Main menu/)).toBeTruthy();
  });

  it('hot-seat: the resigner loses and the result names the winner neutrally', () => {
    // Seat 0 is holding the device and concedes.
    const controller = boot({ botPlayer: null, viewer: 0, neutralResult: true });
    click($('.log-panel__resign'));
    click(byText('.modal .btn', /Yes, resign/));
    skipOutro();

    expect(controller.getState().winner).toBe(1);
    expect($('.result h2').textContent).toMatch(/Rival wins/);
    expect($('.result__reason').textContent).toMatch(/You resigned|Rival|resigned/);
  });

  it('tells the winner that the opponent resigned', () => {
    // Same match seen from the other seat.
    const controller = boot({ botPlayer: null, viewer: 1, neutralResult: false });
    controller.dispatch({ type: 'RESIGN', player: 0 });
    skipOutro();
    expect($('.result h2').textContent).toBe('Victory');
    expect($('.result__reason').textContent).toMatch(/resigned — you win!/);
  });
});

describe('online', () => {
  /** A pair of transports wired straight to each other. */
  function link() {
    const make = () => ({ handlers: [], closers: [], closed: false });
    const a = make();
    const b = make();
    const wire = (self, other) => ({
      get closed() {
        return self.closed;
      },
      send: (message) => {
        for (const handler of other.handlers) handler(JSON.parse(JSON.stringify(message)));
      },
      onMessage: (handler) => {
        self.handlers.push(handler);
        return () => {};
      },
      onClose: (handler) => {
        self.closers.push(handler);
        return () => {};
      },
      close: () => {
        self.closed = true;
      },
    });
    return [wire(a, b), wire(b, a)];
  }

  it('carries a guest resignation to the host, who is the one that decides', () => {
    const [hostWire, guestWire] = link();
    const host = createHostSession(hostWire, { hostName: 'Host', guestName: 'Guest', seed: 3 });
    const guest = createGuestSession(guestWire, { name: 'Guest' });
    host.start();

    guest.dispatch({ type: 'RESIGN', player: GUEST_SEAT });

    expect(host.getState().winner).toBe(0);
    expect(host.getState().endReason).toBe('resign');
    // The guest sees it too, from the host's authoritative broadcast.
    expect(guest.getState().winner).toBe(0);

    host.destroy();
    guest.destroy();
  });

  it('lets the guest resign on the host\'s turn, when it is not in their legal list', () => {
    const [hostWire, guestWire] = link();
    const host = createHostSession(hostWire, { hostName: 'Host', guestName: 'Guest', seed: 3 });
    const guest = createGuestSession(guestWire, { name: 'Guest' });
    host.start();

    const view = guest.getState();
    expect(getLegalActions(view, GUEST_SEAT).some((a) => a.type === 'RESIGN')).toBe(false);
    // Any other off-turn action is still refused locally.
    expect(() => guest.dispatch({ type: 'GUARD', player: GUEST_SEAT })).toThrow(/not something you can do/);
    expect(() => guest.dispatch({ type: 'RESIGN', player: GUEST_SEAT })).not.toThrow();
    expect(host.getState().winner).toBe(0);

    host.destroy();
    guest.destroy();
  });
});
