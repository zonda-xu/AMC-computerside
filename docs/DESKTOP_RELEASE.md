# AMC 电脑连接助手 v1.0.1

Windows、macOS 和 Linux 网关现按本机 AI 程序提供的原生接口判断兼容性。旧配置中的版本记录可以继续使用，只有显式选择 `compatibilityMode: "pinned"` 才会锁定版本。

- Codex 通过共享 app-server 握手，分别检测会话历史、模型目录和控制接口。支持从授权项目打开原会话继续点单，也可以另建会话。本机已用 Windows CLI 0.167.1 和 0.145.0 验证这些操作，测试回复由本机模型模拟服务提供。
- Claude Code 和 OpenCode 改为检查官方 SDK 或会话服务所需的接口。DeepSeek Harness 继续按同宿主控制器的能力接入。
- 连接助手会指出被占用的端口或失效的本机 IP。启用 DeepSeek Harness 时才启动 8898 桥接监听。

## 下载与升级

1. 下载与你的系统对应的 Windows、macOS 或 Linux ZIP。可用同一发布页的 `SHA256SUMS.txt` 核对下载文件。
2. 在旧助手中停止网关并退出。将新包完整解压到新目录，保留原来的配置和 `~/.ai-maid-cafe/desktop` 数据目录，以便沿用主机身份、配对记录和会话。
3. Windows 运行 `Start-Windows.cmd`，macOS 运行 `Start-macOS.command`，Linux 运行 `./Start-Linux.sh`。启动器会打开新的本机管理地址。首次使用请在助手中保存本机地址、授权项目和 AI 平台，再启动网关。三端均需要 Node.js 24.13 或更高的 24.x 版本、OpenSSL 和所用 AI 程序。
