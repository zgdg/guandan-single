import { useEffect, useMemo, useState } from 'react';
import type { Level } from '../../core/types';
import { getCurrentSeat, getLegalReturnCards, getLegalTributeCards } from '../../core/engine';
import { recognize } from '../../core/patterns';
import { patternName } from '../../core/compare';
import { suggestForHuman } from '../../suggest/static';
import { publicStateHash } from '../../suggest/belief';
import { requestPimcSuggestion } from '../../suggest/service';
import {
  humanTributeKind,
  useGameStore,
} from '../../store/gameStore';
import { DecisionSidebar } from '../components/DecisionSidebar';
import { Hand } from '../components/Hand';
import { RulesModal } from '../components/RulesModal';
import { SeatLast, SeatPanel } from '../components/SeatPanel';
import { SettlementPanel } from '../components/SettlementPanel';
import { SuggestionBar } from '../components/SuggestionBar';
import {
  TributeFlow,
  TributeGuide,
  TributeNotice,
  isFirstTrick,
  tributeCardReasons,
} from '../components/TributeFlow';
import { SEAT_SHORT, cornerRank, isRed, suitText } from '../labels';

export function GamePage() {
  const state = useGameStore((store) => store.state);
  const config = useGameStore((store) => store.config);
  const settings = useGameStore((store) => store.settings);
  const selected = useGameStore((store) => store.selected);
  const message = useGameStore((store) => store.message);
  const dealing = useGameStore((store) => store.dealing);
  const backHome = useGameStore((store) => store.backHome);
  const toggleCard = useGameStore((store) => store.toggleCard);
  const selectCards = useGameStore((store) => store.selectCards);
  const clearMessage = useGameStore((store) => store.clearMessage);
  const playSelected = useGameStore((store) => store.playSelected);
  const pass = useGameStore((store) => store.pass);
  const tributeSelected = useGameStore((store) => store.tributeSelected);
  const nextDeal = useGameStore((store) => store.nextDeal);
  const restartDeal = useGameStore((store) => store.restartDeal);
  const runAI = useGameStore((store) => store.runAI);
  const endDealing = useGameStore((store) => store.endDealing);
  const startGame = useGameStore((store) => store.startGame);
  const setSpeed = useGameStore((store) => store.setSpeed);
  const openReview = useGameStore((store) => store.openReview);
  const markSuggestionExpanded = useGameStore((store) => store.markSuggestionExpanded);
  const suggestion = useGameStore((store) => store.suggestion);
  const suggestionHash = useGameStore((store) => store.suggestionHash);
  const suggestionPending = useGameStore((store) => store.suggestionPending);
  const beginSuggestion = useGameStore((store) => store.beginSuggestion);
  const applySuggestion = useGameStore((store) => store.applySuggestion);
  const decisions = useGameStore((store) => store.decisions);
  const [rulesOpen, setRulesOpen] = useState(false);

  const level = (state?.levels[state.currentLevelTeam] ?? 2) as Level;
  const phase = state?.phase ?? 'IDLE';
  const currentSeat = state ? getCurrentSeat(state) : null;
  const tributeKind = humanTributeKind(state);
  const playing = phase === 'PLAYING' && currentSeat === 'S';

  const legalTribute = useMemo(() => {
    if (!state || phase !== 'TRIBUTE' || !tributeKind) return [];
    return tributeKind === 'pay'
      ? getLegalTributeCards(state, 'S', config)
      : getLegalReturnCards(state, 'S', config);
  }, [state, phase, tributeKind, config]);

  const selectedCards = useMemo(() => {
    if (!state) return [];
    return state.players.S.hand.filter((card) => selected.includes(card.id));
  }, [state, selected]);

  const selectionText = useMemo(() => {
    if (selectedCards.length === 0) return '';
    try {
      const patterns = recognize(selectedCards, level, config);
      const names = [...new Set(patterns.map((pattern) => patternName(pattern)))];
      if (names.length === 0) return '当前选牌不是合法牌型';
      if (names.length > 1) return `${names.join(' / ')}（多解，出牌时自动锁定一种）`;
      return names[0]!;
    } catch {
      return '当前选牌不是合法牌型';
    }
  }, [selectedCards, level, config]);

  const selectionInvalid = selectedCards.length > 0 && selectionText === '当前选牌不是合法牌型';
  const patternShort = selectionText ? selectionText.split('（')[0] : '';
  const playLabel =
    selectedCards.length === 0
      ? '出牌'
      : selectionInvalid
        ? '选牌不合法'
        : `出牌 · ${selectedCards.length} 张${patternShort ? ` · ${patternShort}` : ''}`;

  useEffect(() => {
    if (!dealing) return;
    const timer = setTimeout(() => endDealing(), 900 / settings.speed);
    return () => clearTimeout(timer);
  }, [dealing, settings.speed, endDealing]);
  useEffect(() => {
    if (!state || dealing) return;
    if (state.phase === 'SETTLEMENT' || state.phase === 'GAME_OVER') return;
    const seat = getCurrentSeat(state);
    if (!seat || seat === 'S') return;
    const timer = setTimeout(() => runAI(), 800 / settings.speed);
    return () => clearTimeout(timer);
  }, [state, dealing, settings.speed, runAI]);

  useEffect(() => {
    if (!state || dealing || phase !== 'PLAYING' || currentSeat !== 'S') return;
    const hash = publicStateHash(state, 'S');
    if (suggestionHash === hash) return;
    // 先同步给出静态建议（保证立即有内容），再让 Worker 后台精算并覆盖。
    const quick = suggestForHuman(state, config);
    beginSuggestion(hash, quick);
    requestPimcSuggestion(state, config)
      .then((result) => applySuggestion(hash, result.suggestion))
      .catch(() => applySuggestion(hash, quick));
  }, [
    state,
    dealing,
    phase,
    currentSeat,
    config,
    suggestionHash,
    beginSuggestion,
    applySuggestion,
  ]);

  if (!state) {
    return (
      <div className="empty-state">
        <p>没有正在进行的牌局。</p>
        <button type="button" className="btn btn-primary" onClick={backHome}>
          回到首页
        </button>
      </div>
    );
  }

  const suggestedIds = suggestion?.cards.map((card) => card.id) ?? [];
  const canSelect = playing || (phase === 'TRIBUTE' && tributeKind !== null);
  const selectableIds = phase === 'TRIBUTE' ? legalTribute.map((card) => card.id) : undefined;
  const disabledReasons = phase === 'TRIBUTE' ? tributeCardReasons(state, config) : undefined;
  const canPass = playing && state.trick.lastPlay !== null;

  return (
    <div className="game-shell">
      <header className="game-head">
        <button type="button" className="btn btn-ghost btn-small" onClick={backHome}>
          ← 退出
        </button>
        <div className="game-title">
          <strong>第 {state.dealNo} 副</strong>
          <span>打 {level} · {state.currentLevelTeam === 'NS' ? '你方' : '对方'}级牌</span>
        </div>
        <div className="head-right">
          <div className="level-pill" title="双方级数">
            <span className={state.currentLevelTeam === 'NS' ? 'level-mine' : ''}>你 {state.levels.NS}</span>
            <span className="level-divider">/</span>
            <span className={state.currentLevelTeam === 'WE' ? 'level-mine' : ''}>对 {state.levels.WE}</span>
          </div>
          <div className="speed-inline">
            {[0.5, 1, 2].map((speed) => (
              <button
                key={speed}
                type="button"
                className={['speed-mini', settings.speed === speed ? 'speed-active' : ''].join(' ')}
                onClick={() => setSpeed(speed)}
                title="切换 AI 速度"
              >
                {speed}×
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-small" onClick={() => setRulesOpen(true)}>
            规则
          </button>
          <DecisionSidebar decisions={decisions} dealNo={state.dealNo} />
        </div>
      </header>

      {message && (
        <div className="notice notice-warn notice-floating" onClick={clearMessage} role="presentation">
          {message}
          <span className="notice-close">×</span>
        </div>
      )}

      {state.tribute && phase === 'TRIBUTE' && <TributeFlow state={state} />}
      {state.tribute && phase === 'PLAYING' && isFirstTrick(state) && (
        <TributeNotice state={state} />
      )}

      <main className="game-table">
        <div className="seat seat-n">
          <SeatPanel seat="N" state={state} current={currentSeat === 'N'} />
          <SeatLast seat="N" state={state} />
        </div>
        <div className="seat seat-w">
          <SeatPanel seat="W" state={state} current={currentSeat === 'W'} compact />
          <SeatLast seat="W" state={state} />
        </div>
        <div className="seat seat-e">
          <SeatPanel seat="E" state={state} current={currentSeat === 'E'} compact />
          <SeatLast seat="E" state={state} />
        </div>

        <div className="table-center">
          <div className="trick-summary">
            {state.trick.lastPlay ? (
              <>
                <span className="trick-summary-tag">本圈最大</span>
                <span className="trick-summary-owner">
                  {SEAT_SHORT[state.trick.lastPlay.seat]}出
                </span>
                <span className="trick-summary-pattern">
                  {patternName(state.trick.lastPlay.pattern)}
                </span>
                <span className="trick-summary-count">{state.trick.lastPlay.cards.length} 张</span>
              </>
            ) : (
              <span className="trick-summary-empty">
                {phase === 'TRIBUTE'
                  ? '进贡 / 还贡中…'
                  : currentSeat === 'S'
                    ? '本圈开始 · 轮到你领出'
                    : `本圈开始 · 等待 ${currentSeat ? SEAT_SHORT[currentSeat] : '…'} 领出`}
              </span>
            )}
          </div>
        </div>

        <div className="seat seat-s">
          <SeatPanel seat="S" state={state} current={currentSeat === 'S'} />
          <SeatLast seat="S" state={state} />
        </div>

        {dealing && (
          <div className="deal-overlay">
            <div className="deal-back deal-back-1" />
            <div className="deal-back deal-back-2" />
            <div className="deal-back deal-back-3" />
            <div className="deal-back deal-back-4" />
            <p>发牌中…</p>
          </div>
        )}
      </main>

      <footer className="game-hand-area">
        {phase === 'PLAYING' && suggestion && (
          <SuggestionBar
            suggestion={suggestion}
            pending={suggestionPending}
            onAdopt={() => selectCards(suggestion.cards.map((card) => card.id))}
            onAdoptCards={(cards) => selectCards(cards.map((card) => card.id))}
            onPass={pass}
            onExpand={markSuggestionExpanded}
          />
        )}
        {phase === 'TRIBUTE' && state.tribute && (
          <TributeGuide state={state} config={config} />
        )}
        {phase === 'PLAYING' && !playing && (
          <div className="wait-hint">
            {currentSeat ? `等待 ${SEAT_SHORT[currentSeat]} ${currentSeat === 'N' ? '（队友）' : '（对手）'}出牌…` : '结算中…'}
          </div>
        )}

        {selectedCards.length > 0 && (
          <div className="selected-tray" aria-label={`已选 ${selectedCards.length} 张，点小牌可取消`}>
            <span className="selected-tray-label">已选 {selectedCards.length}</span>
            <div className="selected-tray-cards">
              {selectedCards.slice(0, 6).map((card) => (
                <button
                  type="button"
                  key={card.id}
                  className={['selected-mini', isRed(card) ? 'selected-mini-red' : ''].join(' ')}
                  title="点击取消选择"
                  onClick={() => toggleCard(card.id)}
                >
                  <span className="selected-mini-rank">{cornerRank(card)}</span>
                  <span className="selected-mini-suit">{suitText(card)}</span>
                </button>
              ))}
              {selectedCards.length > 6 && (
                <span className="selected-more">+{selectedCards.length - 6}</span>
              )}
            </div>
            <span className="selected-tray-hint">点牌取消</span>
          </div>
        )}

        <Hand
          cards={state.players.S.hand}
          level={level}
          selected={selected}
          suggestedIds={suggestedIds}
          disabled={!canSelect}
          selectableIds={selectableIds}
          disabledReasons={disabledReasons}
          onToggle={toggleCard}
        />

        <div className="action-bar">
          {phase === 'TRIBUTE' && tributeKind ? (
            <button
              type="button"
              className="btn btn-primary btn-large"
              disabled={selected.length !== 1}
              onClick={tributeSelected}
            >
              {tributeKind === 'pay' ? '确认进贡' : '确认还贡'}
            </button>
          ) : playing ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!canPass}
                onClick={pass}
                title={canPass ? '本圈可以过牌' : '领出时不能过牌'}
              >
                过牌
              </button>
              <button
                type="button"
                className="btn btn-primary btn-large"
                disabled={selected.length === 0 || selectionInvalid}
                onClick={playSelected}
              >
                {playLabel}
              </button>
            </>
          ) : (
            <div className="wait-actions">
              {phase === 'SETTLEMENT' ? '本副已结束' : phase === 'GAME_OVER' ? '本局已结束' : '等待操作…'}
            </div>
          )}
        </div>
      </footer>

      {(phase === 'SETTLEMENT' || phase === 'GAME_OVER') && (
        <SettlementPanel
          state={state}
          onNext={nextDeal}
          onNewGame={startGame}
          onRestartDeal={restartDeal}
          onReview={openReview}
        />
      )}

      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </div>
  );
}
