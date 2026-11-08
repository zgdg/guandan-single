import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_CONFIG,
  assertSupportedConfig,
  mergeRuleConfig,
} from '../../src/core/config';
import { nextSeat, playOrder } from '../../src/core/cards';
import { createGame } from '../../src/core/engine';
import { CONFIG, configWith, typesOf } from '../helpers/cards';

describe('规则配置集中管理', () => {
  it('默认值与规划 7.1 的官方口径一致', () => {
    expect(mergeRuleConfig()).toEqual({
      bombTierMode: 'official',
      compareStraightFlushSuit: false,
      wildcardCanFillStraightFlush: true,
      wildcardPairAlone: true,
      allowTripleWithTwoSingles: false,
      allowExtendedPatterns: false,
      levelBombBoost: true,
      returnLevelCard: false,
      aFailResetAfter3: false,
      doubleTributeTieRule: 'headNextToHead',
      antiTributeDoubleMustSamePerson: false,
      innerTribute: true,
      playDirection: 'counterclockwise',
      reportThreshold: 10,
      firstDealLeader: 'random',
      doubleDownEarlyEnd: true,
      maxBombCards: 10,
      maxCandidates: 3000,
      wildcardEnabled: true,
    });
    expect(DEFAULT_RULE_CONFIG).toEqual(mergeRuleConfig());
  });

  it('D09 开启三带两单后，三同张 + 两张不同单牌可识别为三带对', () => {
    expect(
      typesOf('S3 H3 C3 S4 D5', 2, configWith({ allowTripleWithTwoSingles: true })),
    ).toContain('FULL_HOUSE');
    expect(typesOf('S3 H3 C3 S4 D5', 2, CONFIG)).not.toContain('FULL_HOUSE');
  });

  it('D10 开启加长牌型时在入口显式报错，避免配置打开但行为没变', () => {
    expect(() => assertSupportedConfig(mergeRuleConfig({ allowExtendedPatterns: true }))).toThrow(
      /E_UNSUPPORTED_CONFIG/,
    );
    expect(() => createGame(1, configWith({ allowExtendedPatterns: true }), { recordEvents: false })).toThrow(
      /E_UNSUPPORTED_CONFIG/,
    );
  });

  it('炸弹张数超出 4–10 时显式报错', () => {
    expect(() => assertSupportedConfig(mergeRuleConfig({ maxBombCards: 11 }))).toThrow(
      /E_UNSUPPORTED_CONFIG/,
    );
  });

  it('D12 顺时针方向改变下家与出牌顺序', () => {
    const config = configWith({ playDirection: 'clockwise' });
    expect(playOrder(config)).toEqual(['S', 'W', 'N', 'E']);
    expect(nextSeat('S', config)).toBe('W');
    expect(nextSeat('S', CONFIG)).toBe('E');
  });

  it('D15 首副先出者可按配置固定为 S', () => {
    const state = createGame(3, configWith({ firstDealLeader: 'seatS' }), { recordEvents: false });
    expect(state.trick.leader).toBe('S');
  });
});
