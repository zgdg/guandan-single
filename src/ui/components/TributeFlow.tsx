import type { ReactNode } from 'react';
import type { Card, GameState, Seat } from '../../core/types';
import type { RuleConfig } from '../../core/config';
import { getCurrentSeat, getLegalReturnCards, getLegalTributeCards } from '../../core/engine';
import { teamOf } from '../../core/cards';
import { resolveTributeLeader } from '../../core/tribute';
import { SEAT_SHORT, cardText, cornerRank, isRed, isWild, suitText } from '../labels';

function levelOf(state: GameState) {
  return state.levels[state.currentLevelTeam];
}

function seatText(seat: Seat): string {
  return SEAT_SHORT[seat];
}

/** 公开贡牌区的小牌面：只做展示，不回写状态。 */
function TributeCardFace({ card }: { card: Card }) {
  return (
    <span className={['tribute-card', isRed(card) ? 'tribute-card-red' : ''].join(' ')} aria-label={cardText(card)}>
      <span className="tribute-card-rank">{cornerRank(card)}</span>
      <span className="tribute-card-suit">{suitText(card)}</span>
    </span>
  );
}

/** 进贡/还贡是两个独立步骤，步骤条只表达当前进行到哪一步。 */
function stageOf(state: GameState): 'pay' | 'return' {
  const tribute = state.tribute!;
  return tribute.pendingPayers.length > 0 ? 'pay' : 'return';
}

function leaderOf(state: GameState): { seat: Seat; reason: string } {
  const tribute = state.tribute!;
  const seat = resolveTributeLeader(state.roundResult, tribute.relations, tribute.resisted);
  const double = state.roundResult?.isDoubleDown ?? false;
  return { seat, reason: double ? '贡给头游者先出' : '进贡者先出' };
}

/** 顶部公开区：谁向谁贡了什么牌、还了什么牌，双贡逐条区分。 */
export function TributeFlow({ state }: { state: GameState }) {
  const tribute = state.tribute;
  if (!tribute) return null;
  const stage = stageOf(state);
  const leader = leaderOf(state);
  const pendingPay = stage === 'pay';

  return (
    <div className="tribute-flow" role="status">
      <div className="tribute-flow-head">
        <strong className="tribute-flow-title">{pendingPay ? '进贡中' : '还贡中'}</strong>
        <div className="tribute-steps" aria-label="贡牌步骤">
          <span className={['tribute-step', pendingPay ? 'tribute-step-active' : 'tribute-step-done'].join(' ')}>
            1 进贡
          </span>
          <span className="tribute-step-sep">→</span>
          <span className={['tribute-step', pendingPay ? 'tribute-step-todo' : 'tribute-step-active'].join(' ')}>
            2 还贡
          </span>
          <span className="tribute-step-sep">→</span>
          <span className="tribute-step tribute-step-todo">3 首出</span>
        </div>
        <span className="tribute-leader">
          {tribute.relations.length > 0 ? `还贡后 ${seatText(leader.seat)} 先出（${leader.reason}）` : ''}
        </span>
      </div>

      <div className="tribute-rows">
        {tribute.relations.map((relation, index) => {
          const waitingPay = tribute.pendingPayers.includes(relation.payer);
          const waitingReturn =
            tribute.pendingRecipients.includes(relation.recipient) && !relation.returnedCard;
          return (
            <div
              key={`${relation.payer}-${relation.recipient}`}
              className={['tribute-rel', waitingPay || waitingReturn ? 'tribute-rel-active' : ''].join(' ')}
            >
              <div className="tribute-rel-line">
                {tribute.relations.length > 1 && <span className="tribute-rel-index">{index + 1}</span>}
                <span className="tribute-seat">{seatText(relation.payer)}</span>
                <span className="tribute-arrow">进贡 →</span>
                <span className={['tribute-seat', relation.recipient === 'S' ? 'tribute-seat-you' : ''].join(' ')}>
                  {seatText(relation.recipient)}
                </span>
                {relation.paidCard ? (
                  <>
                    <TributeCardFace card={relation.paidCard} />
                    {relation.recipient === 'S' && <span className="tribute-you-tag">已到你手牌</span>}
                  </>
                ) : (
                  <span className="tribute-pending">{waitingPay ? '待进贡' : '未进贡'}</span>
                )}
              </div>

              <div className="tribute-rel-line tribute-rel-return">
                <span className="tribute-seat">{seatText(relation.recipient)}</span>
                <span className="tribute-arrow">还贡 →</span>
                <span className={['tribute-seat', relation.payer === 'S' ? 'tribute-seat-you' : ''].join(' ')}>
                  {seatText(relation.payer)}
                </span>
                {relation.returnedCard ? (
                  <TributeCardFace card={relation.returnedCard} />
                ) : (
                  <span className="tribute-pending">{waitingReturn ? '待还贡' : '未还贡'}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 底部操作提示：说明轮到谁、可选范围、还贡不可选原因。 */
export function TributeGuide({ state, config }: { state: GameState; config: RuleConfig }) {
  const tribute = state.tribute;
  if (!tribute) return null;
  const level = levelOf(state);
  const current = getCurrentSeat(state);
  const stage = stageOf(state);
  const paying = tribute.pendingPayers.includes('S');
  const returning = tribute.pendingRecipients.includes('S');

  let main: ReactNode;
  let sub: string | null = null;

  if (paying) {
    const legal = getLegalTributeCards(state, 'S', config);
    const recipient = tribute.relations.find((relation) => relation.payer === 'S')?.recipient;
    main = (
      <>
        轮到你进贡{recipient ? `给 ${seatText(recipient)}` : ''}：请选手中最大的非红桃级牌
      </>
    );
    sub = legal.length > 1 ? `可进贡 ${legal.length} 张同牌力，任选一张` : null;
  } else if (returning) {
    const relation = tribute.relations.find((item) => item.recipient === 'S' && !item.returnedCard);
    const received = tribute.relations.find((item) => item.recipient === 'S' && item.paidCard)?.paidCard;
    const legal = getLegalReturnCards(state, 'S', config);
    const normal = state.players.S.hand.filter(
      (card) =>
        card.rank <= 10 &&
        (config.returnLevelCard || (card.rank !== level && !isWild(card, level))),
    );
    const fallback = normal.length === 0 && state.players.S.hand.length > 0;
    main = (
      <>
        {received && (
          <>
            你收到 {relation ? `${seatText(relation.payer)} 的 ` : ''}
            <b>{cardText(received)}</b>；
          </>
        )}
        请还一张给 {relation ? seatText(relation.payer) : '进贡者'}：
        <b>
          {fallback
            ? `全手牌都大于 10，只能还最小的一张 ${legal[0] ? cardText(legal[0]) : ''}`
            : `可还 ${legal.length} 张（牌点 ≤10）`}
        </b>
      </>
    );
    sub = fallback
      ? '灰牌不可还：牌点大于 10'
      : config.returnLevelCard
        ? '灰牌不可还：牌点 >10'
        : '灰牌不可还：牌点 >10 / 级牌 / 逢人配';
  } else {
    main =
      stage === 'pay'
        ? `等待 ${current ? seatText(current) : '…'} 进贡…`
        : `等待 ${current ? seatText(current) : '…'} 还贡…`;
  }

  return (
    <div className="tribute-guide">
      <span className="tribute-guide-main">{main}</span>
      {sub && <span className="tribute-guide-sub">{sub}</span>}
    </div>
  );
}

/** 抗贡/内贡跳过的一次性说明，按本副第一圈展示，不做后续常驻。 */
export function TributeNotice({ state }: { state: GameState }) {
  const tribute = state.tribute;
  const prev = state.roundResult;
  if (!tribute || !prev) return null;

  if (tribute.resisted) {
    const lastSeat =
      prev.lastSeat ??
      (Object.keys(prev.outOrder) as Seat[]).find((seat) => prev.outOrder[seat] === 4) ??
      null;
    const payers = prev.isDoubleDown
      ? (['S', 'N', 'E', 'W'] as Seat[]).filter((seat) => teamOf(seat) !== prev.winnerTeam)
      : lastSeat
        ? [lastSeat]
        : [];
    return (
      <div className="tribute-notice" role="status">
        <strong>抗贡</strong>
        <span>
          {payers.length > 1 ? '双下方合计' : payers.length === 1 ? seatText(payers[0]!) : '应进贡方'}
          抓到两张大王，本副免进贡、免还贡；
        </span>
        <span className="tribute-notice-leader">头游 {seatText(prev.headSeat)} 先出。</span>
      </div>
    );
  }

  if (prev.isDoubleDown || tribute.relations.length > 0) return null;
  const lastSeat =
    prev.lastSeat ??
    (Object.keys(prev.outOrder) as Seat[]).find((seat) => prev.outOrder[seat] === 4) ??
    null;
  // 没有关系且不是抗贡，只可能是内贡被关闭后跳过本副。
  if (!lastSeat || teamOf(lastSeat) !== teamOf(prev.headSeat)) return null;
  return (
    <div className="tribute-notice" role="status">
      <strong>内贡已关闭</strong>
      <span>末游与头游同队，本副免进贡、免还贡；</span>
      <span className="tribute-notice-leader">头游 {seatText(prev.headSeat)} 先出。</span>
    </div>
  );
}

/** 手牌不可选原因：用于灰牌的 title / aria，不影响引擎判定。 */
export function tributeCardReasons(state: GameState, config: RuleConfig): Record<string, string> {
  const tribute = state.tribute;
  if (state.phase !== 'TRIBUTE' || !tribute) return {};
  const level = levelOf(state);
  const reasons: Record<string, string> = {};

  if (tribute.pendingPayers.includes('S')) {
    const legal = new Set(getLegalTributeCards(state, 'S', config).map((card) => card.id));
    for (const card of state.players.S.hand) {
      if (legal.has(card.id)) continue;
      reasons[card.id] = isWild(card, level) ? '逢人配不能进贡' : '不是最大的非红桃级牌';
    }
  }

  if (tribute.pendingRecipients.includes('S')) {
    const legal = new Set(getLegalReturnCards(state, 'S', config).map((card) => card.id));
    for (const card of state.players.S.hand) {
      if (legal.has(card.id)) continue;
      if (isWild(card, level)) reasons[card.id] = '逢人配不能还贡';
      else if (card.rank === level) reasons[card.id] = '级牌不能还贡';
      else if (card.rank > 10) reasons[card.id] = '牌点超过 10';
      else reasons[card.id] = '不在可还范围';
    }
  }

  return reasons;
}

/** 本副是否仍处在第一圈（用于抗贡提示的展示时长）。 */
export function isFirstTrick(state: GameState): boolean {
  let lastDeal = -1;
  state.events.forEach((event, index) => {
    if (event.type === 'DEAL') lastDeal = index;
  });
  return state.events.slice(lastDeal + 1).every((event) => event.type !== 'TRICK_END');
}
