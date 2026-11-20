# 插件规范

一个平台 = `plugins/<id>/` 下的两份文件：

```
plugins/breezeblue/
├─ manifest.json   # 元数据、登录 Cookie、域名权限、调度默认值
└─ adapter.json    # 请求、字段提取、成功/失败规则
```

## 登录能力在哪里配置

`manifest.json` 只描述「签到适配器」的 Cookie 名与网络权限。登录页、Cookie 作用域、是否已适配签到，统一在 `src/providers/catalog.ts` 的平台目录里声明：

```ts
{
  id: 'example',
  name: 'Example',
  loginUrl: 'https://example.com/login', // null 表示添加账号时必须填写
  cookieDomains: ['example.com'],        // 只采集这些域及其子域
  primaryCookie: 'example_session',      // 登录完成的判定条件；null 用页面推断
  checkIn: 'adapter',                    // 有 adapter 才能执行签到
  adapterId: 'example',
}
```

自动化条款与官方 API 状态放在 `src/providers/policy.ts`，与 adapter 分开维护：

- `automation: 'allowed'`：条款允许或已获明确授权；
- `'unknown'`：默认值，低频执行并在风险面板提示条款待确认；
- `'prohibited'`：执行器直接拒绝签到。

改完 adapter 后建议先在该平台开启金丝雀：只让一个账号执行，连续 2 天成功再放开。灰度状态存在 `platform_rollout`，可用 `POST /api/risk/canary` 控制。

新增平台的唯一路径是「登录 + 签到」：先在 `plugins/<id>/` 放 `manifest.json` 与 `adapter.json`，再在 `catalog.ts` 登记同一个 `id`，并把 `checkIn` 设为 `'adapter'`。

顺序不能反。`catalog.ts` 只收录已经有 adapter 的平台：控制台里出现的平台都可以直接签到，不存在「能加账号但不能签」的中间状态，所以也不需要 `checkIn: 'none'` 这种占位项。目录接口 `/api/providers` 的 `adapterReady` 由运行时是否加载到插件决定，插件缺失时会显示「缺少适配器」而不是假装可用。

首版只执行随镜像打包的内置插件。`/data/plugins` 下的第三方目录不会被扫描展示，也不会加载代码、执行 hooks，不提供 zip 上传或远程市场。

## manifest.json

| 字段 | 说明 |
|---|---|
| `schemaVersion` | 目前固定 `1` |
| `id` | `^[a-z][a-z0-9-]{2,31}$`，必须与目录名一致 |
| `name` / `version` / `description` | 控制台展示用 |
| `auth.type` | 目前只支持 `cookie` |
| `auth.primaryCookie` | 必须存在的 Cookie 名；缺失时保存会被拒绝 |
| `auth.hintUrl` | 登录页地址，用于弹窗提示 |
| `permissions.network` | 允许访问的 https origin 列表；请求路径必须落在同一 origin |
| `permissions.hooks` | 是否为内置插件加载 hooks；首版不执行第三方 hooks |
| `schedule` | 时区、默认执行时间、抖动秒数、补跑窗口 |
| `limits.timeoutMs` / `maxAttempts` | 单次 HTTP 超时与最大尝试次数 |

## adapter.json

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://example.com",
  "defaultHeaders": { "origin": "https://example.com", "referer": "https://example.com/app" },
  "requests": {
    "summary": { "method": "GET", "path": "/api/summary" },
    "claim": { "method": "POST", "path": "/api/claim", "body": {} }
  },
  "extract": {
    "summary": { "balance": "$.balance", "claimedToday": "$.claimed_today", "available": "$.available", "amount": "$.amount", "resetAt": "$.next_reset" },
    "claim": { "claimed": "$.claimed", "creditsIssued": "$.credits", "balance": "$.balance", "code": "$.code" }
  },
  "rules": {
    "preflight": [
      { "source": "summary", "field": "claimedToday", "op": "eq", "value": true, "result": "ALREADY_CLAIMED" },
      { "source": "summary", "field": "available", "op": "eq", "value": false, "result": "NOT_AVAILABLE" }
    ],
    "claim": [
      { "source": "claim", "field": "claimed", "op": "eq", "value": true, "result": "CLAIMED" },
      { "source": "claim", "field": "claimed", "op": "eq", "value": false, "result": "CLAIM_REJECTED" }
    ],
    "verify": [
      { "source": "verify", "field": "claimedToday", "op": "eq", "value": true, "result": "VERIFIED" },
      { "source": "verify", "field": "claimedToday", "op": "eq", "value": false, "result": "VERIFY_MISMATCH" }
    ]
  },
  "errors": [
    { "bodyCode": "AUTH_REQUIRED", "error": "AUTH_REQUIRED" },
    { "status": [401], "error": "AUTH_REQUIRED" },
    { "status": [403], "messageIncludes": "origin is not allowed", "error": "ORIGIN_BLOCKED" },
    { "status": [403], "error": "CHALLENGE_DETECTED" },
    { "status": [429], "error": "RATE_LIMITED" },
    { "statusMin": 500, "error": "HTTP_5XX", "retry": true },
    { "contentTypeIncludes": "text/html", "error": "CHALLENGE_DETECTED" }
  ],
  "retry": { "maxAttempts": 3, "backoffMs": [1500, 3000] }
}
```

### 可选项：没有「领取按钮」的平台

有些平台不存在独立的领取接口（例如魔搭：调用一次登录信息接口就触发当日发放）。这类平台可以：

- 省略 `requests.claim`，只把 `summary` 当作状态读取；
- 用 `requests.verify` 指向「复核请求」，缺省时复用 `summary`；
- 用 `extract.verify` 覆盖复核响应的取值路径，缺省时复用 `extract.summary`；
- 把 `rules.claim` 留空：HTTP 2xx 即视为已触发，最终以复核为准。

### 可选项：账单模式（`ledger`）

平台不给「今天领没领」的布尔值、只给流水时，配置 `ledger`：

```json
"ledger": {
  "records": ["$.Data.records", "$.data.records"],
  "dateField": "gmt_created",
  "typeField": "type",
  "typeValue": "EARN",
  "ruleKeys": ["daily_active", "aliyun_bindlogin"],
  "amountField": "total_amount",
  "timezone": "Asia/Shanghai"
}
```

配置后的行为：preflight 先读一次流水判断今天是否已到账（已到账直接返回 `already_claimed`，不再触发）；触发后再读流水，**只认**当天、`typeValue` 匹配、`rule_key` 在白名单里的记录。余额增量退化为参考值——账单入账有延迟，不能拿余额当唯一证据。第一次没查到会等待 2.5 秒重读一次，仍没有才记 `unverified`。

`records`、以及 `extract` 里的每个字段都支持给候选路径数组，按顺序取第一个非空值，用来兼容上游 `Data` / `data` 两套信封。

### 路径

只支持 `$`、`.key`、`['key']`、`[0]`、`[*]`（取首元素）和可选链。没有过滤表达式、函数、递归；运行时不使用 `eval`。

### 规则

- `source`：`summary` / `claim` / `verify`
- `field`：`extract` 里定义的键
- `op`：`eq` / `neq` / `truthy` / `falsy` / `gte` / `lte` / `includes`
- 顺序匹配，第一条命中生效
- 领取成功后**必须**再读 summary 并核对余额；只凭 `claimed=true` 不会标记为成功

### 错误分类

按顺序匹配 `status` / `statusMin` / `bodyCode` / `messageIncludes` / `contentTypeIncludes`。

- 401 / `AUTH_REQUIRED` → `needs_reauth`
- 403 + `origin is not allowed` → `ORIGIN_BLOCKED`（配置错误，不重试）
- 其它 403 / HTML → `CHALLENGE_DETECTED`（停止，不绕过）
- 429 → `RATE_LIMITED`（不自动重试）
- 5xx / 网络 → `retry` 指定重试
- 2xx 但缺字段 → `SCHEMA_MISMATCH` / 未验证

## 可选 hooks（内置插件，后续扩展）

BreezeBlue 不需要 hooks；首版也不执行第三方 hooks。未来内置插件可以在 `plugins/<id>/hooks.js` 导出：

```ts
export interface HookContext {
  http: { get(path: string): Promise<Response>; post(path: string, body?: unknown): Promise<Response> };
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface PlatformHooks {
  beforeClaim?(ctx: HookContext, summary: Record<string, unknown>): Promise<{ skip?: boolean; reason?: string }>;
  classify?(ctx: HookContext, response: { status: number; json: unknown }): Promise<string | null>;
  afterClaim?(ctx: HookContext, outcome: { verified: boolean }): Promise<{ verified?: boolean; note?: string }>;
}
```

约束：

- 只能访问 manifest 声明的域名
- 无 `fs` / `process` / 原生 `fetch`
- 单次 3 秒超时
- 只对内置插件启用；第三方 hooks 需要单独做沙箱、签名和权限审计

## 新增一个平台的顺序

1. 新建 `plugins/<id>/manifest.json` 与 `adapter.json`
2. 确认 `permissions.network` 与 `baseUrl` 同源，所有 path 以 `/` 开头
3. 用只读 summary 先确认 Cookie 与字段名
4. 在 `test/` 加成功、已领、401、403 origin、429、5xx、HTML 挑战的契约样本
5. `npm test`、`npm run build`
6. 在控制台「插件 → 重新扫描」查看；首版只启用内置插件

## 安全边界

- 请求只允许 manifest 声明的 https origin；重定向不复跟
- Cookie 由用户输入，加密保存在本机；API 不回显、日志不落原文
- 不执行第三方代码；不提供远程安装
- 遇到验证码/二次验证/挑战即停止，不绕过
- 自动化可能违反平台条款，账号风险由使用者承担
