# HarmonyOS Push V3 主机配置

在现有主机配置中增加 `push`，账号仅存放在主机受限目录，不能放入安装包或提交仓库：

```json
{
  "push": {
    "serviceAccountFile": "/private/ai-maid-cafe/push-service-account.json",
    "category": "WORK",
    "testMessage": true
  }
}
```

`category` 必须替换为应用实际获批的通知分类；示例不代表分类权益已开通。生产发送前按项目实际配置关闭 `testMessage`。Windows 使用主机上绝对文件路径。账号 JSON 必须包含 `key_id`、`sub_account`、完整 PEM `private_key`、`project_id`，文件读取或私钥格式错误会明确阻止启动，不静默使用其他凭据。

网关本地签发 PS256 JWT，直接调用官方 V3 发送端点，不执行 OAuth 换取令牌。没有 `push` 配置时队列保留为未配置状态，不发送请求；过期通知按有效期清理。

## 触发与定位

- 当前运行的明确 `completed`、`failed`、`cancelled` 终态及原生待处理交互触发通知；token 增量和历史 assistant 消息不触发。
- Store 事件、投影和通知意图在同一 SQLite 事务写入。终态按运行、交互按交互 ID 去重。
- 每个配对设备独立发送，通知只携带主机、会话、事件和可选交互定位，不包含命令、路径、模型输出或任何授权令牌。
- 点击只定位，手机仍需认证、同步会话并核对待处理状态；通知不能直接批准。
- 配对撤销、token 轮换、运行时代次改变、交互已处理后，未发送通知会取消；晚到的旧 token 结果不能删除新绑定。

## 审计与故障

`push_jobs.status=accepted` 仅表示服务接受请求，不表示设备收到或系统展示。脱敏的提供方 `code`、`requestId` 和结果保存在 `objects` 的 `push-provider-result` 记录中；不保存 JWT 或请求正文。

JWT 过期重新签发一次；网络故障、服务 5xx 和调试限流进入最多十次退避重试。鉴权或分类权限错误阻止继续无效发送，需运维修正后重启网关。未知/参数错误明确失败。`80300007` 不被猜测为 token 失效，避免误删绑定。

## 验证边界

`tests/gateway/push.test.ts` 验证签名、传输报文、去重、撤销、轮换、过期与恢复逻辑，使用合成账号和模拟 HTTP 响应。它不证明真实服务账号、项目权限、通知分类、手机签名或真机推送可用。

正式验收必须分别保存网关通知意图、提供方接受回执、真机锁屏展示与点击恢复证据。主机服务账号、应用权益和真机未提供时，此项应记录“未验收”，不能标通过。
