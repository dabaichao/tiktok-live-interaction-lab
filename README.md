# TikTok LIVE Interaction Lab v0.1

本项目是一个 local-first 的 TikTok LIVE 互动数据实验平台。TikTok、JSONL Replay 和 Simulator 都会进入同一个标准化事件总线；Boss 原型订阅 `/actions`，语义猜词 Overlay 订阅 `/word-game`，两者都不直接依赖 TikTok API。

## 快速开始

需要 Node.js 20+：

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:3000>。WebSocket 默认只绑定本机：

- `ws://127.0.0.1:8765/events`（同时兼容 `/ws/events`）
- `ws://127.0.0.1:8765/actions`（同时兼容 `/ws/actions`）

首页现在是统一的中文运营管理后台，左侧导航包含直播总览、实时事件、录制与回放、语义游戏和系统配置。TikTok 连接、自动重连、扩展礼物降级、事件审计、Embedding、模型路由、词库和礼物倍率均可在后台查看或保存；密钥只显示是否已配置，不会通过 API 返回。后台配置写入 `DATA_DIR/admin-config.json`，该文件已加入 `.gitignore`。

后台配置接口：

```text
GET   /api/admin/config
PATCH /api/admin/config
GET   /api/events/recent?limit=1000
POST  /api/events/clear
GET   /api/dictionaries
POST  /api/dictionaries/import
POST  /api/dictionaries/supplements
```

语言、模型路由、调试原始事件和计时广播间隔等配置保存后会明确返回“已生效 / 需重新连接 / 需要重启”，不会让运营误以为配置已经作用于当前连接。事件缓存由服务端维护，后台重连后会恢复最近事件；“清空当前事件”会同时清空服务端缓存，而不是只清浏览器列表。

打开 <http://127.0.0.1:3000/test-word-game/> 可运行中文“海外直播语义猜词”Overlay。观众发送中文词语后，服务端校验输入、计算语义关联度并返回排名；点赞可解锁提示并随机提交 1 个本地候选词，礼物按礼物价值 × 10 提交候选词。礼物候选词通过 OpenAI 兼容模型路由生成：可以固定任意模型，也可以按“首选模型 → 兜底模型列表”顺序尝试，默认首选 `hy3`，但不限制只能使用 hy3。模型失败时会重试并报告，不再静默混入本地词库。关注/分享会显示直播动态，答案只保留在服务端，客户端只收到 HMAC 答案码。每轮结束后按猜中、相似度和最佳助攻结算积分。

### 多语言概念词典

当前本地词典快照位于 `data/dictionaries/multilingual_core_v1.json`，包含英文、越南语和简体中文的稳定 `conceptId`、分类、已审核别名和有意保留的多义词冲突。默认游戏仍然是开放输入：未知词不会被丢弃，但通过以下接口可以明确区分 `resolved`、`ambiguous` 和 `unknown`。

```text
GET /api/dictionary/status
GET /api/dictionary/resolve?text=游艇
GET /api/dictionary/resolve?text=du%20thuy%E1%BB%81n&language=vi
```

通过 `SEMANTIC_LANGUAGE=en|vi|zh-Hans` 切换游戏语言；默认使用 `zh-Hans`。房间快照会返回当前 `wordlistId` 和词典统计。中文阶段提示按轮次逐步给出方向、开头和长度，例如答案“苹果”会给出“水果的一种”。切换语言时，答案池和随机候选词从对应语言的已审核标签读取；概念相同的跨语言猜测会归并到同一个概念。

### 词库包格式与 AI 补充

后台支持上传两类 JSON 包：`wordlist`（词库）和 `question-bank`（题目库）。最简单的包就是一个 `DictionarySnapshot`：

```json
{
  "schemaVersion": 1,
  "wordlistId": "zh_core_v1",
  "release": "2026-09-09",
  "defaultLanguage": "zh-Hans",
  "languages": ["zh-Hans"],
  "concepts": [
    {
      "conceptId": "nature.apple",
      "senseKey": "fruit_apple",
      "category": "nature",
      "definitions": { "zh-Hans": "水果的一种" },
      "labels": { "zh-Hans": "苹果" },
      "isAnswerable": true,
      "isGuessable": true,
      "status": "approved",
      "aliases": []
    }
  ]
}
```

也可以使用 `{ "packageType": "wordlist", "snapshot": { ... } }` 包装格式。后台会显示词库数量、题目库数量、概念数、语言和当前激活版本。上传包会先独立保存并校验，选择为当前词库后通过配置返回“需要重启”，不会在直播进行中热切换答案池。AI 产出的词通过“去重补充”进入 `DATA_DIR/dictionary-library/supplements.jsonl` 待审核库：已存在正式词库或补充库的词不会重复写入。

词典缺失项只允许离线补齐。配置运行时的 `HINT_LLM_API_KEY` 后，可以按不超过 100 个概念一批调用首选模型和兜底模型生成 `pending` 提案，输出到本地审核文件，不会自动写入已发布词典：

```bash
npm run dictionary:gap-fill -- --language=vi
```

模型候选必须人工审核后再合并并发布新词典版本；直播实时链路不等待词典补齐请求，也不把模型输出直接当作正式同义词。

Embedding 默认连接本机 OpenAI 兼容服务：`EMBEDDING_BASE_URL=http://127.0.0.1:1234/v1`、`EMBEDDING_MODEL=text-embedding-qwen3-embedding-0.6b`。也可以通过环境变量替换地址、模型和可选的 `EMBEDDING_API_KEY`；请求失败时自动回退到本地规则。

礼物候选词模型可通过 `HINT_LLM_BASE_URL`、`HINT_LLM_MODEL`、`HINT_LLM_FALLBACK_MODELS`、`HINT_LLM_FIXED_MODEL`、`HINT_LLM_API_KEY` 和 `HINT_LLM_TIMEOUT_MS` 配置；默认首选模型为 `hy3`，默认兜底为 `minimax-m3,deepseek-v4-flash`，默认地址为 `https://www.ai68.asia/v1`。模型必须返回 `{\"schemaVersion\":1,\"items\":[{\"word\":\"...\"}]}`，服务端会再次过滤、去重并排除隐藏答案，密钥只应通过运行时环境变量注入。

压测时可通过 `SEMANTIC_ANSWER=yacht` 固定本轮隐藏答案；服务端只返回答案长度和 HMAC 答案码，不会把答案发送给 Overlay。

多轮压测可临时设置 `SEMANTIC_SETTLEMENT_MS=100`、`SEMANTIC_TICK_INTERVAL_MS=50` 加速局间切换；不设置时仍使用正式的 5 秒结算和 1 秒倒计时广播。

旧的 <http://127.0.0.1:3000/test-game-client/> Boss 原型仍保留，继续订阅 `/actions`，用于兼容旧版动作映射回归测试。

打开 <http://127.0.0.1:3000/test-split/> 可同时查看 TikTok 控制台和联动游戏，适合真实连接压测。

在 Dashboard 的“TikTok 连接”区域输入直播中的 TikTok 用户名（例如 `qwestrlll`），点击连接即可读取公开直播事件。连接器会先尝试加载扩展礼物信息；如果签名服务对该附加请求返回 Business plan 限制，会自动降级到基础礼物字段，但直播 WebSocket、聊天、点赞、进场、关注、分享和礼物事件仍会继续接收。若主播没有开播，状态会显示为离线或错误，不会无限停留在“连接中”。

没有 TikTok LIVE 时，直接使用 Dashboard 的 Simulator；Replay 读取 `data/sessions/*/events.jsonl`。默认不会保存原始二进制事件，`STORE_RAW_EVENTS=true` 仅在明确需要时启用。

## 目录

- `src/core`：事件协议、标准化、总线和会话
- `src/sources`：TikTok / Replay / Simulator 适配器
- `src/recording`：流式 JSONL 录制与读取
- `src/actions`：规则驱动的 GameAction 映射
- `src/game`：服务端权威的语义猜词房间、相似度和结算
- `src/dictionary`：多语言概念、别名解析、词典统计和离线模型补齐客户端
- `data/dictionaries`：版本化本地词典快照
- `src/websocket`：事件和动作 WebSocket 网关
- `web`：Vite + Vanilla TypeScript Dashboard
- `tools/test-word-game`：可直接打开的中文 9:16 语义猜词 Overlay
- `tools/test-game-client`：旧版 Boss 动作订阅测试页面
- `docs`：架构、事件和 Unity 协议说明

## 约束

第一阶段不会自动登录 TikTok、抓取 Cookie、处理 CAPTCHA，也不保存密码、Cookie、OAuth 或 session token。请优先连接自己或已获许可的公开直播。
