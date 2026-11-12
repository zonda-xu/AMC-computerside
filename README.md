# AMC 电脑连接助手

Windows、macOS 和 Linux 的独立电脑端工具，让 HarmonyOS 上的 AI Maid Café 通过受信任的加密连接管理本机 AI 编程终端。

## 下载与使用

从 [Releases](https://github.com/zonda-xu/AMC-computerside/releases) 下载对应系统的 ZIP，完整解压后打开 `START-HERE.html`。

| 系统 | 启动入口 |
|---|---|
| Windows | `Start-Windows.cmd` |
| macOS | `Start-macOS.command` |
| Linux | `Start-Linux.sh` |

需要 Node.js 24.13+（24.x）和 OpenSSL；AI 程序需自行安装并完成官方登录。包内已包含 JavaScript 运行依赖，无需 npm install。包体不包含 HarmonyOS 项目、手机素材或任何个人凭据。

## 五步连接

1. 检测运行环境与网卡。
2. 选择同一 Wi-Fi 或 EasyTier 远程中转。
3. 选择项目目录和 AI 程序，检测并固定完整版本。
4. 启动网关，让手机扫码；也可导出二维码 PNG 或配对 JSON。
5. 检查已配对设备，按指引发起首次真实任务。

支持 Codex app-server、Claude Code stream-json、OpenCode ACP 和 DeepSeek Harness 本机桥接。此工具通过原生协议管理会话，不接管任意现有终端窗口。程序版本检测和配对成功均不代替真实 AI 任务验收。

## 本地开发

```sh
npm ci --ignore-scripts
npm start
npm test
npm run typecheck
npm run check:source
npm run package:desktop
```

产物在 `dist/desktop/<时间戳>/`，包含三个 ZIP 和 SHA-256 清单。GitHub Actions 在三个系统运行测试；通过后为 main 上的新版本创建 Release，已有同名版本不会被覆盖。修改版本号后推送可发布新版本。

## 说明

- [使用与排查](docs/DESKTOP_GUIDE.md)
- [验证记录与限制](docs/DESKTOP_VALIDATION.md)
- [发布说明](docs/DESKTOP_RELEASE.md)
- [原 CLI 接入与 DSH 插件](docs/HOST_SETUP.md)
- [独立 EasyTier 网络](docs/EASYTIER.md)
- [协议说明](docs/PROTOCOL.md)

电脑身份、证书和设备记录保存在当前用户的 `.ai-maid-cafe/desktop`，再次启动可复用。只分发原始工具包，不要复制该私有数据目录。局域网访问和远程中转均保留 TLS 验证。本机管理界面仅绑定 127.0.0.1，使用每次启动生成的随机管理凭据。
