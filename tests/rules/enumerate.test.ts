import { describe, expect, it } from 'vitest';
import { beats } from '../../src/core/compare';
import { enumerateLegalPlays } from '../../src/core/enumerate';
import { CONFIG, cards, configWith, patternByType } from '../helpers/cards';

function hand(spec: string) {
  return cards(spec);
}

describe('合法出牌枚举', () => {
  it('领出时枚举出单张、对子、三同张与炸弹', () => {
    const result = enumerateLegalPlays(hand('S3 H3 S5 S5 C5 S9 H9 C9 D9'), 2, CONFIG, null);
    const types = result.options.map((option) => option.pattern.type);
    expect(types).toContain('SINGLE');
    expect(types).toContain('PAIR');
    expect(types).toContain('TRIPLE');
    expect(types).toContain('BOMB');
    expect(result.truncated).toBe(false);
  });

  it('领出时枚举出顺子', () => {
    const result = enumerateLegalPlays(hand('S3 H4 C5 D6 S7 S9'), 2, CONFIG, null);
    expect(result.options.some((option) => option.pattern.type === 'STRAIGHT')).toBe(true);
  });

  it('跟对子时只给对子与炸弹类，且全部能压过', () => {
    const last = patternByType('SA HA', 'PAIR');
    const result = enumerateLegalPlays(
      hand('S3 C3 S4 H4 S5 C5 S9 H9 C9 D9 BJ BJ'),
      2,
      CONFIG,
      last,
    );
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(beats(option.pattern, last, CONFIG)).toBe(true);
      expect(['PAIR', 'BOMB', 'STRAIGHT_FLUSH', 'KING_BOMB']).toContain(option.pattern.type);
    }
  });

  it('没有能压过的牌时返回空集', () => {
    const last = patternByType('SA HA', 'PAIR');
    const result = enumerateLegalPlays(hand('S3 S4 S5 S6'), 2, CONFIG, last);
    expect(result.options).toHaveLength(0);
  });

  it('炸弹会作为跨牌型选项出现', () => {
    const last = patternByType('SA', 'SINGLE');
    const result = enumerateLegalPlays(hand('S3 H9 H9 C9 D9'), 2, CONFIG, last);
    expect(result.options.some((option) => option.pattern.type === 'BOMB')).toBe(true);
  });

  it('逢人配补成的对子能压过对 A', () => {
    const last = patternByType('SA HA', 'PAIR');
    const result = enumerateLegalPlays(hand('S7 H7 S3'), 7, CONFIG, last);
    const pairs = result.options.filter((option) => option.pattern.type === 'PAIR');
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((option) => beats(option.pattern, last, CONFIG))).toBe(true);
  });

  it('关闭 wildcardPairAlone 后不会枚举出两张逢人配的对子', () => {
    const config = configWith({ wildcardPairAlone: false });
    const last = patternByType('SA HA', 'PAIR');
    const result = enumerateLegalPlays(hand('H7 H7 S3'), 7, config, last);
    expect(result.options).toHaveLength(0);
  });

  it('能枚举出 10 张炸弹', () => {
    const result = enumerateLegalPlays(
      hand('S9 H9 C9 D9 S9 H9 C9 D9 H2 H2'),
      2,
      CONFIG,
      null,
    );
    expect(result.options.some((option) => option.pattern.type === 'BOMB' && option.pattern.count === 10)).toBe(true);
  });

  it('所有枚举选项的牌都来自手牌且不重复', () => {
    const source = hand('S3 H3 C3 S4 H4 C4 S5 H5 C5 D5 S7 H7');
    const handIds = new Set(source.map((card) => card.id));
    const result = enumerateLegalPlays(source, 2, CONFIG, null);
    for (const option of result.options) {
      const ids = option.pattern.cards.map((card) => card.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => handIds.has(id))).toBe(true);
    }
  });

  it('跟同花顺时只给更大的炸弹类', () => {
    const last = patternByType('S5 S6 S7 S8 S9', 'STRAIGHT_FLUSH');
    const result = enumerateLegalPlays(
      hand('S10 S-J SQ SK SA S3 H3 C3 D3 S3'),
      2,
      CONFIG,
      last,
    );
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(beats(option.pattern, last, CONFIG)).toBe(true);
    }
  });

  it('四大天王没有可压选项', () => {
    const last = patternByType('BJ BJ SJ SJ', 'KING_BOMB');
    const result = enumerateLegalPlays(hand('S9 H9 C9 D9 S9 H9'), 2, CONFIG, last);
    expect(result.options).toHaveLength(0);
  });

  it('跟顺子时不会混入对子或三同张', () => {
    const last = patternByType('S3 H4 C5 D6 S7', 'STRAIGHT');
    const result = enumerateLegalPlays(hand('S4 C4 S5 H5 S6 C6 S8 H9 C10 DJ S3 H3 C3 D3 S3'), 2, CONFIG, last);
    for (const option of result.options) {
      expect(['STRAIGHT', 'STRAIGHT_FLUSH', 'BOMB', 'KING_BOMB']).toContain(option.pattern.type);
    }
  });

  it('跟三带对时只给更大的三带对与炸弹类', () => {
    const last = patternByType('S8 H8 C8 S3 H3', 'FULL_HOUSE');
    const result = enumerateLegalPlays(hand('S9 H9 C9 S4 H4 S5 C5 S6 H6 S7 C7'), 2, CONFIG, last);
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(['FULL_HOUSE', 'BOMB', 'STRAIGHT_FLUSH', 'KING_BOMB']).toContain(option.pattern.type);
      expect(beats(option.pattern, last, CONFIG)).toBe(true);
    }
  });
});
