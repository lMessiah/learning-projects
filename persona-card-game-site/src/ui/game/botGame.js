/**
 * Vs Bot route: setup screen -> match -> rematch.
 */
import { createMatch } from '../../engine/index.js';
import { DECKS } from '../../data/cards.js';
import { DIFFICULTIES } from '../../engine/bot.js';
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
  // The bot plays one of the decks the player didn't pick.
  const otherDecks = DECKS.filter((d) => d.id !== choice.deckId);
  const botDeck = otherDecks[seed % otherDecks.length];
  const difficulty = DIFFICULTIES.find((d) => d.id === choice.difficulty) || DIFFICULTIES[1];

  const state = createMatch({
    seed,
    players: [
      { name: getProfileName(), deckId: choice.deckId, controller: 'human' },
      { name: `Bot (${difficulty.label})`, deckId: botDeck.id, controller: 'bot', difficulty: difficulty.id },
    ],
  });

  const controller = createController({
    state,
    botPlayer: BOT,
    difficulty: difficulty.id,
    botSeed: seed + 977,
  });

  const unmount = mountBoard(root, {
    controller,
    viewer: HUMAN,
    title: 'Against Bot',
    subtitle: `${DECKS.find((d) => d.id === choice.deckId).name} vs ${botDeck.name} · ${difficulty.label}`,
    onExit,
    onRematch: () => startMatch(root, choice, onRematch, onExit),
  });

  teardown = () => {
    controller.destroy();
    unmount();
  };
}
