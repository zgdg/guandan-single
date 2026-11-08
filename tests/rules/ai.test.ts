import { describe, expect, it } from 'vitest';
import { mergeRuleConfig } from '../../src/core/config';
import { createGame, applyAction, getCurrentSeat } from '../../src/core/engine';
import { createRng } from '../../src/core/cards';
import type { GameState, Seat } from '../../src/core/types';
import { chooseAiAction } from '../../src/ai/policy';
import { DIFFICULTY, PERSONA, type AiDifficulty } from '../../src/ai/persona';

const config = mergeRuleConfig();

interface WalkResult {
  deals: number;
  decisions: number;
  actionTypes: Set<string>;
  states: GameState[];
}

function walk(difficulty: AiDifficulty, dealsWanted: number, seed: number): WalkResult {
  let state = createGame(seed, config, { recordEvents: false });
  let deals = 0;
  let decisions = 0;
  let guard = 0;
  const actionTypes = new Set<string>();
  const states: GameState[] = [];

  while (deals < dealsWanted) {
    guard += 1;
    if (guard > 40_000) throw new Error('E_STUCK: 单副牌动作数异常');
    if (state.phase === 'GAME_OVER') {
      return { deals, decisions, actionTypes, states };
    }
    if (state.phase === 'SETTLEMENT') {
      const next = applyAction(state, { type: 'NEXT_DEAL' }, config, { recordEvents: false });
      if (!next.ok) throw new Error(`NEXT_DEAL 失败: ${next.code} ${next.message}`);
      state = next.state;
      continue;
    }
    const seat = getCurrentSeat(state);
    expect(seat).toBeTruthy();
    const rng = createRng((seed + guard * 131 + state.dealNo) >>> 0);
    const action = chooseAiAction(state, config, seat!, rng, { difficulty });
    expect(action, `difficulty=${difficulty} phase=${state.phase}`).toBeTruthy();
    const result = applyAction(state, action!, config, { recordEvents: false });
    if (!result.ok) {
      throw new Error(`${difficulty} 产生非法动作: ${result.code} ${result.message}`);
    }
    actionTypes.add(action!.type);
    if (state.phase === 'PLAYING') states.push(state);
    decisions += 1;
    state = result.state;
    if (state.phase === 'SETTLEMENT') deals += 1;
  }
  return { deals, decisions, actionTypes, states };
}

function swapOpponentHands(state: GameState): GameState | null {
  const left = state.players.E.hand;
  const right = state.players.W.hand;
  if (left.length !== right.length) return null;
  return {
    ...state,
    players: {
      ...state.players,
      E: { ...state.players.E, hand: right },
      W: { ...state.players.W, hand: left },
    },
  };
}

describe('AI 人格与难度分级', () => {
  it('三个档位的单步动作 100% 合法', () => {
    for (const difficulty of ['L1', 'L2', 'L3'] as AiDifficulty[]) {
      const result = walk(difficulty, 2, 20261107);
      expect(result.decisions).toBeGreaterThan(100);
      expect(result.actionTypes.has('PLAY') || result.actionTypes.has('PAY_TRIBUTE')).toBe(true);
    }
  });

  it('同一局面固定种子下 L2 决策确定', () => {
    const states = walk('L2', 1, 20261108).states;
    const sample = states.find((state) => getCurrentSeat(state) !== 'S');
    expect(sample).toBeTruthy();
    const seat = getCurrentSeat(sample!)!;
    const first = chooseAiAction(sample!, config, seat, createRng(7), { difficulty: 'L2' });
    const second = chooseAiAction(sample!, config, seat, createRng(7), { difficulty: 'L2' });
    expect(second).toEqual(first);
  });

  it('信息边界：只交换两家隐藏手牌（张数相同）不改变决策', () => {
    const states = walk('L2', 2, 20261109).states;
    let checked = 0;
    for (const state of states) {
      const seat = getCurrentSeat(state);
      if (!seat || seat === 'E' || seat === 'W') continue;
      const swapped = swapOpponentHands(state);
      if (!swapped) continue;
      const original = chooseAiAction(state, config, seat, createRng(11), { difficulty: 'L2' });
      const changed = chooseAiAction(swapped, config, seat, createRng(11), { difficulty: 'L2' });
      expect(changed).toEqual(original);
      checked += 1;
      if (checked >= 3) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('人格参数存在差异，且每个座位都有明确牌风', () => {
    expect(PERSONA.E.params.aggression).toBeGreaterThan(PERSONA.N.params.aggression);
    expect(PERSONA.N.params.partnerSupport).toBeGreaterThan(PERSONA.E.params.partnerSupport);
    expect(PERSONA.N.style).toBe('稳健配合');
    expect(PERSONA.E.style).toBe('激进压制');
    expect(PERSONA.W.style).toBe('稳健控场');
  });

  it('L3 单步决策 P95 ≤ 150ms', () => {
    const states = walk('L2', 2, 20261110).states.slice(0, 300);
    expect(states.length).toBeGreaterThan(100);
    const durations: number[] = [];
    for (const state of states) {
      const seat = getCurrentSeat(state);
      if (!seat) continue;
      const rng = createRng(13);
      const started = performance.now();
      chooseAiAction(state, config, seat, rng, { difficulty: 'L3' });
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.floor(0.95 * (durations.length - 1))]!;
    expect(p95).toBeLessThanOrEqual(150);
  });

  it('L3 返回的动作可以直接应用到引擎', () => {
    const states = walk('L2', 1, 20261111).states;
    const sample = states.find((state) => getCurrentSeat(state) !== 'S');
    expect(sample).toBeTruthy();
    const seat = getCurrentSeat(sample!)! as Seat;
    // 搜索即使降级也必须给出可应用动作。
    const action = chooseAiAction(sample!, config, seat, createRng(17), { difficulty: 'L3' });
    expect(action).toBeTruthy();
    const result = applyAction(sample!, action!, config, { recordEvents: false });
    expect(result.ok).toBe(true);
  });

  it('难度元数据覆盖三档且 L3 有预算', () => {
    expect(Object.keys(DIFFICULTY)).toEqual(['L1', 'L2', 'L3']);
    expect(DIFFICULTY.L3.search).toBe('pimc');
    expect(DIFFICULTY.L3.budgetMs).toBeGreaterThan(0);
  });
});
