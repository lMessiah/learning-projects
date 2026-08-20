/**
 * Story Mode — what the game says when you lose a battle.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 * `LOSS_TIPS[battleId]` is an array of strings, one per loss, escalating:
 *
 *   [0]  the first loss   — a nudge. Names the shape of the problem, not the fix.
 *   [1]  the second loss  — the fix, in terms of what to do differently.
 *   [2]  the third loss   — near-explicit. Says the actual play.
 *
 * Edit the wording freely; nothing reads these but `lossTip` below. Adding a
 * fourth entry works and is used on a fourth loss if MAX_RETRIES is raised.
 *
 * ── Why keyed by id and not number ────────────────────────────────────────
 *
 * Reordering the campaign moves battle numbers around. Tips are about the
 * *opponent*, so they follow the opponent — move Battle 5 to slot 2 and its
 * tips go with it, rather than being handed to whoever is standing in slot 5.
 *
 * ── Why escalate at all ───────────────────────────────────────────────────
 *
 * A player who lost once may well have seen the problem and misplayed anyway;
 * telling them the answer immediately takes the fight away from them. A player
 * who has lost three times is not enjoying being taught by inference. The
 * third-loss text is allowed to simply say it.
 */
import { BATTLES } from './campaign.js';

export const LOSS_TIPS = Object.freeze({
  'first-night': [
    'Nothing here is trying to trick you. Take a look at what your Persona can actually do — the skill list is on your active card.',
    'Skills cost SP, and you get some back every turn. Attacking with a skill hits harder than a plain attack; ending your turn with SP unspent wastes it.',
    'Pick your biggest attack, use it on their active Persona, end your turn, and repeat. That is the whole fight — it is meant to be.',
  ],
  'the-exposed': [
    'Watch what happens to the board when you use different attacks. One of them does something the others do not.',
    'Hitting an element a Persona is weak to does double damage and knocks it down — and a knockdown hands you another action. Which of Orpheus\'s two attacks does that here?',
    'Everything they field is weak to fire. Lead with Agi every turn: it doubles, it knocks down, and the One More it grants lets you attack again before they move.',
  ],
  'two-faces': [
    'The attack that carried you through the last two fights is doing noticeably less here. Look at the damage numbers.',
    'They resist fire, so Orpheus is the wrong Persona for this fight — and resisting one element usually means folding to another. Check what else is in your deck.',
    'Change your active to Jack Frost and use Bufu. They are weak to ice, so it doubles and knocks them down, exactly the way fire did last night. Swapping is free; not swapping is the mistake.',
  ],
  'the-hunger': [
    'Count how much damage you do in a turn, then watch how much it heals back. That gap is the fight.',
    'Nothing in your deck is big enough to out-damage that heal, and there is no weakness here to lean on. You need a Persona your deck does not contain.',
    'Fuse. From turn 4 you can combine two Personas on your field into a much bigger one — put Silky and Omoikane down (they are in your opening hand), then fuse them into Kikuri-Hime and hit with that.',
  ],

  // Battles 5-8 keep placeholder tips until Parts B and C build those fights.
  'the-rush': [
    'You are playing a fast deck slowly. Notice how cheap your skills are.',
    'This deck wants to take several actions a turn, not one big one. Weakness hits give you extra actions — spend them.',
    'Chain it: hit a weakness, take the One More, hit again. The deck is built to keep that going, and this opponent folds to it.',
  ],
  'the-wall': [
    'Look at how much of your damage is actually sticking between its turns.',
    'Small hits are being healed off faster than you land them. Size matters here, not frequency.',
    'Build one enormous Physical hit — buff your attack, then swing. Cracking it below half HP is what finally lets you knock it down.',
  ],
  'the-siege': [
    'You are trying to win the opening. You cannot win the opening.',
    'This deck is not built to trade early — it is built to still be standing later. Endurance and healing buy the turns you need.',
    'Stack Endurance, heal, and keep your wall above half HP so it cannot be knocked down. Let their aggression burn out, then start attacking.',
  ],
  nyx: [
    'She does everything the night taught you, at once. Which part of it actually killed you?',
    'Every one of her big moves has a wind-up you can see coming. React to the tell rather than to the damage.',
    'Watch for the phase change when she drops to half HP. Her threats are the same set each time but the order changes — read the telegraph, answer it, and do not commit your whole turn while one is charging.',
  ],
});

/**
 * The tip for a battle at a given loss count.
 *
 * @param battleId  campaign id, e.g. 'half-moon'
 * @param attempt   which loss this is, 1-based
 * @returns the tip string, or null if the battle has no tips authored
 *
 * Out-of-range attempts clamp to the last tip rather than disappearing: a
 * player on their fourth loss needs the clearest one, not silence.
 */
export function lossTip(battleId, attempt) {
  const tips = LOSS_TIPS[battleId];
  if (!tips?.length) return null;
  const index = Math.min(Math.max(Math.trunc(attempt), 1), tips.length) - 1;
  return tips[index];
}

/** How many escalation steps a battle has authored. */
export function tipDepth(battleId) {
  return LOSS_TIPS[battleId]?.length ?? 0;
}

/** Every battle id the campaign uses that has no tips. Empty is the goal. */
export function battlesMissingTips() {
  return BATTLES.filter((battle) => !tipDepth(battle.id)).map((battle) => battle.id);
}
