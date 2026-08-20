/**
 * Story Mode Part A — is the content actually true?
 *
 * Two kinds of check, and the second is the one that matters.
 *
 * **Static.** The authored decks are legal, and each fight's roster really has
 * the property its lesson depends on — that everything in Battle 2 is weak to
 * fire, that Battle 3 resists fire and folds to ice, that Battle 4 has no
 * weakness the starter deck can reach. These are claims the design comments
 * make; a balance pass that moves an affinity should fail here rather than
 * quietly turn a teaching fight into a random one.
 *
 * **Behavioural.** The design law for this campaign is that *the lesson is the
 * path to victory* — the player learns by being unable to win otherwise. That
 * is not a property of the card database, it is a property of the fight, and
 * the only honest way to check it is to play the fight both ways: once with the
 * lesson available and once with it banned, and compare.
 *
 * Those simulations are why this file is separate and slow. They play a few
 * hundred full matches. See tests/support/storySim.js.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG } from '../src/engine/index.js';
import { getPersona, PERSONAS, FUSION_RECIPES } from '../src/data/cards.js';
import { BATTLES, getBattle } from '../src/ui/story/campaign.js';
import { LOADOUTS, getLoadout } from '../src/ui/story/decks.js';
import { checkDeck, buildStoryBattle } from '../src/ui/story/battleSetup.js';
import { resolvePlayerDeck } from '../src/ui/story/decks.js';
import { arm, banType, BAN_FUSE, BAN_SWAP } from './support/storySim.js';

const STARTER = LOADOUTS.STARTER_DECK;

/** `getPersona` throws for Items and Specials, so ask before looking up. */
const PERSONA_IDS = new Set(PERSONAS.map((p) => p.id));
const personaOrNull = (id) => (PERSONA_IDS.has(id) ? getPersona(id) : null);

/** Every damage type the starter deck can actually deal, at any level. */
function typesInDeck(cards) {
  const types = new Set();
  for (const id of new Set(cards)) {
    const persona = personaOrNull(id);
    if (!persona) continue;
    for (const skill of persona.skills ?? []) {
      if (skill.power && skill.type !== 'heal') types.add(skill.type);
    }
  }
  types.add('phys'); // the basic attack, always available
  return types;
}

const rosterOf = (battle) => [
  ...(battle.setup?.opponent?.field ?? []).map((f) => f.cardId),
  ...(battle.setup?.opponent?.deck ?? []).filter((id) => PERSONA_IDS.has(id)),
];

/* ------------------------------------------------------------------ *
 * The authored decks
 * ------------------------------------------------------------------ */

describe('the teaching decks', () => {
  it('are legal wherever they have been authored', () => {
    for (const [id, loadout] of Object.entries(LOADOUTS)) {
      if (!loadout.cards) continue; // not authored yet — the engine rolls one
      expect(checkDeck(loadout.cards), `${id}`).toEqual([]);
    }
  });

  it('give every authored opponent a legal deck too', () => {
    for (const battle of BATTLES) {
      const deck = battle.setup?.opponent?.deck;
      if (!deck) continue;
      expect(checkDeck(deck), `${battle.id} opponent deck`).toEqual([]);
    }
  });

  it('builds the starter deck around four damage types, so swapping has somewhere to go', () => {
    const types = typesInDeck(STARTER.cards);
    for (const type of ['fire', 'ice', 'elec', 'phys']) {
      expect(types.has(type), `starter deck can deal ${type}`).toBe(true);
    }
  });

  it('deliberately contains no dark — which is what makes Battle 4 a wall', () => {
    // Battle 4's opponent is weak to dark and nothing else. If a future edit
    // adds a dark attacker here, that fight silently stops teaching fusion.
    expect(typesInDeck(STARTER.cards).has('dark')).toBe(false);
  });
});

describe('the fusion the campaign is built around', () => {
  const recipe = FUSION_RECIPES.find((r) => r.result === 'kikuri-hime');

  it('has both halves in the starter deck, at a combined level that satisfies it', () => {
    const inDeck = (id) => STARTER.cards.includes(id);
    expect(inDeck('silky'), 'Priestess half').toBe(true);
    expect(inDeck('omoikane'), 'Hierophant half').toBe(true);

    const silky = getPersona('silky');
    const omoikane = getPersona('omoikane');
    expect([silky.arcana, omoikane.arcana].sort()).toEqual([...recipe.arcana].sort());
    expect(silky.level + omoikane.level).toBeGreaterThanOrEqual(recipe.minCombinedLevel);
  });

  it('is reachable from the board Battle 4 starts the player on', () => {
    const battle = getBattle(4);
    const field = battle.setup.playerField.map((f) => f.cardId);
    expect(field).toContain('silky');
    expect(field).toContain('omoikane');

    // The result's printed level must be within FUSION_LEVEL_GAP of the biggest
    // body on that board, or the fusion is legal on paper and refused in play.
    const highest = Math.max(...battle.setup.playerField.map((f) => f.level));
    expect(getPersona('kikuri-hime').level).toBeLessThanOrEqual(highest + CONFIG.FUSION_LEVEL_GAP);
  });

  it('produces a Persona that specifically answers the Battle 4 wall', () => {
    // The fight is not "fusion is a bigger number" — it is "this Persona is the
    // one that survives what this thing does". Kikuri-Hime resists light; the
    // wall attacks with light.
    const wall = getPersona(getBattle(4).setup.opponent.field[0].cardId);
    const fused = getPersona('kikuri-hime');
    const wallTypes = (wall.skills ?? []).filter((s) => s.power).map((s) => s.type);
    expect(wallTypes).toContain('light');
    expect(fused.resists).toContain('light');
    expect(fused.weaknesses).not.toContain('light');
  });
});

/* ------------------------------------------------------------------ *
 * Each fight has the property its lesson needs
 * ------------------------------------------------------------------ */

describe('the fundamentals fights are built for their lessons', () => {
  it('Battle 2: it opens on fire-weak bodies and nothing it holds resists fire', () => {
    const battle = getBattle(2);

    // The opening board is what teaches the lesson, so all of it must burn.
    for (const spec of battle.setup.opponent.field) {
      expect(getPersona(spec.cardId).weaknesses, `${spec.cardId} is weak to fire`).toContain('fire');
    }

    // The deck cannot be all fire-weak — only four deck-legal Personas are, and
    // two copies each is eight of sixteen. What it must never contain is a
    // Persona that RESISTS fire, which would make the answer stop working
    // halfway through the fight for reasons the player cannot see.
    const roster = rosterOf(battle).map(personaOrNull).filter(Boolean);
    for (const persona of roster) {
      expect(persona.resists ?? [], `${persona.id} does not resist fire`).not.toContain('fire');
    }

    const weak = roster.filter((p) => (p.weaknesses ?? []).includes('fire'));
    expect(weak.length / roster.length, 'most of the roster burns').toBeGreaterThanOrEqual(0.5);
  });

  it('Battle 3: the whole field resists fire and folds to ice', () => {
    // The starter's default attack stops working and a Persona already in the
    // deck starts working. That swap is the entire fight.
    for (const spec of getBattle(3).setup.opponent.field) {
      const persona = getPersona(spec.cardId);
      expect(persona.resists ?? [], `${spec.cardId} resists fire`).toContain('fire');
      expect(persona.weaknesses, `${spec.cardId} is weak to ice`).toContain('ice');
    }
  });

  it('Battle 4: nothing on its field has a weakness the starter deck can hit', () => {
    const reachable = typesInDeck(STARTER.cards);
    for (const spec of getBattle(4).setup.opponent.field) {
      const persona = getPersona(spec.cardId);
      const hittable = (persona.weaknesses ?? []).filter((t) => reachable.has(t));
      expect(hittable, `${spec.cardId} exposes ${hittable.join(',')} to the starter deck`).toEqual([]);
    }
  });

  it('runs the fundamentals on the starter deck and keeps the checkpoint where it was', () => {
    for (const n of [1, 2, 3, 4]) expect(getBattle(n).playerDeck).toBe('STARTER_DECK');
    expect(getBattle(3).boss).toBe(true);
  });

  it('keeps every fight short enough to be a lesson rather than a campaign', () => {
    for (const n of [1, 2, 3, 4]) {
      const koTarget = getBattle(n).setup.koTarget;
      expect(koTarget, `battle ${n} knockout target`).toBeGreaterThan(0);
      expect(koTarget, `battle ${n} is shorter than a full match`).toBeLessThan(CONFIG.KO_TARGET);
    }
  });

  it('applies the battle knockout target to the match it builds', () => {
    const battle = getBattle(1);
    const state = buildStoryBattle(battle, resolvePlayerDeck(battle, {}), 'You');
    expect(state.config.KO_TARGET).toBe(battle.setup.koTarget);
    // ...and deals the player the deck the battle assigns, in full. The field
    // is not counted: a starter comes from the offer, not off the top of the deck.
    expect(state.players[0].deck.length + state.players[0].hand.length).toBe(30);
  });
});

/* ------------------------------------------------------------------ *
 * The design law, measured
 * ------------------------------------------------------------------ */

describe('the lesson is the path to victory', () => {
  const N = 12;

  it('Battle 1 is winnable played badly', { timeout: 120_000 }, () => {
    // The "bad player" is the Easy AI: it plays at random and never goes looking
    // for a weakness. If it cannot clear the first fight, no beginner can.
    const bad = arm(getBattle(1), 'easy', N);
    expect(bad.win, `bad player won ${bad.win}%`).toBeGreaterThanOrEqual(75);
  });

  it('Battle 2 collapses when the weakness is taken away', { timeout: 180_000 }, () => {
    const using = arm(getBattle(2), 'medium', N);
    const without = arm(getBattle(2), 'medium', N, banType('fire'));
    expect(using.win).toBeGreaterThanOrEqual(75);
    expect(using.win - without.win, `${using.win}% with fire vs ${without.win}% without`).toBeGreaterThanOrEqual(40);
  });

  it('Battle 3 needs the swap, and needs the ice behind it', { timeout: 180_000 }, () => {
    const free = arm(getBattle(3), 'medium', N);
    const stuck = arm(getBattle(3), 'medium', N, BAN_SWAP);
    const noIce = arm(getBattle(3), 'medium', N, banType('ice'));
    expect(free.win - stuck.win, `${free.win}% swapping vs ${stuck.win}% stuck`).toBeGreaterThan(0);
    expect(free.win - noIce.win, `${free.win}% with ice vs ${noIce.win}% without`).toBeGreaterThanOrEqual(30);
  });

  it('Battle 4 needs the fusion', { timeout: 180_000 }, () => {
    const fusing = arm(getBattle(4), 'medium', N);
    const banned = arm(getBattle(4), 'medium', N, BAN_FUSE);
    expect(fusing.win, `fusing won ${fusing.win}%`).toBeGreaterThanOrEqual(75);
    expect(fusing.win - banned.win, `${fusing.win}% fusing vs ${banned.win}% banned`).toBeGreaterThanOrEqual(40);
    expect(fusing.fusions, 'the winning line actually fuses').toBeGreaterThan(0);
  });

  it('lets a strong player clear all four', { timeout: 240_000 }, () => {
    for (const n of [1, 2, 3, 4]) {
      const strong = arm(getBattle(n), 'brutal', 8);
      expect(strong.win, `battle ${n} at the skill ceiling: ${strong.win}%`).toBeGreaterThanOrEqual(75);
    }
  });
});
