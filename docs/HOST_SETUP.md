# 主机接入

v0.3.0 增加可选自动目录发现与外部会话只读同步，默认关闭。启用配置、状态接口和当前 Push 发送限制见 [自动同步与通知](automatic-sync-and-push.md)；已有目录自动化迁移见 [目录身份确认](workspace-identity-confirmation.md)。目录确认前必须先停止网关。

推荐使用新的 [电脑连接助手](DESKTOP_GUIDE.md)，通过界面完成独立配置、检测、启动和扫码配对。下文保留原有 CLI 与固定 EasyTier 中转部署方式。

## 每台主机的独立配置

| 主机 | App 网地址 | 公网入口 | 本机网关 |
|---|---|---|---|
| macOS | 10.89.90.3 | HTTPS/WSS :18541 | 10.89.90.3:8899 |
| Linux | 10.89.90.4 | HTTPS/WSS :18542 | 10.89.90.4:8899 |
| Windows | 10.89.90.2 | HTTPS/WSS :18543 | 10.89.90.2:8899 |

三次分别运行 setup，不复制 CA 私钥、数据库、hostId 或设备 token。公开域名必须包含在各自主机服务证书的 SAN 中。网关绑定实际存在的 App 虚拟 IP；不要将 8899 暴露到任意公共接口。

Windows 运行示例（PowerShell，路径按实际修改）：

```powershell
npm ci --ignore-scripts
npm run init:host -- --name Windows-Dev --address 10.89.90.2 --public relay.example.com --public-port 18543 --workspace-root "D:\Projects"
npm run gateway -- host.config.json
```

Linux 将地址改为 `.4`、公网端口改为 `18542`，授权目录例如 `/home/me/projects`。同一 OS 用户只允许一个网关进程，锁文件位于用户私有配置目录。目录锁协调的是控制台管理的任务，不构成原生代理的文件系统沙箱。

`runtimes` 可以使用默认能力检测策略。

```json
{
  "codex": {
    "command": "/absolute/path/to/codex",
    "compatibilityMode": "latest-compatible",
    "models": []
  }
}
```

旧配置中的版本记录可继续使用。只有管理员显式选择 `pinned` 时，网关才检查 `expectedVersion`。

## DSH 薄桥接

网关另在 `127.0.0.1:8898` 接收本机桥接，只接受 `dsh-bridge.secret` 对应的凭据。手机 token 不能登录桥接端口，桥接凭据不能登录手机接口。

在 DSH 宿主将完整 `plugins/dsh-bridge/` 包（入口 `cordis.mjs`）作为本地插件加载，配置：

```json
{
  "gatewayUrl": "ws://127.0.0.1:8898",
  "tokenFile": "/absolute/private/path/dsh-bridge.secret",
  "compatibilityMode": "latest-compatible"
}
```

插件通过 Cordis 服务注入等待 `sessionController`，在卸载或热重载时释放连接与监听。默认按宿主服务身份、方法能力及运行时数据契约接入，不再要求固定 rc.5 文件哈希。未知版本仍报告 `verified:false`；缺少可选服务只关闭对应能力。详情及接口见 [DSH 接入说明](DSH_INTEGRATION_2026-11-17.md)。

DSH 退出仅断开此适配器。网关本身不由 DSH 插件托管。

## 前后台和重启

手机后台关闭事件观察连接；前台重新认证并读取有水位的快照。用户消息不随前台恢复重新发送。HTTP 回执丢失时使用原请求 ID 查询。

网关重启会把活跃执行标记为“状态待核实”，保留目录运行权。原生恢复能确认完成或取消时才更新；原生接口无法证明旧执行已结束时，继续显示待核实。Claude 和 OpenCode 的恢复对话不能被当作旧进程或后台子任务已结束的证明。

## 证书续签

保留同一主机身份与 CA，在该 CA 下签发含正确 SAN 的服务证书。手机 HTTP 在不发送凭据的 TLS 探测中使用唯一主机 CA 校验链、日期和主机名，再对该已验证服务公钥做请求级 pinning；普通续签或更换叶证书密钥不要求换 CA。WSS 使用主机 CA 路径。真机仍需执行错误 CA、过期证书、错误 SAN 和错映射端口的拒绝测试。

更换 CA 或 hostId 需要用户显式重新配对。不要跳过证书验证，不把证书和凭据放进 Git。

## Directory And External Source Upgrade

Upgrade the Mac gateway, protocol package, adapters and the complete DSH bridge directory together with the Harmony app. Updating only the phone does not add host or native capabilities. Keep existing host identity, CA, device authorizations, SQLite database and workspaces. Before upgrading, the operator must back up the database and credentials in a protected location; do not attach those backups to a support report. The new state uses versioned object namespaces in the existing SQLite objects table, without destructive table conversion or removal of old task data.

Configure authorized workspace roots on the host, not from the phone. To create sibling projects, authorize their parent directory. If an existing registered workspace covers that parent, creation remains blocked by the existing overlap rule; do not weaken the rule to make the button work. Directory creation is a non-recursive mkdir with ownership/identity checks and durable recovery. It is not an OS sandbox or protection against an administrator concurrently replacing directories. Protect authorized roots against untrusted local writers. Failed/ambiguous operations leave directories in place for operator review; never recursively clean them up automatically.

| Tool | External Source Deployment |
|---|---|
| Codex | 已登记的 app-server 提供 `thread/list` 和 `thread/read`。网关校验线程 ID、授权目录，并按线程报告的历史模式读取完整轮次。 |
| Claude Code | 授权项目历史由官方 SDK 的 `listSessions` 和 `getSessionMessages` 提供。 |
| OpenCode | 从已登记服务读取项目会话和消息。DevEco Code 使用自身的原生会话接口。 |
| DSH | 桥接插件验证同宿主 controller、服务协议及各操作的能力，按原生会话 ID 读取历史。 |

DSH rc.5 has page/projections/follow, not the old plugin's guessed events/state methods. The history path only calls list, projections and page. It requires a sequenced projection waterline and bounds every backward page by asOfSeq; null, migration-required or unavailable projections fail explicitly. It never calls follow, which can promote a prepared source into an Agent, and registers no approval/question handlers. Discovery remains a bounded snapshot with single-use 60-second cursors. Large histories fail instead of truncating. Refresh is manual durable-journal synchronization, not live terminal attachment. Plugin restart changes source generation and requires rediscovery/import before new reads.

导入历史后，控制操作还需验证同一已登记实例、原会话与授权项目。无法确认归属时保留只读历史。

### Mac Runtime Confirmation

升级统一网关、协议包、适配器及完整 `plugins/dsh-bridge/` 目录，保留现有主机配置、SQLite、CA、配对信息及桥接密钥。旧 `dist/desktop`、`output/AMC-computerside` 打包副本不会随源码自动更新。

DSH 默认 `latest-compatible`，无需把 `expectedVersion` 改写成旧 rc.5 来通过检查。仅在确实需要固定包版本时，使用 `compatibilityMode: "pinned"` 和准确的 controller `expectedVersion`，并在网关和插件两侧一致配置。新 profile 是 `dsh-controller-capabilities-v2`；哈希只作为诊断，不作为默认接入门槛。支持能力不等于真实引擎/真机验证。

### Phone Model Selection

The 2026-11-13 phone probe received one workspace, four runtimes and zero registered models for every runtime. Codex reported `codex-cli 0.167.0-alpha.4.1`; DSH reported `0.2.1-rc.5`. Installation and an online transport do not supply a model catalog. Setup intentionally initializes `runtimes.<engine>.models` to an empty array. Character mappings are artwork metadata, not available model identities.

On the Mac, use the existing protected configuration locally to register only exact native-supported `providerId`, `modelId` and a display `label` under the Codex runtime's `models`. Obtain the identity from that installed runtime's own metadata/API and active provider; do not infer it from the model label, artwork, CLI version, this document, or another provider. Do not share the configuration, credentials or a full bootstrap response. Restart the gateway after configuration changes, then use the phone's model/workspace refresh action. No automatic model discovery or private configuration rewrite was performed by this fix.

DSH 现在从宿主 `modelCatalog`（或原生 LLM registry）获取模型，只有真实 `selectModel` 返回确认身份才更新会话模型。不需要在主机配置中猜测 DSH 模型 ID。现有手机页面根据服务端能力和目录显示模型，无需修改页面；slash 和 steer 的新增协议入口不新增 UI。

Home selection persists a new-session target, not a native-confirmed model. Chat selection applies only to an idle managed session and, for Codex, the confirmed thread provider. An external imported session has no control lease. Running/waiting/cancel-requested/uncertain sessions remain disabled. A configure receipt is not model confirmation: the updated gateway notifies the catalog after persisting the next-turn target; the phone resubscribes for a snapshot, and only native model confirmation changes the current model. Updating only the APK will not repair missing host registration or the old gateway's missing notification.
