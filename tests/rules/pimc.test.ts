import { describe, expect, it } from 'vitest';
import type { Card, GameState, PatternSelector } from '../../src/core/types';
import { mergeRuleConfig } from '../../src/core/config';
import { applyAction, createGame, getCurrentSeat } from '../../src/core/engine';
import { chooseAction, selectorOf } from '../../src/ai/simple';
import { createRng } from '../../src/core/cards';
import { runPimc } from '../../src/suggest/pimc';

const config = mergeRuleConfig();

type HumanAction =
  | { type: 'PASS'; seat: 'S' }
  | { type: 'PLAY'; seat: 'S'; cards: Card[]; selector?: PatternSelector };

/** 走牌局；轮到 S 出牌时交给回调，返回 null 则改用 L1 AI。 */
function walk(
  seed: number,
  maxDeals: number,
  onHumanTurn: (state: GameState) => HumanAction | null,
): GameState {
  let state = createGame(seed, config, { recordEvents: false });
  const rng = createRng(seed * 17 + 3);
  let deals = 0;
  for (let step = 0; step < 4000; step += 1) {
    if (state.phase === 'SETTLEMENT') {
      deals += 1;
      if (deals >= maxDeals) return state;
      const next = applyAction(state, { type: 'NEXT_DEAL' }, config, { recordEvents: false });
      if (!next.ok) return state;
      state = next.state;
      continue;
    }
    if (state.phase === 'GAME_OVER') return state;
    const seat = getCurrentSeat(state);
    if (!seat) return state;

    const humanAction =
      seat === 'S' && state.phase === 'PLAYING' ? onHumanTurn(state) : null;
    const action = humanAction ?? chooseAction(state, config, rng, { followRate: 0.7 });
    if (!action) return state;
    const result = applyAction(state, action, config, { recordEvents: false });
    if (!result.ok) throw new Error(`非法动作 ${result.code}: ${result.message}`);
    state = result.state;
  }
  return state;
}

function actionFromPimc(state: GameState): HumanAction {
  const result = runPimc(state, config, 'S');
  const suggestion = result.suggestion;
  if (suggestion.action === 'PASS') {
    if (state.trick.lastPlay === null) throw new Error('领出时建议过牌');
    return { type: 'PASS', seat: 'S' };
  }
  const handIds = new Set(state.players.S.hand.map((card) => card.id));
  for (const card of suggestion.cards) expect(handIds.has(card.id)).toBe(true);
  const selector = suggestion.option ? selectorOf(suggestion.option.pattern) : undefined;
  return { type: 'PLAY', seat: 'S', cards: suggestion.cards, ...(selector ? { selector } : {}) };
}

describe('PIMC 建议', () => {
  it(
    '抽样对局中建议 100% 合法且不会卡死',
    () => {
      let calls = 0;
      for (let seed = 1; seed <= 5; seed += 1) {
        walk(seed, 2, (state) => {
          calls += 1;
          return actionFromPimc(state);
        });
      }
      expect(calls).toBeGreaterThan(30);
    },
    60000,
  );

  it('同一公开局面同版本的建议完全一致（固定 seed）', () => {
    for (let seed = 1; seed <= 4; seed += 1) {
      let compared = 0;
      walk(seed, 1, (state) => {
        if (compared >= 3) return null;
        const first = runPimc(state, config, 'S');
        const second = runPimc(state, config, 'S');
        expect(second.suggestion.action).toBe(first.suggestion.action);
        expect(second.suggestion.cards.map((card) => card.id)).toEqual(
          first.suggestion.cards.map((card) => card.id),
        );
        expect(second.suggestion.title).toBe(first.suggestion.title);
        compared += 1;
        return actionFromPimc(state);
      });
    }
  });

  it('信息边界：剩余张数相同的两家交换真实手牌，建议完全不变', () => {
    let total = 0;
    for (let seed = 1; seed <= 8; seed += 1) {
      let compared = 0;
      walk(seed, 1, (state) => {
        if (compared >= 1) return null;
        // 公开剩余张数必须一致，否则交换手牌等于改变公开信息。
        if (state.players.E.outOrder !== null || state.players.W.outOrder !== null) return null;
        if (state.players.E.hand.length !== state.players.W.hand.length) return null;
        const swapped: GameState = {
          ...state,
          players: {
            ...state.players,
            E: { ...state.players.E, hand: state.players.W.hand },
            W: { ...state.players.W, hand: state.players.E.hand },
          },
        };
        const first = runPimc(state, config, 'S');
        const second = runPimc(swapped, config, 'S');
        expect(second.suggestion.action).toBe(first.suggestion.action);
        expect(second.suggestion.cards.map((card) => card.id)).toEqual(
          first.suggestion.cards.map((card) => card.id),
        );
        compared += 1;
        total += 1;
        return actionFromPimc(state);
      });
    }
    expect(total).toBeGreaterThanOrEqual(1);
  });

  it('时间预算不足时降级为更少粒子，仍给出合法建议并标记 degraded', () => {
    let checked = 0;
    walk(1, 1, (state) => {
      if (checked >= 1) return null;
      const result = runPimc(state, config, 'S', {
        particles: 8,
        minParticles: 2,
        budgetMs: 0,
      });
      expect(result.degraded).toBe(true);
      expect(result.degradeReason).not.toBeNull();
      expect(result.particles).toBeLessThanOrEqual(2);
      expect(result.suggestion.degraded).toBe(true);
      checked += 1;
      return actionFromPimc(state);
    });
  });

  it('非出牌阶段直接回退静态建议', () => {
    const state = walk(1, 1, () => null);
    expect(state.phase === 'SETTLEMENT' || state.phase === 'GAME_OVER').toBe(true);
    const result = runPimc(state, config, 'S');
    expect(result.degraded).toBe(true);
    expect(result.suggestion.engine).toBe('static');
  });

  it('默认参数下 P95 ≤ 150ms（桌面基线，移动端另有 Worker 与降级）', () => {
    const samples: number[] = [];
    for (let seed = 1; seed <= 3; seed += 1) {
      walk(seed, 1, (state) => {
        if (samples.length >= 40) return null;
        const started = performance.now();
        runPimc(state, config, 'S');
        samples.push(performance.now() - started);
        return actionFromPimc(state);
      });
    }
    expect(samples.length).toBeGreaterThanOrEqual(20);
    const sorted = [...samples].sort((left, right) => left - right);
    const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)]!;
    expect(p95).toBeLessThanOrEqual(150);
  }, 60000);
});
