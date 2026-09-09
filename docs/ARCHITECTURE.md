# Architecture

```text
TikTokSourceAdapter ─┐
ReplaySource ────────┼─> Normalizer ─> Normalized EventBus ─> Dashboard / Recorder
SimulatorSource ────┘                                  ├─> ActionMapper ─> /actions
                                                       └─> SemanticGameService ─> /word-game
```

所有输入源实现 `LiveEventSource`。事件进入总线前会拥有独立 session 的 `sequence`，因此游戏完全不需要区分 TikTok、回放和模拟器。

HTTP API 在 `3000`，WebSocket Gateway 在 `127.0.0.1:8765`。事件客户端连接 `/events`，动作客户端连接 `/actions`，语义猜词 Overlay 连接 `/word-game`；事件和动作通道也接受带 `/ws` 前缀的路径。

录制使用 append-only JSONL，写入过程中不读取整个文件。UI 最多保留 1000 条事件；服务端广播会断开明显积压的 WebSocket 客户端，避免阻塞采集。
