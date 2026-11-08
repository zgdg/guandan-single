import { describe, expect, it } from 'vitest';
import { applyAction, createGame, getCurrentSeat } from '../../src/core/engine';
import { mergeRuleConfig } from '../../src/core/config';
import { chooseAction } from '../../src/ai/simple';
import { createRng } from '../../src/core/cards';
import { selectorForSuggestion, suggestForHuman } from '../../src/suggest/static';

describe('P1 静态建议合法性', () => {
  it('每种抽样局面下建议都是合法动作（出牌能通过引擎校验，过牌符合规则）', () => {
    const config = mergeRuleConfig();
    for (let seed = 1; seed <= 8; seed += 1) {
      let state = createGame(seed, config, { recordEvents: false });
      const rng = createRng(seed);
      for (let step = 0; step < 260; step += 1) {
        if (state.phase === 'GAME_OVER') break;
        if (state.phase === 'SETTLEMENT') {
          const next = applyAction(state, { type: 'NEXT_DEAL' }, config, { recordEvents: false });
          expect(next.ok).toBe(true);
          if (!next.ok) break;
          state = next.state;
          continue;
        }
        const seat = getCurrentSeat(state);
        if (!seat) break;

        if (seat === 'S' && state.phase === 'PLAYING') {
          const suggestion = suggestForHuman(state, config);
          if (suggestion.action === 'PASS') {
            expect(state.trick.lastPlay).not.toBeNull();
            const result = applyAction(state, { type: 'PASS', seat: 'S' }, config, {
              recordEvents: false,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) break;
            state = result.state;
            continue;
          }
          const handIds = new Set(state.players.S.hand.map((card) => card.id));
          for (const card of suggestion.cards) expect(handIds.has(card.id)).toBe(true);
          const selector = selectorForSuggestion(suggestion);
          const result = applyAction(
            state,
            { type: 'PLAY', seat: 'S', cards: suggestion.cards, ...(selector ? { selector } : {}) },
            config,
            { recordEvents: false },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) break;
          state = result.state;
          continue;
        }

        const action = chooseAction(state, config, rng, { followRate: 0.7 });
        if (!action) break;
        const result = applyAction(state, action, config, { recordEvents: false });
        expect(result.ok).toBe(true);
        if (!result.ok) break;
        state = result.state;
      }
    }
  });
});
