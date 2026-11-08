import { describe, expect, it } from 'vitest';
import { configWith, patternByType, patternOf, patternsOf, typesOf } from '../helpers/cards';

describe('逢人配（红桃级牌）', () => {
  it('逢人配可以补成对子', () => {
    const pair = patternByType('S7 H7', 'PAIR', 7);
    expect(pair.count).toBe(2);
    expect(pair.mainRank).toBe(98);
  });

  it('两张逢人配可以单独成对（默认允许）', () => {
    const pair = patternOf('H7 H7', { type: 'PAIR', rank: 7 }, 7);
    expect(pair.mainRank).toBe(98);
  });

  it('关闭 wildcardPairAlone 后两张逢人配不能单独成对', () => {
    const config = configWith({ wildcardPairAlone: false });
    expect(typesOf('H7 H7', 7, config)).not.toContain('PAIR');
  });

  it('逢人配不能替代大小王组成对子', () => {
    expect(typesOf('SJ H7', 7)).not.toContain('PAIR');
  });

  it('逢人配不能替代大小王组成四大天王', () => {
    expect(typesOf('BJ BJ SJ H2', 2)).not.toContain('KING_BOMB');
  });

  it('逢人配可以补炸弹', () => {
    const bomb = patternByType('S9 H9 C9 H7', 'BOMB', 7);
    expect(bomb.count).toBe(4);
  });

  it('逢人配可以补到 10 张炸弹', () => {
    const bomb = patternByType('S9 H9 C9 D9 S9 H9 C9 D9 H2 H2', 'BOMB', 2);
    expect(bomb.count).toBe(10);
  });

  it('关闭 wildcardEnabled 后红桃级牌按普通级牌处理', () => {
    const config = configWith({ wildcardEnabled: false });
    expect(typesOf('S9 H9 C9 H7', 7, config)).not.toContain('BOMB');
  });

  it('逢人配可以补顺子', () => {
    const straight = patternByType('S5 H6 S8 D9 H7', 'STRAIGHT', 7);
    expect(straight.sequenceLow).toBe(5);
    expect(straight.wildAssignments[0]?.asRank).toBe(7);
  });

  it('顺子中的逢人配按被替代牌的自然牌点计算，不按级牌牌力', () => {
    const straight = patternByType('S5 H6 S8 D9 H7', 'STRAIGHT', 7);
    expect(straight.mainRank).toBe(9);
    expect(straight.mainRank).not.toBe(98);
  });

  it('A 可作 1，逢人配补 5 组成 A2345', () => {
    const straight = patternByType('SA H2 C3 D4 H7', 'STRAIGHT', 7);
    expect(straight.sequenceLow).toBe(1);
    expect(straight.mainRank).toBe(5);
  });

  it('两张逢人配可能产生多个顺子窗口，需声明', () => {
    const straights = patternsOf('S3 H4 C5 H7 H7', 7).filter((item) => item.type === 'STRAIGHT');
    expect(straights.length).toBeGreaterThanOrEqual(2);
    expect(new Set(straights.map((item) => item.sequenceLow)).size).toBeGreaterThanOrEqual(2);
  });

  it('逢人配可以补同花顺（默认允许）', () => {
    const flush = patternByType('S5 S6 S8 S9 H7', 'STRAIGHT_FLUSH', 7);
    expect(flush.suit).toBe('S');
    expect(flush.wildAssignments[0]?.asSuit).toBe('S');
  });

  it('关闭 wildcardCanFillStraightFlush 后逢人配不能补同花顺，但仍是普通顺子', () => {
    const config = configWith({ wildcardCanFillStraightFlush: false });
    expect(typesOf('S5 S6 S8 S9 H7', 7, config)).not.toContain('STRAIGHT_FLUSH');
    expect(typesOf('S5 S6 S8 S9 H7', 7, config)).toContain('STRAIGHT');
  });

  it('逢人配可以补三连对', () => {
    expect(patternByType('S3 H3 S4 S5 H5 H7', 'TUBE', 7).sequenceLow).toBe(3);
  });

  it('逢人配可以补钢板', () => {
    expect(patternByType('S3 H3 C3 S4 H4 H7', 'PLATE', 7).sequenceLow).toBe(3);
  });

  it('逢人配可以补三带对的三同张', () => {
    const pattern = patternOf('S3 H3 H7 S4 H4', { type: 'FULL_HOUSE', tripleRank: 3 }, 7);
    expect(pattern.tripleRank).toBe(3);
  });

  it('逢人配可以补三带对的对子', () => {
    const pattern = patternByType('S3 H3 C3 S4 H7', 'FULL_HOUSE', 7);
    expect(pattern.tripleRank).toBe(3);
    expect(pattern.pairRank).toBe(4);
  });
});
