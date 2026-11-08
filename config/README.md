# 配置说明

本目录的 [app.config.json](app.config.json) 是项目唯一的配置来源，由 [loader.ts](loader.ts) 解析。主 README 的配置入口见 [../README.md](../README.md)。

> **不要在该 JSON 中写注释。** 加载器使用 `JSON.parse` 读取文件，任何注释都会导致解析失败、`npm run dev` / `npm run dev:api` / `npm run build` 无法启动。字段说明统一放在本文档；`app.config.json` 顶部的 `_doc` 字段只是指向本文档的普通字符串字段，加载器会忽略它。

## 1. 读取方式与生效时机

- 默认路径：`process.cwd()/config/app.config.json`。npm 脚本需在仓库根目录执行，否则会读不到配置。
- 服务端 `npm run dev:api`（[server/index.ts](../server/index.ts)）调用 `loadAppConfig()`，要求模型配置完整。
- 前端开发/构建（[vite.config.ts](../vite.config.ts)）调用 `loadAppConfig({ requireModel: false })`，只读取开关、端口与路径，不读取模型密钥；开关结果与公开路径在构建期注入前端产物。
- 配置文件和系统环境变量都在进程启动/构建开始时读取。改完后必须重启 `npm run dev` 与 `npm run dev:api`；如果改了配置后要重新构建产物，也需要重新执行 `npm run build`（Vite 不会热更新构建期注入值）。

配置文件本身出错时的行为：

| 情况 | 实际结果 |
| --- | --- |
| 文件不存在、无读取权限或 JSON 不合法 | 抛出 `读取配置文件失败（<绝对路径>）：<原始错误>`；`dev:api` 打印 `[commentary] 启动失败：...` 后以退出码 1 结束；Vite 启动/构建失败 |
| 根对象缺少 `commentary` 段 | 抛出 `配置文件缺少 commentary 段（<绝对路径>）`，表现同上 |

## 2. 占位符语法

字符串字段可以写成占位符，从**系统环境变量**取值：

- `{{ENV_VAR}}`：无默认值。
- `{{ENV_VAR|默认值}}`：环境变量未设置或为空时使用默认值。

实际解析规则（[loader.ts](loader.ts) 的 `resolvePlaceholder`）：

1. 占位符必须**占满整个字符串**才会被识别。例如 `abc{{FOO}}` 会被当作普通字面量，不会替换。
2. 环境变量值会去掉首尾空白；只有空白字符或空字符串视为“未设置”。
3. 没有默认值且非必填时解析为 `''`（空字符串）。
4. 没有默认值且必填时抛错：`必填环境变量 <变量名> 未设置（配置项 <字段路径>）`。
5. 字段值为数字时先转成字符串再处理；对象等其它类型抛错：`配置项 <字段路径> 必须是字符串或数字`。
6. 字段缺失（`undefined`）时：必填抛 `配置项 <字段路径> 缺失`，非必填返回 `''`。

数字字段（`port`、`temperature`、`timeoutMs`）在占位符解析后再用 `Number()` 转换：

- 空字符串或无占位符时使用代码内置默认值（JSON 中的写法见下表）。
- 非空且不是合法数字：`配置项 <字段路径> 不是合法数字：<原值>`。
- 另有专门校验：`port`、`timeoutMs` 必须 `> 0`，否则分别抛 `配置项 commentary.port 必须为正整数` / `配置项 commentary.model.timeoutMs 必须为正整数`。注意实现只校验“大于 0”，小数也会通过，报错文案中的“正整数”是文案而非严格整数校验。

## 3. 字段逐项说明

| 字段路径 | 类型 | 是否必填 | 默认值 | 可选值 / 约束 | 对应环境变量 | 缺失或非法时的实际行为 |
| --- | --- | --- | --- | --- | --- | --- |
| `commentary` | object | 是 | 无 | 必须是对象 | 无 | 缺失时 `配置文件缺少 commentary 段（<路径>）` |
| `commentary.enabled` | string（可含占位符） | 否 | `auto` | `auto` / `true` / `false`（大小写不敏感，去首尾空白）；实现还接受 `1`、`on` 等价 `true`，`0`、`off` 等价 `false` | `COMMENTARY_ENABLED`（JSON 中为 `{{COMMENTARY_ENABLED\|auto}}`） | 空值或缺失按 `auto`；其它值抛 `配置项 commentary.enabled 只接受 auto / true / false，当前值：<值>`。三种语义见第 4 节 |
| `commentary.host` | string | 否 | `127.0.0.1` | 任意可监听的主机名/IP | 默认无；改成占位符后可用任意环境变量 | 缺失用默认值；非字符串/数字抛 `配置项 commentary.host 必须是字符串或数字`；不校验 IP 格式，监听失败由 Node 抛出 |
| `commentary.port` | number 或数字字符串 | 否 | `8788` | `> 0` 的有限数字 | 默认无；改成占位符后可用任意环境变量 | 缺失/空值用 `8788`；不是数字抛 `不是合法数字`；`<= 0` 抛 `必须为正整数` |
| `commentary.endpoint` | string | 否 | `/api/commentary` | 以 `/` 开头的 HTTP 路径（加载器不校验格式） | 默认无；改成占位符后可用任意环境变量 | 缺失用默认值；不校验路径格式。置为空字符串时前端不会发请求，服务端 `POST` 也匹配不到该路径，实际返回 `404 NOT_FOUND` |
| `commentary.model` | object | 条件必填 | 无 | 必须是对象 | 无 | 当 `enabled` 解析为 `true` 且服务端加载（`requireModel=true`）时缺失，抛 `AI 点评已开启，但配置文件缺少 commentary.model 段`；关闭或前端构建时允许缺失，回落到空模型配置 |
| `commentary.model.baseUrl` | string | 条件必填 | 无 | OpenAI 兼容接口根地址；服务端会拼接 `/chat/completions` | `LLM_BASE_URL`（JSON 中为 `{{LLM_BASE_URL}}`） | 模型段存在但该字段缺失且处于“开启 + 服务端”状态：`配置项 commentary.model.baseUrl 缺失`；占位符未设置：`必填环境变量 LLM_BASE_URL 未设置（配置项 commentary.model.baseUrl）`。字面量空字符串不会在加载时报错，但请求时会因 URL 不合法而失败。关闭或前端构建时不报错，值为 `''` |
| `commentary.model.name` | string | 条件必填 | 无 | 服务商模型名 | `LLM_MODEL`（JSON 中为 `{{LLM_MODEL}}`） | 同上，错误信息分别对应 `commentary.model.name` / `LLM_MODEL` |
| `commentary.model.apiKey` | string | 否 | `''` | 任意密钥字符串 | `LLM_API_KEY`（JSON 中为 `{{LLM_API_KEY}}`） | 未设置时留空，服务端请求不带 `Authorization` 头（按无需鉴权的本地模型处理） |
| `commentary.model.temperature` | number 或数字字符串 | 否 | `0.3` | 有限数字；加载器不做范围校验（负数也会通过） | `LLM_TEMPERATURE`（JSON 中为 `{{LLM_TEMPERATURE\|0.3}}`） | 缺失/空值用 `0.3`；非数字抛 `配置项 commentary.model.temperature 不是合法数字：<值>` |
| `commentary.model.timeoutMs` | number 或数字字符串 | 否 | `5000` | `> 0` 的有限数字 | `LLM_TIMEOUT_MS`（JSON 中为 `{{LLM_TIMEOUT_MS\|5000}}`） | 缺失/空值用 `5000`；非数字抛 `不是合法数字`；`<= 0` 抛 `配置项 commentary.model.timeoutMs 必须为正整数` |

补充说明：

- `commentary.model` 的“条件必填”只在 `dev:api` / 服务端成立。`npm run dev` 与 `npm run build` 使用 `requireModel: false`，缺少模型环境变量不会导致前端启动或构建失败。
- `enabled=false` 时，服务端不会解析必填模型项，也不会因缺少 `LLM_BASE_URL` / `LLM_MODEL` 退出。
- 若把 JSON 中的数字字段改成无默认值的占位符（例如 `"port": "{{MY_PORT}}"`），环境变量未设置时最终仍会回落到 `8788` / `0.3` / `5000`，因为加载器在数值解析前会套用内置默认值。

## 4. `commentary.enabled` 的三种语义

| 取值 | 含义 | 结果 |
| --- | --- | --- |
| `auto`（默认，含空值） | 按模型是否配置自动决定 | 仅当 `commentary.model.baseUrl` 与 `commentary.model.name` 解析后都非空时开启；`apiKey` 不参与判断。两者任一为空则关闭 |
| `true`（也接受 `1` / `on`） | 强制开启 | 服务端若缺少 `commentary.model` 段会在启动时报错；模型段存在但必填环境变量缺失也会启动失败。前端构建（`requireModel=false`）仍会成功，但后端未就绪时复盘页会显示“暂不可用”降级文案 |
| `false`（也接受 `0` / `off`） | 强制关闭 | 即使模型配置齐全也关闭；服务端不解析必填模型项；前端构建不注入路径与代理 |

`auto` 的实际判断代码位于 [loader.ts](loader.ts)：`modelConfigured` 只检查 `baseUrl` 与 `name` 解析结果是否非空。

## 5. 开启 / 关闭时的实际行为

### 5.1 前端（构建期注入）

- Vite 构建时注入两个常量：`__COMMENTARY_ENABLED__`（布尔）与 `__COMMENTARY_ENDPOINT__`（公开路径）。
- 关闭时：`__COMMENTARY_ENABLED__=false`，`__COMMENTARY_ENDPOINT__=''`，**不注册** `/api/commentary` 代理。复盘页 effect 直接早退，**不发起任何请求、不渲染点评区块**，也不会出现“暂不可用”提示。
- 开启时：注入 `true` 与 `commentary.endpoint`，Vite 开发/预览把该路径代理到 `http://<commentary.host>:<commentary.port>`。若代理未启动、超时或断流，复盘页显示“AI 点评暂不可用（未配置或服务未启动），不影响上面的复盘内容”；已有部分文本时标记“点评未完整生成”。
- 前端产物只包含上述布尔与公开路径，不包含模型地址、密钥或环境变量名。

### 5.2 服务端（`npm run dev:api`）

- 无论开关是否开启，只要配置本身合法，服务都会监听 `commentary.host:commentary.port`。
- `GET /healthz` 始终返回 `200`：

  | 字段 | 含义 |
  | --- | --- |
  | `ok` | 固定 `true` |
  | `enabled` | 解析后的开关布尔值 |
  | `configured` | 当前实现直接取 `enabled`，不单独表示“密钥是否配置” |
  | `model` | 开启时为 `commentary.model.name`，关闭时为 `null` |

- 关闭时：`POST commentary.endpoint` 返回 `404`，响应体为 `{ "error": "COMMENTARY_DISABLED", "message": "AI 点评已在 config/app.config.json 中关闭" }`；不暴露代理逻辑。
- 其它方法或路径（包括 `GET commentary.endpoint`）：`404`，响应体为 `{ "error": "NOT_FOUND" }`。
- 开启时：`POST commentary.endpoint` 校验请求体（要求 `dealNo` / `result` / `decisions`，且 `decisions` 不超过 40 条），以 SSE 流式转发至 `<baseUrl>/chat/completions`；请求体非法返回 `400 { "error": "BAD_REQUEST" }`，上游失败/超时通过 SSE `error` 事件返回。

## 6. 环境变量设置

本项目**不读取 `.env` 文件**，所有 `{{}}` 占位符只从当前进程的系统环境变量解析。

| 环境变量 | 作用 | 是否必填 |
| --- | --- | --- |
| `LLM_BASE_URL` | OpenAI 兼容接口根地址，服务端拼接 `/chat/completions` | 点评开启且运行 `dev:api` 时必填 |
| `LLM_MODEL` | 模型名 | 点评开启且运行 `dev:api` 时必填 |
| `LLM_API_KEY` | 接口密钥；为空时不发送 `Authorization` 头 | 否 |
| `LLM_TEMPERATURE` | 采样温度，默认 `0.3` | 否 |
| `LLM_TIMEOUT_MS` | 上游超时（毫秒），默认 `5000` | 否 |
| `COMMENTARY_ENABLED` | 总开关，`auto` / `true` / `false` | 否，默认 `auto` |

Windows PowerShell 当前会话示例：

```powershell
$env:LLM_BASE_URL = "http://127.0.0.1:11434/v1"
$env:LLM_MODEL = "qwen2.5:7b"
$env:LLM_API_KEY = "your-key"          # 本地无鉴权模型可省略
$env:LLM_TEMPERATURE = "0.3"           # 可选
$env:LLM_TIMEOUT_MS = "5000"           # 可选
npm run dev:api
```

需要永久写入用户环境变量时可用 `setx`（新开的终端才会生效）：

```powershell
setx LLM_BASE_URL "http://127.0.0.1:11434/v1"
setx LLM_MODEL "qwen2.5:7b"
setx LLM_API_KEY "your-key"
```

修改环境变量后：

- 必须重启 `npm run dev:api`，否则服务端仍使用旧值。
- 必须重启 `npm run dev`；因为开关与点评路径是 Vite 构建期注入的。
- 若要重新构建产物，必须重新执行 `npm run build`（同样是为了重新注入构建期常量）。

## 7. 自查建议

```powershell
# 1. 确认 JSON 合法（注释会导致这里直接失败）
Get-Content config/app.config.json -Raw | ConvertFrom-Json | Out-Null

# 2. 查看服务端实际解析结果
Invoke-RestMethod http://127.0.0.1:8788/healthz

# 3. 配置相关用例
npx vitest run tests/config/loader.test.ts
```
