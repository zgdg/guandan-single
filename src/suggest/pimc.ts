import type { Card, EngineAction, GameState, Level, PlayOption, Seat } from '../core/types';
import { SEAT_ORDER_CCW } from '../core/types';
import type { RuleConfig } from '../core/config';
import { applyAction, getCurrentSeat, getLegalPlays } from '../core/engine';
import { chooseAction, selectorOf } from '../ai/simple';
import { beats, isBombPattern, patternName } from '../core/compare';
import { createRng, isWildcard, partnerSeat, teamOf } from '../core/cards';
import { estimateHandTurns } from '../ai/handEval';
import {
  buildSuggestion,
  consOf,
  sameCards,
  structurePenalty,
  suggestForHuman,
  type Suggestion,
  type SuggestionAlternative,
} from './static';
import { publicStateHash, sampleParticles, weightedMean, type Particle } from './belief';

export interface PimcOptions {
  /** 目标信念粒子数。 */
  particles?: number;
  /** 时间不足时至少保留的粒子数。 */
  minParticles?: number;
  /** 参与 rollout 的候选动作数（含过牌）。 */
  candidates?: number;
  /** 每个候选动作 rollout 的最大步数（截断后走叶子评估）。 */
  horizon?: number;
  /** 主线程同预算；超时降级。 */
  budgetMs?: number;
  /** rollout 中三家 AI 的跟牌意愿。 */
  rolloutFollowRate?: number;
}

/**
 * 依据实测吞吐设定：桌面 Node 下整副 rollout P95≈24ms，
 * 全副 20×4 会到秒级，因此改为「截断 rollout（默认 16 步）+ 叶子名次估计」。
 */
export const PIMC_DEFAULTS: Required<PimcOptions> = {
  particles: 8,
  minParticles: 4,
  candidates: 3,
  horizon: 16,
  budgetMs: 160,
  rolloutFollowRate: 0.6,
};

/** 被压/被炸的惩罚权重：只作次要修正，避免把建议逼成「一律过牌」。 */
const RISK_WEIGHT = 0.3;

/**
 * 静态锚点分：静态建议已验证显著优于 L1，采样只应在「明显更优」时推翻它。
 * 0.55 约等于半个名次收益，可过滤截断 rollout 的噪声。
 */
const STATIC_ANCHOR_BONUS = 0.55;

export interface CandidateScore {
  action: 'PLAY' | 'PASS';
  option: PlayOption | null;
  expectedRank: number;
  risk: number;
  samples: number;
  /** 该候选在多少比例的样本中是最优。 */
  bestShare: number;
  /** 名次收益的样本方差，用于置信度。 */
  variance: number;
  score: number;
}

export interface PimcResult {
  suggestion: Suggestion;
  /** 是否走了降级路径（粒子不足 / 超时 / 采样失败 / Worker 不可用）。 */
  degraded: boolean;
  degradeReason: string | null;
  particles: number;
  candidates: number;
  elapsedMs: number;
  confidence: number;
  scores: CandidateScore[];
}

interface Candidate {
  kind: 'PLAY' | 'PASS';
  option: PlayOption | null;
  prune: number;
}

interface SimOutcome {
  rankValue: number;
  risk: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** 只覆盖粒子手牌；引擎每次落子前都会深拷贝其余可变字段，共享是安全的。 */
function simulationState(state: GameState, particle: Particle): GameState {
  const players = {} as GameState['players'];
  for (const seat of SEAT_ORDER_CCW) {
    players[seat] = { ...state.players[seat], hand: particle.hands[seat] };
  }
  return { ...state, players, events: [] };
}

/** 名次收益：头游+二游=3、头游+三游=2、头游+末游=1、未拿头游=0。 */
function rankValueOf(order: Record<Seat, number | null>, seat: Seat): number {
  const head = SEAT_ORDER_CCW.find((item) => order[item] === 1);
  if (!head || teamOf(head) !== teamOf(seat)) return 0;
  const mateAt = (at: number): boolean =>
    SEAT_ORDER_CCW.some((item) => order[item] === at && teamOf(item) === teamOf(seat));
  return mateAt(2) ? 3 : mateAt(3) ? 2 : 1;
}

/**
 * 连续叶子评估：剩余手数按 exp(-手数) 折算成完赛概率，枚举手牌未出完座位的全部顺序，
 * 用名次收益的期望值代替「整数手数直接排名」。
 * 所以拆炸弹多算的 0.2–0.5 手会直接压低期望，而不是只在整数并列时才改变排序。
 */
function leafRank(state: GameState, config: RuleConfig, seat: Seat, extraTurns = 0): number {
  const level = state.levels[state.currentLevelTeam];
  const order = {} as Record<Seat, number | null>;
  const pending: Seat[] = [];
  let place = 1;
  for (const item of SEAT_ORDER_CCW) {
    const out = state.players[item].outOrder;
    order[item] = out;
    if (out === null) pending.push(item);
    else place = Math.max(place, out + 1);
  }
  const turns = (item: Seat): number =>
    estimateHandTurns(state.players[item].hand, level, config) +
    (item === seat ? extraTurns : 0);
  const weight = {} as Record<Seat, number>;
  for (const item of pending) weight[item] = Math.exp(-turns(item));
  let expected = 0;
  const walk = (rest: Seat[], probability: number, next: number): void => {
    if (rest.length === 0) {
      expected += probability * rankValueOf(order, seat);
      return;
    }
    let total = 0;
    for (const item of rest) total += weight[item]!;
    for (const item of rest) {
      order[item] = next;
      walk(
        rest.filter((entry) => entry !== item),
        (probability * weight[item]!) / total,
        next + 1,
      );
    }
  };
  walk(pending, 1, place);
  return expected;
}

/** 剪枝打分：优先「多出牌、少用炸弹/逢人配、能一手走完」。 */
function pruneScore(
  option: PlayOption,
  handCount: number,
  level: Level,
  config: RuleConfig,
): number {
  const pattern = option.pattern;
  let score = pattern.count;
  if (isBombPattern(pattern)) score -= 7;
  score -= pattern.cards.filter((card) => isWildcard(card, level, config)).length * 1.5;
  if (pattern.count === 1) score -= 0.6;
  if (handCount - pattern.count === 0) score += 8;
  return score;
}

/** 融合锚点：人类建议用静态建议，AI 用 L2 启发式动作，避免采样噪声把决策拉偏。 */
export interface Anchor {
  action: 'PLAY' | 'PASS';
  option: PlayOption | null;
}

interface BuildCandidatesResult {
  picked: Candidate[];
  /** 若锚点拆结构且存在同牌型的安全替代，这里返回该替代，用于取消锚点加分。 */
  structureSafe: PlayOption | null;
}

/** 找同牌型、同张数、不拆结构、主牌力最小的替代。 */
function findStructureSafe(
  legal: PlayOption[],
  hand: PlayOption['pattern']['cards'],
  anchor: Anchor | null,
  level: Level,
  config: RuleConfig,
): PlayOption | null {
  const target = anchor?.option;
  if (!target || structurePenalty(hand, target, level, config) === 0) return null;
  let best: PlayOption | null = null;
  for (const option of legal) {
    if (
      option.pattern.type === target.pattern.type &&
      option.pattern.count === target.pattern.count &&
      structurePenalty(hand, option, level, config) === 0 &&
      (!best || option.pattern.mainRank < best.pattern.mainRank)
    ) {
      best = option;
    }
  }
  return best;
}

function buildCandidates(
  state: GameState,
  legal: PlayOption[],
  config: RuleConfig,
  seat: Seat,
  limit: number,
  anchor: Anchor | null,
  structureGuard: boolean,
): BuildCandidatesResult {
  const level = state.levels[state.currentLevelTeam];
  const handCount = state.players[seat].hand.length;
  const passAllowed = state.trick.lastPlay !== null;
  const mk = (option: PlayOption): Candidate => ({
    kind: 'PLAY',
    option,
    prune: pruneScore(option, handCount, level, config),
  });
  const plays = legal.map(mk).sort((left, right) => right.prune - left.prune);

  const slots = Math.max(1, limit - (passAllowed ? 1 : 0));
  const picked = plays.slice(0, slots);

  // 人类建议链路：锚点拆结构时，强制把「同牌型、不拆结构」的替代塞进候选。
  // 用替换而非追加，保证 rollout 候选数不变，不拖慢单步耗时。
  let structureSafe: PlayOption | null = null;
  if (structureGuard) {
    structureSafe = findStructureSafe(legal, state.players[seat].hand, anchor, level, config);
    if (
      structureSafe &&
      !picked.some((candidate) => candidate.option && sameCards(candidate.option, structureSafe!))
    ) {
      // 候选按剪枝分降序，末位优先级最低；直接替换它，避免增加 rollout 数量。
      if (picked.length >= slots) picked.pop();
      picked.push(mk(structureSafe));
    }
  }
  // 必须保留「能一手走完」的最优解，避免被剪枝误杀。
  const finisher = plays.find((candidate) => handCount - candidate.option!.pattern.count === 0);
  if (finisher && !picked.some((candidate) => candidate.option === finisher.option)) {
    picked.push(finisher);
  }

  // 锚点动作必须进入候选：融合阶段以它为基准，采样只在明显更优时才推翻。
  if (anchor?.option) {
    const found = picked.find((candidate) => candidate.option && sameCards(candidate.option, anchor.option!));
    if (!found) picked.push(mk(anchor.option));
  }

  if (passAllowed) {
    const last = state.trick.lastPlay!;
    const partnerLead = last.seat === partnerSeat(seat);
    const opponentCount = state.players[last.seat].hand.length;
    picked.push({
      kind: 'PASS',
      option: null,
      prune: partnerLead ? 2.5 : opponentCount <= 3 ? -2 : 0.4,
    });
  }
  return { picked, structureSafe };
}

function isAnchorMatch(candidate: Candidate, anchor: Anchor | null): boolean {
  if (!anchor) return false;
  if (candidate.kind === 'PASS') return anchor.action === 'PASS';
  return !!(
    candidate.option &&
    anchor.action === 'PLAY' &&
    anchor.option &&
    sameCards(candidate.option, anchor.option)
  );
}

function candidateAction(candidate: Candidate, seat: Seat): EngineAction | null {
  if (candidate.kind === 'PASS') return { type: 'PASS', seat };
  const option = candidate.option;
  if (!option) return null;
  const selector = selectorOf(option.pattern);
  return {
    type: 'PLAY',
    seat,
    cards: option.pattern.cards,
    ...(selector ? { selector } : {}),
  };
}

export type RolloutStrategy = (
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  rng: () => number,
) => EngineAction | null;

/**
 * 单个粒子 + 单个候选的截断 rollout。
 * 返回 null 表示候选动作被引擎拒绝（理论上不会发生，用于兜底合法性）。
 */
function rolloutCandidate(
  base: GameState,
  candidate: Candidate,
  config: RuleConfig,
  seat: Seat,
  horizon: number,
  followRate: number,
  seed: number,
  strategy: RolloutStrategy | null,
): SimOutcome | null {
  try {
    return rolloutCandidateInner(base, candidate, config, seat, horizon, followRate, seed, strategy);
  } catch {
    // 任何引擎/数据异常都视为该样本不可用，绝不向外抛出。
    return null;
  }
}

function rolloutCandidateInner(
  base: GameState,
  candidate: Candidate,
  config: RuleConfig,
  seat: Seat,
  horizon: number,
  followRate: number,
  seed: number,
  strategy: RolloutStrategy | null,
): SimOutcome | null {
  const action = candidateAction(candidate, seat);
  if (!action) return null;
  const first = applyAction(base, action, config, { recordEvents: false });
  if (!first.ok) return null;

  const ourPattern = candidate.option?.pattern ?? null;
  const trickLeader = first.state.trick.leader;
  const trackingTrick = ourPattern !== null && first.state.trick.lastPlay?.seat === seat;
  let risk = 0;
  let current = first.state;
  const rng = createRng(seed);

  for (let step = 0; step < horizon; step += 1) {
    if (current.phase === 'SETTLEMENT' || current.phase === 'GAME_OVER') break;
    const actor = getCurrentSeat(current);
    if (!actor) break;
    const nextAction = strategy
      ? strategy(current, config, actor, rng)
      : chooseAction(current, config, rng, { followRate });
    if (!nextAction) break;
    const result = applyAction(current, nextAction, config, { recordEvents: false });
    if (!result.ok) break;

    if (
      trackingTrick &&
      ourPattern &&
      current.trick.leader === trickLeader &&
      nextAction.type === 'PLAY' &&
      teamOf(actor) !== teamOf(seat)
    ) {
      const played = result.state.trick.lastPlay?.pattern;
      if (played && beats(played, ourPattern, config)) {
        risk = Math.max(risk, isBombPattern(played) ? 0.85 : 0.45);
      } else if (!played && result.state.trick.leader !== trickLeader) {
        // 对手打完这一手后本圈结束，说明我们被压且无人再应。
        risk = Math.max(risk, 0.45);
      }
    }
    current = result.state;
  }

  // 拆炸弹/拆三张在叶子上真实多算一点手数，避免「当下走得快」掩盖结构损失。
  const damage = candidate.option
    ? structurePenalty(
        base.players[seat].hand,
        candidate.option,
        base.levels[base.currentLevelTeam],
        config,
      )
    : 0;
  const extraTurns = damage >= 80 ? 0.5 : damage >= 24 ? 0.3 : damage > 0 ? 0.2 : 0;
  const rankValue = leafRank(current, config, seat, extraTurns);

  return { rankValue, risk };
}

function weightedVariance(values: number[], weights: number[], mean: number): number {
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const weight = weights[index] ?? 1;
    numerator += weight * (values[index]! - mean) ** 2;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function buildReason(
  state: GameState,
  candidate: Candidate,
  expectedRank: number,
  samples: number,
): { title: string; reason: string } {
  const partner = partnerSeat('S');
  const last = state.trick.lastPlay;
  const mate = !!(last && last.seat === partner);
  if (candidate.kind === 'PASS') {
    return {
      title: '建议过牌',
      reason: mate
        ? `队友领出，采样显示过牌更稳（${samples} 个推断样本）`
        : `采样评估后这手先不接更划算（${samples} 个推断样本）`,
    };
  }
  const pattern = candidate.option!.pattern;
  const name = patternName(pattern);
  if (!last) {
    return { title: `建议出${name}`, reason: `领出${name}，一次走 ${pattern.count} 张` };
  }
  return {
    title: mate ? `建议用${name}接应` : `建议用${name}压住`,
    reason: mate
      ? `采样显示抢下这圈牌权更有利（名次收益 ${expectedRank.toFixed(1)}/3）`
      : `采样显示这手比过牌更优（名次收益 ${expectedRank.toFixed(1)}/3）`,
  };
}

function fallback(
  staticSuggestion: Suggestion,
  reason: string,
  started: number,
  particles: number,
): PimcResult {
  return {
    suggestion: {
      ...staticSuggestion,
      engine: 'static',
      degraded: true,
      degradeReason: reason,
    },
    degraded: true,
    degradeReason: reason,
    particles,
    candidates: 0,
    elapsedMs: Math.round(now() - started),
    confidence: 0,
    scores: [],
  };
}

/** 供 UI/Worker 在超时或不可用时直接拿到带降级标记的静态建议。 */
export function degradedSuggestion(
  state: GameState,
  config: RuleConfig,
  reason: string,
  seat: 'S' = 'S',
): PimcResult {
  return fallback(suggestForHuman(state, config, seat), reason, now(), 0);
}

interface SearchOutcome {
  candidates: Candidate[];
  legal: PlayOption[];
  scores: CandidateScore[];
  samples: number;
  degraded: boolean;
  degradeReason: string | null;
  elapsedMs: number;
}

type SearchResult = { ok: true; outcome: SearchOutcome } | { ok: false; reason: string };

/**
 * 通用的「采样 + 候选 rollout」搜索：人类建议与 L3 AI 共用。
 * 只读取公开信息（通过信念采样生成对手手牌），不触碰真实隐藏手牌。
 */
function searchCandidates(
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  opts: Required<PimcOptions>,
  anchor: Anchor | null,
  anchorBonus: number,
  riskWeight: number = RISK_WEIGHT,
  strategy: RolloutStrategy | null = null,
  structureGuard = false,
): SearchResult {
  const started = now();
  const level = state.levels[state.currentLevelTeam];
  const { options: legal } = getLegalPlays(state, config, seat);
  const built = buildCandidates(state, legal, config, seat, opts.candidates, anchor, structureGuard);
  const candidates = built.picked;
  if (candidates.length === 0) return { ok: false, reason: '没有可用的候选动作' };
  // 锚点加分按结构代价分档：不拆结构→全分；拆了但无同牌型替代→半分；有安全替代→0。
  const anchorDamage =
    structureGuard && anchor?.option
      ? structurePenalty(state.players[seat].hand, anchor.option, level, config)
      : 0;
  const effectiveAnchorBonus = anchorDamage === 0 ? anchorBonus : built.structureSafe ? 0 : anchorBonus * 0.5;

  // 对手接近走完时，被压/被炸的代价更高，风险权重临时上调。
  const threat = state.trick.lastPlay;
  if (threat && teamOf(threat.seat) !== teamOf(seat) && state.players[threat.seat].hand.length <= 6) {
    riskWeight *= 1.5;
  }

  const belief = sampleParticles(state, config, seat, opts.particles);
  if (belief.particles.length === 0) {
    return { ok: false, reason: belief.degradedReason ?? '信念采样失败' };
  }

  const hashSeed = Number.parseInt(publicStateHash(state, seat), 16);
  const outcomes = candidates.map(() => ({ ranks: [] as number[], risks: [] as number[] }));
  const weights: number[] = [];
  const particleBest: number[] = [];
  let degraded = false;
  let degradeReason: string | null = null;

  for (let index = 0; index < belief.particles.length; index += 1) {
    if (index >= opts.minParticles && now() - started > opts.budgetMs) {
      degraded = true;
      degradeReason = `时间预算超限，粒子数降为 ${index}`;
      break;
    }
    const particle = belief.particles[index]!;
    const sim = simulationState(state, particle);
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const outcome = rolloutCandidate(
        sim,
        candidates[candidateIndex]!,
        config,
        seat,
        opts.horizon,
        opts.rolloutFollowRate,
        (hashSeed ^ (index * 0x9e3779b9) ^ (candidateIndex * 0x85ebca6b)) >>> 0,
        strategy,
      );
      if (!outcome) {
        outcomes[candidateIndex]!.ranks.push(0);
        outcomes[candidateIndex]!.risks.push(1);
        continue;
      }
      outcomes[candidateIndex]!.ranks.push(outcome.rankValue);
      outcomes[candidateIndex]!.risks.push(outcome.risk);
      // 样本内比较只看采样结果；静态锚点只在最终融合时加分。
      const score = outcome.rankValue - riskWeight * outcome.risk;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = candidateIndex;
      }
    }
    weights.push(particle.weight);
    particleBest.push(bestIndex);
  }

  const samples = weights.length;
  if (samples === 0) return { ok: false, reason: '粒子数为 0' };

  const scores: CandidateScore[] = candidates.map((candidate, index) => {
    const ranks = outcomes[index]!.ranks;
    const risks = outcomes[index]!.risks;
    const expectedRank = weightedMean(ranks, weights);
    const risk = weightedMean(risks, weights);
    const bestShare = particleBest.filter((item) => item === index).length / samples;
    const variance = weightedVariance(ranks, weights, expectedRank);
    return {
      action: candidate.kind,
      option: candidate.option,
      expectedRank,
      risk,
      samples: ranks.length,
      bestShare,
      variance,
      score:
        expectedRank -
        riskWeight * risk +
        (isAnchorMatch(candidate, anchor) ? effectiveAnchorBonus : 0),
    };
  });

  return {
    ok: true,
    outcome: {
      candidates,
      legal,
      scores,
      samples,
      degraded,
      degradeReason,
      elapsedMs: Math.round(now() - started),
    },
  };
}

/**
 * PIMC 建议：公开信息采样 → 候选剪枝 → 截断 rollout → 名次收益融合。
 * 任何异常/超时都回退静态建议，并标记 degraded；返回的动作始终来自合法枚举。
 */
export function runPimc(
  state: GameState,
  config: RuleConfig,
  seat: 'S' = 'S',
  options: PimcOptions = {},
): PimcResult {
  const started = now();
  const opts = { ...PIMC_DEFAULTS, ...options };
  const staticSuggestion = suggestForHuman(state, config, seat);
  const anchor = { action: staticSuggestion.action, option: staticSuggestion.option };

  if (state.phase !== 'PLAYING' || getCurrentSeat(state) !== seat) {
    return fallback(staticSuggestion, '当前不是你的出牌回合', started, 0);
  }

  const search = searchCandidates(
    state,
    config,
    seat,
    opts,
    anchor,
    STATIC_ANCHOR_BONUS,
    RISK_WEIGHT,
    null,
    true,
  );
  if (!search.ok) {
    return fallback(staticSuggestion, search.reason, started, 0);
  }
  const { candidates, legal, scores, samples, degraded, degradeReason } = search.outcome;
  const level = state.levels[state.currentLevelTeam];

  const sorted = [...scores].sort((left, right) => right.score - left.score);
  const chosen = sorted[0]!;
  const chosenIndex = scores.indexOf(chosen);

  const differ = sorted[1] ? chosen.score - sorted[1].score : 1;
  const confidence = Math.min(
    0.92,
    Math.max(
      0.25,
      0.5 + 0.35 * Math.min(1, Math.max(0, differ) / 0.9) - Math.min(0.25, chosen.variance / 12),
    ),
  );

  const anchorHit = isAnchorMatch(candidates[chosenIndex]!, anchor);
  const reasonText = anchorHit
    ? { title: staticSuggestion.title, reason: staticSuggestion.reason }
    : buildReason(state, candidates[chosenIndex]!, chosen.expectedRank, chosen.samples);
  const base = buildSuggestion(
    state,
    config,
    seat,
    chosen.action,
    chosen.option,
    reasonText.title,
    reasonText.reason,
    legal,
  );

  // §4.2.7：把握度低时并列展示 2 个方案（仍标注首选），把采样第二名提到备选第一位。
  const runnerUp = sorted[1];
  const runnerUpOption =
    runnerUp?.action === 'PLAY' &&
    runnerUp.option &&
    !(chosen.option && sameCards(chosen.option, runnerUp.option))
      ? runnerUp.option
      : null;
  const alternatives: SuggestionAlternative[] =
    confidence < 0.45 && runnerUp && runnerUpOption
      ? [
          {
            option: runnerUpOption,
            pros: `采样把握与首选接近，名次期望 ${runnerUp.expectedRank.toFixed(1)} / 3`,
            cons: consOf(runnerUpOption, state.players[seat].hand, level, config),
          },
          ...base.alternatives.filter((alt) => !sameCards(alt.option, runnerUpOption)),
        ]
      : base.alternatives;

  const bestShare = Math.round(chosen.bestShare * 100);
  const reasons = [
    ...(confidence < 0.45 ? ['次优方案与首选接近，两种打法都可以'] : []),
    `基于 ${chosen.samples} 个推断样本，本队名次收益期望 ${chosen.expectedRank.toFixed(1)} / 3`,
    anchorHit
      ? '采样未找到明显更优打法，沿用静态选择'
      : `这些样本中 ${bestShare}% 判断这手最优`,
    ...base.reasons,
  ].slice(0, 3);
  const riskText =
    chosen.risk > 0.2
      ? `${base.risk}（采样中被压约 ${Math.round(chosen.risk * 100)}%）`
      : base.risk;

  const suggestion: Suggestion = {
    ...base,
    reasons,
    alternatives,
    risk: riskText,
    confidence,
    degraded,
    engine: 'pimc',
    sampleParticles: samples,
    ...(degraded && degradeReason ? { degradeReason } : {}),
  };

  return {
    suggestion,
    degraded,
    degradeReason,
    particles: samples,
    candidates: candidates.length,
    elapsedMs: Math.round(now() - started),
    confidence,
    scores,
  };
}

export interface SeatSearchOptions extends PimcOptions {
  /** 融合锚点（一般为该座位的 L2 启发式动作）。 */
  anchor?: Anchor | null;
  anchorBonus?: number;
  /** 风险项权重；AI 对局通常低于人类建议，避免过度保守。 */
  riskWeight?: number;
  /** rollout 策略；AI 可注入自己的启发式，人类建议默认用轻量贪心。 */
  rolloutPolicy?: RolloutStrategy | null;
}

/**
 * L3 对局 AI 用：对任意座位做一次采样搜索，直接返回最优点数的合法动作。
 * 以 L2 启发式动作作为锚点，搜索只在不明显更优时才推翻它；失败时返回 null，由调用方回退。
 */
export function searchSeatAction(
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  options: SeatSearchOptions = {},
): EngineAction | null {
  if (state.phase !== 'PLAYING' || getCurrentSeat(state) !== seat) return null;
  const {
    anchor = null,
    anchorBonus = STATIC_ANCHOR_BONUS,
    riskWeight = RISK_WEIGHT,
    rolloutPolicy = null,
    ...pimcOptions
  } = options;
  const opts = { ...PIMC_DEFAULTS, ...pimcOptions };
  const search = searchCandidates(
    state,
    config,
    seat,
    opts,
    anchor,
    anchorBonus,
    riskWeight,
    rolloutPolicy,
  );
  if (!search.ok) return null;
  const sorted = [...search.outcome.scores].sort((left, right) => right.score - left.score);
  const best = sorted[0];
  if (!best) return null;
  return candidateAction(
    { kind: best.action, option: best.option, prune: best.score },
    seat,
  );
}

