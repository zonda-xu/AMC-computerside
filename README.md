# AMC 电脑连接助手与主机网关

AI Maid Café 的主机端源码，支持 Windows、macOS 和 Linux。手机端及独立特效 Demo 位于 [AI-Maid-Caf-](https://github.com/zonda-xu/AI-Maid-Caf-)。

本仓库包含电脑连接向导、HTTPS/WSS 网关、SQLite 持久化、四引擎适配器和 DeepSeek Harness 宿主桥接插件，不包含手机工程、人物素材、个人主机配置或密钥。

## 从源码运行

需要 Node.js 24.13+（24.x）、OpenSSL，以及自行安装并登录的 AI 平台。SDK 和原生工具依赖应按 [运行时交接](apps/desktop/RUNTIME_HANDOFF.md) 配置；根 npm 依赖不会替代官方原生程序。

```sh
npm ci --ignore-scripts
npm start
```

浏览器打开仅绑定 `127.0.0.1` 的电脑向导：选择网络、授权工作区及 AI 平台，启动网关，再用手机扫码配对。连接信息、证书和 SQLite 保存在当前用户目录的 `.ai-maid-cafe/desktop`，再次启动继续使用原身份。

再次启动时，如果已有助手在运行，当前启动器会请你选择关闭旧助手并切换，或保留旧助手并退出。切换会沿用主机身份，并尝试恢复之前运行中的手机网关。

已有主机配置可直接运行：

```sh
npm run gateway -- /absolute/private/host.config.json
npm run pair -- --config /absolute/private/host.config.json --out pairing-device.png
```

首次命令行初始化步骤见 [HOST_SETUP](docs/HOST_SETUP.md)。升级时保留现有配置、数据库、CA、配对记录及桥接密钥。

## 原生接入

| 平台 | 接入方式 |
| --- | --- |
| Codex | 官方 app-server WebSocket、模型目录、会话及运行控制；支持原生线程模型设置和确认 |
| Claude Code | 官方 Agent SDK 持久 Query、模型目录、任务事件与交互 |
| OpenCode | v2 HTTP/SSE、模型目录和原生会话控制 |
| DeepSeek Harness | 在同一宿主加载 Cordis 插件，通过 sessionController 管理原生会话 |

四个平台默认按原生接口接入。Codex 握手成功后单独检测会话列表、模型目录和控制接口。旧配置中的 `expectedVersion` 只在显式选择 `compatibilityMode: "pinned"` 时锁定版本。模型、附件、审批、问答、slash/steer 等能力以宿主实际支持为准。详情见 [DSH 接入说明](docs/DSH_INTEGRATION_2026-11-17.md)。

网关和手机共同使用协议 v2。会话身份、运行代次、幂等命令、水位恢复、工作区授权及 SQLite 持久化继续有效；切换手机页面或平台不会自动取消其他任务。EasyTier 仅提供网络互通，配对与访问仍使用受信任的 TLS。

## 检查与打包

```sh
npm test
npm run typecheck
npm run typecheck:desktop
npm run check:source
npm run package:desktop
```

`package:desktop` 在 `dist/desktop/` 生成三系统 ZIP 和 SHA-256 清单。基础包包含 JavaScript 管理依赖，不捆绑 Node.js、OpenSSL 或已登录的原生 AI 程序。`npm run check:offline` 可检查另行准备的离线依赖是否完整；缺少原生依赖时失败是预期行为。

源码上传不改变已发布安装包。历史下载位于 [Releases](https://github.com/zonda-xu/AMC-computerside/releases)，使用前核对对应版本说明。

## 文档

- [电脑助手操作指南](docs/DESKTOP_GUIDE.md)
- [协议](docs/PROTOCOL.md)
- [四平台离线部署](docs/FOUR_PLATFORM_OFFLINE.md)
- [EasyTier 网络](docs/EASYTIER.md)
- [工作区发现与会话同步](docs/automatic-sync-and-push.md)
- [Harmony Push V3](docs/HARMONY_PUSH_V3.md)

Windows 上已进行 Codex 和 DSH 真实任务联调；macOS/Linux 原生操作、其他平台及签名真机推送仍须在对应环境验收。自动测试通过不代表所有平台都已完成真实任务验收。
