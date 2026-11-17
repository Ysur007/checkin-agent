# checkin-agent

本地优先的签到执行台：在服务端浏览器里登录账号，自动捕获并加密保存 Cookie，按平台执行真实签到请求，再把结果写进可追溯的账本。

当前适配情况：

- **BreezeBlue**：完整签到适配器。真实调用 `GET /api/credits/summary`、`POST /api/credits/daily-claim`，领取后再次读取 summary + 余额复核。
- **其它平台**：只接入「登录 / Cookie 采集 / 失效重登 / 定时调度」。没有 adapter 的平台会明确显示「待适配」，不会伪造签到成功。
- **自定义平台**：填写任意登录页地址即可采集该域 Cookie；需要签到时按 `plugins/` 规范补一个 JSON adapter。

## 它解决什么

| 能力 | 实现 |
|---|---|
| 账号登录 | 服务端 Chromium 打开登录页，控制台实时显示画面；可点击、输入、滚动，验证码/2FA 由你自己完成 |
| Cookie 自动获取 | 检测到登录成功后自动按平台域名范围提取 Cookie，`AES-256-GCM` 加密写库；接口只返回字段名、长度与指纹 |
| 登录态维护 | 记录 Cookie 过期时间；启动/每 30 分钟巡检，过期立即标记 `needs_reauth`；有适配器的账号每 6 小时调一次只读 summary |
| 重新获取 | 每个账号保留独立的浏览器配置目录，重登时多数平台可免密恢复；失效账号在签到中心和账号页都有「重新登录」 |
| 签到执行 | 手动单个 / 全部签到 / 定时签到，串行执行、失败重试有上限 |
| 防重复签到 | `claim_days(account_id, local_date)` 主键账本；执行前查账本，成功后写入，数据库层也不可能重复 |
| 结果记录 | 每次运行记录 HTTP 状态、耗时、字节数、requestId、领取前后余额与复核结果；签到记录按天聚合 |
| 风险控制 | 每日随机窗口、全局单并发、每小时启动上限、平台熔断、一键暂停、挑战率与事件面板 |
| 安全 | 单管理员 + CSRF + 登录限流；登录窗口绑定当前管理员会话；Cookie 加密、日志脱敏、审计日志 |

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：设置 ADMIN_PASSWORD（至少 8 位），或留空首次打开时设置
docker compose up -d --build
```

打开 `http://<NAS-IP>:8787`。首次进入设置管理密码，然后：

1. 签到中心 → 添加账号 → 选择平台（或「自定义」）；
2. 确认登录页地址 → 打开登录窗口；
3. 在窗口里完成登录；状态变成「已检测到登录」后会自动校验并加密保存（失败时会保留窗口，可手动点「提取 Cookie」）；
4. 回到签到中心，展开平台即可单独签到，或点「立即全部签到」。

> 登录窗口是服务端浏览器，不是本地浏览器。账号密码只输入到平台页面里，服务不读取、不保存密码。

## 支持的平台

| 平台 | 登录采集 | 签到 |
|---|---|---|
| BreezeBlue | ✅ | ✅ 真实接口 + 复核 |
| WorkBuddy / Qoder / Trae / Cline / Kiro / Cursor / 智谱清言 / CodeArts | ✅ | 待适配 |
| ZCode / KukuAI / MonkeyCode / Accio / CatPaw | ✅（需填写登录页） | 待适配 |
| 自定义平台 | ✅ | 需自备 adapter |

平台清单位于 `src/providers/catalog.ts`。`loginUrl: null` 的平台在添加账号时必须填写实际登录页；登录页地址在登录前还可以修改。

## 登录方式：浏览器标签登录 + 粘贴一次 Cookie

服务端不内置浏览器，登录只做两步：

1. 控制台 → 账号 →「登录 / 更新」→ 点「打开 BreezeBlue 登录页」，新标签会打开在你自己的浏览器里
2. 登录完成后按 `F12` → **Network** → 任意请求 → 复制 `cookie` 请求头；或右键请求 → **Copy as cURL** 整段复制，粘回弹窗保存

两种粘贴格式都能识别（纯 Cookie 头 / `Cookie: ...` / 整段 cURL），服务端自己挑出 cookie 那一行。

保存时服务端会先用这份 Cookie 调一次平台只读接口：通过才标记「已验证」，失败会返回具体原因（401、挑战、字段缺失）。Cookie 用 AES-256-GCM 加密入库，日志只留字段名与指纹。

这样做的原因很实际：浏览器不允许一个站点读取另一个站点的 Cookie（尤其是 HttpOnly 的 session），所以要么装桌面客户端或浏览器扩展，要么复制一次。我们把成本压在「复制一次」上，服务端因此完全不占浏览器内存——镜像从 976MB 降到 282MB。

### 浏览器扩展：装一次，之后全自动

不想手动复制就用扩展。`extension/` 里是一个 MV3 扩展，服务端也直接提供下载（`/checkin-agent-extension.zip`）。

1. 控制台 → 设置 → 浏览器扩展 → 下载并解压
2. `chrome://extensions`（Edge 是 `edge://extensions`）→ 打开开发者模式 → 加载已解压的扩展程序
3. 在同一张卡片里点「生成扩展令牌」，把令牌和控制台地址填进扩展弹窗
4. 去平台登录，登录完点扩展图标 →「读取当前站点 Cookie 并保存」

扩展用 `chrome.cookies` 读取**当前标签所属站点**的 Cookie（包括 HttpOnly），带上 Bearer 令牌 POST 到 `/api/ext/cookie`；服务端校验、加密、返回 verified。令牌只存哈希，可随时吊销，扩展本身不联网保存任何东西。

为什么这条路可行而纯网页不行：浏览器不允许 A 站点读取 B 站点的 Cookie，但扩展在获得 `cookies` + host 权限后可以——这也是 1Password、各类会话管理器的做法。

## 登录与 Cookie 生命周期

```
创建账号（status=unconfigured）
  → 启动独立浏览器配置 /data/profiles/<accountId>
  → 打开登录页，实时截图 + 转发点击/输入
  → 检测到平台 Cookie（有 primaryCookie 时要求它存在）
  → 提取该域及子域 Cookie → 调 summary 只读校验
      ├─ 401/403/挑战 → 不保存，继续留在登录窗口
      └─ 通过 → AES-256-GCM 加密写库，记录过期时间
  → 关闭浏览器

定时/巡检
  → cookie_expires_at 已过 → needs_reauth（不发请求）
  → 有 adapter 且 6 小时未校验 → 调 summary
      ├─ 401/403 → needs_reauth
      └─ 其它错误 → 保留原状态，记录错误码

重新登录
  → 复用 /data/profiles/<accountId>
  → 平台仍记得登录 → 直接 ready，提取新 Cookie
  → 平台要求重新认证 → 你在窗口里完成，再提取
```

## 防重复签到

`claim_days` 以 `(account_id, local_date)` 为主键。三层拦截：

1. 手动单个签到：先查账本，已存在直接返回 `409 ALREADY_CHECKED_IN`；
2. 批量签到：跳过已签、未登录、登录失效、待适配的账号，并返回跳过原因；
3. 定时任务：账本 + 当天定时运行记录双重跳过，进程重启也不会重复。

只有 `succeeded` 或平台明确返回「今天已领」的 `already_claimed` 才写入账本；`unverified`、`failed`、`needs_reauth` 不写，允许修复后重试。

## 风险控制

默认策略是“低频、串行、可停止”，不追求绕过检测：

- **随机窗口**：账号在基准时间后按 `账号 + 日期` 叠加随机偏移，默认散开 30 分钟；设置页可改 0–240 分钟。
- **全局单并发**：手动、批量、定时共用一条执行队列，同一时刻只跑一个账号。
- **启动上限**：自动任务每小时最多启动 6 次；任一账号持有运行锁时，调度器不会启动下一个。
- **平台熔断**：同一平台 24 小时内出现 3 次验证挑战/限流，或样本 ≥5 且挑战率 ≥20%，自动暂停该平台 6 小时；到期后进入半开，只允许一次执行，成功才恢复。
- **会话健康分**：按过期、校验结果、连续失败、最近成功、近 24h 挑战计算 0–100 分；低于 60 不参与自动调度，低于 40 手动也会拒绝。
- **一键暂停**：暂停后定时和手动签到都会被拦截，登录、Cookie 更新、记录查看不受影响。
- **策略表**：`src/providers/policy.ts` 标记平台的自动化条款与官方 API 状态；`prohibited` 直接拒绝，`unknown` 需要先在风险条上确认一次条款。
- **风险事件**：验证挑战、限流、登录失效、熔断、暂停、环境漂移、灰度推进都会写入 `risk_events`，不含 Cookie 或响应正文。
- **金丝雀灰度**：改 adapter、改调度或平台改版后，可让某个平台进入灰度：只允许一个健康分最高的账号先跑，连续 2 天成功才放开同平台其它账号；失败会自动换一个账号重新观察。灰度期间其它账号的签到会返回 `CANARY_HOLD`，不会静默跳过。
- **出口环境基线**：服务每小时探测一次出口 IP / 地区 / 运营商。同地区 IP 变动自动沿用；地区或运营商变化会暂停自动任务并记 `environment_drift`，在风险面板确认后写入新基线再恢复。手动签到不受此限制。
- **策略确认**：`unknown` 且有 adapter 的平台，执行前必须在风险面板确认一次条款，否则返回 `POLICY_UNACKNOWLEDGED`。

阈值是保守的工程默认值，不保证与平台真实规则一致；平台条款仍以各平台为准。

## 安全模型

- **单管理员**：`scrypt` 密码哈希、HttpOnly 会话 Cookie、CSRF 双提交、登录 5 次/5 分钟限流。
- **登录窗口归属**：每个 `login_session` 绑定创建它的管理员会话，其他会话既不能看画面也不能操作；最多同时 3 个窗口，12 分钟超时。
- **Cookie 作用域**：只提取登录页所在域及其子域，且必须匹配平台声明的 `cookieDomains`；不会把浏览器里其它站点 Cookie 一起带走。
- **加密**：AES-256-GCM，AAD 绑定账号 ID；密钥 `/data/app.key` 权限 0600。数据库里没有明文 Cookie。
- **不回显**：账号接口只返回字段名、长度、指纹、过期时间；运行事件与日志经过脱敏，`cookie` / `authorization` / `token` / `password` 一律替换为 `***`。
- **浏览器配置**：`/data/profiles/<accountId>` 内含平台登录态，权限 0700，敏感程度等同 `app.key`。
- **审计**：登录、重登、Cookie 捕获/更新、签到、删除、调度修改、备份都会写入 `audit_log`。
- **URL 防护**：登录页只允许 https；拒绝 `127.0.0.1`、`10.*`、`192.168.*`、`172.16-31.*` 等内网地址（`LOGIN_ALLOW_PRIVATE=1` 仅用于本地联调）。
- **失败处理**：浏览器启动失败、解密失败、平台 401、限流、5xx、超时都有独立错误码；不会把失败写成功。

## 数据与备份

- SQLite：`/data/checkin.db`（WAL）
- 密钥：`/data/app.key`（0600）
- 浏览器配置：`/data/profiles/`（0700）
- 备份：设置 → 立即备份，产物在 `/data/backups/`；也可以直接备份整个 `/data`
- **`checkin.db` + `app.key` + `profiles/` 必须一起备份**，否则 Cookie 无法解密，重登也需要重新输入密码
- `/data` 必须是本地卷，不要放 SMB/NFS（SQLite WAL 会损坏）

## Docker / NAS

镜像内置 Debian Chromium 与中文字体；`docker-compose.yml` 以只读根文件系统运行，`/tmp` 和 `/dev/shm` 使用 tmpfs。

- 群晖：Container Manager → 项目 → 粘贴 compose；数据目录用 `/volume1/docker/checkin-agent/data`；UID 不是 1000 时加 `user: "<uid>:<gid>"`
- 威联通：Container Station → 应用程序；确认 `TZ=Asia/Shanghai`
- 反代并启用 HTTPS 后设置 `COOKIE_SECURE=1`；不要把 8787 直接暴露公网
- 不需要浏览器登录时可设 `BROWSER_LOGIN=0`，此时只能手动录入 Cookie
- 多架构：`docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/checkin-agent:0.2.0 --push .`

首次启动如果出现 `SQLITE_CANTOPEN` / `permission denied`，在宿主机执行 `sudo chown -R 1000:1000 ./data`（容器内是 node 用户，UID 1000）。

### 用 GitHub Actions 构建的镜像（推荐，设备上不用装构建环境）

`.github/workflows/docker-image.yml` 会在 push 时构建并推送到 GHCR：

```bash
docker pull ghcr.io/ysur007/checkin-agent-app:0.2.0
docker run -d --name checkin-agent --restart unless-stopped \
  -p 8787:8787 \
  -v /vol1/1000/docker/checkin-agent/data:/data \
  -e TZ=Asia/Shanghai \
  -e BROWSER_LOGIN=1 \
  -e PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium \
  -e AUTOMATION_PAUSED=1 \
  -m 1280m \
  ghcr.io/ysur007/checkin-agent-app:0.2.0
```

`AUTOMATION_PAUSED=1` 只在**首次初始化**时生效：装好即为暂停状态，之后以控制台开关为准，重启不会覆盖你的选择。适合"先部署观察、确认链路后再放开"的场景。

`deploy/compose.yaml` 是设备本地构建版，`deploy/compose.pull.yaml` 是拉取 GHCR 镜像版，两者都带这个开关。

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

- **56 项单元测试**：Cookie 拼装/去重/过期、作用域、URL 防护、签到账本唯一性、过期判断、风险熔断/半开/恢复、会话健康分、条款确认、金丝雀灰度推进与轮换、出口漂移分类、调度暂停与启动上限、状态机成功/已领/401/claim 拒绝/余额不符/schema 缺失。
- **端到端（本地假平台，HTTPS）**：真实 Chromium 打开登录页 → 点击/输入 → 捕获 `demo_session` → summary 校验余额 500 → 加密入库 → 签到请求返回 `claimed=true, credits=100` → 复核余额 500→600、`verified=true` → 账本写入 → 第二次签到返回 `409 ALREADY_CHECKED_IN`。
- **重新获取**：把 Cookie 过期时间改为过去 → 界面显示「登录失效」→ 点「重新登录」复用浏览器配置 → 平台直接回到 `/app`，状态「已检测到登录」→ 提取新 Cookie 成功。
- **风险控制**：注入 3 次验证挑战 → 平台熔断、手动签到返回 `409 CIRCUIT_OPEN` → 控制台恢复 → 再签到真实成功（余额 500→600，`verified=true`）；暂停开关下批量签到返回 `409 AUTOMATION_PAUSED`。
- **金丝雀**：两个演示账号开启灰度 → 非金丝雀签到返回 `409 CANARY_HOLD` → 金丝雀真实签到成功（500→600）累计 1 天 → 第 2 天成功后自动 `open`，事件记 `canary_promote`。
- **出口漂移**：把探测源切到返回 SG / AS9999 的本地 mock → 服务判定 `major`、保留旧基线、批量签到返回 `409 ENVIRONMENT_DRIFT` → 控制台「确认环境」后写入新基线并恢复。
- **泄漏检查**：数据库中的 Cookie 为 `v1.…` 密文，`grep demo_session=` 在日志中出现 0 次；审计只记录账号 ID 与指纹。
- 假平台与 demo adapter 只用于联调，位于 `test/fixtures/`，不会打进运行镜像的 `plugins/`。

## 限制

- 只适配了 BreezeBlue 的签到接口；其它平台目前是登录采集，不会显示成已签。
- 不自动填写账号密码、不绕过验证码/2FA/风控；遇到挑战会在登录窗口里等你处理。
- 浏览器登录是 headless Chromium，个别平台的登录页可能拒绝无头环境；这种情况改用手动 Cookie。
- 不提供多用户、通知渠道、积分消费、远程插件市场。
- 自动操作网页可能违反平台条款，账号风险自担；仅用于你本人有权操作的账号。

## 归因

BreezeBlue 请求形状参考 MIT 项目 [`mi-tuan/dsh-breeze-claim`](https://github.com/mi-tuan/dsh-breeze-claim)。详见 `NOTICE`。
