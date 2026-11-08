import type { Pattern } from './types';
import type { RuleConfig } from './config';

/** 炸弹类层级：1=4炸，2=5炸，3=同花顺，4=6+炸，5=四大天王；4.5=变体「同花顺 > 6+炸」。 */
export function bombTier(pattern: Pattern, config: RuleConfig): number {
  if (pattern.type === 'KING_BOMB') return 5;
  if (pattern.type === 'STRAIGHT_FLUSH') {
    return config.bombTierMode === 'flushAboveSixBomb' ? 4.5 : 3;
  }
  if (pattern.type === 'BOMB') {
    if (pattern.count >= 6) return 4;
    if (pattern.count === 5) return 2;
    return 1;
  }
  return 0;
}

export function isBombPattern(pattern: Pattern): boolean {
  return pattern.type === 'BOMB' || pattern.type === 'STRAIGHT_FLUSH' || pattern.type === 'KING_BOMB';
}

const SUIT_POWER: Record<string, number> = { S: 4, H: 3, C: 2, D: 1 };

/**
 * b 能否压过 a。
 * - 普通牌型：同类型、同张数、主键严格更大。
 * - 炸弹类：按配置的层级比较；同层再比张数/牌力；同花顺默认不比花色。
 */
export function beats(b: Pattern, a: Pattern, config: RuleConfig): boolean {
  const aBomb = isBombPattern(a);
  const bBomb = isBombPattern(b);
  if (aBomb && !bBomb) return false;
  if (!aBomb && bBomb) return true;

  if (aBomb && bBomb) {
    const ta = bombTier(a, config);
    const tb = bombTier(b, config);
    if (tb !== ta) return tb > ta;
    if (a.type === 'KING_BOMB' && b.type === 'KING_BOMB') return false;
    if (a.type === 'STRAIGHT_FLUSH' && b.type === 'STRAIGHT_FLUSH') {
      if (b.mainRank !== a.mainRank) return b.mainRank > a.mainRank;
      if (!config.compareStraightFlushSuit) return false;
      return (SUIT_POWER[b.suit ?? ''] ?? 0) > (SUIT_POWER[a.suit ?? ''] ?? 0);
    }
    if (a.type === 'BOMB' && b.type === 'BOMB') {
      if (b.count !== a.count) return b.count > a.count;
      return b.mainRank > a.mainRank;
    }
    return false;
  }

  if (b.type !== a.type) return false;
  if (b.count !== a.count) return false;
  return b.mainRank > a.mainRank;
}

/** 返回可读的牌型名称，供错误信息/测试使用。 */
export function patternName(pattern: Pattern): string {
  switch (pattern.type) {
    case 'SINGLE':
      return '单张';
    case 'PAIR':
      return '对子';
    case 'TRIPLE':
      return '三同张';
    case 'FULL_HOUSE':
      return '三带对';
    case 'STRAIGHT':
      return '顺子';
    case 'TUBE':
      return '三连对';
    case 'PLATE':
      return '钢板';
    case 'BOMB':
      return `${pattern.count} 张炸弹`;
    case 'STRAIGHT_FLUSH':
      return '同花顺';
    case 'KING_BOMB':
      return '四大天王';
  }
}
