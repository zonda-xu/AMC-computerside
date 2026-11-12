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
