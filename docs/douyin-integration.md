# 抖音直播数据独立接入

本项目的抖音服务与 TikTok 服务相互独立：TikTok 继续使用原来的 `src/server.ts`、HTTP 端口和连接方式；抖音使用 `src/douyin-server.ts`，只复用标准化事件模型、语义猜词游戏和词典。抖音后台同时提供 Webcast 快速连接和官方小玩法两种通道。

## 启动

使用 Node.js 22.12 或更新版本（推荐 Node.js 24）。首次使用扫码登录助手：

```powershell
npm install
npm run setup:douyin-login
```

第二条命令安装 Electron 官方运行时；本机需要能访问 Electron 下载地址。如果下载环境需要 HTTP(S) 代理，Node.js 24 可在当前终端设置 `$env:NODE_USE_ENV_PROXY='1'` 后重新执行（已有 HTTP_PROXY / HTTPS_PROXY 时生效）。不关闭 TLS 校验。组件未安装不会影响服务启动，后台会提示修复方式。

```powershell
npm run dev:douyin
```

- 抖音后台：`http://127.0.0.1:3002/douyin-admin/`
- 游戏画面：`http://127.0.0.1:3002/test-word-game/`
- 分屏：`http://127.0.0.1:3002/douyin-split/`
- WebSocket：`ws://127.0.0.1:8767/word-game`

可使用 `DOUYIN_PORT` 和 `DOUYIN_WS_PORT` 修改端口。

## 真实接入前置条件

### Webcast 快速连接（默认）

1. 输入 `https://live.douyin.com/{web_rid}` 或直接输入 `web_rid`。
2. 保持抖音后台页面打开；该页面完成签名、protobuf/gzip 解码，并把结构化事件送入本地服务。
3. 可尝试匿名接收聊天、点赞；网页 Webcast 礼物接收需要有效登录态（社区库的要求，并非官方稳定性承诺）。使用下方独立扫码登录助手自动同步。程序只检查是否包含登录字段，不把“字段已提供”冒充“登录验证成功”，更不会把暂时没有礼物认定为 Cookie 失效。
4. 此通道依赖抖音网页内部协议，不属于官方开放接口；抖音修改签名或 protobuf 后可能需要升级适配器。

快速通道使用 `@dycast/core`（MIT）处理 Webcast 协议，本地 `/dylive` 和 `/socket` 只承担 HTTP/WebSocket 转发。解析后的 `WebcastChatMessage`、`WebcastLikeMessage`、`WebcastGiftMessage` 等会转换为现有 `NormalizedLiveEvent`。

抖音服务启动时用项目内的 Vite 将 `@dycast/core` 和 `pako` 打包为一个浏览器 ESM 文件，再提供 `/vendor/dycast/index.mjs`。不要直接通过静态路由暴露 npm 原始入口，否则浏览器会报无法解析 `pako`。开发与编译后启动均使用该流程，需安装项目依赖（包含开发依赖）。连接组件加载失败时不会初始化新会话或重置游戏；刷新后台后可重试。回归测试 `tests/douyin-browser-bundle.test.ts` 覆盖模块执行及 gzip/protobuf 解码，不代表已连通真实直播间。

### 自动获取登录态（默认）

1. 在本机打开抖音后台。服务启动先恢复本机加密登录缓存；尚无可恢复登录态时，后台自动打开一次独立的抖音官方网页窗口，也可点击“扫码登录并连接”。
2. 在官方窗口点击登录，使用自己的抖音 App 扫码并确认。验证码、短信或其他风控交互由用户本人完成。
3. 登录助手从**自己的隔离会话**获取适用于直播站点的 Cookie，经私有子进程 IPC 同步到本机服务并以 Windows DPAPI 加密保存，然后清理临时会话并关闭窗口。不读取 Chrome / Edge 资料，不需要 F12，不将 Cookie 返回后台网页。
4. 发起登录的后台页面若已填好直播间，会自动连接并开局；未填链接时提示输入。其他页面只同步状态，避免重复开局。刷新发起页面或换页面后，可手动点击“连接直播”。直播期间仍需保持后台页面打开。
5. 取消、关闭窗口或 5 分钟超时后，不会反复弹出；点击登录按钮可重试。“停止抖音数据”、清除登录态、切换并启动官方通道会取消正在进行的登录，过期回传不会生效。

这是本机**网页登录助手**，不是抖音官方 OAuth 授权。浏览器使用非持久化 session partition、禁用 Node 集成、开启 sandbox/contextIsolation，禁止下载、权限请求与任意外站主页面跳转。服务把 Cookie 加密保存在独立的 `data/douyin/login.dpapi.json`，不会写入运营配置、日志或浏览器 localStorage。2026-09-18起支持服务重启自动恢复；首次保存、平台到期或缓存不可解密时仍需扫码。Electron 自身可能产生运行时缓存/元数据，但登录会话使用内存分区并在退出时清理。

“登录态已获取”只说明提取到登录字段；不承诺账号会收到礼物。礼物链路仍以真实 `WebcastGiftMessage` 接收结果为准。后台 API 仅返回阶段、时间、尝试 ID 和中文提示。登录启动、取消及凭证操作均限制同源回环访问；子进程用独立 IPC 回传，不开放 Cookie 回调端口。

相关代码：`src/douyin/DouyinLoginService.ts`、`tools/douyin-login/`；测试：`tests/douyin-login.test.ts`、`tests/douyin-admin-login.test.ts`。参考 [Electron Session](https://www.electronjs.org/docs/latest/api/session)、[Cookies](https://www.electronjs.org/docs/latest/api/cookies)、[安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。

### 手动获取并提供 Cookie（高级备用）

1. 在 Chrome / Edge 打开 `https://live.douyin.com/`，登录自己的账号后进入直播间。
2. 按 F12 → Network（网络），刷新直播间，再选择发往 `live.douyin.com` 的请求。
3. 在 Headers（标头）→ Request Headers（请求标头）复制 `Cookie` 字段的值，不是响应的 `Set-Cookie`，也不需要整份 HAR 或 cURL。
4. 展开本机后台“高级备用：手动提供 Cookie”，在密码框中粘贴，点击“连接直播 / 重新连接”。通常需包含 `sessionid` / `sessionid_ss` / `sid_tt` 登录字段之一。

Cookie 等同登录凭证，不要发到聊天、截图、写入仓库。输入成功后密码框清空；后台在内存使用、以当前 Windows 账号加密保存。重新连接时留空会沿用登录态；停止数据、换房和重启不会主动退出。“退出账号并断开”清除内存和加密缓存，删除失败会明确报错。

HTTP 与 WebSocket 只将凭证发往固定抖音域名；忽略浏览器携带的 localhost Cookie；上游 `Set-Cookie` 更新内存及加密缓存，不写入浏览器。状态接口不返回 Cookie 原文或密文；本地凭证操作限制为回环地址及同源请求，防止其它网站调用本地凭证代理。已知到期与HTTP 401会提示重登，不能用“没有收到礼物”或一般网络错误推断登录失效。详情见 `douyin-operations.md` 的“记住登录”。

### 点赞、礼物与原始消息诊断

- 浏览器适配器 `tools/douyin-admin/webcast-client.js` 同时解码 `WebcastLikeMessage` / `WebcastChatLikeMessage`，使用消息中的数值点赞数，不从房间总点赞差值伪造用户操作。
- “已连接”须收到并成功送入后端的互动，不仅是本地 WebSocket 打开。礼物通道独立显示是否观测到礼物，不暗示登录永远有效。
- 后台按消息类型显示：原始收到 → 解码成功 → 后端接收，以及解析失败和未支持数量。只保存内存中的类型/计数，不保存帧内容、聊天、Cookie 或签名。
- 每次人工重新连接重置该连接的诊断；已投递数据使用会话令牌隔离。浏览器按最多 500 条分批发送，不再静默截断超大批次。日志与测试不向真实房间注入假点赞/假礼物。
- 原始数量为 0：尚未观测到该消息，需结合登录态和直播间实际活动判断。原始 > 0、解码为 0：查看解码失败/未支持。解码 > 0、接收为 0：检查桥接请求及会话是否失效。

参考：[Dycast 礼物登录要求](https://github.com/skmcj/dycast)、[ChatLikeMessage 协议定义](https://github.com/adseng/dy-comment-cast/blob/master/proto/douyin.proto)、[Chrome 网络请求标头操作](https://developer.chrome.com/docs/devtools/network/reference#headers)。

### 官方小玩法（稳定备用）

1. 在抖音开放平台创建并发布直播小玩法/直播互动插件。
2. 申请评论、点赞和指定礼物等直播间数据能力，并取得 `live_data_push` 权限。
3. 玩法必须正在目标直播间挂载；仅凭主播用户名或直播链接不能启动官方推送任务。
4. 准备直播间 `roomId`、小玩法 `AppID`、有效 `access token` 和推送签名密钥。
5. 将 `https://你的公网域名/api/douyin/events` 配置为数据推送回调。`127.0.0.1` 无法被抖音服务器访问，开发测试需部署服务器或使用可靠的 HTTPS 隧道。

可以通过后台临时输入凭证，也可通过环境变量提供：

```text
DOUYIN_ROOM_ID=
DOUYIN_APP_ID=
DOUYIN_ACCESS_TOKEN=
DOUYIN_PUSH_SECRET=
DOUYIN_GIFT_CATALOG_JSON={"加密礼物ID":{"name":"小心心"}}
```

后台不会把 Access Token 和推送密钥写入浏览器存储或项目配置文件。

## 一键启动行为

点击“启动官方数据与游戏”后，服务会依次为 `live_comment`、`live_like`、`live_gift` 启动独立任务。三项都成功后才显示已连接。切换房间开启新游戏并清空上一房间积分；同房重连保留当前游戏。任何一项失败都会停止本次已经启动的任务，防止出现半连接状态。

停止时会分别停止三类官方推送任务，不影响 TikTok 服务。抖音在玩法取消挂载或主播关播后也会自动停止任务。

新增的礼物目录、互动规则、游戏设置和执行记录见 [抖音游戏运营后台](douyin-operations.md)。

## 回调安全和数据规则

- 使用抖音规定的 MD5 + Base64 算法校验 `x-signature`，不接受伪造回调。
- 按 `msg_id` 去重，缓存最近 20,000 个消息 ID。
- `test: true` 的官方测试礼物不进入游戏和排行榜。
- 抖音礼物回调只提供加密礼物 ID、数量和总价值（分）。礼物名称通过 `DOUYIN_GIFT_CATALOG_JSON` 或后台 JSON 映射补充。
- 回调先完成校验和入队，再异步计算语义，避免耗时模型调用阻塞官方回调。

## 官方资料

- 数据开放说明：https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/server/live-room-scope/data-open/data-open-desc
- 启动任务：https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/server/live-room-scope/data-open/start-task
- 停止任务：https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/server/live-room-scope/data-open/stop-task
- 查询任务状态：https://developer.open-douyin.com/docs/resource/zh-CN/interaction/develop/server/live-room-scope/data-open/query-task-status
