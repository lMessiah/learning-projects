/**
 * Vs Bot route: setup screen -> match -> rematch.
 */
import { createMatch, createRng } from '../../engine/index.js';
import { DECKS } from '../../data/cards.js';
import { ARCHETYPES, getArchetype } from '../../data/archetypes.js';
import { DIFFICULTIES } from '../../engine/bot.js';
import { getPlaystyle, resolvePlaystyle } from '../../engine/playstyles.js';
import { getProfileName } from '../profile.js';
import { createController } from './controller.js';
import { mountBoard } from './board.js';
import { renderBotSetup } from './setup.js';
import { applyThemeFor } from '../theme.js';

const HUMAN = 0;
const BOT = 1;

let teardown = null;

function cleanup() {
  if (teardown) {
    teardown();
    teardown = null;
  }
}

/** Deterministic-ish per-match seed; the engine itself stays fully seeded. */
function freshSeed() {
  return Math.floor(Date.now() % 2147483647) || 1;
}

export function renderBotGame(root) {
  cleanup();
  const goMenu = () => {
    cleanup();
    window.location.hash = '#/';
  };

  const showSetup = () => {
    cleanup();
    renderBotSetup(root, { onExit: goMenu, onStart: (choice) => startMatch(root, choice, showSetup, goMenu) });
  };

  showSetup();
}

function startMatch(root, choice, onRematch, onExit) {
  cleanup();
  // Your deck sets the theme unless Settings has locked one in.
  applyThemeFor({ deckId: choice.deckId });

  const seed = freshSeed();

  // Random is resolved ONCE, here, through the seeded RNG — not per turn, or the
  // bot would have a new personality every time it acted.
  const picked = choice.playstyle ?? 'normal';
  const [resolvedId] = resolvePlaystyle(picked, createRng(seed + 4231));
  const playstyle = getPlaystyle(resolvedId);
  // Random hides what it landed on, and the deck is half the tell — so the
  // subtitle goes dark rather than announcing "Persona 5" at a Defensive bot.
  const concealed = picked === 'random';

  // A playstyle locks the bot to the deck it is built around, mirror or not:
  // the player asked for that plan, and handing them a watered-down version
  // because they happened to pick the same flavour would be the worse surprise.
  // Normal keeps the original behaviour — one of the decks you didn't pick.
  const otherDecks = DECKS.filter((d) => d.id !== choice.deckId);
  const botDeck = playstyle.deckId
    ? DECKS.find((d) => d.id === playstyle.deckId)
    : otherDecks[seed % otherDecks.length];
  const botArchetype = ARCHETYPES[(seed >>> 3) % ARCHETYPES.length];
  const difficulty = DIFFICULTIES.find((d) => d.id === choice.difficulty) || DIFFICULTIES[1];

  const state = createMatch({
    seed,
    players: [
      { name: getProfileName(), deckId: choice.deckId, archetype: choice.archetype, controller: 'human' },
      {
        name: `Bot (${difficulty.label})`,
        deckId: botDeck.id,
        archetype: botArchetype.id,
        controller: 'bot',
        difficulty: difficulty.id,
      },
    ],
  });

  const controller = createController({
    state,
    botPlayer: BOT,
    difficulty: difficulty.id,
    playstyle: resolvedId,
    botSeed: seed + 977,
  });

  const you = `${DECKS.find((d) => d.id === choice.deckId).name} (${getArchetype(choice.archetype)?.name ?? 'mixed'})`;
  const them = concealed ? '??? (unknown playstyle)' : `${botDeck.name} (${botArchetype.name}) · ${playstyle.label}`;

  const unmount = mountBoard(root, {
    controller,
    viewer: HUMAN,
    title: 'Against Bot',
    subtitle: `${you} vs ${them} · ${difficulty.label}`,
    onExit,
    onRematch: () => startMatch(root, choice, onRematch, onExit),
  });

  teardown = () => {
    controller.destroy();
    unmount();
  };
}
