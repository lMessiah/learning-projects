/**
 * @vitest-environment jsdom
 *
 * Story Mode, end to end: play Battle 1 to a real win and check the campaign
 * moves on.
 *
 * This is the one thing tests/story.test.js cannot cover, because it costs a
 * whole match through the real board — a few hundred MB of jsdom heap. Vitest
 * isolates per file and this repo already gives each full match a file of its
 * own (see tests/support/fullMatch.js on why), so this file holds exactly one.
 *
 * The human seat is driven by the medium AI. A player who only ever ends their
 * turn never puts a Persona on the field, so nothing can be knocked out and the
 * match never finishes. Seed 6 is a driver seed under which that AI beats
 * Battle 1's fixed configuration in around 61 turns.
 *
 * Battle 1 assigns STARTER_DECK, so the human plays it whatever the save says —
 * which this test also checks, by wrecking the remembered choice first.
 *
 * The controller is captured by mocking the module rather than by adding a test
 * seam to `startBattle`: the production path stays exactly what ships.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRng } from '../src/engine/index.js';
import { chooseBotAction } from '../src/engine/bot.js';

/** Every controller the story route builds, in order. */
const built = [];

vi.mock('../src/ui/game/controller.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createController(...args) {
      const controller = actual.createController(...args);
      built.push(controller);
      return controller;
    },
  };
});

const { renderStory } = await import('../src/ui/story/index.js');
const progressModule = await import('../src/ui/story/progress.js');
const { getStoryProgress, resetStoryProgress, reloadStoryProgress, setChosenDeck } = progressModule;
const { BATTLES } = await import('../src/ui/story/campaign.js');
const { LOADOUTS } = await import('../src/ui/story/decks.js');
const { SHELF_TROPHY_ID } = await import('../src/ui/story/trophies.js');
const { isShelfUnlocked, hasTrophy, resetTrophies, reloadTrophies } = await import('../src/ui/story/trophyStore.js');
const { renderMenu } = await import('../src/ui/menu.js');

/** The driver seed the human seat plays Battle 1 under. */
const HUMAN_DRIVER_SEED = 6;

let root;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  window.location.hash = '';
  localStorage.clear();
  resetStoryProgress();
  resetTrophies();
  built.length = 0;
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  renderStory(root, {});
  for (const controller of built) controller.destroy();
  built.length = 0;
  document.body.innerHTML = '';
  document.body.className = '';
  vi.useRealTimers();
});

const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

describe('winning Battle 1', () => {
  it('advances the campaign, saves it, and offers Battle 2', () => {
    const errors = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args));

    // A remembered choice that is NOT the assigned deck. Battle 1 must ignore it.
    setChosenDeck({ deckId: 'p5', archetype: 'defensive' });

    renderStory(root, { battleNumber: 1 });
    const controller = built.at(-1);
    expect(controller, 'the story route built a controller').toBeTruthy();

    // Straight into the fight — no deck-select screen for an assigned battle.
    expect(root.querySelector('.board-screen')).toBeTruthy();
    const assigned = LOADOUTS[BATTLES[0].playerDeck];
    expect(controller.getState().players[0].deckId).toBe(assigned.deckId);

    vi.advanceTimersByTime(5000);

    let humanRng = createRng(HUMAN_DRIVER_SEED);
    for (let i = 0; i < 4000 && controller.getState().winner === null; i++) {
      const state = controller.getState();
      if (state.activePlayer === 0) {
        const [action, next] = chooseBotAction(state, 0, 'medium', humanRng);
        humanRng = next;
        if (!action) break;
        controller.dispatch(action);
      } else {
        vi.advanceTimersByTime(600);
      }
    }

    const finished = controller.getState();
    expect(errors).toEqual([]); // the controller logs here if the bot plays illegally
    expect(finished.winner).toBe(0);

    // Progress was written the moment the match ended, not when a button was
    // pressed — a player who closes the tab on the victory screen keeps the win.
    expect(getStoryProgress().cleared).toEqual([1]);
    expect(getStoryProgress().currentBattle).toBe(2);
    expect(reloadStoryProgress().currentBattle).toBe(2);

    // Click past the outro to the scoreboard, which carries the story's own
    // buttons rather than the generic "Play again" pair.
    click(root.querySelector('.match-outro'));
    const actions = [...root.querySelectorAll('.result__actions .btn')];
    const labels = actions.map((b) => b.textContent);
    expect(labels.some((l) => l.includes('Play again'))).toBe(false);
    expect(labels[0]).toContain(BATTLES[1].name);
    expect(labels.at(-1)).toContain('Campaign map');

    click(actions[0]);
    expect(window.location.hash).toBe('#/story/2');

    spy.mockRestore();
  });

  it('reveals the trophy shelf, which did not exist a moment earlier', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(isShelfUnlocked(), 'the shelf is hidden before the first win').toBe(false);

    renderStory(root, { battleNumber: 1 });
    const controller = built.at(-1);
    vi.advanceTimersByTime(5000);

    let humanRng = createRng(HUMAN_DRIVER_SEED);
    for (let i = 0; i < 4000 && controller.getState().winner === null; i++) {
      const state = controller.getState();
      if (state.activePlayer === 0) {
        const [action, next] = chooseBotAction(state, 0, 'medium', humanRng);
        humanRng = next;
        if (!action) break;
        controller.dispatch(action);
      } else {
        vi.advanceTimersByTime(600);
      }
    }
    expect(controller.getState().winner).toBe(0);

    // Earned, persisted, and announced as the reveal rather than as a routine
    // trophy — this is the one result screen that gets the bigger treatment.
    expect(hasTrophy(SHELF_TROPHY_ID)).toBe(true);
    expect(Object.keys(reloadTrophies())).toContain(SHELF_TROPHY_ID);

    click(root.querySelector('.match-outro'));
    const awards = root.querySelector('.trophy-awards');
    expect(awards).toBeTruthy();
    expect(awards.className).toContain('trophy-awards--reveal');
    expect(awards.textContent).toContain('unlocked the Trophy Shelf');
    expect(awards.querySelector(`[data-trophy="${SHELF_TROPHY_ID}"]`)).toBeTruthy();

    // And the rest of the app now admits trophies exist.
    const menuRoot = document.createElement('div');
    document.body.appendChild(menuRoot);
    renderMenu(menuRoot);
    expect(menuRoot.textContent).toMatch(/Trophy Shelf/);
    menuRoot.remove();

    spy.mockRestore();
  });
});
