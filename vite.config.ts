import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { loadAppConfig } from './config/loader';

// P1 起为 H5 单页应用；规则内核仍只存在于 src/core，不依赖 React。
// 唯一配置来源是 config/app.config.json；前端构建只读代理地址，不读模型密钥。
export default defineConfig(() => {
  const config = loadAppConfig({ requireModel: false });
  const { enabled, host, port, endpoint } = config.commentary;
  // 开关关闭时不注入代理、也不注入路径，前端产物里连点评地址都没有。
  const proxy = enabled
    ? {
        [endpoint]: {
          target: `http://${host}:${port}`,
          changeOrigin: true,
        },
      }
    : undefined;

  return {
    base: './',
    plugins: [react()],
    define: {
      __COMMENTARY_ENABLED__: JSON.stringify(enabled),
      __COMMENTARY_ENDPOINT__: JSON.stringify(enabled ? endpoint : ''),
    },
    server: proxy ? { proxy } : {},
    preview: proxy ? { proxy } : {},
    build: {
      outDir: 'dist',
      target: 'es2020',
    },
    // worker 用 ES 模块格式，才能和主包共享公共 chunk，避免 static/pimc 打两份。
    worker: { format: 'es' as const },
  };
});
