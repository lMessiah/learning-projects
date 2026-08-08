/**
 * Tunable rule constants. Everything the designers might want to retune lives
 * here so the rest of the engine never hard-codes a number.
 */
export const CONFIG = Object.freeze({
  // Board
  FIELD_CAP: 8, // active + bench, KO'd Personas don't count
  KO_TARGET: 8, // KO this many of the opponent's Personas to win

  // Power curve: a Persona card can only be played to the field if its printed
  // level is at most (highest level among your field Personas + this). High
  // tier cards sit in hand until the rest of your board has grown into them,
  // so a turn-3 draw can never drop a level 46 Persona onto the board.
  PLAY_LEVEL_GAP: 10,
  // Nothing above this level appears in a prebuilt deck; stronger Personas are
  // fusion-only. Enforced by validateDatabase().
  DECK_MAX_PERSONA_LEVEL: 25,

  // Cards
  OPENING_HAND: 5,
  DRAW_PER_TURN: 1,
  PASS_DRAW: 1, // extra card drawn when you pass your action
  HAND_LIMIT: 7, // discard down to this at end of turn

  // Per-turn allowances
  ACTIONS_PER_TURN: 1,
  PERSONA_CHANGES_PER_TURN: 1,
  MAX_ONE_MORE_PER_TURN: 1,
  ITEMS_PER_TURN: 1, // you may play at most one Item card per turn
  SPECIALS_PER_TURN: 1, // ...and at most one Special card per turn

  // SP economy
  SP_REGEN_PER_TURN: 3,

  // Damage multipliers
  WEAK_MULT: 2,
  RESIST_MULT: 0.5,
  GUARD_MULT: 0.5,
  BUFF_MULT: 1.4, // debuffs divide by this
  CHARGE_MULT: 2.5, // Concentrate / Charge
  SHOCK_TAKEN_MULT: 1.5,

  // Basic attack (no cost, always available)
  BASIC_ATTACK_POWER: 30,

  // Status ailments
  BURN_DAMAGE: 5,
  BURN_DURATION: 3,
  SHOCK_DURATION: 1, // expires at the end of the victim's next turn
  BUFF_DURATION: 3,

  // Levelling
  LEVEL_UP_GAP: 3, // victim level >= killer level + this  ->  +2 levels instead of +1

  // Deck out
  FATIGUE_DAMAGE: 5, // per stack, to all of that player's Personas, each of their turns
});

export const MAGIC_TYPES = Object.freeze(['fire', 'ice', 'elec', 'wind', 'light', 'dark', 'almighty']);

/** Which stat a skill attacks with. */
export function skillCategory(type) {
  if (type === 'phys') return 'phys';
  if (MAGIC_TYPES.includes(type)) return 'magic';
  return 'support';
}
