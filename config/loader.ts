import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 唯一配置文件 `config/app.config.json` 的加载器。
 *
 * 字符串值支持 `{{环境变量名}}` 占位符；可选值可写 `{{环境变量名|默认值}}`。
 * - 服务端启动时调用 `loadAppConfig()`：必填项（baseUrl、model）缺失会抛出带变量名的错误。
 * - 前端构建时调用 `loadAppConfig({ requireModel: false })`：只读端口/路径，不解析模型密钥。
 */

export interface CommentaryModelConfig {
  baseUrl: string;
  name: string;
  apiKey: string;
  temperature: number;
  timeoutMs: number;
}

export interface AppConfig {
  commentary: {
    /** AI 点评总开关；关闭时前端不请求、服务端不暴露接口。 */
    enabled: boolean;
    host: string;
    port: number;
    endpoint: string;
    model: CommentaryModelConfig;
  };
}

export interface LoadAppConfigOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  /** 默认 true；前端构建传 false，避免因缺少模型环境变量而失败。 */
  requireModel?: boolean;
}

const PLACEHOLDER = /^\{\{([A-Za-z_][A-Za-z0-9_]*)(?:\|([^}]*))?\}\}$/;

function resolvePlaceholder(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  required: boolean,
): string {
  if (raw === undefined || raw === null) {
    if (required) throw new Error(`配置项 ${path} 缺失`);
    return '';
  }
  if (typeof raw !== 'string') {
    if (typeof raw === 'number') return String(raw);
    throw new Error(`配置项 ${path} 必须是字符串或数字`);
  }
  const match = PLACEHOLDER.exec(raw.trim());
  if (!match) return raw;
  const variable = match[1]!;
  const fallback = match[2];
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (fallback !== undefined) return fallback.trim();
  if (required) {
    throw new Error(`必填环境变量 ${variable} 未设置（配置项 ${path}）`);
  }
  return '';
}

function readNumber(raw: unknown, path: string, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`配置项 ${path} 不是合法数字：${raw}`);
  }
  return fallback;
}

export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const configPath = options.configPath ?? resolve(process.cwd(), 'config/app.config.json');
  const env = options.env ?? process.env;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`读取配置文件失败（${configPath}）：${(error as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || !(raw as { commentary?: unknown }).commentary) {
    throw new Error(`配置文件缺少 commentary 段（${configPath}）`);
  }

  const commentary = (raw as { commentary: Record<string, unknown> }).commentary;
  const requireModel = options.requireModel ?? true;
  const host = resolvePlaceholder(commentary.host ?? '127.0.0.1', env, 'commentary.host', false);
  const port = readNumber(
    resolvePlaceholder(commentary.port ?? 8788, env, 'commentary.port', false) || 8788,
    'commentary.port',
    8788,
  );
  if (port <= 0) throw new Error('配置项 commentary.port 必须为正整数');
  const endpoint = resolvePlaceholder(
    commentary.endpoint ?? '/api/commentary',
    env,
    'commentary.endpoint',
    false,
  );

  const modelRaw = commentary.model;
  const model = modelRaw && typeof modelRaw === 'object' ? (modelRaw as Record<string, unknown>) : null;
  const blankModel: CommentaryModelConfig = {
    baseUrl: '',
    name: '',
    apiKey: '',
    temperature: 0.3,
    timeoutMs: 5000,
  };

  // 开关：auto（默认）表示「未配置模型就当作关闭」，也可用环境变量强制 true/false。
  const switchText = resolvePlaceholder(
    commentary.enabled ?? 'auto',
    env,
    'commentary.enabled',
    false,
  )
    .trim()
    .toLowerCase();
  const modelConfigured = Boolean(
    model &&
      resolvePlaceholder(model.baseUrl, env, 'commentary.model.baseUrl', false) &&
      resolvePlaceholder(model.name, env, 'commentary.model.name', false),
  );
  let enabled: boolean;
  if (switchText === '' || switchText === 'auto') enabled = modelConfigured;
  else if (switchText === 'true' || switchText === '1' || switchText === 'on') enabled = true;
  else if (switchText === 'false' || switchText === '0' || switchText === 'off') enabled = false;
  else {
    throw new Error(`配置项 commentary.enabled 只接受 auto / true / false，当前值：${switchText}`);
  }

  if (!model) {
    if (requireModel && enabled) {
      throw new Error('AI 点评已开启，但配置文件缺少 commentary.model 段');
    }
    return { commentary: { enabled, host, port, endpoint, model: blankModel } };
  }

  // 前端构建只需要 enabled 这一个布尔值，不接触模型配置与密钥。
  if (!requireModel || !enabled) {
    return { commentary: { enabled, host, port, endpoint, model: blankModel } };
  }

  const temperature = readNumber(
    resolvePlaceholder(model.temperature ?? 0.3, env, 'commentary.model.temperature', false) || 0.3,
    'commentary.model.temperature',
    0.3,
  );
  const timeoutMs = readNumber(
    resolvePlaceholder(model.timeoutMs ?? 5000, env, 'commentary.model.timeoutMs', false) || 5000,
    'commentary.model.timeoutMs',
    5000,
  );
  if (timeoutMs <= 0) throw new Error('配置项 commentary.model.timeoutMs 必须为正整数');

  return {
    commentary: {
      enabled,
      host,
      port,
      endpoint,
      model: {
        baseUrl: resolvePlaceholder(model.baseUrl, env, 'commentary.model.baseUrl', true),
        name: resolvePlaceholder(model.name, env, 'commentary.model.name', true),
        apiKey: resolvePlaceholder(model.apiKey, env, 'commentary.model.apiKey', false),
        temperature,
        timeoutMs,
      },
    },
  };
}
