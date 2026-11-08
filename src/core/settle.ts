import type { Level, Seat, Team } from './types';
import type { RuleConfig } from './config';
import { partnerSeat, teamOf } from './cards';

export interface SettlementInput {
  levels: Record<Team, Level>;
  currentLevelTeam: Team;
  outOrder: Record<Seat, number | null>;
  headSeat: Seat;
  secondSeat: Seat | null;
  config: RuleConfig;
  aFailCounts: Record<Team, number>;
}

export interface SettlementResult {
  levels: Record<Team, Level>;
  currentLevelTeam: Team;
  /** 3=双下、2=头游+三游、1=头游+末游。 */
  upgrade: number;
  isDoubleDown: boolean;
  passA: boolean;
  aFailed: boolean;
  aFailCounts: Record<Team, number>;
}

const A_LEVEL = 14;

/** 找出名次为 place 的座位。 */
export function seatByPlace(outOrder: Record<Seat, number | null>, place: number): Seat | null {
  for (const seat of Object.keys(outOrder) as Seat[]) {
    if (outOrder[seat] === place) return seat;
  }
  return null;
}

/**
 * 一副牌结束后的名次/升级/过 A 判定。
 *
 * 关键口径（docs/掼蛋规则汇总.md §6）：
 * - 只有头游方升级；升级数由头游搭档名次决定。
 * - 打 A 的一方（本副 currentLevelTeam）头游且搭档不是末游，才过 A。
 * - A 队是台下拿头游不判过 A，只按自身级数升级并成为下一副台上。
 * - 升级超过 A 只到 A。
 */
export function settleRound(input: SettlementInput): SettlementResult {
  const { levels, currentLevelTeam, outOrder, headSeat, secondSeat, config, aFailCounts } = input;
  const levelAtStart = levels[currentLevelTeam];
  const winnerTeam = teamOf(headSeat);
  const thirdSeat = seatByPlace(outOrder, 3);
  const lastSeat = seatByPlace(outOrder, 4);
  const partnerPlace = outOrder[partnerSeat(headSeat)];

  const isDoubleDown = secondSeat !== null && teamOf(secondSeat) === winnerTeam;
  let upgrade = 1;
  if (isDoubleDown) upgrade = 3;
  else if (thirdSeat !== null && teamOf(thirdSeat) === winnerTeam) upgrade = 2;

  // 「打 A 的一方」= 本副开始时的 currentLevelTeam；必须该队头游，且搭档不是末游。
  const passA =
    levelAtStart === A_LEVEL &&
    winnerTeam === currentLevelTeam &&
    partnerPlace !== null &&
    partnerPlace !== 4 &&
    secondSeat !== null;

  const aFailed = levelAtStart === A_LEVEL && !passA;

  const nextLevels: Record<Team, Level> = { ...levels };
  nextLevels[winnerTeam] = Math.min(A_LEVEL, nextLevels[winnerTeam] + upgrade) as Level;

  const nextFailCounts: Record<Team, number> = { ...aFailCounts };
  if (aFailed) {
    nextFailCounts[currentLevelTeam] += 1;
    if (config.aFailResetAfter3 && nextFailCounts[currentLevelTeam] >= 3) {
      // 规则文档 §6.5 / D01：三次打 A 不过回 2。文档未明确「连续 vs 累计」，
      // 这里按保守的「一场内累计」实现；该口径由 aFailResetAfter3 开关控制，默认关闭。
      nextLevels[currentLevelTeam] = 2;
      nextFailCounts[currentLevelTeam] = 0;
    }
  }

  return {
    levels: nextLevels,
    currentLevelTeam: winnerTeam,
    upgrade,
    isDoubleDown,
    passA,
    aFailed,
    aFailCounts: nextFailCounts,
  };
}

export function otherTeam(team: Team): Team {
  return team === 'NS' ? 'WE' : 'NS';
}
