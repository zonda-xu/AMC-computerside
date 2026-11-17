# DeepSeek Harness 接入补齐（2026-11-17）

本次修改目标为 `D:\hw\AI-Maid-Caf--main` 源码。保留四引擎网关、SQLite 数据模型、已有设备配对及运行身份校验；未修改鸿蒙 ArkTS、页面、样式或桌面 UI。没有替换运行中的原生宿主，也没有升级已有打包目录。

## 参考依据

- 用户 fork 的固定提交：[ds-scidesk-xyz 129026010e6d4834b9aa5185549c6a72b77a0c3c](https://github.com/zonda-xu/ds-scidesk-xyz/tree/129026010e6d4834b9aa5185549c6a72b77a0c3c)。参考其原生模型目录、附件 admission、独立 slash 执行、输入来源去重、工作区归属和 Cordis 生命周期；没有移植其 UI 或替换现有统一网关。
- 实际连接了本机配置的 `huawei_developerknowledge` MCP。当前会话未加载该 MCP 的原生工具，因此使用配置中的端点执行 MCP `initialize`、`tools/list`、`searchDocuments`、`getDocumentsById`。服务器要求协议 `2025-11-25`，初始化及文档查询成功。
- MCP 返回的官方资料：[应用网络重连](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/application-network-reconnection)、[WebSocket 连接](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-websocket)。其网络中断、切网、前后台重连约束用于保持现有“恢复连接后查询快照/原回执”的设计；不把重新连接当成重发有副作用命令的理由。
- 本地保存的官方 rc.5 controller 源码用于核对 `resolveAgent`、`prompt`、file receipt、`selectModel`、`follow/page` 数据结构。测试模拟这些契约，不冒充真实模型执行。

## 接入和兼容策略

完整复制 `plugins/dsh-bridge/`，通过包入口 `cordis.mjs` 加载。该入口使用 Cordis `inject(['sessionController'])` 等待服务，并通过 `effect` 释放连接和监听；`index.mjs` 仍是可独立测试的底层连接函数。

```json
{
  "gatewayUrl": "ws://127.0.0.1:8898",
  "tokenFile": "D:/absolute/private/dsh-bridge.secret",
  "compatibilityMode": "latest-compatible"
}
```

沿用实际部署中的密钥路径，不创建新主机身份、数据库或配对。插件 `ws` 依赖保持不变。

默认不再用固定版本、入口哈希、特定包构造器作为接入门槛。新 profile 为 `dsh-controller-capabilities-v2`。检查实际宿主提供的同一个 `sessionController`、必需方法、事件接口及只读 `list` 返回结构；模型、附件、slash、审批和问答按可选服务分别声明。列表支持数组及 items/sessions/rows 包装。之后仍验证快照水位、历史顺序、流帧、原生返回身份及接受结果，不能以版本放宽为由忽略契约变化。

若包可解析则报告其实际版本及哈希；打包宿主无法解析独立包时保留未知版本，不伪造版本。显式选择 `pinned` 仍要求可读的准确 controller `expectedVersion`，网关和插件均可执行该策略。只读外部会话发现也解除默认 rc.5 限制，保留旧 profile 的准确历史证据兼容。

`verified` 仍为 false：能力检测表示可以尝试对应原生操作，不表示该版本已完成真实引擎/设备验收。

## 已实现能力

1. 模型目录优先使用 controller，缺少目录接口时读取 LLM registry，保留各 provider 的失败信息。模型切换及新会话目标模型使用 `selectModel`；只有原生返回的 selected 身份才能更新已确认模型。缺少配置能力不向现有手机提供模型控制。
2. 图片通过原生 encoded image block 提交；普通文件通过当前 Session 的 `fileUploads.upload` 获得 receipt，再提交 controller。网关仍验证附件项目归属、真实文件及摘要，插件再次验证 Base64、大小及 SHA-256。不用文本拼接假装已交付附件。单文件上限 16 MiB，单次原生请求附件总量上限 32 MiB，最多 10 个附件。
3. 原生 slash 命令通过 `commands.list/execute`，不用模型 prompt 模拟；附件同样使用原生 receipt。网关保存命令意图、返回结果及不确定状态，跨网关重启不重复派发。
4. steer 调用真实原生能力，保持当前 run，不伪造下一轮；网关验证当前 running 状态、runId 和 generation。缺少真实 steer 方法时明确失败，不降级为 queue。
5. 输入原生 requestId 携带网关输入身份和载荷摘要。恢复时检查 inbox、user/message、agent/inbox/spliced，覆盖“已取出队列但尚未写为用户消息”的间隙；支持通过只读 inspect 恢复冷会话的已接受证据。载荷改变拒绝复用身份。
6. 同一插件存活时，slash 和取消回执丢失可通过 snapshot 恢复；若原生效果无法确认，则维持 uncertain 和持久目录占用，不自动重执行。插件重启后没有原生 slash 执行证据时，仍需原生核对，不能凭推测解锁。
7. 创建会话后通过原生 workspaceRegistry 关联桌面工作区；失败返回诊断，不通过改写 DSH 内部配置文件补救。会话列表使用原生标题。导入历史过滤明确的 runtime-context 等内部来源。
8. 保留既有显式附着校验、双端审批/问答单次结算、旧代拒绝、精确 turn 取消、分页快照恢复与消息去重。控制器负责原生 Agent/preset 创建和恢复，不另起独立 DSH 会话进程。

## 新增协议入口（不新增 UI）

现有模型选择、附件上传、submit/configure 路径继续使用。slash/steer 为能力驱动的协议扩展，不改页面：

- `GET /v2/sessions/{id}/native-commands`：只允许已绑定且具备 slash 能力的授权会话，返回原生命令描述。
- `POST /v2/commands`，`action: "slash"`，payload 为 `{ expectedGeneration, line: "/command arguments", attachmentIds: [] }`。
- `POST /v2/commands`，`action: "steer"`，payload 为 `{ expectedGeneration, runId, text, attachmentIds: [] }`。

都须携带现有完整 `protocolVersion:2`、hostId、sessionId、ref、clientRequestId，沿用现有认证。回执查询仍为 `GET /v2/commands/{clientRequestId}`。slash 的原生结果保存在回执 `result`；原生接受不等同于某个模型任务完成。目录写入互斥和未决操作约束覆盖新增命令。

## 验证与边界

最终 `npm test` 为 **439/439 通过，0 失败、0 跳过**，日志见 `output/dsh-integration-tests-20261117.log`；`npm run typecheck`、`npm run check:source` 通过。套接字测试在允许本机 TCP/TLS/WebSocket 的环境执行。新增测试覆盖能力缺失/未来版本/显式固定、附件、模型、steer、slash、原生插入日志重载去重、SQLite 重开后的命令幂等、未决目录锁、丢失回执恢复、授权根目录变化及 Cordis 生命周期。

上述 439 项为 DSH 接入阶段记录。当时尚未执行真实 DSH 模型请求；后续主 App 联调结果如下。没有把 fork 的真实设备记录当作本项目验证。

部署须同步升级网关、协议包、适配器、完整桥接插件；已有 `dist/` 与 `output/AMC-*` 副本未原地覆盖。先使用可丢弃工作区在实际宿主完成文本、附件、模型、审批/问答、停止、断线恢复和同会话继续，再标记该宿主验证完成。

## 本机桌面宿主联调补充

- 实际宿主为 `E:\dafeiyu\DeepSeek Harness.exe`，版本 `0.2.2-rc.3`。电脑端版本探测通过该安装自带的 Electron Node 模式及官方 CLI 入口，不把桌面 EXE 当普通 CLI 直接运行 `--version`。
- Cordis 4 的 `ctx.get` 会为同一服务产生新的 scoped proxy。能力检测通过 `Symbol.for('cordis.original')` 比较原始服务身份，同时保留 scoped proxy 执行调用；真实不同服务仍拒绝。默认兼容策略仍为 `latest-compatible`。
- 用户授权重启后，桥接插件在已有 desktop profile 中加载。实际目录读取、会话创建、原生文件任务、权限拒绝、取消、同原生会话继续以及主 App 实时完成与成果预览均已验证。原有配置与历史保留。
- 手机端消息投影修复共享 nativeKey 的 reasoning/assistant 冲突，最终回复不再被过程消息覆盖。当前全项目回归为 **460/460**，类型检查与主 App 构建通过。
- 尚未实测原生附件上传、slash/steer、所有审批问答分支、真机系统推送；这些能力保留契约回归覆盖，不能因本次文本和文件验收而统一标记全部已验证。详细证据见 `CAFE_MAIN_INTEGRATION_2026-11-17.md`。
