import type { Card, Level, PlayOption } from '../core/types';
import type { RuleConfig } from '../core/config';
import { groupByRank, isWildcard } from '../core/cards';

/**
 * 手牌评估：对局 AI 与 PIMC 叶子评估共用。
 * 只用自己手牌，不读取任何其他座位的信息。
 */

/** 粗估还要几手才能走完：按非空牌点组数计，逢人配可合并半手。 */
export function estimateHandTurns(hand: Card[], level: Level, config: RuleConfig): number {
  const wilds = hand.filter((card) => isWildcard(card, level, config)).length;
  const naturals = hand.filter((card) => !isWildcard(card, level, config));
  const groups = groupByRank(naturals);
  const reduction = Math.min(wilds, Math.max(0, groups.size - 1)) * 0.5;
  return Math.max(0, groups.size - reduction);
}

/** 打出某个选项后，剩余手牌的预计手数。 */
export function turnsAfterPlay(
  hand: Card[],
  option: PlayOption,
  level: Level,
  config: RuleConfig,
): number {
  const used = new Set(option.cards.map((card) => card.id));
  return estimateHandTurns(
    hand.filter((card) => !used.has(card.id)),
    level,
    config,
  );
}

/** 估算炸弹数量（四张同点 + 四大天王），用于「是否保留控场手段」的判断。 */
export function countBombs(hand: Card[], level: Level, config: RuleConfig): number {
  const naturals = hand.filter((card) => !isWildcard(card, level, config));
  const groups = groupByRank(naturals);
  let bombs = 0;
  for (const [, cards] of groups) {
    if (cards.length >= 4) bombs += 1;
  }
  const bigKings = groups.get(16)?.length ?? 0;
  const smallKings = groups.get(15)?.length ?? 0;
  if (bigKings >= 2 && smallKings >= 2) bombs += 1;
  return bombs;
}

/** 这手牌是否拆掉了四张同点的炸弹胚子（只影响解释与评估，不改变合法性）。 */
export function breaksBomb(hand: Card[], option: PlayOption, level: Level, config: RuleConfig): boolean {
  const naturalGroups = groupByRank(hand.filter((card) => !isWildcard(card, level, config)));
  for (const [, cards] of naturalGroups) {
    if (cards.length < 4) continue;
    const used = option.cards.filter(
      (card) => card.rank === cards[0]!.rank && !isWildcard(card, level, config),
    ).length;
    if (used > 0) return true;
  }
  return false;
}
