# 四平台实际验收记录模板

## 当前状态

依据根计划第 11 节 T01–T24 与附录 F。本文件是**待实际执行的记录模板**，不是通过报告。生产实现、协议模拟及本机网关集成测试已修改并通过，鸿蒙已实际编译打包；最新结果见 `docs/FOUR_PLATFORM_IMPLEMENTATION_REPORT_2026-11-16.md`。没有执行真实原生任务、使用模型账号、连接用户主机/VPS 或鸿蒙真机。所有真实用例默认 NOT RUN，不能用 fixtures、mock、schema、编译或 HTTP 200 预填 PASS。

状态只使用 NOT RUN、BLOCKED、FAIL、PASS、N/A。BLOCKED 必须有具体前置缺失或版本/字段差异；N/A 必须有不适用理由和审核人，不能算通过。PASS 必须附下述原始证据。每次执行追加独立记录，不覆盖失败历史。主机 OS、引擎版本、通路变化须新建执行批次。

## 批次信息

| 字段 | 实际填写 |
| --- | --- |
| batchId / 日期 UTC / 执行人 / 审核人 | 待填 |
| 源码实际提交或快照 SHA256 / 工作区差异 | 待填，不用计划基线冒充实际提交 |
| 网关、桌面、协议、适配器、完整插件、手机产物版本和摘要 | 待填 |
| Node / TypeScript / AJV / 锁文件摘要 | 待填 |
| Codex CLI 版本/路径/摘要/app-server 实例身份 | 待填 |
| Claude SDK / CLI 版本/路径/Query 生命周期身份 | 待填 |
| OpenCode client / CLI / 服务登记与进程身份 | 待填 |
| DSH 宿主 revision / controller 版本 / pluginInstanceId | 待填 |
| macOS / Linux / Windows 版本与架构、各引擎支持范围 | 待填，逐主机执行；不支持须说明 |
| 模型 providerId/modelId、认证是否就绪 | 待填，不含密钥 |
| 手机型号 / HarmonyOS / SDK / 应用签名标识 / 通知权益 | 待填，不含签名私钥 |
| hostId / workspaceId / 授权目录 / runtimeInstanceId / generation | 待填 |
| LAN/移动公网/VPS/EasyTier 拓扑及端口 | 待填 |
| 升级前后证书 CA 指纹、配对/历史/工作区保留核对 | 待填，不记录 CA 私钥或 token |

## T01–T24 记录索引

以下每一行是实际验收入口。C=Codex、L=Claude Code、O=OpenCode、D=DSH。四平台用例每引擎分别记录，不共享一个 PASS。限定引擎列的 N/A 仅表示该条的范围，其余用例不得据此跳过。T23/T24 必须在适用四平台闭环分别留证。

| ID | 操作与实际通过证据 | C | L | O | D | 实际记录路径 / 限制 |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | 手机新建并在授权目录创建唯一文件；关联原生 session、命令、run；校验真实文件内容/摘要 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T02 | 多步任务包含工具；执行中手机出现增量和工具进度；完整消息替换增量、无双份 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T03 | 分别正常完成与明确失败；保存两次原生终态、最终文本或可定位错误，不能凭最后文本判成功 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，两次记录 |
| T04 | 真实权限等待、手机允许一次、原生实际执行；记录展示范围和准确原生响应 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T05 | 拒绝同类请求；证明操作未执行，原生后续解释不冒充操作成功 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T06 | 真实原生提问；手机答案按原生结构返回，执行继续；记录问题键/类型/实际接收 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，秘密答案脱敏 |
| T07 | 停止受控长工具；先正在停止、后原生确认；心跳文件在观测窗口不再增长 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，非文本取消 |
| T08 | 停止后同会话继续；nativeSessionId 不变、新 runId，引用前轮上下文及文件 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T09 | 提交后手机立即断网再恢复；主机仅执行一次，补齐结果，无离线假终态 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T10 | 重复/重传同 clientRequestId 100 次；原生投递/文件副作用只一次，回执一致；同键不同正文拒绝 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T11 | 原生接受后切断回执；显示 uncertain，恢复核对原生命令/输入记录，不自动重提 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，故障注入时点 |
| T12 | 两个配对客户端竞争允许/拒绝，原生支持时再测手机/桌面；一次结算、旧卡关闭、晚答无作用 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，不虚构 Claude 任意终端接管 |
| T13 | 等待审批时停止，旧答案再次发送；不能复活原运行或作用于下一轮 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T14 | 接近完成时停止，分别控制完成先到/停止先到；保留真实结果，晚 cancel ack 不改 completed | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，两种顺序 |
| T15 | 网关重启但原生保留；重连同服务，认出活动会话，不重复执行、不伪造回调 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T16 | 原生异常退出；记录真实错误和状态，关闭失效审批；恢复核对旧执行后才继续 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，generation 前后 |
| T17 | 手机切主机后发送旧页面命令；host/ref/generation 拒绝串发，新主机无副作用 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填 |
| T18 | 真机锁屏/关应用时完成与审批；系统通知实际出现、点击定位后查询当前状态 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，真机证据必需 |
| T19 | DSH 有 pending inbox 时取消当前 turn；只停当前轮，后续原生启动如实显示，不假称清空队列 | N/A | N/A | N/A | NOT RUN | 待填 |
| T20 | OpenCode SSE 断线期间结束；重订阅加快照/消息/pending 重建，二次核对，无伪 replay cursor | N/A | N/A | NOT RUN | N/A | 待填 |
| T21 | Codex 桌面 CLI 与手机同 app-server 同线程；同一 turn 可见、审批/停止作用同执行 | NOT RUN | N/A | N/A | N/A | 待填，不以同历史替代 |
| T22 | Claude 连续两轮复用 Query，Query 结束后 resume 同 session；旧 callback 不复用 | N/A | NOT RUN | N/A | N/A | 待填 |
| T23 | 手机关闭 Wi-Fi，仅移动网络经 VPS+EasyTier；四平台命令/事件均走公网，无私网旁路 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，路由/转发证据必需 |
| T24 | 重复事件去重、token 轮换、处理后点击旧通知；无重复终态推送、旧 revision 不删新绑定、旧通知不授权 | NOT RUN | NOT RUN | NOT RUN | NOT RUN | 待填，三种子场景 |

## 单次实际记录

每个索引条目、引擎、主机 OS 及子场景使用以下完整记录。文件可放受保护证据目录，索引引用脱敏副本和摘要。未执行字段保持“未执行/待填”，不得复制样例 ID 当成真实 ID。

```text
recordId: 待填
batchId / caseId (T01-T24) / subcase: 待填
engine / OS / 手机 / 网络通路: 待填
status: NOT RUN
执行日期 UTC / 执行人 / 审核人: 待填
前置条件与安全授权 / 缺失条件: 待填
实际版本、构建摘要和配置差异: 待填
hostId / workspaceId / 目录: 待填
runtimeInstanceId / pluginInstanceId 或 Query/app-server/service 身份: 待填
generation 前后 / nativeSessionId / gateway sessionId: 待填
clientRequestId / deviceId / runId / native turn-message-request ID: 待填
interactionId / 原生 request ID 的类型和值: 待填
故障注入点、事件顺序和时间源: 待填
实际步骤与输入: 待填
预期结果: 引用索引用例，并补充本轮可判定条件
实际观察: 未执行
原生请求/响应/事件日志路径与 SHA256: 待填
网关持久回执、seq、投影与重连日志路径及 SHA256: 待填
主机文件/工具结果/执行次数/心跳观测: 待填
手机截图或录像路径、时间点及 SHA256: 待填
推送意图 / provider requestId / 设备展示 / 点击后查询: 待填或说明不适用
native submit 次数 / resolver 结算次数 / 终态数 / 重复文本数: 待填
判定依据与差异: 未执行
限制、失败定位、问题单和重试 recordId: 待填
```

原始证据保留原生 ID 的类型和值以便关联，但必须去掉 Authorization、JWT、模型密钥、设备/桥 token、私钥与秘密问题答案。外发报告可用一致脱敏映射，不改变“同一 ID”和类型关系；完整受保护原件不能进入 Git。

## 判定细则

- T01 真实文件需唯一标记、执行前不存在、执行后校验内容/摘要。单纯 HTTP 200、空会话、虚构进度均不合格。
- T04–T06 不同引擎使用各自原生结构。Codex request ID 保留数字/字符串；附加权限不是 decision 布尔；Claude AskUserQuestion 用问题文本键；OpenCode 表单用 field.key/option.value 与真实类型；DSH 命中存活 resolver。
- T07 使用原生执行器管理且不自行 daemonize 的心跳子进程，记录 PID、启动方式、采样间隔、取消前后内容、足够长的停止后观测窗口。自行脱离进程和后台服务的停止范围单列，不能声称全部被终止。
- T08/T14 旧 cancel 仍在途或 uncertain 时禁止新一轮；自然完成先到保留 completed。OpenCode session interrupt 没有 expectedTurnId，不承诺独立客户端提交下一轮时的原子比较取消。DSH 同宿主实时校验 turn 后 cancel，仍不清 inbox。
- T11/T15 恢复不是新输入，真实副作用和原生投递次数都必须核对；数据库意图、原生接受、落库确认的时间点分别记录。
- T12 至少测试 A 先允许/B 后拒绝和反向顺序；只应有一个原生有效决定，不能用串行调用次数代替真实竞争测试。DSH 下游 unavailable 不自动批准，手机断线不自动拒绝。
- T16/T17 覆盖 generation 3→4 后旧答复拒绝且新运行时无调用；同一宿主桥重连与手机重连不应无故升代。
- T18/T24 分别记录网关通知意图、官方接口接受、真机展示及点击恢复。`80000000` 只代表服务接受；绑定 revision 和 token 轮换必须核对，旧通知只能定位不能执行授权。
- T20 不要求恢复不存在的瞬时 token 流；要求完整消息/工具结果/最终状态重建且不重复。DSH 额外核对 follow 无 afterSeq，page 固定 throughSeq，attempt/revision/index 去重。
- T23 记录关闭 Wi-Fi、移动网络状态、VPS TCP 入口与 EasyTier 转发观察，不能将 LAN 或模拟器连通算作公网通过。

## 补充门槛

| 项目 | 实际记录 | 当前判定 |
| --- | --- | --- |
| macOS 路径/进程/编码与各引擎支持矩阵 | 待填 | NOT RUN |
| Linux 路径/进程/编码与各引擎支持矩阵 | 待填 | NOT RUN |
| Windows 路径/进程/编码与各引擎支持矩阵 | 待填 | NOT RUN |
| 既有证书、配对、hostId、历史及工作区迁移保留 | 待填，参照 docs/FOUR_PLATFORM_OFFLINE.md | NOT RUN |
| 错误 CA、过期证书、错误 SAN、错映射端口拒绝 | 待填，逐项记录 | NOT RUN |
| 增量入库到手机 P95 ≤2s | 待填，样本数/时间源/原始分布 | NOT RUN |
| 普通命令持久回执 P95 ≤1s | 待填，模型计算耗时单列 | NOT RUN |
| 100 次重传无重复执行 | 待填，参照 T10 原生/文件副作用 | NOT RUN |

## 离线证据独立记账

`tests/contracts/offline-fixtures.test.ts` 的合成协议校验与七条参考回放单独记录命令、Node 版本、通过/失败数量。即使全部通过，本表 T01–T24 仍保持 NOT RUN，直到实际执行并附证据。它不验证真实适配器、SQLite 崩溃原子性、模型可用性、真机推送或公网路由。

最终汇总需分别统计离线契约、真实原生、真机、公网的 PASS/FAIL/BLOCKED/NOT RUN 数量与未满足限制。不得把 N/A 或离线成功折算成真实四平台交付通过。
