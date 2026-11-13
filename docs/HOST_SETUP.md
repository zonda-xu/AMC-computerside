# 主机接入

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

`runtimes` 示例（版本必须自行实测后替换）：

```json
{
  "codex": {
    "command": "/absolute/path/to/codex",
    "expectedVersion": "codex-cli 0.167.0-alpha.4",
    "models": []
  }
}
```

Codex 该版本来自本次源码环境的协议生成器，**没有因此被标为在你的三台主机上通过验收**。Claude Code / OpenCode 的版本由部署者固定，未知版本不会自动切换到其他协议或终端解析。

## DSH 薄桥接

网关另在 `127.0.0.1:8898` 接收本机桥接，只接受 `dsh-bridge.secret` 对应的凭据。手机 token 不能登录桥接端口，桥接凭据不能登录手机接口。

在 DSH 宿主将 `plugins/dsh-bridge/index.mjs` 作为本地插件加载，配置：

```json
{
  "gatewayUrl": "ws://127.0.0.1:8898",
  "tokenFile": "/absolute/private/path/dsh-bridge.secret",
  "hostVersion": "SET_EXACT_TESTED_DSH_VERSION"
}
```

插件使用宿主提供的 `sessionController`、`session/event`、`agent/assistant-stream`、`approval/request` 和 `user-questions/request`。接口参考固定在 DSH 提交 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`。用户问题的返回结构和原生版本需要真实宿主验收，不把模拟消息测试等同于兼容性确认。

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
| Codex | Exact `codex-cli 0.167.0-alpha.4.1` or previously verified `codex-cli 0.167.1`, matching expectedVersion. The alpha.4.1 npm provenance resolves to `d2c035639366e0bf2c316aa2065c24aabc12bcdc`; its own list/read/turns JSON schemas are bundled under tests/contracts/codex-generated/alpha4.1. Uses thread/list with useStateDbOnly, thread/read metadata and paginated full thread/turns/list, never resume/start for import. CODEX_HOME/command participate in source identity. The old alpha.4 approval schemas are not evidence of history compatibility. |
| Claude Code | External discovery/history is unverified and disabled. Supply the deployed version and a selected sanitized native record/contract before adding a parser. The gateway's own reservation file is not an external catalog. |
| OpenCode | External discovery/history is unverified and disabled. Supply the deployed version and its native list/history API or ACP discovery proof. ACP load alone is not enumeration or process control. |
| DSH | Same loaded plugin host only, official `@deepseek-ai/dsh-api-session-controller@0.2.1-rc.5`. Install index.mjs, mapping.mjs, external.mjs and profile.mjs together. Bridge v2 verifies the resolved controller entry SHA256 and that ctx.get('sessionController') is an instance of the class exported by that exact module. Configuration hostVersion/hostRevision no longer enables anything. CLI rc.5 alone is not API evidence. Managed creation/send/approval/control are disabled in both adapter and plugin. |

DSH rc.5 has page/projections/follow, not the old plugin's guessed events/state methods. The history path only calls list, projections and page. It requires a sequenced projection waterline and bounds every backward page by asOfSeq; null, migration-required or unavailable projections fail explicitly. It never calls follow, which can promote a prepared source into an Agent, and registers no approval/question handlers. Discovery remains a bounded snapshot with single-use 60-second cursors. Large histories fail instead of truncating. Refresh is manual durable-journal synchronization, not live terminal attachment. Plugin restart changes source generation and requires rediscovery/import before new reads.

External sending, approvals, answers, cancellation, configuration and continuation remain disabled for all four tools. No control lease is issued; rejecting lease endpoints is not a completed control implementation. Do not bypass this gate with quiet logs, a checked box or successful resume. Codex retains the separate gateway-managed new-session entry, which is not continuation or proof that an independent CLI has stopped writing. DSH's older managed path is disabled, including new creation, because its state API and approval competition were not verified for rc.5. Existing records are not removed or marked stopped by the upgrade.

### Mac Runtime Confirmation

Run the upgraded gateway on the Mac with Node 24.13+ below 25, keeping the existing protected host configuration and data. Pin Codex expectedVersion to the complete local output `codex-cli 0.167.0-alpha.4.1`; do not replace it with alpha.4 or 0.167.1 to get past a gate. Pin DSH expectedVersion to `0.2.1-rc.5`, the verified controller package version. Keep Claude/OpenCode enabled:false while uninstalled. Do not recreate host identity, CA, pairing or the database.

Load the complete bridge directory within the existing DSH rc.5 host profile, with ws 8 available and the official controller package resolvable from profile.mjs. Its only plugin settings are gatewayUrl (local ws://127.0.0.1:8898) and tokenFile (existing protected bridge secret path). Do not send that file, config or credentials to support. If plugin resolution finds a second/different controller copy, the instanceof/digest check intentionally fails; install it in the same dependency context as the loaded service, not beside an arbitrary global CLI. No automatic Mac file update or SSH is provided.

After reconnecting, inspect the authenticated GET /v1/external-capabilities response using an existing authorized client. Do not paste authorization headers/tokens. Codex must report profile `codex-app-server-0.167.0-alpha.4.1`; DSH must report `dsh-controller-0.2.1-rc.5-page-v2`, a nonempty namespace, discover/history supported, syncMode manual-refresh, and all control actions unverified. The DSH bridge probe reports externalProtocol 2, control false, and controllerDigest `a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386`. These confirm negotiated implementation support, not successful user-history or task E2E. No history is read by the probe. Only select a disposable authorized workspace/session when explicitly ready to test reads.

The controller digest was computed from the official npm tarball after checking SHA512 `9kcolv2E00fuMMXWDbMn4K2JRMdAf8Ql5wME1CaGxgManvLjPM2Ymc46o2TJnwH4kO2gUtVKUrP9hcreHd148g==`. Source tag dsh-v0.2.1-rc.5 resolves to `b830ec950faba0a46dda564be3e2d854afed94f1`; the older fcc0ad4 source reports 0.2.2-rc.1 and is not rc.5 evidence. This is an authenticated local plugin/API check, not adversarial binary attestation or proof about other independently running processes.

### Phone Model Selection

The 2026-11-13 phone probe received one workspace, four runtimes and zero registered models for every runtime. Codex reported `codex-cli 0.167.0-alpha.4.1`; DSH reported `0.2.1-rc.5`. Installation and an online transport do not supply a model catalog. Setup intentionally initializes `runtimes.<engine>.models` to an empty array. Character mappings are artwork metadata, not available model identities.

On the Mac, use the existing protected configuration locally to register only exact native-supported `providerId`, `modelId` and a display `label` under the Codex runtime's `models`. Obtain the identity from that installed runtime's own metadata/API and active provider; do not infer it from the model label, artwork, CLI version, this document, or another provider. Do not share the configuration, credentials or a full bootstrap response. Restart the gateway after configuration changes, then use the phone's model/workspace refresh action. No automatic model discovery or private configuration rewrite was performed by this fix.

The observed DSH descriptor still advertised model control, unlike the updated read-only adapter. Upgrade `apps/gateway/src/core.ts`, the protocol package, adapters and complete `plugins/dsh-bridge/` together from this source tree; old `dist/desktop` and `output/AMC-computerside` copies are not updated deployment artifacts. The phone rejects rc.5 model control even when an older host advertises it. Do not add DSH models to unlock it. Keep Claude/OpenCode disabled while uninstalled.

Home selection persists a new-session target, not a native-confirmed model. Chat selection applies only to an idle managed session and, for Codex, the confirmed thread provider. An external imported session has no control lease. Running/waiting/cancel-requested/uncertain sessions remain disabled. A configure receipt is not model confirmation: the updated gateway notifies the catalog after persisting the next-turn target; the phone resubscribes for a snapshot, and only native model confirmation changes the current model. Updating only the APK will not repair missing host registration or the old gateway's missing notification.
