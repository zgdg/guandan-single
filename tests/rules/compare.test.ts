import { describe, expect, it } from 'vitest';
import type { Level, PatternType } from '../../src/core/types';
import type { RuleConfig } from '../../src/core/config';
import { beats } from '../../src/core/compare';
import { CONFIG, configWith, patternByType, patternOf } from '../helpers/cards';

type CompareCase = {
  desc: string;
  a: string;
  b: string;
  expected: boolean;
  level?: Level;
  config?: Partial<RuleConfig>;
  aType?: PatternType;
  bType?: PatternType;
};

const CASES: CompareCase[] = [
  { desc: '单张级牌 7 > 单张 A', a: 'SA', b: 'S7', expected: true, level: 7 },
  { desc: '单张小王 > 单张级牌 7', a: 'S7', b: 'SJ', expected: true, level: 7 },
  { desc: '单张大王 > 单张小王', a: 'SJ', b: 'BJ', expected: true },
  { desc: '单张级牌不能压小王', a: 'SJ', b: 'S7', expected: false, level: 7 },
  { desc: '对级牌 > 对 A', a: 'SA HA', b: 'S7 C7', expected: true, level: 7 },
  { desc: '对大王 > 对级牌', a: 'S7 C7', b: 'BJ BJ', expected: true, level: 7 },
  { desc: '三张级牌 > 三张 A', a: 'SA HA CA', b: 'S7 C7 D7', expected: true, level: 7 },
  { desc: '三带对只比三同张，9 > 8', a: 'S8 H8 C8 SA HA', b: 'S9 H9 C9 S3 H3', expected: true, aType: 'FULL_HOUSE', bType: 'FULL_HOUSE' },
  { desc: '顺子 6-10 > 5-9', a: 'S5 H6 C7 D8 S9', b: 'S6 H7 C8 D9 S10', expected: true, level: 7 },
  { desc: '顺子中的级牌不提升，5-9 压不过 6-10', a: 'S6 H7 C8 D9 S10', b: 'S5 H6 C7 D8 S9', expected: false, level: 7 },
  { desc: '三连对 QQKKAA > AA2233', a: 'SA HA S2 H2 S3 H3', b: 'SQ HQ SK HK SA HA', expected: true, level: 7 },
  { desc: '钢板 KKKAAA > AAA222', a: 'SA HA CA S2 H2 C2', b: 'SK HK CK SA HA CA', expected: true, level: 7 },
  { desc: '5 张 3 炸弹 > 4 张 A 炸弹', a: 'SA HA CA DA', b: 'S3 H3 C3 D3 S3', expected: true },
  { desc: '6 张炸弹 > 同花顺 10JQKA', a: 'S10 S-J SQ SK SA', b: 'S3 H3 C3 D3 S3 H3', expected: true, aType: 'STRAIGHT_FLUSH', bType: 'BOMB' },
  { desc: '同花顺 > 5 张炸弹', a: 'S9 H9 C9 D9 S9', b: 'S10 S-J SQ SK SA', expected: true, aType: 'BOMB', bType: 'STRAIGHT_FLUSH' },
  { desc: '同花顺 > 4 张炸弹', a: 'SA HA CA DA', b: 'S10 S-J SQ SK SA', expected: true, aType: 'BOMB', bType: 'STRAIGHT_FLUSH' },
  { desc: '四大天王 > 10 张炸弹', a: 'S9 H9 C9 D9 S9 H9 C9 D9 H2 H2', b: 'BJ BJ SJ SJ', expected: true, aType: 'BOMB', bType: 'KING_BOMB' },
  { desc: '同张数级牌炸弹 > A 炸弹', a: 'SA HA CA DA', b: 'S7 H7 C7 D7', expected: true, level: 7, aType: 'BOMB', bType: 'BOMB' },
  { desc: '关闭 levelBombBoost 后 A 炸弹 > 级牌炸弹', a: 'S7 H7 C7 D7', b: 'SA HA CA DA', expected: true, level: 7, aType: 'BOMB', bType: 'BOMB', config: { levelBombBoost: false } },
  { desc: '同花顺同点不比花色，S 同花不能压 H 同花', a: 'H5 H6 H7 H8 H9', b: 'S5 S6 S7 S8 S9', expected: false, aType: 'STRAIGHT_FLUSH', bType: 'STRAIGHT_FLUSH' },
  { desc: '开启 compareStraightFlushSuit 后 S 同花 > H 同花', a: 'H5 H6 H7 H8 H9', b: 'S5 S6 S7 S8 S9', expected: true, aType: 'STRAIGHT_FLUSH', bType: 'STRAIGHT_FLUSH', config: { compareStraightFlushSuit: true } },
  { desc: '顺子不能压对子', a: 'S5 H5', b: 'S3 H4 C5 D6 S7', expected: false, aType: 'PAIR', bType: 'STRAIGHT' },
  { desc: '相同单张不能压', a: 'S5', b: 'H5', expected: false },
  { desc: '4 张炸弹不能压 5 张炸弹', a: 'S9 H9 C9 D9 S9', b: 'SA HA CA DA', expected: false, aType: 'BOMB', bType: 'BOMB' },
  { desc: '普通单张不能压炸弹', a: 'SA HA CA DA', b: 'BJ', expected: false, aType: 'BOMB' },
  { desc: '炸弹可以压三带对', a: 'S9 H9 C9 S8 H8', b: 'SA HA CA DA', expected: true, aType: 'FULL_HOUSE', bType: 'BOMB' },
  { desc: 'A2345 顺子 < 10JQKA 顺子', a: 'S10 HJ CQ DK SA', b: 'SA H2 C3 D4 S5', expected: false },
  { desc: 'A2233 三连对 < QQKKAA 三连对', a: 'SQ HQ SK HK SA HA', b: 'SA HA S2 H2 S3 H3', expected: false, level: 7 },
  { desc: '6 张 3 炸弹 > 5 张 A 炸弹', a: 'SA HA CA DA SA', b: 'S3 H3 C3 D3 S3 H3', expected: true, aType: 'BOMB', bType: 'BOMB' },
  { desc: '官方口径同花顺压不过 6 张炸弹', a: 'S3 H3 C3 D3 S3 H3', b: 'S10 S-J SQ SK SA', expected: false, aType: 'BOMB', bType: 'STRAIGHT_FLUSH' },
  { desc: '变体口径同花顺可压 6 张炸弹', a: 'S3 H3 C3 D3 S3 H3', b: 'S10 S-J SQ SK SA', expected: true, aType: 'BOMB', bType: 'STRAIGHT_FLUSH', config: { bombTierMode: 'flushAboveSixBomb' } },
];

function pattern(spec: string, type: PatternType | undefined, level: Level, config: RuleConfig) {
  return type ? patternByType(spec, type, level, config) : patternOf(spec, undefined, level, config);
}

describe('比较器：beats(b, a)', () => {
  it.each(CASES)('$desc', ({ a, b, expected, level, config, aType, bType }) => {
    const ruleConfig = config ? configWith(config) : CONFIG;
    const levelValue = level ?? 2;
    const patternA = pattern(a, aType, levelValue, ruleConfig);
    const patternB = pattern(b, bType, levelValue, ruleConfig);
    expect(beats(patternB, patternA, ruleConfig)).toBe(expected);
  });
});
