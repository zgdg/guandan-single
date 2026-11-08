import { useEffect, useState } from 'react';
import type { Card, Seat } from '../../core/types';
import { SEAT_LABEL, cardText, placeText } from '../labels';
import { VERDICT_LABEL, type DecisionRecord } from '../../review/decisions';
import { useGameStore } from '../../store/gameStore';
import { isCommentaryEnabled, streamCommentary } from '../../review/commentaryStream';
import {
  readCachedCommentary,
  readCommentaryUsage,
  recordCommentaryUsage,
  writeCachedCommentary,
} from '../../review/commentaryCache';
import type { TokenUsage } from '../../review/commentary';

type CommentaryState =
  | { status: 'idle' }
  | { status: 'streaming'; text: string; usage: TokenUsage | null }
  | { status: 'done'; text: string; usage: TokenUsage | null; incomplete: boolean }
  | { status: 'unavailable' };

const SEVERITY: Record<DecisionRecord['verdict'], number> = {
  mistake: 0,
  better: 1,
  style: 2,
  match: 3,
};

function cardsText(cards: Card[]): string {
  if (cards.length === 0) return '过牌';
  const shown = cards.slice(0, 8).map(cardText).join(' ');
  return cards.length > 8 ? `${shown} …` : shown;
}

function DecisionCard({ record, index }: { record: DecisionRecord; index?: number }) {
  const counts = record.snapshot.handCounts;
  const last = record.snapshot.lastPlay;
  return (
    <article className={`review-decision verdict-${record.verdict}`}>
      <div className="review-decision-head">
        <span className="review-verdict">{VERDICT_LABEL[record.verdict]}</span>
        <span className="review-turn">
          {index === undefined ? '' : `${index}. `}第 {record.turn} 次决策
        </span>
        {last ? (
          <span className="review-last">
            上一手 {SEAT_LABEL[last.seat]} 出 {last.name}（{last.count} 张）
          </span>
        ) : (
          <span className="review-last">本圈由你领出</span>
        )}
      </div>

      <div className="review-compare">
        <div>
          <span className="review-compare-label">你的选择</span>
          <span className="review-cards">{cardsText(record.actualCards)}</span>
        </div>
        <div>
          <span className="review-compare-label">建议</span>
          <span className="review-cards">{cardsText(record.suggestedCards)}</span>
        </div>
      </div>

      {record.note ? <p className="review-note">{record.note}</p> : null}

      <div className="review-snapshot">
        <span>出牌前剩余：</span>
        {(['S', 'N', 'E', 'W'] as Seat[]).map((seat) => (
          <span className="review-snapshot-item" key={seat}>
            {seat === 'S' ? '你' : seat === 'N' ? '队友' : SEAT_LABEL[seat]} {counts[seat]}
          </span>
        ))}
        <span className="review-snapshot-item">级牌 {record.snapshot.level}</span>
      </div>
    </article>
  );
}

export function ReviewPage() {
  const state = useGameStore((store) => store.state);
  const decisions = useGameStore((store) => store.decisions);
  const expandedCount = useGameStore((store) => store.expandedCount);
  const closeReview = useGameStore((store) => store.closeReview);
  const nextDeal = useGameStore((store) => store.nextDeal);
  const startGame = useGameStore((store) => store.startGame);
  const [showAll, setShowAll] = useState(false);
  const [commentary, setCommentary] = useState<CommentaryState>({ status: 'idle' });

  const dealNo = state?.dealNo ?? null;
  const dealDecisions = dealNo ? decisions.filter((item) => item.dealNo === dealNo) : [];
  const resultText = state?.roundResult
    ? `${state.roundResult.winnerTeam === 'NS' ? '你方' : '对方'}升 ${state.roundResult.upgrade} 级`
    : '本副进行中';

  // 自动生成点评：失败只影响本块，绝不阻塞复盘页；离开页面则中断请求。
  useEffect(() => {
    // 开关在构建期注入：关闭时连请求都不发起，也不渲染点评区块。
    if (!isCommentaryEnabled() || !dealNo || dealDecisions.length === 0) {
      setCommentary({ status: 'idle' });
      return;
    }
    const input = { dealNo, result: resultText, decisions: dealDecisions };
    const cached = readCachedCommentary(input);
    if (cached) {
      setCommentary({
        status: 'done',
        text: cached.text,
        usage: readCommentaryUsage(dealNo),
        incomplete: false,
      });
      return;
    }

    const controller = new AbortController();
    let active = true;
    setCommentary({ status: 'streaming', text: '', usage: null });

    void streamCommentary(input, {
      signal: controller.signal,
      onDelta: (delta) => {
        if (!active) return;
        setCommentary((previous) =>
          previous.status === 'streaming'
            ? { ...previous, text: previous.text + delta }
            : previous,
        );
      },
      onUsage: (usage) => {
        recordCommentaryUsage(dealNo, usage);
        if (!active) return;
        setCommentary((previous) =>
          previous.status === 'streaming' || previous.status === 'done'
            ? { ...previous, usage }
            : previous,
        );
      },
    }).then((streamed) => {
      if (!active) return;
      if (!streamed) {
        setCommentary({ status: 'unavailable' });
        return;
      }
      if (!streamed.incomplete) writeCachedCommentary(input, streamed.text);
      setCommentary({
        status: 'done',
        text: streamed.text,
        usage: streamed.usage ?? readCommentaryUsage(dealNo),
        incomplete: streamed.incomplete,
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
    // 决策集合在一副牌复盘期间不再增长，按副号与决策数触发即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealNo, dealDecisions.length]);

  if (!state) {
    return (
      <div className="review-page">
        <p className="review-empty">还没有可复盘的对局。</p>
      </div>
    );
  }

  const result = state.roundResult;
  const over = state.phase === 'GAME_OVER';
  const keyDecisions = [...dealDecisions]
    .filter((item) => item.verdict !== 'match')
    .sort((left, right) => SEVERITY[left.verdict] - SEVERITY[right.verdict] || left.turn - right.turn)
    .slice(0, 3);
  const matched = dealDecisions.filter((item) => item.verdict === 'match').length;
  const rate = dealDecisions.length > 0 ? Math.round((matched / dealDecisions.length) * 100) : 0;

  return (
    <div className="review-page">
      <header className="review-head">
        <button type="button" className="btn btn-ghost btn-small" onClick={closeReview}>
          ← 返回牌桌
        </button>
        <div className="review-head-title">
          第 {state.dealNo} 副复盘
          {result ? ` · ${result.winnerTeam === 'NS' ? '你方' : '对方'}升 ${result.upgrade} 级` : ''}
        </div>
      </header>

      <main className="review-body">
        <section className="review-summary">
          <div className="review-summary-row">
            <span>名次</span>
            {(['S', 'N', 'E', 'W'] as Seat[]).map((seat) => (
              <span className="review-snapshot-item" key={seat}>
                {seat === 'S' ? '你' : seat === 'N' ? '队友' : SEAT_LABEL[seat]}{' '}
                {placeText(result?.outOrder[seat] ?? null) || '未出完'}
              </span>
            ))}
          </div>
          <div className="review-summary-row">
            <span>建议采纳</span>
            <strong>
              {matched}/{dealDecisions.length}
            </strong>
            <span className="review-summary-muted">（{rate}%）</span>
            <span className="review-summary-muted">展开理由 {expandedCount} 次</span>
          </div>
        </section>

        {commentary.status !== 'idle' && (
          <section className="review-commentary" aria-live="polite">
            <h3 className="review-section-title">
              AI 教练点评
              {commentary.status === 'streaming' && (
                <span className="review-commentary-status">生成中…</span>
              )}
            </h3>
            {commentary.status === 'streaming' && (
              <p className="review-commentary-text">
                {commentary.text || '正在根据你的决策生成点评…'}
                <span className="review-caret" aria-hidden="true" />
              </p>
            )}
            {commentary.status === 'done' && (
              <>
                <p className="review-commentary-text">{commentary.text}</p>
                {commentary.incomplete && (
                  <p className="review-commentary-muted">点评未完整生成，可重新进入复盘再试。</p>
                )}
              </>
            )}
            {commentary.status === 'unavailable' && (
              <p className="review-commentary-muted">
                AI 点评暂不可用（未配置或服务未启动），不影响上面的复盘内容。
              </p>
            )}
            {commentary.status !== 'unavailable' && commentary.usage && (
              <p className="review-commentary-usage">
                本次点评用量：输入 {commentary.usage.promptTokens} / 输出{' '}
                {commentary.usage.completionTokens} tokens
              </p>
            )}
          </section>
        )}

        <section>
          <h3 className="review-section-title">
            关键决策{keyDecisions.length > 0 ? `（${keyDecisions.length}）` : ''}
          </h3>
          {keyDecisions.length === 0 ? (
            <p className="review-empty">
              本副没有明显可改的决策。{dealDecisions.length === 0 ? '（这一副你没有做决策）' : ''}
            </p>
          ) : (
            <div className="review-decisions">
              {keyDecisions.map((record, index) => (
                <DecisionCard key={record.id} record={record} index={index + 1} />
              ))}
            </div>
          )}
        </section>

        {dealDecisions.length > 0 && (
          <section>
            <button
              type="button"
              className="btn btn-ghost btn-small review-all-toggle"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? '收起全部决策' : `全部决策（${dealDecisions.length}）`}
            </button>
            {showAll && (
              <div className="review-decisions">
                {dealDecisions.map((record) => (
                  <DecisionCard key={record.id} record={record} />
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="review-actions">
        <button type="button" className="btn btn-ghost" onClick={closeReview}>
          返回牌桌
        </button>
        {over ? (
          <button type="button" className="btn btn-primary btn-large" onClick={startGame}>
            再来一局
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-large"
            onClick={() => {
              nextDeal();
              closeReview();
            }}
          >
            下一副
          </button>
        )}
      </footer>
    </div>
  );
}
