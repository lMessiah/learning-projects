/**
 * Story Mode — the campaign map and the battle runner.
 *
 * Routes:
 *   #/story          the campaign map
 *   #/story/<n>      one battle, 1..BATTLE_COUNT
 *
 * ── This mode is single-player, and stays that way ────────────────────────
 *
 * Story Mode is you against the bot, and it shares nothing with online play.
 * Concretely, and pinned by tests/story.test.js, which walks the import graph
 * from disk:
 *
 *   - No file in this folder imports anything under `src/net/`.
 *   - The peer-to-peer layer — the signalling, the data channel, the transport,
 *     the online match loop — is unreachable from here at any depth.
 *   - `mountBoard`'s one networking touchpoint, `options.presence`, is opt-in
 *     and is not passed, so the presence overlay never mounts and no transport
 *     is ever constructed.
 *
 * The one thing worth being precise about: the *shared* board statically links
 * the presence overlay, and `ui/settings.js` links the relay's URL helper, so
 * `net/presence.js` and `net/websocket.js` are in the bundle behind this mode —
 * exactly as they already are behind Against Bot and the tutorial. Neither is
 * ever called. The test asserts that set exactly, so a genuinely new edge into
 * the network code fails rather than passing quietly.
 *
 * A story battle is an ordinary match: the real engine, the real bot, the real
 * board. What the mode adds is the sequence around it — which battle is next,
 * what happens when you win it, and where that gets written down.
 */
import { DECKS } from '../../data/cards.js';
import { ARCHETYPES, getArchetype } from '../../data/archetypes.js';
import { getProfileName } from '../profile.js';
import { createController } from '../game/controller.js';
import { mountBoard } from '../game/board.js';
import { applyThemeFor } from '../theme.js';
import { BATTLES, BATTLE_COUNT, MAX_RETRIES, CHECKPOINT_AFTER_BATTLE, getBattle, nextBattle } from './campaign.js';
import { PLAYER_CHOICE, getLoadout, resolvePlayerDeck } from './decks.js';
import { buildStoryBattle } from './battleSetup.js';
import { renderStoryDeckSelect } from './deckSelect.js';
import { lossTip } from './tips.js';
import { earnedBy } from './trophies.js';
import { awardTrophies, getEarnedTrophies, isShelfUnlocked } from './trophyStore.js';
import { watchBattle } from './trophyWatch.js';
import { renderTrophyAwards } from './trophyScreen.js';
import {
  getStoryProgress,
  getChosenDeck,
  recordBattleCleared,
  recordBattleLost,
  lossesOn,
  retriesRemaining,
  isBattleUnlocked,
  isBattleCleared,
  isCampaignComplete,
  resetStoryProgress,
} from './progress.js';

const HUMAN = 0;
const BOT = 1;

const DECK_SYMBOL = { p3: '🌙', p4: '🌫️', p5: '🎭' };

let teardown = null;

function cleanup() {
  if (teardown) {
    teardown();
    teardown = null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** `#/story/4` -> 4. Null for the map route or anything unparseable. */
export function storyBattleFromHash(hash) {
  const match = /^#\/story\/(\d+)$/.exec(hash || '');
  if (!match) return null;
  return Number(match[1]);
}

const goMap = () => {
  window.location.hash = '#/story';
};
const goBattle = (number) => {
  window.location.hash = `#/story/${number}`;
};
const goTrophies = () => {
  window.location.hash = '#/trophies';
};

/**
 * Go to a battle even when it is the one already in the address bar.
 *
 * Falling out of Battle 1 sends you back to Battle 1, and setting `location.hash`
 * to the value it already holds fires no `hashchange` — so the button would do
 * nothing at all. This re-enters directly in that case.
 */
function goBattleFrom(root, number) {
  const target = `#/story/${number}`;
  if (window.location.hash === target) enterBattle(root, getBattle(number));
  else window.location.hash = target;
}

/* ------------------------------------------------------------------ *
 * The campaign map
 * ------------------------------------------------------------------ */

function renderMap(root) {
  root.innerHTML = '';
  const progress = getStoryProgress();
  const complete = isCampaignComplete(progress);

  const topbar = el('div', 'topbar');
  topbar.appendChild(
    button('← Menu', 'btn btn--ghost', () => {
      window.location.hash = '#/';
    })
  );
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Story Mode'));
  titles.appendChild(
    el(
      'div',
      'topbar__sub',
      complete
        ? `The night is over — all ${BATTLE_COUNT} battles cleared.`
        : `Battle ${progress.currentBattle} of ${BATTLE_COUNT} · ${progress.cleared.length} cleared`
    )
  );
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup');
  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'Seven battles, played as one long night. Each one hands you the deck it wants to teach you, ' +
        'against the opponent that makes the point — until the last, which lets you bring whichever ' +
        `one you got on with. Lose a battle ${MAX_RETRIES} times and the night resets to the checkpoint. ` +
        'Progress is saved on this device only; nothing leaves your browser.'
    )
  );

  // --- The path ---------------------------------------------------------
  wrap.appendChild(el('h2', 'setup__heading', 'The night'));
  const path = el('div', 'story-path');
  for (const battle of BATTLES) {
    const cleared = isBattleCleared(battle.number, progress);
    const unlocked = isBattleUnlocked(battle.number, progress);
    const isNext = unlocked && !cleared;

    const node = el('button', 'setup-card story-card');
    node.type = 'button';
    node.dataset.battle = String(battle.number);
    if (cleared) node.classList.add('story-card--cleared');
    if (isNext) node.classList.add('story-card--next');
    if (!unlocked) {
      node.classList.add('story-card--locked');
      node.disabled = true;
    }

    node.appendChild(el('span', 'story-card__number', String(battle.number)));

    // Retries are only interesting on the battle you are actually stuck on.
    const losses = lossesOn(battle.number, progress);
    const status = cleared ? 'Cleared ✓' : isNext ? 'Next ▶' : 'Locked 🔒';
    const statusNode = el('span', 'story-card__status', status);
    if (isNext && losses > 0) {
      const left = retriesRemaining(battle.number, progress);
      statusNode.textContent = `Next ▶ · ${left} ${left === 1 ? 'retry' : 'retries'} left`;
      statusNode.classList.add('story-card__status--warn');
    }
    node.appendChild(statusNode);
    node.appendChild(el('span', 'setup-card__icon', unlocked ? battle.icon : '🔒'));
    node.appendChild(el('span', 'setup-card__title', unlocked ? battle.name : '???'));
    node.appendChild(el('span', 'setup-card__desc', unlocked ? battle.blurb : 'Clear the battle before it to find out.'));
    if (unlocked) {
      node.appendChild(el('span', 'setup-card__tag', battle.tagline));
      // Which deck the battle puts in your hands is half of what the battle IS,
      // so it belongs on the card rather than behind a click.
      const loadout = getLoadout(battle.playerDeck);
      const chip = el('span', 'story-card__deck');
      chip.classList.toggle('story-card__deck--choice', !loadout);
      chip.textContent = loadout ? `${loadout.icon} You play: ${loadout.name}` : '🎴 You play: your choice';
      node.appendChild(chip);
    }

    // The checkpoint is a property of the run, not of a battle, but the player
    // needs to see where it is before they need it rather than after.
    if (battle.number === CHECKPOINT_AFTER_BATTLE) {
      node.appendChild(el('span', 'story-card__checkpoint', '⚑ Checkpoint — fail past here and you return to the next battle'));
    }

    node.addEventListener('click', () => {
      if (unlocked) goBattle(battle.number);
    });
    path.appendChild(node);
  }
  wrap.appendChild(path);

  // --- Actions ----------------------------------------------------------
  const actions = el('div', 'story-map__actions');
  const current = getBattle(progress.currentBattle);
  if (complete) {
    actions.appendChild(button('▶ Replay the final battle', 'btn btn--primary', () => goBattle(BATTLE_COUNT)));
  } else {
    const label = progress.cleared.length === 0 ? '▶ Begin the night' : `▶ Continue — Battle ${current.number}: ${current.name}`;
    actions.appendChild(button(label, 'btn btn--primary', () => goBattle(progress.currentBattle)));
  }

  // Before the first trophy is earned there is no button, no hint, and nothing
  // that suggests the system exists. Earning it is the reveal.
  if (isShelfUnlocked()) {
    actions.appendChild(button('🏆 Trophy Shelf', 'btn', goTrophies));
  }

  if (progress.cleared.length || progress.currentBattle > 1) {
    actions.appendChild(
      button('Reset progress', 'btn btn--ghost', () => {
        if (window.confirm('Erase your Story Mode progress and start again from Battle 1?')) {
          resetStoryProgress();
          renderMap(root);
        }
      })
    );
  }
  wrap.appendChild(actions);

  root.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * One battle
 * ------------------------------------------------------------------ */

/**
 * Run one battle.
 *
 * `chosen` is only ever consulted for a PLAYER_CHOICE battle; for the other six
 * `resolvePlayerDeck` returns the assigned loadout and ignores it. Retrying goes
 * back through here, so a restart always re-applies the battle's own deck rather
 * than whatever the player happened to be holding last.
 */
function startBattle(root, battle, chosen = getChosenDeck()) {
  cleanup();
  const player = resolvePlayerDeck(battle, chosen);
  applyThemeFor({ deckId: player.deckId });

  // Read BEFORE the match writes anything: the trophies that ask "on your first
  // attempt?" mean the state of play as the player sat down.
  const lossesBefore = lossesOn(battle.number);

  // Authored, not dealt — see battleSetup.js. A battle with no `setup` block
  // still comes out as the ordinary seeded match it always was.
  const state = buildStoryBattle(battle, player, getProfileName());

  const controller = createController({
    state,
    botPlayer: BOT,
    difficulty: battle.difficulty,
    playstyle: battle.playstyle,
    botSeed: battle.seed + 977,
  });

  // The board is handed the WRAPPED controller, so the watcher sees the human's
  // actions as they are dispatched. See trophyWatch.js.
  const watch = watchBattle(controller, HUMAN);

  /**
   * Everything the result screen needs, decided once when the match ends.
   *
   * `resultExtra` and `resultActions` are called on every re-render of that
   * screen — switching to the battle-log tab calls them again — so they must be
   * pure reads. All the writing happens here, exactly once.
   */
  let outcome = null;

  // Snapshotted before the match can award anything, so "what is new" is honest.
  const heldBefore = new Set(Object.keys(getEarnedTrophies()));
  const shelfWasUnlocked = isShelfUnlocked();

  const unsubscribe = controller.subscribe((next) => {
    if (outcome || next.winner === null) return;
    const won = next.winner === HUMAN;
    const match = watch.summary(next);

    // Progress first: the trophies read it, and No Continues in particular is a
    // question about the record this result just became part of.
    const loss = won ? null : recordBattleLost(battle.number);
    const progress = won ? recordBattleCleared(battle.number) : loss.progress;

    const awarded = awardTrophies(earnedBy({ battle, won, match, lossesBefore, progress }, heldBefore).map((t) => t.id));

    outcome = {
      won,
      awarded,
      // True only for the one result screen that reveals the system.
      revealed: !shelfWasUnlocked && isShelfUnlocked(),
      retriesLeft: won ? MAX_RETRIES : loss.retriesRemaining,
      failedOut: won ? false : loss.failedOut,
      checkpoint: won ? null : loss.checkpoint,
      tip: won ? null : lossTip(battle.id, lossesBefore + 1),
    };
  });

  const after = nextBattle(battle.number);
  // An assigned battle names the loadout, because that name is the lesson. A
  // PLAYER_CHOICE battle names the actual deck, because the player chose it.
  const you = player.loadout
    ? `${player.loadout.icon} ${player.loadout.name}`
    : `${DECKS.find((d) => d.id === player.deckId).name} (${getArchetype(player.archetype)?.name ?? 'mixed'})`;

  const unmountBoard = mountBoard(root, {
    controller: watch.controller,
    viewer: HUMAN,
    title: `Story Mode · Battle ${battle.number}`,
    subtitle: `${battle.icon} ${battle.name} — ${you} vs ${battle.opponent}`,
    onExit: goMap,
    // Replaying the battle from the top is what "again" means in a campaign, and
    // the fixed seed means it is genuinely the same fight.
    onRematch: () => startBattle(root, battle, chosen),
    resultExtra: () => renderResultExtra(outcome, battle),
    resultActions: () => resultActionsFor(root, outcome, battle, after, chosen),
  });

  teardown = () => {
    watch.stop();
    unsubscribe();
    controller.destroy();
    unmountBoard();
  };
}

/* ------------------------------------------------------------------ *
 * The result screen: retries, the tip, and anything just earned
 * ------------------------------------------------------------------ */

function renderResultExtra(outcome, battle) {
  if (!outcome) return null;
  const box = el('div', 'story-result');

  if (!outcome.won) {
    if (outcome.failedOut) {
      // The rollback has already happened in storage by the time this renders —
      // see recordBattleLost. This is telling the player, not asking them.
      const banner = el('div', 'story-result__banner story-result__banner--fail');
      banner.appendChild(el('strong', null, 'Out of retries.'));
      banner.appendChild(
        el(
          'span',
          null,
          ` The night resets to Battle ${outcome.checkpoint}${
            outcome.checkpoint > 1 ? ' — the checkpoint.' : '.'
          }`
        )
      );
      box.appendChild(banner);
    } else {
      const banner = el('div', 'story-result__banner');
      banner.appendChild(
        el('strong', null, `${outcome.retriesLeft} ${outcome.retriesLeft === 1 ? 'retry' : 'retries'} remaining`)
      );
      banner.appendChild(
        el('span', null, ` on Battle ${battle.number}. Lose them all and the night resets to the checkpoint.`)
      );
      box.appendChild(banner);
    }

    if (outcome.tip) {
      const tip = el('div', 'story-result__tip');
      tip.appendChild(el('span', 'story-result__tip-who', `${battle.icon} ${battle.name}`));
      tip.appendChild(el('p', 'story-result__tip-text', outcome.tip));
      box.appendChild(tip);
    }
  }

  const awards = renderTrophyAwards(outcome.awarded, {
    revealed: outcome.revealed,
    onOpenShelf: goTrophies,
  });
  if (awards) box.appendChild(awards);

  return box.childNodes.length ? box : null;
}

function resultActionsFor(root, outcome, battle, after, chosen) {
  if (!outcome) return null;

  if (outcome.won) {
    return [
      after
        ? {
            label: `▶ Battle ${after.number}: ${after.name}`,
            className: 'btn btn--primary',
            onClick: () => goBattle(after.number),
          }
        : { label: '🌅 Dawn — the night is over', className: 'btn btn--primary', onClick: goMap },
      { label: 'Campaign map', className: 'btn', onClick: goMap },
    ];
  }

  if (outcome.failedOut) {
    return [
      {
        label: `↺ Restart from Battle ${outcome.checkpoint}`,
        className: 'btn btn--primary',
        onClick: () => goBattleFrom(root, outcome.checkpoint),
      },
      { label: 'Campaign map', className: 'btn', onClick: goMap },
    ];
  }

  return [
    {
      label: `↺ Try again (${outcome.retriesLeft} left)`,
      className: 'btn btn--primary',
      onClick: () => startBattle(root, battle, chosen),
    },
    { label: 'Campaign map', className: 'btn', onClick: goMap },
  ];
}

/* ------------------------------------------------------------------ *
 * Route entry
 * ------------------------------------------------------------------ */

/**
 * Enter a battle: deck select if it asks, straight into the fight if it does not.
 *
 * Split out of the route so the "restart from the checkpoint" button can reuse
 * it — that button sometimes targets the battle already in the address bar.
 */
function enterBattle(root, battle) {
  // The one battle that asks gets the setup screen; the other six start on the
  // deck they were built around. Note this is the ENTRY path only — "Try again"
  // from the result screen goes straight back into the fight, so a retry is not
  // six clicks away.
  if (battle.playerDeck === PLAYER_CHOICE) {
    renderStoryDeckSelect(root, {
      battle,
      onExit: goMap,
      onStart: (choice) => startBattle(root, battle, choice),
    });
    return;
  }
  startBattle(root, battle);
}

export function renderStory(root, { battleNumber = null } = {}) {
  cleanup();
  if (battleNumber === null) {
    renderMap(root);
    return;
  }
  const battle = getBattle(battleNumber);
  // An unknown or still-locked battle is a stale bookmark or a hand-typed hash,
  // not an error worth a screen of its own.
  if (!battle || !isBattleUnlocked(battle.number)) {
    goMap();
    return;
  }
  enterBattle(root, battle);
}
