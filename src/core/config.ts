/**
 * 规则配置：所有地方差异与「待确认」项集中在这里，禁止散落到规则逻辑。
 * 默认值严格按 docs/掼蛋规则汇总.md 的默认竞赛口径，并与规划 7.1 的 D01–D16 对应。
 */

export type PlayDirection = 'counterclockwise' | 'clockwise';
export type DoubleTributeTieRule = 'headNextToHead' | 'firstInOrder';
export type FirstDealLeaderRule = 'random' | 'seatS';

export interface RuleConfig {
  /** D05：炸弹层级。official = 6+炸 > 同花顺 > 5炸 > 4炸；flushAboveSixBomb = 同花顺 > 6+炸。 */
  bombTierMode: 'official' | 'flushAboveSixBomb';
  /** D06：同花顺比大小是否比花色。默认只看最高牌点。 */
  compareStraightFlushSuit: boolean;
  /** D07：逢人配能否补同花顺。 */
  wildcardCanFillStraightFlush: boolean;
  /** D08：两张逢人配能否单独成对。 */
  wildcardPairAlone: boolean;
  /** D09：三带对能否「三带两单」。默认只能三同张 + 一对。 */
  allowTripleWithTwoSingles: boolean;
  /** D10：是否允许加长牌型（6+ 顺子、4+ 连对、3+ 钢板、三带三）。P0 未实现，开启会显式报错。 */
  allowExtendedPatterns: boolean;
  /** D13：级牌炸弹是否提升到 A 之上。 */
  levelBombBoost: boolean;
  /** D04：还贡能否还级牌/红桃级牌。 */
  returnLevelCard: boolean;
  /** D01：打 A 累计 3 次失败是否退回 2。false=官方默认继续打 A。 */
  aFailResetAfter3: boolean;
  /** D02：双贡贡牌同点时的归属。 */
  doubleTributeTieRule: DoubleTributeTieRule;
  /** D03：双贡抗贡是否必须同一人持两张大王。false=两人合计即可。 */
  antiTributeDoubleMustSamePerson: boolean;
  /** D14：是否保留内贡（头游与末游同队仍进贡）。 */
  innerTribute: boolean;
  /** D12：出牌方向。 */
  playDirection: PlayDirection;
  /** D11：报牌阈值；核心引擎只提供 needsReport 判定，展示层决定是否强制。 */
  reportThreshold: number;
  /** D15：首副牌先出者。random 用种子随机等效切牌抽签。 */
  firstDealLeader: FirstDealLeaderRule;
  /** D16：双下是否提前结束（头游+二游同队，二游出完即结束）。 */
  doubleDownEarlyEnd: boolean;
  /** 炸弹最大张数（含逢人配），官方默认 10。 */
  maxBombCards: number;
  /** 单次合法枚举上限，超出则截断并标记。 */
  maxCandidates: number;
  /** 是否启用逢人配（红桃级牌）。关闭用于对比测试。 */
  wildcardEnabled: boolean;
}

export const DEFAULT_RULE_CONFIG: Readonly<RuleConfig> = Object.freeze({
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

export function mergeRuleConfig(partial: Partial<RuleConfig> = {}): RuleConfig {
  return { ...DEFAULT_RULE_CONFIG, ...partial };
}

/** 在入口处显式拒绝 P0 尚未实现的变体，避免「配置打开了但行为没变」。 */
export function assertSupportedConfig(config: RuleConfig): void {
  if (config.allowExtendedPatterns) {
    throw new Error('E_UNSUPPORTED_CONFIG: allowExtendedPatterns=true 在 P0 尚未实现');
  }
  if (config.maxBombCards < 4 || config.maxBombCards > 10) {
    throw new Error('E_UNSUPPORTED_CONFIG: maxBombCards 必须在 4–10');
  }
}

/** 规则版本：判定口径变化升主版本，仅展示/排序变化升次版本（规划 8.4）。 */
export const RULE_VERSION = '0.1.0';
