import { useEffect, useRef } from 'react';
import type { Card, Level } from '../../core/types';
import { PlayingCard } from './PlayingCard';

interface Props {
  cards: Card[];
  level: Level;
  selected: string[];
  suggestedIds: string[];
  disabled: boolean;
  /** 只允许选择这些牌；不传则全部可选。 */
  selectableIds?: string[];
  /** 不可选原因（进贡/还贡），只用于提示。 */
  disabledReasons?: Record<string, string>;
  onToggle: (cardId: string) => void;
}

export function Hand({
  cards,
  level,
  selected,
  suggestedIds,
  disabled,
  selectableIds,
  disabledReasons,
  onToggle,
}: Props) {
  const handRef = useRef<HTMLDivElement | null>(null);
  // 手动滑动后的冷却时间：期内到来的建议不抢滚动。
  const lockUntil = useRef(0);
  const pointing = useRef(false);
  // 自动滚动自身产生的 scroll 事件不算手动滑动。
  const programmaticUntil = useRef(0);
  const suggestedKey = suggestedIds.join(',');

  useEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const lock = () => {
      lockUntil.current = Date.now() + 1200;
    };
    const down = () => {
      pointing.current = true;
      lock();
    };
    const up = () => {
      pointing.current = false;
      lockUntil.current = Date.now() + 600;
    };
    const onScroll = () => {
      if (Date.now() >= programmaticUntil.current) lock();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('wheel', lock, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
      el.removeEventListener('wheel', lock);
      el.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    if (!suggestedKey) return;
    const el = handRef.current;
    if (!el) return;
    // 等建议条与手牌布局稳定后再量位置。
    const timer = window.setTimeout(() => {
      if (!el.isConnected) return;
      if (pointing.current || Date.now() < lockUntil.current) return;
      if (el.scrollWidth <= el.clientWidth + 1) return;
      const slots = el.querySelectorAll<HTMLElement>('.hand-slot');
      const box = el.getBoundingClientRect();
      let left = Infinity;
      let right = -Infinity;
      cards.forEach((card, index) => {
        if (!suggestedIds.includes(card.id)) return;
        const slot = slots[index];
        if (!slot) return;
        const rect = slot.getBoundingClientRect();
        const start = rect.left - box.left + el.scrollLeft;
        left = Math.min(left, start);
        right = Math.max(right, start + rect.width);
      });
      if (!Number.isFinite(left)) return;
      const viewLeft = el.scrollLeft;
      const viewRight = viewLeft + el.clientWidth;
      // 已完整可见（留 8px 余量）就不动，避免无意义的抖动。
      if (left >= viewLeft + 8 && right <= viewRight - 8) return;
      const max = el.scrollWidth - el.clientWidth;
      const target = Math.max(0, Math.min(max, (left + right) / 2 - el.clientWidth / 2));
      if (Math.abs(target - el.scrollLeft) < 24) return;
      programmaticUntil.current = Date.now() + 900;
      // 只横向滚手牌容器，绝不调用 scrollIntoView / window.scrollTo。
      el.scrollTo({ left: target, behavior: 'smooth' });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [suggestedKey]);

  return (
    <div ref={handRef} className={['hand', disabled ? 'hand-disabled' : ''].join(' ')}>
      {cards.map((card, index) => {
        // 同点数相邻的牌来自 sortHand 的排序，这里只加视觉分组，不改顺序。
        const groupStart = index > 0 && cards[index - 1]!.rank !== card.rank;
        const active = selected.includes(card.id) || suggestedIds.includes(card.id);
        return (
          <div
            key={card.id}
            className={['hand-slot', groupStart ? 'hand-group-start' : ''].join(' ')}
            // 只比左邻高一层：抬起后不会盖住右邻的可点击露出条。
            style={{ zIndex: index * 2 + (active ? 1 : 0) }}
          >
            <PlayingCard
              card={card}
              level={level}
              selected={selected.includes(card.id)}
              suggested={suggestedIds.includes(card.id)}
              disabled={disabled || (selectableIds !== undefined && !selectableIds.includes(card.id))}
              disabledReason={disabledReasons?.[card.id]}
              onClick={() => onToggle(card.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
