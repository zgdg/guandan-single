import { describe, expect, it } from 'vitest';
import type { Level, PatternType } from '../../src/core/types';
import { recognize, selectPattern } from '../../src/core/patterns';
import { CONFIG, cards, configWith, patternsOf, typesOf } from '../helpers/cards';

type ValidCase = { spec: string; type: PatternType; level?: Level; config?: Partial<typeof CONFIG> };
type InvalidCase = ValidCase;

const VALID: ValidCase[] = [
  { spec: 'S5', type: 'SINGLE' },
  { spec: 'BJ', type: 'SINGLE' },
  { spec: 'S5 H5', type: 'PAIR' },
  { spec: 'BJ BJ', type: 'PAIR' },
  { spec: 'SJ SJ', type: 'PAIR' },
  { spec: 'S5 H5 C5', type: 'TRIPLE' },
  { spec: 'S3 H3 C3 S4 H4', type: 'FULL_HOUSE' },
  { spec: 'S3 H3 C3 BJ BJ', type: 'FULL_HOUSE' },
  { spec: 'S3 H3 H7 S4 H4', type: 'FULL_HOUSE', level: 7 },
  { spec: 'S3 H3 C3 S4 H7', type: 'FULL_HOUSE', level: 7 },
  { spec: 'S3 H4 C5 D6 S7', type: 'STRAIGHT' },
  { spec: 'S10 HJ CQ DK SA', type: 'STRAIGHT' },
  { spec: 'SA H2 C3 D4 S5', type: 'STRAIGHT' },
  { spec: 'S5 H6 S8 D9 H7', type: 'STRAIGHT', level: 7 },
  { spec: 'S3 S4 S5 S6 S7', type: 'STRAIGHT_FLUSH' },
  { spec: 'S10 S-J SQ SK SA', type: 'STRAIGHT_FLUSH' },
  { spec: 'SA S2 S3 S4 S5', type: 'STRAIGHT_FLUSH' },
  { spec: 'S5 S6 S8 S9 H7', type: 'STRAIGHT_FLUSH', level: 7 },
  { spec: 'S3 H3 S4 H4 S5 H5', type: 'TUBE' },
  { spec: 'SA HA S2 H2 S3 H3', type: 'TUBE' },
  { spec: 'SQ HQ SK HK SA HA', type: 'TUBE' },
  { spec: 'S3 H3 S4 S5 H5 H7', type: 'TUBE', level: 7 },
  { spec: 'S3 H3 C3 S4 H4 C4', type: 'PLATE' },
  { spec: 'SA HA CA S2 H2 C2', type: 'PLATE' },
  { spec: 'SK HK CK SA HA CA', type: 'PLATE' },
  { spec: 'S3 H3 C3 S4 H4 H7', type: 'PLATE', level: 7 },
  { spec: 'S9 H9 C9 D9', type: 'BOMB' },
  { spec: 'S9 H9 C9 D9 S9', type: 'BOMB' },
  { spec: 'S9 H9 C9 D9 S9 H9', type: 'BOMB' },
  { spec: 'S9 H9 C9 H2', type: 'BOMB' },
  { spec: 'S9 H9 C9 D9 S9 H9 C9 D9 H2 H2', type: 'BOMB' },
  { spec: 'BJ BJ SJ SJ', type: 'KING_BOMB' },
];

const INVALID: InvalidCase[] = [
  { spec: 'S5 H6', type: 'PAIR' },
  { spec: 'BJ SJ', type: 'PAIR' },
  { spec: 'BJ BJ SJ', type: 'TRIPLE' },
  { spec: 'S5', type: 'PAIR' },
  { spec: 'S5 H5 C5 D5', type: 'TRIPLE' },
  { spec: 'S3 H3 C3 S4 D5', type: 'FULL_HOUSE' },
  { spec: 'S3 H3 C3 BJ SJ', type: 'FULL_HOUSE' },
  { spec: 'S3 H3 C3 S4 H4 S5', type: 'FULL_HOUSE' },
  { spec: 'S3 H4 C5 D6 S8', type: 'STRAIGHT' },
  { spec: 'SJ SQ SK SA H2', type: 'STRAIGHT', level: 7 },
  { spec: 'S3 H4 C5 D6 S7 H8', type: 'STRAIGHT' },
  { spec: 'S3 H4 C5 D6 BJ', type: 'STRAIGHT' },
  { spec: 'S3 H4 S5 S6 S7', type: 'STRAIGHT_FLUSH' },
  { spec: 'S3 S4 S5 S6 S7 S8', type: 'STRAIGHT_FLUSH' },
  { spec: 'S3 S4 S5 S6 H7', type: 'STRAIGHT_FLUSH' },
  { spec: 'S3 H3 S4 H4', type: 'TUBE' },
  { spec: 'S3 H3 S4 H4 S5 H5 S6 H6', type: 'TUBE' },
  { spec: 'SK HK SA HA S2 H2', type: 'TUBE', level: 7 },
  { spec: 'S3 H3 C3 S4 H4', type: 'PLATE' },
  { spec: 'S3 H3 C3 S4 H4 C4 S5 H5 C5', type: 'PLATE' },
  { spec: 'S9 H9 C9 D10', type: 'BOMB' },
  { spec: 'BJ BJ SJ H2', type: 'KING_BOMB' },
];

describe('牌型识别：合法牌型', () => {
  it.each(VALID)('$spec 能识别为 $type', ({ spec, type, level, config }) => {
    const ruleConfig = config ? configWith(config) : CONFIG;
    expect(typesOf(spec, level ?? 2, ruleConfig)).toContain(type);
  });
});

describe('牌型识别：非法/不成立的组合', () => {
  it.each(INVALID)('$spec 不应识别为 $type', ({ spec, type, level, config }) => {
    const ruleConfig = config ? configWith(config) : CONFIG;
    expect(typesOf(spec, level ?? 2, ruleConfig)).not.toContain(type);
  });
});

describe('牌型识别的通用约束', () => {
  it('空牌返回空结果', () => {
    expect(recognize([], 2, CONFIG)).toEqual([]);
  });

  it('重复 cardId 直接报错，不能按花色+牌点去重', () => {
    const [card] = cards('S5');
    expect(() => recognize([card!, card!], 2, CONFIG)).toThrow(/E_DUPLICATE_CARD/);
  });

  it('一组牌有多种解释时不自动选最强', () => {
    const candidates = patternsOf('S3 H3 H7 H4 C4', 7);
    expect(candidates.filter((item) => item.type === 'FULL_HOUSE')).toHaveLength(2);
    expect(selectPattern(candidates)).toBeUndefined();
  });

  it('可通过声明锁定三带对的三同张牌点', () => {
    const candidates = patternsOf('S3 H3 H7 H4 C4', 7);
    const chosen = selectPattern(candidates, { type: 'FULL_HOUSE', tripleRank: 3 });
    expect(chosen?.tripleRank).toBe(3);
    const other = selectPattern(candidates, { type: 'FULL_HOUSE', tripleRank: 4 });
    expect(other?.tripleRank).toBe(4);
  });

  it('纯天然同花顺不会同时给出普通顺子解释', () => {
    const types = typesOf('S3 S4 S5 S6 S7');
    expect(types).toContain('STRAIGHT_FLUSH');
    expect(types).not.toContain('STRAIGHT');
  });

  it('带逢人配的同花顺同时保留顺子解释', () => {
    const types = typesOf('S5 S6 S8 S9 H7', 7);
    expect(types).toContain('STRAIGHT_FLUSH');
    expect(types).toContain('STRAIGHT');
  });
});
