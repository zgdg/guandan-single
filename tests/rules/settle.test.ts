import { describe, expect, it } from 'vitest';
import type { Level, Seat } from '../../src/core/types';
import { settleRound } from '../../src/core/settle';
import { CONFIG, configWith } from '../helpers/cards';

function orderOf(sequence: Seat[]): Record<Seat, number | null> {
  return {
    S: null,
    W: null,
    N: null,
    E: null,
    ...Object.fromEntries(sequence.map((seat, index) => [seat, index + 1])),
  } as Record<Seat, number | null>;
}

function settle(
  sequence: Seat[],
  options: {
    levels?: { NS: number; WE: number };
    currentLevelTeam?: 'NS' | 'WE';
    aFailCounts?: { NS: number; WE: number };
    config?: Partial<typeof CONFIG>;
  } = {},
) {
  const levels = options.levels ?? { NS: 2, WE: 2 };
  const currentLevelTeam = options.currentLevelTeam ?? 'NS';
  return settleRound({
    levels: levels as { NS: Level; WE: Level },
    currentLevelTeam,
    outOrder: orderOf(sequence),
    headSeat: sequence[0]!,
    secondSeat: sequence[1] ?? null,
    config: options.config ? configWith(options.config) : CONFIG,
    aFailCounts: options.aFailCounts ?? { NS: 0, WE: 0 },
  });
}

const REMAINING_AFTER_S: Seat[][] = [
  ['N', 'E', 'W'],
  ['N', 'W', 'E'],
  ['E', 'N', 'W'],
  ['E', 'W', 'N'],
  ['W', 'N', 'E'],
  ['W', 'E', 'N'],
];

const REMAINING_AFTER_N: Seat[][] = [
  ['S', 'E', 'W'],
  ['S', 'W', 'E'],
  ['E', 'S', 'W'],
  ['E', 'W', 'S'],
  ['W', 'S', 'E'],
  ['W', 'E', 'S'],
];

describe('名次与升级', () => {
  it.each(REMAINING_AFTER_S)('头游 S、搭档 N 的名次决定升级：%s', (...rest) => {
    const second = rest[0] as Seat;
    const third = rest[1] as Seat;
    const last = rest[2] as Seat;
    const result = settle(['S', second, third, last]);
    const expected = second === 'N' ? 3 : third === 'N' ? 2 : 1;
    expect(result.upgrade).toBe(expected);
    expect(result.isDoubleDown).toBe(second === 'N');
  });

  it.each(REMAINING_AFTER_N)('头游 N、搭档 S 的名次决定升级：%s', (...rest) => {
    const second = rest[0] as Seat;
    const third = rest[1] as Seat;
    const last = rest[2] as Seat;
    const result = settle(['N', second, third, last]);
    const expected = second === 'S' ? 3 : third === 'S' ? 2 : 1;
    expect(result.upgrade).toBe(expected);
    expect(result.isDoubleDown).toBe(second === 'S');
  });

  it('升级超过 A 只升到 A', () => {
    const result = settle(['S', 'N', 'E', 'W'], { levels: { NS: 13, WE: 5 } });
    expect(result.levels.NS).toBe(14);
  });

  it('只有头游方升级，输方级数不变', () => {
    const result = settle(['E', 'W', 'S', 'N'], { levels: { NS: 9, WE: 5 } });
    expect(result.levels.WE).toBe(8);
    expect(result.levels.NS).toBe(9);
  });

  it('双下时下一副打赢家（台上）级数', () => {
    const result = settle(['S', 'N', 'E', 'W'], { levels: { NS: 5, WE: 3 }, currentLevelTeam: 'NS' });
    expect(result.currentLevelTeam).toBe('NS');
    expect(result.levels.NS).toBe(8);
  });

  it('台下赢下后成为新的台上', () => {
    const result = settle(['E', 'W', 'S', 'N'], { levels: { NS: 9, WE: 5 }, currentLevelTeam: 'NS' });
    expect(result.currentLevelTeam).toBe('WE');
  });
});

describe('过 A 判定', () => {
  it('打 A 一方头游且搭档二游，过 A', () => {
    const result = settle(['S', 'N', 'E', 'W'], { levels: { NS: 14, WE: 9 }, currentLevelTeam: 'NS' });
    expect(result.passA).toBe(true);
    expect(result.aFailed).toBe(false);
  });

  it('打 A 一方头游且搭档三游，过 A', () => {
    const result = settle(['S', 'E', 'N', 'W'], { levels: { NS: 14, WE: 9 }, currentLevelTeam: 'NS' });
    expect(result.passA).toBe(true);
  });

  it('打 A 一方头游但搭档末游，不算过 A', () => {
    const result = settle(['S', 'E', 'W', 'N'], { levels: { NS: 14, WE: 9 }, currentLevelTeam: 'NS' });
    expect(result.passA).toBe(false);
    expect(result.aFailed).toBe(true);
  });

  it('A 队是台下拿头游，不判过 A', () => {
    const result = settle(['E', 'W', 'S', 'N'], { levels: { NS: 14, WE: 12 }, currentLevelTeam: 'NS' });
    expect(result.passA).toBe(false);
    expect(result.aFailed).toBe(true);
    expect(result.levels.NS).toBe(14);
  });

  it('WE 打 A 且头游搭档二游，过 A', () => {
    const result = settle(['E', 'W', 'S', 'N'], { levels: { NS: 9, WE: 14 }, currentLevelTeam: 'WE' });
    expect(result.passA).toBe(true);
  });

  it('双方都到 A 时，只有本副打 A 的一方可能过 A', () => {
    const result = settle(['S', 'N', 'E', 'W'], { levels: { NS: 14, WE: 14 }, currentLevelTeam: 'NS' });
    expect(result.passA).toBe(true);
    expect(result.levels.WE).toBe(14);
  });

  it('打 A 失败会累计次数', () => {
    const result = settle(['S', 'E', 'W', 'N'], {
      levels: { NS: 14, WE: 9 },
      currentLevelTeam: 'NS',
      aFailCounts: { NS: 1, WE: 0 },
    });
    expect(result.aFailCounts.NS).toBe(2);
  });

  it('开启三次不过回 2 后，第三次打 A 失败降到 2', () => {
    const result = settle(['E', 'W', 'S', 'N'], {
      levels: { NS: 14, WE: 10 },
      currentLevelTeam: 'NS',
      aFailCounts: { NS: 2, WE: 0 },
      config: { aFailResetAfter3: true },
    });
    expect(result.levels.NS).toBe(2);
    expect(result.aFailCounts.NS).toBe(0);
  });

  it('默认不开启三次回 2，A 队继续保持 A', () => {
    const result = settle(['E', 'W', 'S', 'N'], {
      levels: { NS: 14, WE: 10 },
      currentLevelTeam: 'NS',
      aFailCounts: { NS: 2, WE: 0 },
    });
    expect(result.levels.NS).toBe(14);
    expect(result.aFailCounts.NS).toBe(3);
  });
});
