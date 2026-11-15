# 自动同步与 Harmony Push 运维及集成

## 交付边界

已接入授权根一级项目自动登记、Codex / DeepSeek Harness 外部会话只读同步、持久通知队列、设备绑定以及 Harmony 客户端通知设置和点击定位。网关启动已装配同一个 PushCoordinator 到 HTTP 层及同步事务钩子。自动化默认关闭，需要主机侧显式启用。真实系统通知尚未端到端验收。

**官方发送能力明确未配置、禁用。** 本次核实的官方文档缺少完整发送 URL 和 JWT audience，代码没有猜测端点、没有 Android HMS OAuth 发送实现，也不读取任何服务账号私钥。没有 `transport` 时状态为 `unconfigured`，不会发起网络请求，不会影响历史同步。即使主机已有某个凭据文件或环境变量，也不会自动启用发送。

## 官方契约核实

实施时首先运行了 `devecocli docs search "Push Kit" "服务端" --limit 8 --format json`，随后使用 `devecocli docs read <documentId>` 阅读以下官方本地文档。可按完整 ID 复核：

| 文档 ID | 已核实内容或缺失 |
| --- | --- |
| `开发指南/Push_Kit_推送服务/端云调试/端云调试概述/push-server-intro` | 主机调用云侧，再由云侧下发；回执可选；云侧响应不等于设备实际展示。 |
| `开发指南/Push_Kit_推送服务/使用入门/push-gettingstart` | 开通、签名、通知自分类权益、Push Token 更新、通知授权、点击 skills、服务账号 JWT、REST 请求和真机排障步骤。HarmonyOS NEXT 需重新按该流程集成。 |
| `开发指南/Push_Kit_推送服务/端云调试/推送场景化消息/push-scenes-send` | HTTPS V3，Alert 使用 `push-type: 0`；`target.token` 为数组；通知体含 category/title/body/clickAction；测试消息需显式 `testMessage: true`。完整 URL 仅剩 `]/messages:send`。 |
| `API参考/Push_Kit_推送服务/REST_API/场景化消息推送/请求体结构说明/push-scenariozed-api-request-struct` | HarmonyOS 5+ 不再支持 OAuth 2.0；使用服务账号 JWT，建议有效期 3600 秒。接口 URL 损坏为 `]**/messages:send`，无法验证域名和完整路径。 |
| `开发指南/Push_Kit_推送服务/端云调试/基于服务账号生成鉴权令牌/push-jwt-token` | API Console 下载服务账号密钥；project_id 必须匹配项目；JWT header 为 kid/typ=JWT/alg=PS256，使用 RSA/PSS SHA256，iss 来自 sub_account，exp 比 iat 晚 3600 秒。文档的 aud 和 URL 为空，不能推断。 |
| `API参考/Push_Kit_推送服务/REST_API/场景化消息推送/请求体参数说明/push-scenariozed-api-request-param` | `clickAction.actionType: 0` 打开首页，`clickAction.data` 为 JSON 对象；ttl 以秒计；appMessageId 有去重语义，notifyId 是覆盖语义，不能混同。 |

本地材料表明调测项目每日最多 1000 条测试请求、每次最多 10 个 token；这不是费用承诺，也不是生产额度保证。**费用、商用资格、地区可用性及当前控制台套餐均未核实，不声称免费。** 上线前必须查当前官方价格、服务协议、分类权益和配额，记录确认日期、账号、项目与适用地区。

未来启用直连发送前，必须从可读的当前官方原文重新核实完整 HTTPS URL、项目路径、JWT audience、响应与永久失效 token 错误码，以及分类权益。保存可复核的官方来源和日期，再实现独立 `PushTransport`。不得将本接口的 result 枚举当作官方错误码，不得仅按 HTTP 200 判定成功，不得允许客户端提供任意发送 URL。当前仓库没有生产直连 transport。

## 配对设备 API

所有请求沿用现有 TLS 服务、`Authorization: Bearer <配对令牌>` 和 `X-AMC-Host: <hostId>`。设备主体由 `Store.authenticate()` 决定，不能用 body 指定 deviceId；这与其他已配对 API 的授权范围相同，未新增用户或租户概念。Push Token 不是配对令牌。

| 方法和路径 | 请求 | 成功 data |
| --- | --- | --- |
| `GET /v1/devices/self/push` | 无 body | `{ bound, state, reason? }` |
| `PUT /v1/devices/self/push` | 严格仅 `{ "token": "<Push Token>" }` | `{ bound: true, state, reason? }` |
| `DELETE /v1/devices/self/push` | 无 body | `{ bound: false, state, reason? }` |
| `GET /v1/automation` | 无 body | `{ enabled, roots, scanIntervalSeconds, syncIntervalSeconds, limited, lastSuccessAt?, lastFailureAt?, lastFailureCode? }` |
| `GET /v1/push/status` | 无 body | `{ configured, state }` |

响应仍采用现有 `{ protocolVersion: 1, hostId, data }` envelope。无发送器时 `state: "unconfigured"`；绑定成功不表示可发送、获系统授权或通知送达。失败沿用 envelope 内的 `data.error` 和 HTTP 状态。

- 未配对/已撤销返回 401；host 不匹配返回 409。
- PUT body 限 8192 字节；token 非空、最多 4096 UTF-8 字节，不接受空白和控制字符。长度限制是本地防御边界，不是对官方 token 格式的猜测。
- 每设备一个绑定，全主机最多 100 个；同 token 不得被第二个设备抢占，返回通用 409，不透露已有设备身份或 token。
- 同 token 重复 PUT 幂等，不中断正在发送的请求；轮换原子替换 revision 并取消该设备所有旧 pending/sending 项，不迁移旧通知到新 token。
- DELETE 幂等取消未发项；现有 `Store.revoke(id)` 在同一事务内撤销配对、删除绑定、取消未发项，现有撤销入口无需另加 Push 调用。
- 不在返回值、bootstrap、设备列表、异常信息或日志中返回 Push Token、token hash、私钥、JWT。HTTP 请求体日志也必须关闭或全量脱敏。

已提交给第三方的请求无法撤回。coordinator 处理轮换/解绑时还会中止本实例的 in-flight signal；从其他入口直接 `Store.revoke()` 会立即取消持久任务，不能保证已在网络中的通知停止展示。过期 lease 的旧响应不能修改取消任务，也不能删除轮换后的 token。

## Main 装配

接口签名：

```ts
new PushCoordinator(store: Store, hostId: string, options?: PushOptions)
makeServer(core: Core, tls: ServerOptions, about: { name: string; os: string }, push?: PushCoordinator)
```

`PushOptions` 支持 `transport?`、测试时钟 `now?`、测试随机源 `random?` 及发送前异步授权 `authorize?(session, signal)`。网关启动已经提供严格的目录身份与当前授权复验；未来注入生产 transport 时必须保留该检查。没有生产发送凭据配置项，也没有凭据自动发现。`makeServer` 的第四参数可选，旧调用仍可用，其缺省 coordinator 只提供 fail-closed 绑定 API，不自动启动调度。

集成方应创建并复用同一实例，交给 HTTP 层、external 事务钩子和生命周期管理：

```ts
import { PushCoordinator } from './push.ts';

const push = new PushCoordinator(core.store, core.hostId);
const server = makeServer(core, tls, about, push);
push.start();

async function shutdownPush(): Promise<void> {
  await push.stop();
}
```

先停止并等待自动同步调度器，再 `await push.stop()`，最后关闭 Store。HTTP 服务停止接受请求的时序沿用主机现有关闭流程。不要在 `server.close` 后立即关数据库而不等待 worker；不要将 Push 跟随手机 WebSocket 的连接/断开启动或停止。`stop()` 后同一实例不能再启动，需要新建实例。

`start(): void` 每秒非重入 tick，启动时立即执行一次；`tick(): Promise<void>` 可用于确定性测试及管理触发；`stop(): Promise<void>` 停止调度、中止正在发送的 signal、等待当前 tick。无发送器时 tick 仍可标记过期项，不尝试发送。

`status()` 仅返回安全状态：`unconfigured`、`ready`、`authentication`、`permission`、`stopped` 之一和可选原因。`ready` 只表示注入的 transport 未被阻断，不是官方服务已开通或设备可达的证明。只有主机内可信管理操作可调用 `resume(): void` 清除鉴权/权限阻断，不能从公开匿名 API 自动恢复。数据库 IO 异常会从显式 `tick()` 抛出，定时 tick 不记录异常正文；运维需监控数据库健康和队列积压，不能只监控 ready。

## External 事务钩子

无需修改 Core 事件订阅，也不通过广播事件异步补写通知。准确接口为：

```ts
push.enqueue(sessionId: string, seq: number): number
push.completeBaseline(sessionId: string, complete: boolean): boolean
```

两者都必须在当前 `Store.transaction()` 的同步回调内调用，事务外会返回 409 `push_transaction_required`。`enqueue` 返回新建的设备通知意图数；`completeBaseline` 返回是否首次建立或因 source identity 改变而重建 baseline。`complete: false` 不写 baseline。

若使用 external 同步模块提供的 `notificationIntent` 和 `baselineCompleted` 扩展点，装配如下。两个扩展点都必须由 external 在上述同步事务内执行，不能改成异步通知或事务提交后的 EventEmitter 回调。`silentBaseline` 是同步器的第一层保护，coordinator 自身的 baseline 检查仍然不可省略。

```ts
core.external.notificationIntent = intent => {
  if (!intent.silentBaseline) push.enqueue(intent.session.id, intent.event.seq);
};
core.external.baselineCompleted = session => {
  push.completeBaseline(session.id, true);
};
```

单条新/修订 external 消息的集成形态如下；`key`、`hash` 和 `message` 使用同步器已验证的数据。函数只接收 sessionId 和 seq，通知内容从事务内刚写入的权威 events 表读取，不接受调用方提供通知正文或任意负载。

```ts
const event = store.transaction(() => {
  const previous = store.get<{ hash: string }>('external-message-v1', key);
  if (previous?.hash === hash) return;
  const event = store.event(sessionId, 'message.completed', {
    id: key,
    role: message.role,
    text: message.text
  }, false);
  store.put('external-message-v1', key, { hash });
  push.enqueue(sessionId, event.seq);
  return event;
});
if (event) core.emit('event', event);
```

首次自动完整轮次的所有页必须先保持静默，在最终页提交投影/checkpoint 的同一事务末尾执行：

```ts
store.transaction(() => {
  store.put('external-checkpoint-v1', sessionId, checkpoint);
  push.completeBaseline(sessionId, true);
});
```

如果最终页消息也在该事务内写入，则先按上例逐条 event/hash/enqueue，最后才 completeBaseline。不要嵌套 `Store.transaction()`，也不要在同步事务回调中 await。

**完整轮次的判定是 external 调度器的职责，不能由 Push 猜测。** 只有满足以下条件才传 true：从首页开始、遍历到末页、页/条数/字节/时长预算未耗尽、cursor 无重复或失效、期间 provider/source identity 和授权未变、没有取消或异常，并持有全轮 session/source 串行锁。不能只因某次单页调用没有 cursor 就认定完成；手动分页 observation 不应建立自动 baseline。失败的首次同步和重启重试必须一直静默，直到一次真正完整的自动轮次成功。

baseline 以本机 host/ref 和 externalSource 全字段指纹隔离，并持久化当时 session.watermark。已有手动投影首次进入自动完整同步也走相同静默过程。入队端自身检查 baseline 存在、source 匹配和 `seq > baseline.watermark`；source 改变时旧 baseline 自动失效，worker 也会取消旧身份未发任务，新身份第一次完整同步仍静默。已有匹配 baseline 的后续 completeBaseline 调用不移动 watermark，也不取消已有通知。

只接收本机外部只读投影的 `message.completed`、显式 role=assistant、非空正文；user、reasoning、delta 和 run.updated 不通知，绝不将 idle 或历史 assistant 文本解释为“任务完成”。使用 Store 同一事务才能保证投影、外部哈希、通知意图共同提交或共同回滚。事务后再调用 enqueue 虽可人为另开事务，但破坏原子性，不属于支持的集成方式。

## Outbox 与发送器契约

SQLite 增量新增 `push_bindings`、`push_baselines`、`push_jobs`、`push_intents` 和索引；不删除旧消息，旧程序可忽略新表。稳定幂等键由 device + session + source/message-id/text-version 摘要组成，不含 token。相同内容版本重复同步不会重新入队；不同文本修订可入队，正文只参与摘要，不写入 Push 表。

按设备、绑定 revision、会话进行固定 10 秒聚合，窗口从首条消息开始，不因持续更新无限延后；只合并从未尝试发送的 pending 项。重试保持同一 notificationId；新 revision 的消息不加入已经发送/重试中的聚合。默认本地有效期 1 小时，重启仍有效，过期项不发送。单实例串行发送，每轮最多领取 100 项；SQLite lease 为 30 秒，超时恢复后可重试。

可信主机代码可注入如下 transport；当前测试使用模拟实现，不是生产发送：

```ts
interface PushTransport {
  send(token: string, notice: PushNotice, signal: AbortSignal): Promise<PushResult>;
}
type PushResult = 'accepted' | 'retry' | 'invalid_token' | 'permission' | 'authentication' | 'permanent';
```

`PushNotice` 字段为 `hostId`、`sessionId`、`eventId`、`notificationId`、`title`、`body`、`ttlSeconds`。标题固定“AI 会话有更新”，正文固定“打开应用查看最新内容”；标识必须是现有不透明主机/会话 ID 和事件摘要。严禁加入真实会话标题、文件路径、消息正文、模型思考、配对令牌、Push Token 或服务账号材料。Push Token 只通过 send 的独立参数给可信发送器，不能放入点击参数。

未来官方发送器须匹配客户端的 `payload.notification.clickAction` 契约：`actionType: 1`、`action: "com.zondaxu.aimaidcafe.NOTIFICATION"`、`uri: "aimaidcafe://notification?hostId=HOST_ID&sessionId=SESSION_ID"`。两个 ID 仅接受 `[A-Za-z0-9_-]{1,200}`；不得加入正文、路径、token、额外参数或命令。按官方类别权益配置 category、testMessage、有效期和稳定消息标识；点击参数不是认证授权，客户端必须恢复配对并认证获取快照后定位。详见 `apps/harmony/AUTOMATION_PUSH.md`。当前不存在完整核实的云侧请求映射或实际发送实现，不可把内部 PushNotice 直接当官方请求 body。

| 结果 | 行为 |
| --- | --- |
| accepted | 仅记云侧接受，不声称送达、展示或点击。 |
| retry / 抛异常 / 10 秒超时 | signal 中止，指数退避带 0.5–1 倍抖动，最大退避 5 分钟，最多 10 次尝试，过期优先。异常正文不保存、不输出。 |
| invalid_token | 仅删除该任务绑定 revision，取消同 revision 未发项；不会误删轮换后的 token。 |
| authentication / permission | 记录可见运维阻断状态并暂停本实例后续发送，修复凭据/权益后由管理员 resume；重启会重新尝试，不是永久禁用配置。 |
| permanent | 该任务标为 failed，不再重试。 |

transport 必须遵守 AbortSignal 和请求超时，拒绝重定向/非官方目标，限制响应体大小，按已核实官方业务码分类，不能记录原始响应/请求。coordinator 会在 10 秒后停止等待，即使第三方错误地忽略 signal 也不能无限占用 tick；但忽略 signal 的第三方仍可能实际发送，因此不符合生产接入条件。第三方接受后、SQLite 标记前崩溃可能重复发送，不能承诺端到端 exactly-once。

## 开通与签名

1. 用户在华为开发者平台完成所需身份和协议，在 AppGallery Connect 创建对应项目和 HarmonyOS 应用，核实目标分发方式、所在地区、设备支持和 Push 商用资格。客户端既有 bundleName 为 `com.zondaxu.aimaidcafe`，不得拿 Android 应用的 APP ID 顶替。
2. 在正确项目开通 Push 服务，按当前通知分类标准申请合适的自分类权益；不能为提高频率擅自伪装成 IM/通话。调试阶段显式使用测试消息并登记测试设备。费用和生产配额需另外核实。
3. 按当前官方控制台和 DevEco 要求配置调试/发布签名、证书、profile、项目/APP 身份和所要求的证书指纹/客户端服务文件，确认客户端身份和项目一致。已读指南包含手动签名要求及新版本自动签名说明，需按实际 DevEco/SDK 和分发渠道复核，不宣称任意自动签名已满足 Push 开通。
4. 在 API Console 为该项目申请推送服务 API 的服务账号密钥，project_id 与应用项目一致。只在主机上保存私钥。不要在聊天中粘贴任何密钥、JWT、配对令牌或 Push Token。
5. 取得完整可读官方 URL、audience 和响应码文档，完成发送器实现和审查；在此之前当前代码持续 unconfigured，提供凭据也不能解锁。
6. 真机安装与项目匹配的签名包；客户端请求通知授权并获取 Push Token，用户明确为该已配对主机启用绑定。轮换后重新 PUT，取消配对前 DELETE；主机撤销配对会兜底清除绑定。
7. 验证主机出站 HTTPS、DNS、系统时间和服务端访问权限；无需为此将私有 gateway 暴露公网，也无需新增中继或隧道。本实现不包含公网回执接收服务。

## 配置与运维

- 在已有主机配置中显式添加下面的 `automation` 配置后重启网关；不要为启用自动化重新运行初始化覆盖主机身份。新主机初始化可以使用 `--enable-automation`。桌面配置保存会保留 automation 和其他既有配置字段。

```json
{
  "automation": {
    "enabled": true,
    "scanIntervalSeconds": 60,
    "syncIntervalSeconds": 15,
    "excludedDirectoryNames": []
  }
}
```

- `allowedWorkspaceRoots` 必须指向已明确授权的项目容器；自动发现只检查它们的一级真实子目录，不登记容器自身、不递归、不跟随链接/junction。标记包括 `.git`、`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`pom.xml`、Gradle 清单和 `oh-package.json5`；只看标记类型，不执行项目脚本。已有父工作区与子项目冲突时保留原记录并报告，不自动删除或拆分。
- 自动化会读取授权项目对应的 Codex / DSH 历史，并可能启动 Codex app-server；只读不代表不启动原生查询服务。精确版本和来源验证仍然生效，不支持的运行时会暂停并报告状态。手机关闭或退后台不停止主机同步；主机本身必须持续在线。
- 自动登记会固定授权根与项目目录的设备号、inode 和创建时间，同路径目录替换不会继承旧项目身份。旧手动工作区自动同步前须在主机显式确认，详见 `docs/workspace-identity-confirmation.md`；不要通过删除指纹绕过检查。失败候选独立退避，正常会话继续同步，取消排队不会跳过同会话的前序读。
- 当前安全默认配置就是省略 transport；不需要凭据即可运行同步、绑定和持久 outbox。旧配置默认关闭，不得因 Push 自动读取更多项目历史。客户端设置中需按主机显式开启通知，绑定成功仍不代表官方发送器存在。
- 密钥文件放在源码、构建产物、客户端资源和共享目录之外；未来配置仅引用安全文件路径或秘密管理器，不把私钥/JWT 放入可导出的普通主机配置。环境引用也需限制进程继承和诊断导出；当前实现不消费任何 Push 环境变量。
- Windows 对密钥和数据库所在目录使用当前服务账号专有 NTFS ACL，移除不必要继承和普通用户读取权限，可用 Windows Credential Manager/DPAPI 保护凭据并由未来发送器解密。不能把 chmod 当 Windows ACL 保护。POSIX 目录建议 0700、秘密文件 0600，核实运行服务账号与备份权限。
- 数据库包含必须可取回的 Push Token，目前没有应用层加密；必须连同 SQLite `-wal`/`-shm`、备份、故障转储和主机数据目录一起限制访问，按需使用磁盘加密。不要输出整个 push_bindings、objects 或请求体排障。
- 监控按 status 聚合的任务数、最早 pending 时间、attempts、expired/failed 增长、数据库空间和 host 在线状态。可运行 `SELECT status,count(*),min(created),max(attempts) FROM push_jobs GROUP BY status;`，不要选择 token 字段。无人值守主机必须持续运行；休眠、断网、原生服务退出或版本不受支持都会阻断同步。
- 当前保留终态 jobs 与 push_intents 作为持久内容版本去重账本，没有自动清理，需监控增长、规划容量和安全备份；不能直接删 job 而留下外键 intents，也不能删除去重账本后声称历史重放仍不会通知。大规模保留/归档策略需另行设计并测试。
- 关闭前先停止同步，再停止发送器；回滚/禁用时逐设备 DELETE 或在事务内调用 `store.clearPush(deviceId)` 取消绑定和未发项，保留工作区与历史。清理后允许旧代码忽略增量表，不能覆盖其他任务的数据库或源码修改。
- 凭据泄露立即在官方控制台撤销并更换，撤销受影响设备，保护备份并排查日志；不能靠代码回退继续使用旧密钥。绑定 API 返回安全状态不等于服务器数据目录已安全配置。

## 验收与外部依赖

模拟测试覆盖：强制事务、首次及失败 baseline 静默、旧手动投影相同基线流程、assistant 过滤、内容版本去重、原子回滚、固定窗口聚合、按设备隔离、数量/长度限制、token 轮换和撤销、过期、持久重启/lease 恢复、重试耗尽、超时中止、失效 token、鉴权/权限阻断、source 更换、HTTPS 原鉴权主体与敏感字段不返回。它们不证明官方云侧连接或真机通知。

运行环境要求 Node `>=24.13.0 <25`；默认 DevEco PATH 的 Node 18 不支持原生 `.ts`/SQLite。测试中的 HTTPS 临时证书还依赖 OpenSSL；Windows 本机验证使用系统 Node 24 和 Git 自带 OpenSSL，不修改项目运行时要求。

```powershell
$env:PATH = "C:\Program Files\Git\usr\bin;" + $env:PATH
& "C:\Program Files\nodejs\node.exe" --test tests/gateway/push.test.ts tests/gateway/transport.test.ts tests/gateway/core.test.ts tests/gateway/external-import.test.ts
npm run typecheck
```

验证应执行完整 `npm test`、`npm run typecheck`、`npm run check:source` 和 `npm run check:assets`；Harmony 修改需通过 `arkts_check` 和真实构建。默认 Node 18 不支持仓库原生 `.ts` 测试，应临时将已安装的 Node 24 与 Git OpenSSL 置于当前命令 PATH 首位，不修改系统配置。模拟与构建通过均不能替代官方云侧/真机通知验收。

2026-11-13 本地统一复验：182/182 测试通过，typecheck、source 和 assets 检查通过；六个新增或修改的 ArkTS 文件检查无错误，Harmony `entry@default` debug 构建成功，并在现有 Pura 90 / HarmonyOS 6.1.1(24) 模拟器安装启动成功。未执行 UI 自动走查、官方 Push 云侧发送或真机后台通知测试。构建提示未配置 signingConfig，模拟器启动成功不代表已满足正式签名和 Push 身份要求。

生产验收外部阻塞项：完整官方 URL/audience/业务错误码和费用确认、开发者项目及 Push 权益、调试/发布签名、服务账号材料、正式发送器及支持的真机。Harmony token/授权/点击处理和 main/external 接线已经实现，但仍需官方端到端验证。外部条件未完成前报告“自动登记、同步、队列与客户端已实现，官方发送器尚未实现，真机后台通知未验收”。

验收需分别记录前台、后台、锁屏、系统回收后的发送与展示；冷启动/热启动点击认证定位；断网恢复后读取权威快照；撤销/解绑/轮换后不再提交旧绑定；首次历史导入和首次失败重试无通知；已知/未知/过期 host/session 安全降级。强制停止、系统频控和拒绝通知授权单独记录，不承诺必达。确认 Push 只是提醒，不替代前台快照补偿、不新增后台 WebSocket/音频/定位保活、不因手机退后台停止主机同步。
