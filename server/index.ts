import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { buildCommentaryPrompt, type CommentaryInput, type TokenUsage } from '../src/review/commentary';
import { loadAppConfig, type CommentaryModelConfig } from '../config/loader';

/**
 * LLM 复盘点评的后端代理（可选组件）。
 *
 * 所有配置来自根目录 `config/app.config.json`，模型项用 `{{环境变量名}}`
 * 占位符在启动时解析为系统环境变量：
 * - {{LLM_BASE_URL}}  OpenAI 兼容接口的根地址（必填）
 * - {{LLM_MODEL}}     模型名（必填）
 * - {{LLM_API_KEY}}   可选；为空时按本地模型处理，不发送鉴权头
 * - {{LLM_TEMPERATURE|0.3}}  可选，默认 0.3
 * - {{LLM_TIMEOUT_MS|5000}}  可选，默认 5000
 *
 * 代理只转发「结构化决策摘要」，不接触任何隐藏手牌；流式输出给前端，
 * 并把服务商返回的 token 用量回传（前端本地记录）。
 */

type ProxyErrorCode = 'BAD_REQUEST' | 'UPSTREAM_STATUS' | 'UPSTREAM_ERROR' | 'TIMEOUT';

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function sendEvent(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseHeaders(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1_000_000) throw new Error('E_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isCommentaryInput(value: unknown): value is CommentaryInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<CommentaryInput>;
  return (
    Number.isFinite(input.dealNo) &&
    typeof input.result === 'string' &&
    Array.isArray(input.decisions) &&
    input.decisions.length <= 40
  );
}

function normalizeUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, number | undefined>;
  const prompt = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completion = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const total = Number(usage.total_tokens ?? usage.totalTokens ?? prompt + completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

interface UpstreamChunk {
  text: string;
  usage: TokenUsage | null;
}

function parseUpstreamData(raw: string): UpstreamChunk | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const body = parsed as {
    choices?: Array<{ delta?: { content?: unknown } }>;
    usage?: unknown;
  };
  const content = body.choices?.[0]?.delta?.content;
  return {
    text: typeof content === 'string' ? content : '',
    usage: normalizeUsage(body.usage),
  };
}

async function proxyCommentary(
  request: IncomingMessage,
  response: ServerResponse,
  config: CommentaryModelConfig,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: 'BAD_REQUEST', message: '请求体不是合法 JSON' });
    return;
  }
  if (!isCommentaryInput(payload)) {
    sendJson(response, 400, { error: 'BAD_REQUEST', message: '缺少 dealNo / result / decisions' });
    return;
  }

  const prompt = buildCommentaryPrompt(payload);
  const controller = new AbortController();
  let timedOut = false;
  let clientClosed = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  // IncomingMessage 的 close 在请求体读完就会触发，必须监听响应侧的提前断开。
  response.on('close', () => {
    if (!response.writableEnded) {
      clientClosed = true;
      controller.abort();
    }
  });

  sseHeaders(response);

  const finish = (code: ProxyErrorCode, message: string): void => {
    clearTimeout(timer);
    if (!response.writableEnded) {
      sendEvent(response, { type: 'error', code, message });
      response.end();
    }
  };

  try {
    const upstream = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.name,
        temperature: config.temperature,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      finish('UPSTREAM_STATUS', `上游返回 ${upstream.status}`);
      return;
    }
    if (!upstream.body) {
      finish('UPSTREAM_ERROR', '上游没有返回流式响应');
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: TokenUsage | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        const chunk = parseUpstreamData(data);
        if (!chunk) continue;
        if (chunk.text) sendEvent(response, { type: 'delta', text: chunk.text });
        if (chunk.usage) {
          usage = chunk.usage;
          sendEvent(response, { type: 'usage', usage: chunk.usage });
        }
      }
    }

    // 部分服务商的最后一帧没有换行，补处理剩余缓冲。
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data !== '[DONE]') {
        const chunk = parseUpstreamData(data);
        if (chunk) {
          if (chunk.text) sendEvent(response, { type: 'delta', text: chunk.text });
          if (chunk.usage) {
            usage = chunk.usage;
            sendEvent(response, { type: 'usage', usage: chunk.usage });
          }
        }
      }
    }

    clearTimeout(timer);
    if (usage) {
      // 只记录用量，不记录点评内容与任何牌面信息。
      console.log(
        JSON.stringify({
          event: 'commentary_usage',
          model: config.name,
          dealNo: payload.dealNo,
          ...usage,
        }),
      );
    }
    if (!response.writableEnded) {
      sendEvent(response, { type: 'done', usage });
      response.end();
    }
  } catch (error) {
    clearTimeout(timer);
    if (clientClosed) return;
    if (timedOut) {
      finish('TIMEOUT', `超过 ${config.timeoutMs}ms 未完成`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    finish('UPSTREAM_ERROR', message);
    console.error(JSON.stringify({ event: 'commentary_error', message }));
  }
}

function main(): void {
  let config: ReturnType<typeof loadAppConfig>;
  try {
    config = loadAppConfig();
  } catch (error) {
    // 必填环境变量缺失时直接启动失败，并点名是哪一个变量。
    console.error(`[commentary] 启动失败：${(error as Error).message}`);
    process.exit(1);
  }

  const { enabled, host, port, endpoint, model } = config.commentary;

  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? '';

    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        enabled,
        configured: enabled,
        model: enabled ? model.name : null,
      });
      return;
    }

    if (request.method !== 'POST' || path !== endpoint) {
      sendJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }

    // 开关关闭时不暴露点评接口：明确返回 404，便于探活与排查。
    if (!enabled) {
      sendJson(response, 404, {
        error: 'COMMENTARY_DISABLED',
        message: 'AI 点评已在 config/app.config.json 中关闭',
      });
      return;
    }

    void proxyCommentary(request, response, model);
  });

  server.listen(port, host, () => {
    const actualPort = (server.address() as { port?: number } | null)?.port ?? port;
    console.log(
      JSON.stringify({
        event: 'commentary_proxy_ready',
        enabled,
        host,
        port: actualPort,
        endpoint: enabled ? endpoint : null,
        model: enabled ? model.name : null,
        auth: enabled && model.apiKey ? 'bearer' : 'none',
        timeoutMs: model.timeoutMs,
      }),
    );
  });
}

main();
