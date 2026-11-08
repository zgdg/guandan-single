import type { Card, Level, Rank, Seat, Suit, Team } from './types';
import { SEAT_ORDER_CCW, SEAT_ORDER_CW } from './types';
import type { RuleConfig } from './config';

/** 可复现随机数：mulberry32。所有洗牌/随机必须先注入种子。 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

/** 108 张：2 副 × (4 花色 × 13 点 + 2 王)。 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  const suits: Suit[] = ['S', 'H', 'C', 'D'];
  for (const copy of [0, 1] as const) {
    for (const suit of suits) {
      for (let rank = 2; rank <= 14; rank += 1) {
        deck.push({
          id: `${copy}-${suit}-${rank}`,
          suit,
          rank: rank as Rank,
          copy,
        });
      }
    }
    for (const rank of [15, 16] as const) {
      deck.push({ id: `${copy}-JOKER-${rank}`, suit: 'JOKER', rank, copy });
    }
  }
  return deck;
}

/**
 * 牌力（用于单张/对子/三同张/三带对的三同张/炸弹比较）：
 * 大王 100 > 小王 99 > 级牌 98 > A 14 > K 13 > ... > 2。
 */
export function powerRank(card: Card, level: Level): number {
  if (card.rank === 16) return 100;
  if (card.rank === 15) return 99;
  if (card.rank === level) return 98;
  return card.rank;
}

/**
 * 炸弹牌力：默认与 powerRank 相同（级牌炸弹高于 A 炸弹）。
 * 关闭 levelBombBoost 时，级牌炸弹按自然牌点比较（D13）。
 */
export function bombPowerRank(card: Card, level: Level, config: RuleConfig): number {
  if (card.rank === level && !config.levelBombBoost) return card.rank;
  return powerRank(card, level);
}

/**
 * 连续牌型的自然牌点：级牌回到自然位置，A 由具体窗口决定作 1 或 14。
 * 返回 2–14；王不允许进入连续牌型。
 */
export function sequenceRank(card: Card): number {
  if (card.rank === 15 || card.rank === 16) {
    throw new Error(`E_SEQUENCE_JOKER: 王不能进入连续牌型 (${card.id})`);
  }
  return card.rank;
}

/** 逢人配 = 红桃级牌（最多 2 张）。 */
export function isWildcard(card: Card, level: Level, config: RuleConfig): boolean {
  return config.wildcardEnabled && card.suit === 'H' && card.rank === level;
}

export function teamOf(seat: Seat): Team {
  return seat === 'S' || seat === 'N' ? 'NS' : 'WE';
}

export function partnerSeat(seat: Seat): Seat {
  switch (seat) {
    case 'S':
      return 'N';
    case 'N':
      return 'S';
    case 'E':
      return 'W';
    case 'W':
      return 'E';
  }
}

export function nextSeat(seat: Seat, config: RuleConfig): Seat {
  const order = config.playDirection === 'counterclockwise' ? SEAT_ORDER_CCW : SEAT_ORDER_CW;
  const index = order.indexOf(seat);
  return order[(index + 1) % order.length]!;
}

export function playOrder(config: RuleConfig): readonly Seat[] {
  return config.playDirection === 'counterclockwise' ? SEAT_ORDER_CCW : SEAT_ORDER_CW;
}

const SUIT_SORT_ORDER: Record<string, number> = { S: 0, H: 1, C: 2, D: 3, JOKER: 4 };

/** 手牌展示排序：牌力降序、同点按花色固定顺序、再按副本。 */
export function sortHand(cards: Card[], level: Level): Card[] {
  return [...cards].sort((a, b) => {
    const pa = powerRank(a, level);
    const pb = powerRank(b, level);
    if (pb !== pa) return pb - pa;
    const sa = SUIT_SORT_ORDER[a.suit] ?? 9;
    const sb = SUIT_SORT_ORDER[b.suit] ?? 9;
    if (sa !== sb) return sa - sb;
    return a.copy - b.copy;
  });
}

export function groupByRank(cards: Card[]): Map<Rank, Card[]> {
  const groups = new Map<Rank, Card[]>();
  for (const card of cards) {
    const list = groups.get(card.rank) ?? [];
    list.push(card);
    groups.set(card.rank, list);
  }
  return groups;
}

export function sameCard(a: Card, b: Card): boolean {
  return a.id === b.id;
}
