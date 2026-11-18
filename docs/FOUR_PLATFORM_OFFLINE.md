# 四平台离线开发与部署

## 适用范围

离线打包的依赖清单来自四平台开发计划。主机运行时按实际协议能力接入，配置步骤见 [主机说明](HOST_SETUP.md)。

四平台 JSON 是按已摘录的真实原生接口形态构造的**合成、最小相关字段样例**，不是从真实程序录制的完整报文，也不是上游完整 schema。`nativeVerified:false` 必须保留。Claude 的 Query、AbortSignal、DSH 的 agent/resolver 是进程内对象；JSON 只表示可序列化参数和结果，不能恢复这些句柄。

## 版本清单

| 对象 | 计划固定目标 | 本次实际证据 |
| --- | --- | --- |
| 仓库审查基线 | v0.3.0 / `6cb57bf5e17ae7d78928040c5608b498230f6aeb` | 来自计划，未据此认定本工作目录提交 |
| 对标 DSH 插件 | v0.5.86 / `26d98dc2ed3cb7bede7f9471d2ed7fa5d8f7e68a` | 资料参照，未运行 |
| Node | `>=24.13.0 <25` | `C:\Program Files\nodejs\node.exe` 实测 `v24.18.0` |
| TypeScript | 5.9.3 | package.json 固定值；部署记录仍须记录实际安装值 |
| AJV | 8.17.1 | 使用仓库已有依赖，无新依赖 |
| Codex | `rust-v0.169.0` / `d32063f96c2dff1dc96af839b3952abb6acfeda4` | 本机 0.167.1 与 0.145.0 已通过共享连接、历史、同会话续聊和另开会话测试，使用本机测试模型服务 |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk@0.3.325` | 仅合成契约；未调用 SDK |
| Claude Code | 2.1.325 / `a360e7297ecfcddeae9ec99fb3c93153ed86aca4` | 计划组合，未实测 |
| OpenCode client / CLI | 均为 2.3.0 / `d5ea1ee6761eaba9787b09211b23d6d76288aded` | 仅 v2 HTTP/SSE 合成契约 |
| DSH | `b830ec950faba0a46dda564be3e2d854afed94f1` / controller 0.2.1-rc.5 | 仅合成契约；未连接宿主 |
| HarmonyOS | 部署机已安装 SDK、构建工具、合法签名 | 9 个修改文件 ArkTS 静态检查通过；default/debug entry 构建通过，并安装启动 Pura 90 模拟器；未连接真机 |
| Push Kit | NEXT/5+ V3、服务账号 JWT PS256 | 本次未调用官方服务、未验证设备展示 |

部署报告逐项补充实际版本输出、包完整性、可执行文件绝对路径、OS/架构和构建产物摘要。不能用计划版本替代实测版本。OpenCode OpenAPI `0.0.1` 不是 CLI 版本。SDK peer dependencies 为 `@anthropic-ai/sdk >=0.93.0`、`@modelcontextprotocol/sdk ^1.29.0`、`zod ^4.0.0`，离线包集合须记录锁文件解析后的具体版本。包 SHA512 对照根计划 12.1，不修改锁文件以绕过缺包。

## 离线材料

1. 准备同一批次源码、package-lock.json、已安装依赖或完整 npm 缓存、本机 Node 24、TypeScript、OpenSSL。在隔离副本中验证包摘要和依赖完整性，不能清理现有可用环境后才发现缺包。
2. 预置四种固定版本可执行文件、SDK、peer dependencies、DSH 宿主及完整桥目录；由运行账户准备合法认证。禁止将模型密钥放入 fixture、手机、日志或文档。
3. 预置 HarmonyOS SDK、构建工具、调试签名和所需离线资源。推送另需已开通项目、匹配签名、通知分类权益、服务账号与真机。
4. 记录缺失材料为 BLOCKED，不运行联网安装或自动下载作为“离线部署步骤”。有完整缓存时可在独立部署目录使用 npm 的 `ci --offline --ignore-scripts`；若包需要安装脚本，应先审查并记录本机重建步骤，不默认为可省略。

离线开发不等于模型运行不需要网络。真实模型、公共入口及官方推送仍依赖其各自可用的网络、账号、设备，不由 Markdown 或 fixtures 提供。

使用 Node 24 在仓库或解压后的分发目录执行 `npm run check:offline`，或 `node scripts/check-offline-readiness.mjs --json`，可只读核对目标 SDK/client/CLI 包、计划 SHA512 锁元数据、SDK peers 及已安装传递依赖闭包。检查保留 Node 实际解析的嵌套路径，比较安装清单与对应锁条目的名称、版本、integrity，核对依赖与 peer 版本范围；不支持的范围保守阻塞。平台 optional 包按目标 OS/架构筛选，适用但未安装的 optional 依赖也阻塞；缺席的 optional peer 不要求安装。该检查不安装、不联网、不加载依赖代码，也不运行原生程序；阻塞时非零退出。它不重算 npm 原始压缩包完整性，也不证明安装文件未被修改。`nativeVerified:false` 表示依赖就绪不能替代原生控制验收。当前环境缺少目标包与 peers，检查结果应为 BLOCKED，不应为使其变绿而伪造锁条目。

## 桌面分发模式

默认 `node scripts/package-desktop.mjs` 保持基础管理工具包模式（`base-management`），仅收集根生产依赖闭包，提供向导、网关及适配器源码，不承诺四平台依赖完整或原生控制已验收。基础包运行 `check:offline` 因缺少目标 SDK 而 BLOCKED 是预期结果，不影响基础管理入口的用途。

显式执行 `node scripts/package-desktop.mjs --offline --out <新的隔离目录>` 才请求四平台离线开发完整依赖包（`four-platform-offline`）。在创建输出目录前，对 Windows、macOS、Linux 分别检查当前 Node 架构下的真实锁条目、固定目标 SDK/client/CLI 与 peers，以及全部已安装依赖闭包。缺少任一目标适用依赖即报 `BLOCKED`，不自动安装、不伪造或补写锁文件。制作多系统包需事先准备对应平台的 optional 依赖；单机安装树通常不满足其他 OS 的原生依赖。完整指项目运行 JavaScript 依赖集合，并非自包含系统镜像：Node、OpenSSL、Codex 二进制、DSH 宿主、认证、手机 SDK/签名仍由部署方提供并独立验收。

两个模式均随包提供原始 `package-lock.json`、`scripts/check-offline-readiness.mjs` 和可执行的 `check:offline` npm 命令，目录移动后无需仓库路径。`distribution-manifest.json` 记录实际模式、目标 OS/架构、各物理安装路径的版本与锁 integrity，以及其余随包文件的大小和 SHA256；该清单不包含自身。批次 `manifest.json` 和 `SHA256SUMS.txt` 记录各 ZIP 摘要。清单始终保留 `nativeControlVerified:false`、`runtimeBundled:false`，不以目标版本表冒充实际安装清单。部署指南位于 `docs/DESKTOP_GUIDE.md`，根目录“使用说明.md”仅链接到包内文档；运行时交接说明在源码原路径及 `docs/RUNTIME_HANDOFF.md` 均可用。

## 配置与网络

保留现有受保护 `host.config.json`，先备份再改版本与运行路径。setup 仅用于**没有既有身份的新主机**；升级不要重跑 setup。当前 setup 的真实配置字段如下，此片段仅用于核对，不是可以覆盖现有配置的完整文件：

```json
{
  "listen": "10.89.90.2",
  "port": 8899,
  "publicEndpoint": "https://relay.example.com:18543",
  "dataDir": "D:/AMC/private/data",
  "caFile": "D:/AMC/private/data/host-ca.pem",
  "certFile": "D:/AMC/private/data/gateway.pem",
  "keyFile": "D:/AMC/private/data/gateway.key",
  "allowedWorkspaceRoots": ["D:/Projects"]
}
```

`relay.example.com` 与路径必须由操作员替换；不可重新生成或覆盖 `hostId`。`runtimes.<engine>.command` 指定实际可执行文件绝对路径，`expectedVersion` 记录该适配器所需的完整本机输出，`models` 仅登记原生实际可用的 providerId/modelId/label。CLI 的 `--version` 不证明已认证或可审批；未安装、握手失败或控制未验证时不开放写能力。不要把此文版本标签直接当作所有引擎的 `expectedVersion` 输出字符串。

配置目录 A 与 `dataDir` B 可以不同。桌面保存名称或其他设置保留既有 `dataDir`，不会隐式搬迁数据库；桌面 RuntimeManager 与网关均使用 B 中的运行时登记和锁文件。既有 hostId、CA、桥密钥路径、配对、历史和工作区数据继续沿用。新主机才默认使用配置目录作为数据目录。需要迁移 B 时应停止网关、备份并显式操作，不通过一次名称保存完成迁移。

| 配置项 | 约定与验证 |
| --- | --- |
| EasyTier | `deploy/easytier/profile.example.json`，独立 `agent-console-mesh`，`10.89.90.0/24`，peer 12080 |
| Windows | VPS TCP 18543 → `10.89.90.2:8899` |
| macOS | VPS TCP 18541 → `10.89.90.3:8899` |
| Linux | VPS TCP 18542 → `10.89.90.4:8899` |
| TLS | 云端只转发字节，主机终止 TLS；SAN 包含真实域名，8899 仅监听授权接口 |
| 工作区 | 主机登记 workspaceId → 授权绝对目录，不接受手机任意 cwd |
| 模型认证 | 留在主机运行账户，不透传给手机或 VPS |
| 推送 | 主机私有配置指向完整服务账号文件，project_id 与应用匹配；JWT/私钥不得进入报告 |

原生运行时配置与协议 2 必须由同批生产实现提供。已有主机管理器提供显式启动/登记、无副作用连接和身份核对，配置字段以 `RuntimeConfig` 与 [运行时交接说明](../apps/desktop/RUNTIME_HANDOFF.md) 为准。服务未登记、握手失败或能力未验证时部署判为 BLOCKED，不能只增加端点字段后宣称启用。

| 引擎 | 本机运行与所有权核对 |
| --- | --- |
| Codex | 用固定二进制 `app-server --help` 核对后运行 `codex app-server --listen ws://127.0.0.1:8897`；核对占用和进程身份。桌面用 `codex --remote ws://127.0.0.1:8897` 连接同一个服务。初始化后发 initialized；另起进程读相同历史不是接管。 |
| Claude | 通过长期持有的官方 SDK Query 接受 AsyncIterable 输入，明确 `pathToClaudeCodeExecutable`、授权 cwd、`includePartialMessages:true`、`permissionMode:default`。持续消费输出。手机断线不关闭输入；Query 真结束才用 resume 同 session，不 fork。 |
| OpenCode | 用 `Service.discover()` 与 `Service.headers(endpoint)` 连接同一已登记服务。普通读取不得调用 ensure 替换服务；确认无服务且操作员明确启动时才使用 `opencode serve --service`。手机不访问原生端点。 |
| DSH | 完整 `plugins/dsh-bridge/` 加载进实际宿主；插件取得该宿主 controller。桥主动连 `ws://127.0.0.1:8898`，`tokenFile` 指向既有私有 dsh-bridge.secret。controller 必须来自匹配依赖上下文；不能用版本字符串代替真实握手或用历史记录伪造 resolver。 |

## 升级与迁移

1. 协调升级网关、协议、四适配器、完整 DSH 桥、桌面与手机为同一批次 `/v2`；不同时维护旧 ACP 与新 HTTP 双轨写入。现有 `/v1` 或历史只读部署不能因此自动获得控制权。
2. 在受控维护窗口停止新提交，记录活动 run、在途 cancel、uncertain 命令及待交互。不要为了迁移把未知运行标为成功或已停止。
3. 停止网关后，以 SQLite 支持的一致性方式备份完整数据，并保留 host.config、hostId、CA/私钥、叶证书/密钥、配对设备授权、token、桥 secret、工作区、历史和目录身份标记。数据库有 WAL 时不能仅复制一个正在写入的主文件。备份只放受保护位置，不上传仓库。
4. 同一主机保留 CA 和配对身份；叶证书在原 CA 下续签，SAN 正确，私钥权限受限。手机保留唯一主机 CA 校验和 pinning，WSS 继续验证主机 CA。更换 CA 或 hostId 必须显式重新配对，不得关闭 TLS 校验。
5. 不向另一台主机复制 CA 私钥、数据库、hostId 或设备 token。目录迁移遵循 [目录身份确认](workspace-identity-confirmation.md)，不删除既有数据，不通过放宽重叠目录限制解决迁移冲突。
6. 重连同一个原生服务，核对原生 session、活动轮次、pending 和 generation 后才恢复写入。手机/同宿主桥重连不自行升代；原生身份或控制句柄真正重建才升代，旧答案不可送到新代次。持久历史不能恢复 SDK callback。
   网关启动后每五秒检查已绑定但断开的会话，并通过每会话串行的原生恢复接口核对；失败按会话退避，最长五分钟。恢复不会创建会话、提交模型输入或启动原生服务。只读未绑定历史不参与自动控制恢复；无法证明旧 Claude Query 已终止时继续保留不确定状态。
7. 验证旧历史可读、配对仍有效、错误 CA/SAN/过期证书/错端口被拒绝、工作区未改变，再进行真实验收。失败时停止写入并核对活动执行；回滚使用匹配版本和一致性备份，不自动重发 uncertain 命令，不盲目回退已经迁移的数据。

## 样例与测试

| JSON | 内容与关键约束 |
| --- | --- |
| `tests/fixtures/four-platform/codex.json` | thread/turn、文本/工具/终态、数字 101 与字符串 "101" 审批 ID、附加权限对象、按 question ID 回答、精确 turn interrupt、同线程下一轮 |
| `tests/fixtures/four-platform/claude-code.json` | SDK 参数与 system/init、输入 UUID 与原生输出关联、工具结果、allow/deny、AskUserQuestion 原问题文本键、interrupt receipt、同 Query 下一轮及 resume |
| `tests/fixtures/four-platform/opencode.json` | v2 原始 HTTP data envelope、inbox 接受而非完成、SSE 事件数据、权限 request ID 非 event ID、按 key/value 的类型化表单、resume=false、无回放的恢复读取 |
| `tests/fixtures/four-platform/deepseek-harness.json` | create 实际 ID 非建议 ID、prompt accepted、follow stream/持久 seq、toolCallId、resolver 原生返回值、turn/end、page throughSeq、cancel 不清 inbox |
| `tests/fixtures/four-platform/lifecycle.json` | 附录 F 的七条参考轨迹、binding generation、重复与冲突正文、审批竞争、崩溃不重提、流缺口重建、旧代次拒绝、四平台失败/输出限制样例 |

`tests/contracts/offline-fixtures.test.ts` 使用现有 AJV 与 `node:test`，通过相对 `import.meta.url` 读取 JSON，检查原生相关字段、跨报文关联、负向 schema 输入和参考回放状态。其他契约与网关测试还覆盖生产适配器边界、合成原生服务、SQLite 事务、并发和恢复；它们与真实原生验收必须分开记录。AJV 仅检查本样例的结构约束，不声称通过上游完整 schema。

在仓库根目录执行，明确绕开默认 Node 18：

```powershell
& "C:\Program Files\nodejs\node.exe" --version
& "C:\Program Files\nodejs\node.exe" --test tests/contracts/offline-fixtures.test.ts
& "C:\Program Files\nodejs\node.exe" node_modules/typescript/bin/tsc --noEmit
& "C:\Program Files\nodejs\node.exe" scripts/check-source.mjs
& "C:\Program Files\nodejs\node.exe" scripts/check-assets.mjs
& "C:\Program Files\nodejs\node.exe" --test "tests/contracts/*.test.ts" "tests/gateway/*.test.ts" "tests/desktop/*.test.ts" "tests/assets/*.test.ts" "apps/harmony/tests/*.test.mjs"
```

最后一条等价于当前 package.json 的 test 脚本测试范围，但直接选用 Node 24，不依赖 npm 子进程 PATH。参考回放本身不验证生产并发调度、网关事务持久性、真实原生投递次数或工具退出；前两项另有本地集成测试，后两项仍须真实 T01–T24 证据确认。七条参考轨迹不能算作七项真实 E2E 通过。

## 连接已经存在的原生会话

手机先在授权工作区发现并导入历史，再根据 bootstrap 的 `controlCapabilities.attach` 和 `connectionState` 显示连接入口。当前 Codex、OpenCode、DSH 提供原生所有权核对；独立 Claude 终端不因此获得接管能力。`externalSource` 保留历史来源，实际可操作性由验证后的 binding 决定。

调用 `POST /v2/sessions/{sessionId}/attach`，正文只接受 `protocolVersion:2`、当前 `hostId`、唯一 `clientRequestId`、bootstrap 中的 `runtimeInstanceId` 和导入会话原始完整 `ref`。不要把历史占位 runtime ID 改写成目标运行时后再发请求；网关验证成功后返回新的完整 Session。此操作不创建原生会话、不提交任务、不终止其他执行。

成功回执可按原请求重查；失败验证会关闭部分控制绑定并记录 rejected。手机查询原回执确定失败后才释放重试请求。网关重启不把 unbound 历史当作待恢复执行；已经连接的外部会话重连时重新验证原生所有权和工作目录。无原生 turn ID 的 OpenCode 仅记录可获得的真实时间边界，不构造原生 ID。

Claude Query 真结束后，提交前重建同会话的 Query 会产生新 generation。旧页面提交会被拒绝且不会产生新输入；刷新会话后使用新请求继续。仍可能执行的旧 Query 或仍在途的取消不会被自动替换。

## 验收边界

实际执行记录填写 [T01–T24 模板](../tests/e2e/FOUR_PLATFORM_ACCEPTANCE.md)。真实原生、真机和公网当前均 NOT RUN，不预填通过。主机 OS 需要覆盖 macOS/Linux/Windows 的路径、进程和编码；引擎不支持某 OS 时记录理由，不虚构 4×3 通过。

- 只读历史、同 ID 的另一进程、任意 Claude 独立终端都不是完整接管；控制权必须来自真实绑定。
- native_accepted 不是完成，interrupt/cancel 返回也不是所有工具已经退出。T07 要测受控长工具心跳停止，不能用文本生成取消替代。
- Codex 可指定 threadId + turnId；Claude interrupt 针对持有的 Query，still_queued 必须如实处理。
- OpenCode 和 DSH 的取消是 session 当前执行粒度。网关可以串行化本项目命令，却不能给另一独立客户端提供原生不支持的 compare-and-cancel。控制期间新提交应统一入口；跨独立客户端下一轮的风险必须披露。
- DSH cancel 不清 inbox；`max-tokens` 不成功，冷读 `interrupted` 不等于用户取消，`forked` 不是源会话完成。
- OpenCode SSE 不承诺回放；重新订阅、缓冲、读会话/消息/pending、合并后再核对。DSH follow 不接受 afterSeq/cursor，page 以 snapshot.cursor 固定 throughSeq。
- 不确定窗口禁止自动再次提交；完成先到保留 completed，旧停止仍在途时不能开始下一轮。
- 终态通知去重、服务接受、真机展示与点击恢复分别留证；推送成功码不能证明手机显示，旧通知点击不能授权。断线 token 增量可能不可恢复，不声称逐 token 完整回放。

性能目标来自计划：增量相对网关入库 P95 ≤2 秒、持久回执 P95 ≤1 秒、100 次重传无重复执行。实际采样数、时钟方案、原生计算耗时另记；本次未测这些性能指标。
