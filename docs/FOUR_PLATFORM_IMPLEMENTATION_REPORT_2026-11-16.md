# 四平台协调升级实现与验证记录

## 2026-11-16 本次最终交付复核

本节是当前代码的最新结果，下文保留先前实施记录。已在现有实现上补齐原生控制、既有会话连接、恢复及手机投影的缺口。**计划的完整验收仍未完成**：固定版本原生依赖缺失，真实模型任务、移动公网和真机通知未运行；Claude 多选答案的原生字符串编码仍因缺少目标 SDK 工具 schema/fixture 而明确拒绝，未用猜测的编码代替。

本次具体修改：

- 新增 `POST /v2/sessions/{id}/attach`，校验配对身份、完整源 ref、目标运行时与工作区。手机只按 `controlCapabilities.attach` 显示连接入口。Codex、OpenCode、DSH 分别验证原生所有权、目录与运行时身份；连接不创建会话或提交任务。失败关闭部分绑定、返回 rejected；恢复重新验证所有权，不绕过接管边界。
- 未绑定的历史在网关重启、原生握手和断开时保持 unbound，不自动接管，也不凭未知历史占用受管理写锁。连接到已有活动任务时创建独立网关 run，保留真实原生标识；OpenCode 没有 turn ID 时仅保存已验证 busy 时间边界。
- Codex 补齐旧轮审批拒绝、权限字段、原生请求关闭与错误保留；导入后按原生身份合并消息，避免历史重复。共享 WebSocket 有明确握手超时。
- Claude 每个 Query 使用独立身份和 generation，提交前准备控制句柄；重建后拒绝旧代请求，刷新后继续原会话。输入入队不算原生接受，still_queued 非空不算已停止。用实际 Core/SQLite 验证跨 Query 的同会话继续。
- OpenCode 增加同服务会话发现/历史 provider 并在网关注册；通过输入 ID、最新 user 消息与 busy/idle 边界核对完成和取消，避免受管理任务永久 uncertain；竞争输入或证据不足仍保留 uncertain。
- DSH 在网络断开时继续跟踪宿主事件，关闭已经结束的审批；捕获手机订阅前的审批，并保持单次结算。原生跟踪与桥连接生命周期分离，历史附着复用消息 ID。
- 手机忽略网关已判旧的事件、终态关闭失效交互、新轮清除旧结果，保存完整结束证据；连接请求持久化并以原回执核对。推送排除历史、初始快照、未绑定历史及已处理交互。

本次实际验证：

| 检查 | 结果与证据 |
| --- | --- |
| Node | `C:\Program Files\nodejs\node.exe`，24.18.0 |
| 全量 Node 测试 | **386/386 通过，0 失败、0 跳过**；`output/four-platform-final-tests-20261116.log` |
| 项目及桌面 TypeScript | 两项 `tsc --noEmit` 通过 |
| 源码与资源 | `check-source.mjs` 120 个源文件检查通过；`check-assets.mjs` 通过 |
| 鸿蒙真实编译/打包 | CompileArkTS、assembleHap 成功；`output/harmony-four-platform-build-20261116.log` |
| 鸿蒙产物 | `apps/harmony/entry/build/default/outputs/default/entry-default-unsigned.hap`，103674632 字节；未配置 signingConfig |
| HAP SHA256 | `46CCED568A1E87970A4EDBEC56EF5232D6D5B9544ECD3A4AD5EF553FDD108556` |
| 离线依赖 | BLOCKED；`output/four-platform-dependency-readiness.json`，Claude SDK/OpenCode client/CLI 与必需 peers 未提供完整锁定安装集合 |
| 当前设备 | `hdc list targets` 为空，未进行本次模拟器/真机 UI、通知或原生任务交互验收 |

测试使用本机 TLS、WebSocket、HTTP、SQLite 和合成原生协议；初次沙箱测试的 loopback EACCES 已在允许本机连接的环境重跑，不计作通过证据。386 项通过不能代替 T01–T24 真实引擎/设备验收。无 Git 元数据，不能核实提交基线、提交改动或推送仓库。

尚需提供目标依赖与运行环境，固定完整依赖锁，再执行原生 T01–T24；尤其包括 Claude 多选答案契约、受控长工具停止、三主机、公网移动网络、签名真机与系统通知。旧报告中提及的模拟器启动属于历史记录，并非本次观察结果。

## 交付判定

本次已修改生产代码和离线测试，不将其标记为计划全部验收完成。目标 SDK/CLI 离线依赖、真实 DSH 宿主、模型账号、公网主机和推送真机环境尚未齐备；四平台真实执行及 T01–T24 仍需按验收表留证。尤其不能把合成协议、模拟 HTTP/WebSocket 服务或鸿蒙模拟器启动等同于原生控制闭环通过。

工作目录没有可用的 Git 元数据，无法核实其提交确为计划指定基线；保留原文件并按本地实际目录修改，未执行提交或推送。

## 已实现的代码范围

| 区域 | 主要改动 |
| --- | --- |
| 统一协议 | 协议 2、`/v2`、RuntimeBinding、generation、稳定网关 runId 与原生 ID 分离、类型化原生交互与事件 schema |
| 网关 | 会话命令串行、持久幂等与投递意图、目标轮次/代次校验、不可回退终态、不确定停止阻止下一轮、待审批单次结算、WSS 持久 seq 补齐 |
| 历史与恢复 | 历史来源不授予控制权；已验证绑定独立授权；持久绑定断开后自动查询同一运行时，失败退避，不自动提交或启动新原生服务 |
| Codex | 共享本机 app-server WebSocket、initialize/initialized、线程/轮次映射、保留数字或字符串原生审批 ID、附加权限与用户问题；主机显式管理服务登记 |
| Claude | 官方 SDK 动态加载、长期 Query 与输入队列、原生初始化确认、权限 Promise 与 AbortSignal、AskUserQuestion、interrupt/result、同 Query 下一轮与同 session resume；移除旧 permission MCP 控制实现 |
| OpenCode | v2 服务发现、HTTP/SSE、实时流重连与快照/消息/交互核对、permission/form、`interrupt?resume=false`；替换 ACP 控制路径 |
| DSH | 同宿主 controller create/prompt/cancel/follow/page、插件待交互 resolver、手机/电脑单次结算、原生流/持久事件映射与取消原因区分 |
| 手机 | 协议同步、能力驱动替代 DSH 固定只读、新建后独立提交、停止当前 run、同会话继续、seq 缺口补齐、权威文本归并、原生选项/类型化表单、通知点击重新查询 |
| 主机管理 | 显式启动/登记 Codex/OpenCode、无副作用 probe/connect、版本门槛、端点身份、三主机配置与既有身份/推送配置保留 |
| 官方推送 | PS256 JWT、官方 V3 请求、过期 JWT 刷新、保守错误分类、稳定通知 ID、终态/交互事务 outbox、token revision 与撤销检查、脱敏提供方回执 |
| 离线资料 | 四平台原生形态 JSON fixtures、AJV 及参考轨迹测试、部署/迁移说明、T01–T24 验收模板、推送配置说明 |

## 已执行验证

- 项目测试使用本地 `C:\Program Files\nodejs\node.exe`，版本 `24.18.0`；默认 DevEco PATH 的 Node `18.20.1` 不符合项目约束，不能直接用于 `.ts` Node 测试。
- `npm run typecheck`、`npm run check:source`、`npm run check:assets` 已实际执行通过。最终全量测试结果以本报告末尾的复核记录为准。
- 官方推送与恢复集成专项 14 项通过，包含签名验证、发送报文、原子回滚、历史静默、撤销、轮换、过期、失败退避和恢复不重提。
- 鸿蒙 9 个修改的 `.ets` 文件通过 `arkts_check`；`build_project` 使用 `default/debug`、`entry`，增量构建成功。
- 构建配置兼容 SDK `6.0.0(20)`，目标 SDK `6.1.1(24)`；构建提示没有 product signingConfig，模拟器仍已成功安装运行。
- 应用 `com.zondaxu.aimaidcafe/EntryAbility` 已在 Pura 90 模拟器 `127.0.0.1:5555` 安装并启动。未进行 UI 自动走查、截图验收或真实网关任务交互，未连接真机。

## 不可计为完成的项目

1. **依赖与版本固定未完成**：本机 Codex 实际为 `0.167.1`，不是目标 `0.169.0`。本地未提供 Claude SDK `0.3.325`、Claude Code `2.1.325`、OpenCode client/CLI `2.3.0` 与完整 peer 依赖闭包。未联网下载、未伪造 lockfile 条目；新依赖的离线解析和锁定仍阻塞。
2. **原生五项闭环未验收**：未用四种目标版本执行真实文件任务、真实权限与问题、受控长工具取消及同会话上下文继续。可连接、版本匹配或模拟事件均不是此项证据。
3. **复杂原生边界仍需目标安装包验证**：Claude 多选答案的原生字符串编码、Query 首次初始化和进程退出后旧执行确认；Codex 同 app-server 桌面共享与断连审批恢复；OpenCode 服务登记路径与 SSE 缺口恢复；DSH 真实 agent/session 关联及桌面审批呈现撤回。
4. **公网与系统推送未验收**：没有以移动网络穿过 VPS/EasyTier 完成指令，也没有提供真实推送服务账号、分类权益和匹配签名真机。提供方模拟成功不表示系统展示。
5. **跨 OS 与性能未验收**：macOS/Linux/Windows 三主机真实运行、P95 延迟和真实 100 次重传等需分别记录，不能由 Windows 单机测试外推。

## 相关资料

- `docs/FOUR_PLATFORM_OFFLINE.md`
- `docs/HARMONY_PUSH_V3.md`
- `apps/desktop/RUNTIME_HANDOFF.md`
- `tests/e2e/FOUR_PLATFORM_ACCEPTANCE.md`
- `tests/fixtures/four-platform/`

应先提供缺失离线包及目标运行环境，核实真实版本和控制契约，再逐项填写验收证据；未通过项不得因本次代码编译成功而勾选。

## 最终回归复核

使用 Node `24.18.0`，PATH 同时包含本机 Git 的 OpenSSL 目录：

```powershell
$env:PATH='C:\Program Files\nodejs;C:\Program Files\Git\mingw64\bin;C:\Program Files\Git\usr\bin;'+$env:PATH
npm run typecheck
npm test
npm run check:source
npm run check:assets
```

最终 `npm run typecheck` 通过；`npm test` **240/240 通过，0 失败、0 跳过**。9 个修改的 `.ets` 文件再次通过静态检查。测试包含合成原生服务、真实本机 TLS/WSS 与持久数据库，但不包含目标模型程序、真机系统推送或公网验收。

## 本轮继续实施复核

本轮开始时实际全量测试为 242 项，其中 241 项通过，1 项素材展示源码断言失败。上节 240 项是前次执行记录，不应当作本轮结果。

新增网关修复：

- 审批允许的路径必须仍在主机授权根目录内；拒绝越权请求不调用原生答复，也不扩大目录授权。
- 审批路径异步核对后重新检查会话、运行、连接代次与工作区；失效请求不发送给新控制句柄。
- 一次串行恢复失败不会将已经排队的下一次恢复一起拒绝；恢复仍不产生模型输入。
- snapshot/events/history/messages 读取统一核对当前工作区授权，撤销根目录授权后不能通过旧历史路由继续读取。
- bootstrap 仅返回当前仍获主机授权的工作区及其会话；停止中或事实待核对的运行拒绝旧审批答复。
- 已建立的 WSS 订阅在工作区授权失效后也会关闭，不继续泄露后续消息；审批异步路径核对期间若原生替换了同 ID 请求，拒绝使用旧展示范围答复新请求。
- README 与离线部署说明同步实际 v2 控制实现，移除仍声称主路径为 ACP/permission MCP 或仅新增 fixtures 的过期说明。

上述修复的网关专项测试 16 项通过，包含本机真实 TLS/WSS，但不是目标引擎或公网验收。完整本轮复核结果在所有修改完成后另记。

手机本轮补齐了回执证据持久化、晚到回执不回退新轮状态、控制请求串行、停止/待核对时禁止审批、异步发送前身份复核，以及跨连接的 seq 缺口恢复。原生表单不再重复显示问题区；可选空数值省略，空多选仍执行原生最少项数校验。素材展示测试改为真实执行组件方法，验证透明衍生图失败后回退原图、原图失败后显示占位，未为满足旧正则而退回展示逻辑。

本轮 `build_project` 已实际成功完成 `default/debug` 的 `entry` 增量构建，随后在唯一连接的 Pura 90 模拟器（`127.0.0.1:5555`、HarmonyOS 6.1.1 API 24）安装并启动 `com.zondaxu.aimaidcafe/EntryAbility`。没有 product signingConfig，未配置或改动个人签名；模拟器启动不代表真机签名、任务交互、系统推送或 UI 视觉验收通过。本轮未执行 UI 自动走查。

新增 `npm run check:offline` 只读依赖检查及 9 项契约测试，分别报告未提供与版本/完整性不匹配，并检查包内、scope 层与根目录中的 peer 遮蔽关系。当前实际执行结果为 BLOCKED：Node 24.18.0 就绪，Claude SDK、OpenCode client/CLI 和必需 SDK peers 在锁文件与安装目录均缺失。检查不下载、不修改锁文件、不执行依赖代码或原生程序；其结果只代表依赖就绪度，始终不冒充真实引擎验收。
