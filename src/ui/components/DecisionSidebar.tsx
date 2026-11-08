import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../../core/types';
import { VERDICT_LABEL, type DecisionRecord } from '../../review/decisions';
import { cardText } from '../labels';

interface Props {
  decisions: DecisionRecord[];
  dealNo: number;
}

function shortCards(cards: Card[]): string {
  if (cards.length === 0) return '过牌';
  const shown = cards.slice(0, 4).map(cardText).join(' ');
  return cards.length > 4 ? `${shown} …` : shown;
}

/** 对局内的轻量决策侧栏：默认收起，只有产生决策记录后才允许展开。 */
export function DecisionSidebar({ decisions, dealNo }: Props) {
  const [open, setOpen] = useState(false);
  const list = decisions.filter((item) => item.dealNo === dealNo);
  const matched = list.filter((item) => item.verdict === 'match').length;
  const hasRecords = list.length > 0;

  // 换副（或本副记录被清空）一律回到收起：
  // 避免上一副手动展开的状态，在新一副产生第一条记录时被“继承”而自动弹开。
  useEffect(() => {
    setOpen(false);
  }, [dealNo]);

  useEffect(() => {
    if (!hasRecords) setOpen(false);
  }, [hasRecords]);

  return (
    <>
      <button
        type="button"
        className="decision-toggle"
        aria-expanded={open && hasRecords}
        aria-label={`本副决策，共 ${list.length} 次`}
        disabled={!hasRecords}
        title={hasRecords ? '查看本副决策记录' : '本副还没有决策记录'}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="decision-toggle-label">本副决策</span>
        <span className="decision-toggle-label-short">决策</span>
        <span className="decision-toggle-count">{list.length}</span>
      </button>

      {/* 面板挂到 body：避免顶栏的 backdrop-filter 改变 fixed 定位基准。 */}
      {open && hasRecords && createPortal(
        <aside className="decision-panel" aria-label="本副决策">
          <header className="decision-panel-head">
            <span className="decision-panel-title">本副决策</span>
            <span className="decision-panel-meta">
              {list.length} 次 · 采纳 {matched}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-small decision-panel-close"
              onClick={() => setOpen(false)}
            >
              收起
            </button>
          </header>

          <div className="decision-list">
            {[...list].reverse().map((record) => (
              <article
                key={record.id}
                className={['decision-item', `verdict-${record.verdict}`].join(' ')}
              >
                <div className="decision-item-head">
                  <span className="review-verdict">{VERDICT_LABEL[record.verdict]}</span>
                  <span className="decision-turn">第 {record.turn} 次</span>
                </div>
                <div className="decision-item-body">
                  <span>你 {shortCards(record.actualCards)}</span>
                  <span>建议 {shortCards(record.suggestedCards)}</span>
                </div>
                {record.verdict === 'mistake' && record.note ? (
                  <p className="decision-note">{record.note}</p>
                ) : null}
              </article>
            ))}
          </div>
        </aside>,
        document.body,
      )}
    </>
  );
}
