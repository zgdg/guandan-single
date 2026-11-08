import type { CommentaryInput, TokenUsage } from './commentary';

/**
 * 复盘点评的前端客户端：只请求自家代理，不携带任何密钥。
 * 代理地址由 `config/app.config.json` 的 `commentary.endpoint` 在构建期注入，
 * 默认同源 `/api/commentary`；前端不读取任何模型配置或密钥。
 *
 * 任何失败（未配置、代理不可用、超时、流中断）都返回 null，绝不抛出，
 * 调用方据此隐藏点评区域，复盘页其余内容照常展示。
 */

export interface CommentaryStreamResult {
  text: string;
  usage: TokenUsage | null;
  /** 流在中途失败但有部分文本时标记，界面可提示「点评未完整生成」。 */
  incomplete: boolean;
}

export interface CommentaryStreamOptions {
  /** 覆盖默认代理地址，主要供测试与多环境部署使用。 */
  endpoint?: string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

function resolveEndpoint(explicit?: string): string {
  if (explicit !== undefined) return explicit.trim();
  try {
    // 构建期由 vite.config.ts 从 config/app.config.json 注入，前端只拿得到公开路径。
    // 未注入（开关关闭 / 非 Vite 环境）时返回空串，调用方据此不发请求。
    if (typeof __COMMENTARY_ENDPOINT__ === 'string' && __COMMENTARY_ENDPOINT__.trim()) {
      return __COMMENTARY_ENDPOINT__.trim();
    }
  } catch {
    // 未注入。
  }
  return '';
}

/** AI 点评总开关：构建期注入，未注入（测试/非 Vite 环境）按关闭处理。 */
export function isCommentaryEnabled(): boolean {
  try {
    return typeof __COMMENTARY_ENABLED__ === 'boolean' ? __COMMENTARY_ENABLED__ : false;
  } catch {
    return false;
  }
}

interface StreamEvent {
  type?: string;
  text?: string;
  usage?: unknown;
  code?: string;
  message?: string;
}

function normalizeUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const prompt = Number(value.promptTokens ?? value.prompt_tokens ?? 0);
  const completion = Number(value.completionTokens ?? value.completion_tokens ?? 0);
  const total = Number(value.totalTokens ?? value.total_tokens ?? prompt + completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function parseEvent(raw: string): StreamEvent | null {
  const line = raw
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.startsWith('data:'));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(5).trim());
    return parsed && typeof parsed === 'object' ? (parsed as StreamEvent) : null;
  } catch {
    return null;
  }
}

/**
 * 请求代理并按 SSE 增量回调；返回值只包含最终文本与用量。
 * 代理未配置（503）或网络错误时返回 null。
 */
export async function streamCommentary(
  input: CommentaryInput,
  options: CommentaryStreamOptions = {},
): Promise<CommentaryStreamResult | null> {
  const endpoint = resolveEndpoint(options.endpoint);
  if (!endpoint) return null;

  let text = '';
  let usage: TokenUsage | null = null;
  let failed = false;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dealNo: input.dealNo,
        result: input.result,
        decisions: input.decisions,
      }),
      signal: options.signal,
    });

    if (!response.ok || !response.body) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const raw of events) {
        const event = parseEvent(raw);
        if (!event) continue;
        if (event.type === 'delta' && typeof event.text === 'string' && event.text) {
          text += event.text;
          options.onDelta?.(event.text);
        } else if (event.type === 'usage') {
          const normalized = normalizeUsage(event.usage);
          if (normalized) {
            usage = normalized;
            options.onUsage?.(normalized);
          }
        } else if (event.type === 'error') {
          failed = true;
        }
      }
    }
  } catch {
    return null;
  }

  if (!text.trim()) return null;
  return { text, usage, incomplete: failed };
}
