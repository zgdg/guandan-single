import type { Card, GameState, Level, Pattern, PlayOption } from '../core/types';
import type { RuleConfig } from '../core/config';
import { isBombPattern, patternName } from '../core/compare';
import { getLegalPlays } from '../core/engine';
import { groupByRank, isWildcard, partnerSeat, teamOf } from '../core/cards';
import { selectorOf } from '../ai/simple';
import { countBombs } from '../ai/handEval';

export interface SuggestionAlternative {
  option: PlayOption;
  pros: string;
  cons: string;
}

export interface Suggestion {
  action: 'PLAY' | 'PASS';
  cards: Card[];
  option: PlayOption | null;
  title: string;
  reason: string;
  /** 过牌是否合法（领出时不能过）。 */
  canPass: boolean;
  /** 展开后的 2–3 条结构化依据，必须带具体数字或牌张信息。 */
  reasons: string[];
  /** 备选方案（最多 3 条，已排除主推）。 */
  alternatives: SuggestionAlternative[];
  /** 这手最需要承担的风险，一句话。 */
  risk: string;
  /** 0–1 把握度；静态版不提供。 */
  confidence?: number;
  /** 是否走了降级路径（降级时 UI 必须提示）。 */
  degraded?: boolean;
  engine?: 'static' | 'pimc';
  /** 本次建议使用的信念粒子数。 */
  sampleParticles?: number;
  /** 降级原因；仅在 degraded=true 时有值。 */
  degradeReason?: string;
}

/** 这手牌本身的基础代价：不主动动炸弹、尽量多出牌、尽量低牌力。 */
function playCost(option: PlayOption): number {
  return (
    (isBombPattern(option.pattern) ? 1000 : 0) +
    (10 - option.pattern.count) * 12 +
    option.pattern.mainRank
  );
}

/**
 * 结构保全评估：只惩罚「拆到无法复原的结构」，不惩罚正常使用整组牌。
 * 例：4 张 5 只出 2 张 → 拆炸弹；3 张 7 只出 1 张 → 拆三同张；
 * 手里已有 3-4-5-6-7 的自然顺子窗口，却只抽走其中一张 → 破坏顺子窗口。
 * 权重：炸弹 80 / 三同张 24 / 对子 12 / 每个顺子窗口 6。
 */
export function structurePenalty(
  hand: Card[],
  option: PlayOption,
  level: Level,
  config: RuleConfig,
): number {
  // 用定长数组代替 Map：rank 取值 1–16，查表比分组更短也更快。
  const counts = new Uint8Array(18);
  const used = new Uint8Array(18);
  for (const card of hand) {
    if (!isWildcard(card, level, config)) counts[card.rank]! += 1;
  }
  for (const card of option.pattern.cards) {
    if (!isWildcard(card, level, config)) used[card.rank]! += 1;
  }

  let penalty = 0;
  for (let rank = 1; rank <= 16; rank += 1) {
    const total = counts[rank]!;
    const taken = used[rank]!;
    if (taken > 0 && taken < total) {
      penalty += total >= 4 ? 80 : total === 3 ? 24 : total === 2 ? 12 : 0;
    }
  }

  // 顺子窗口只对「不足 5 张」的出牌生效；打完整顺子本身不算拆。
  if (option.pattern.count < 5) {
    for (let low = 1; low <= 10; low += 1) {
      let present = true;
      let broken = false;
      for (let offset = 0; offset < 5 && present; offset += 1) {
        const rank = low + offset === 1 ? 14 : low + offset;
        const total = counts[rank]!;
        if (total === 0) present = false;
        else if (total === used[rank]!) broken = true;
      }
      if (present && broken) penalty += 6;
    }
  }

  return penalty;
}

interface ScoredOption {
  option: PlayOption;
  base: number;
  damage: number;
}

/** 统一排序：调整后代价升序 → 结构代价升序（同分优先不拆）→ 基础代价升序。 */
function scoreOptions(
  options: PlayOption[],
  hand: Card[],
  level: Level,
  config: RuleConfig,
): ScoredOption[] {
  return options
    .map((option) => ({
      option,
      base: playCost(option),
      damage: structurePenalty(hand, option, level, config),
    }))
    .sort((left, right) => {
      // 同牌型同张数时，「不拆结构」优先于牌力高低。
      const shape =
        left.option.pattern.type === right.option.pattern.type &&
        left.option.pattern.count === right.option.pattern.count;
      return (
        (shape ? left.damage - right.damage : 0) ||
        left.base + left.damage - (right.base + right.damage) ||
        left.damage - right.damage ||
        left.base - right.base
      );
    });
}

function describeLead(pattern: Pattern): string {
  if (pattern.count >= 5) return `领出${patternName(pattern)}，一次走 ${pattern.count} 张，减少手数`;
  if (pattern.type === 'SINGLE') return '领出最小单张，先把散牌走掉';
  return `领出${patternName(pattern)}，保持手牌结构`;
}

export function sameCards(left: PlayOption, right: PlayOption): boolean {
  if (left.pattern.cards.length !== right.pattern.cards.length) return false;
  const ids = new Set(left.pattern.cards.map((card) => card.id));
  return right.pattern.cards.every((card) => ids.has(card.id));
}

/** 同一牌型、同一主牌的备选只保留一条，避免列出两张同点牌当「两个方案」。 */
function sameShape(left: PlayOption, right: PlayOption): boolean {
  const a = left.pattern;
  const b = right.pattern;
  return (
    a.type === b.type &&
    a.mainRank === b.mainRank &&
    a.sequenceLow === b.sequenceLow &&
    a.suit === b.suit
  );
}

function prosOf(option: PlayOption): string {
  const pattern = option.pattern;
  if (isBombPattern(pattern)) return '用炸弹强行拿到牌权';
  if (pattern.count >= 5) return `一次走 ${pattern.count} 张，手数减少更多`;
  if (pattern.count === 1) return '代价最小，不拆牌型';
  return `走 ${pattern.count} 张，兼顾出牌量与结构`;
}

export function consOf(option: PlayOption, hand: Card[], level: Level, config: RuleConfig): string {
  if (isBombPattern(option.pattern)) return '消耗炸弹，后续控场变弱';
  const wilds = option.pattern.cards.filter((card) => isWildcard(card, level, config)).length;
  if (wilds > 0) return `用掉 ${wilds} 张逢人配，牌型灵活性下降`;
  const groups = groupByRank(hand.filter((card) => !isWildcard(card, level, config)));
  for (const [rank, cards] of groups) {
    const used = option.pattern.cards.filter(
      (card) => card.rank === rank && !isWildcard(card, level, config),
    ).length;
    if (used > 0 && cards.length - used > 0) {
      if (cards.length >= 4) return '拆掉了四张同点的炸弹胚子';
      if (cards.length >= 3) return '拆掉了三同张';
    }
  }
  if (option.pattern.count === 1) return '只走 1 张，手数没有减少';
  return '牌力偏低，容易被对手反压';
}

function buildAlternatives(
  options: PlayOption[],
  chosen: PlayOption | null,
  hand: Card[],
  level: Level,
  config: RuleConfig,
): SuggestionAlternative[] {
  const pool = options.filter((option) => (chosen ? !sameCards(option, chosen) : true));
  const unique: PlayOption[] = [];
  for (const option of pool) {
    if (!unique.some((item) => sameCards(item, option) || sameShape(item, option))) {
      unique.push(option);
    }
  }
  return scoreOptions(unique, hand, level, config)
    .slice(0, 3)
    .map(({ option }) => ({
      option,
      pros: prosOf(option),
      cons: consOf(option, hand, level, config),
    }));
}

function buildReasons(
  state: GameState,
  seat: 'S',
  suggestion: Pick<Suggestion, 'action' | 'option'>,
  level: Level,
  config: RuleConfig,
): string[] {
  const player = state.players[seat];
  const partner = partnerSeat(seat);
  const partnerCount = state.players[partner].hand.length;
  const lastPlay = state.trick.lastPlay;
  const bombs = countBombs(player.hand, level, config);
  const reasons: string[] = [];

  if (suggestion.action === 'PLAY' && suggestion.option) {
    const count = suggestion.option.pattern.count;
    reasons.push(`这手出 ${count} 张，手牌 ${player.hand.length} → ${player.hand.length - count} 张`);
    reasons.push(
      bombs > 0
        ? `手里还留有 ${bombs} 个炸弹，控场手段没有用光`
        : '手里已经没有炸弹，这手要尽量少丢牌权',
    );
  } else {
    reasons.push(
      lastPlay && lastPlay.seat === partner
        ? `队友剩 ${partnerCount} 张，过牌把领出权留给队友`
        : `对手剩 ${state.players[lastPlay?.seat ?? partner].hand.length} 张，这手先不接`,
    );
    reasons.push(
      bombs > 0 ? `保留 ${bombs} 个炸弹，等关键回合再用` : '手里已无炸弹，先攒住手数',
    );
    reasons.push('过牌后本圈不能再出，要等下一圈领出');
  }

  if (lastPlay && lastPlay.seat !== partner) {
    const opponentCount = state.players[lastPlay.seat].hand.length;
    reasons.push(
      `出牌的是${teamOf(lastPlay.seat) === 'WE' ? '对手' : '对方'}，手上还剩 ${opponentCount} 张`,
    );
  } else if (!lastPlay) {
    reasons.push(`本圈由你领出，队友剩 ${partnerCount} 张，先走自己的散牌`);
  } else {
    reasons.push(`队友剩 ${partnerCount} 张，本圈让他继续控场`);
  }

  return reasons.slice(0, 3);
}

function buildRisk(
  state: GameState,
  suggestion: Pick<Suggestion, 'action' | 'option'>,
): string {
  if (suggestion.action === 'PASS') return '若队友也接不住，本圈会被对手拿下';
  const pattern = suggestion.option?.pattern;
  if (!pattern) return '';
  if (isBombPattern(pattern)) return '用掉一个炸弹，后续控场能力下降';
  if (state.trick.lastPlay) return '若对手还有更大的同类牌型或炸弹，这手会被反压';
  return '领出后被压，本圈牌权会转移，需要队友接应';
}

/**
 * 按指定动作生成完整建议结构（理由/备选/风险）。
 * PIMC 选定动作后复用同一套解释模板，保证「采样版」与「静态版」文案口径一致。
 */
export function buildSuggestion(
  state: GameState,
  config: RuleConfig,
  seat: 'S',
  action: 'PLAY' | 'PASS',
  option: PlayOption | null,
  title: string,
  reason: string,
  optionsOverride?: PlayOption[],
): Suggestion {
  const level = state.levels[state.currentLevelTeam];
  const hand = state.players[seat].hand;
  const options =
    optionsOverride ?? getLegalPlays(state, config, seat).options;
  const base = { action, option, title, reason };
  return {
    action,
    cards: option ? option.pattern.cards : [],
    option,
    title,
    reason,
    canPass: state.trick.lastPlay !== null,
    reasons: buildReasons(state, seat, base, level, config),
    alternatives: buildAlternatives(options, option, hand, level, config),
    risk: buildRisk(state, base),
  };
}

/**
 * P1/P2 静态建议：只看自己手牌与公开信息，先保证 100% 合法。
 * 领出优先「多出牌、低牌力、不拆炸弹」；跟牌优先「最小代价压住、不浪费炸弹」。
 */
export function suggestForHuman(state: GameState, config: RuleConfig, seat: 'S' = 'S'): Suggestion {
  const lastPlay = state.trick.lastPlay;
  const hand = state.players[seat].hand;
  const level = state.levels[state.currentLevelTeam];
  const pass = (reason: string): Suggestion =>
    buildSuggestion(state, config, seat, 'PASS', null, '建议过牌', reason);

  const { options } = getLegalPlays(state, config, seat);

  if (!lastPlay) {
    if (options.length === 0) {
      return pass('没有可领出的牌');
    }
    const picked = scoreOptions(options, hand, level, config)[0]!.option;
    return buildSuggestion(
      state,
      config,
      seat,
      'PLAY',
      picked,
      `建议出${patternName(picked.pattern)}`,
      describeLead(picked.pattern),
      options,
    );
  }

  // 上家是队友：默认让队友继续领牌，不抢队友的出牌权。
  if (lastPlay.seat === partnerSeat(seat)) {
    return pass('上家是队友，过牌让他继续领出');
  }

  const nonBombs = options.filter((option) => !isBombPattern(option.pattern));
  if (nonBombs.length > 0) {
    const scored = scoreOptions(nonBombs, hand, level, config).sort((left, right) => {
      if (left.damage !== right.damage) return left.damage - right.damage;
      if (left.option.pattern.mainRank !== right.option.pattern.mainRank) {
        return left.option.pattern.mainRank - right.option.pattern.mainRank;
      }
      return left.base - right.base;
    });
    const picked = scored[0]!.option;
    const beatingTeam = teamOf(lastPlay.seat);
    const teamText = beatingTeam === 'WE' ? '对手' : '对方';
    return buildSuggestion(
      state,
      config,
      seat,
      'PLAY',
      picked,
      `建议用${patternName(picked.pattern)}压住`,
      `用最小代价压住${teamText}的牌，炸弹先留着`,
      options,
    );
  }

  // 只有炸弹能压：对手快出完时才建议拦截，否则保留炸弹。
  const opponentCount = state.players[lastPlay.seat].hand.length;
  if (options.length > 0 && opponentCount <= config.reportThreshold) {
    const picked = scoreOptions(options, hand, level, config)[0]!.option;
    return buildSuggestion(
      state,
      config,
      seat,
      'PLAY',
      picked,
      `建议用${patternName(picked.pattern)}拦截`,
      `对手只剩 ${opponentCount} 张，必须拦住这一手`,
      options,
    );
  }

  return pass('只有炸弹能压，先留住炸弹等关键回合');
}

/** 把建议转成引擎可执行的动作参数（多解释牌型显式声明）。 */
export function selectorForSuggestion(suggestion: Suggestion) {
  return suggestion.option ? selectorOf(suggestion.option.pattern) : undefined;
}
