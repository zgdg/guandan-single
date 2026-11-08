import type { Card, Level, RoundResult, Seat } from './types';
import type { RuleConfig } from './config';
import { isWildcard, nextSeat, playOrder, powerRank, teamOf } from './cards';
import { otherTeam } from './settle';

export interface TributePlan {
  resisted: boolean;
  /** 内贡被关闭等导致本副不进贡。 */
  skipped: boolean;
  /** 已确定进贡关系（尚未实际贡牌）。 */
  relations: Array<{ payer: Seat; recipient: Seat }>;
  /** 每位进贡者应贡的最大牌（可能有多张同牌力，任选其一）。 */
  tributeCards: Partial<Record<Seat, Card[]>>;
  /** 首圈领出者。 */
  leader: Seat;
}

function bigKingCount(hand: Card[]): number {
  return hand.filter((card) => card.rank === 16).length;
}

/** 贡牌必须是最大非红桃级牌；同牌力可有多张。 */
export function maxTributeCards(hand: Card[], level: Level, config: RuleConfig): Card[] {
  const eligible = hand.filter((card) => !isWildcard(card, level, config));
  if (eligible.length === 0) return [];
  let max = -Infinity;
  for (const card of eligible) max = Math.max(max, powerRank(card, level));
  return eligible.filter((card) => powerRank(card, level) === max);
}

/**
 * 还贡候选。
 * 默认口径：牌点 ≤ 10（含 10），且不能还级牌/红桃级牌。
 * 若手中没有符合条件的牌（即全部牌力都高于 10），还最小的一张。
 */
export function legalReturnCards(hand: Card[], level: Level, config: RuleConfig): Card[] {
  const eligible = hand.filter((card) => {
    if (card.rank > 10) return false;
    if (!config.returnLevelCard) {
      if (card.rank === level) return false;
      if (isWildcard(card, level, config)) return false;
    }
    return true;
  });
  if (eligible.length > 0) return eligible;

  if (hand.length === 0) return [];
  let minCard = hand[0]!;
  let minPower = powerRank(minCard, level);
  for (const card of hand) {
    const power = powerRank(card, level);
    if (power < minPower || (power === minPower && card.rank < minCard.rank)) {
      minCard = card;
      minPower = power;
    }
  }
  return [minCard];
}

/** 抗贡：单贡本人两张大王；双贡默认两人合计两张，可配置必须同一人。 */
export function isAntiTribute(
  payers: Seat[],
  hands: Record<Seat, Card[]>,
  config: RuleConfig,
): boolean {
  if (payers.length === 1) return bigKingCount(hands[payers[0]!] ?? []) >= 2;
  if (config.antiTributeDoubleMustSamePerson) {
    return payers.some((seat) => bigKingCount(hands[seat] ?? []) >= 2);
  }
  return payers.reduce((sum, seat) => sum + bigKingCount(hands[seat] ?? []), 0) >= 2;
}

function firstPayerInOrder(head: Seat, payers: Seat[], config: RuleConfig): Seat {
  const order = playOrder(config);
  const start = order.indexOf(head);
  for (let step = 1; step <= order.length; step += 1) {
    const seat = order[(start + step) % order.length]!;
    if (payers.includes(seat)) return seat;
  }
  return payers[0]!;
}

/**
 * 生成下一副的进贡计划（只含关系与候选牌，不修改手牌）。
 * 关系/首出权依据 docs/掼蛋规则汇总.md §5.2–5.7。
 */
export function planTribute(
  prev: RoundResult,
  hands: Record<Seat, Card[]>,
  level: Level,
  config: RuleConfig,
): TributePlan {
  const head = prev.headSeat;
  const second = prev.secondSeat;
  const winnerTeam = prev.winnerTeam;

  if (prev.isDoubleDown) {
    const payers = (Object.keys(hands) as Seat[]).filter(
      (seat) => teamOf(seat) === otherTeam(winnerTeam),
    );
    const resisted = isAntiTribute(payers, hands, config);
    if (resisted || second === null) {
      return {
        resisted,
        skipped: false,
        relations: [],
        tributeCards: {},
        leader: head,
      };
    }

    const cardsByPayer: Partial<Record<Seat, Card[]>> = {};
    const powerByPayer = new Map<Seat, number>();
    for (const payer of payers) {
      const cards = maxTributeCards(hands[payer] ?? [], level, config);
      cardsByPayer[payer] = cards;
      powerByPayer.set(payer, cards.length > 0 ? powerRank(cards[0]!, level) : -Infinity);
    }

    const [p0, p1] = payers as [Seat, Seat];
    let headPayer: Seat;
    const power0 = powerByPayer.get(p0) ?? -Infinity;
    const power1 = powerByPayer.get(p1) ?? -Infinity;
    if (power0 === power1) {
      // D02：同点贡牌归属。默认「头游下家→头游并由其先出」。
      if (config.doubleTributeTieRule === 'headNextToHead') {
        const headNext = nextSeat(head, config);
        headPayer = payers.includes(headNext) ? headNext : firstPayerInOrder(head, payers, config);
      } else {
        headPayer = firstPayerInOrder(head, payers, config);
      }
    } else {
      headPayer = power0 > power1 ? p0 : p1;
    }
    const secondPayer = headPayer === p0 ? p1 : p0;

    return {
      resisted: false,
      skipped: false,
      relations: [
        { payer: headPayer, recipient: head },
        { payer: secondPayer, recipient: second },
      ],
      tributeCards: cardsByPayer,
      leader: headPayer,
    };
  }

  const payer = findLastSeat(prev);
  if (payer === null) {
    return { resisted: false, skipped: false, relations: [], tributeCards: {}, leader: head };
  }
  if (teamOf(payer) === teamOf(head) && !config.innerTribute) {
    // D14：内贡开关关闭时本副不进贡，由头游领出。
    return { resisted: false, skipped: true, relations: [], tributeCards: {}, leader: head };
  }

  const resisted = isAntiTribute([payer], hands, config);
  if (resisted) {
    return { resisted: true, skipped: false, relations: [], tributeCards: {}, leader: head };
  }
  const cards = maxTributeCards(hands[payer] ?? [], level, config);
  return {
    resisted: false,
    skipped: false,
    relations: [{ payer, recipient: head }],
    tributeCards: { [payer]: cards },
    leader: payer,
  };
}

function findLastSeat(prev: RoundResult): Seat | null {
  if (prev.lastSeat) return prev.lastSeat;
  for (const seat of Object.keys(prev.outOrder) as Seat[]) {
    if (prev.outOrder[seat] === 4) return seat;
  }
  return null;
}

/** 本副 TRIBUTE 阶段结束后的首圈领出者。 */
export function resolveTributeLeader(
  prev: RoundResult | null,
  relations: Array<{ payer: Seat; recipient: Seat }>,
  resisted: boolean,
): Seat {
  const head = prev?.headSeat ?? 'S';
  if (resisted || relations.length === 0 || !prev) return head;
  if (prev.isDoubleDown) {
    const relation = relations.find((item) => item.recipient === head);
    return relation?.payer ?? head;
  }
  return relations[0]!.payer;
}
