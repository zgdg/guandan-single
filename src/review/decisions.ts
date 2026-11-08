import type { Card, GameState, Level, Seat } from '../core/types';
import type { RuleConfig } from '../core/config';
import type { Suggestion } from '../suggest/static';
import { isBombPattern, patternName } from '../core/compare';
import { teamOf } from '../core/cards';
import { recognize } from '../core/patterns';

export type DecisionVerdict = 'match' | 'better' | 'mistake' | 'style';

export interface DecisionSnapshot {
  handCounts: Record<Seat, number>;
  lastPlay: { seat: Seat; name: string; count: number } | null;
  level: Level;
}

export interface DecisionRecord {
  id: string;
  dealNo: number;
  /** 本副内的第几次人类决策（从 1 开始）。 */
  turn: number;
  actual: 'PLAY' | 'PASS';
  actualCards: Card[];
  suggestedAction: 'PLAY' | 'PASS';
  suggestedCards: Card[];
  suggestedTitle: string;
  verdict: DecisionVerdict;
  /** 一句话说明「差异在哪、代价是什么」，与建议一致时为空。 */
  note: string;
  snapshot: DecisionSnapshot;
}

function sameSet(left: Card[], right: Card[]): boolean {
  if (left.length !== right.length) return false;
  const ids = new Set(left.map((card) => card.id));
  return right.every((card) => ids.has(card.id));
}

function snapshotOf(state: GameState): DecisionSnapshot {
  const counts = {} as Record<Seat, number>;
  for (const seat of ['S', 'E', 'N', 'W'] as Seat[]) {
    counts[seat] = state.players[seat].hand.length;
  }
  const last = state.trick.lastPlay;
  return {
    handCounts: counts,
    lastPlay: last
      ? { seat: last.seat, name: patternName(last.pattern), count: last.pattern.count }
      : null,
    level: state.levels[state.currentLevelTeam],
  };
}

function classify(
  state: GameState,
  config: RuleConfig,
  suggestion: Suggestion,
  actual: 'PLAY' | 'PASS',
  actualCards: Card[],
): { verdict: DecisionVerdict; note: string } {
  const agreed =
    actual === suggestion.action &&
    (actual === 'PASS' || sameSet(actualCards, suggestion.cards));
  if (agreed) return { verdict: 'match', note: '' };

  const actualBomb =
    actual === 'PLAY' &&
    actualCards.length > 0 &&
    recognize(actualCards, state.levels[state.currentLevelTeam], config).some((pattern) =>
      isBombPattern(pattern),
    );
  const suggestedNonBomb = suggestion.option ? !isBombPattern(suggestion.option.pattern) : true;
  const suggestedName = suggestion.option ? patternName(suggestion.option.pattern) : '';

  if (actual === 'PASS' && suggestion.action === 'PLAY' && suggestion.option) {
    const target = state.trick.lastPlay?.seat ?? null;
    const remaining = target ? state.players[target].hand.length : 0;
    const isOpponent = target ? teamOf(target) !== teamOf('S') : false;
    if (isOpponent && remaining > 0 && remaining <= config.reportThreshold) {
      return {
        verdict: 'mistake',
        note: `对手只剩 ${remaining} 张，这一手本可以用${suggestedName}拦住`,
      };
    }
    return {
      verdict: 'better',
      note: `本可以用${suggestedName}压住这一手，过牌后本圈不能再出`,
    };
  }

  if (actual === 'PLAY' && suggestion.action === 'PASS') {
    if (actualBomb) {
      return { verdict: 'better', note: '队友领出时又用炸弹抢牌权，消耗偏大' };
    }
    return { verdict: 'style', note: '抢了队友的领出权，属于风格选择，不算失误' };
  }

  if (actual === 'PLAY' && suggestion.action === 'PLAY') {
    if (actualBomb && suggestedNonBomb) {
      return {
        verdict: 'better',
        note: `本可以用${suggestedName}压住，这一手额外消耗了一个炸弹`,
      };
    }
    return {
      verdict: 'better',
      note: `建议用${suggestedName}，当前这手牌力更高/出牌更多，代价更大`,
    };
  }

  return { verdict: 'match', note: '' };
}

export function buildDecision(
  state: GameState,
  config: RuleConfig,
  suggestion: Suggestion,
  actual: 'PLAY' | 'PASS',
  actualCards: Card[],
  turn: number,
): DecisionRecord {
  const { verdict, note } = classify(state, config, suggestion, actual, actualCards);
  return {
    id: `${state.dealNo}-${turn}`,
    dealNo: state.dealNo,
    turn,
    actual,
    actualCards,
    suggestedAction: suggestion.action,
    suggestedCards: suggestion.cards,
    suggestedTitle: suggestion.title,
    verdict,
    note,
    snapshot: snapshotOf(state),
  };
}

export const VERDICT_LABEL: Record<DecisionVerdict, string> = {
  mistake: '明显失误',
  better: '可选更优',
  style: '风格差异',
  match: '与建议一致',
};
