import type { GameState, Seat } from '../../core/types';
import { PERSONA, SEAT_LABEL, SEAT_SHORT, cornerRank, isRed, placeText, suitText } from '../labels';

interface Props {
  seat: Seat;
  state: GameState;
  current: boolean;
  compact?: boolean;
}

function pressureLevel(count: number): '' | 'mid' | 'low' | 'critical' {
  if (count <= 4) return 'critical';
  if (count <= 8) return 'low';
  if (count <= 14) return 'mid';
  return '';
}

export function SeatPanel({ seat, state, current, compact }: Props) {
  const player = state.players[seat];
  const persona = seat === 'S' ? null : PERSONA[seat];
  const passed = state.trick.passedSeats.includes(seat);
  const out = placeText(player.outOrder);
  const label = compact ? SEAT_SHORT[seat] : SEAT_LABEL[seat];
  const count = player.hand.length;
  const ratio = Math.max(0, Math.min(1, count / 27));
  const pressure = pressureLevel(count);

  const played = state.trick.lastPlay?.seat === seat && !passed;

  return (
    <div
      className={[
        'seat-panel',
        played ? 'seat-played' : '',
        current ? 'seat-current' : '',
        player.outOrder ? 'seat-out' : '',
      ].join(' ')}
    >
      <div className="seat-avatar">{seat === 'S' ? '你' : persona?.name.slice(0, 1)}</div>
      <div className="seat-meta">
        <div className="seat-name">
          <span className="seat-name-full">{label}</span>
          <span className="seat-name-short">{SEAT_LABEL[seat].split(' · ')[0]}</span>
          {persona && <span className="seat-style">{persona.style}</span>}
        </div>
        <div className="seat-count">
          {player.outOrder ? (
            <span className="seat-place">{out}</span>
          ) : (
            <>
              <strong>{count}</strong> 张
              {current && (
                <span className="seat-state seat-thinking">
                  {compact ? '出牌' : seat === 'S' ? '轮到你' : '出牌中'}
                </span>
              )}
              {passed && !current && (
                <span className="seat-state seat-pass">{compact ? '过' : '已过'}</span>
              )}
            </>
          )}
        </div>
        {!player.outOrder && (
          <div className={['seat-progress', pressure ? `seat-progress-${pressure}` : ''].join(' ')}>
            <i style={{ width: `${Math.round(ratio * 100)}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

/** 座位跟前的小牌：最多 6 个牌位，超出显示前 5 张 + 「+N」；已过显示「过」占位。 */
const MINI_SLOTS = 6;

export function SeatLast({ seat, state }: { seat: Seat; state: GameState }) {
  const passed = state.trick.passedSeats.includes(seat);
  const plays = state.trick.history.filter((record) => record.seat === seat);
  const mine = plays.length > 0 ? plays[plays.length - 1] : null;
  const top = !passed && state.trick.lastPlay?.seat === seat;
  const cards = passed || !mine ? [] : mine.cards;
  const shown = cards.length > MINI_SLOTS ? cards.slice(0, MINI_SLOTS - 1) : cards;
  const more = cards.length - shown.length;

  return (
    <div className={['seat-last', top ? 'seat-last-top' : '', passed ? 'seat-last-passed' : ''].join(' ')}>
      {passed ? (
        <span className="seat-last-pass">过</span>
      ) : cards.length === 0 ? (
        <span className="seat-last-idle" aria-hidden="true" />
      ) : (
        <span className="seat-last-cards">
          {shown.map((card) => {
            const rank = cornerRank(card);
            return (
              <span
                key={card.id}
                className={['seat-mini', isRed(card) ? 'seat-mini-red' : ''].join(' ')}
              >
                <span className={['seat-mini-rank', rank.length > 1 ? 'seat-mini-rank-wide' : ''].join(' ')}>
                  {rank}
                </span>
                <span className="seat-mini-suit">{suitText(card)}</span>
              </span>
            );
          })}
          {more > 0 && <span className="seat-mini seat-mini-more">+{more}</span>}
        </span>
      )}
    </div>
  );
}
