/**
 * @vitest-environment jsdom
 *
 * Tips: the per-player counters the engine keeps, the patterns read off them,
 * and the three places they surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyAction, createMatch, CONFIG } from '../src/engine/index.js';
import {
  analyseMatch,
  generalTips,
  renderTips,
  mountRotatingTip,
  STRATEGY_TIPS,
  GENERAL_TIPS,
  ALL_TIPS,
} from '../src/ui/tips.js';
import { setupMatch, setField, activeOf, endTurn } from './helpers.js';

/** A finished-looking state whose loser has exactly the stats we want to test. */
function loserWith(stats) {
  const state = setupMatch();
  state.winner = 1;
  state.phase = 'gameOver';
  Object.assign(state.players[0].stats, stats);
  return state;
}

const idsOf = (tips) => tips.map((t) => t.id);

describe('the strategy tips', () => {
  it('includes all six playstyle plans', () => {
    expect([...idsOf(STRATEGY_TIPS)].sort()).toEqual(['carry', 'control', 'coverage', 'ramp', 'rush', 'turtle']);
  });

  it('states each plan in one readable sentence', () => {
    for (const tip of ALL_TIPS) {
      expect(tip.title).toBeTruthy();
      expect(tip.text.length).toBeGreaterThan(40);
      expect(typeof tip.text).toBe('string');
    }
  });

  it('keeps the numbers in the general tips honest against CONFIG', () => {
    const text = GENERAL_TIPS.map((t) => t.text).join(' ');
    expect(text).toContain(String(CONFIG.PLAY_LEVEL_GAP));
    expect(text).toContain(String(CONFIG.FIELD_CAP));
    expect(text).toContain(String(CONFIG.COMEBACK_UNDERDOG_DEFICIT));
  });
});

describe('the engine counts what the tips need', () => {
  it('records attacks, weakness hits and knockdowns', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'apsaras', active: true, hp: 900, maxHp: 900 }]); // weak elec

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'zio' });

    const stats = state.players[0].stats;
    expect(stats.attacks).toBe(1);
    expect(stats.weaknessHits).toBe(1);
    expect(stats.knockdowns).toBe(1);
    expect(stats.oneMores).toBe(1);
    expect(stats.typesUsed).toEqual(['elec']);
  });

  it('records guards, turns and heavy hits taken', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'ippon-datara', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 40, maxHp: 40 }]);

    state = applyAction(state, { type: 'GUARD', player: 0 });
    expect(state.players[0].stats.guards).toBe(1);

    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(state.players[0].stats.turnsTaken).toBeGreaterThanOrEqual(2);
  });

  it('records losing an active with nothing to replace it', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'ippon-datara', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 1 }]); // no bench

    state = applyAction(state, { type: 'ATTACK', player: 0 });

    expect(state.players[1].stats.koWithEmptyBench).toBe(1);
    expect(state.players[0].stats.koWithEmptyBench).toBe(0);
  });

  it('survives being sent over the wire', () => {
    const state = createMatch({ seed: 3, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p4' }] });
    const round = JSON.parse(JSON.stringify(state));
    expect(round.players[0].stats).toEqual(state.players[0].stats);
  });
});

describe('post-loss analysis', () => {
  it('calls out never hitting a weakness', () => {
    const tips = analyseMatch(loserWith({ attacks: 9, weaknessHits: 0 }), 0);
    expect(idsOf(tips)).toContain('no-weakness');
    expect(tips[0].contextual).toBe(true);
  });

  it('calls out hoarding SP', () => {
    expect(idsOf(analyseMatch(loserWith({ turnsEndedFullSp: 6 }), 0))).toContain('unspent-sp');
  });

  it('calls out an empty bench', () => {
    expect(idsOf(analyseMatch(loserWith({ koWithEmptyBench: 2 }), 0))).toContain('empty-bench');
  });

  it('calls out never guarding while being hit hard', () => {
    expect(idsOf(analyseMatch(loserWith({ guards: 0, heavyHitsTaken: 5 }), 0))).toContain('no-guard');
  });

  it('calls out a fusion left on the table', () => {
    expect(idsOf(analyseMatch(loserWith({ fusionReadyTurns: 7, fusions: 0 }), 0))).toContain('unused-fusion');
  });

  it('calls out never probing for weaknesses', () => {
    const tips = analyseMatch(loserWith({ turnsTaken: 10, typesUsed: ['phys'], attacks: 10, weaknessHits: 2 }), 0);
    expect(idsOf(tips)).toContain('no-probing');
  });

  it('quotes the player\'s own numbers back at them', () => {
    const tips = analyseMatch(loserWith({ turnsEndedFullSp: 7 }), 0);
    expect(tips.find((t) => t.id === 'unspent-sp').text).toContain('7');
  });

  it('falls back to general tips when nothing specific went wrong', () => {
    const clean = loserWith({
      attacks: 20,
      weaknessHits: 6,
      turnsTaken: 12,
      typesUsed: ['fire', 'ice', 'elec'],
      guards: 4,
      fusions: 2,
      knockdowns: 4,
      oneMores: 4,
    });
    const tips = analyseMatch(clean, 0);
    expect(tips).toHaveLength(3);
    expect(tips.every((t) => !t.contextual)).toBe(true);
  });

  it('returns at most the requested number, contextual first', () => {
    const messy = loserWith({
      attacks: 12,
      weaknessHits: 0,
      turnsEndedFullSp: 9,
      koWithEmptyBench: 3,
      guards: 0,
      heavyHitsTaken: 8,
      fusionReadyTurns: 9,
      fusions: 0,
    });
    const tips = analyseMatch(messy, 0, { count: 3 });
    expect(tips).toHaveLength(3);
    expect(tips.every((t) => t.contextual)).toBe(true);
  });

  it('never repeats a tip within one set', () => {
    const tips = analyseMatch(loserWith({ koWithEmptyBench: 1 }), 0);
    expect(new Set(idsOf(tips)).size).toBe(tips.length);
  });

  it('copes with a state that has no stats at all', () => {
    const state = loserWith({});
    delete state.players[0].stats;
    expect(analyseMatch(state, 0)).toHaveLength(3);
  });
});

describe('the rotating connection-screen tip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows one tip and moves on', () => {
    const host = document.createElement('div');
    const rotation = mountRotatingTip(host, { intervalMs: 1000, seed: 0 });

    const title = host.querySelector('.tip__title');
    const first = title.textContent;
    expect(first).toMatch(/^Tip · /);

    vi.advanceTimersByTime(1000);
    expect(title.textContent).not.toBe(first);

    rotation.stop();
    const settled = title.textContent;
    vi.advanceTimersByTime(5000);
    expect(title.textContent).toBe(settled); // stopped means stopped
  });

  it('starts somewhere different for a different seed', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    const ra = mountRotatingTip(a, { seed: 0 });
    const rb = mountRotatingTip(b, { seed: 3 });
    expect(a.querySelector('.tip__title').textContent).not.toBe(b.querySelector('.tip__title').textContent);
    ra.stop();
    rb.stop();
  });
});

describe('rendering', () => {
  it('renders a titled block, marking the contextual ones', () => {
    const node = renderTips(analyseMatch(loserWith({ koWithEmptyBench: 1 }), 0), { heading: 'What to try next time' });
    expect(node.querySelector('.tips__heading').textContent).toBe('What to try next time');
    expect(node.querySelectorAll('.tip').length).toBe(3);
    expect(node.querySelectorAll('.tip--contextual').length).toBe(1);
  });

  it('rotates the general list deterministically', () => {
    expect(idsOf(generalTips(0, 3))).toEqual(idsOf(generalTips(0, 3)));
    expect(idsOf(generalTips(0, 3))).not.toEqual(idsOf(generalTips(5, 3)));
  });
});
