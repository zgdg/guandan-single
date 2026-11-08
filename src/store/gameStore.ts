import { create } from 'zustand';
import type { Card, GameState, Seat } from '../core/types';
import type { RuleConfig } from '../core/config';
import { RULE_VERSION, mergeRuleConfig } from '../core/config';
import {
  applyAction,
  checkPlay,
  createGame,
  getCurrentSeat,
  getLegalReturnCards,
  getLegalTributeCards,
} from '../core/engine';
import { createRng } from '../core/cards';
import { selectorOf } from '../ai/simple';
import { chooseAiAction } from '../ai/policy';
import { normalizeDifficulty, type AiDifficulty } from '../ai/persona';
import { beats } from '../core/compare';
import { suggestForHuman, type Suggestion } from '../suggest/static';
import { publicStateHash } from '../suggest/belief';
import { buildDecision, type DecisionRecord } from '../review/decisions';

export const HUMAN_SEAT: Seat = 'S';
export const SAVE_KEY = 'guandan-single.save.v1';
export const SETTINGS_KEY = 'guandan-single.settings.v1';

export type Screen = 'home' | 'game' | 'review';

export interface GameSettings {
  /** 1=正常，2=2 倍速，0.5=慢速；影响 AI 行动间隔与发牌动画。 */
  speed: number;
  /** 对局 AI 难度档位，默认 L2；L3 会启用采样搜索。 */
  aiDifficulty: AiDifficulty;
}

interface SaveData {
  version: 1;
  ruleVersion: string;
  state: GameState;
  config: RuleConfig;
  settings: GameSettings;
  dealStart: GameState;
  decisions?: DecisionRecord[];
  expandedCount?: number;
}

interface PersistedSettings {
  settings: GameSettings;
}

export interface GameStore {
  screen: Screen;
  state: GameState | null;
  config: RuleConfig;
  settings: GameSettings;
  selected: string[];
  message: string | null;
  dealing: boolean;
  dealStart: GameState | null;
  hasSave: boolean;
  /** 本局人类决策记录（含建议对比），用于复盘。 */
  decisions: DecisionRecord[];
  /** 建议卡展开次数（本地埋点）。 */
  expandedCount: number;
  /** 当前轮次的建议（静态先出，PIMC 结果回来后再覆盖）。 */
  suggestion: Suggestion | null;
  /** 建议对应的公开局面摘要，防止把旧建议用到新局面上。 */
  suggestionHash: string | null;
  /** 是否正在后台精算。 */
  suggestionPending: boolean;

  beginSuggestion: (hash: string, suggestion: Suggestion) => void;
  applySuggestion: (hash: string, suggestion: Suggestion) => void;
  clearSuggestion: () => void;
  startGame: () => void;
  loadGame: () => void;
  backHome: () => void;
  setSpeed: (speed: number) => void;
  setAiDifficulty: (difficulty: AiDifficulty) => void;
  toggleCard: (cardId: string) => void;
  selectCards: (cardIds: string[]) => void;
  clearSelection: () => void;
  playSelected: () => void;
  pass: () => void;
  tributeSelected: () => void;
  nextDeal: () => void;
  restartDeal: () => void;
  runAI: () => void;
  endDealing: () => void;
  clearMessage: () => void;
  openReview: () => void;
  closeReview: () => void;
  markSuggestionExpanded: () => void;
}

function readSettings(): GameSettings {
  const fallback: GameSettings = { speed: 1, aiDifficulty: 'L2' };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as PersistedSettings;
    const speed = Number(parsed.settings?.speed);
    return {
      speed: [0.5, 1, 2].includes(speed) ? speed : 1,
      aiDifficulty: normalizeDifficulty(parsed.settings?.aiDifficulty),
    };
  } catch {
    return fallback;
  }
}

function writeSave(data: SaveData): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

function readSave(): SaveData | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SaveData;
    if (!parsed || parsed.version !== 1 || !parsed.state || !parsed.state.players) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hasSaveNow(): boolean {
  return readSave() !== null;
}

const initialSave = typeof localStorage !== 'undefined' ? readSave() : null;

function persistSettings(settings: GameSettings, get: () => GameStore): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ settings }));
  }
  if (get().state) persist(get);
}

function persist(get: () => GameStore): void {
  const store = get();
  if (!store.state) return;
  writeSave({
    version: 1,
    ruleVersion: RULE_VERSION,
    state: store.state,
    config: store.config,
    settings: store.settings,
    dealStart: store.dealStart ?? store.state,
    decisions: store.decisions,
    expandedCount: store.expandedCount,
  });
}

/** 记录一次人类决策（比较对象是决策发生时的建议，不是事后视角）。 */
function withDecision(
  state: GameState,
  config: RuleConfig,
  actual: 'PLAY' | 'PASS',
  cards: Card[],
  decisions: DecisionRecord[],
  suggestion: Suggestion,
): DecisionRecord[] {
  const turn = decisions.filter((item) => item.dealNo === state.dealNo).length + 1;
  return [...decisions, buildDecision(state, config, suggestion, actual, cards, turn)];
}

/** 优先使用界面当前展示的建议（可能来自 PIMC），否则现场回退静态建议。 */
function displayedSuggestion(state: GameState, config: RuleConfig, store: GameStore): Suggestion {
  if (store.suggestion && store.suggestionHash === publicStateHash(state, HUMAN_SEAT)) {
    return store.suggestion;
  }
  return suggestForHuman(state, config);
}

const NO_SUGGESTION = {
  suggestion: null,
  suggestionHash: null,
  suggestionPending: false,
} as const;

export const useGameStore = create<GameStore>((set, get) => ({
  screen: 'home',
  state: null,
  config: mergeRuleConfig(),
  settings: readSettings(),
  selected: [],
  message: null,
  dealing: false,
  dealStart: null,
  hasSave: initialSave !== null,
  decisions: initialSave?.decisions ?? [],
  expandedCount: initialSave?.expandedCount ?? 0,
  suggestion: null,
  suggestionHash: null,
  suggestionPending: false,

  beginSuggestion: (hash, suggestion) =>
    set({ suggestion, suggestionHash: hash, suggestionPending: true }),
  applySuggestion: (hash, suggestion) => {
    if (get().suggestionHash !== hash) return;
    set({ suggestion, suggestionPending: false });
  },
  clearSuggestion: () => set({ ...NO_SUGGESTION }),

  startGame: () => {
    const config = mergeRuleConfig();
    const seed = Math.floor(Math.random() * 0x7fffffff);
    const state = createGame(seed, config, { recordEvents: true });
    set({
      screen: 'game',
      state,
      config,
      selected: [],
      message: null,
      dealing: true,
      dealStart: state,
      hasSave: true,
      decisions: [],
      expandedCount: 0,
      ...NO_SUGGESTION,
    });
    persist(get);
  },

  loadGame: () => {
    const save = readSave();
    if (!save) {
      set({ message: '没有找到可继续的存档，请开始新局。', hasSave: false });
      return;
    }
    if (save.ruleVersion !== RULE_VERSION) {
      set({
        message: `存档版本不兼容（存档 ${save.ruleVersion}，当前 ${RULE_VERSION}），已保留旧档，请开始新局。`,
        hasSave: true,
      });
      return;
    }
    set({
      screen: 'game',
      state: save.state,
      config: mergeRuleConfig(save.config),
      settings: save.settings
        ? {
            speed: [0.5, 1, 2].includes(Number(save.settings.speed)) ? save.settings.speed : 1,
            aiDifficulty: normalizeDifficulty(save.settings.aiDifficulty),
          }
        : { speed: 1, aiDifficulty: 'L2' },
      selected: [],
      message: null,
      dealing: false,
      dealStart: save.dealStart ?? save.state,
      hasSave: true,
      decisions: save.decisions ?? [],
      expandedCount: save.expandedCount ?? 0,
      ...NO_SUGGESTION,
    });
  },

  backHome: () => set({ screen: 'home', selected: [], message: null, dealing: false, ...NO_SUGGESTION }),

  setSpeed: (speed: number) => {
    const settings = { ...get().settings, speed };
    set({ settings });
    persistSettings(settings, get);
  },

  setAiDifficulty: (aiDifficulty: AiDifficulty) => {
    const settings = { ...get().settings, aiDifficulty };
    set({ settings });
    persistSettings(settings, get);
  },

  toggleCard: (cardId: string) => {
    const { state, selected } = get();
    if (!state) return;
    if (state.phase === 'PLAYING' && getCurrentSeat(state) !== HUMAN_SEAT) return;
    if (state.phase === 'TRIBUTE' && getCurrentSeat(state) !== HUMAN_SEAT) return;
    if (selected.includes(cardId)) {
      set({ selected: selected.filter((id) => id !== cardId) });
    } else {
      // 进贡/还贡只允许选一张。
      if (state.phase === 'TRIBUTE') {
        set({ selected: [cardId] });
      } else {
        set({ selected: [...selected, cardId] });
      }
    }
  },

  selectCards: (cardIds: string[]) => set({ selected: cardIds }),
  clearSelection: () => set({ selected: [] }),

  playSelected: () => {
    const { state, config, selected } = get();
    if (!state) return;
    if (state.phase !== 'PLAYING' || state.trick.turn !== HUMAN_SEAT) {
      set({ message: '现在不是你的出牌回合。' });
      return;
    }
    if (selected.length === 0) {
      set({ message: '请先选择要出的牌。' });
      return;
    }
    const hand = state.players[HUMAN_SEAT].hand;
    const cards = hand.filter((card) => selected.includes(card.id));
    if (cards.length !== selected.length) {
      set({ message: '选中的牌不在手中，请重新选择。' });
      return;
    }

    // 先做一次纯校验：多解释时自动锁定一个能压过上家的解释。
    const check = checkPlay(state, HUMAN_SEAT, cards, config);
    let chosen = cards;
    let selector = undefined as ReturnType<typeof selectorOf> | undefined;
    if (!check.ok && check.code === 'E_AMBIGUOUS_PATTERN' && check.candidates?.length) {
      const last = state.trick.lastPlay?.pattern ?? null;
      const candidate =
        check.candidates.find((pattern) => (last ? beats(pattern, last, config) : true)) ??
        check.candidates[0]!;
      chosen = candidate.cards;
      selector = selectorOf(candidate);
    } else if (!check.ok) {
      set({ message: check.message });
      return;
    }

    const action = {
      type: 'PLAY' as const,
      seat: HUMAN_SEAT,
      cards: chosen,
      ...(selector ? { selector } : {}),
    };
    const result = applyAction(state, action, config, { recordEvents: true });
    if (!result.ok) {
      set({ message: result.message });
      return;
    }
    const suggestion = displayedSuggestion(state, config, get());
    set({
      state: result.state,
      selected: [],
      message: null,
      decisions: withDecision(state, config, 'PLAY', chosen, get().decisions, suggestion),
      ...NO_SUGGESTION,
    });
    persist(get);
  },

  pass: () => {
    const { state, config } = get();
    if (!state) return;
    const result = applyAction(state, { type: 'PASS', seat: HUMAN_SEAT }, config, {
      recordEvents: true,
    });
    if (!result.ok) {
      set({ message: result.message });
      return;
    }
    const suggestion = displayedSuggestion(state, config, get());
    set({
      state: result.state,
      selected: [],
      message: null,
      decisions: withDecision(state, config, 'PASS', [], get().decisions, suggestion),
      ...NO_SUGGESTION,
    });
    persist(get);
  },

  tributeSelected: () => {
    const { state, config, selected } = get();
    if (!state || state.phase !== 'TRIBUTE' || selected.length !== 1) {
      set({ message: '请选择一张要进贡/还贡的牌。' });
      return;
    }
    const cardId = selected[0]!;
    const canPay = getLegalTributeCards(state, HUMAN_SEAT, config).some((card) => card.id === cardId);
    const canReturn = getLegalReturnCards(state, HUMAN_SEAT, config).some((card) => card.id === cardId);
    if (!canPay && !canReturn) {
      set({ message: '这张牌不符合贡牌/还贡规则。' });
      return;
    }
    const action = canPay
      ? ({ type: 'PAY_TRIBUTE', seat: HUMAN_SEAT, cardId } as const)
      : ({ type: 'RETURN_TRIBUTE', seat: HUMAN_SEAT, cardId } as const);
    const result = applyAction(state, action, config, { recordEvents: true });
    if (!result.ok) {
      set({ message: result.message });
      return;
    }
    set({ state: result.state, selected: [], message: null, ...NO_SUGGESTION });
    persist(get);
  },

  nextDeal: () => {
    const { state, config } = get();
    if (!state || state.phase !== 'SETTLEMENT') return;
    const result = applyAction(state, { type: 'NEXT_DEAL' }, config, { recordEvents: true });
    if (!result.ok) {
      set({ message: result.message });
      return;
    }
    set({
      state: result.state,
      dealStart: result.state,
      selected: [],
      message: null,
      dealing: true,
      ...NO_SUGGESTION,
    });
    persist(get);
  },

  restartDeal: () => {
    const { dealStart, decisions } = get();
    if (!dealStart) return;
    set({
      state: dealStart,
      selected: [],
      message: '本副已重开。',
      dealing: true,
      decisions: decisions.filter((item) => item.dealNo !== dealStart.dealNo),
      ...NO_SUGGESTION,
    });
    persist(get);
  },

  runAI: () => {
    const { state, config, settings } = get();
    if (!state) return;
    if (state.phase === 'SETTLEMENT' || state.phase === 'GAME_OVER') return;
    const seat = getCurrentSeat(state);
    if (!seat || seat === HUMAN_SEAT) return;
    const rng = createRng(
      (state.rngSeed + state.dealNo * 131 + state.playedCards.length * 31 + state.events.length) >>> 0,
    );
    const action = chooseAiAction(state, config, seat, rng, {
      difficulty: settings.aiDifficulty,
    });
    if (!action) return;
    const result = applyAction(state, action, config, { recordEvents: true });
    if (!result.ok) {
      // AI 理论上不会产生非法动作；兜底过牌，避免卡死。
      const fallback = applyAction(state, { type: 'PASS', seat }, config, { recordEvents: true });
      if (fallback.ok) {
        set({ state: fallback.state });
        persist(get);
      }
      return;
    }
    set({ state: result.state, ...NO_SUGGESTION });
    persist(get);
  },

  endDealing: () => set({ dealing: false }),
  clearMessage: () => set({ message: null }),

  openReview: () => {
    const { state } = get();
    if (!state) return;
    if (state.phase !== 'SETTLEMENT' && state.phase !== 'GAME_OVER') return;
    set({ screen: 'review', selected: [], message: null });
  },

  closeReview: () => set({ screen: 'game' }),

  markSuggestionExpanded: () => {
    set({ expandedCount: get().expandedCount + 1 });
    persist(get);
  },
}));

/** 供 UI 判断当前是否轮到手牌操作。 */
export function isHumanTurn(state: GameState | null): boolean {
  if (!state) return false;
  if (state.phase !== 'PLAYING' && state.phase !== 'TRIBUTE') return false;
  return getCurrentSeat(state) === HUMAN_SEAT;
}

/** 当前人类需要进贡还是还贡。 */
export function humanTributeKind(state: GameState | null): 'pay' | 'return' | null {
  if (!state || state.phase !== 'TRIBUTE' || !state.tribute) return null;
  if (state.tribute.pendingPayers.includes(HUMAN_SEAT)) return 'pay';
  if (state.tribute.pendingRecipients.includes(HUMAN_SEAT)) return 'return';
  return null;
}

export function isCardSelected(state: GameState, selected: string[]): Card[] {
  return state.players[HUMAN_SEAT].hand.filter((card) => selected.includes(card.id));
}
