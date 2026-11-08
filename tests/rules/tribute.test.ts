import { describe, expect, it } from 'vitest';
import type { Card, RoundResult, Seat } from '../../src/core/types';
import { CONFIG, cards, configWith, normal } from '../helpers/cards';
import { isAntiTribute, legalReturnCards, maxTributeCards, planTribute, resolveTributeLeader } from '../../src/core/tribute';
import { otherTeam } from '../../src/core/settle';

function handOf(spec: string): Card[] {
  return cards(spec);
}

function allHands(specs: Partial<Record<Seat, string>>): Record<Seat, Card[]> {
  return {
    S: handOf(specs.S ?? 'S3'),
    E: handOf(specs.E ?? 'S4'),
    N: handOf(specs.N ?? 'S5'),
    W: handOf(specs.W ?? 'S6'),
  };
}

function singlePrev(headSeat: Seat, secondSeat: Seat, thirdSeat: Seat, lastSeat: Seat): RoundResult {
  const outOrder: Record<Seat, number | null> = { S: null, W: null, N: null, E: null };
  outOrder[headSeat] = 1;
  outOrder[secondSeat] = 2;
  outOrder[thirdSeat] = 3;
  outOrder[lastSeat] = 4;
  return {
    dealNo: 1,
    headSeat,
    secondSeat,
    lastSeat,
    outOrder,
    winnerTeam: headSeat === 'S' || headSeat === 'N' ? 'NS' : 'WE',
    upgrade: 1,
    isDoubleDown: false,
    passA: false,
    aFailed: false,
  };
}

function doublePrev(headSeat: Seat, secondSeat: Seat): RoundResult {
  const outOrder: Record<Seat, number | null> = { S: null, W: null, N: null, E: null };
  outOrder[headSeat] = 1;
  outOrder[secondSeat] = 2;
  return {
    dealNo: 1,
    headSeat,
    secondSeat,
    lastSeat: null,
    outOrder,
    winnerTeam: headSeat === 'S' || headSeat === 'N' ? 'NS' : 'WE',
    upgrade: 3,
    isDoubleDown: true,
    passA: false,
    aFailed: false,
  };
}

describe('贡牌与还贡候选', () => {
  it('进贡选择最大非红桃级牌', () => {
    const result = maxTributeCards(handOf('S3 SA BJ SJ S7'), 7, CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]!.rank).toBe(16);
  });

  it('进贡排除红桃级牌（逢人配）', () => {
    const result = maxTributeCards(handOf('H7 S7 SA S3'), 7, CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).not.toBe(handOf('H7')[0]!.id);
    expect(result[0]!.suit).toBe('S');
    expect(result[0]!.rank).toBe(7);
  });

  it('还贡必须是牌点不超过 10 且非级牌的牌', () => {
    const result = legalReturnCards(handOf('S3 S7 H7 SA S10'), 7, CONFIG);
    expect(result.map((card) => card.rank).sort((a, b) => a - b)).toEqual([3, 10]);
  });

  it('全手牌都大于 10 时还最小的一张', () => {
    const result = legalReturnCards(handOf('SA SK SQ SJ'), 7, CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]!.rank).toBe(12);
  });

  it('手里只有级牌是不超过 10 的牌时，按保守口径还最小牌', () => {
    const result = legalReturnCards(handOf('S3 SK SA'), 3, CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]!.rank).toBe(13);
  });

  it('开启 returnLevelCard 后可以还级牌', () => {
    const config = configWith({ returnLevelCard: true });
    const result = legalReturnCards(handOf('S3 SA'), 3, config);
    expect(result.map((card) => card.rank)).toEqual([3]);
  });
});

describe('抗贡', () => {
  it('单贡本人两张大王可以抗贡', () => {
    const hands = allHands({ W: 'BJ BJ SA S3' });
    expect(isAntiTribute(['W'], hands, CONFIG)).toBe(true);
  });

  it('双贡两人合计两张大王可以抗贡（默认）', () => {
    const hands = allHands({ E: 'BJ SA', W: 'BJ SK' });
    expect(isAntiTribute(['E', 'W'], hands, CONFIG)).toBe(true);
  });

  it('双贡配置为必须同一人时，两人各一张大王不能抗贡', () => {
    const config = configWith({ antiTributeDoubleMustSamePerson: true });
    const hands = allHands({ E: 'BJ SA', W: 'BJ SK' });
    expect(isAntiTribute(['E', 'W'], hands, config)).toBe(false);
  });

  it('双贡配置为必须同一人时，同一人两张大王可以抗贡', () => {
    const config = configWith({ antiTributeDoubleMustSamePerson: true });
    const hands = allHands({ E: 'BJ BJ SA', W: 'SK' });
    expect(isAntiTribute(['E', 'W'], hands, config)).toBe(true);
  });
});

describe('进贡关系与首出权', () => {
  it('单贡：末游向头游进贡，由进贡者领出', () => {
    const prev = singlePrev('S', 'E', 'W', 'N');
    const plan = planTribute(prev, allHands({}), 2, CONFIG);
    expect(plan.resisted).toBe(false);
    expect(plan.relations).toEqual([{ payer: 'N', recipient: 'S' }]);
    expect(plan.leader).toBe('N');
  });

  it('单贡抗贡后不进贡，由头游领出', () => {
    const prev = singlePrev('S', 'E', 'W', 'N');
    const plan = planTribute(prev, allHands({ N: 'BJ BJ SA' }), 2, CONFIG);
    expect(plan.resisted).toBe(true);
    expect(plan.relations).toHaveLength(0);
    expect(plan.leader).toBe('S');
  });

  it('内贡默认成立：末游与头游同队仍进贡', () => {
    const prev = singlePrev('S', 'E', 'W', 'N');
    const plan = planTribute(prev, allHands({}), 2, CONFIG);
    expect(plan.relations).toEqual([{ payer: 'N', recipient: 'S' }]);
  });

  it('关闭 innerTribute 后内贡跳过，由头游领出', () => {
    const config = configWith({ innerTribute: false });
    const prev = singlePrev('S', 'E', 'W', 'N');
    const plan = planTribute(prev, allHands({}), 2, config);
    expect(plan.skipped).toBe(true);
    expect(plan.relations).toHaveLength(0);
    expect(plan.leader).toBe('S');
  });

  it('双贡：大贡给头游、小贡给二游，贡给头游者领出', () => {
    const prev = doublePrev('S', 'N');
    expect(prev.isDoubleDown).toBe(true);
    expect(otherTeam(prev.winnerTeam)).toBe('WE');
    const plan = planTribute(prev, allHands({ E: 'SA S3', W: 'SK S4' }), 2, CONFIG);
    expect(plan.relations).toEqual([
      { payer: 'E', recipient: 'S' },
      { payer: 'W', recipient: 'N' },
    ]);
    expect(plan.leader).toBe('E');
  });

  it('双贡同点时默认由头游下家贡给头游并先出', () => {
    const prev = doublePrev('S', 'N');
    const plan = planTribute(prev, allHands({ E: 'SA S3', W: 'HA H3' }), 2, CONFIG);
    expect(plan.relations[0]).toEqual({ payer: 'E', recipient: 'S' });
    expect(plan.leader).toBe('E');
  });

  it('双贡两人合计两张大王时抗贡', () => {
    const prev = doublePrev('S', 'N');
    const plan = planTribute(prev, allHands({ E: 'BJ SA', W: 'BJ SK' }), 2, CONFIG);
    expect(plan.resisted).toBe(true);
    expect(plan.leader).toBe('S');
  });

  it('双贡被抗后由头游领出', () => {
    const prev = doublePrev('S', 'N');
    const plan = planTribute(prev, allHands({ E: 'BJ BJ S3', W: 'SK S4' }), 2, CONFIG);
    expect(plan.resisted).toBe(true);
    expect(resolveTributeLeader(prev, plan.relations, plan.resisted)).toBe('S');
  });

  it('双贡结束后首圈由贡给头游的人领出', () => {
    const prev = doublePrev('S', 'N');
    const plan = planTribute(prev, allHands({ E: 'SA S3', W: 'SK S4' }), 2, CONFIG);
    expect(resolveTributeLeader(prev, plan.relations, plan.resisted)).toBe('E');
  });

  it('planTribute 记录的贡牌候选与实际手牌一致', () => {
    const prev = singlePrev('S', 'E', 'W', 'N');
    const hands = allHands({ N: 'H2 S2 CA S5', S: 'S6' });
    const plan = planTribute(prev, hands, 2, CONFIG);
    expect(plan.tributeCards.N?.map((card) => card.rank)).toEqual([2]);
  });

  it('级牌 10 的贡牌按级牌牌力大于 A', () => {
    const prev = singlePrev('S', 'E', 'W', 'N');
    const hands = allHands({ N: 'C10 SA S3', S: 'S6' });
    const plan = planTribute(prev, hands, 10, CONFIG);
    expect(normal(plan.tributeCards.N?.[0]?.rank ?? 2)).toBe(10);
  });
});
