/**
 * @vitest-environment jsdom
 *
 * Story Mode — the campaign data, the local save, the map, and the one
 * structural promise the mode makes.
 *
 * Three separate things are checked here:
 *
 *   1. **The campaign is coherent.** Every battle names a deck, archetype,
 *      difficulty and playstyle that really exist, and a battle's deck agrees
 *      with the deck its playstyle is built around — otherwise the boss is
 *      handed a plan it has no cards for and simply plays worse than the one
 *      below it.
 *   2. **Progress survives being wrong.** The save is a JSON blob on the
 *      player's own machine, so it is editable. A hand-typed `currentBattle: 99`
 *      has to clamp rather than route to a battle that does not exist.
 *   3. **Story Mode cannot reach the network code.** This is the promise the
 *      mode is built on, and a comment saying so is worth nothing six months
 *      from now — so the import graph is walked from disk instead.
 *
 * Winning a battle end-to-end is deliberately NOT here: it costs a full match
 * through the real board, which this repo gives a file of its own. See
 * tests/story.win.test.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve as resolvePath, relative } from 'node:path';
import { DECKS } from '../src/data/cards.js';
import { ARCHETYPES } from '../src/data/archetypes.js';
import { DIFFICULTIES } from '../src/engine/bot.js';
import { PLAYSTYLES } from '../src/engine/playstyles.js';
import { renderMenu } from '../src/ui/menu.js';
import { BATTLES, BATTLE_COUNT, getBattle, nextBattle, isBattleNumber } from '../src/ui/story/campaign.js';
import { PLAYER_CHOICE, LOADOUTS, LOADOUT_IDS, getLoadout, isPlayerDeckValue, resolvePlayerDeck } from '../src/ui/story/decks.js';
import {
  getStoryProgress,
  saveStoryProgress,
  setChosenDeck,
  getChosenDeck,
  recordBattleCleared,
  isBattleUnlocked,
  isBattleCleared,
  isCampaignComplete,
  resetStoryProgress,
  reloadStoryProgress,
} from '../src/ui/story/progress.js';
import { renderStory, storyBattleFromHash } from '../src/ui/story/index.js';
import { PERSONAS } from '../src/data/cards.js';

const REPO = resolvePath(__dirname, '..');
const KEY = 'pcg.story.progress';

let root;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  document.body.className = '';
  window.location.hash = '';
  localStorage.clear();
  resetStoryProgress();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  // Leaving the route tears the battle's controller down. Without this a story
  // bot keeps stepping on the fake clock into whatever runs next.
  renderStory(root, {});
  document.body.innerHTML = '';
  document.body.className = '';
  vi.useRealTimers();
});

const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const cards = () => $$('.story-card');

/* ------------------------------------------------------------------ *
 * The campaign
 * ------------------------------------------------------------------ */

describe('the campaign', () => {
  it('is numbered in order, with unique ids and seeds', () => {
    expect(BATTLES).toHaveLength(BATTLE_COUNT);
    expect(BATTLES.map((b) => b.number)).toEqual(BATTLES.map((_, i) => i + 1));
    expect(new Set(BATTLES.map((b) => b.id)).size).toBe(BATTLE_COUNT);
    expect(new Set(BATTLES.map((b) => b.seed)).size).toBe(BATTLE_COUNT);
  });

  it('names a real deck, archetype, difficulty and playstyle for every battle', () => {
    for (const battle of BATTLES) {
      expect(DECKS.some((d) => d.id === battle.deckId), `${battle.id} deck`).toBe(true);
      expect(ARCHETYPES.some((a) => a.id === battle.archetype), `${battle.id} archetype`).toBe(true);
      expect(DIFFICULTIES.some((d) => d.id === battle.difficulty), `${battle.id} difficulty`).toBe(true);
      expect(PLAYSTYLES.some((p) => p.id === battle.playstyle), `${battle.id} playstyle`).toBe(true);
    }
  });

  it('gives every generated-deck boss the deck its playstyle is built around', () => {
    // Only applies where the deck is still ROLLED. A battle that authors its
    // opponent's deck has already decided what the boss is holding, and that
    // list is the plan — checked instead by tests/story.content.test.js.
    for (const battle of BATTLES) {
      if (battle.setup?.opponent?.deck) continue;
      const style = PLAYSTYLES.find((p) => p.id === battle.playstyle);
      if (!style.deckId) continue; // 'normal' has no deck of its own
      expect(battle.deckId, `${battle.id} runs ${style.label}`).toBe(style.deckId);
    }
  });

  it('never offers a boss the meta "random" playstyle', () => {
    // Random resolves to one of the other four at match start. A story boss is
    // an authored fight, so a hidden coin-flip over its plan would make the
    // battle a different battle each attempt.
    expect(BATTLES.some((b) => b.playstyle === 'random')).toBe(false);
  });

  it('ramps difficulty and ends on Nyx', () => {
    const rank = { easy: 0, medium: 1, brutal: 2, chaos: 2 };
    const ranks = BATTLES.map((b) => rank[b.difficulty]);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
    expect(BATTLES[BATTLE_COUNT - 1].name).toBe('Nyx');
  });

  it('looks battles up and walks forward, stopping at the end', () => {
    expect(getBattle(1).id).toBe(BATTLES[0].id);
    expect(getBattle(0)).toBeNull();
    expect(getBattle(BATTLE_COUNT + 1)).toBeNull();
    expect(nextBattle(1).number).toBe(2);
    expect(nextBattle(BATTLE_COUNT)).toBeNull();
    expect(isBattleNumber(3)).toBe(true);
    expect(isBattleNumber(3.5)).toBe(false);
    expect(isBattleNumber('3')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The decks the campaign hands out
 * ------------------------------------------------------------------ */

describe('assigned decks', () => {
  it('gives every battle a player deck that is a real loadout or PLAYER_CHOICE', () => {
    for (const battle of BATTLES) {
      expect(isPlayerDeckValue(battle.playerDeck), `${battle.id} -> ${battle.playerDeck}`).toBe(true);
    }
  });

  it('names a real deck flavour and archetype in every loadout', () => {
    for (const id of LOADOUT_IDS) {
      const loadout = LOADOUTS[id];
      expect(loadout.id, 'the table key and the id agree').toBe(id);
      expect(DECKS.some((d) => d.id === loadout.deckId), `${id} deck`).toBe(true);
      expect(ARCHETYPES.some((a) => a.id === loadout.archetype), `${id} archetype`).toBe(true);
    }
  });

  it('does not define a loadout no battle ever hands out', () => {
    // Not a style rule — an unreachable loadout is content the player can never
    // see, which is exactly the kind of thing that rots without anyone noticing.
    const used = new Set(BATTLES.map((b) => b.playerDeck));
    for (const id of LOADOUT_IDS) expect(used.has(id), `${id} is never assigned`).toBe(true);
  });

  it('ends the campaign by handing the choice back', () => {
    // Which battle assigns what is the author's to edit freely; that the mode
    // finishes by stepping back is the structural promise worth pinning.
    expect(BATTLES.at(-1).playerDeck).toBe(PLAYER_CHOICE);
    expect(BATTLES.filter((b) => b.playerDeck === PLAYER_CHOICE)).toHaveLength(1);
  });

  it('backs the Wallbreaker loadout with the deck that actually hits hardest', () => {
    // decks.js claims p4 is the Phys deck and points WALLBREAKER_DECK at it.
    // If a balance pass moves that, the Battle 6 lesson quietly stops working,
    // so the claim is checked against the shipped database rather than trusted.
    const physPower = {};
    const strength = {};
    for (const persona of PERSONAS) {
      // `PERSONAS` carries fully resolved skill objects, not library ids.
      const top = (persona.skills ?? [])
        .filter((skill) => skill.type === 'phys' && skill.power)
        .map((skill) => skill.power);
      physPower[persona.game] = Math.max(physPower[persona.game] ?? 0, ...top, 0);
      (strength[persona.game] ??= []).push(persona.strength);
    }
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const wallbreaker = LOADOUTS.WALLBREAKER_DECK.deckId;

    for (const deckId of DECKS.map((d) => d.id).filter((id) => id !== wallbreaker)) {
      expect(physPower[wallbreaker], `${wallbreaker} vs ${deckId} top Phys`).toBeGreaterThan(physPower[deckId]);
      expect(avg(strength[wallbreaker]), `${wallbreaker} vs ${deckId} avg STR`).toBeGreaterThan(avg(strength[deckId]));
    }
  });

  it('resolves an assigned battle to its loadout, ignoring whatever was chosen', () => {
    const battle = BATTLES.find((b) => b.playerDeck !== PLAYER_CHOICE);
    const loadout = getLoadout(battle.playerDeck);
    const resolved = resolvePlayerDeck(battle, { deckId: 'p5', archetype: 'defensive' });

    expect(resolved.deckId).toBe(loadout.deckId);
    expect(resolved.archetype).toBe(loadout.archetype);
    expect(resolved.loadout).toBe(loadout);
    expect(resolved.chosen).toBe(false);
  });

  it('resolves a PLAYER_CHOICE battle to what the player picked', () => {
    const battle = BATTLES.find((b) => b.playerDeck === PLAYER_CHOICE);
    const resolved = resolvePlayerDeck(battle, { deckId: 'p5', archetype: 'defensive' });

    expect(resolved.deckId).toBe('p5');
    expect(resolved.archetype).toBe('defensive');
    expect(resolved.loadout).toBeNull();
    expect(resolved.chosen).toBe(true);
  });

  it('falls back to a playable deck when the choice is missing or nonsense', () => {
    const battle = BATTLES.find((b) => b.playerDeck === PLAYER_CHOICE);
    for (const bad of [undefined, null, {}, { deckId: 'nope', archetype: 'nope' }]) {
      const resolved = resolvePlayerDeck(battle, bad);
      expect(DECKS.some((d) => d.id === resolved.deckId)).toBe(true);
      expect(ARCHETYPES.some((a) => a.id === resolved.archetype)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Progress
 * ------------------------------------------------------------------ */

describe('story progress', () => {
  it('starts at Battle 1 with nothing cleared', () => {
    const progress = getStoryProgress();
    expect(progress.currentBattle).toBe(1);
    expect(progress.cleared).toEqual([]);
    expect(isBattleUnlocked(1)).toBe(true);
    expect(isBattleUnlocked(2)).toBe(false);
    expect(isCampaignComplete()).toBe(false);
  });

  it('opens the next battle when one is cleared, and persists it', () => {
    recordBattleCleared(1);
    expect(getStoryProgress().currentBattle).toBe(2);
    expect(isBattleCleared(1)).toBe(true);
    expect(isBattleUnlocked(2)).toBe(true);
    expect(isBattleUnlocked(3)).toBe(false);

    // Survives a reload — the point of the whole module.
    expect(reloadStoryProgress().currentBattle).toBe(2);
  });

  it('does not walk backwards when an early battle is replayed', () => {
    recordBattleCleared(1);
    recordBattleCleared(2);
    recordBattleCleared(3);
    expect(getStoryProgress().currentBattle).toBe(4);

    recordBattleCleared(1); // replayed from the map
    const progress = getStoryProgress();
    expect(progress.currentBattle).toBe(4);
    expect(progress.cleared).toEqual([1, 2, 3]);
  });

  it('completes the campaign without running past the last battle', () => {
    for (const battle of BATTLES) recordBattleCleared(battle.number);
    const progress = getStoryProgress();
    expect(progress.currentBattle).toBe(BATTLE_COUNT);
    expect(isCampaignComplete()).toBe(true);
  });

  it('ignores a battle number that is not one', () => {
    recordBattleCleared(99);
    recordBattleCleared('2');
    expect(getStoryProgress().cleared).toEqual([]);
  });

  it('clamps and repairs a hand-edited save', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        version: 1,
        currentBattle: 99,
        cleared: [2, 2, 99, 'x', 1],
        chosenDeckId: 'nope',
        chosenArchetype: 'nope',
      })
    );
    const progress = reloadStoryProgress();
    // Note where it lands: 3, not 7. A frontier that is not a battle number at
    // all falls back to what was actually cleared, so editing the file cannot
    // skip you to Nyx — it can only put you back where you really were.
    expect(progress.currentBattle).toBe(3);
    expect(progress.cleared).toEqual([1, 2]);
    expect(progress.chosenDeckId).toBe(DECKS[0].id);
    expect(progress.chosenArchetype).toBe(ARCHETYPES[0].id);
  });

  it('pulls currentBattle up to match what was actually cleared', () => {
    // The other direction: a save claiming Battle 1 but holding five clears.
    localStorage.setItem(KEY, JSON.stringify({ version: 1, currentBattle: 1, cleared: [1, 2, 3, 4, 5] }));
    expect(reloadStoryProgress().currentBattle).toBe(6);
  });

  it('drops a save from an older version rather than half-reading it', () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 0, currentBattle: 6, cleared: [1, 2, 3, 4, 5] }));
    expect(reloadStoryProgress().currentBattle).toBe(1);
  });

  it('survives unreadable storage', () => {
    localStorage.setItem(KEY, 'not json {');
    expect(reloadStoryProgress().currentBattle).toBe(1);
  });

  it('remembers what the deck-select screen was last set to', () => {
    setChosenDeck({ deckId: DECKS[2].id, archetype: 'swift' });
    const progress = reloadStoryProgress();
    expect(getChosenDeck(progress)).toEqual({ deckId: DECKS[2].id, archetype: 'swift' });
  });

  it('resets back to the start', () => {
    recordBattleCleared(1);
    recordBattleCleared(2);
    saveStoryProgress({ chosenDeckId: DECKS[1].id });
    resetStoryProgress();
    const progress = reloadStoryProgress();
    expect(progress.currentBattle).toBe(1);
    expect(progress.cleared).toEqual([]);
    expect(progress.chosenDeckId).toBe(DECKS[0].id);
  });
});

/* ------------------------------------------------------------------ *
 * The map
 * ------------------------------------------------------------------ */

describe('the campaign map', () => {
  it('is reachable from the main menu', () => {
    renderMenu(root);
    const box = $$('.menu__box').find((n) => n.textContent.includes('Story Mode'));
    expect(box).toBeTruthy();
    click(box);
    expect(window.location.hash).toBe('#/story');
  });

  it('lists every battle, with only the first one open on a fresh save', () => {
    renderStory(root, {});
    expect(cards()).toHaveLength(BATTLE_COUNT);

    const [first, second] = cards();
    expect(first.disabled).toBe(false);
    expect(first.className).toContain('story-card--next');
    expect(first.textContent).toContain(BATTLES[0].name);

    expect(second.disabled).toBe(true);
    expect(second.className).toContain('story-card--locked');
    // A locked battle keeps its name to itself.
    expect(second.textContent).not.toContain(BATTLES[1].name);
    expect(second.textContent).toContain('???');
  });

  it('marks cleared battles and moves the frontier along', () => {
    recordBattleCleared(1);
    recordBattleCleared(2);
    renderStory(root, {});

    const [one, two, three, four] = cards();
    expect(one.className).toContain('story-card--cleared');
    expect(two.className).toContain('story-card--cleared');
    expect(three.className).toContain('story-card--next');
    expect(four.disabled).toBe(true);
    expect(three.textContent).toContain('Next');
  });

  it('routes to a battle when its card is clicked', () => {
    recordBattleCleared(1);
    renderStory(root, {});
    click(cards()[1]);
    expect(window.location.hash).toBe('#/story/2');
  });

  it('has a continue button pointing at the current battle', () => {
    recordBattleCleared(1);
    recordBattleCleared(2);
    renderStory(root, {});
    const go = $$('.story-map__actions .btn--primary')[0];
    expect(go.textContent).toContain('Battle 3');
    click(go);
    expect(window.location.hash).toBe('#/story/3');
  });

  it('names the deck each unlocked battle hands you, and keeps locked ones secret', () => {
    // The deck a battle gives you IS the battle, so the map says so up front —
    // there is no campaign-wide picker any more.
    renderStory(root, {});
    expect($$('.setup-card[data-deck]')).toEqual([]);

    const [first, second] = cards();
    expect(first.querySelector('.story-card__deck').textContent).toContain(getLoadout(BATTLES[0].playerDeck).name);
    expect(second.querySelector('.story-card__deck')).toBeNull();
  });

  it('marks the finale as the one battle that lets you choose', () => {
    for (const battle of BATTLES) recordBattleCleared(battle.number);
    renderStory(root, {});
    const chip = cards().at(-1).querySelector('.story-card__deck');
    expect(chip.className).toContain('story-card__deck--choice');
    expect(chip.textContent).toContain('your choice');
  });

  it('resets progress when confirmed, and not when it is not', () => {
    recordBattleCleared(1);
    renderStory(root, {});

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    click($$('.story-map__actions .btn--ghost')[0]);
    expect(getStoryProgress().cleared).toEqual([1]);

    window.confirm.mockReturnValue(true);
    click($$('.story-map__actions .btn--ghost')[0]);
    expect(getStoryProgress().cleared).toEqual([]);
    expect(cards()[1].disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Routing into a battle
 * ------------------------------------------------------------------ */

describe('the battle route', () => {
  it('parses a battle number out of the hash', () => {
    expect(storyBattleFromHash('#/story/4')).toBe(4);
    expect(storyBattleFromHash('#/story')).toBeNull();
    expect(storyBattleFromHash('#/story/nyx')).toBeNull();
    expect(storyBattleFromHash('#/howto/basics')).toBeNull();
  });

  it('mounts a real board for an unlocked battle', () => {
    renderStory(root, { battleNumber: 1 });
    expect(root.querySelector('.board-screen')).toBeTruthy();
    expect(root.textContent).toContain('Battle 1');
    expect(root.textContent).toContain(BATTLES[0].name);
  });

  it('never mounts the presence overlay — there is no peer to watch', () => {
    renderStory(root, { battleNumber: 1 });
    expect(document.querySelector('.presence-overlay')).toBeNull();
  });

  it('starts an assigned battle immediately, on the deck it assigns', () => {
    renderStory(root, { battleNumber: 1 });
    expect(root.querySelector('.board-screen')).toBeTruthy();
    expect(root.querySelector('.setup__start')).toBeNull(); // no deck-select step
    expect(root.textContent).toContain(getLoadout(BATTLES[0].playerDeck).name);
  });

  it('opens deck select for the battle that hands the choice back', () => {
    for (const battle of BATTLES) recordBattleCleared(battle.number);
    const finale = BATTLES.at(-1);

    renderStory(root, { battleNumber: finale.number });
    expect(root.querySelector('.board-screen'), 'no board until a deck is picked').toBeNull();
    const start = root.querySelector('.setup__start');
    expect(start.textContent).toContain(finale.opponent);

    const p5 = $$('.setup-card[data-deck]').find((n) => n.dataset.deck === 'p5');
    click(p5);
    click(root.querySelector('[data-archetype="defensive"]'));
    click(start);

    // The pick is remembered, and it is what the match was actually built on.
    expect(getChosenDeck(reloadStoryProgress())).toEqual({ deckId: 'p5', archetype: 'defensive' });
    expect(root.querySelector('.board-screen')).toBeTruthy();
  });

  it('leaves deck select without starting anything', () => {
    for (const battle of BATTLES) recordBattleCleared(battle.number);
    renderStory(root, { battleNumber: BATTLES.at(-1).number });
    click(root.querySelector('.topbar .btn--ghost'));
    expect(window.location.hash).toBe('#/story');
  });

  it('bounces a locked battle back to the map', () => {
    renderStory(root, { battleNumber: 5 });
    expect(window.location.hash).toBe('#/story');
    expect(root.querySelector('.board-screen')).toBeNull();
  });

  it('bounces a battle number that does not exist', () => {
    renderStory(root, { battleNumber: 42 });
    expect(window.location.hash).toBe('#/story');
  });
});

/* ------------------------------------------------------------------ *
 * Separation from online play
 * ------------------------------------------------------------------ */

describe('story mode is single-player all the way down', () => {
  /** Every module Story Mode pulls in, transitively, as repo-relative paths. */
  function importGraph(entries) {
    const seen = new Set();
    const queue = entries.map((e) => resolvePath(REPO, e));

    while (queue.length) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      if (!file.endsWith('.js')) continue; // .json and .css are leaves

      const source = readFileSync(file, 'utf8');
      // Static `import ... from '...'` and `export ... from '...'` only, which
      // is all this codebase uses. A dynamic import would be missed, so:
      expect(/\bimport\s*\(/.test(source), `${relative(REPO, file)} uses a dynamic import`).toBe(false);

      for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
        const spec = match[1];
        if (!spec.startsWith('.')) continue; // a bare specifier is a dependency
        const target = resolvePath(dirname(file), spec);
        if (existsSync(target)) queue.push(target);
      }
    }
    return [...seen].map((f) => relative(REPO, f));
  }

  /**
   * Read off disk rather than hand-listed: a new file in the folder must be
   * covered by this guard automatically, or the guard rots the moment the mode
   * grows — which it did, twice, while this feature was being built.
   */
  const STORY_FILES = readdirSync(resolvePath(REPO, 'src/ui/story'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `src/ui/story/${name}`);

  /**
   * The peer-to-peer layer proper: the signalling, the data channel, the
   * transport, and the online match loop built on them. Nothing Story Mode
   * touches may reach any of it, at any depth.
   */
  const PEER_TO_PEER = [
    'src/net/webrtc.js',
    'src/net/transport.js',
    'src/net/onlineMatch.js',
    'src/net/shortcode.js',
    'src/net/matchSave.js',
    'src/ui/game/online.js',
  ];

  it('covers every module in the story folder', () => {
    // Guards the guard: if this drops to a handful of files the assertions below
    // stop meaning anything.
    expect(STORY_FILES.length).toBeGreaterThanOrEqual(8);
    expect(STORY_FILES).toContain('src/ui/story/index.js');
  });

  it('imports nothing from src/net/ in its own modules', () => {
    for (const file of STORY_FILES) {
      const source = readFileSync(resolvePath(REPO, file), 'utf8');
      const specs = [...source.matchAll(/\bfrom\s+'([^']+)'/g)].map((m) => m[1]);
      expect(specs.filter((s) => s.includes('/net/')), file).toEqual([]);
    }
  });

  it('cannot reach the peer-to-peer layer at any depth', () => {
    const graph = importGraph(STORY_FILES);
    // Sanity: the walk really did follow imports out of the folder.
    expect(graph).toContain('src/engine/index.js');
    expect(graph).toContain('src/ui/game/board.js');

    const reached = graph.filter((f) => PEER_TO_PEER.includes(f));
    expect(reached, `Story Mode reached the peer-to-peer layer: ${reached.join(', ')}`).toEqual([]);
  });

  /**
   * What Story Mode DOES reach under src/net/, and why neither is a hole.
   *
   *   src/net/presence.js   `board.js` is shared by every mode and statically
   *                         imports the presence overlay. The overlay mounts
   *                         only when `options.presence` is passed, and no
   *                         single-player mode passes it.
   *   src/net/websocket.js  `ui/settings.js` imports `defaultRelayUrl` so the
   *                         relay *setting* can show its fallback. Reading a
   *                         URL string opens no socket.
   *
   * Both are already linked into the tutorial and Against Bot for exactly the
   * same reasons. This test pins the set: a new edge into src/net/ from
   * anything Story Mode touches fails here rather than passing quietly.
   */
  it('reaches only the two already-shared net modules, by their known routes', () => {
    const viaStory = importGraph(STORY_FILES).filter((f) => f.startsWith('src/net/')).sort();
    expect(viaStory).toEqual(['src/net/presence.js', 'src/net/websocket.js']);

    expect(importGraph(['src/ui/game/presenceOverlay.js'])).toContain('src/net/presence.js');
    expect(importGraph(['src/ui/settings.js'])).toContain('src/net/websocket.js');

    // Against Bot carries the same two, so Story Mode adds no network surface.
    const viaBot = importGraph(['src/ui/game/botGame.js']).filter((f) => f.startsWith('src/net/')).sort();
    expect(viaStory).toEqual(viaBot);

    // ...and story never hands the board the option that would construct one.
    const storySource = STORY_FILES.map((f) => readFileSync(resolvePath(REPO, f), 'utf8')).join('\n');
    expect(/\bpresence\s*:/.test(storySource), 'story passes options.presence').toBe(false);
  });

  it('leaves the online mode untouched — it still reaches its transport', () => {
    // The mirror image of the test above. Without it, deleting the WebRTC layer
    // outright would make the isolation test pass for the wrong reason.
    const graph = importGraph(['src/ui/game/online.js']);
    expect(graph).toContain('src/net/webrtc.js');
  });
});
