import { describe, expect, it } from 'vitest';
import type { Card, GameState, Level, Pattern, Seat } from '../../src/core/types';
import { createDeck } from '../../src/core/cards';
import {
  applyAction,
  assertCardConservation,
  checkPlay,
  createGame,
  getLegalPlays,
  getLegalReturnCards,
  getLegalTributeCards,
  needsReport,
  toAIView,
  stateHash,
} from '../../src/core/engine';
import { beats } from '../../src/core/compare';
import { createRng } from '../../src/core/cards';
import { chooseAction } from '../../src/ai/simple';
import { CONFIG, cards, configWith } from '../helpers/cards';

function cardByRank(hand: Card[], rank: number): Card {
  const found = hand.find((card) => card.rank === rank);
  if (!found) throw new Error(`手牌中找不到牌点 ${rank}`);
  return found;
}

function makeState(
  hands: Record<Seat, string>,
  options: { leader?: Seat; level?: number; config?: Partial<typeof CONFIG> } = {},
): GameState {
  const config = options.config ? configWith(options.config) : CONFIG;
  const state = createGame(12345, config, { recordEvents: false });
  for (const seat of ['S', 'E', 'N', 'W'] as Seat[]) {
    state.players[seat].hand = cards(hands[seat]);
    state.players[seat].outOrder = null;
  }
  const leader = options.leader ?? 'S';
  const level = (options.level ?? 2) as Level;
  state.levels = { NS: level, WE: level };
  state.currentLevelTeam = 'NS';
  state.trick = { leader, turn: leader, lastPlay: null, passedSeats: [], history: [] };
  state.playedCards = [];
  state.phase = 'PLAYING';
  return state;
}

function singlePrev(headSeat: Seat, secondSeat: Seat, thirdSeat: Seat, lastSeat: Seat) {
  const outOrder: Record<Seat, number | null> = { S: null, W: null, N: null, E: null };
  outOrder[headSeat] = 1;
  outOrder[secondSeat] = 2;
  outOrder[thirdSeat] = 3;
  outOrder[lastSeat] = 4;
  return {
    dealNo: 1,
    headSeat,
    secondSeat,
    lastSeat,
    outOrder,
    winnerTeam: headSeat === 'S' || headSeat === 'N' ? 'NS' as const : 'WE' as const,
    upgrade: 1,
    isDoubleDown: false,
    passA: false,
    aFailed: false,
  };
}

function tributeState(): GameState {
  const state = createGame(1, CONFIG, { recordEvents: false });
  state.phase = 'TRIBUTE';
  state.levels = { NS: 7, WE: 2 };
  state.currentLevelTeam = 'NS';
  // 用真实牌库构造手牌，保证进贡/还贡后仍可通过 108 张守恒校验。
  const deck = createDeck();
  const take = (id: string): Card => {
    const card = deck.find((item) => item.id === id);
    if (!card) throw new Error(`牌库中找不到 ${id}`);
    return card;
  };
  const southHand = [take('0-S-14'), take('0-S-3'), take('0-S-5')];
  const eastHand = [take('1-S-14'), take('1-S-3')];
  state.players.S.hand = southHand;
  state.players.E.hand = eastHand;
  state.players.N.hand = [];
  state.players.W.hand = [];
  const heldIds = new Set([...southHand, ...eastHand].map((card) => card.id));
  state.playedCards = deck.filter((card) => !heldIds.has(card.id));
  state.tribute = {
    relations: [{ payer: 'E', recipient: 'S' }],
    resisted: false,
    pendingPayers: ['E'],
    pendingRecipients: [],
  };
  state.roundResult = singlePrev('S', 'W', 'N', 'E');
  return state;
}

describe('对局创建与牌数守恒', () => {
  it('首副每人 27 张，合计 108 张唯一牌', () => {
    const state = createGame(2026, CONFIG, { recordEvents: false });
    expect(state.phase).toBe('PLAYING');
    expect(state.dealNo).toBe(1);
    expect(state.levels).toEqual({ NS: 2, WE: 2 });
    expect(state.currentLevelTeam).toBe('NS');
    for (const seat of ['S', 'E', 'N', 'W'] as Seat[]) {
      expect(state.players[seat].hand).toHaveLength(27);
    }
    assertCardConservation(state);
  });

  it('首副首出可配置为固定 S', () => {
    const config = configWith({ firstDealLeader: 'seatS' });
    const state = createGame(99, config, { recordEvents: false });
    expect(state.trick.leader).toBe('S');
    expect(state.trick.turn).toBe('S');
  });
});

describe('出牌/过牌/一圈', () => {
  it('领出者不能过牌', () => {
    const state = makeState({ S: 'S3 S4', E: 'S5', N: 'S6', W: 'S7' });
    const result = applyAction(state, { type: 'PASS', seat: 'S' }, CONFIG, { recordEvents: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('E_LEADER_CANNOT_PASS');
  });

  it('三人过牌后本圈结束，最后出牌者领出下一圈', () => {
    const state = makeState({ S: 'S3 S4', E: 'S5', N: 'S6', W: 'S7' });
    const play = applyAction(
      state,
      { type: 'PLAY', seat: 'S', cards: [cardByRank(state.players.S.hand, 3)] },
      CONFIG,
      { recordEvents: false },
    );
    expect(play.ok).toBe(true);
    if (!play.ok) return;
    let current = play.state;
    for (const seat of ['E', 'N', 'W'] as Seat[]) {
      const pass = applyAction(current, { type: 'PASS', seat }, CONFIG, { recordEvents: false });
      expect(pass.ok).toBe(true);
      if (pass.ok) current = pass.state;
    }
    expect(current.trick.leader).toBe('S');
    expect(current.trick.turn).toBe('S');
    expect(current.trick.lastPlay).toBeNull();
    expect(current.playedCards).toHaveLength(1);
  });

  it('接风：最后出牌者出完时由搭档领出', () => {
    const state = makeState({ S: 'S3', E: 'S5 S6', N: 'S4 S7', W: 'S8 S9' });
    let current = state;
    const play = applyAction(
      current,
      { type: 'PLAY', seat: 'S', cards: [cardByRank(current.players.S.hand, 3)] },
      CONFIG,
      { recordEvents: false },
    );
    if (!play.ok) throw new Error(play.message);
    current = play.state;
    for (const seat of ['E', 'N', 'W'] as Seat[]) {
      const pass = applyAction(current, { type: 'PASS', seat }, CONFIG, { recordEvents: false });
      if (!pass.ok) throw new Error(pass.message);
      current = pass.state;
    }
    expect(current.players.S.outOrder).toBe(1);
    expect(current.trick.leader).toBe('N');
    expect(current.trick.turn).toBe('N');
  });

  it('双下提前结束：头游+二游同队立即结算并升 3 级', () => {
    const state = makeState({ S: 'S3', E: 'S5 S6', N: 'S4', W: 'S7 S8' });
    let current = state;
    const play = applyAction(
      current,
      { type: 'PLAY', seat: 'S', cards: [cardByRank(current.players.S.hand, 3)] },
      CONFIG,
      { recordEvents: false },
    );
    if (!play.ok) throw new Error(play.message);
    current = play.state;
    for (const seat of ['E', 'N', 'W'] as Seat[]) {
      const pass = applyAction(current, { type: 'PASS', seat }, CONFIG, { recordEvents: false });
      if (!pass.ok) throw new Error(pass.message);
      current = pass.state;
    }
    const secondPlay = applyAction(
      current,
      { type: 'PLAY', seat: 'N', cards: [cardByRank(current.players.N.hand, 4)] },
      CONFIG,
      { recordEvents: false },
    );
    if (!secondPlay.ok) throw new Error(secondPlay.message);
    current = secondPlay.state;
    expect(current.phase).toBe('SETTLEMENT');
    expect(current.roundResult?.isDoubleDown).toBe(true);
    expect(current.roundResult?.upgrade).toBe(3);
    expect(current.roundResult?.lastSeat).toBeNull();
    expect(current.levels.NS).toBe(5);
    expect(current.currentLevelTeam).toBe('NS');
  });

  it('关闭双下提前结束后，二游同队仍继续打三游/末游', () => {
    const config = configWith({ doubleDownEarlyEnd: false });
    const state = makeState({ S: 'S3', E: 'S5', N: 'S4', W: 'S6' }, { config });
    let current = state;
    const play = applyAction(
      current,
      { type: 'PLAY', seat: 'S', cards: [cardByRank(current.players.S.hand, 3)] },
      config,
      { recordEvents: false },
    );
    if (!play.ok) throw new Error(play.message);
    current = play.state;
    for (const seat of ['E', 'N', 'W'] as Seat[]) {
      const pass = applyAction(current, { type: 'PASS', seat }, config, { recordEvents: false });
      if (!pass.ok) throw new Error(pass.message);
      current = pass.state;
    }
    const secondPlay = applyAction(
      current,
      { type: 'PLAY', seat: 'N', cards: [cardByRank(current.players.N.hand, 4)] },
      config,
      { recordEvents: false },
    );
    if (!secondPlay.ok) throw new Error(secondPlay.message);
    current = secondPlay.state;
    expect(current.phase).toBe('PLAYING');
    expect(current.players.N.outOrder).toBe(2);
    expect(current.trick.turn).toBe('W');

    const thirdPlay = applyAction(
      current,
      { type: 'PLAY', seat: 'W', cards: [cardByRank(current.players.W.hand, 6)] },
      config,
      { recordEvents: false },
    );
    if (!thirdPlay.ok) throw new Error(thirdPlay.message);
    current = thirdPlay.state;
    expect(current.phase).toBe('SETTLEMENT');
    expect(current.roundResult?.lastSeat).toBe('E');
    expect(current.players.E.outOrder).toBe(4);
    expect(current.roundResult?.isDoubleDown).toBe(true);
  });

  it('已过牌的玩家不能再出牌（防守性校验）', () => {
    const state = makeState({ S: 'S3', E: 'S4 S5', N: 'S6', W: 'S7' });
    state.trick.passedSeats = ['E'];
    state.trick.turn = 'E';
    const check = checkPlay(state, 'E', [cardByRank(state.players.E.hand, 5)], CONFIG);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_ALREADY_PASSED');
  });
});

describe('出牌校验', () => {
  it('不是当前回合不能出牌', () => {
    const state = makeState({ S: 'S3', E: 'S4', N: 'S5', W: 'S6' });
    const check = checkPlay(state, 'E', [cardByRank(state.players.E.hand, 4)], CONFIG);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_NOT_YOUR_TURN');
  });

  it('不能出不在自己手里的牌', () => {
    const state = makeState({ S: 'S3', E: 'S4', N: 'S5', W: 'S6' });
    const check = checkPlay(state, 'S', [cardByRank(state.players.E.hand, 4)], CONFIG);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_CARD_NOT_OWNED');
  });

  it('同一张牌不能重复使用', () => {
    const state = makeState({ S: 'S3 S4', E: 'S4', N: 'S5', W: 'S6' });
    const card = cardByRank(state.players.S.hand, 3);
    const check = checkPlay(state, 'S', [card, card], CONFIG);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_DUPLICATE_CARD');
  });

  it('无效牌型被拒绝', () => {
    const state = makeState({ S: 'S3 S4 S5 S6 S8', E: 'S4', N: 'S5', W: 'S6' });
    const check = checkPlay(
      state,
      'S',
      state.players.S.hand,
      CONFIG,
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_INVALID_PATTERN');
  });

  it('多个解释时必须声明', () => {
    const state = makeState({ S: 'S3 H3 H7 H4 C4', E: 'S4', N: 'S5', W: 'S6' }, { level: 7 });
    const check = checkPlay(state, 'S', state.players.S.hand, CONFIG);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_AMBIGUOUS_PATTERN');
    const selected = checkPlay(state, 'S', state.players.S.hand, CONFIG, {
      type: 'FULL_HOUSE',
      tripleRank: 3,
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(selected.pattern.type).toBe('FULL_HOUSE');
  });

  it('普通牌型必须同型同张数且更大', () => {
    const state = makeState({ S: 'SA HA', E: 'S3 H3', N: 'S5', W: 'S6' });
    const first = applyAction(
      state,
      { type: 'PLAY', seat: 'S', cards: state.players.S.hand },
      CONFIG,
      { recordEvents: false },
    );
    if (!first.ok) throw new Error(first.message);
    const check = checkPlay(first.state, 'E', first.state.players.E.hand, CONFIG);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe('E_CANNOT_BEAT');
  });

  it('炸弹可以跨牌型压普通牌型', () => {
    const state = makeState({ S: 'SA HA', E: 'S3 H3 C3 D3', N: 'S5', W: 'S6' });
    let current = state;
    const first = applyAction(
      current,
      { type: 'PLAY', seat: 'S', cards: current.players.S.hand },
      CONFIG,
      { recordEvents: false },
    );
    if (!first.ok) throw new Error(first.message);
    current = first.state;
    const bomb = applyAction(
      current,
      { type: 'PLAY', seat: 'E', cards: current.players.E.hand },
      CONFIG,
      { recordEvents: false },
    );
    expect(bomb.ok).toBe(true);
    if (bomb.ok) expect(bomb.state.trick.lastPlay?.pattern.type).toBe('BOMB');
  });

  it('合法枚举只给出能压过上一手的牌', () => {
    const state = makeState({ S: 'SA HA', E: 'S3 H3 C3 D3 S5', N: 'S5', W: 'S6' });
    const first = applyAction(
      state,
      { type: 'PLAY', seat: 'S', cards: state.players.S.hand },
      CONFIG,
      { recordEvents: false },
    );
    if (!first.ok) throw new Error(first.message);
    const last = first.state.trick.lastPlay!.pattern;
    const result = getLegalPlays(first.state, CONFIG, 'E');
    expect(result.options.length).toBeGreaterThan(0);
    for (const option of result.options) {
      expect(beats(option.pattern, last, CONFIG)).toBe(true);
    }
  });
});

describe('进贡/还贡状态机', () => {
  it('只能进贡最大的非红桃级牌', () => {
    const state = tributeState();
    const legal = getLegalTributeCards(state, 'E', CONFIG);
    expect(legal.map((card) => card.rank)).toEqual([14]);
    const wrong = applyAction(
      state,
      { type: 'PAY_TRIBUTE', seat: 'E', cardId: cardByRank(state.players.E.hand, 3).id },
      CONFIG,
      { recordEvents: false },
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('E_TRIBUTE_CARD_INVALID');
  });

  it('还贡必须还符合规则的牌', () => {
    const state = tributeState();
    const paid = applyAction(
      state,
      { type: 'PAY_TRIBUTE', seat: 'E', cardId: cardByRank(state.players.E.hand, 14).id },
      CONFIG,
      { recordEvents: false },
    );
    if (!paid.ok) throw new Error(paid.message);
    const afterPay = paid.state;
    expect(afterPay.tribute?.pendingRecipients).toEqual(['S']);
    expect(getLegalReturnCards(afterPay, 'S', CONFIG).map((card) => card.rank).sort()).toEqual([3, 5]);
    const wrong = applyAction(
      afterPay,
      { type: 'RETURN_TRIBUTE', seat: 'S', cardId: cardByRank(afterPay.players.S.hand, 14).id },
      CONFIG,
      { recordEvents: false },
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('E_TRIBUTE_CARD_INVALID');
  });

  it('完成进贡与还贡后进入出牌阶段，由进贡者领出', () => {
    const state = tributeState();
    let current = state;
    const paid = applyAction(
      current,
      { type: 'PAY_TRIBUTE', seat: 'E', cardId: cardByRank(current.players.E.hand, 14).id },
      CONFIG,
      { recordEvents: false },
    );
    if (!paid.ok) throw new Error(paid.message);
    current = paid.state;
    const returned = applyAction(
      current,
      { type: 'RETURN_TRIBUTE', seat: 'S', cardId: cardByRank(current.players.S.hand, 3).id },
      CONFIG,
      { recordEvents: false },
    );
    if (!returned.ok) throw new Error(returned.message);
    current = returned.state;
    expect(current.phase).toBe('PLAYING');
    expect(current.trick.leader).toBe('E');
    expect(current.trick.turn).toBe('E');
    assertCardConservation(current);
  });

  it('非进贡阶段不能支付贡牌', () => {
    const state = createGame(3, CONFIG, { recordEvents: false });
    const result = applyAction(
      state,
      { type: 'PAY_TRIBUTE', seat: 'E', cardId: state.players.E.hand[0]!.id },
      CONFIG,
      { recordEvents: false },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('E_WRONG_PHASE');
  });
});

describe('信息隔离、回放与流程守卫', () => {
  it('AIView 只暴露自己的手牌', () => {
    const state = createGame(8, CONFIG, { recordEvents: false });
    const view = toAIView(state, 'S');
    expect(view.myHand).toHaveLength(27);
    for (const seat of ['S', 'E', 'N', 'W'] as Seat[]) {
      expect(Object.keys(view.players[seat])).not.toContain('hand');
      expect(view.players[seat].handCount).toBe(27);
    }
    expect(JSON.stringify(view)).not.toContain('"hand":');
  });

  it('同 seed 同动作序列得到相同状态摘要', () => {
    const config = CONFIG;
    let left = createGame(4242, config, { recordEvents: false });
    let right = createGame(4242, config, { recordEvents: false });
    expect(stateHash(left)).toBe(stateHash(right));
    const rng = createRng(777);
    for (let step = 0; step < 50; step += 1) {
      const action = chooseAction(left, config, rng);
      if (!action) break;
      const leftResult = applyAction(left, action, config, { recordEvents: false });
      const rightResult = applyAction(right, action, config, { recordEvents: false });
      if (!leftResult.ok) throw new Error(leftResult.message);
      if (!rightResult.ok) throw new Error(rightResult.message);
      left = leftResult.state;
      right = rightResult.state;
      expect(stateHash(left)).toBe(stateHash(right));
    }
  });

  it('剩余 10 张及以下触发报牌提示，11 张不触发', () => {
    const state = createGame(9, CONFIG, { recordEvents: false });
    state.players.S.hand = cards('S3 H3 C3 D3 S4 H4 C4 D4 S5 H5');
    expect(needsReport(state, 'S', CONFIG)).toBe(true);
    state.players.S.hand = cards('S3 H3 C3 D3 S4 H4 C4 D4 S5 H5 C5');
    expect(needsReport(state, 'S', CONFIG)).toBe(false);
    state.players.S.hand = [];
    expect(needsReport(state, 'S', CONFIG)).toBe(false);
  });

  it('未结算时不能进入下一副', () => {
    const state = createGame(5, CONFIG, { recordEvents: false });
    const result = applyAction(state, { type: 'NEXT_DEAL' }, CONFIG, { recordEvents: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('E_WRONG_PHASE');
  });
});
