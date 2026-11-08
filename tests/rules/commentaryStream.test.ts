import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentaryInput } from '../../src/review/commentary';
import { streamCommentary } from '../../src/review/commentaryStream';
import {
  commentaryCacheKey,
  readCachedCommentary,
  readCommentaryUsage,
  recordCommentaryUsage,
  writeCachedCommentary,
} from '../../src/review/commentaryCache';
import type { DecisionRecord } from '../../src/review/decisions';

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: '3-1',
    dealNo: 3,
    turn: 1,
    actual: 'PASS',
    actualCards: [],
    suggestedAction: 'PLAY',
    suggestedCards: [{ id: '0-♠-8', suit: 'S', rank: 8, copy: 0 }],
    suggestedTitle: '建议出对子',
    verdict: 'better',
    note: '本可以用对子压住这一手',
    snapshot: { handCounts: { S: 20, E: 20, N: 20, W: 20 }, lastPlay: null, level: 2 },
    ...overrides,
  };
}

const input: CommentaryInput = {
  dealNo: 3,
  result: '你方升 2 级',
  decisions: [
    decision(),
    decision({
      id: '3-2',
      turn: 2,
      actual: 'PLAY',
      actualCards: [{ id: '1-♥-11', suit: 'H', rank: 11, copy: 1 }],
      suggestedAction: 'PASS',
      suggestedCards: [],
      suggestedTitle: '建议过牌',
      verdict: 'style',
      note: '抢了队友的领出权',
    }),
  ],
};

function sseBody(events: unknown[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('streamCommentary', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('把流式增量拼成完整文本并回传 token 用量', async () => {
    const deltas: string[] = [];
    const usages: unknown[] = [];
    const seen: Array<Record<string, unknown>> = [];

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return streamResponse([
        sseBody([{ type: 'delta', text: '你这一手' }]),
        sseBody([{ type: 'delta', text: '拦得不错。' }]),
        sseBody([
          { type: 'usage', usage: { promptTokens: 88, completionTokens: 21, totalTokens: 109 } },
        ]),
        sseBody([{ type: 'done', usage: null }]),
      ]);
    }) as typeof fetch;

    const result = await streamCommentary(input, {
      endpoint: '/api/commentary',
      onDelta: (delta) => deltas.push(delta),
      onUsage: (usage) => usages.push(usage),
    });

    expect(result).not.toBeNull();
    expect(result?.text).toBe('你这一手拦得不错。');
    expect(result?.usage).toEqual({ promptTokens: 88, completionTokens: 21, totalTokens: 109 });
    expect(result?.incomplete).toBe(false);
    expect(deltas).toEqual(['你这一手', '拦得不错。']);
    expect(usages).toHaveLength(1);
    expect(seen[0]).toMatchObject({ dealNo: 3, result: '你方升 2 级' });
    expect(Array.isArray((seen[0] as { decisions?: unknown }).decisions)).toBe(true);
    // 前端不应携带任何鉴权信息。
    expect(JSON.stringify(seen[0])).not.toContain('authorization');
  });

  it('代理未配置或不可用时返回 null，不抛错', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"error":"CONFIG_MISSING"}', { status: 503 })) as typeof fetch;
    const result = await streamCommentary(input, { endpoint: '/api/commentary' });
    expect(result).toBeNull();

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await streamCommentary(input, { endpoint: '/api/commentary' })).toBeNull();
  });

  it('流中断但已有文本时标记 incomplete，保留已生成内容', async () => {
    globalThis.fetch = vi.fn(async () =>
      streamResponse([
        sseBody([{ type: 'delta', text: '先看第一手：' }]),
        sseBody([{ type: 'error', code: 'TIMEOUT', message: '超过 5000ms' }]),
      ]),
    ) as typeof fetch;

    const result = await streamCommentary(input, { endpoint: '/api/commentary' });
    expect(result?.text).toBe('先看第一手：');
    expect(result?.incomplete).toBe(true);
  });

  it('没有任何增量文本时返回 null', async () => {
    globalThis.fetch = vi.fn(async () => streamResponse([sseBody([{ type: 'done', usage: null }])])) as typeof fetch;
    expect(await streamCommentary(input, { endpoint: '/api/commentary' })).toBeNull();
  });
});

describe('commentaryCache', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } satisfies Partial<Storage>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('同一副牌同一组决策命中缓存，决策内容变化则视为不同缓存', () => {
    const key = commentaryCacheKey(input);
    expect(key.startsWith('3|你方升 2 级|2|')).toBe(true);
    expect(commentaryCacheKey({ ...input })).toBe(key);

    writeCachedCommentary(input, '缓存点评');
    expect(readCachedCommentary(input)?.text).toBe('缓存点评');

    const fewer: CommentaryInput = { ...input, decisions: [input.decisions[0]!] };
    expect(readCachedCommentary(fewer)).toBeNull();

    const differentCard = structuredClone(input);
    differentCard.decisions[1]!.actualCards = [
      { id: '1-♦-13', suit: 'D', rank: 13, copy: 1 },
    ];
    expect(commentaryCacheKey(differentCard)).not.toBe(key);
    expect(readCachedCommentary(differentCard)).toBeNull();
  });

  it('记录并读取每副的 token 用量', () => {
    recordCommentaryUsage(3, { promptTokens: 88, completionTokens: 21, totalTokens: 109 });
    recordCommentaryUsage(3, { promptTokens: 91, completionTokens: 24, totalTokens: 115 });
    const usage = readCommentaryUsage(3);
    expect(usage).toMatchObject({ dealNo: 3, promptTokens: 91, completionTokens: 24, totalTokens: 115 });
  });
});
