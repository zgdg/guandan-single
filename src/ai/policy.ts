import type { EngineAction, GameState, Level, PlayOption, Seat } from '../core/types';
import type { RuleConfig } from '../core/config';
import {
  getCurrentSeat,
  getLegalPlays,
  getLegalReturnCards,
  getLegalTributeCards,
} from '../core/engine';
import { isBombPattern } from '../core/compare';
import { isWildcard, partnerSeat, teamOf } from '../core/cards';
import { chooseAction, selectorOf } from './simple';
import { breaksBomb, turnsAfterPlay } from './handEval';
import { DIFFICULTY, personaOf, type AiDifficulty, type PersonaParams } from './persona';
import { searchSeatAction } from '../suggest/pimc';

export interface AiPolicyOptions {
  difficulty?: AiDifficulty;
  /** 覆盖默认人格参数（主要用于测试与离线对局）。 */
  persona?: PersonaParams;
}

/** L3 单步搜索规模：只复核「过牌」决策，成本远低于全量搜索。 */
const L3_SEARCH = {
  particles: 4,
  candidates: 3,
  horizon: 8,
};

function play(option: PlayOption, seat: Seat): EngineAction {
  const selector = selectorOf(option.pattern);
  return {
    type: 'PLAY',
    seat,
    cards: option.cards,
    ...(selector ? { selector } : {}),
  };
}

function tributeAction(state: GameState, config: RuleConfig, seat: Seat): EngineAction | null {
  const tributeCards = getLegalTributeCards(state, seat, config);
  if (tributeCards.length > 0) {
    return { type: 'PAY_TRIBUTE', seat, cardId: tributeCards[0]!.id };
  }
  const returnCards = getLegalReturnCards(state, seat, config);
  if (returnCards.length > 0) {
    const smallest = [...returnCards].sort((left, right) => left.rank - right.rank)[0]!;
    return { type: 'RETURN_TRIBUTE', seat, cardId: smallest.id };
  }
  return null;
}

/** 领出评估：优先减少预计手数，同时避免拆炸弹/浪费逢人配。 */
function leadScore(
  hand: GameState['players'][Seat]['hand'],
  option: PlayOption,
  level: Level,
  config: RuleConfig,
): number {
  const turns = turnsAfterPlay(hand, option, level, config);
  let score = 1 - turns * 3;
  score += option.pattern.count * 0.35;
  if (option.pattern.count === 1) score -= 0.4;
  if (isBombPattern(option.pattern)) score -= 8;
  else if (breaksBomb(hand, option, level, config)) score -= 2;
  const wilds = option.cards.filter((card) => isWildcard(card, level, config)).length;
  score -= wilds * 0.9;
  // 领出高牌容易浪费控场手段，低牌优先。
  score -= Math.max(0, option.pattern.mainRank - 10) * 0.18;
  if (hand.length - option.pattern.count === 0) score += 6;
  return score;
}

/** 跟牌评估：用最小代价压住，手数减少作为次要收益。 */
function followScore(
  hand: GameState['players'][Seat]['hand'],
  option: PlayOption,
  level: Level,
  config: RuleConfig,
): number {
  const turns = turnsAfterPlay(hand, option, level, config);
  let score = -turns * 2 - option.pattern.mainRank * 0.3;
  score -= option.cards.filter((card) => isWildcard(card, level, config)).length * 0.9;
  if (isBombPattern(option.pattern)) score -= 6;
  else if (breaksBomb(hand, option, level, config)) score -= 1.6;
  if (hand.length - option.pattern.count === 0) score += 10;
  return score;
}

/** 炸弹时机：只有「能一手走完」「对手快出完」「抢回控场」才动炸弹。 */
function bombAllowed(
  state: GameState,
  seat: Seat,
  option: PlayOption,
  persona: PersonaParams,
): boolean {
  if (!isBombPattern(option.pattern)) return true;
  const handCount = state.players[seat].hand.length;
  if (handCount - option.pattern.count === 0) return true;
  const last = state.trick.lastPlay;
  if (!last) return false;
  const opponentLed = teamOf(last.seat) !== teamOf(seat);
  if (!opponentLed) return false;
  return state.players[last.seat].hand.length <= persona.bombThreshold;
}

/** 在按分数排好的候选里按噪声取次优（L2 的 5% 失误率）。 */
function pickWithNoise(options: PlayOption[], noise: number, rng: () => number): PlayOption | null {
  if (options.length === 0) return null;
  if (options.length > 1 && rng() < noise) return options[1]!;
  return options[0]!;
}

function decideLead(
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  legal: PlayOption[],
  difficulty: AiDifficulty,
  rng: () => number,
): EngineAction | null {
  const hand = state.players[seat].hand;
  const level = state.levels[state.currentLevelTeam];
  const finisher = legal.find((option) => hand.length - option.pattern.count === 0);
  if (finisher) return play(finisher, seat);

  // 领出不动炸弹：只保留常规牌型的候选；若手上只剩炸弹，则退回全部合法牌。
  const regular = legal.filter((option) => !isBombPattern(option.pattern));
  const pool = regular.length > 0 ? regular : legal;
  const scored = [...pool]
    .sort(
      (left, right) =>
        leadScore(hand, right, level, config) - leadScore(hand, left, level, config),
    )
    .map((option) => option);
  const chosen = pickWithNoise(scored, DIFFICULTY[difficulty].noise, rng);
  return chosen ? play(chosen, seat) : null;
}

function decideFollow(
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  legal: PlayOption[],
  persona: PersonaParams,
  difficulty: AiDifficulty,
  rng: () => number,
): EngineAction | null {
  const hand = state.players[seat].hand;
  const level = state.levels[state.currentLevelTeam];
  const last = state.trick.lastPlay!;
  const partner = partnerSeat(seat);
  const partnerLed = last.seat === partner;
  const partnerOut = state.players[partner].outOrder !== null;
  const handCount = hand.length;

  // 能一手走完，永远优先。
  const finisher = legal.find((option) => handCount - option.pattern.count === 0);
  if (finisher) return play(finisher, seat);

  // 队友领出：让队友继续控场；只有激进人格在无风险时才会抢。
  if (partnerLed) {
    const mayCompete = !partnerOut && rng() >= persona.partnerSupport && persona.aggression >= 0.7;
    if (!mayCompete) return { type: 'PASS', seat };
  }

  const allowed = legal.filter((option) => bombAllowed(state, seat, option, persona));
  if (allowed.length === 0) return { type: 'PASS', seat };

  const nonBombs = allowed.filter((option) => !isBombPattern(option.pattern));
  const bombs = allowed.filter((option) => isBombPattern(option.pattern));
  const opponentCount = teamOf(last.seat) !== teamOf(seat) ? state.players[last.seat].hand.length : handCount;
  const mustBlock = !partnerLed && opponentCount <= (difficulty === 'L3' ? 4 : 3);

  // 只剩炸弹：除非必须拦截，否则保留。
  if (nonBombs.length === 0) {
    if (!mustBlock && rng() < 0.75) return { type: 'PASS', seat };
    const chosen = pickWithNoise([...bombs], difficulty === 'L2' ? 0.05 : 0, rng);
    return chosen ? play(chosen, seat) : { type: 'PASS', seat };
  }

  const scored = [...nonBombs]
    .sort(
      (left, right) =>
        followScore(hand, right, level, config) - followScore(hand, left, level, config),
    )
    .map((option) => option);
  const best = scored[0]!;
  const expensive =
    best.pattern.mainRank >= level ||
    breaksBomb(hand, best, level, config) ||
    best.cards.some((card) => isWildcard(card, level, config));

  if (!mustBlock && !partnerLed) {
    // 人格 + 难度共同决定过牌容忍度；越贵的牌越倾向保留。
    const tolerance = Math.min(1, persona.passTolerance + DIFFICULTY[difficulty].passTolerance);
    const passChance = tolerance * (expensive ? 1 : 0.45);
    if (rng() < passChance) return { type: 'PASS', seat };
  }

  const chosen = pickWithNoise(scored, DIFFICULTY[difficulty].noise, rng);
  return chosen ? play(chosen, seat) : { type: 'PASS', seat };
}

/**
 * 对局 AI 的统一下单入口（L1–L3 + 人格）。
 * 只读取自己的手牌与公开信息：其他座位只使用剩余张数与出牌记录。
 * 返回的动作始终来自合法枚举；任何搜索失败都回退启发式。
 */
export function chooseAiAction(
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  rng: () => number,
  options: AiPolicyOptions = {},
): EngineAction | null {
  if (state.phase === 'GAME_OVER') return null;
  if (state.phase === 'SETTLEMENT') return { type: 'NEXT_DEAL' };

  const current = getCurrentSeat(state);
  if (!current || current !== seat) return null;

  if (state.phase === 'TRIBUTE') return tributeAction(state, config, seat);

  const difficulty = options.difficulty ?? 'L2';
  const persona = options.persona ?? personaOf(seat);

  // L1：保留 P0 的贪心策略，人格只影响跟牌意愿。
  if (difficulty === 'L1') {
    return chooseAction(state, config, rng, {
      followRate: Math.min(0.9, Math.max(0.2, 0.35 + persona.aggression * 0.5)),
    });
  }

  // L3 更果断：炸弹时机更宽、更信任队友的牌权。
  const effectivePersona =
    difficulty === 'L3'
      ? {
          ...persona,
          bombThreshold: persona.bombThreshold + 3,
          partnerSupport: Math.min(1, persona.partnerSupport + 0.15),
        }
      : persona;

  const last = state.trick.lastPlay;
  const { options: legal } = getLegalPlays(state, config, seat);
  if (legal.length === 0) {
    return last ? { type: 'PASS', seat } : null;
  }

  const heuristic = last
    ? decideFollow(state, config, seat, legal, effectivePersona, difficulty, rng)
    : decideLead(state, config, seat, legal, difficulty, rng);

  // L3：启发式给出 PLAY 时直接执行；只在启发式想「过牌」时用采样搜索复核，
  // 避免采样偏保守把该压的牌放走，也不让搜索噪声推翻明确的进攻决策。
  if (difficulty === 'L3' && heuristic?.type === 'PASS') {
    const searched = searchSeatAction(state, config, seat, {
      ...L3_SEARCH,
      budgetMs: DIFFICULTY.L3.budgetMs,
      anchor: { action: 'PASS', option: null },
      anchorBonus: 1.5,
      riskWeight: 0.05,
    });
    if (searched && searched.type === 'PLAY') return searched;
  }

  return heuristic;
}
