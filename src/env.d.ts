/**
 * 构建期由 vite.config.ts 从 config/app.config.json 注入。
 * - enabled：AI 点评开关，关闭时前端不会发起任何点评请求。
 * - endpoint：前端公开请求路径。
 * 两者都不含模型配置或密钥。
 */
declare const __COMMENTARY_ENABLED__: boolean | undefined;
declare const __COMMENTARY_ENDPOINT__: string | undefined;
