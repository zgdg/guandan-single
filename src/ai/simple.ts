import type { Card, EngineAction, GameState, Pattern, PatternSelector, Seat } from '../core/types';
import type { RuleConfig } from '../core/config';
import { isBombPattern } from '../core/compare';
import { getCurrentSeat, getLegalPlays, getLegalReturnCards, getLegalTributeCards } from '../core/engine';

export interface PolicyOptions {
  /** 跟牌时尝试压过的概率；其余情况直接过牌。 */
  followRate?: number;
}

const DEFAULT_FOLLOW_RATE = 0.35;

/** 从枚举结果还原出「需要声明的牌型」，避免同一组牌的歧义解释被引擎拒绝。 */
export function selectorOf(pattern: Pattern): PatternSelector | undefined {
  switch (pattern.type) {
    case 'PAIR':
    case 'TRIPLE':
    case 'BOMB': {
      const assigned = pattern.wildAssignments[0]?.asRank;
      const natural = pattern.cards.find((card) => card.rank <= 16)?.rank;
      const rank = assigned ?? natural;
      return rank === undefined ? undefined : { type: pattern.type, rank };
    }
    case 'FULL_HOUSE':
      return pattern.tripleRank === null ? undefined : { type: 'FULL_HOUSE', tripleRank: pattern.tripleRank };
    case 'STRAIGHT':
    case 'TUBE':
    case 'PLATE':
      return pattern.sequenceLow === null
        ? undefined
        : { type: pattern.type, sequenceLow: pattern.sequenceLow };
    case 'STRAIGHT_FLUSH':
      return pattern.sequenceLow === null || pattern.suit === null
        ? undefined
        : { type: 'STRAIGHT_FLUSH', sequenceLow: pattern.sequenceLow, suit: pattern.suit };
    default:
      return undefined;
  }
}

function randomCard(hand: Card[], rng: () => number): Card | null {
  if (hand.length === 0) return null;
  return hand[Math.floor(rng() * hand.length)] ?? null;
}

/**
 * P0 自动对局策略：能出则出（带随机的跟牌意愿），否则过牌。
 * 目标不是强度，而是稳定地把每副牌走完并覆盖状态机路径。
 */
export function chooseAction(
  state: GameState,
  config: RuleConfig,
  rng: () => number,
  policy: PolicyOptions = {},
): EngineAction | null {
  if (state.phase === 'GAME_OVER') return null;
  if (state.phase === 'SETTLEMENT') return { type: 'NEXT_DEAL' };

  const seat = getCurrentSeat(state);
  if (!seat) return null;

  if (state.phase === 'TRIBUTE') {
    const tributeCards = getLegalTributeCards(state, seat, config);
    if (tributeCards.length > 0) {
      const card = tributeCards[0]!;
      return { type: 'PAY_TRIBUTE', seat, cardId: card.id };
    }
    const returnCards = getLegalReturnCards(state, seat, config);
    if (returnCards.length > 0) {
      const card = returnCards[0]!;
      return { type: 'RETURN_TRIBUTE', seat, cardId: card.id };
    }
    return null;
  }

  const lastPlay = state.trick.lastPlay;
  if (!lastPlay) {
    // 领出：打一张最小单牌，保证一定有合法动作且快速推进。
    const lowest = state.players[seat].hand[state.players[seat].hand.length - 1];
    return lowest ? { type: 'PLAY', seat, cards: [lowest] } : null;
  }

  const followRate = policy.followRate ?? DEFAULT_FOLLOW_RATE;
  if (rng() >= followRate) return { type: 'PASS', seat };

  const { options } = getLegalPlays(state, config, seat);
  if (options.length === 0) return { type: 'PASS', seat };

  const sorted = [...options].sort((left, right) => {
    const leftBomb = isBombPattern(left.pattern) ? 1 : 0;
    const rightBomb = isBombPattern(right.pattern) ? 1 : 0;
    if (leftBomb !== rightBomb) return leftBomb - rightBomb;
    if (left.pattern.count !== right.pattern.count) return left.pattern.count - right.pattern.count;
    return left.pattern.mainRank - right.pattern.mainRank;
  });
  const choice = sorted[Math.floor(rng() * Math.min(2, sorted.length))] ?? sorted[0]!;
  return {
    type: 'PLAY',
    seat: seat as Seat,
    cards: choice.pattern.cards,
    selector: selectorOf(choice.pattern),
  };
}
