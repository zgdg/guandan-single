import type { Card, Level, NormalRank, Pattern, Rank, Suit, WildAssignment, PatternSelector } from './types';
import type { RuleConfig } from './config';
import { bombPowerRank, isWildcard, powerRank } from './cards';

type RankPower = (rank: NormalRank) => number;

function makeRankPower(level: Level): RankPower {
  return (rank) => (rank === level ? 98 : rank);
}

function wildAssignments(cards: Card[], targets: Array<{ rank: NormalRank; suit?: Suit }>): WildAssignment[] {
  return cards.map((card, index) => {
    const target = targets[index]!;
    const assignment: WildAssignment = { cardId: card.id, asRank: target.rank };
    if (target.suit) assignment.asSuit = target.suit;
    return assignment;
  });
}

function basePattern(
  type: Pattern['type'],
  cards: Card[],
  mainRank: number,
  extra: Partial<Pattern> = {},
): Pattern {
  return {
    type,
    cards,
    count: cards.length,
    mainRank,
    bombTier: 0,
    wildAssignments: [],
    ...extra,
  };
}

function natural(cards: Card[], level: Level, config: RuleConfig): Card[] {
  return cards.filter((card) => !isWildcard(card, level, config));
}

function wilds(cards: Card[], level: Level, config: RuleConfig): Card[] {
  return cards.filter((card) => isWildcard(card, level, config));
}

function isJoker(card: Card): boolean {
  return card.rank === 15 || card.rank === 16;
}

function countByRank(cards: Card[]): Map<Rank, number> {
  const counts = new Map<Rank, number>();
  for (const card of cards) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  return counts;
}

/**
 * A 在连续牌型中的位置：low=1 时作 1（位置 0）；窗口顶端为 14 时作 14（最后一位）。
 * 其它窗口不允许 A，且不允许 K-A-2 绕圈。
 */
function aPosition(rank: Rank, low: number, length: number): number | null {
  const top = low + length - 1;
  if (rank === 14) {
    if (low === 1) return 0;
    if (top === 14) return length - 1;
    return null;
  }
  if (rank >= low && rank <= top) return rank - low;
  return null;
}

function rankAtPosition(low: number, position: number): NormalRank {
  const value = low + position;
  return value === 1 ? 14 : (value as NormalRank);
}

function detectSingle(cards: Card[], level: Level): Pattern[] {
  if (cards.length !== 1) return [];
  return [basePattern('SINGLE', cards, powerRank(cards[0]!, level))];
}

function detectPair(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length !== 2) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  const power = makeRankPower(level);

  if (w.length === 0) {
    if (nat.length !== 2) return [];
    if (nat[0]!.rank !== nat[1]!.rank) return [];
    // 一大王 + 一小王不是对子；同点王（两大/两小）合法。
    return [basePattern('PAIR', cards, powerRank(nat[0]!, level))];
  }
  if (w.length === 1) {
    if (nat.length !== 1 || isJoker(nat[0]!)) return [];
    const rank = nat[0]!.rank as NormalRank;
    return [
      basePattern('PAIR', cards, power(rank), {
        wildAssignments: wildAssignments(w, [{ rank }]),
      }),
    ];
  }
  // 两张逢人配单独成对；可声明为任意 2–14 的牌点，默认取牌力最高的级牌解释。
  if (w.length === 2 && config.wildcardPairAlone) {
    const results: Pattern[] = [];
    for (let rank = 2; rank <= 14; rank += 1) {
      const r = rank as NormalRank;
      results.push(
        basePattern('PAIR', cards, power(r), {
          wildAssignments: wildAssignments(w, [
            { rank: r },
            { rank: r },
          ]),
        }),
      );
    }
    return results;
  }
  return [];
}

function detectTriple(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length !== 3) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  if (nat.length === 0) return [];
  const rank = nat[0]!.rank;
  if (isJoker(nat[0]!)) return [];
  if (nat.some((card) => card.rank !== rank)) return [];
  const assignments = wildAssignments(w, w.map(() => ({ rank: rank as NormalRank })));
  return [
    basePattern('TRIPLE', cards, makeRankPower(level)(rank as NormalRank), {
      wildAssignments: assignments,
    }),
  ];
}

function detectFullHouse(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length !== 5) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  if (nat.length === 0) return [];
  const counts = countByRank(nat);
  const results: Pattern[] = [];
  const totalNatural = nat.length;

  // 官方默认：三同张 + 一对（对子可为两大王/两小王）。
  for (let t = 2; t <= 14; t += 1) {
    const tripleRank = t as NormalRank;
    const ct = counts.get(tripleRank) ?? 0;
    if (ct > 3) continue;
    for (let p = 2; p <= 14; p += 1) {
      if (p === t) continue;
      const pairRank = p as NormalRank;
      const cp = counts.get(pairRank) ?? 0;
      if (cp > 2) continue;
      if (ct + cp !== totalNatural) continue;
      const deficits = 3 - ct + (2 - cp);
      if (deficits !== w.length) continue;
      const targets = [
        ...Array.from({ length: 3 - ct }, () => ({ rank: tripleRank })),
        ...Array.from({ length: 2 - cp }, () => ({ rank: pairRank })),
      ];
      results.push(
        basePattern('FULL_HOUSE', cards, makeRankPower(level)(tripleRank), {
          tripleRank,
          pairRank,
          variant: 'pair',
          wildAssignments: wildAssignments(w, targets),
        }),
      );
    }
    // 对子为两张王：必须是同点两张，逢人配不能当王。
    for (const jokerRank of [15, 16] as const) {
      const cp = counts.get(jokerRank) ?? 0;
      if (cp !== 2) continue;
      const ct = counts.get(tripleRank) ?? 0;
      if (ct > 3) continue;
      if (ct + 2 !== totalNatural) continue;
      if (3 - ct !== w.length) continue;
      results.push(
        basePattern('FULL_HOUSE', cards, makeRankPower(level)(tripleRank), {
          tripleRank,
          pairRank: jokerRank,
          variant: 'pair',
          wildAssignments: wildAssignments(
            w,
            Array.from({ length: 3 - ct }, () => ({ rank: tripleRank })),
          ),
        }),
      );
    }
  }

  // 可配置变体：三同张 + 两张不同单牌（D09 默认关闭）。
  if (config.allowTripleWithTwoSingles) {
    for (let t = 2; t <= 14; t += 1) {
      const tripleRank = t as NormalRank;
      const ct = counts.get(tripleRank) ?? 0;
      if (ct > 3) continue;
      const others = [...counts.entries()].filter(([rank]) => rank !== t && rank !== 15 && rank !== 16);
      if (others.length !== 2) continue;
      if (others.some(([, count]) => count !== 1)) continue;
      if (ct + 2 !== totalNatural) continue;
      if (3 - ct !== w.length) continue;
      results.push(
        basePattern('FULL_HOUSE', cards, makeRankPower(level)(tripleRank), {
          tripleRank,
          variant: 'twoSingles',
          wildAssignments: wildAssignments(
            w,
            Array.from({ length: 3 - ct }, () => ({ rank: tripleRank })),
          ),
        }),
      );
    }
  }

  return results;
}

interface SequenceCandidate {
  low: number;
  length: number;
  requirement: number;
}

function sequenceWindows(length: number): SequenceCandidate[] {
  // 长 5 时 low 1..10；长 3 时 1..12；长 2 时 1..13。A 只能在 low=1 或顶端=14 时参与。
  const maxLow = 15 - length;
  const windows: SequenceCandidate[] = [];
  for (let low = 1; low <= maxLow; low += 1) {
    windows.push({ low, length, requirement: 1 });
  }
  return windows;
}

function detectStraightLike(
  cards: Card[],
  level: Level,
  config: RuleConfig,
  type: 'STRAIGHT' | 'STRAIGHT_FLUSH',
): Pattern[] {
  if (cards.length !== 5) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  if (nat.some(isJoker)) return [];
  if (type === 'STRAIGHT_FLUSH' && w.length > 0 && !config.wildcardCanFillStraightFlush) return [];

  const suits = new Set(nat.map((card) => card.suit));
  if (type === 'STRAIGHT_FLUSH' && suits.size > 1) return [];
  const suit = type === 'STRAIGHT_FLUSH' ? (nat[0]?.suit as Suit | undefined) : undefined;
  if (type === 'STRAIGHT_FLUSH' && !suit) return [];

  // 纯天然同花顺不再返回普通顺子解释；带逢人配时两种解释都保留，交由声明层选择。
  if (type === 'STRAIGHT' && w.length === 0 && suits.size === 1) return [];

  const results: Pattern[] = [];
  for (const window of sequenceWindows(5)) {
    const positions = new Map<number, Card>();
    let valid = true;
    for (const card of nat) {
      if (type === 'STRAIGHT_FLUSH' && card.suit !== suit) {
        valid = false;
        break;
      }
      const pos = aPosition(card.rank, window.low, 5);
      if (pos === null || positions.has(pos)) {
        valid = false;
        break;
      }
      positions.set(pos, card);
    }
    if (!valid) continue;
    const missing: number[] = [];
    for (let pos = 0; pos < 5; pos += 1) {
      if (!positions.has(pos)) missing.push(pos);
    }
    if (missing.length !== w.length) continue;
    const targets = missing.map((pos) => ({
      rank: rankAtPosition(window.low, pos),
      ...(type === 'STRAIGHT_FLUSH' && suit ? { suit } : {}),
    }));
    const mainRank = window.low + 4;
    results.push(
      type === 'STRAIGHT'
        ? basePattern('STRAIGHT', cards, mainRank, {
            sequenceLow: window.low,
            wildAssignments: wildAssignments(w, targets),
          })
        : basePattern('STRAIGHT_FLUSH', cards, mainRank, {
            sequenceLow: window.low,
            suit,
            bombTier: 3,
            wildAssignments: wildAssignments(w, targets),
          }),
    );
  }
  return results;
}

function detectTube(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length !== 6) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  if (nat.some(isJoker)) return [];
  const counts = countByRank(nat);
  if ([...counts.values()].some((count) => count > 2)) return [];
  const results: Pattern[] = [];
  for (const window of sequenceWindows(3)) {
    const naturalPositions: number[] = [];
    let valid = true;
    for (const card of nat) {
      const pos = aPosition(card.rank, window.low, 3);
      if (pos === null) {
        valid = false;
        break;
      }
      naturalPositions.push(pos);
    }
    if (!valid) continue;
    const perPos = [0, 0, 0];
    for (const pos of naturalPositions) perPos[pos] = (perPos[pos] ?? 0) + 1;
    if (perPos.some((count) => count > 2)) continue;
    const deficits = perPos.reduce((sum, count) => sum + (2 - count), 0);
    if (deficits !== w.length) continue;
    const targets = perPos.flatMap((count, pos) =>
      Array.from({ length: 2 - count }, () => ({ rank: rankAtPosition(window.low, pos) })),
    );
    results.push(
      basePattern('TUBE', cards, window.low + 2, {
        sequenceLow: window.low,
        wildAssignments: wildAssignments(w, targets),
      }),
    );
  }
  return results;
}

function detectPlate(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length !== 6) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  if (nat.some(isJoker)) return [];
  const counts = countByRank(nat);
  if ([...counts.values()].some((count) => count > 3)) return [];
  const results: Pattern[] = [];
  for (const window of sequenceWindows(2)) {
    const perPos = [0, 0];
    let valid = true;
    for (const card of nat) {
      const pos = aPosition(card.rank, window.low, 2);
      if (pos === null) {
        valid = false;
        break;
      }
      perPos[pos] = (perPos[pos] ?? 0) + 1;
    }
    if (!valid) continue;
    if (perPos.some((count) => count > 3)) continue;
    const deficits = perPos.reduce((sum, count) => sum + (3 - count), 0);
    if (deficits !== w.length) continue;
    const targets = perPos.flatMap((count, pos) =>
      Array.from({ length: 3 - count }, () => ({ rank: rankAtPosition(window.low, pos) })),
    );
    results.push(
      basePattern('PLATE', cards, window.low + 1, {
        sequenceLow: window.low,
        wildAssignments: wildAssignments(w, targets),
      }),
    );
  }
  return results;
}

function detectBomb(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length < 4 || cards.length > config.maxBombCards) return [];
  const nat = natural(cards, level, config);
  const w = wilds(cards, level, config);
  if (nat.length === 0) return [];
  if (nat.some(isJoker)) return [];
  const rank = nat[0]!.rank;
  if (nat.some((card) => card.rank !== rank)) return [];
  const assignments = wildAssignments(w, w.map(() => ({ rank: rank as NormalRank })));
  const tier: Pattern['bombTier'] = cards.length >= 6 ? 4 : cards.length === 5 ? 2 : 1;
  return [
    basePattern('BOMB', cards, bombPowerRank(nat[0]!, level, config), {
      bombTier: tier,
      wildAssignments: assignments,
    }),
  ];
}

function detectKingBomb(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length !== 4) return [];
  const nat = natural(cards, level, config);
  if (nat.length !== 4) return [];
  const counts = countByRank(nat);
  if ((counts.get(16) ?? 0) !== 2 || (counts.get(15) ?? 0) !== 2) return [];
  return [basePattern('KING_BOMB', cards, 200, { bombTier: 5 })];
}

function wildKey(pattern: Pattern): string {
  return pattern.wildAssignments
    .map((assignment) => `${assignment.cardId}:${assignment.asRank}:${assignment.asSuit ?? ''}`)
    .sort()
    .join(',');
}

function patternKey(pattern: Pattern): string {
  return [
    pattern.type,
    pattern.count,
    pattern.mainRank,
    pattern.sequenceLow ?? '',
    pattern.suit ?? '',
    pattern.tripleRank ?? '',
    pattern.pairRank ?? '',
    pattern.variant ?? '',
    pattern.bombTier,
    pattern.cards.map((card) => card.id).sort().join('+'),
    wildKey(pattern),
  ].join('|');
}

/** 由强到弱排序，仅用于展示候选解释顺序；不代表引擎会自动选最强。 */
export function patternStrength(a: Pattern, b: Pattern): number {
  if (a.bombTier !== b.bombTier) return b.bombTier - a.bombTier;
  if (a.type === 'BOMB' && b.type === 'BOMB' && a.count !== b.count) return b.count - a.count;
  return b.mainRank - a.mainRank;
}

/**
 * 识别一组牌的所有合法解释。
 * - 返回多解释时，调用方（UI/引擎）必须要求声明或显式选择一种。
 * - 不擅自替用户选「最强解释」。
 */
export function recognize(cards: Card[], level: Level, config: RuleConfig): Pattern[] {
  if (cards.length === 0) return [];
  if (cards.some((card) => card.rank < 2)) return [];
  const ids = new Set(cards.map((card) => card.id));
  if (ids.size !== cards.length) {
    throw new Error('E_DUPLICATE_CARD: 同一张牌被重复使用');
  }

  const results: Pattern[] = [
    ...detectSingle(cards, level),
    ...detectPair(cards, level, config),
    ...detectTriple(cards, level, config),
    ...detectFullHouse(cards, level, config),
    ...detectStraightLike(cards, level, config, 'STRAIGHT'),
    ...detectStraightLike(cards, level, config, 'STRAIGHT_FLUSH'),
    ...detectTube(cards, level, config),
    ...detectPlate(cards, level, config),
    ...detectBomb(cards, level, config),
    ...detectKingBomb(cards, level, config),
  ];

  const seen = new Set<string>();
  const deduped: Pattern[] = [];
  for (const pattern of results) {
    const key = patternKey(pattern);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(pattern);
    }
  }
  return deduped.sort(patternStrength);
}

/** 两个解释在牌型比较上完全等价（同一批牌、同类型、同主牌、同连牌起点/花色）。 */
function samePlayShape(left: Pattern, right: Pattern): boolean {
  if (left.type !== right.type || left.mainRank !== right.mainRank || left.bombTier !== right.bombTier) {
    return false;
  }
  if ((left.sequenceLow ?? -1) !== (right.sequenceLow ?? -1)) return false;
  if ((left.suit ?? '') !== (right.suit ?? '')) return false;
  if ((left.tripleRank ?? -1) !== (right.tripleRank ?? -1)) return false;
  if ((left.variant ?? '') !== (right.variant ?? '')) return false;
  if (left.cards.length !== right.cards.length) return false;
  const ids = new Set(left.cards.map((card) => card.id));
  return right.cards.every((card) => ids.has(card.id));
}

/** 按声明筛选解释；声明字段只比较已提供的项。 */
export function selectPattern(
  candidates: Pattern[],
  selector?: PatternSelector,
): Pattern | undefined {
  if (!selector) return candidates.length === 1 ? candidates[0] : undefined;
  const matched = candidates.filter((pattern) => {
    if (pattern.type !== selector.type) return false;
    if (selector.sequenceLow !== undefined && pattern.sequenceLow !== selector.sequenceLow) return false;
    if (selector.suit !== undefined && pattern.suit !== selector.suit) return false;
    if (selector.tripleRank !== undefined && pattern.tripleRank !== selector.tripleRank) return false;
    if (selector.rank !== undefined) {
      if (pattern.type === 'SINGLE' || pattern.type === 'PAIR' || pattern.type === 'TRIPLE') {
        // mainRank 已含级牌提升，不能直接与自然牌点比较；用牌面/逢人配声明反查。
        // 有逢人配时必须按声明反查，否则两张逢人配会因牌面本身就是级牌而匹配所有解释。
        if (pattern.wildAssignments.length > 0) {
          return pattern.wildAssignments.some((assignment) => assignment.asRank === selector.rank);
        }
        return (
          pattern.cards.some((card) => card.rank === selector.rank) ||
          pattern.mainRank === selector.rank
        );
      }
      if (pattern.type === 'BOMB') {
        const naturalRankMatches = pattern.cards.some((card) => card.rank === selector.rank);
        const wildMatches = pattern.wildAssignments.some(
          (assignment) => assignment.asRank === selector.rank,
        );
        return naturalRankMatches || wildMatches;
      }
    }
    return true;
  });
  if (matched.length === 1) return matched[0];
  // 三带对的两张逢人配做对子时，pairRank 有多种等价解释；比较口径相同则任取其一，
  // 否则 AI 会因为「无法唯一声明」而打不出这手合法牌。
  if (matched.length > 1 && matched.every((pattern) => samePlayShape(pattern, matched[0]!))) {
    return matched[0];
  }
  return undefined;
}
