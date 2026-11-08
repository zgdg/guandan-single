import type { Card, Level } from '../../core/types';
import { cornerRank, isRed, isWild, suitText } from '../labels';

interface Props {
  card: Card;
  level: Level;
  selected?: boolean;
  suggested?: boolean;
  disabled?: boolean;
  /** 不可选原因，仅用于 title / aria-label，不参与规则判定。 */
  disabledReason?: string;
  onClick?: () => void;
}

export function PlayingCard({
  card,
  level,
  selected,
  suggested,
  disabled,
  disabledReason,
  onClick,
}: Props) {
  const joker = card.suit === 'JOKER';
  const red = isRed(card);
  const wild = isWild(card, level);
  return (
    <button
      type="button"
      className={[
        'card',
        joker ? 'card-joker' : '',
        red ? 'card-red' : '',
        selected ? 'card-selected' : '',
        suggested ? 'card-suggested' : '',
        disabled ? 'card-disabled' : '',
      ].join(' ')}
      onClick={onClick}
      disabled={disabled}
      aria-label={`${cornerRank(card)}${joker ? '王' : suitText(card)}${disabledReason ? `（${disabledReason}）` : ''}`}
      title={disabledReason ?? (wild ? '逢人配（红桃级牌）' : undefined)}
    >
      {wild && <span className="card-wild">配</span>}
      {joker ? (
        <span className="card-joker-face">
          <span>{card.rank === 16 ? '大' : '小'}</span>
          <span>王</span>
        </span>
      ) : (
        <>
          <span className="card-corner">
            <span>{cornerRank(card)}</span>
            <span>{suitText(card)}</span>
          </span>
          <span className="card-suit">{suitText(card)}</span>
        </>
      )}
    </button>
  );
}
