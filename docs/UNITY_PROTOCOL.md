# Unity / Game Client Protocol

Unity 只连接动作流：

```text
ws://127.0.0.1:8765/actions
```

连接后服务端发送：

```json
{"op":"hello","protocol":"tiktok-live-lab","version":1}
```

规则命中后发送：

```json
{
  "op": "action",
  "action": {
    "schemaVersion": 1,
    "actionId": "uuid",
    "sourceEventId": "uuid",
    "timestamp": 1730000000000,
    "actor": { "uniqueId": "john123", "nickname": "John" },
    "action": "SPECIAL_ATTACK",
    "power": 10
  }
}
```

游戏不读取 `giftId`、TikTok payload 或连接 TikTok。需要增加游戏行为时，修改 `config/game-rules.json`，让它输出稳定的动作名和参数。

## 语义猜词 Overlay 协议

浏览器 Overlay 连接：

```text
ws://127.0.0.1:8765/word-game
```

该通道直接消费标准化事件，不依赖 `/actions`。服务端只向客户端发送房间状态、倒计时、猜词结果、提示、动态和结算；隐藏答案保存在服务端，客户端只收到长度和 HMAC 答案码。当前主要消息包括 `ROOM_SNAPSHOT`、`TIMER_TICK`、`GUESS_ACCEPTED`、`GUESS_REJECTED`、`HINT_UNLOCKED`、`ROUND_ANSWERED`、`ROUND_SETTLED` 和 `ROOM_STATS`。

MVP 规则：英文单词或短语限制为 2–20 个字符，每位观众每 1.2 秒最多提交一次，同一观众本轮不能重复提交同一个词；时间轴按探索、线索、锁定、冲刺四个阶段推进，25%/50%/75% 未命中时自动解锁词汇类型、首字母和长度提示。点赞累计 1000 解锁提示，礼物解锁提示或增加 30 秒，猜中奖励 150 分，前两名相似猜测奖励 100/50 分，最佳助攻奖励 50 分。

Overlay 显示实时猜词的观众头像、用户名、段位、实际猜词和 Embedding 关联度；排行榜最多显示 Top 20，第一、第二、第三名使用不同的视觉层级。命中结算会发送当前积分、当前排名和超越上一名所需积分，前端用弹窗和线性浮窗展示。

## 内置压测游戏

浏览器打开 `http://127.0.0.1:3000/test-game-client/` 可直接运行内置的“直播守城·联动挑战”。当前动作映射如下：

| 互动 | GameAction | 游戏效果 |
|---|---|---|
| 聊天 `attack` | `CHAT_ATTACK` | Boss 受伤 |
| 聊天 `heal` | `CHAT_HEAL` | 基地回血 |
| 聊天 `shield` | `CHAT_SHIELD` | 增加护盾 |
| 礼物 | `GIFT_ULTIMATE` | 冷却可用时触发礼物大招，否则造成普通礼物冲击 |
| 点赞 | `LIKE_PULSE` | 增加联动能量 |
| 进场 | `JOIN_REINFORCEMENT` | 增加援军 |
| 关注 | `FOLLOW_SHIELD` | 增加护盾 |
| 分享 | `SHARE_BOOST` | 增加能量和得分 |
| 房间统计 | `ROOM_STATUS` | 同步观众数和总点赞 |
