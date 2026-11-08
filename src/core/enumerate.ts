import type {
  Card,
  Level,
  NormalRank,
  Pattern,
  PatternType,
  PlayOption,
  Suit,
  WildAssignment,
} from './types';
import type { RuleConfig } from './config';
import { bombPowerRank, groupByRank, isWildcard, powerRank } from './cards';
import { beats } from './compare';

interface HandIndex {
  byRank: Map<number, Card[]>;
  wilds: Card[];
}

interface Requirement {
  rank: NormalRank;
  count: number;
  natural: Card[];
  allowWild: boolean;
  suit?: Suit;
}

interface Selection {
  cards: Card[];
  wildAssignments: WildAssignment[];
  usedWilds: Card[];
}

function indexHand(hand: Card[], level: Level, config: RuleConfig): HandIndex {
  const wilds = hand.filter((card) => isWildcard(card, level, config));
  const naturals = hand.filter((card) => !isWildcard(card, level, config));
  const groups = groupByRank(naturals);
  const byRank = new Map<number, Card[]>();
  for (const [rank, cards] of groups) byRank.set(rank, cards);
  return { byRank, wilds };
}

function combinations<T>(items: T[], k: number, cap: number): T[][] {
  if (k === 0) return [[]];
  if (k > items.length || cap <= 0) return [];
  const results: T[][] = [];
  const pick = (start: number, chosen: T[]): void => {
    if (results.length >= cap) return;
    if (chosen.length === k) {
      results.push([...chosen]);
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      if (results.length >= cap) return;
      chosen.push(items[i]!);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return results;
}

/**
 * 按需求生成牌张组合。
 * 枚举策略：逢人配只用于补缺口，不做「有自然牌却用逢人配替代」的冗余解释。
 * 这能覆盖实战中的全部有效打法，并显著控制组合爆炸；该策略在规划 5.4 的枚举上限内可回退。
 */
function generateSelections(reqs: Requirement[], wilds: Card[], cap: number): Selection[] {
  const deficits: number[] = [];
  let totalDeficit = 0;
  for (const req of reqs) {
    const natCount = Math.min(req.count, req.natural.length);
    const deficit = req.count - natCount;
    if (deficit > 0 && !req.allowWild) return [];
    deficits.push(deficit);
    totalDeficit += deficit;
  }
  if (totalDeficit > wilds.length) return [];
  if (totalDeficit > cap) return [];

  const wildSubsets = combinations(wilds, totalDeficit, cap);
  if (wildSubsets.length === 0) return [];

  const naturalCombos: Card[][][] = [];
  for (const req of reqs) {
    const natCount = Math.min(req.count, req.natural.length);
    const combos = combinations(req.natural, natCount, cap);
    if (combos.length === 0) return [];
    naturalCombos.push(combos);
  }

  const results: Selection[] = [];
  const chosenNaturals: Card[][] = [];

  const build = (): void => {
    if (results.length >= cap) return;
    for (const wildSubset of wildSubsets) {
      let wildIndex = 0;
      const assignments: WildAssignment[] = [];
      for (let i = 0; i < reqs.length; i += 1) {
        const req = reqs[i]!;
        for (let d = 0; d < deficits[i]!; d += 1) {
          const wild = wildSubset[wildIndex]!;
          const assignment: WildAssignment = { cardId: wild.id, asRank: req.rank };
          if (req.suit) assignment.asSuit = req.suit;
          assignments.push(assignment);
          wildIndex += 1;
        }
      }
      const cards = [...chosenNaturals.flat(), ...wildSubset];
      results.push({ cards, wildAssignments: assignments, usedWilds: wildSubset });
      if (results.length >= cap) return;
    }
  };

  const recurse = (index: number): void => {
    if (results.length >= cap) return;
    if (index === reqs.length) {
      build();
      return;
    }
    const combos = naturalCombos[index]!;
    for (const combo of combos) {
      if (results.length >= cap) return;
      chosenNaturals.push(combo);
      recurse(index + 1);
      chosenNaturals.pop();
    }
  };
  recurse(0);
  return results;
}

function makePattern(
  type: PatternType,
  cards: Card[],
  mainRank: number,
  assignments: WildAssignment[],
  extra: Partial<Pattern> = {},
): Pattern {
  return {
    type,
    cards,
    count: cards.length,
    mainRank,
    bombTier: 0,
    wildAssignments: assignments,
    ...extra,
  };
}

function rankPower(rank: NormalRank, level: Level): number {
  return rank === level ? 98 : rank;
}

function requirement(
  byRank: Map<number, Card[]>,
  rank: NormalRank,
  count: number,
  options: { allowWild?: boolean; suit?: Suit } = {},
): Requirement {
  let natural = byRank.get(rank) ?? [];
  if (options.suit) natural = natural.filter((card) => card.suit === options.suit);
  return {
    rank,
    count,
    natural,
    allowWild: options.allowWild ?? true,
    ...(options.suit ? { suit: options.suit } : {}),
  };
}

function addPatterns(
  target: PlayOption[],
  patterns: Pattern[],
  cap: number,
  seen: Set<string>,
): void {
  for (const pattern of patterns) {
    if (target.length >= cap) return;
    const key = [
      pattern.type,
      pattern.cards.map((card) => card.id).sort().join('+'),
      pattern.sequenceLow ?? '',
      pattern.suit ?? '',
      pattern.mainRank,
      pattern.tripleRank ?? '',
      pattern.pairRank ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    target.push({ pattern, cards: pattern.cards });
  }
}

function generateSingles(hand: Card[], level: Level, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (const card of hand) {
    patterns.push(makePattern('SINGLE', [card], powerRank(card, level), []));
  }
  return patterns;
}

function generatePairs(index: HandIndex, level: Level, config: RuleConfig, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let rank = 2; rank <= 14; rank += 1) {
    const req = requirement(index.byRank, rank as NormalRank, 2);
    for (const selection of generateSelections([req], index.wilds, cap)) {
      // D08：关闭 wildcardPairAlone 时，两张逢人配不能单独成对。
      if (
        !config.wildcardPairAlone &&
        selection.cards.length === 2 &&
        selection.cards.every((card) => isWildcard(card, level, config))
      ) {
        continue;
      }
      patterns.push(
        makePattern('PAIR', selection.cards, rankPower(rank as NormalRank, level), selection.wildAssignments),
      );
      if (patterns.length >= cap) return patterns;
    }
  }
  for (const rank of [15, 16] as const) {
    const req = requirement(index.byRank, rank as unknown as NormalRank, 2, { allowWild: false });
    for (const selection of generateSelections([req], index.wilds, cap)) {
      patterns.push(makePattern('PAIR', selection.cards, powerRank(selection.cards[0]!, level), selection.wildAssignments));
      if (patterns.length >= cap) return patterns;
    }
  }
  if (config.wildcardPairAlone && index.wilds.length >= 2) {
    const req: Requirement = { rank: level, count: 2, natural: [], allowWild: true };
    for (const selection of generateSelections([req], index.wilds, cap)) {
      patterns.push(makePattern('PAIR', selection.cards, rankPower(level, level), selection.wildAssignments));
      if (patterns.length >= cap) return patterns;
    }
  }
  return patterns;
}

function generateTriples(index: HandIndex, level: Level, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let rank = 2; rank <= 14; rank += 1) {
    const req = requirement(index.byRank, rank as NormalRank, 3);
    for (const selection of generateSelections([req], index.wilds, cap)) {
      patterns.push(
        makePattern('TRIPLE', selection.cards, rankPower(rank as NormalRank, level), selection.wildAssignments),
      );
      if (patterns.length >= cap) return patterns;
    }
  }
  return patterns;
}

function generateFullHouses(index: HandIndex, level: Level, config: RuleConfig, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let t = 2; t <= 14; t += 1) {
    const tripleRank = t as NormalRank;
    for (let p = 2; p <= 14; p += 1) {
      if (p === t) continue;
      const pairRank = p as NormalRank;
      const reqs = [
        requirement(index.byRank, tripleRank, 3),
        requirement(index.byRank, pairRank, 2),
      ];
      for (const selection of generateSelections(reqs, index.wilds, cap)) {
        patterns.push(
          makePattern('FULL_HOUSE', selection.cards, rankPower(tripleRank, level), selection.wildAssignments, {
            tripleRank,
            pairRank,
            variant: 'pair',
          }),
        );
        if (patterns.length >= cap) return patterns;
      }
    }
    for (const jokerRank of [15, 16] as const) {
      const reqs = [
        requirement(index.byRank, tripleRank, 3),
        requirement(index.byRank, jokerRank as unknown as NormalRank, 2, { allowWild: false }),
      ];
      for (const selection of generateSelections(reqs, index.wilds, cap)) {
        patterns.push(
          makePattern('FULL_HOUSE', selection.cards, rankPower(tripleRank, level), selection.wildAssignments, {
            tripleRank,
            pairRank: jokerRank,
            variant: 'pair',
          }),
        );
        if (patterns.length >= cap) return patterns;
      }
    }
  }
  return patterns;
}

function sequenceReq(
  index: HandIndex,
  low: number,
  countPerRank: number,
  position: number,
  options: { suit?: Suit } = {},
): Requirement {
  const rank = rankAt(low, position);
  return requirement(index.byRank, rank, countPerRank, options);
}

function rankAt(low: number, position: number): NormalRank {
  const value = low + position;
  return value === 1 ? 14 : (value as NormalRank);
}

function generateStraights(index: HandIndex, level: Level, config: RuleConfig, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let low = 1; low <= 10; low += 1) {
    const reqs = [0, 1, 2, 3, 4].map((pos) => sequenceReq(index, low, 1, pos));
    for (const selection of generateSelections(reqs, index.wilds, cap)) {
      const naturalSuits = new Set(selection.cards.filter((card) => !isWildcard(card, level, config)).map((card) => card.suit));
      // 纯天然同花顺只按同花顺解释，不再提供普通顺子解释（与识别层一致）。
      if (selection.usedWilds.length === 0 && naturalSuits.size === 1) continue;
      patterns.push(
        makePattern('STRAIGHT', selection.cards, low + 4, selection.wildAssignments, { sequenceLow: low }),
      );
      if (patterns.length >= cap) return patterns;
    }
  }
  return patterns;
}

function generateStraightFlushes(
  index: HandIndex,
  level: Level,
  config: RuleConfig,
  cap: number,
): Pattern[] {
  const patterns: Pattern[] = [];
  const suits: Suit[] = ['S', 'H', 'C', 'D'];
  for (const suit of suits) {
    for (let low = 1; low <= 10; low += 1) {
      const reqs = [0, 1, 2, 3, 4].map((pos) => sequenceReq(index, low, 1, pos, { suit }));
      for (const selection of generateSelections(reqs, index.wilds, cap)) {
        if (selection.usedWilds.length > 0 && !config.wildcardCanFillStraightFlush) continue;
        patterns.push(
          makePattern('STRAIGHT_FLUSH', selection.cards, low + 4, selection.wildAssignments, {
            sequenceLow: low,
            suit,
            bombTier: 3,
          }),
        );
        if (patterns.length >= cap) return patterns;
      }
    }
  }
  return patterns;
}

function generateTubes(index: HandIndex, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let low = 1; low <= 12; low += 1) {
    const reqs = [0, 1, 2].map((pos) => sequenceReq(index, low, 2, pos));
    for (const selection of generateSelections(reqs, index.wilds, cap)) {
      patterns.push(makePattern('TUBE', selection.cards, low + 2, selection.wildAssignments, { sequenceLow: low }));
      if (patterns.length >= cap) return patterns;
    }
  }
  return patterns;
}

function generatePlates(index: HandIndex, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let low = 1; low <= 13; low += 1) {
    const reqs = [0, 1].map((pos) => sequenceReq(index, low, 3, pos));
    for (const selection of generateSelections(reqs, index.wilds, cap)) {
      patterns.push(makePattern('PLATE', selection.cards, low + 1, selection.wildAssignments, { sequenceLow: low }));
      if (patterns.length >= cap) return patterns;
    }
  }
  return patterns;
}

function generateBombs(index: HandIndex, level: Level, config: RuleConfig, cap: number): Pattern[] {
  const patterns: Pattern[] = [];
  for (let rank = 2; rank <= 14; rank += 1) {
    for (let count = 4; count <= config.maxBombCards; count += 1) {
      const req = requirement(index.byRank, rank as NormalRank, count);
      for (const selection of generateSelections([req], index.wilds, cap)) {
        const firstNatural = selection.cards.find((card) => !isWildcard(card, level, config));
        if (!firstNatural) continue;
        const tier: Pattern['bombTier'] = count >= 6 ? 4 : count === 5 ? 2 : 1;
        patterns.push(
          makePattern('BOMB', selection.cards, bombPowerRank(firstNatural, level, config), selection.wildAssignments, {
            bombTier: tier,
          }),
        );
        if (patterns.length >= cap) return patterns;
      }
    }
  }
  return patterns;
}

function generateKingBomb(index: HandIndex): Pattern[] {
  const big = index.byRank.get(16) ?? [];
  const small = index.byRank.get(15) ?? [];
  if (big.length < 2 || small.length < 2) return [];
  return [
    makePattern('KING_BOMB', [big[0]!, big[1]!, small[0]!, small[1]!], 200, [], {
      bombTier: 5,
    }),
  ];
}

const NORMAL_COUNTS: Partial<Record<PatternType, number>> = {
  SINGLE: 1,
  PAIR: 2,
  TRIPLE: 3,
  FULL_HOUSE: 5,
  STRAIGHT: 5,
  TUBE: 6,
  PLATE: 6,
};

export interface EnumerateResult {
  options: PlayOption[];
  truncated: boolean;
}

/**
 * 枚举当前手牌的所有合法出牌（不含过牌，过牌由状态机按轮次规则追加）。
 * @param lastPattern 本圈上一手；null 表示由该玩家领出。
 */
export function enumerateLegalPlays(
  hand: Card[],
  level: Level,
  config: RuleConfig,
  lastPattern: Pattern | null = null,
): EnumerateResult {
  const index = indexHand(hand, level, config);
  const cap = config.maxCandidates;
  const target: PlayOption[] = [];
  const seen = new Set<string>();
  let truncated = false;

  const wants = (type: PatternType): boolean => {
    if (!lastPattern) return true;
    if (type === 'BOMB' || type === 'STRAIGHT_FLUSH' || type === 'KING_BOMB') return true;
    return type === lastPattern.type;
  };

  const add = (patterns: Pattern[]): void => {
    if (target.length >= cap) {
      truncated = true;
      return;
    }
    addPatterns(target, patterns, cap, seen);
    if (target.length >= cap) truncated = true;
  };

  // 炸弹优先，避免枚举截断时丢掉关键控场手段。
  if (wants('KING_BOMB')) add(generateKingBomb(index));
  if (wants('BOMB')) add(generateBombs(index, level, config, cap));
  if (wants('STRAIGHT_FLUSH')) add(generateStraightFlushes(index, level, config, cap));
  if (wants('SINGLE')) add(generateSingles(hand, level, cap));
  if (wants('PAIR')) add(generatePairs(index, level, config, cap));
  if (wants('TRIPLE')) add(generateTriples(index, level, cap));
  if (wants('FULL_HOUSE')) add(generateFullHouses(index, level, config, cap));
  if (wants('STRAIGHT')) add(generateStraights(index, level, config, cap));
  if (wants('TUBE')) add(generateTubes(index, cap));
  if (wants('PLATE')) add(generatePlates(index, cap));

  const filtered = lastPattern
    ? target.filter((option) => beats(option.pattern, lastPattern, config))
    : target;

  // 跟牌时同类型同张数的约束已在生成时限定；但仍用 beats 复核，保证比较器是唯一真相。
  return { options: filtered, truncated };
}
