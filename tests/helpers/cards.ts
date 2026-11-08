import type { Card, Level, Pattern, PatternSelector, NormalRank, Rank, Suit } from '../../src/core/types';
import { recognize, selectPattern } from '../../src/core/patterns';
import { mergeRuleConfig, type RuleConfig } from '../../src/core/config';

const RANK_MAP: Record<string, Rank> = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

let autoId = 0;

/** 创建一张唯一的测试牌（id 自动递增，避免不同手牌之间撞 id）。 */
export function c(suit: Suit | 'JOKER', rank: Rank, copy: 0 | 1 = 0): Card {
  const id = `${copy}-${suit}-${rank}-${autoId++}`;
  return { id, suit, rank, copy };
}

/**
 * 便捷牌组：`"S3 H4 C5 D6 S7"`、`"BJ BJ SJ"`。
 * 注意 `SJ` 固定表示小王；需要「黑桃 J」时用 `S-J` 这种带连字符的写法。
 * 同一花色牌点重复出现时自动递增副本序号。
 */
export function cards(spec: string): Card[] {
  const used = new Map<string, number>();
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token === 'BJ') return c('JOKER', 16, nextCopy(used, 'JOKER-16'));
      if (token === 'SJ') return c('JOKER', 15, nextCopy(used, 'JOKER-15'));
      const [suitText, rankText] = token.includes('-') ? token.split('-') : [token[0]!, token.slice(1)];
      const suit = suitText as Suit;
      if (!['S', 'H', 'C', 'D'].includes(suit)) throw new Error(`无法解析测试牌：${token}`);
      const rank = RANK_MAP[rankText!];
      if (!rank) throw new Error(`无法解析测试牌：${token}`);
      const copy = nextCopy(used, `${suit}-${rank}`);
      return c(suit, rank, copy);
    });
}

function nextCopy(used: Map<string, number>, key: string): 0 | 1 {
  const next = used.get(key) ?? 0;
  used.set(key, next + 1);
  if (next > 1) throw new Error(`测试牌超过两副：${key}`);
  return next as 0 | 1;
}

export const LEVEL_DEFAULT: Level = 2;
export const CONFIG: RuleConfig = mergeRuleConfig();

export function configWith(partial: Partial<RuleConfig>): RuleConfig {
  return mergeRuleConfig(partial);
}

export function typesOf(spec: string, level: Level = LEVEL_DEFAULT, config: RuleConfig = CONFIG): string[] {
  return recognize(cards(spec), level, config).map((pattern) => pattern.type);
}

export function patternsOf(
  spec: string,
  level: Level = LEVEL_DEFAULT,
  config: RuleConfig = CONFIG,
): Pattern[] {
  return recognize(cards(spec), level, config);
}

export function patternOf(
  spec: string,
  selector?: PatternSelector,
  level: Level = LEVEL_DEFAULT,
  config: RuleConfig = CONFIG,
): Pattern {
  const candidates = recognize(cards(spec), level, config);
  const pattern = selectPattern(candidates, selector);
  if (!pattern) throw new Error(`测试牌无法唯一识别为 ${selector?.type ?? '唯一牌型'}：${spec}`);
  return pattern;
}

export function patternByType(
  spec: string,
  type: Pattern['type'],
  level: Level = LEVEL_DEFAULT,
  config: RuleConfig = CONFIG,
): Pattern {
  return patternOf(spec, { type }, level, config);
}

export function seats(): Record<'S' | 'W' | 'N' | 'E', number | null> {
  return { S: null, W: null, N: null, E: null };
}

export function normal(rank: Rank): NormalRank {
  return rank as NormalRank;
}
