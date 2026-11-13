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

## Authorized Directory Creation And External Sources

These additive v1 endpoints require the existing host identity header and device authentication. An old gateway returns 404; the phone does not substitute unrestricted paths or change pairing.

| Method And Path | Request / Result |
|---|---|
| GET /v1/workspace-roots | `items: [{rootId,name,canCreate,reason}]`; no remote disk browser |
| POST /v1/workspaces/create | `{clientRequestId,rootId,directoryName,name}`; returns the registered Workspace |
| GET /v1/workspace-operations/:requestId | This device's durable directory operation stage, detail and optional workspace ID |
| GET /v1/external-capabilities | Four independent profiles, including per-action supported/unsupported/unverified and reasons |
| GET /v1/external-sessions?workspaceId=...&engineId=...&cursor=... | At most 50 native candidates per implemented provider page, filtered to the registered canonical cwd |
| GET /v1/external-sessions/:candidateId/history?cursor=... | Validated, bounded read-only message content; opaque candidate ID only |
| POST /v1/external-sessions/:candidateId/import | `{clientRequestId}`; idempotent read-only projection, initially without history |
| POST /v1/sessions/:id/observation | `{cursor?}`; one explicit passive history refresh/page, returns `{snapshot,cursor?}` |
| POST /v1/sessions/:id/handoffs | Currently rejects with `handoff_unverified`; no verified original-writer/exclusive-control evidence |
| POST /v1/sessions/:id/control-leases | Currently rejects with `handoff_unverified`; no leases are issued |

Directory operations are keyed by device and request ID, with a parameter hash and persisted `prepared`, `created`, `done`, `failed` or `needs_review` stage. A crash before ownership proof is durable cannot automatically adopt or delete a directory. A proven `created` operation can finish registration if parent and target identity still match. A `done` retry returns the same workspace. Existing directories and overlapping workspaces are never adopted. The portable name policy is stricter than POSIX and rejects Windows device aliases, separators, ADS and trailing dot/space. The JSON schema is `packages/protocol/schema/workspace-create.schema.json`; additional properties are rejected.

External identity binds host, engine, source namespace/instance, native ID and profile. Source identity is separate from the adapter's managed runtime identity. Imported source messages have durable source-key/content deduplication and independent gateway sequence numbers. History imports only text; no run termination, model confirmation, tool execution, pending approval or directory-lock release is replayed. Changed final text replaces the same projected message. DSH history is explicitly a journal view, not reconstruction of the current compacted model-visible surface.

`externalSource` marks imported sessions. Both command acceptance and dispatch reject all mutations, including calls through the old command endpoint. The reconcile endpoint also rejects imported sessions rather than invoking native resume. This release does **not** implement lease issuance, renew/revoke, controlEpoch dispatch, native handoff or original-process continuation. Those remain blocked, not simulated by a client checkbox or a successful resume. Existing managed sessions retain their previous authorization path. New managed sessions use POST /v1/sessions and are separate native conversations, not external continuation.

WSS now emits host-scoped `catalog.changed` after workspace registration/creation, managed session creation and external import. The phone coalesces bootstrap refreshes, preserves loaded messages, resubscribes, checks connection generation and cleans scheduled work on background/disposal. Manual observation adds no background polling or lease renewal.
