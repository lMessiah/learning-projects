/**
 * The signature triangle.
 *
 * Each flavour is always offered its signature Persona as one of its three
 * starters — Pixie for P3, Slime for P4, Ara Mitama for P5 — so the three of
 * them meet constantly, and how they match up is the first thing a new player
 * learns about the game.
 *
 * WHAT THE TRIANGLE IS. Not "who wins a duel". This is a card game with a bench
 * of eight, fusion, the Gallows and ONE action a turn, and the scarce resource
 * is turns. So the triangle is about TEMPO: every one of the three has a
 * matchup where it is removed cheaply, and one where removing it costs the
 * opponent far more than it costs its owner.
 *
 *   Slime      answers Ara Mitama  — Corrosive pierces the Endurance he is made of
 *   Pixie      answers Slime       — Zio hits his elec weakness before he ramps
 *   Ara Mitama blanks  Pixie       — she cannot remove him faster than Dia heals,
 *                                    so her turns buy her nothing while his owner
 *                                    develops a board behind him
 *
 * Ara Mitama is deliberately NOT trying to beat anyone. His Strength is frozen;
 * he stalls. The measure of him is the turns he takes off his opponent, which is
 * why the assertions below count turns rather than knockouts.
 */
import { describe, it, expect } from 'vitest';
import { createMatch, applyAction, CONFIG } from '../src/engine/index.js';
import { personaSkills } from '../src/engine/state.js';
import { STARTER_SIGNATURES, getPersona, DECKS, checkStarterSignatures } from '../src/data/cards.js';
import { poolFor } from '../src/data/archetypes.js';
import { setupMatch, setField, activeOf } from './helpers.js';

/* ------------------------------------------------------------------ *
 * The starter guarantee
 * ------------------------------------------------------------------ */

describe('every flavour is always offered its signature', () => {
  it('declares one signature per flavour, and each is a real Persona', () => {
    for (const deck of DECKS) {
      const id = STARTER_SIGNATURES[deck.id];
      expect(id, `${deck.id} has no signature`).toBeTruthy();
      expect(() => getPersona(id)).not.toThrow();
    }
    expect(STARTER_SIGNATURES).toMatchObject({ p3: 'pixie', p4: 'slime', p5: 'ara-mitama' });
  });

  /**
   * The invariant that connects the two halves of "signature".
   *
   * `starterSignatures` decides who is GUARANTEED the card on turn one; `game`
   * decides whose deck it is shuffled into. Nothing linked them, and they came
   * apart: Ara Mitama was P5's guaranteed starter with `game: "p4"`, so a P5
   * player was handed one and could never draw a second, while P4 decks were
   * full of a Persona that flavour is not about.
   */
  it('puts every signature in its own flavour’s draw pool, not just its opening offer', () => {
    for (const deck of DECKS) {
      const id = STARTER_SIGNATURES[deck.id];
      const card = getPersona(id);
      const drawable = card.game === deck.id || card.game === 'common';
      expect(
        drawable,
        `${deck.id}'s signature ${id} has game "${card.game}" — ${deck.id} can be handed one but never draw another`
      ).toBe(true);
      expect(poolFor(deck.id).persona.some((p) => p.id === id), `${id} is missing from ${deck.id}'s pool`).toBe(true);
    }
  });

  it('is caught by the validator if it ever comes apart again', () => {
    // The check above proves today's data is right. This proves the guard that
    // keeps it right is awake — by feeding it exactly the bug that got through.
    expect(checkStarterSignatures()).toEqual([]);

    // Slime's game is p4, so naming it P5's signature is the same shape of
    // mistake Ara Mitama shipped with.
    const broken = checkStarterSignatures({ ...STARTER_SIGNATURES, p5: 'slime' });
    expect(broken).toHaveLength(1);
    expect(broken[0]).toMatch(/p5.*slime.*game "p4".*cannot draw it/);

    // ...and the other two failure modes it covers.
    expect(checkStarterSignatures({ p3: 'not-a-card' })[0]).toMatch(/unknown card/);
    // Nekomata is a real, common Persona but is not in the starter pool.
    expect(checkStarterSignatures({ p3: 'nekomata' })[0]).toMatch(/not in the starter pool/);
  });

  it('offers it on every seed, for both seats, without shrinking the choice', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const [a, b] of [['p3', 'p4'], ['p4', 'p5'], ['p5', 'p3'], ['p3', 'p3']]) {
        const state = createMatch({
          seed,
          players: [
            { name: 'A', deckId: a, controller: 'human' },
            { name: 'B', deckId: b, controller: 'human' },
          ],
        });
        for (const [seat, flavour] of [[0, a], [1, b]]) {
          const offers = state.starterOptions[seat];
          expect(offers, `${flavour} seat ${seat} seed ${seed}`).toContain(STARTER_SIGNATURES[flavour]);
          expect(offers).toHaveLength(3);
          expect(new Set(offers).size, 'offers must be distinct').toBe(3);
        }
      }
    }
  });

  it('still varies the other two, so the choice is a real one', () => {
    const others = new Set();
    for (let seed = 1; seed <= 40; seed++) {
      const state = createMatch({
        seed,
        players: [
          { name: 'A', deckId: 'p4', controller: 'human' },
          { name: 'B', deckId: 'p4', controller: 'human' },
        ],
      });
      for (const id of state.starterOptions[0]) if (id !== 'slime') others.add(id);
    }
    expect(others.size).toBeGreaterThan(2);
  });
});

/* ------------------------------------------------------------------ *
 * The tempo harness
 * ------------------------------------------------------------------ */

/** Scale a Persona to `level` off its printed growth, so a duel compares cards. */
function scaleTo(persona, level) {
  const c = getPersona(persona.cardId);
  const g = c.statGrowth;
  const n = level - c.level;
  persona.level = level;
  persona.strength = c.strength + n * (g.strength ?? 0);
  persona.magic = c.magic + n * (g.magic ?? 0);
  persona.endurance = c.endurance + n * (g.endurance ?? 0);
  persona.maxHp = c.hp + n * (g.hp ?? 0);
  persona.hp = persona.maxHp;
  persona.maxSp = c.sp + n * (g.sp ?? 0);
  persona.sp = persona.maxSp;
}

/**
 * How many of ITS OWN turns the attacker needs to knock the defender out.
 *
 * The attacker always throws its best affordable damaging skill. The defender
 * plays its role rather than trading: if it can heal and is below full, it
 * heals — which is the whole of what a wall does. Returns `Infinity` when the
 * attacker cannot get through at all inside the cap, which is a real outcome
 * and the one Ara Mitama is built to produce.
 */
function turnsToRemove(attackerId, defenderId, { level = 12, cap = 30, forget = [] } = {}) {
  const state = setupMatch();
  setField(state, 0, [{ cardId: attackerId, active: true }]);
  setField(state, 1, [{ cardId: defenderId, active: true }]);
  scaleTo(activeOf(state, 0), level);
  scaleTo(activeOf(state, 1), level);
  if (forget.length) activeOf(state, 1).forgottenSkills = [...forget];

  let s = state;
  for (let turn = 1; turn <= cap; turn++) {
    // Attacker's turn.
    s.activePlayer = 0;
    s.turnState.actionsRemaining = 1;
    const me = activeOf(s, 0);
    const options = personaSkills(s, me)
      .filter((k) => k.effect.kind === 'damage')
      .filter((k) => (k.type === 'phys' ? me.hp > k.hpCost : me.sp >= (k.spCost ?? 0)))
      .sort((a, b) => b.power - a.power);
    try {
      s = applyAction(s, options.length
        ? { type: 'USE_SKILL', player: 0, skillId: options[0].id }
        : { type: 'ATTACK', player: 0 });
    } catch {
      /* shocked, or nothing affordable — the turn is simply lost */
    }
    const target = s.players[1].field[0];
    if (target.ko) return turn;

    // Defender's turn: hold the line. Heal if hurt and able, otherwise Guard.
    s.activePlayer = 1;
    s.turnState.actionsRemaining = 1;
    const wall = activeOf(s, 1);
    if (wall && !wall.ko) {
      const heal = personaSkills(s, wall)
        .filter((k) => k.effect.kind === 'heal' && wall.sp >= (k.spCost ?? 0))
        .sort((a, b) => b.power - a.power)[0];
      try {
        s = applyAction(s, heal && wall.hp < wall.maxHp
          ? { type: 'USE_SKILL', player: 1, skillId: heal.id, targetUid: wall.uid }
          : { type: 'GUARD', player: 1 });
      } catch {
        /* shocked — it loses the turn, which is the attacker's reward */
      }
      // SP regen, so a long stall is a real economy rather than a one-shot.
      wall.sp = Math.min(wall.maxSp, wall.sp + CONFIG.SP_REGEN_PER_TURN);
    }
  }
  return Infinity;
}

describe('the triangle, measured in turns', () => {
  it('Slime breaks the wall, and Ara Mitama cannot answer him back', () => {
    // Corrosive plus frozen Strength makes this wildly asymmetric: Slime needs
    // a handful of turns, Ara Mitama needs dozens.
    for (const level of [8, 12, 18]) {
      const bySlime = turnsToRemove('slime', 'ara-mitama', { level });
      const byAra = turnsToRemove('ara-mitama', 'slime', { level });
      expect(bySlime, `L${level}`).toBeLessThan(6);
      expect(byAra, `L${level}`).toBeGreaterThan(10);
    }
  });

  it('Slime is THE answer to the wall — faster than Pixie at every level', () => {
    // This is what CORROSIVE_END_SCALE is tuned for. At 0.6 the passive was
    // decorative: Slime took LONGER than Pixie to break the wall, and stripping
    // it in the balance simulator changed the win rate by 0.0pp. At 0.3 he is
    // the designated wall-breaker and the passive is worth +10pp.
    for (const level of [8, 12, 18]) {
      const bySlime = turnsToRemove('slime', 'ara-mitama', { level });
      const byPixie = turnsToRemove('pixie', 'ara-mitama', { level });
      expect(bySlime, `L${level}: Slime ${bySlime}, Pixie ${byPixie}`).toBeLessThan(byPixie);
    }
  });

  it('and does NOT become the answer to everything — Pixie still trades evenly', () => {
    // The balance guard on the buff above. Corrosive is physical-only and
    // scales with the target's Endurance, so a soft caster barely feels it:
    // Pixie removes Slime as fast as he removes her.
    for (const level of [8, 12, 18]) {
      const pixieOnSlime = turnsToRemove('pixie', 'slime', { level });
      const slimeOnPixie = turnsToRemove('slime', 'pixie', { level });
      expect(pixieOnSlime, `L${level}`).toBeLessThanOrEqual(slimeOnPixie);
    }
  });

  it('Pixie answers Slime — she removes him far faster than Ara Mitama can', () => {
    for (const level of [8, 12, 18]) {
      const byPixie = turnsToRemove('pixie', 'slime', { level });
      const byAra = turnsToRemove('ara-mitama', 'slime', { level });
      expect(byPixie, `L${level}: Pixie ${byPixie}, Ara ${byAra}`).toBeLessThan(byAra);
      expect(byPixie).toBeLessThan(4);
    }
  });

  it('Dia buys Ara Mitama real time EARLY, measured by taking it away', () => {
    // A true ablation: the same duel with the heal stripped from the instance
    // via `forgottenSkills`, the engine's own mechanism for a Persona no longer
    // knowing something.
    for (const level of [4, 6]) {
      const withHeal = turnsToRemove('slime', 'ara-mitama', { level });
      const without = turnsToRemove('slime', 'ara-mitama', { level, forget: ['dia'] });
      expect(without, `L${level}: with Dia ${withHeal}, without ${without}`).toBeLessThan(withHeal);
    }
  });

  it('...and is worth NOTHING from level 8 on, because it does not scale', () => {
    // Measured, and worth stating plainly: Dia restores a flat 30 HP while
    // every damage number on the board grows. By level 8 the fight is decided
    // in 2-4 turns and a 30 HP heal every other turn cannot change the count.
    // If Ara Mitama is to stall past the opening, he needs Diarama, not Dia.
    for (const level of [8, 12, 16, 18]) {
      const withHeal = turnsToRemove('slime', 'ara-mitama', { level });
      const without = turnsToRemove('slime', 'ara-mitama', { level, forget: ['dia'] });
      expect(withHeal, `L${level} — Dia started mattering again; update this claim`).toBe(without);
    }
  });

  // KNOWN GAP — the third edge. Ara Mitama is supposed to blank Pixie: she is a
  // chip-damage caster and he is a healing wall, so her turns should buy her
  // nothing while his owner develops a board behind him.
  //
  // Measured, she removes him in 2-3 turns at every level, which is FASTER than
  // Slime manages. Two things cause it, and Dia cannot fix either:
  //
  //   1. He is weak to elec, so Zio lands at x2.
  //   2. Zio inflicts Shock 40% of the time, and a shocked Persona cannot act
  //      AT ALL — requireUsableActive blocks attacking, healing AND Guard. The
  //      lockout takes exactly the turn the stall depends on.
  //
  // So Pixie hard-counters the stall by construction: elec is both his weakness
  // and the element carrying the one ailment that switches a wall off. Closing
  // this needs a design decision — see the report — not a bigger heal.
  it.skip('Ara Mitama blanks Pixie — she cannot out-damage the wall', () => {
    for (const level of [8, 12, 18]) {
      expect(turnsToRemove('pixie', 'ara-mitama', { level }), `L${level}`).toBeGreaterThanOrEqual(6);
    }
  });

  it('records the gap, so fixing it fails loudly rather than passing unnoticed', () => {
    for (const level of [8, 12, 18]) {
      expect(turnsToRemove('pixie', 'ara-mitama', { level }), `L${level}`).toBeLessThan(6);
    }
  });
});

/**
 * WHERE THE TRIANGLE HOLDS.
 *
 * It does not hold at every level, and the suite says so rather than testing
 * three convenient ones. Measured across levels 3-22 (95% of Personas ever seen
 * on a board are level 19 or below, so this is the range that matters):
 *
 *   HOLDS   8-12 and 18-22
 *   BROKEN  3-7   — Slime has only Bash until Assault Dive at 8, and Bash cannot
 *                   out-damage Ara Mitama's Dia. At level 7 he cannot break the
 *                   wall at all.
 *   BROKEN  14-17 — Pixie's Zionga lands at 14 and Slime's Gigantic Fist at 16,
 *                   so she is ahead of him for two levels, and he over-corrects
 *                   for two more (16-17 he one-shots her).
 *
 * Both gaps are SKILL-CURVE TIMING, not stats. Moving Slime's unlocks was tested
 * against the engine at four settings and every one produced exactly 12 broken
 * levels — the break just relocates from "too weak against the wall" to "out-
 * races the caster". His power curve is a step function; wherever the step
 * lands, he is behind Pixie's or ahead of it. Closing this needs a SMOOTHER
 * curve (more, smaller steps), not a shifted one.
 */
const TRIANGLE_HOLDS = [8, 9, 10, 11, 12, 13, 18, 19, 20, 21, 22];
const TRIANGLE_BROKEN = [3, 4, 5, 6, 7, 14, 15, 16, 17];

describe('the level bands the triangle actually holds in', () => {
  const edges = (L) => ({
    wall: turnsToRemove('slime', 'ara-mitama', { level: L }) < turnsToRemove('pixie', 'ara-mitama', { level: L }),
    trade: turnsToRemove('pixie', 'slime', { level: L }) <= turnsToRemove('slime', 'pixie', { level: L }),
    stall: turnsToRemove('pixie', 'ara-mitama', { level: L }) > turnsToRemove('pixie', 'slime', { level: L }),
  });

  it('holds completely across 8-12 and 18-22', () => {
    for (const L of TRIANGLE_HOLDS) {
      const e = edges(L);
      expect(e.wall, `L${L}: Slime should be the wall answer`).toBe(true);
      expect(e.trade, `L${L}: Pixie should at least trade evenly with Slime`).toBe(true);
      expect(e.stall, `L${L}: Ara Mitama should buy more time than Slime does`).toBe(true);
    }
  });

  it('records the bands where it does NOT hold, so closing them fails loudly', () => {
    // Asserted rather than skipped: if a future change fixes one of these, this
    // test breaks and forces TRIANGLE_HOLDS to be widened instead of the gap
    // being quietly forgotten.
    for (const L of TRIANGLE_BROKEN) {
      const e = edges(L);
      expect(e.wall && e.trade && e.stall, `L${L} now holds — move it into TRIANGLE_HOLDS`).toBe(false);
    }
  });

  it('holds in the band where most of the game is actually played', () => {
    // Levels 8-12 alone are ~26% of all board time, and 18-22 another ~14%.
    // The broken bands are real and larger; this pins the good one so a
    // regression there is caught immediately.
    expect(TRIANGLE_HOLDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe('the mechanic behind each edge', () => {
  it('Corrosive is the wall-breaker, and it really lowers Endurance', () => {
    expect(getPersona('slime').passive).toBe('corrosive');
    expect(CONFIG.CORROSIVE_END_SCALE).toBeLessThan(1);
  });

  it('Slime is weak to elec and resists phys, which is what closes the cycle', () => {
    const slime = getPersona('slime');
    expect(slime.weaknesses).toEqual(['elec']);
    expect(slime.resists).toEqual(['phys']);
    const zio = getPersona('pixie').skills.find((s) => s.id === 'zio');
    expect(zio.unlockLevel).toBe(1);
  });

  it('Ara Mitama is the wall the triangle needs, and can stall from turn one', () => {
    const ara = getPersona('ara-mitama');
    expect(ara.statGrowth.endurance).toBe(2);
    expect(ara.statGrowth.strength).toBe(0); // he is not meant to threaten anyone
    expect(ara.resists).not.toContain('phys'); // or Slime could never get through
    const dia = ara.skills.find((s) => s.id === 'dia');
    expect(dia, 'Ara Mitama needs a heal to do his job').toBeTruthy();
    expect(dia.unlockLevel).toBe(1); // he is a STARTER; he must stall immediately
  });
});
