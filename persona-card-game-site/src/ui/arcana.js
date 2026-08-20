/**
 * Presentation-only lookup tables: arcana palettes/symbols and damage-type icons.
 *
 * All card art in this project is placeholder CSS — a coloured frame, a symbol
 * and text. No official artwork, sprites or logos are used.
 */

export const ARCANA_STYLE = {
  Fool: { symbol: '🃏', hue: 0, color: '#e63946', ink: '#ffd9dd' },
  Magician: { symbol: '🎩', hue: 20, color: '#f4791f', ink: '#ffe4cc' },
  Priestess: { symbol: '🌙', hue: 205, color: '#4aa3df', ink: '#d7ecff' },
  Empress: { symbol: '👑', hue: 320, color: '#d64f9e', ink: '#ffd9f0' },
  Emperor: { symbol: '🏛️', hue: 45, color: '#d9a441', ink: '#fff0cc' },
  Hierophant: { symbol: '📜', hue: 35, color: '#b98b4e', ink: '#f5e3c8' },
  Lovers: { symbol: '💞', hue: 340, color: '#ef6f8c', ink: '#ffe0e7' },
  Chariot: { symbol: '🛞', hue: 15, color: '#c1552f', ink: '#ffdccf' },
  Justice: { symbol: '⚖️', hue: 190, color: '#3fb8b0', ink: '#d4f5f2' },
  Hermit: { symbol: '🔦', hue: 265, color: '#8a6fd1', ink: '#e6dcff' },
  Fortune: { symbol: '🎡', hue: 100, color: '#6bbf59', ink: '#ddf5d6' },
  Strength: { symbol: '🦁', hue: 50, color: '#e0b83c', ink: '#fff4cc' },
  'Hanged Man': { symbol: '🙃', hue: 165, color: '#4bb98a', ink: '#d7f5e8' },
  Death: { symbol: '💀', hue: 240, color: '#6c6f9c', ink: '#dcdeff' },
  Temperance: { symbol: '🍶', hue: 180, color: '#4fb3c9', ink: '#d6f2f8' },
  Devil: { symbol: '😈', hue: 285, color: '#9b4fd1', ink: '#eddcff' },
  Tower: { symbol: '🗼', hue: 5, color: '#cf3a2f', ink: '#ffd6d2' },
  Star: { symbol: '⭐', hue: 215, color: '#5b7fe0', ink: '#dbe5ff' },
  Moon: { symbol: '🌗', hue: 250, color: '#7a6ad1', ink: '#e2dcff' },
  Sun: { symbol: '☀️', hue: 40, color: '#f0a91e', ink: '#ffeec4' },
  Judgement: { symbol: '🎺', hue: 48, color: '#e3c14a', ink: '#fff6d1' },
};

const FALLBACK_ARCANA = { symbol: '❔', hue: 0, color: '#8b8b8b', ink: '#e8e8e8' };

export function arcanaStyle(arcana) {
  return ARCANA_STYLE[arcana] || FALLBACK_ARCANA;
}

/**
 * Personas that carry their own icon instead of their arcana's.
 *
 * Card "art" in this project is an emoji on a gradient, and by default that
 * emoji is the arcana's — so every Priestess looks like every other Priestess.
 * That is fine for the long tail and wrong for the three cards the game is
 * actually built around: Pixie, Ara Mitama and Slime are the starting triad
 * (see STARTER_SIGNATURES in data/cards.js), they beat each other in a cycle,
 * and the tutorial teaches that cycle by name. They should be recognisable at a
 * glance on a crowded board.
 *
 * This is presentation only. Arcana, palette and every rule that reads them are
 * untouched — a Pixie is still Lovers, and still draws the Lovers colour.
 */
export const PERSONA_SYMBOL = {
  pixie: '🧚',
  'ara-mitama': '🩸',
  slime: '🫠',
};

/** A Persona's own icon, falling back to its arcana's. */
export function personaSymbol(persona) {
  return PERSONA_SYMBOL[persona?.id] ?? arcanaStyle(persona?.arcana).symbol;
}

export const TYPE_ICON = {
  phys: '👊',
  fire: '🔥',
  ice: '❄️',
  elec: '⚡',
  wind: '🌪️',
  light: '✨',
  dark: '🌑',
  almighty: '💠',
  heal: '💚',
  buff: '🔺',
  debuff: '🔻',
  ailment: '☠️',
};

export const TYPE_LABEL = {
  phys: 'Phys',
  fire: 'Fire',
  ice: 'Ice',
  elec: 'Elec',
  wind: 'Wind',
  light: 'Light',
  dark: 'Dark',
  almighty: 'Almighty',
  heal: 'Heal',
  buff: 'Buff',
  debuff: 'Debuff',
  ailment: 'Ailment',
};

export function typeIcon(type) {
  return TYPE_ICON[type] || '•';
}

export function typeLabel(type) {
  return TYPE_LABEL[type] || type;
}

export const CARD_TYPE_STYLE = {
  persona: { label: 'Persona', symbol: '🎭' },
  item: { label: 'Item', symbol: '🧪', color: '#3fb8b0' },
  special: { label: 'Special', symbol: '🌀', color: '#e63946' },
};
