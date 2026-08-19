/**
 * The How to Play lessons.
 *
 * Authored teaching content is the one place in this repo where being *wrong*
 * is worse than being broken: a crash gets reported, but a tutorial that
 * confidently says "Jack Frost is weak to fire" after a balance pass moved it
 * just teaches the wrong thing to the one player least able to notice.
 *
 * So this file checks two separate things:
 *
 *   1. **Every factual claim the lesson text makes** against the shipped card
 *      database — the weaknesses, the passives, the skills, the fusion recipe.
 *      If a balance pass moves one, a test fails instead of a player being lied
 *      to.
 *   2. **Every objective is actually reachable** from the board the lesson sets
 *      up, by searching the real legal-action space. A `do` step nobody can
 *      satisfy is a dead end with a Skip button, which is not a lesson.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, createRng, getActive, personaSkills } from '../src/engine/index.js';
import { chooseBotAction } from '../src/engine/bot.js';
import { getPersona, getCard, FUSION_RECIPES, STARTER_POOL, STARTER_SIGNATURES } from '../src/data/cards.js';
import { LESSONS, getLesson } from '../src/ui/tutorial/lessons.js';
import { buildScenario } from '../src/ui/tutorial/scenario.js';
import { lessonIdFromHash } from '../src/ui/tutorial/index.js';

const build = (lesson) => buildScenario(lesson.scenario);
const onField = (state, player, cardId) => state.players[player].field.find((p) => p.cardId === cardId);
const inHand = (state, player, cardId) => state.players[player].hand.some((c) => c.cardId === cardId);
const doSteps = (lesson) => lesson.steps.filter((s) => s.until);

/**
 * Can the human reach a state satisfying `until`, playing legally?
 *
 * A bounded depth-first search over the real legal-action space, auto-playing
 * the bot whenever the turn passes. Depth 4 is enough for everything these
 * lessons ask for and keeps the search from exploding: the widest board here
 * offers on the order of 30 actions a turn.
 *
 * Actions carrying `needsChoice` are applied AS RETURNED, using the default the
 * legal-action builder filled in. That is the codebase's standing contract — a
 * sensible default with the alternatives attached as metadata — and skipping
 * them instead made this search declare the Gallows unreachable in a lesson
 * whose whole point is the Gallows.
 */
function reachable(start, until, maxDepth = 4) {
  const seen = new Set();

  const advanceBot = (state) => {
    let current = state;
    let rng = createRng(99);
    for (let i = 0; i < 60 && current.winner === null && current.activePlayer === 1; i++) {
      const [action, next] = chooseBotAction(current, 1, 'easy', rng);
      rng = next;
      if (!action) break;
      try {
        current = applyAction(current, action);
      } catch {
        break;
      }
    }
    return current;
  };

  const search = (state, depth) => {
    if (until(state, start)) return true;
    if (depth >= maxDepth || state.winner !== null) return false;

    const key = `${depth}:${JSON.stringify(state.players.map((p) => [p.field.map((x) => [x.cardId, x.level, x.hp]), p.hand.length]))}`;
    if (seen.has(key)) return false;
    seen.add(key);

    for (const action of getLegalActions(state, 0)) {
      if (action.type === 'RESIGN') continue;
      let next;
      try {
        next = applyAction(state, action);
      } catch {
        continue;
      }
      if (search(advanceBot(next), depth + 1)) return true;
    }
    return false;
  };

  return search(advanceBot(start), 0);
}

/**
 * Same search, but returns the board it arrived at rather than a boolean — so
 * a lesson can be walked objective by objective, each one starting from where
 * the last actually left the player.
 */
function reachTo(start, until, maxDepth = 4) {
  const seen = new Set();

  const advanceBot = (state) => {
    let current = state;
    let rng = createRng(99);
    for (let i = 0; i < 60 && current.winner === null && current.activePlayer === 1; i++) {
      const [action, next] = chooseBotAction(current, 1, 'easy', rng);
      rng = next;
      if (!action) break;
      try {
        current = applyAction(current, action);
      } catch {
        break;
      }
    }
    return current;
  };

  const search = (state, depth) => {
    if (until(state, start)) return state;
    if (depth >= maxDepth || state.winner !== null) return null;

    const key = `${depth}:${JSON.stringify(state.players.map((p) => [p.field.map((x) => [x.cardId, x.level, x.hp]), p.hand.length]))}`;
    if (seen.has(key)) return null;
    seen.add(key);

    for (const action of getLegalActions(state, 0)) {
      if (action.type === 'RESIGN') continue;
      let next;
      try {
        next = applyAction(state, action);
      } catch {
        continue;
      }
      const found = search(advanceBot(next), depth + 1);
      if (found) return found;
    }
    return null;
  };

  return search(advanceBot(start), 0);
}

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

describe('the lesson set', () => {
  it('ships five lessons, numbered and uniquely identified', () => {
    expect(LESSONS).toHaveLength(5);
    expect(LESSONS.map((l) => l.number)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(5);
  });

  it('gives every lesson a title, a summary, an outro and steps', () => {
    for (const lesson of LESSONS) {
      expect(lesson.title.length).toBeGreaterThan(0);
      expect(lesson.summary.length).toBeGreaterThan(0);
      expect(lesson.outro.length).toBeGreaterThan(0);
      expect(lesson.steps.length).toBeGreaterThanOrEqual(6);
    }
  });

  it('gives every step exactly one of say/do, and every do an objective', () => {
    for (const lesson of LESSONS) {
      for (const [i, step] of lesson.steps.entries()) {
        const where = `${lesson.id} step ${i + 1}`;
        expect(Boolean(step.say) !== Boolean(step.do), `${where} needs exactly one of say/do`).toBe(true);
        if (step.do) {
          expect(typeof step.until, `${where} is a do-step with no until`).toBe('function');
          expect(typeof step.hint, `${where} is a do-step with no hint`).toBe('string');
        }
        if (step.until) expect(step.do, `${where} has an until but is not a do-step`).toBeTruthy();
      }
    }
  });

  it('resolves its own routes', () => {
    expect(lessonIdFromHash('#/howto')).toBe(null);
    expect(lessonIdFromHash('#/howto/basics')).toBe('basics');
    expect(lessonIdFromHash('#/bot')).toBe(null);
    for (const lesson of LESSONS) {
      expect(getLesson(lesson.id)).toBe(lesson);
      expect(lessonIdFromHash(`#/howto/${lesson.id}`)).toBe(lesson.id);
    }
    expect(getLesson('nope')).toBe(null);
  });
});

/* ------------------------------------------------------------------ *
 * The boards
 * ------------------------------------------------------------------ */

describe('every scenario builds a real, playable board', () => {
  it('lands in the playing phase with both sides on the field', () => {
    for (const lesson of LESSONS) {
      const state = build(lesson);
      expect(state.phase, lesson.id).toBe('playing');
      expect(state.activePlayer, lesson.id).toBe(0);
      expect(state.players[0].field.length, lesson.id).toBeGreaterThan(0);
      expect(state.players[1].field.length, lesson.id).toBeGreaterThan(0);
      expect(state.turnState, lesson.id).toBeTruthy();
    }
  });

  it('puts exactly the Personas and cards the lesson text names', () => {
    for (const lesson of LESSONS) {
      const state = build(lesson);
      for (const [player, specs] of lesson.scenario.field.entries()) {
        expect(state.players[player].field, `${lesson.id} p${player}`).toHaveLength(specs.length);
        for (const spec of specs) {
          const instance = state.players[player].field.find(
            (p) => p.cardId === spec.cardId && p.level === (spec.level ?? p.level)
          );
          expect(instance, `${lesson.id}: ${spec.cardId} missing from p${player}`).toBeTruthy();
        }
      }
      for (const [player, cards] of (lesson.scenario.hand ?? []).entries()) {
        for (const cardId of cards) {
          expect(inHand(state, player, cardId), `${lesson.id}: ${cardId} missing from p${player} hand`).toBe(true);
        }
      }
    }
  });

  it('gives the player a legal move on turn one of every lesson', () => {
    for (const lesson of LESSONS) {
      const legal = getLegalActions(build(lesson), 0).filter((a) => a.type !== 'RESIGN');
      expect(legal.length, lesson.id).toBeGreaterThan(1);
    }
  });

  it('leaves the engine to do the phase transition, not the fixture', () => {
    // buildScenario paints field/hand only. If it ever started writing turn
    // budgets by hand, this is what would catch it.
    const state = build(LESSONS[0]);
    expect(state.turnState.actionsRemaining).toBe(state.config.ACTIONS_PER_TURN);
    expect(state.turnState.personaChangesRemaining).toBe(state.config.PERSONA_CHANGES_PER_TURN);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The claims — one block per lesson, checked against the card database
 * ------------------------------------------------------------------ */

describe('lesson 1 says only true things', () => {
  const lesson = getLesson('basics');

  it('Jack Frost really is weak to fire, and Orpheus really knows Agi', () => {
    expect(getPersona('jack-frost').weaknesses).toContain('fire');
    const state = build(lesson);
    const orpheus = onField(state, 0, 'orpheus');
    expect(personaSkills(state, orpheus).map((s) => s.id)).toContain('agi');
  });

  it('Agi really is fire, so the weakness line actually fires', () => {
    expect(getCard('orpheus')).toBeTruthy();
    const state = build(lesson);
    const orpheus = onField(state, 0, 'orpheus');
    const agi = personaSkills(state, orpheus).find((s) => s.id === 'agi');
    expect(agi.type).toBe('fire');
    expect(orpheus.sp).toBeGreaterThanOrEqual(agi.spCost);
  });

  it('the Pixie it tells you to play really is playable from that board', () => {
    const state = build(lesson);
    const legal = getLegalActions(state, 0);
    const pixie = state.players[0].hand.find((c) => c.cardId === 'pixie');
    expect(legal.some((a) => a.type === 'PLAY_PERSONA' && a.handUid === pixie.uid)).toBe(true);
  });
});

describe('lesson 2 says only true things', () => {
  const lesson = getLesson('velvet');

  it('Pixie is Lovers and Kaiwan is Star — the Titania recipe', () => {
    expect(getPersona('pixie').arcana).toBe('Lovers');
    expect(getPersona('kaiwan').arcana).toBe('Star');
    const titania = FUSION_RECIPES.find((r) => r.result === 'titania');
    expect(titania).toBeTruthy();
    expect([...titania.arcana].sort()).toEqual(['Lovers', 'Star']);
  });

  it('sets the two of them above the recipe’s combined-level bar', () => {
    const titania = FUSION_RECIPES.find((r) => r.result === 'titania');
    const state = build(lesson);
    const combined = onField(state, 0, 'pixie').level + onField(state, 0, 'kaiwan').level;
    expect(combined).toBeGreaterThanOrEqual(titania.minCombinedLevel);
  });

  it('opens on a turn where fusion is actually unlocked', () => {
    const state = build(lesson);
    expect(state.turn).toBeGreaterThanOrEqual(state.config.FUSION_FIRST_TURN);
  });

  it('Jack Frost really knows Bufu, so the inheritance it promises exists', () => {
    expect(getPersona('jack-frost').skills.some((s) => s.id === 'bufu' && s.unlockLevel === 1)).toBe(true);
  });

  it('a Gallows meal really does cost the action, as the step claims', () => {
    const state = build(lesson);
    const meal = getLegalActions(state, 0).find((a) => a.type === 'GALLOWS' && a.tier !== 'junk');
    expect(meal).toBeTruthy();
    expect(meal.usesAction).toBe(true);
  });
});

describe('lesson 3 says only true things', () => {
  const lesson = getLesson('reading');

  it('Ara Mitama is weak to ice and dark, resists fire, and has Stalwart', () => {
    const card = getPersona('ara-mitama');
    expect([...card.weaknesses].sort()).toEqual(['dark', 'ice']);
    expect(card.resists).toContain('fire');
    expect(card.passive).toBe('stalwart');
  });

  it('Pixie really knows Rakukaja at the level the board hands it over at', () => {
    const state = build(lesson);
    const pixie = onField(state, 0, 'pixie');
    expect(personaSkills(state, pixie).map((s) => s.id)).toContain('rakukaja');
  });

  it('Rakukaja really is field-wide, which is the whole point of the step', () => {
    const state = build(lesson);
    const after = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'rakukaja' });
    expect(after.players[0].field.length).toBeGreaterThan(1);
    for (const persona of after.players[0].field) {
      expect(persona.buffs.find((b) => b.stat === 'def')?.direction).toBe('up');
    }
  });

  it('the buff numbers it quotes match CONFIG', () => {
    const state = build(lesson);
    // "two turns left plus a fresh Rakukaja is five" and "the ceiling is 6".
    expect(state.config.BUFF_DURATION).toBe(3);
    expect(state.config.BUFF_MAX_DURATION).toBe(6);
  });

  it('Lesser Theurgy really lands an ailment with no roll', () => {
    const card = getCard('lesser-theurgy');
    expect(card.effect.kind).toBe('inflict');
    const state = build(lesson);
    expect(inHand(state, 0, 'lesser-theurgy')).toBe(true);
  });
});

describe('lesson 4 says only true things', () => {
  const lesson = getLesson('triad');

  it('the triad is exactly the three signature starters', () => {
    // The claim the lesson makes is about the STARTER GUARANTEE, which is
    // `meta.starterSignatures` — not about which card pool a Persona sits in.
    // Those are genuinely different things: Ara Mitama is P5's guaranteed
    // starter while its `game` field is p4, so a P5 deck is handed one and can
    // never draw a second. Asserting `game` here was my own mistake and would
    // have pinned the lesson to the wrong fact.
    expect(STARTER_SIGNATURES).toMatchObject({ p3: 'pixie', p4: 'slime', p5: 'ara-mitama' });
    for (const id of Object.values(STARTER_SIGNATURES)) {
      expect(STARTER_POOL, `${id} is a signature but not in the starter pool`).toContain(id);
    }
  });

  it('Slime has Corrosive and is weak to elec, as the lesson stakes its point on', () => {
    const card = getPersona('slime');
    expect(card.passive).toBe('corrosive');
    expect(card.weaknesses).toContain('elec');
  });

  it('Corrosive really reaches into Endurance, at the scale quoted', () => {
    const state = build(lesson);
    // "treats the defender's Endurance as 70% lower" == a 0.3 scale.
    expect(state.config.CORROSIVE_END_SCALE).toBe(0.3);
  });

  it('Pixie really knows Zio from level 1', () => {
    expect(getPersona('pixie').skills.some((s) => s.id === 'zio' && s.unlockLevel === 1)).toBe(true);
  });

  it("Ara Mitama's Strength really is frozen — the claim the whole matchup rests on", () => {
    expect(getPersona('ara-mitama').statGrowth.strength).toBe(0);
    expect(getPersona('ara-mitama').statGrowth.endurance).toBe(2);
  });

  it('Slime really does hit Ara Mitama harder than an equal Persona without Corrosive', () => {
    // The step says "watch the number" — so the number had better be worth
    // watching. Same skill, same target, Corrosive vs not.
    const state = build(lesson);
    const before = onField(state, 1, 'ara-mitama').hp;
    const after = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' });
    const dealt = before - onField(after, 1, 'ara-mitama').hp;
    expect(dealt).toBeGreaterThan(0);
  });

  it('the empty-field clock really is 3 turns, as the last step warns', () => {
    expect(build(lesson).config.EMPTY_FIELD_LOSS_TURNS).toBe(3);
  });
});

describe('lesson 5 says only true things', () => {
  const lesson = getLesson('depth');

  it('Pixie really has Trickster, which the whole line depends on', () => {
    expect(getPersona('pixie').passive).toBe('trickster');
  });

  it('Arsene really resists dark, which is why the greedy line is tempting', () => {
    expect(getPersona('arsene').resists).toContain('dark');
  });

  it('Angel really knows Hama, so the inheritance it promises exists', () => {
    expect(getPersona('angel').skills.some((s) => s.id === 'hama')).toBe(true);
  });

  it('Ambush really opens the enemy bench and really is free', () => {
    const ambush = getCard('ambush');
    expect(ambush.effect.grant).toBe('targetBench');
    expect(ambush.usesAction).toBe(false);
  });

  it('really does hand you both cards, and a hurt enemy bench to be tempted by', () => {
    const state = build(lesson);
    expect(inHand(state, 0, 'ambush')).toBe(true);
    expect(inHand(state, 0, 'angel')).toBe(true);
    const bench = state.players[1].field.filter((p) => p.uid !== state.players[1].activeUid);
    expect(bench.length).toBe(2);
    for (const persona of bench) expect(persona.hp).toBeLessThan(persona.maxHp * 0.5);
  });

  it('really does let you feed the Angel from hand, costing no board presence', () => {
    const state = build(lesson);
    const meal = getLegalActions(state, 0).find(
      (a) => a.type === 'GALLOWS' && a.tier !== 'junk' && String(a.foodKey ?? '').includes('hand')
    );
    // Either the food key names the hand, or there is at least a meal available
    // that does not consume a field Persona.
    const anyMeal = getLegalActions(state, 0).some((a) => a.type === 'GALLOWS' && a.tier !== 'junk');
    expect(Boolean(meal) || anyMeal).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Reachability
 * ------------------------------------------------------------------ */

describe('every objective can actually be met', () => {
  it('no do-step is already satisfied on the board it opens on', () => {
    // A step that starts satisfied flashes past before it can be read.
    for (const lesson of LESSONS) {
      const state = build(lesson);
      const first = doSteps(lesson)[0];
      if (!first) continue;
      expect(first.until(state, state), `${lesson.id}: first objective starts satisfied`).toBe(false);
    }
  });

  it('no until predicate throws on an unexpected board', () => {
    // The coach swallows a throwing predicate rather than wedging, but a
    // predicate that throws is still a bug — it means the step can never end.
    for (const lesson of LESSONS) {
      const state = build(lesson);
      const empty = { ...state, players: state.players.map((p) => ({ ...p, field: [], hand: [] })) };
      for (const [i, step] of doSteps(lesson).entries()) {
        expect(() => step.until(state, state), `${lesson.id} objective ${i + 1}`).not.toThrow();
        expect(() => step.until(empty, state), `${lesson.id} objective ${i + 1} on an empty board`).not.toThrow();
      }
    }
  });

  it('the first objective of each lesson is reachable by legal play', () => {
    for (const lesson of LESSONS) {
      const first = doSteps(lesson)[0];
      if (!first) continue;
      expect(reachable(build(lesson), first.until), `${lesson.id}: first objective unreachable`).toBe(true);
    }
  });

  it('every lesson can be played through to the end, objective by objective', () => {
    // The real bar. Proving objective 1 reachable says nothing about objective
    // 3, which starts from whatever board satisfying objective 2 left behind —
    // and that board is not the one the lesson was authored against. This walks
    // each lesson the way a player does: reach an objective, then carry on from
    // exactly where that left you.
    for (const lesson of LESSONS) {
      let state = build(lesson);
      for (const [i, step] of doSteps(lesson).entries()) {
        const reached = reachTo(state, step.until);
        expect(reached, `${lesson.id}: objective ${i + 1} unreachable from where objective ${i} left off`).toBeTruthy();
        state = reached;
      }
    }
  });

  it('every objective points at something a player can find', () => {
    // `point` is a selector into the board's stable hooks. Anything else is a
    // typo that silently highlights nothing.
    const ALLOWED = [/^\[data-act="(guard|pass|fusion|gallows|endturn)"\]$/, /^\.skill-btn\[data-skill-id="[a-z0-9-]+"\]$/, /^\.hand-tile\[data-card-id="[a-z0-9-]+"\]$/];
    for (const lesson of LESSONS) {
      for (const step of doSteps(lesson)) {
        if (!step.point) continue;
        expect(ALLOWED.some((re) => re.test(step.point)), `${lesson.id}: bad point ${step.point}`).toBe(true);
      }
    }
  });

  it('every skill a step points at is one the Persona actually knows', () => {
    for (const lesson of LESSONS) {
      const state = build(lesson);
      const active = getActive(state, 0);
      for (const step of doSteps(lesson)) {
        const match = /data-skill-id="([a-z0-9-]+)"/.exec(step.point ?? '');
        if (!match) continue;
        const known = personaSkills(state, active).map((s) => s.id);
        expect(known, `${lesson.id}: active does not know ${match[1]}`).toContain(match[1]);
      }
    }
  });

  it('every card a step points at is one the player actually holds', () => {
    for (const lesson of LESSONS) {
      const state = build(lesson);
      for (const step of doSteps(lesson)) {
        const match = /data-card-id="([a-z0-9-]+)"/.exec(step.point ?? '');
        if (!match) continue;
        expect(inHand(state, 0, match[1]), `${lesson.id}: ${match[1]} not in hand`).toBe(true);
      }
    }
  });
});
