Windows / macOS / Linux 独立电脑连接助手首发。

- 本机浏览器五步向导：环境检查、网络选择、AI 程序与项目目录、扫码配对、首次任务。
- 同一 Wi-Fi 直接连接；可生成原独立 EasyTier 网络的主机和中转配置。
- 自动保存完整原生程序版本，生成独立 TLS 身份，管理网关启停。
- 二维码与 JSON 配对，120 秒有效且单次使用；支持大图扫码、入口检测和设备撤销。
- 三个包只包含电脑端必需代码与 JavaScript 依赖，不含 HarmonyOS、人物素材和任何个人配置。

使用方式：下载对应系统的 ZIP → 完整解压 → 打开 START-HERE.html → 运行本系统启动入口。

需要先安装 **Node.js 24.13+（24.x）、OpenSSL，以及自己的 AI 程序**。运行包不需要 npm install。macOS / Linux 可能需要为启动脚本添加执行权限。

Windows 本机已验证向导、真实 TLS 配对、设备撤销和网关重启。自动测试不代表 HarmonyOS 真机、真实 AI 账号会话或用户 VPS 网络已经验收。三个操作系统的自动测试结果见本版本关联的 GitHub Actions 运行。macOS / Linux 图形桌面的启动与真实手机扫码仍需目标机器确认。

分发包 SHA-256 校验值见附带的 SHA256SUMS.txt。包未提供原生系统签名安装程序，也不捆绑 Node.js / OpenSSL。
