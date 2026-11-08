import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAppConfig } from '../../config/loader';

const configPath = resolve(process.cwd(), 'config/app.config.json');

function load(env: Record<string, string>, requireModel = true) {
  return loadAppConfig({ env: env as NodeJS.ProcessEnv, configPath, requireModel });
}

describe('config/loader', () => {
  it('从系统环境变量解析 {{}} 占位符，并提供可选默认值', () => {
    const config = load({
      LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
      LLM_MODEL: 'qwen2.5:7b',
      LLM_API_KEY: 'secret-key',
    });

    expect(config.commentary).toMatchObject({
      host: '127.0.0.1',
      port: 8788,
      endpoint: '/api/commentary',
      model: {
        baseUrl: 'http://127.0.0.1:11434/v1',
        name: 'qwen2.5:7b',
        apiKey: 'secret-key',
        temperature: 0.3,
        timeoutMs: 5000,
      },
    });
  });

  it('可选环境变量覆盖默认值', () => {
    const config = load({
      LLM_BASE_URL: 'http://local/v1',
      LLM_MODEL: 'local',
      LLM_TEMPERATURE: '0.7',
      LLM_TIMEOUT_MS: '9000',
    });
    expect(config.commentary.model.temperature).toBe(0.7);
    expect(config.commentary.model.timeoutMs).toBe(9000);
  });

  it('API_KEY 未设置时留空（按本地模型处理）', () => {
    const config = load({ LLM_BASE_URL: 'http://local/v1', LLM_MODEL: 'local' });
    expect(config.commentary.model.apiKey).toBe('');
  });

  it('必填项缺失且开关开启时报出具体变量名', () => {
    expect(() => load({ COMMENTARY_ENABLED: 'true' })).toThrow(/LLM_BASE_URL/);
    expect(() =>
      load({ COMMENTARY_ENABLED: 'true', LLM_BASE_URL: 'http://local/v1' }),
    ).toThrow(/LLM_MODEL/);
  });

  it('开关默认 auto：未配置模型即关闭，且不解析模型配置', () => {
    const config = load({});
    expect(config.commentary.enabled).toBe(false);
    expect(config.commentary.model.baseUrl).toBe('');
    expect(config.commentary.model.name).toBe('');
  });

  it('开关默认 auto：模型地址与名称齐全时开启', () => {
    const config = load({ LLM_BASE_URL: 'http://local/v1', LLM_MODEL: 'local' });
    expect(config.commentary.enabled).toBe(true);
    expect(config.commentary.model.name).toBe('local');
  });

  it('COMMENTARY_ENABLED=false 可强行关闭，即便模型已配置', () => {
    const config = load({
      COMMENTARY_ENABLED: 'false',
      LLM_BASE_URL: 'http://local/v1',
      LLM_MODEL: 'local',
      LLM_API_KEY: 'secret-key',
    });
    expect(config.commentary.enabled).toBe(false);
    expect(config.commentary.model.apiKey).toBe('');
  });

  it('COMMENTARY_ENABLED=true 但配置缺少 model 段时报错', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'guandan-config-')), 'no-model.json');
    writeFileSync(path, JSON.stringify({ commentary: { enabled: 'true' } }));
    expect(() =>
      loadAppConfig({ env: {} as NodeJS.ProcessEnv, configPath: path }),
    ).toThrow(/缺少 commentary\.model 段/);
  });

  it('开关取值非法时明确报错', () => {
    expect(() => load({ COMMENTARY_ENABLED: 'maybe' })).toThrow(/commentary\.enabled/);
  });

  it('前端构建只注入开关结果，不读模型配置', () => {
    const config = load({}, false);
    expect(config.commentary.enabled).toBe(false);
    expect(config.commentary.endpoint).toBe('/api/commentary');
    expect(config.commentary.model.apiKey).toBe('');
    expect(config.commentary.model.baseUrl).toBe('');
  });

  it('前端构建时若模型已配置，开关为开启', () => {
    const config = load({ LLM_BASE_URL: 'http://local/v1', LLM_MODEL: 'local' }, false);
    expect(config.commentary.enabled).toBe(true);
    expect(config.commentary.model.apiKey).toBe('');
  });

  it('数字型环境变量非法时明确报错', () => {
    expect(() =>
      load({
        LLM_BASE_URL: 'http://local/v1',
        LLM_MODEL: 'local',
        LLM_TEMPERATURE: 'hot',
      }),
    ).toThrow(/commentary\.model\.temperature/);
  });
});
