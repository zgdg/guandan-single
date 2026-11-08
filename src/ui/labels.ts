import type { Card, Level, Seat } from '../core/types';

export const SUIT_ICON: Record<string, string> = {
  S: '♠',
  H: '♥',
  C: '♣',
  D: '♦',
};

export const RANK_LABEL: Record<number, string> = {
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
  15: '小',
  16: '大',
};

export const SEAT_LABEL: Record<Seat, string> = {
  S: '你 · 南家',
  N: '北家 · 队友',
  E: '东家 · 对手',
  W: '西家 · 对手',
};

export const SEAT_SHORT: Record<Seat, string> = {
  S: '你',
  N: '队友',
  E: '东家',
  W: '西家',
};

export { PERSONA } from '../ai/persona';

export function cornerRank(card: Card): string {
  if (card.rank === 15) return '小';
  if (card.rank === 16) return '大';
  return RANK_LABEL[card.rank] ?? String(card.rank);
}

export function suitText(card: Card): string {
  if (card.suit === 'JOKER') return '王';
  return SUIT_ICON[card.suit] ?? '';
}

export function isRed(card: Card): boolean {
  return card.suit === 'H' || card.suit === 'D' || card.rank === 16;
}

export function isWild(card: Card, level: Level): boolean {
  return card.suit === 'H' && card.rank === level;
}

export function placeText(place: number | null): string {
  if (place === null) return '';
  return ['头游', '二游', '三游', '末游'][place - 1] ?? '';
}

/** 单张牌的简短文字，如「♠8」「大王」，用于建议与复盘里的牌面摘要。 */
export function cardText(card: Card): string {
  if (card.rank === 16) return '大王';
  if (card.rank === 15) return '小王';
  return `${suitText(card)}${cornerRank(card)}`;
}
