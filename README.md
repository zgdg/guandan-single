# 掼蛋练习场（guandan-single）

一个单机 H5 掼蛋练习游戏：你坐南家，北家是队友，东、西家是 AI 对手。发牌、进贡、出牌、接风、升级、结算都按默认竞赛规则完整跑通；轮到用户时给出一条合法建议和理由，一局结束后进入复盘页查看关键决策。项目不做联网匹配、账号体系与多副牌变体。

- 规则内核：纯 TypeScript，位于 [src/core](src/core)，不依赖 React。
- 前端：React 18 + TypeScript + Zustand + Vite。
- AI：内置 L1 / L2 / L3 三档出牌难度；L3 使用采样搜索。
- AI 点评（可选）：通过本地 Node 代理调用 OpenAI 兼容的 LLM 服务，生成复盘点评；不配置模型时自动关闭。
- 测试：Vitest；规则用例位于 [tests/rules](tests/rules)。

## 环境要求

- Node.js 与 npm。仓库的 `package.json` 未声明 `engines`，具体最低 Node 版本**待确认**；构建工具为 Vite 6、tsx 4、TypeScript 5。
- 可选：一个 OpenAI 兼容的 LLM 服务（本地或云端），仅在使用 AI 点评时需要。

## 安装

```bash
npm install
```

## 启动

项目由「前端」与「AI 点评代理」两个进程组成，按需分别启动。

```bash
# 终端 1：前端开发服务器（Vite，带热更新）
npm run dev

# 终端 2（可选）：AI 点评代理，默认监听 127.0.0.1:8788
npm run dev:api
```

各自作用：

- `npm run dev`：启动 Vite 前端开发服务器，终端会打印访问地址。只启动它也能完整对局与复盘；AI 点评关闭时复盘页不显示点评区块。
- `npm run dev:api`：用 `tsx` 运行 [server/index.ts](server/index.ts)，读取 [config/app.config.json](config/app.config.json)，提供 `POST /api/commentary` 流式代理与 `GET /healthz`。Vite 开发/预览在点评开启时会把 `/api/commentary` 转发到该地址。

提示：

- 修改 `config/app.config.json` 或模型相关环境变量后，**两个进程都要重启**；Vite 的开关与路径是构建期注入的。
- 点评配置默认 `auto`：只有 `LLM_BASE_URL` 与 `LLM_MODEL` 都存在时才开启。未配置时 `dev:api` 仍可启动，但 `/api/commentary` 返回 404。
- 详细字段、默认值、报错行为见 [config/README.md](config/README.md)。

## 常用脚本

以下脚本均来自 [package.json](package.json)：

| 脚本 | 实际命令 | 作用 |
| --- | --- | --- |
| `npm run dev` | `vite` | 启动前端开发服务器 |
| `npm run dev:api` | `tsx server/index.ts` | 启动 AI 点评代理 |
| `npm run build` | `tsc --noEmit && vite build` | 类型检查后构建到 `dist/` |
| `npm run typecheck` | `tsc --noEmit` | 只做 TypeScript 类型检查 |
| `npm test` | `vitest run` | 运行全部用例 |
| `npm run test:rules` | `vitest run tests/rules` | 只运行规则用例（不包含 `tests/config`） |
| `npm run test:watch` | `vitest` | 以监听模式运行用例 |
| `npm run sim` | `tsx src/cli/simulate.ts` | 自动对局模拟，统计非法动作/卡死/牌数守恒 |
| `npm run sim:arena` | `tsx src/cli/arena.ts` | 两种 AI 难度的离线对战强度对比 |
| `npm run bench` | `tsx src/cli/bench.ts` | 引擎吞吐基准，输出 P50/P95/P99 |

传递参数时使用 `--` 分隔：

```bash
# 自动模拟 1000 副；--follow-rate 为 AI 跟牌概率（0–1），--quiet 只输出汇总
npm run sim -- --deals=1000 --seed=20261107 --follow-rate=0.35 --quiet

# NS 队 L3 vs EW 队 L2，共 500 副；--a/--b 仅识别 L1/L2/L3，其它值按 L2 处理
npm run sim:arena -- --deals=500 --seed=20261107 --a=L3 --b=L2 --personas --json

# 基准默认 20 副 / 600 个 AI 单步样本 / 50 副 rollout；--json 输出机器可读结果
npm run bench -- --deals=20 --ai-samples=600 --rollout-deals=50 --seed=20261107 --json
```

关于 `preview`：`package.json` 当前**没有** `preview` 脚本。Vite 6 自带 `vite preview`，可在构建后执行 `npx vite preview` 预览 `dist/`；这不是仓库封装的 npm 脚本，本次文档未实际执行该命令（待确认）。

## 目录结构

```text
config/
  app.config.json      # 唯一配置源（合法 JSON，不能写注释）
  loader.ts            # 配置加载与 {{ENV_VAR|默认值}} 占位符解析
  README.md            # 逐字段配置说明
server/
  index.ts             # AI 点评代理（/healthz + /api/commentary SSE）
src/
  core/                # 纯 TS 规则内核：牌型、比较、引擎、枚举、进贡、结算
  ai/                  # AI 出牌策略与难度/人格
  suggest/             # 人类建议：静态评估、信念采样、PIMC、Worker
  review/              # 复盘决策记录、点评 prompt、缓存与 SSE 客户端
  store/               # Zustand 全局状态、本地存档与设置
  ui/                  # 页面、组件与样式（展示层）
  cli/                 # simulate / arena / bench 命令行入口
tests/
  rules/               # 规则与 AI/建议/点评用例
  config/              # 配置加载用例
docs/                  # 规则、规划与实现对照文档
dist/                  # npm run build 产物（可能不存在）
ui-review/             # 本地 UI 走查截图（非运行时依赖）
index.html             # Vite 入口
vite.config.ts         # Vite 配置，构建期注入点评开关与路径
```

## 配置入口

- 唯一配置源：[config/app.config.json](config/app.config.json)（必须保持合法 JSON，**不能添加注释**）。
- 加载器：[config/loader.ts](config/loader.ts)。
- 字段说明：[config/README.md](config/README.md)，涵盖字段路径、类型、必填性、默认值、环境变量、`auto/true/false` 语义、关闭时前端不请求/不渲染、服务端 `404 COMMENTARY_DISABLED`、`/healthz` 字段与重启要求。
- 模型配置通过 `{{ENV_VAR}}` / `{{ENV_VAR|默认值}}` 从**系统环境变量**解析，不再读取 `.env`。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/H5掼蛋练习游戏规划.md](docs/H5掼蛋练习游戏规划.md) | 产品定位、页面交互、规则基线、AI 设计、技术架构、分阶段路线、风险与待确认项、附录（含配置与点评设计） |
| [docs/掼蛋规则汇总.md](docs/掼蛋规则汇总.md) | 掼蛋规则底稿：基础设定、牌型、逢人配、出牌流程、进贡还贡、升级结算、常见变体与待确认清单 |
| [docs/规则实现对照表.md](docs/规则实现对照表.md) | 规则文档到代码的对照：D01–D16 配置项、用例分布、验证命令与当前验证结果 |

建议阅读顺序：先看规划文档了解产品与架构，再以规则汇总为口径依据，最后用实现对照表核对代码与用例。
