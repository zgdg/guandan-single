import type {
  Card,
  EngineAction,
  GameState,
  Level,
  Pattern,
  PatternSelector,
  Phase,
  PlayCheck,
  PlayErrorCode,
  PlayRecord,
  ReplayEvent,
  RoundResult,
  Seat,
  Team,
  TrickState,
} from './types';
import { SEAT_ORDER_CCW } from './types';
import type { RuleConfig } from './config';
import { RULE_VERSION, assertSupportedConfig } from './config';
import {
  createDeck,
  createRng,
  isWildcard,
  nextSeat,
  partnerSeat,
  playOrder,
  powerRank,
  shuffle,
  sortHand,
  teamOf,
} from './cards';
import { recognize, selectPattern } from './patterns';
import { beats } from './compare';
import { enumerateLegalPlays, type EnumerateResult } from './enumerate';
import {
  legalReturnCards,
  maxTributeCards,
  planTribute,
  resolveTributeLeader,
} from './tribute';
import { settleRound } from './settle';

export interface EngineOptions {
  /** 模拟时关闭事件日志，避免 O(n²) 拷贝；默认开启。 */
  recordEvents?: boolean;
}

export interface AIView {
  seat: Seat;
  phase: Phase;
  dealNo: number;
  currentLevel: Level;
  levels: Record<Team, Level>;
  currentLevelTeam: Team;
  trick: TrickState;
  tribute: GameState['tribute'];
  roundResult: RoundResult | null;
  playedCards: Card[];
  players: Record<Seat, { seat: Seat; team: Team; handCount: number; outOrder: number | null; isAI: boolean }>;
  myHand: Card[];
}

export type ApplyResult =
  | { ok: true; state: GameState }
  | { ok: false; code: PlayErrorCode; message: string; candidates?: Pattern[] };

type ErrorCode = PlayErrorCode;

function fail(code: ErrorCode, message: string, candidates?: Pattern[]): ApplyResult {
  return candidates ? { ok: false, code, message, candidates } : { ok: false, code, message };
}

function currentLevel(state: GameState): Level {
  return state.levels[state.currentLevelTeam];
}

/** 避免与 Math.imul 的 32 位混叠：同一 seed 的不同副/不同用途使用独立流。 */
function deriveSeed(seed: number, dealNo: number, purpose = 0): number {
  let x = (seed >>> 0) ^ Math.imul(dealNo + 1, 0x9e3779b9) ^ Math.imul(purpose + 1, 0x85ebca6b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function cloneState(state: GameState): GameState {
  const players = {} as Record<Seat, GameState['players'][Seat]>;
  for (const seat of SEAT_ORDER_CCW) {
    const player = state.players[seat];
    players[seat] = { ...player, hand: [...player.hand] };
  }
  return {
    ...state,
    levels: { ...state.levels },
    players,
    trick: {
      ...state.trick,
      passedSeats: [...state.trick.passedSeats],
      history: [...state.trick.history],
    },
    tribute: state.tribute
      ? {
          ...state.tribute,
          relations: state.tribute.relations.map((relation) => ({ ...relation })),
          pendingPayers: [...state.tribute.pendingPayers],
          pendingRecipients: [...state.tribute.pendingRecipients],
        }
      : null,
    roundResult: state.roundResult
      ? { ...state.roundResult, outOrder: { ...state.roundResult.outOrder } }
      : null,
    aFailCounts: { ...state.aFailCounts },
    playedCards: [...state.playedCards],
    events: [...state.events],
  };
}

function addEvent(
  state: GameState,
  type: ReplayEvent['type'],
  actor: ReplayEvent['actor'],
  payload: unknown,
  options: EngineOptions,
): void {
  if (!options.recordEvents) return;
  state.events.push({
    seq: state.events.length + 1,
    type,
    actor,
    payload,
    ruleVersion: state.ruleVersion,
  });
}

function dealPlayers(
  seed: number,
  dealNo: number,
  level: Level,
  config: RuleConfig,
): Record<Seat, GameState['players'][Seat]> {
  const rng = createRng(deriveSeed(seed, dealNo, 1));
  const deck = shuffle(createDeck(), rng);
  const order = playOrder(config);
  const players = {} as Record<Seat, GameState['players'][Seat]>;
  order.forEach((seat, index) => {
    players[seat] = {
      seat,
      team: teamOf(seat),
      hand: sortHand(deck.slice(index * 27, (index + 1) * 27), level),
      outOrder: null,
      isAI: true,
    };
  });
  return players;
}

function firstLeader(seed: number, dealNo: number, config: RuleConfig): Seat {
  if (config.firstDealLeader === 'seatS') return 'S';
  const rng = createRng(deriveSeed(seed, dealNo, 2));
  const order = playOrder(config);
  return order[Math.floor(rng() * order.length)]!;
}

function freshTrick(leader: Seat): TrickState {
  return { leader, turn: leader, lastPlay: null, passedSeats: [], history: [] };
}

export function createGame(
  seed: number,
  config: RuleConfig,
  options: EngineOptions = {},
): GameState {
  assertSupportedConfig(config);
  const opts: EngineOptions = { recordEvents: true, ...options };
  const dealNo = 1;
  const levels: Record<Team, Level> = { NS: 2, WE: 2 };
  const currentLevelTeam: Team = 'NS';
  const players = dealPlayers(seed, dealNo, 2, config);
  const leader = firstLeader(seed, dealNo, config);
  const state: GameState = {
    phase: 'PLAYING',
    dealNo,
    levels,
    currentLevelTeam,
    players,
    trick: freshTrick(leader),
    tribute: null,
    roundResult: null,
    rngSeed: seed,
    ruleVersion: RULE_VERSION,
    aFailCounts: { NS: 0, WE: 0 },
    playedCards: [],
    events: [],
  };
  addEvent(state, 'START_MATCH', 'SYSTEM', { seed, ruleVersion: RULE_VERSION }, opts);
  addEvent(state, 'DEAL', 'SYSTEM', { dealNo, leader }, opts);
  return state;
}

function buildNextDeal(state: GameState, config: RuleConfig, options: EngineOptions): GameState {
  const dealNo = state.dealNo + 1;
  const level = state.levels[state.currentLevelTeam];
  const players = dealPlayers(state.rngSeed, dealNo, level, config);
  const hands = {} as Record<Seat, Card[]>;
  for (const seat of SEAT_ORDER_CCW) hands[seat] = players[seat].hand;

  const plan = state.roundResult ? planTribute(state.roundResult, hands, level, config) : null;
  const relations = plan?.relations ?? [];
  const tribute: GameState['tribute'] = plan
    ? {
        relations: relations.map((relation) => ({ ...relation })),
        resisted: plan.resisted,
        pendingPayers: relations.map((relation) => relation.payer),
        pendingRecipients: [],
      }
    : null;
  const leader = plan?.leader ?? firstLeader(state.rngSeed, dealNo, config);
  const next: GameState = {
    phase: relations.length > 0 ? 'TRIBUTE' : 'PLAYING',
    dealNo,
    levels: { ...state.levels },
    currentLevelTeam: state.currentLevelTeam,
    players,
    trick: freshTrick(leader),
    tribute,
    roundResult: state.roundResult,
    rngSeed: state.rngSeed,
    ruleVersion: RULE_VERSION,
    aFailCounts: { ...state.aFailCounts },
    playedCards: [],
    events: [...state.events],
  };
  addEvent(next, 'DEAL', 'SYSTEM', { dealNo, leader, level }, options);
  if (plan?.resisted) {
    addEvent(next, 'TRIBUTE_SKIP', 'SYSTEM', { reason: 'resisted', head: state.roundResult?.headSeat }, options);
  }
  if (plan?.skipped) {
    addEvent(next, 'TRIBUTE_SKIP', 'SYSTEM', { reason: 'innerTributeDisabled' }, options);
  }
  return next;
}

function takeCards(hand: Card[], ids: string[]): { hand: Card[]; cards: Card[] } | null {
  if (ids.length === 0) return null;
  const unique = new Set(ids);
  if (unique.size !== ids.length) return null;
  const byId = new Map(hand.map((card) => [card.id, card]));
  const cards: Card[] = [];
  for (const id of ids) {
    const card = byId.get(id);
    if (!card) return null;
    cards.push(card);
  }
  return { hand: hand.filter((card) => !unique.has(card.id)), cards };
}

export function checkPlay(
  state: GameState,
  seat: Seat,
  cards: Card[],
  config: RuleConfig,
  selector?: PatternSelector,
): PlayCheck {
  if (state.phase !== 'PLAYING') {
    return { ok: false, code: 'E_WRONG_PHASE', message: `当前阶段 ${state.phase} 不能出牌` };
  }
  if (state.trick.turn !== seat) {
    return { ok: false, code: 'E_NOT_YOUR_TURN', message: `当前轮到 ${state.trick.turn}` };
  }
  if (state.trick.passedSeats.includes(seat)) {
    return { ok: false, code: 'E_ALREADY_PASSED', message: '本圈已过牌，不能再出牌' };
  }

  const ids = cards.map((card) => card.id);
  if (ids.length === 0) {
    return { ok: false, code: 'E_INVALID_PATTERN', message: '至少选择一张牌' };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, code: 'E_DUPLICATE_CARD', message: '同一张牌被重复使用' };
  }
  const handIds = new Set(state.players[seat].hand.map((card) => card.id));
  if (ids.some((id) => !handIds.has(id))) {
    return { ok: false, code: 'E_CARD_NOT_OWNED', message: '选中的牌不在该玩家手中' };
  }

  const candidates = recognize(cards, currentLevel(state), config);
  if (candidates.length === 0) {
    return { ok: false, code: 'E_INVALID_PATTERN', message: '选中的牌不构成合法牌型' };
  }
  const pattern = selectPattern(candidates, selector);
  if (!pattern) {
    if (selector || candidates.length > 1) {
      return {
        ok: false,
        code: 'E_AMBIGUOUS_PATTERN',
        message: '同一组牌有多个合法解释，需要明确声明牌型',
        candidates,
      };
    }
    return { ok: false, code: 'E_INVALID_PATTERN', message: '无法识别牌型', candidates };
  }

  const lastPlay = state.trick.lastPlay;
  if (lastPlay && !beats(pattern, lastPlay.pattern, config)) {
    return {
      ok: false,
      code: 'E_CANNOT_BEAT',
      message: `选中的 ${pattern.type} 无法压过上一手 ${lastPlay.pattern.type}`,
      candidates: [pattern],
    };
  }
  return { ok: true, pattern };
}

function countOut(state: GameState): number {
  let count = 0;
  for (const seat of SEAT_ORDER_CCW) if (state.players[seat].outOrder !== null) count += 1;
  return count;
}

function seatByPlace(state: GameState, place: number): Seat | null {
  for (const seat of SEAT_ORDER_CCW) if (state.players[seat].outOrder === place) return seat;
  return null;
}

function activeSeats(state: GameState, config: RuleConfig): Seat[] {
  return playOrder(config).filter(
    (seat) =>
      state.players[seat].hand.length > 0 && !state.trick.passedSeats.includes(seat),
  );
}

function nextActiveAfter(state: GameState, from: Seat, config: RuleConfig): Seat | null {
  const order = playOrder(config);
  const start = order.indexOf(from);
  for (let step = 1; step <= order.length; step += 1) {
    const seat = order[(start + step) % order.length]!;
    if (
      state.players[seat].hand.length > 0 &&
      !state.trick.passedSeats.includes(seat)
    ) {
      return seat;
    }
  }
  return null;
}

/**
 * 本圈结束，进入下一圈。
 * 接风：最后出牌者已出完时，由搭档领出；若搭档也已出完（只在关闭双下提前结束时可能出现），
 * 规则文档未明确，这里按「最后出牌者的下一位仍有牌的玩家」保守处理。
 */
function beginNextTrick(state: GameState, config: RuleConfig, options: EngineOptions): void {
  const last = state.trick.lastPlay;
  if (!last) return;
  let leader = last.seat;
  let viaJiefeng = false;
  if (state.players[leader].hand.length === 0) {
    const partner = partnerSeat(leader);
    if (state.players[partner].hand.length > 0) {
      leader = partner;
      viaJiefeng = true;
    } else {
      const fallback = nextActiveAfter(state, last.seat, config);
      if (fallback) leader = fallback;
    }
  }
  if (state.players[leader].hand.length === 0) {
    const active = activeSeats(state, config);
    if (active[0]) leader = active[0];
  }
  state.trick = freshTrick(leader);
  addEvent(state, 'TRICK_END', 'SYSTEM', { leader, viaJiefeng, lastSeat: last.seat }, options);
}

function advanceTrickAfterPlay(state: GameState, config: RuleConfig, options: EngineOptions, from: Seat): void {
  const last = state.trick.lastPlay;
  if (!last) return;
  const active = activeSeats(state, config);
  const others = active.filter((seat) => seat !== last.seat);
  if (others.length === 0) {
    beginNextTrick(state, config, options);
    return;
  }
  const next = nextActiveAfter(state, from, config);
  if (next) state.trick.turn = next;
  else beginNextTrick(state, config, options);
}

function advanceTrickAfterPass(state: GameState, config: RuleConfig, options: EngineOptions, from: Seat): void {
  const last = state.trick.lastPlay;
  if (!last) return;
  const active = activeSeats(state, config);
  const others = active.filter((seat) => seat !== last.seat);
  if (others.length === 0) {
    beginNextTrick(state, config, options);
    return;
  }
  const next = nextActiveAfter(state, from, config);
  if (next) state.trick.turn = next;
  else beginNextTrick(state, config, options);
}

function finishRound(
  state: GameState,
  config: RuleConfig,
  options: EngineOptions,
  earlyDoubleDown: boolean,
): void {
  if (!earlyDoubleDown) {
    const remaining = SEAT_ORDER_CCW.filter((seat) => state.players[seat].outOrder === null);
    if (remaining.length === 1) state.players[remaining[0]!].outOrder = 4;
  }

  const headSeat = seatByPlace(state, 1);
  if (!headSeat) throw new Error('E_INTERNAL: 结算时没有头游');
  const secondSeat = seatByPlace(state, 2);
  const lastSeat = seatByPlace(state, 4);
  const settlement = settleRound({
    levels: state.levels,
    currentLevelTeam: state.currentLevelTeam,
    outOrder: {
      S: state.players.S.outOrder,
      W: state.players.W.outOrder,
      N: state.players.N.outOrder,
      E: state.players.E.outOrder,
    },
    headSeat,
    secondSeat,
    config,
    aFailCounts: state.aFailCounts,
  });

  state.levels = settlement.levels;
  state.currentLevelTeam = settlement.currentLevelTeam;
  state.aFailCounts = settlement.aFailCounts;
  state.roundResult = {
    dealNo: state.dealNo,
    headSeat,
    secondSeat,
    lastSeat,
    outOrder: {
      S: state.players.S.outOrder,
      W: state.players.W.outOrder,
      N: state.players.N.outOrder,
      E: state.players.E.outOrder,
    },
    winnerTeam: teamOf(headSeat),
    upgrade: settlement.upgrade,
    isDoubleDown: settlement.isDoubleDown,
    passA: settlement.passA,
    aFailed: settlement.aFailed,
  };

  addEvent(state, 'SETTLE', 'SYSTEM', {
    headSeat,
    secondSeat,
    lastSeat,
    isDoubleDown: settlement.isDoubleDown,
    upgrade: settlement.upgrade,
  }, options);
  addEvent(state, 'LEVEL_UP', 'SYSTEM', {
    team: state.currentLevelTeam,
    levels: state.levels,
    upgrade: settlement.upgrade,
    aFailed: settlement.aFailed,
  }, options);

  if (settlement.passA) {
    state.phase = 'GAME_OVER';
    state.gameOverReason = 'PASS_A';
    addEvent(state, 'GAME_OVER', 'SYSTEM', { reason: 'PASS_A', team: teamOf(headSeat) }, options);
  } else {
    state.phase = 'SETTLEMENT';
  }
}

function startPlayingAfterTribute(state: GameState): void {
  state.phase = 'PLAYING';
  const relations = state.tribute?.relations ?? [];
  const resisted = state.tribute?.resisted ?? false;
  const leader = resolveTributeLeader(state.roundResult, relations, resisted);
  state.trick = freshTrick(leader);
  if (state.tribute) {
    state.tribute.pendingPayers = [];
    state.tribute.pendingRecipients = [];
  }
}

export function applyAction(
  state: GameState,
  action: EngineAction,
  config: RuleConfig,
  options: EngineOptions = {},
): ApplyResult {
  const opts: EngineOptions = { recordEvents: true, ...options };

  if (action.type === 'NEXT_DEAL') {
    if (state.phase !== 'SETTLEMENT') {
      return fail('E_WRONG_PHASE', '只有结算阶段才能开始下一副');
    }
    const next = buildNextDeal(state, config, opts);
    addEvent(next, 'NEXT_DEAL', 'SYSTEM', { fromDeal: state.dealNo, toDeal: next.dealNo }, opts);
    return { ok: true, state: next };
  }

  if (action.type === 'PAY_TRIBUTE') {
    if (state.phase !== 'TRIBUTE' || !state.tribute) {
      return fail('E_WRONG_PHASE', '当前不在进贡阶段');
    }
    if (!state.tribute.pendingPayers.includes(action.seat)) {
      return fail('E_TRIBUTE_NOT_PENDING', '该玩家当前不需要进贡');
    }
    const hand = state.players[action.seat].hand;
    const card = hand.find((item) => item.id === action.cardId);
    if (!card) return fail('E_CARD_NOT_OWNED', '贡牌不在该玩家手中');
    const legal = maxTributeCards(hand, currentLevel(state), config);
    if (!legal.some((item) => item.id === action.cardId)) {
      return fail('E_TRIBUTE_CARD_INVALID', '必须进贡最大的非红桃级牌');
    }
    const relation = state.tribute.relations.find((item) => item.payer === action.seat);
    if (!relation) return fail('E_TRIBUTE_NOT_PENDING', '找不到该玩家的进贡关系');

    const next = cloneState(state);
    const taken = takeCards(next.players[action.seat].hand, [action.cardId]);
    if (!taken) return fail('E_CARD_NOT_OWNED', '贡牌不在该玩家手中');
    next.players[action.seat].hand = taken.hand;
    next.players[relation.recipient].hand = sortHand(
      [...next.players[relation.recipient].hand, card],
      currentLevel(next),
    );
    const nextRelation = next.tribute!.relations.find((item) => item.payer === action.seat)!;
    nextRelation.paidCard = card;
    next.tribute!.pendingPayers = next.tribute!.pendingPayers.filter((seat) => seat !== action.seat);
    addEvent(next, 'TRIBUTE_PAY', action.seat, { payer: action.seat, recipient: relation.recipient, cardId: card.id }, opts);

    if (next.tribute!.pendingPayers.length === 0) {
      next.tribute!.pendingRecipients = next.tribute!.relations
        .filter((item) => !item.returnedCard)
        .map((item) => item.recipient);
      if (next.tribute!.pendingRecipients.length === 0) startPlayingAfterTribute(next);
    }
    return { ok: true, state: next };
  }

  if (action.type === 'RETURN_TRIBUTE') {
    if (state.phase !== 'TRIBUTE' || !state.tribute) {
      return fail('E_WRONG_PHASE', '当前不在还贡阶段');
    }
    if (!state.tribute.pendingRecipients.includes(action.seat)) {
      return fail('E_TRIBUTE_NOT_PENDING', '该玩家当前不需要还贡');
    }
    const relation = state.tribute.relations.find(
      (item) => item.recipient === action.seat && !item.returnedCard,
    );
    if (!relation) return fail('E_TRIBUTE_NOT_PENDING', '找不到该玩家的还贡关系');
    const hand = state.players[action.seat].hand;
    const card = hand.find((item) => item.id === action.cardId);
    if (!card) return fail('E_CARD_NOT_OWNED', '还贡牌不在该玩家手中');
    const legal = legalReturnCards(hand, currentLevel(state), config);
    if (!legal.some((item) => item.id === action.cardId)) {
      return fail('E_TRIBUTE_CARD_INVALID', '还贡必须还一张牌点不超过 10 的牌；若全手均大于 10 则还最小牌');
    }

    const next = cloneState(state);
    const taken = takeCards(next.players[action.seat].hand, [action.cardId]);
    if (!taken) return fail('E_CARD_NOT_OWNED', '还贡牌不在该玩家手中');
    next.players[action.seat].hand = taken.hand;
    next.players[relation.payer].hand = sortHand(
      [...next.players[relation.payer].hand, card],
      currentLevel(next),
    );
    const nextRelation = next.tribute!.relations.find(
      (item) => item.recipient === action.seat && !item.returnedCard,
    )!;
    nextRelation.returnedCard = card;
    next.tribute!.pendingRecipients = next.tribute!.pendingRecipients.filter(
      (seat) => seat !== action.seat,
    );
    addEvent(next, 'TRIBUTE_RETURN', action.seat, {
      recipient: action.seat,
      payer: relation.payer,
      cardId: card.id,
    }, opts);

    if (next.tribute!.pendingRecipients.length === 0) startPlayingAfterTribute(next);
    return { ok: true, state: next };
  }

  if (action.type === 'PASS') {
    if (state.phase !== 'PLAYING') return fail('E_WRONG_PHASE', '当前不在出牌阶段');
    if (state.trick.turn !== action.seat) return fail('E_NOT_YOUR_TURN', `当前轮到 ${state.trick.turn}`);
    if (state.trick.lastPlay === null) {
      return fail('E_LEADER_CANNOT_PASS', '本圈由你领出，必须出牌');
    }
    if (state.trick.passedSeats.includes(action.seat)) {
      return fail('E_ALREADY_PASSED', '本圈已过牌，不能再出牌');
    }
    const next = cloneState(state);
    next.trick.passedSeats.push(action.seat);
    addEvent(next, 'PASS', action.seat, { seat: action.seat }, opts);
    advanceTrickAfterPass(next, config, opts, action.seat);
    return { ok: true, state: next };
  }

  // PLAY
  const check = checkPlay(state, action.seat, action.cards, config, action.selector);
  if (!check.ok) return fail(check.code, check.message, check.candidates);

  const next = cloneState(state);
  const taken = takeCards(next.players[action.seat].hand, action.cards.map((card) => card.id));
  if (!taken) return fail('E_CARD_NOT_OWNED', '选中的牌不在该玩家手中');
  next.players[action.seat].hand = taken.hand;
  const record: PlayRecord = { seat: action.seat, pattern: check.pattern, cards: taken.cards };
  next.trick.lastPlay = record;
  next.trick.history.push(record);
  next.playedCards.push(...taken.cards);
  addEvent(next, 'PLAY', action.seat, {
    seat: action.seat,
    cards: taken.cards.map((card) => card.id),
    pattern: check.pattern.type,
    mainRank: check.pattern.mainRank,
    selector: action.selector,
  }, opts);

  if (taken.hand.length === 0) {
    const place = countOut(next) + 1;
    next.players[action.seat].outOrder = place;
    addEvent(next, 'PLAYER_OUT', action.seat, { seat: action.seat, place }, opts);

    if (place === 2) {
      const headSeat = seatByPlace(next, 1);
      const sameTeam = headSeat !== null && teamOf(headSeat) === teamOf(action.seat);
      if (sameTeam && config.doubleDownEarlyEnd) {
        finishRound(next, config, opts, true);
        return { ok: true, state: next };
      }
    }
    if (place === 3 || place === 4) {
      finishRound(next, config, opts, false);
      return { ok: true, state: next };
    }
  }

  advanceTrickAfterPlay(next, config, opts, action.seat);
  return { ok: true, state: next };
}

/** 当前阶段该谁操作；结算/结束阶段为 null。 */
export function getCurrentSeat(state: GameState): Seat | null {
  if (state.phase === 'PLAYING') return state.trick.turn;
  if (state.phase === 'TRIBUTE' && state.tribute) {
    return state.tribute.pendingPayers[0] ?? state.tribute.pendingRecipients[0] ?? null;
  }
  return null;
}

/** 当前手牌的全部合法出牌（不含过牌）。 */
export function getLegalPlays(
  state: GameState,
  config: RuleConfig,
  seat: Seat = state.trick.turn,
): EnumerateResult {
  if (state.phase !== 'PLAYING') return { options: [], truncated: false };
  const lastPattern = state.trick.lastPlay?.pattern ?? null;
  return enumerateLegalPlays(state.players[seat].hand, currentLevel(state), config, lastPattern);
}

/**
 * D11：剩余牌数 ≤ reportThreshold 时需要报牌。
 * 本产品采用「全程精确展示 + 到阈值加提示」，不实现线下报牌后不得出牌的流程。
 */
export function needsReport(state: GameState, seat: Seat, config: RuleConfig): boolean {
  const count = state.players[seat].hand.length;
  return count > 0 && count <= config.reportThreshold;
}

export function getLegalTributeCards(state: GameState, seat: Seat, config: RuleConfig): Card[] {
  if (state.phase !== 'TRIBUTE' || !state.tribute?.pendingPayers.includes(seat)) return [];
  return maxTributeCards(state.players[seat].hand, currentLevel(state), config);
}

export function getLegalReturnCards(state: GameState, seat: Seat, config: RuleConfig): Card[] {
  if (state.phase !== 'TRIBUTE' || !state.tribute?.pendingRecipients.includes(seat)) return [];
  return legalReturnCards(state.players[seat].hand, currentLevel(state), config);
}

/** 信息隔离：AI 只能看到自己的手牌与公开信息。 */
export function toAIView(state: GameState, seat: Seat): AIView {
  const players = {} as AIView['players'];
  for (const item of SEAT_ORDER_CCW) {
    const player = state.players[item];
    players[item] = {
      seat: player.seat,
      team: player.team,
      handCount: player.hand.length,
      outOrder: player.outOrder,
      isAI: player.isAI,
    };
  }
  return {
    seat,
    phase: state.phase,
    dealNo: state.dealNo,
    currentLevel: currentLevel(state),
    levels: { ...state.levels },
    currentLevelTeam: state.currentLevelTeam,
    trick: {
      ...state.trick,
      passedSeats: [...state.trick.passedSeats],
      history: [...state.trick.history],
    },
    tribute: state.tribute
      ? {
          relations: state.tribute.relations.map((relation) => ({ ...relation })),
          resisted: state.tribute.resisted,
          pendingPayers: [...state.tribute.pendingPayers],
          pendingRecipients: [...state.tribute.pendingRecipients],
        }
      : null,
    roundResult: state.roundResult,
    playedCards: [...state.playedCards],
    players,
    myHand: [...state.players[seat].hand],
  };
}

/** 稳定的状态摘要，用于回放一致性测试（不含事件日志本身）。 */
export function stateHash(state: GameState): string {
  const { events: _events, ...rest } = state;
  const text = JSON.stringify(rest);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 走完一副牌后，确认四家手牌 + 已出牌 = 108 张且无重复。 */
export function assertCardConservation(state: GameState): void {
  const ids = new Set<string>();
  let total = state.playedCards.length;
  for (const seat of SEAT_ORDER_CCW) {
    const hand = state.players[seat].hand;
    total += hand.length;
    for (const card of hand) {
      if (ids.has(card.id)) throw new Error(`E_DUPLICATE_CARD: ${card.id}`);
      ids.add(card.id);
    }
  }
  for (const card of state.playedCards) {
    if (ids.has(card.id)) throw new Error(`E_DUPLICATE_CARD: ${card.id}`);
    ids.add(card.id);
  }
  if (total !== 108) throw new Error(`E_CARD_COUNT: 手牌+已出牌=${total}，应为 108`);
}

export function nextSeatOf(seat: Seat, config: RuleConfig): Seat {
  return nextSeat(seat, config);
}

export function isWild(card: Card, level: Level, config: RuleConfig): boolean {
  return isWildcard(card, level, config);
}

export function powerOf(card: Card, level: Level): number {
  return powerRank(card, level);
}
