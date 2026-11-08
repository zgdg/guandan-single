/**
 * 核心类型定义。
 *
 * 设计约束（对应规划 5.2 / 5.5）：
 * - 本文件与 core 下其它模块不得依赖 React、DOM 或网络。
 * - GameState 必须可序列化，便于存档与回放。
 * - 隐藏信息（各家手牌）只在运行时 state 中存在；导出给 AI 时必须走 AIView。
 */

export type Suit = 'S' | 'H' | 'C' | 'D';
export type JokerSuit = 'JOKER';

/**
 * 牌点：2–14 为普通牌（11=J、12=Q、13=K、14=A），15=小王，16=大王。
 * 注意：牌点不等于牌力。牌力必须走 powerRank，连续牌型必须走 sequenceRank。
 */
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
export type NormalRank = Exclude<Rank, 15 | 16>;
export type Level = NormalRank;

export interface Card {
  /** 唯一且稳定：`${copy}-${suit}-${rank}`，回放与选中都依赖它。 */
  id: string;
  suit: Suit | JokerSuit;
  rank: Rank;
  /** 同一副牌内的副本序号（0/1），两副牌共 108 张。 */
  copy: 0 | 1;
}

export type Seat = 'S' | 'W' | 'N' | 'E';
export type Team = 'NS' | 'WE';

/** 默认逆时针出牌顺序：S → E → N → W → S（上家/下家随 playDirection 配置）。 */
export const SEAT_ORDER_CCW: readonly Seat[] = ['S', 'E', 'N', 'W'];
export const SEAT_ORDER_CW: readonly Seat[] = ['S', 'W', 'N', 'E'];

export type Phase = 'IDLE' | 'DEALING' | 'TRIBUTE' | 'PLAYING' | 'SETTLEMENT' | 'GAME_OVER';

export type PatternType =
  | 'SINGLE'
  | 'PAIR'
  | 'TRIPLE'
  | 'FULL_HOUSE'
  | 'STRAIGHT'
  | 'TUBE'
  | 'PLATE'
  | 'BOMB'
  | 'STRAIGHT_FLUSH'
  | 'KING_BOMB';

/** 逢人配的替代声明，用于「同组牌有多种解释」时锁定其中一种。 */
export interface WildAssignment {
  cardId: string;
  asRank: NormalRank;
  /** 同花顺需要指定花色；其它牌型可省略。 */
  asSuit?: Suit;
}

export interface Pattern {
  type: PatternType;
  cards: Card[];
  count: number;
  /**
   * 比较主键：
   * - 普通牌型：powerRank（单/对/三/三带对的三同张）
   * - 顺子类：最高一张的 sequenceRank
   * - 炸弹：powerRank（级牌炸弹是否提升由配置决定）
   */
  mainRank: number;
  /** 连续牌型的起始自然牌点（1 表示 A 作 1）。 */
  sequenceLow?: number;
  /** 同花顺花色；仅在 type=STRAIGHT_FLUSH 时存在。 */
  suit?: Suit;
  /** 三带对：三同张牌点与对子牌点（对子可为 15/16 两张王）。 */
  tripleRank?: NormalRank;
  pairRank?: Rank;
  /** 0=普通牌型；1=4炸；2=5炸；3=同花顺；4=6+炸；5=四大天王。 */
  bombTier: 0 | 1 | 2 | 3 | 4 | 5;
  wildAssignments: WildAssignment[];
  /**
   * 三带对变体：pair=三同张+一对（官方默认）；twoSingles=三同张+两张不同单牌。
   * twoSingles 仅在 allowTripleWithTwoSingles=true 时出现。
   */
  variant?: 'pair' | 'twoSingles';
}

export interface PlayOption {
  pattern: Pattern;
  cards: Card[];
}

export type PlayErrorCode =
  | 'E_WRONG_PHASE'
  | 'E_NOT_YOUR_TURN'
  | 'E_CARD_NOT_OWNED'
  | 'E_DUPLICATE_CARD'
  | 'E_INVALID_PATTERN'
  | 'E_AMBIGUOUS_PATTERN'
  | 'E_CANNOT_BEAT'
  | 'E_LEADER_CANNOT_PASS'
  | 'E_ALREADY_PASSED'
  | 'E_TRIBUTE_CARD_INVALID'
  | 'E_TRIBUTE_NOT_PENDING'
  | 'E_GAME_OVER';

export type PlayCheck =
  | { ok: true; pattern: Pattern }
  | { ok: false; code: PlayErrorCode; message: string; candidates?: Pattern[] };

export interface PlayRecord {
  seat: Seat;
  pattern: Pattern;
  cards: Card[];
}

export interface PlayerState {
  seat: Seat;
  team: Team;
  hand: Card[];
  /** 1=头游、2=二游、3=三游、4=末游；双下提前结束时后两名可为 null。 */
  outOrder: number | null;
  isAI: boolean;
}

export interface TrickState {
  /** 本圈领出者。 */
  leader: Seat;
  /** 当前轮到谁；出牌/过牌后推进。 */
  turn: Seat;
  /** 本圈最后一手；领出前为 null。 */
  lastPlay: PlayRecord | null;
  /** 本圈已过牌且不能再出牌的座位。 */
  passedSeats: Seat[];
  history: PlayRecord[];
}

export interface RoundResult {
  dealNo: number;
  headSeat: Seat;
  /** 二游；双下时即头游搭档。 */
  secondSeat: Seat | null;
  /** 末游；双下提前结束时为 null。 */
  lastSeat: Seat | null;
  outOrder: Record<Seat, number | null>;
  winnerTeam: Team;
  upgrade: number;
  isDoubleDown: boolean;
  passA: boolean;
  aFailed: boolean;
}

export interface TributeRelation {
  payer: Seat;
  recipient: Seat;
  paidCard?: Card;
  returnedCard?: Card;
}

export interface TributeState {
  /** 已确定进贡关系；抗贡时为空。 */
  relations: TributeRelation[];
  resisted: boolean;
  pendingPayers: Seat[];
  pendingRecipients: Seat[];
}

export type GameEventType =
  | 'START_MATCH'
  | 'DEAL'
  | 'TRIBUTE_PAY'
  | 'TRIBUTE_RETURN'
  | 'TRIBUTE_SKIP'
  | 'PLAY'
  | 'PASS'
  | 'TRICK_END'
  | 'PLAYER_OUT'
  | 'SETTLE'
  | 'LEVEL_UP'
  | 'NEXT_DEAL'
  | 'GAME_OVER';

/**
 * 回放事件：只记录「发生了什么」和动作输入，不保存中间状态。
 * 不含墙钟时间，保证同 seed + 同动作序列可完全复现。
 */
export interface ReplayEvent {
  seq: number;
  type: GameEventType;
  actor: Seat | 'SYSTEM';
  payload: unknown;
  ruleVersion: string;
}

export interface GameState {
  phase: Phase;
  /** 第几副牌，从 1 开始。 */
  dealNo: number;
  levels: Record<Team, Level>;
  /** 本副牌打谁的级牌（上一副赢家=台上）。 */
  currentLevelTeam: Team;
  players: Record<Seat, PlayerState>;
  trick: TrickState;
  tribute: TributeState | null;
  roundResult: RoundResult | null;
  rngSeed: number;
  ruleVersion: string;
  /** 打 A 失败次数，用于可配置的「三次不过回 2」。 */
  aFailCounts: Record<Team, number>;
  /** 本副牌已经打出的牌，用于牌数守恒与回放校验。 */
  playedCards: Card[];
  /** 可选事件日志；模拟时关闭以降低拷贝开销。 */
  events: ReplayEvent[];
  gameOverReason?: 'PASS_A';
}

export type GameAction =
  | { type: 'PLAY'; seat: Seat; cards: Card[]; selector?: PatternSelector }
  | { type: 'PASS'; seat: Seat }
  | { type: 'PAY_TRIBUTE'; seat: Seat; cardId: string }
  | { type: 'RETURN_TRIBUTE'; seat: Seat; cardId: string };

/** 引擎命令 = 玩家动作 + 流程推进（NEXT_DEAL 不是玩家动作）。 */
export type EngineAction = GameAction | { type: 'NEXT_DEAL' };

/** 用于在同组牌有多种合法解释时指定一种。 */
export interface PatternSelector {
  type: PatternType;
  /** 顺子/连对/钢板的起始自然牌点。 */
  sequenceLow?: number;
  /** 同花顺花色。 */
  suit?: Suit;
  /** 三带对的三同张牌点。 */
  tripleRank?: NormalRank;
  /** 单牌/对子/三同张/炸弹的牌点（含 15/16 两张王）。 */
  rank?: Rank;
}
