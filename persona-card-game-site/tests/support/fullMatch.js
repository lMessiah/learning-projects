/**
 * Harness for the "play a whole match through the real board UI" tests.
 *
 * Each match drives hundreds of actions and rebuilds the whole board every
 * time, so even one of them peaks at a few hundred MB of jsdom heap. Vitest
 * isolates per file, so the difficulties get ONE FILE EACH — botMatch.easy,
 * .medium, .brutal, .chaos — and this holds the harness they share.
 *
 * Do not put two matches in one file. Two in a single worker roughly doubles
 * its peak, and on a modest machine the worker is OOM-killed mid-run; vitest
 * reports that as "Worker exited unexpectedly" and quietly skips the file
 * rather than failing it, which is a very easy way to lose test coverage
 * without noticing.
 */
import { expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, createRng, CONFIG } from '../../src/engine/index.js';
import { chooseBotAction } from '../../src/engine/bot.js';
import { createController } from '../../src/ui/game/controller.js';
import { mountBoard } from '../../src/ui/game/board.js';

let root = null;
let unmount = null;
let controller = null;

/** Wire up the jsdom root and the fake clock the bot pacing runs on. */
export function useBoardHarness() {
  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    unmount?.();
    controller?.destroy();
    root?.remove();
    // Drop the references too: the controller holds a whole match state, and
    // the next test should not be running against the previous one's heap.
    unmount = null;
    controller = null;
    root = null;
    vi.useRealTimers();
  });
}

/**
 * Play a whole match through the UI. The human seat is driven by the medium
 * AI: a player who only ever ends their turn would never put Personas on the
 * field, so they could never be knocked out and the match would never finish.
 */
function playFullMatch(difficulty, seed) {
  const state = createMatch({
    seed,
    players: [
      { name: 'You', deckId: 'p3', controller: 'human' },
      { name: `Bot (${difficulty})`, deckId: 'p4', controller: 'bot', difficulty },
    ],
  });
  controller = createController({ state, botPlayer: 1, difficulty, botSeed: seed + 1 });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'Against Bot', subtitle: difficulty, onExit() {} });

  // Starter selection: click one of the three offered cards, let the bot pick.
  root.querySelectorAll('.starter-select .card')[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  vi.advanceTimersByTime(5000);

  let humanRng = createRng(seed * 13 + 5);
  for (let i = 0; i < 4000 && controller.getState().winner === null; i++) {
    const current = controller.getState();
    if (current.activePlayer === 0) {
      const [action, next] = chooseBotAction(current, 0, 'medium', humanRng);
      humanRng = next;
      if (!action) break;
      controller.dispatch(action);
    } else {
      vi.advanceTimersByTime(600);
    }
  }
  return controller.getState();
}

/** Run one difficulty to a decisive finish and assert the whole contract. */
export function expectDecisiveMatch(difficulty, seed = 7) {
  const errors = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));

  const state = playFullMatch(difficulty, seed);

  expect(errors).toEqual([]); // the controller logs here if the bot ever plays an illegal move
  expect(state.winner).not.toBe(null);
  expect(state.phase).toBe('gameOver');
  expect(state.players[state.winner === 0 ? 1 : 0].koCount).toBeGreaterThanOrEqual(CONFIG.KO_TARGET);

  // The match ends on a short outro. Click past it — its own behaviour is
  // covered in board.outro.test.js; what matters here is that it always hands
  // over to the scoreboard rather than being somewhere a real match can stall.
  const outro = root.querySelector('.match-outro');
  expect(outro).toBeTruthy();
  outro.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // The result overlay is on screen with a rematch route out.
  expect(root.querySelector('.result')).toBeTruthy();
  expect(root.querySelector('.result h2').textContent).toMatch(/Victory|Defeat/);

  // The log stays bounded however long the match ran — the state is deep
  // copied on every action, so an unbounded log would be quadratic.
  expect(state.log.length).toBeLessThanOrEqual(400);
  expect(root.querySelectorAll('.log-entry').length).toBeLessThanOrEqual(151);

  spy.mockRestore();
  return state;
}
