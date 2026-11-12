# 手机协议 v1

所有普通响应为 `{ protocolVersion: 1, hostId, data }`。每台主机使用自己的 CA 和设备 Bearer token，认证请求还须携带 `X-AMC-Host`。token 不进入 URL。错误使用非 2xx 状态和 `data.error = { code, message }`。

| 方法与路径 | 内容 |
|---|---|
| GET /v1/hello | 无凭据的公开主机信息，不含项目与会话 |
| POST /v1/pair | hostId、一次性 ticket、deviceName，兑换设备 token |
| GET /v1/bootstrap | 主机项目、会话索引、运行时探测、授权设备 |
| POST /v1/workspaces | 在主机预授权根目录内登记现有项目 |
| POST /v1/sessions | 持久 clientRequestId、workspaceId、engineId、可选精确模型 |
| POST /v1/commands | 完整 SessionRef、sessionId、clientRequestId、action 与 payload |
| GET /v1/commands/:id | 查询本设备原始请求回执 |
| GET /v1/sessions/:id/snapshot | 100 条消息和 100 个工具对象的最新投影与水位 |
| GET /v1/sessions/:id/messages?before=N | 更早的完整消息，按 startSeq 分页 |
| GET /v1/sessions/:id/events?after=N | 会话事件按序读取 |
| GET /v1/sessions/:id/history?before=N | 旧事件分页，不隐式重新执行 |
| POST /v1/sessions/:id/reconcile | 显式核对原生状态，不重发上次输入 |
| POST /v1/workspaces/:id/attachments | name、mime、Base64 data，最多 16 MiB 原始数据 |
| GET /v1/workspaces/:id/files?path=... | 授权项目内相对路径列表 |
| GET /v1/workspaces/:id/read?path=... | 最多 1 MiB 文本 |
| GET /v1/workspaces/:id/download?path=... | 最多 16 MiB 文件的 Base64 和 SHA-256 |
| GET /v1/workspaces/:id/diff | 当前 Git 工作树差异，可能含用户手动修改 |
| DELETE /v1/devices/:id | 撤销设备并结束该设备全部事件连接 |

## 命令

`submit` 的 payload 是 `{text, attachmentIds}`；`cancel` 是空对象；`configure` 是 `{model: {providerId, modelId, label}}`；`decide` 带 `{interactionId, epoch, choiceId}` 或 `{interactionId, epoch, answers}`。

SessionRef 包括主机、项目、持久逻辑实例、平台、原生会话 ID。已有会话不能修改所属平台。相同设备与请求 ID 的相同载荷返回原回执，目标或内容改变则 409。已接收记录在原生接收结果未知时不自动重新派发。

回执 `received` 表示网关保存，`native_accepted` 表示原生确认；运行是否完成由会话状态决定。取消回执不释放目录运行权。审批决定原子占有，旧 epoch 被拒绝；原生未提供的决定或取消选项不对外提供。

## 事件

WSS `/v1/events` 使用相同认证头。客户端发：

```json
{ "type": "subscribe", "hostId": "paired-host-id", "sessionIds": ["registered-session-id"] }
```

服务端按顺序发送 `snapshot`、`ready`，之后发送 `event`；另以 `receipt` 回传设备请求结果。每个消息都包在同一个主机响应外层中。快照读取与订阅注册之间没有异步等待；事件从快照水位之后开始。客户端发现序号缺口时重新请求快照，不把重复 delta 再拼接一次。

事件种类：message.delta / message.completed、tool.updated、agent.updated、run.updated、interaction.created / closed、model.confirmed、error。最终消息与增量使用同一 ID，最终文本替换增量。待决交互、确认模型和 epoch 属于快照内容。interaction.created 按交互 ID 插入或更新状态，决定被占有时变为 responding。

目前保留全部网关事件，不实施静默日志裁剪。手机默认只取窗口，旧消息和事件可分页读取。将来引入保留策略前须增加明确的游标过期协议。
