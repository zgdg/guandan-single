import type { GameState, Seat, Team } from '../../core/types';
import { SEAT_SHORT } from '../labels';

interface Props {
  state: GameState;
  onNext: () => void;
  onNewGame: () => void;
  onRestartDeal: () => void;
  onReview: () => void;
}

const PLACES = [1, 2, 3, 4] as const;

function seatAt(state: GameState, place: number): Seat | null {
  for (const seat of ['S', 'N', 'E', 'W'] as const) {
    if (state.players[seat].outOrder === place) return seat;
  }
  return null;
}

function teamName(team: Team): string {
  return team === 'NS' ? '你方（南/北）' : '对方（东/西）';
}

export function SettlementPanel({ state, onNext, onNewGame, onRestartDeal, onReview }: Props) {
  const result = state.roundResult;
  if (!result) return null;
  const over = state.phase === 'GAME_OVER';
  const ours = result.winnerTeam === 'NS';
  const capped = state.levels[result.winnerTeam] === 14;
  return (
    <div className="settlement-mask">
      <div className="settlement">
        <div className="settlement-head">
          <span className="settlement-kicker">第 {result.dealNo} 副结算</span>
          <h2>{over ? (ours ? '过 A 成功，本局结束' : '对方过 A，本局结束') : '本副结束'}</h2>
          <p>
            {result.isDoubleDown ? '双下：头游 + 二游同队，本副提前结束。' : '按名次结算升级。'}
            {result.aFailed ? ' 打 A 失败，本副未过 A。' : ''}
          </p>
        </div>

        <div className="place-list">
          {PLACES.map((place) => {
            const seat = seatAt(state, place);
            const label = ['头游', '二游', '三游', '末游'][place - 1]!;
            return (
              <div key={place} className={['place-row', seat === 'S' || seat === 'N' ? 'place-ours' : ''].join(' ')}>
                <span className="place-name">{label}</span>
                <span className="place-seat">{seat ? SEAT_SHORT[seat] : '未出完'}</span>
              </div>
            );
          })}
        </div>

        <div className="settlement-upgrade">
          <div>
            <span className="upgrade-label">本副升级</span>
            <strong>
              {teamName(result.winnerTeam)} +{result.upgrade} 级
              {capped && <span className="upgrade-note">（封顶 A）</span>}
            </strong>
          </div>
          <div className="level-row">
            <span className={state.currentLevelTeam === 'NS' ? 'level-active' : ''}>
              你方：{state.levels.NS}
            </span>
            <span className={state.currentLevelTeam === 'WE' ? 'level-active' : ''}>
              对方：{state.levels.WE}
            </span>
          </div>
          {over ? (
            <p className="settlement-hint">本局已结束，可点「再来一局」重新从 2 打起。</p>
          ) : (
            <p className="settlement-hint">
              下一副打 {state.currentLevelTeam === 'NS' ? '你方' : '对方'} 的级牌{' '}
              {state.levels[state.currentLevelTeam]}。
            </p>
          )}
        </div>

        <div className="settlement-actions">
          <button type="button" className="btn btn-ghost" onClick={onReview}>
            复盘本副
          </button>
          {over ? (
            <button type="button" className="btn btn-primary btn-large" onClick={onNewGame}>
              再来一局
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={onRestartDeal}>
                重开本副
              </button>
              <button type="button" className="btn btn-primary btn-large" onClick={onNext}>
                下一副
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
