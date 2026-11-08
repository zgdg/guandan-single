import { useEffect, useState } from 'react';
import type { Card } from '../../core/types';
import type { Suggestion } from '../../suggest/static';
import { cardText, cornerRank, isRed, suitText } from '../labels';

interface Props {
  suggestion: Suggestion;
  pending?: boolean;
  onAdopt: () => void;
  onAdoptCards: (cards: Card[]) => void;
  onPass: () => void;
  onExpand?: () => void;
}

function confidenceText(confidence: number): '高' | '中' | '低' {
  if (confidence >= 0.7) return '高';
  if (confidence >= 0.45) return '中';
  return '低';
}

function confidenceClass(confidence: number): 'high' | 'mid' | 'low' {
  if (confidence >= 0.7) return 'high';
  if (confidence >= 0.45) return 'mid';
  return 'low';
}

function cardsText(cards: Card[]): string {
  const shown = cards.slice(0, 6).map(cardText).join(' ');
  return cards.length > 6 ? `${shown} …` : shown;
}

function MiniCard({ card }: { card: Card }) {
  return (
    <span
      className={['suggestion-mini', isRed(card) ? 'suggestion-mini-red' : ''].join(' ')}
      title={cardText(card)}
    >
      <span className="suggestion-mini-rank">{cornerRank(card)}</span>
      <span className="suggestion-mini-suit">{suitText(card)}</span>
    </span>
  );
}

export function SuggestionBar({ suggestion, pending, onAdopt, onAdoptCards, onPass, onExpand }: Props) {
  const [expanded, setExpanded] = useState(false);
  const key = `${suggestion.action}:${suggestion.cards.map((card) => card.id).join(',')}`;
  const lowConfidence =
    suggestion.engine === 'pimc' &&
    suggestion.confidence !== undefined &&
    suggestion.confidence < 0.45;
  const parallel = lowConfidence ? suggestion.alternatives[0] : undefined;

  useEffect(() => {
    setExpanded(false);
  }, [key]);

  return (
    <div
      className={['suggestion', suggestion.action === 'PASS' ? 'suggestion-pass' : ''].join(' ')}
    >
      <div className="suggestion-main">
        <div className="suggestion-icon">💡</div>
        <div className="suggestion-copy">
          <div className="suggestion-title">{suggestion.title}</div>
          <div className="suggestion-reason">{suggestion.reason}</div>
          <div className="suggestion-meta">
            {pending && <span className="suggestion-chip suggestion-chip-pending">精算中…</span>}
            {!pending && suggestion.engine === 'pimc' && suggestion.confidence !== undefined && (
              <span className={`suggestion-chip suggestion-chip-level-${confidenceClass(suggestion.confidence)}`}>
                把握{confidenceText(suggestion.confidence)}
              </span>
            )}
            {!pending && suggestion.engine === 'pimc' && (
              <span className="suggestion-chip">采样 {suggestion.sampleParticles ?? 0} 次</span>
            )}
            {suggestion.degraded && (
              <span className="suggestion-chip suggestion-chip-degraded" title={suggestion.degradeReason}>
                快速建议
              </span>
            )}
          </div>
          {parallel && (
            <div className="suggestion-parallel">
              也可以：{cardsText(parallel.option.pattern.cards)}
            </div>
          )}
        </div>
        {suggestion.action === 'PLAY' && suggestion.cards.length > 0 && (
          <div className="suggestion-cards" aria-label="建议出的牌">
            {suggestion.cards.slice(0, 6).map((card) => (
              <MiniCard key={card.id} card={card} />
            ))}
            {suggestion.cards.length > 6 && (
              <span className="suggestion-more">+{suggestion.cards.length - 6}</span>
            )}
          </div>
        )}
        {suggestion.action === 'PLAY' ? (
          <div className="suggestion-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={onAdopt}>
              按建议选牌
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small suggestion-toggle"
              aria-expanded={expanded}
              onClick={() => {
                if (!expanded) onExpand?.();
                setExpanded(!expanded);
              }}
            >
              {expanded ? '收起 ▴' : '为什么 ▾'}
            </button>
          </div>
        ) : (
          <div className="suggestion-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={onPass}>
              按建议过牌
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-small suggestion-toggle"
              aria-expanded={expanded}
              onClick={() => {
                if (!expanded) onExpand?.();
                setExpanded(!expanded);
              }}
            >
              {expanded ? '收起 ▴' : '为什么 ▾'}
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <p className="suggestion-disclaimer">建议基于你可见的信息与概率推断，不等于必胜</p>
      )}

      {expanded && (
        <div className="suggestion-detail">
          <div className="suggestion-section">
            <h4 className="suggestion-section-title">为什么这样打</h4>
            <ul className="suggestion-reasons">
              {suggestion.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
          {suggestion.alternatives.length > 0 && (
            <div className="suggestion-section">
              <h4 className="suggestion-section-title">备选方案</h4>
              <div className="suggestion-alts">
                {suggestion.alternatives.map((alt, index) => (
                  <div className="suggestion-alt" key={alt.option.pattern.cards.map((card) => card.id).join(',')}>
                    <div className="suggestion-alt-head">
                      <span className="suggestion-alt-index">{index + 2}</span>
                      <span className="suggestion-alt-cards">{cardsText(alt.option.pattern.cards)}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        onClick={() => onAdoptCards(alt.option.pattern.cards)}
                      >
                        用这套
                      </button>
                    </div>
                    <p className="suggestion-alt-note">
                      优点：{alt.pros}　缺点：{alt.cons}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {suggestion.risk && <p className="suggestion-risk">风险：{suggestion.risk}</p>}
        </div>
      )}
    </div>
  );
}
