/**
 * @vitest-environment jsdom
 *
 * The post-match scoreboard, and the engine book-keeping it reads.
 *
 * The tracking is the interesting half: it all funnels through `applyDamage`
 * and `koPersona`, so a Burn tick counts exactly as much as a skill does and
 * the KO timeline is complete however long the match ran.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, applyAilment, createMatch, getLegalActions, CONFIG } from '../src/engine/index.js';
import { chooseBotAction } from '../src/engine/bot.js';
import { createRng } from '../src/engine/rng.js';
import { renderMatchStats, summarise, mvpOf } from '../src/ui/matchStats.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf, endTurn } from './helpers.js';

function board() {
  const state = setupMatch({ seed: 8080 });
  setField(state, 0, [
    { cardId: 'ippon-datara', level: 20, active: true },
    { cardId: 'silky', level: 20 },
  ]);
  setField(state, 1, [
    { cardId: 'jack-frost', level: 6, active: true },
    { cardId: 'angel', level: 6 },
  ]);
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

/** A short bot-vs-bot match, so the numbers under test are real ones. */
function playedOut(seed = 606) {
  let state = createMatch({
    seed,
    players: [
      { name: 'A', deckId: 'p3', archetype: 'aggressive', controller: 'bot', difficulty: 'brutal' },
      { name: 'B', deckId: 'p5', archetype: 'tactical', controller: 'bot', difficulty: 'brutal' },
    ],
  });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
  state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });

  let rng = createRng(seed + 1);
  for (let i = 0; i < 3000 && state.winner === null; i++) {
    const [action, next] = chooseBotAction(state, state.activePlayer, 'brutal', rng);
    rng = next;
    if (!action) break;
    state = applyAction(state, action);
  }
  return state;
}

describe('damage ledger', () => {
  it('credits the attacker and debits the defender', () => {
    const state = board();
    const before = state.players[1].field[0].hp;
    const next = applyAction(state, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'bash',
      targetUid: uidOf(state, 1, 'jack-frost'),
    });
    const dealt = before - next.players[1].field[0].hp;

    expect(next.players[0].stats.damageDealt).toBe(dealt);
    expect(next.players[1].stats.damageTaken).toBe(dealt);
    // The HP cost of a physical skill is self-inflicted: taken, never "dealt".
    expect(next.players[1].stats.damageDealt).toBe(0);
  });

  it('counts damage a player does to themselves as taken only', () => {
    const state = board();
    state.players[0].fatigue = 2;
    const next = endTurn(state, 0); // player 1's turn; then hand it back
    const back = endTurn(next, 1);

    expect(back.players[0].stats.damageTaken).toBeGreaterThan(0);
    expect(back.players[0].stats.damageDealt).toBe(0);
    expect(back.players[1].stats.damageDealt).toBe(0);
  });

  it('counts a Burn tick, which no attack ever touched', () => {
    const state = board();
    applyAilment(state, activeOf(state, 1), 'burn');
    const next = endTurn(endTurn(state, 0), 1);
    expect(next.players[1].stats.damageTaken).toBeGreaterThanOrEqual(CONFIG.BURN_DAMAGE);
  });
});

describe('biggest hit', () => {
  it('records the amount, the skill and both Personas', () => {
    const state = board();
    const next = applyAction(state, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'bash',
      targetUid: uidOf(state, 1, 'jack-frost'),
    });

    const hit = next.players[0].stats.biggestHit;
    expect(hit).toBeTruthy();
    expect(hit.source).toBe('Bash');
    expect(hit.by).toBe('Ippon-Datara');
    expect(hit.target).toBe('Jack Frost');
    expect(hit.amount).toBeGreaterThan(0);
  });

  it('only ever moves upward', () => {
    let state = board();
    state = applyAction(state, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'assault-dive',
      targetUid: uidOf(state, 1, 'jack-frost'),
    });
    const big = state.players[0].stats.biggestHit.amount;

    state.turnState.actionsRemaining = 1;
    state = applyAction(state, { type: 'ATTACK', player: 0, targetUid: uidOf(state, 1, 'jack-frost') });
    expect(state.players[0].stats.biggestHit.amount).toBe(big);
    expect(state.players[0].stats.biggestHit.source).toBe('Assault Dive');
  });

  it('names a Special or a basic attack as its own source', () => {
    const state = board();
    setHand(state, 0, ['armageddon']);
    const next = applyAction(state, {
      type: 'PLAY_SPECIAL',
      player: 0,
      handUid: handUidOf(state, 0, 'armageddon'),
    });
    expect(next.players[0].stats.biggestHit.source).toBe('Armageddon');
  });
});

describe('the knockout timeline', () => {
  it('records every knockout in order, with who scored it', () => {
    const state = playedOut();
    const timeline = state.koTimeline;

    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.length).toBe(state.players[0].koCount + state.players[1].koCount);
    for (const [i, entry] of timeline.entries()) {
      expect([0, 1]).toContain(entry.owner);
      expect(typeof entry.cardId).toBe('string');
      if (i > 0) expect(entry.turn).toBeGreaterThanOrEqual(timeline[i - 1].turn);
    }
  });

  it('is complete even after the log has thrown its early entries away', () => {
    const state = playedOut(909);
    // The log is capped; the timeline is not, and a decisive match reaches the
    // knockout target, so every one of those must be in it.
    const loser = state.players[0].koCount >= CONFIG.KO_TARGET ? 0 : 1;
    if (state.endReason === 'ko-target') {
      expect(state.koTimeline.filter((e) => e.owner === loser)).toHaveLength(CONFIG.KO_TARGET);
    }
  });
});

describe('MVP', () => {
  it('is the Persona that did the most damage', () => {
    const state = board();
    const hitter = activeOf(state, 0);
    hitter.dmgDealt = 300;
    hitter.kos = 2;
    state.players[0].field[1].dmgDealt = 40;

    const mvp = mvpOf(state, 0);
    expect(mvp.persona.uid).toBe(hitter.uid);
    expect(mvp.damage).toBe(300);
    expect(mvp.kos).toBe(2);
  });

  it('breaks a damage tie on knockouts', () => {
    const state = board();
    state.players[0].field[0].dmgDealt = 100;
    state.players[0].field[0].kos = 0;
    state.players[0].field[1].dmgDealt = 100;
    state.players[0].field[1].kos = 3;
    expect(mvpOf(state, 0).persona.uid).toBe(state.players[0].field[1].uid);
  });

  it('is null for a side that never landed a blow', () => {
    expect(mvpOf(board(), 1)).toBe(null);
  });

  it('survives its Persona being knocked out and left on the field', () => {
    const state = playedOut();
    for (const player of state.players) {
      const mvp = mvpOf(state, player.id);
      if (!mvp) continue;
      expect(mvp.damage).toBeGreaterThan(0);
      // Being dead does not un-earn the damage.
      expect(typeof mvp.persona.ko).toBe('boolean');
    }
  });
});

describe('rendering', () => {
  it('shows both sides, every headline number and the timeline', () => {
    const state = playedOut();
    const node = renderMatchStats(state);

    expect(node.querySelectorAll('.stats-col')).toHaveLength(2);
    expect(node.querySelector('.stats__meta').textContent).toContain(`${state.turn} turns`);

    const labels = [...node.querySelectorAll('.stats-table__label')].map((n) => n.textContent);
    for (const wanted of [
      'Damage dealt',
      'Damage taken',
      'One Mores',
      'Technicals',
      'Fusions',
      'Gallows',
      'Showtimes',
      'Cards drawn',
      'Cards played',
      'SP spent',
    ]) {
      expect(labels, `missing "${wanted}"`).toContain(wanted);
    }

    expect(node.querySelector('.ko-timeline')).toBeTruthy();
    expect(node.querySelectorAll('.ko-timeline__item').length).toBe(state.koTimeline.length);
    expect(node.textContent).toMatch(/Biggest hit/);
    expect(node.textContent).toMatch(/MVP/);
  });

  it('prints the real numbers, not placeholders', () => {
    const state = playedOut();
    const summary = summarise(state, 0);
    const dealt = summary.rows.find(([label]) => label === 'Damage dealt')[1];
    expect(dealt).toBe(state.players[0].stats.damageDealt);
    expect(dealt).toBeGreaterThan(0);
  });

  it('copes with a match that ended before anything happened', () => {
    const state = applyAction(setupMatch(), { type: 'RESIGN', player: 0 });
    const node = renderMatchStats(state);
    expect(node.textContent).toContain('Nobody was knocked out.');
    expect(node.textContent).toContain('never landed one');
  });
});
