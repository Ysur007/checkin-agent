# checkin-agent

本地优先的签到执行台：把浏览器里的登录态加密存进自己的 NAS，按平台调用真实签到接口，用账本保证一天只签一次，再把每一步写进可追溯的记录。

目前**只接入了一个平台**：BreezeBlue。列表里出现的平台都可以直接签到，没有「先加进来、以后再说」的占位项。

## 适配情况

| 平台 | 登录凭证 | 签到 |
|---|---|---|
| BreezeBlue | 浏览器扩展一键回传，或粘贴 Cookie / cURL | 真实调用 `GET /api/credits/summary`、`POST /api/credits/daily-claim`，领取后读 summary + 余额复核 |

判定成功要同时满足三件事：claim 返回 `claimed=true`、summary 里 `claimedToday=true`、余额增量不少于 credits。任何一项对不上就记为 `unverified`，**不写账本、不算成功**。

新增平台的方式见「[新增平台](#新增平台)」。

## 它解决什么

| 能力 | 实现 |
|---|---|
| 登录凭证获取 | 浏览器扩展读当前站点 Cookie（含 HttpOnly），Bearer 令牌回传；也支持手动粘贴 Cookie 头或整段 cURL |
| 加密保存 | `AES-256-GCM`，AAD 绑定账号 ID；密钥 `/data/app.key`（0600）；接口只返回字段名、长度与指纹 |
| 登录态维护 | 记录 `cookie_expires_at`；每 30 分钟扫一遍，过期直接标记 `needs_reauth` 且不再发请求；未过期的账号最多每 6 小时调一次只读 summary |
| 签到执行 | 手动单个 / 全部 / 定时，全局串行，失败重试有上限 |
| 防重复 | `claim_days(account_id, local_date)` 复合主键账本，数据库层挡住重复 |
| 结果记录 | 每次运行记录 HTTP 状态、耗时、字节数、requestId、领取前后余额与复核结论；记录按天聚合 |
| 风险控制 | 随机窗口、单并发、每小时启动上限、平台熔断、会话健康分、一键暂停、灰度、出口基线 |
| 安全 | 单管理员 + CSRF + 登录限流；Cookie 加密、日志脱敏、审计日志 |

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：设置 ADMIN_PASSWORD（至少 8 位），或留空首次打开时在控制台设置
docker compose up -d --build
```

打开 `http://<NAS-IP>:8787`，首次进入设置管理密码，然后：

1. 签到中心 → 添加账号 → 选 BreezeBlue；
2. 按弹窗提示保存一次登录 Cookie（扩展自动回传，或粘贴 Cookie 头 / cURL）；
3. 保存时服务端会用这份 Cookie 调一次只读 summary：通过才标记「已验证」，失败会返回具体原因（401、验证挑战、字段缺失）；
4. 回到签到中心点「签到」，或交给定时任务。

## 登录凭证：两种方式

浏览器不允许一个站点读取另一个站点的 Cookie（尤其是 HttpOnly 的 session），所以凭证只能从你自己的浏览器里取出。服务端没有任何浏览器进程，镜像里也没有 Chromium。

### 方式一：浏览器扩展（推荐，装一次之后全自动）

`extension/` 是一个 MV3 扩展，服务端也直接提供下载：`/checkin-agent-extension.zip`。

1. 控制台 → 设置 → 浏览器扩展 → 下载并解压
2. `chrome://extensions`（Edge 是 `edge://extensions`）→ 打开开发者模式 → 加载已解压的扩展程序
3. 在同一张卡片里点「生成扩展令牌」，把令牌和控制台地址填进扩展弹窗
4. 登录平台后点扩展图标 → 选择目标账号 →「读取当前站点 Cookie 并保存」

下拉框里有两类选项：已有的账号，和「＋ 新建账号（平台名）」。选已有账号会**覆盖**它的登录态（适合原账号登录过期后刷新）；想保留原来的登录态、再存一个（主号 / 小号 / 另一台浏览器），选「＋ 新建账号」，服务端会建一条独立账号记录，互不影响。弹窗底部会明确写出这次是覆盖还是新建。

扩展用 `chrome.cookies` 读取**当前标签所属站点**的 Cookie，带上 Bearer 令牌 POST 到 `/api/ext/cookie`。令牌只存 SHA-256 哈希、可随时吊销；扩展除了把 Cookie 发给你的控制台，不联网保存任何东西。

### 方式二：复制一次

控制台 → 账号 →「登录 / 更新」→ 打开平台登录页 → 登录后按 `F12` → **Network** → 任意请求 → 复制 `cookie` 请求头；或右键请求 → **Copy as cURL** 整段复制。

三种粘贴格式都能识别：纯 Cookie 头、`Cookie: ...` 前缀、整段 cURL（服务端自己挑出 cookie 那一行）。

## Cookie 生命周期

```
保存
  → 解析 Cookie 字段，缺主 Cookie（breeze_blue_session）直接拒绝
  → 调平台 summary 只读校验
      ├─ 401/403 → 不保存，返回具体原因
      ├─ 网络/5xx → 保存但标记未验证，返回 warning
      └─ 通过 → AES-256-GCM 加密写库，记录过期时间与指纹

巡检（服务启动后每 30 分钟扫一遍）
  → cookie_expires_at 已过 → needs_reauth（不发请求）
  → 未过期且距上次校验 ≥6 小时 → 调 summary
      ├─ 401/403 → needs_reauth
      └─ 其它错误 → 保留原状态，记录错误码

失效
  → 签到中心与账号页显示「登录失效」，重新用扩展或粘贴更新即可
```

## 新增平台

按 `docs/PLUGIN.md` 的契约写 `plugins/<id>/manifest.json` 与 `plugins/<id>/adapter.json`，再到 `src/providers/catalog.ts` 登记同一个 `id`。顺序不能反：**先有 adapter，平台才会出现在添加账号的列表里**，这样不会有人加到一个签不了的账号。

adapter 需要声明：主 Cookie 名、Cookie 域、summary 与 claim 的 method/path、成功判定字段、错误码映射（401 / 403 origin / 429 / 5xx / HTML 挑战）。契约测试写在 `test/`，`plugins/catalog.json` 只登记随镜像打包的内置插件。

## 防重复签到

`claim_days` 以 `(account_id, local_date)` 为主键，三层拦截：

1. 手动单个签到：先查账本，已存在直接 `409 ALREADY_CHECKED_IN`；
2. 批量签到：跳过已签、未登录、登录失效的账号，并返回跳过原因；
3. 定时任务：账本 + 当天定时运行记录双重跳过，进程重启也不会重复。

只有 `succeeded` 或平台明确返回「今天已领」的 `already_claimed` 才写账本；`unverified`、`failed`、`needs_reauth` 不写，允许修复后重试。

## 风险控制

默认策略是「低频、串行、可停止」，不追求绕过检测：

- **随机窗口**：基准时间后按 `账号 + 日期` 叠加随机偏移，默认散开 30 分钟，可调 0–240 分钟。
- **全局单并发**：手动、批量、定时共用一条执行队列，同一时刻只跑一个账号。
- **启动上限**：自动任务每小时最多启动 6 次；已有账号持锁时调度器不会再起一个。
- **平台熔断**：24 小时内 3 次验证挑战/限流，或样本 ≥5 且挑战率 ≥20%，暂停该平台 6 小时；到期进入半开，只放一次，成功才恢复。
- **会话健康分**：按过期、校验结果、连续失败、最近成功、24h 挑战算出 0–100；低于 60 不参与自动调度，低于 40 手动也拒绝。
- **一键暂停**：暂停后定时与手动签到都被拦截，登录、Cookie 更新、看记录不受影响。
- **策略确认**：`src/providers/policy.ts` 记录各平台条款状态；`prohibited` 直接拒绝，`unknown` 需先在风险条上确认一次。
- **金丝雀灰度**：平台可先进灰度，只让健康分最高的账号先跑，连续 2 天成功才放开其它账号；失败自动换人。灰度期间其它账号返回 `CANARY_HOLD`，不会静默跳过。
- **出口基线**：每小时探测一次出口 IP / 地区 / 运营商。同地区 IP 变动自动沿用；地区或运营商变化会暂停自动任务并记 `environment_drift`，确认后写入新基线再恢复。手动签到不受限。
- **风险事件**：挑战、限流、失效、熔断、暂停、漂移、灰度推进都写 `risk_events`，不含 Cookie 与响应正文。

阈值是保守的工程默认值，不保证与平台真实规则一致。

## 安全模型

- **单管理员**：`scrypt` 密码哈希、HttpOnly 会话 Cookie、CSRF 双提交、登录 5 次/5 分钟限流。
- **Cookie 来源**：扩展只读当前标签所属站点的 Cookie，不遍历其它站点；服务端保存前再校验主 Cookie（`breeze_blue_session`）是否存在，并用平台只读接口验一次真实有效性——无效的 Cookie 存不进来。
- **加密**：AES-256-GCM，AAD 绑定账号 ID，密钥 `/data/app.key`（0600）。数据库里没有明文 Cookie。
- **扩展令牌**：只存哈希，明文只在生成时显示一次，可单独吊销。
- **不回显**：账号接口只给字段名、长度、指纹、过期时间；日志里 `cookie` / `authorization` / `token` / `password` 一律替换为 `***`。
- **审计**：登录、Cookie 更新、签到、删除账号、改调度、备份、令牌生成/吊销都写 `audit_log`。
- **失败处理**：解密失败、平台 401、限流、5xx、超时都有独立错误码，失败不会被写成成功。

## 数据与备份

- SQLite：`/data/checkin.db`（WAL）
- 密钥：`/data/app.key`（0600）
- 备份：设置 → 立即备份，产物在 `/data/backups/`
- **`checkin.db` + `app.key` 必须一起备份**，否则 Cookie 无法解密，只能重新登录
- `/data` 必须是本地卷，不要放 SMB/NFS（SQLite WAL 会损坏）

## Docker / NAS

镜像基于 `node:22-bookworm-slim`，以非 root 的 `node` 用户运行，带 healthcheck（`/api/health/ready`）。`docker-compose.yml` 还以只读根文件系统运行，`/tmp` 用 tmpfs。

- 群晖：Container Manager → 项目 → 粘贴 compose；数据目录用 `/volume1/docker/checkin-agent/data`；UID 不是 1000 时加 `user: "<uid>:<gid>"`
- 威联通：Container Station → 应用程序；确认 `TZ=Asia/Shanghai`
- 反代并启用 HTTPS 后设置 `COOKIE_SECURE=1`；不要把 8787 直接暴露公网
- 内存 512MB 足够，容器里没有浏览器进程

首次启动如果出现 `SQLITE_CANTOPEN` / `permission denied`，在宿主机执行 `sudo chown -R 1000:1000 ./data`（容器内是 UID 1000 的 node 用户）。

### 用 GitHub Actions 构建（推荐，设备上不用装构建环境）

`.github/workflows/docker-image.yml` 在 push 时构建并推送到 GHCR：

```bash
docker pull ghcr.io/ysur007/checkin-agent-app:0.2.4
docker run -d --name checkin-agent --restart unless-stopped \
  -p 8787:8787 \
  -v /vol1/1000/docker/checkin-agent/data:/data \
  -e TZ=Asia/Shanghai \
  -e AUTOMATION_PAUSED=1 \
  -m 512m \
  ghcr.io/ysur007/checkin-agent-app:0.2.4
```

`AUTOMATION_PAUSED=1` 只在**首次初始化**时生效：装好即为暂停，之后以控制台开关为准，重启不会覆盖你的选择。适合「先部署观察、确认链路后再放开」。

`deploy/compose.yaml` 是设备本地构建版，`deploy/compose.pull.yaml` 是拉取 GHCR 镜像版。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录（容器内 `/data`） |
| `ADMIN_PASSWORD` | 空 | 首次初始化的管理员密码，至少 8 位；留空则首次打开时在控制台设置 |
| `APP_KEY` | 空 | 32 字节 base64 主密钥；留空则首次启动生成 `/data/app.key` |
| `TZ` | `Asia/Shanghai` | 决定「今天」的时区，签到账本按它划分日期 |
| `LOG_LEVEL` | `info` | pino 日志级别 |
| `COOKIE_SECURE` | `0` | 控制台走 HTTPS 时设为 `1` |
| `AUTOMATION_PAUSED` | `0` | 首次初始化即暂停自动化 |
| `EGRESS_PROBE` | `1` | 是否做出口 IP / 地区探测，`0` 关闭 |
| `EGRESS_PROBE_URL` | `https://ipinfo.io/json` | 出口探测地址，可换成自建 |

## 本地开发

```bash
npm install
npm run dev          # API :8787
npm run dev:web      # Vite :5173，代理 /api
npm run build        # tsc + 前端类型检查 + vite build
npm start
npm test
```

只读探测（不会领取）：

```bash
npm run probe -- --cookie-file ./cookie.txt
```

## 验证记录

- **56 项单元测试**：Cookie 拼装/去重/过期、作用域推导、URL 防护、签到账本唯一性、过期判断、风险熔断/半开/恢复、会话健康分、条款确认、金丝雀推进与轮换、出口漂移分类、调度暂停与启动上限、状态机成功/已领/401/claim 拒绝/余额不符/schema 缺失。
- **端到端（本地假平台，HTTPS）**：捕获 `demo_session` → summary 校验余额 500 → 加密入库 → 签到返回 `claimed=true, credits=100` → 复核 500→600、`verified=true` → 写账本 → 第二次签到 `409 ALREADY_CHECKED_IN`。
- **扩展链路**：无令牌 401 → 生成令牌 201 → 列表 200 → 回传 Cookie 200（verified）→ 吊销 204 → 再用 401。
- **风险控制**：注入 3 次验证挑战 → 平台熔断、手动签到 `409 CIRCUIT_OPEN` → 控制台恢复 → 再签到真实成功；暂停开关下批量签到 `409 AUTOMATION_PAUSED`。
- **金丝雀**：非金丝雀签到 `409 CANARY_HOLD` → 金丝雀连签 2 天成功后自动 `open`，事件记 `canary_promote`。
- **出口漂移**：探测源切到返回 SG / AS9999 的 mock → 判定 `major`、保留旧基线、批量签到 `409 ENVIRONMENT_DRIFT` → 确认环境后写入新基线并恢复。
- **泄漏检查**：库里 Cookie 为 `v1.…` 密文；日志中 `demo_session=` 出现 0 次；审计只记账号 ID 与指纹。
- 假平台与 demo adapter 只用于联调，位于 `test/fixtures/`，不会打进运行镜像的 `plugins/`。

## 限制

- 只适配了 BreezeBlue。列表里没有的平台就是没适配，不会用假数据凑成功。
- 不自动填写账号密码，不绕过验证码 / 2FA / 风控。
- 不提供多用户、通知渠道、积分消费、远程插件市场。
- 自动操作网页可能违反平台条款，账号风险自担；仅用于你本人有权操作的账号。

## 归因

BreezeBlue 请求形状参考 MIT 项目 [`mi-tuan/dsh-breeze-claim`](https://github.com/mi-tuan/dsh-breeze-claim)。详见 `NOTICE`。
