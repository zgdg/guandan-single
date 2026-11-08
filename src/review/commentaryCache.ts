import type { CommentaryInput, TokenUsage } from './commentary';

/**
 * 复盘点评的本地缓存与用量记录（只存本机，不上报）。
 * 规划要求「每副牌最多 1 次调用」，重复打开复盘优先读缓存。
 */

const CACHE_KEY = 'gd_commentary_cache_v1';
const USAGE_KEY = 'gd_commentary_usage_v1';
const MAX_ENTRIES = 20;

export interface CachedCommentary {
  text: string;
  at: string;
}

export interface CommentaryUsageRecord extends TokenUsage {
  dealNo: number;
  at: string;
}

interface CacheEntry extends CachedCommentary {
  key: string;
}

function storage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** 决策指纹：牌号与手数在不同对局里会重复，必须把决策内容也纳入缓存键。 */
function fingerprint(input: CommentaryInput): string {
  return input.decisions
    .map((item) =>
      [
        item.turn,
        item.actual,
        item.actualCards.map((card) => card.id).join('+'),
        item.suggestedAction,
        item.suggestedCards.map((card) => card.id).join('+'),
        item.suggestedTitle,
        item.verdict,
        item.note,
      ].join(':'),
    )
    .join('|');
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

export function commentaryCacheKey(input: CommentaryInput): string {
  return [input.dealNo, input.result, input.decisions.length, hashString(fingerprint(input))].join('|');
}

export function readCachedCommentary(input: CommentaryInput): CachedCommentary | null {
  const store = storage();
  if (!store) return null;
  try {
    const parsed: unknown = JSON.parse(store.getItem(CACHE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return null;
    const key = commentaryCacheKey(input);
    const hit = (parsed as CacheEntry[]).find((entry) => entry?.key === key);
    return hit && typeof hit.text === 'string' ? { text: hit.text, at: hit.at } : null;
  } catch {
    return null;
  }
}

export function writeCachedCommentary(input: CommentaryInput, text: string): void {
  const store = storage();
  if (!store || !text.trim()) return;
  try {
    const parsed: unknown = JSON.parse(store.getItem(CACHE_KEY) ?? '[]');
    const entries = Array.isArray(parsed) ? (parsed as CacheEntry[]) : [];
    const key = commentaryCacheKey(input);
    const next = [{ key, text, at: new Date().toISOString() }, ...entries.filter((entry) => entry?.key !== key)].slice(
      0,
      MAX_ENTRIES,
    );
    store.setItem(CACHE_KEY, JSON.stringify(next));
  } catch {
    // 存储写满或被禁用时静默放弃缓存，不影响点评本身。
  }
}

export function recordCommentaryUsage(dealNo: number, usage: TokenUsage): void {
  const store = storage();
  if (!store) return;
  try {
    const parsed: unknown = JSON.parse(store.getItem(USAGE_KEY) ?? '[]');
    const entries = Array.isArray(parsed) ? (parsed as CommentaryUsageRecord[]) : [];
    const next = [
      { dealNo, at: new Date().toISOString(), ...usage },
      ...entries.filter((entry) => entry?.dealNo !== dealNo),
    ].slice(0, MAX_ENTRIES);
    store.setItem(USAGE_KEY, JSON.stringify(next));
  } catch {
    // 记录失败不影响点评。
  }
}

export function readCommentaryUsage(dealNo: number): CommentaryUsageRecord | null {
  const store = storage();
  if (!store) return null;
  try {
    const parsed: unknown = JSON.parse(store.getItem(USAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return null;
    const hit = (parsed as CommentaryUsageRecord[]).find((entry) => entry?.dealNo === dealNo);
    return hit ?? null;
  } catch {
    return null;
  }
}
