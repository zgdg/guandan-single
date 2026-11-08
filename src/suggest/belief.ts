import type { Card, GameState, Level, Pattern, Rank, Seat } from '../core/types';
import { SEAT_ORDER_CCW } from '../core/types';
import type { RuleConfig } from '../core/config';
import { createDeck, createRng, groupByRank, isWildcard, powerRank, sortHand } from '../core/cards';

/** 一个信念粒子 = 满足公开信息约束的一整套未知手牌分配。 */
export interface Particle {
  hands: Record<Seat, Card[]>;
  /** 公开行为似然权重（过牌约束），已归一化前为乘积。 */
  weight: number;
}

export interface BeliefResult {
  particles: Particle[];
  /** 本次采样的难度降级原因；null 表示完整采样。 */
  degradedReason: string | null;
}

/** 过牌很可能持有更大牌型时的似然折扣（软约束，不是绝对排除）。 */
const PASS_LIKELIHOOD = 0.55;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function patternSignature(pattern: Pattern | null): string {
  if (!pattern) return 'lead';
  return [
    pattern.type,
    pattern.count,
    pattern.mainRank,
    pattern.sequenceLow ?? '',
    pattern.suit ?? '',
    pattern.cards.map((card) => card.id).sort().join('+'),
  ].join('|');
}

/**
 * 只由公开信息决定的局面摘要：同一公开局面 + 同一版本 → 同一建议。
 * 刻意不包含任何隐藏手牌，保证「交换对手手牌」不改变建议。
 */
export function publicStateHash(state: GameState, seat: Seat): string {
  const counts = SEAT_ORDER_CCW.map((item) => `${item}:${state.players[item].hand.length}`).join(',');
  const mine = state.players[seat].hand.map((card) => card.id).sort().join('+');
  const played = state.playedCards.map((card) => card.id).sort().join('+');
  const tribute = state.tribute
    ? state.tribute.relations
        .map(
          (relation) =>
            `${relation.payer}>${relation.recipient}:${relation.paidCard?.id ?? '-'}:${relation.returnedCard?.id ?? '-'}`,
        )
        .join(',')
    : '-';
  const tested = [
    state.ruleVersion,
    state.dealNo,
    state.levels.NS,
    state.levels.WE,
    state.currentLevelTeam,
    counts,
    mine,
    played,
    lastPlaySignature(state),
    state.trick.passedSeats.join(','),
    state.trick.turn,
    state.trick.leader,
    state.players.S.outOrder ?? '-',
    state.players.E.outOrder ?? '-',
    state.players.N.outOrder ?? '-',
    state.players.W.outOrder ?? '-',
    tribute,
  ].join('#');
  return fnv1a(tested);
}

function lastPlaySignature(state: GameState): string {
  return patternSignature(state.trick.lastPlay?.pattern ?? null);
}

/** 单张/对子能否压过上一手的快速近似判断（只在过牌加权时使用）。 */
function cheapCanBeat(hand: Card[], last: Pattern, level: Level, config: RuleConfig): boolean {
  if (last.type === 'BOMB' || last.type === 'STRAIGHT_FLUSH' || last.type === 'KING_BOMB') {
    return false;
  }
  const wilds = hand.filter((card) => isWildcard(card, level, config));
  const naturals = hand.filter((card) => !isWildcard(card, level, config));
  const groups = groupByRank(naturals);

  // 任何 4 张以上同点（含可用逢人配补齐）都能用炸弹压过普通牌型。
  for (const [, cards] of groups) {
    if (cards.length >= 4) return true;
  }
  if ((groups.get(16)?.length ?? 0) >= 2 && (groups.get(15)?.length ?? 0) >= 2) return true;

  if (last.type === 'SINGLE') {
    if (naturals.some((card) => powerRank(card, level) > last.mainRank)) return true;
    // 逢人配当作级牌单张使用，牌力为 98。
    return wilds.length > 0 && 98 > last.mainRank;
  }

  if (last.type === 'PAIR') {
    for (let rank = 2; rank <= 14; rank += 1) {
      const count = (groups.get(rank as Rank)?.length ?? 0) + wilds.length;
      const power = rank === level ? 98 : rank;
      if (count >= 2 && power > last.mainRank) return true;
    }
    for (const rank of [15, 16] as const) {
      if ((groups.get(rank)?.length ?? 0) >= 2 && rank > last.mainRank) return true;
    }
  }
  return false;
}

/** 某家在某圈过牌后，按其采样手牌给出行为似然权重。 */
function passWeight(hand: Card[], last: Pattern, level: Level, config: RuleConfig): number {
  if (hand.length === 0) return 1;
  return cheapCanBeat(hand, last, level, config) ? PASS_LIKELIHOOD : 1;
}

/**
 * 信念采样：未知牌池 = 全牌 - 我的手牌 - 已出牌 - 已公开贡牌，
 * 只按各家的公开剩余张数分配，不读取任何对手真实手牌。
 *
 * @param count 目标粒子数（实际可能少于该值，见 degradedReason）
 */
export function sampleParticles(
  state: GameState,
  config: RuleConfig,
  seat: Seat,
  count: number,
): BeliefResult {
  const level = state.levels[state.currentLevelTeam];
  const known = new Set<string>();
  for (const card of state.players[seat].hand) known.add(card.id);
  for (const card of state.playedCards) known.add(card.id);

  const pinned = {} as Record<Seat, Card[]>;
  for (const item of SEAT_ORDER_CCW) pinned[item] = [];
  if (state.tribute) {
    for (const relation of state.tribute.relations) {
      if (relation.paidCard && !known.has(relation.paidCard.id)) {
        known.add(relation.paidCard.id);
        pinned[relation.recipient].push(relation.paidCard);
      }
      if (relation.returnedCard && !known.has(relation.returnedCard.id)) {
        known.add(relation.returnedCard.id);
        pinned[relation.payer].push(relation.returnedCard);
      }
    }
  }

  const unknown = createDeck().filter((card) => !known.has(card.id));
  const others = SEAT_ORDER_CCW.filter((item) => item !== seat);
  let required = 0;
  for (const item of others) {
    required += state.players[item].hand.length - pinned[item].length;
  }
  if (required !== unknown.length) {
    return { particles: [], degradedReason: `未知牌池与剩余张数不一致（${unknown.length} vs ${required}）` };
  }
  if (required < 0) {
    return { particles: [], degradedReason: '公开贡牌与剩余张数冲突' };
  }

  const rng = createRng(Number.parseInt(publicStateHash(state, seat), 16));
  const lastPlay = state.trick.lastPlay?.pattern ?? null;
  const passed = state.trick.passedSeats;
  const particles: Particle[] = [];

  for (let index = 0; index < count; index += 1) {
    const pool = [...unknown];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }

    const hands = {} as Record<Seat, Card[]>;
    hands[seat] = state.players[seat].hand;
    let cursor = 0;
    for (const item of others) {
      const need = state.players[item].hand.length - pinned[item].length;
      const slice = pool.slice(cursor, cursor + need);
      cursor += need;
      hands[item] = sortHand([...slice, ...pinned[item]], level);
    }

    let weight = 1;
    if (lastPlay) {
      for (const item of passed) {
        weight *= passWeight(hands[item], lastPlay, level, config);
      }
    }
    particles.push({ hands, weight });
  }

  return { particles, degradedReason: null };
}

/** 加权均值。 */
export function weightedMean(values: number[], weights: number[]): number {
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const weight = weights[index] ?? 1;
    numerator += values[index]! * weight;
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}
