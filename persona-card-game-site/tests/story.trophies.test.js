/**
 * @vitest-environment jsdom
 *
 * Story Mode stage 4: the trophy system.
 *
 * Three layers, tested at the level each one lives at:
 *
 *   the definitions   every trigger is exercised against a synthetic context,
 *                     because a trophy that cannot fire is worse than no trophy
 *   the store         persistence, and the hiding of the whole system until the
 *                     first one is earned
 *   the watcher       the three facts the engine does not record — the One More
 *                     chain, the low-water HP mark, and the biggest Phys hit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMenu } from '../src/ui/menu.js';
import { createMatch } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { BATTLES, BATTLE_COUNT, CHECKPOINT_AFTER_BATTLE, getBattle } from '../src/ui/story/campaign.js';
import {
  TROPHIES,
  TROPHY_IDS,
  SHELF_TROPHY_ID,
  WALLBREAKER_PHYS_DAMAGE,
  COMEBACK_HP_FRACTION,
  CHAIN_REACTION_LENGTH,
  getTrophy,
  earnedBy,
} from '../src/ui/story/trophies.js';
import {
  getEarnedTrophies,
  hasTrophy,
  awardTrophies,
  isShelfUnlocked,
  resetTrophies,
  reloadTrophies,
} from '../src/ui/story/trophyStore.js';
import { watchBattle } from '../src/ui/story/trophyWatch.js';
import { renderTrophies } from '../src/ui/story/trophyScreen.js';
import { renderStory } from '../src/ui/story/index.js';
import { resetStoryProgress, recordBattleCleared, recordBattleLost } from '../src/ui/story/progress.js';

let root;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  window.location.hash = '';
  localStorage.clear();
  resetStoryProgress();
  resetTrophies();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  renderStory(root, {});
  document.body.innerHTML = '';
  document.body.className = '';
  vi.useRealTimers();
});

const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/** A context in which nothing notable happened, to vary one field at a time. */
const NOTHING = {
  battle: getBattle(1),
  won: false,
  lossesBefore: 0,
  progress: { retriesUsed: 0, cleared: [], currentBattle: 1 },
  match: {
    oneMores: 0,
    fusions: 0,
    gallows: 0,
    technicals: 0,
    weaknessHits: 0,
    personasLost: 3,
    longestOneMore: 0,
    biggestPhysHit: 0,
    lowestHpFraction: 1,
  },
};

const ctx = (patch = {}) => ({ ...NOTHING, ...patch, match: { ...NOTHING.match, ...(patch.match ?? {}) } });
const fires = (id, context) => earnedBy(context).some((t) => t.id === id);

/* ------------------------------------------------------------------ *
 * The definitions
 * ------------------------------------------------------------------ */

describe('the trophy list', () => {
  it('is well formed: unique ids, and every field a screen renders', () => {
    expect(new Set(TROPHY_IDS).size).toBe(TROPHIES.length);
    for (const trophy of TROPHIES) {
      expect(typeof trophy.id, trophy.id).toBe('string');
      expect(trophy.name, trophy.id).toBeTruthy();
      expect(trophy.description, trophy.id).toBeTruthy();
      expect(trophy.icon, trophy.id).toBeTruthy();
      expect(typeof trophy.trigger, `${trophy.id} trigger`).toBe('function');
    }
  });

  it('holds the twelve the campaign was designed around', () => {
    expect(TROPHIES).toHaveLength(12);
    expect(getTrophy(SHELF_TROPHY_ID)).toBeTruthy();
    expect(getTrophy('nope')).toBeNull();
  });

  it('awards nothing at all for a battle in which nothing happened', () => {
    expect(earnedBy(ctx())).toEqual([]);
  });

  it('survives a trigger that throws instead of taking the result screen down', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // `match` missing entirely is the shape a bug would produce.
    expect(() => earnedBy({ battle: getBattle(1), won: true })).not.toThrow();
    spy.mockRestore();
  });
});

describe('every trigger fires on the thing it names, and not otherwise', () => {
  it('Unlock the Trophy Shelf — clearing Battle 1', () => {
    expect(fires(SHELF_TROPHY_ID, ctx({ won: true, battle: getBattle(1) }))).toBe(true);
    expect(fires(SHELF_TROPHY_ID, ctx({ won: false, battle: getBattle(1) }))).toBe(false);
    expect(fires(SHELF_TROPHY_ID, ctx({ won: true, battle: getBattle(2) }))).toBe(false);
  });

  it('Half Moon — reaching the checkpoint', () => {
    expect(fires('half-moon', ctx({ won: true, battle: getBattle(CHECKPOINT_AFTER_BATTLE) }))).toBe(true);
    expect(fires('half-moon', ctx({ won: true, battle: getBattle(CHECKPOINT_AFTER_BATTLE + 1) }))).toBe(false);
  });

  it('Nightfall — finishing the deck-identity block, the battle before the finale', () => {
    const last = getBattle(BATTLE_COUNT - 1);
    expect(fires('nightfall', ctx({ won: true, battle: last }))).toBe(true);
    expect(fires('nightfall', ctx({ won: false, battle: last }))).toBe(false);
    expect(fires('nightfall', ctx({ won: true, battle: getBattle(BATTLE_COUNT) }))).toBe(false);
  });

  it('Dawn — defeating Nyx', () => {
    expect(fires('dawn', ctx({ won: true, battle: getBattle(BATTLE_COUNT) }))).toBe(true);
    expect(fires('dawn', ctx({ won: true, battle: getBattle(BATTLE_COUNT - 1) }))).toBe(false);
  });

  it('First Blood — a One More, win or lose', () => {
    expect(fires('first-blood', ctx({ match: { oneMores: 1 } }))).toBe(true);
    expect(fires('first-blood', ctx())).toBe(false);
  });

  it('Chain Reaction — a chain of the full length in one turn', () => {
    expect(fires('chain-reaction', ctx({ match: { longestOneMore: CHAIN_REACTION_LENGTH } }))).toBe(true);
    expect(fires('chain-reaction', ctx({ match: { longestOneMore: CHAIN_REACTION_LENGTH - 1 } }))).toBe(false);
  });

  it('Alchemist — a fusion', () => {
    expect(fires('alchemist', ctx({ match: { fusions: 1 } }))).toBe(true);
    expect(fires('alchemist', ctx())).toBe(false);
  });

  it('Wallbreaker — the wall-breaking battle, won, on one big Phys hit', () => {
    const big = { biggestPhysHit: WALLBREAKER_PHYS_DAMAGE };
    // Keyed to whichever battle hands out the Wallbreaker deck, not to a number.
    const wall = BATTLES.find((b) => b.playerDeck === 'WALLBREAKER_DECK');
    const other = BATTLES.find((b) => b.playerDeck !== 'WALLBREAKER_DECK');
    expect(fires('wallbreaker', ctx({ won: true, battle: wall, match: big }))).toBe(true);
    // ...and each condition genuinely matters
    expect(fires('wallbreaker', ctx({ won: false, battle: wall, match: big }))).toBe(false);
    expect(fires('wallbreaker', ctx({ won: true, battle: other, match: big }))).toBe(false);
    expect(
      fires('wallbreaker', ctx({ won: true, battle: wall, match: { biggestPhysHit: WALLBREAKER_PHYS_DAMAGE - 1 } }))
    ).toBe(false);
  });

  it('Untouchable — a win with nothing knocked out', () => {
    expect(fires('untouchable', ctx({ won: true, match: { personasLost: 0 } }))).toBe(true);
    expect(fires('untouchable', ctx({ won: true, match: { personasLost: 1 } }))).toBe(false);
    expect(fires('untouchable', ctx({ won: false, match: { personasLost: 0 } }))).toBe(false);
  });

  it('Comeback — a win from under the HP line', () => {
    expect(fires('comeback', ctx({ won: true, match: { lowestHpFraction: COMEBACK_HP_FRACTION } }))).toBe(true);
    expect(fires('comeback', ctx({ won: true, match: { lowestHpFraction: COMEBACK_HP_FRACTION + 0.01 } }))).toBe(false);
    expect(fires('comeback', ctx({ won: false, match: { lowestHpFraction: 0 } }))).toBe(false);
  });

  it('Flawless Night — a boss beaten first time', () => {
    const boss = BATTLES.find((b) => b.boss);
    const ordinary = BATTLES.find((b) => !b.boss);
    expect(fires('flawless-night', ctx({ won: true, battle: boss, lossesBefore: 0 }))).toBe(true);
    expect(fires('flawless-night', ctx({ won: true, battle: boss, lossesBefore: 1 }))).toBe(false);
    expect(fires('flawless-night', ctx({ won: true, battle: ordinary, lossesBefore: 0 }))).toBe(false);
  });

  it('No Continues — the whole night with the tally still at zero', () => {
    const finale = getBattle(BATTLE_COUNT);
    expect(fires('no-continues', ctx({ won: true, battle: finale, progress: { retriesUsed: 0 } }))).toBe(true);
    expect(fires('no-continues', ctx({ won: true, battle: finale, progress: { retriesUsed: 1 } }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

describe('the trophy store', () => {
  it('awards, persists and reports', () => {
    expect(awardTrophies(['first-blood'])).toEqual(['first-blood']);
    expect(hasTrophy('first-blood')).toBe(true);
    expect(hasTrophy('dawn')).toBe(false);
    expect(Object.keys(reloadTrophies())).toEqual(['first-blood']);
  });

  it('never awards the same trophy twice', () => {
    awardTrophies(['first-blood']);
    expect(awardTrophies(['first-blood', 'alchemist'])).toEqual(['alchemist']);
    expect(awardTrophies(['first-blood'])).toEqual([]);
  });

  it('ignores ids that are not trophies', () => {
    expect(awardTrophies(['not-a-trophy'])).toEqual([]);
    expect(getEarnedTrophies()).toEqual({});
  });

  it('drops stored ids that no longer exist in the definitions', () => {
    localStorage.setItem(
      'pcg.story.trophies',
      JSON.stringify({ version: 1, earned: { 'first-blood': 1, 'deleted-trophy': 2 } })
    );
    expect(Object.keys(reloadTrophies())).toEqual(['first-blood']);
  });

  it('survives unreadable or stale storage', () => {
    localStorage.setItem('pcg.story.trophies', 'not json {');
    expect(reloadTrophies()).toEqual({});
    localStorage.setItem('pcg.story.trophies', JSON.stringify({ version: 0, earned: { dawn: 1 } }));
    expect(reloadTrophies()).toEqual({});
  });

  it('keeps the shelf when campaign progress is reset', () => {
    // Different lifetimes on purpose: starting the night again must not take
    // away what you already proved you could do.
    awardTrophies([SHELF_TROPHY_ID, 'half-moon']);
    recordBattleCleared(1);
    resetStoryProgress();
    expect(isShelfUnlocked()).toBe(true);
    expect(Object.keys(reloadTrophies()).sort()).toEqual([SHELF_TROPHY_ID, 'half-moon'].sort());
  });
});

/* ------------------------------------------------------------------ *
 * Hidden until unlocked
 * ------------------------------------------------------------------ */

describe('the shelf is hidden until it is earned', () => {
  it('is locked before the first trophy', () => {
    expect(isShelfUnlocked()).toBe(false);
  });

  it('shows no trophy UI anywhere on the menu or the campaign map', () => {
    renderMenu(root);
    expect(root.textContent).not.toMatch(/troph/i);

    renderStory(root, {});
    expect(root.textContent).not.toMatch(/troph/i);
  });

  it('sends a bookmarked shelf URL back to the menu rather than revealing it', () => {
    renderTrophies(root);
    expect(window.location.hash).toBe('#/');
    expect(root.querySelector('.trophy-grid')).toBeNull();
  });

  it('is opened by the first trophy, and only by that one', () => {
    awardTrophies(['first-blood']);
    expect(isShelfUnlocked()).toBe(false); // any trophy but the shelf one

    awardTrophies([SHELF_TROPHY_ID]);
    expect(isShelfUnlocked()).toBe(true);
  });

  it('appears on the menu and the map once unlocked', () => {
    awardTrophies([SHELF_TROPHY_ID]);

    renderMenu(root);
    const menuButton = $$('.btn').find((b) => b.textContent.includes('Trophy Shelf'));
    expect(menuButton).toBeTruthy();
    click(menuButton);
    expect(window.location.hash).toBe('#/trophies');

    window.location.hash = '';
    renderStory(root, {});
    const mapButton = $$('.story-map__actions .btn').find((b) => b.textContent.includes('Trophy Shelf'));
    expect(mapButton).toBeTruthy();
    click(mapButton);
    expect(window.location.hash).toBe('#/trophies');
  });
});

/* ------------------------------------------------------------------ *
 * The shelf itself
 * ------------------------------------------------------------------ */

describe('the trophy screen', () => {
  beforeEach(() => {
    awardTrophies([SHELF_TROPHY_ID, 'first-blood']);
  });

  it('lists every trophy, marking which are held', () => {
    renderTrophies(root);
    expect($$('.trophy')).toHaveLength(TROPHIES.length);
    expect($$('.trophy--earned')).toHaveLength(2);
    expect($$('.trophy--locked')).toHaveLength(TROPHIES.length - 2);
    expect(root.querySelector('.topbar__sub').textContent).toContain(`2 of ${TROPHIES.length}`);
  });

  it('shows a locked trophy as a goal — named, described, but plainly not held', () => {
    renderTrophies(root);
    const dawn = root.querySelector('[data-trophy="dawn"]');
    expect(dawn.className).toContain('trophy--locked');
    expect(dawn.textContent).toContain(getTrophy('dawn').name);
    expect(dawn.textContent).toContain(getTrophy('dawn').description);
    expect(dawn.textContent).toContain('Locked');
  });

  it('dates what has been earned', () => {
    renderTrophies(root);
    expect(root.querySelector(`[data-trophy="${SHELF_TROPHY_ID}"]`).textContent).toContain('Earned');
  });
});

/* ------------------------------------------------------------------ *
 * The watcher
 * ------------------------------------------------------------------ */

describe('the match watcher', () => {
  function harness() {
    const state = createMatch({
      seed: 4242,
      players: [
        { name: 'You', deckId: 'p3', archetype: 'tactical', controller: 'human' },
        { name: 'Foe', deckId: 'p4', archetype: 'aggressive', controller: 'bot', difficulty: 'easy' },
      ],
    });
    const controller = createController({ state, botPlayer: 1, botSeed: 1 });
    return { controller, watch: watchBattle(controller, 0) };
  }

  it('reports a quiet match as having done nothing', () => {
    const { controller, watch } = harness();
    const summary = watch.summary();
    expect(summary.longestOneMore).toBe(0);
    expect(summary.biggestPhysHit).toBe(0);
    expect(summary.personasLost).toBe(0);
    watch.stop();
    controller.destroy();
  });

  it('treats an empty field as full HP, not as a comeback', () => {
    // Before starters are chosen both fields are empty. Counting that as 0% HP
    // would hand Comeback to everyone who ever won a battle.
    const { controller, watch } = harness();
    expect(watch.summary().lowestHpFraction).toBe(1);
    watch.stop();
    controller.destroy();
  });

  it('passes every method the board uses through to the real controller', () => {
    // The wrapper stands in for the controller at mount time, so a method it
    // forgets is a crash on the board rather than a missing trophy.
    const { controller, watch } = harness();
    for (const method of ['getState', 'isBotTurn', 'isBusy', 'dispatch', 'legalActions', 'subscribe', 'start', 'setSpeed', 'destroy']) {
      expect(typeof watch.controller[method], method).toBe('function');
    }
    expect(watch.controller.getState()).toBe(controller.getState());
    watch.stop();
    controller.destroy();
  });

  it('stops observing once stopped', () => {
    const { controller, watch } = harness();
    watch.stop();
    const before = watch.summary().biggestPhysHit;
    controller.dispatch({ type: 'CHOOSE_STARTER', player: 0, cardId: controller.getState().starterOptions[0][0] });
    expect(watch.summary().biggestPhysHit).toBe(before);
    controller.destroy();
  });
});

/* ------------------------------------------------------------------ *
 * Awarding, end to end through the loss path
 * ------------------------------------------------------------------ */

describe('awarding on a real result', () => {
  it('does not award a win-only trophy for a battle that was lost', () => {
    recordBattleLost(1);
    expect(hasTrophy(SHELF_TROPHY_ID)).toBe(false);
    expect(isShelfUnlocked()).toBe(false);
  });
});
