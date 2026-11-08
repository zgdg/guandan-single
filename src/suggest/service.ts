import type { GameState } from '../core/types';
import type { RuleConfig } from '../core/config';
import { publicStateHash } from './belief';
import { degradedSuggestion, type PimcResult } from './pimc';

/** 单次精算的墙钟上限；超过后立刻改用静态建议并提示降级。 */
const TIMEOUT_MS = 420;
const CACHE_LIMIT = 40;

interface Pending {
  hash: string;
  state: GameState;
  config: RuleConfig;
  resolve: (result: PimcResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const cache = new Map<string, PimcResult>();
let worker: Worker | null | undefined;
let sequence = 0;
const pending = new Map<number, Pending>();

function trimCache(): void {
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function remember(hash: string, result: PimcResult): PimcResult {
  cache.set(hash, result);
  trimCache();
  return result;
}

function failAll(reason: string): void {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.resolve(remember(item.hash, degradedSuggestion(item.state, item.config, reason)));
  }
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof Worker === 'undefined') {
    worker = null;
    return null;
  }
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: number; hash: string; result: PimcResult | null }>) => {
      const { id, hash, result } = event.data;
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      clearTimeout(item.timer);
      item.resolve(
        result
          ? remember(hash, result)
          : remember(hash, degradedSuggestion(item.state, item.config, '精算进程返回异常，已使用快速建议')),
      );
    };
    worker.onerror = () => {
      failAll('精算进程不可用，已使用快速建议');
      worker?.terminate();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/**
 * 异步请求 PIMC 建议（Web Worker）。任何失败/超时都返回带降级标记的静态建议，
 * 因此调用方永远拿到的是一条合法建议。
 */
export function requestPimcSuggestion(state: GameState, config: RuleConfig): Promise<PimcResult> {
  const hash = publicStateHash(state, 'S');
  const cached = cache.get(hash);
  if (cached) return Promise.resolve(cached);

  const active = getWorker();
  if (!active) {
    return Promise.resolve(degradedSuggestion(state, config, '当前环境不支持 Worker，已使用快速建议'));
  }

  return new Promise<PimcResult>((resolve) => {
    const id = (sequence += 1);
    const timer = setTimeout(() => {
      const item = pending.get(id);
      if (!item) return;
      pending.delete(id);
      resolve(remember(hash, degradedSuggestion(item.state, item.config, '精算超时，已使用快速建议')));
    }, TIMEOUT_MS);
    pending.set(id, { hash, state, config, resolve, timer });
    try {
      // 事件日志只用于回放，不参与决策；去掉可显著降低结构化克隆开销。
      active.postMessage({ id, hash, state: { ...state, events: [] }, config });
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(degradedSuggestion(state, config, '精算请求发送失败，已使用快速建议'));
    }
  });
}
