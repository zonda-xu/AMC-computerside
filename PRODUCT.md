# AI Maid Café 电脑连接助手

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

拥有 Windows、macOS 或 Linux 电脑、希望用 HarmonyOS 手机控制本机 AI 编程终端的受信任用户。电脑部署不应要求复制手机工程。

## Product Purpose

通过每个系统的独立工具包，在本机浏览器逐步完成环境检测、网络选择、AI 程序与目录设置、一次性配对和首次任务验证。

## Capabilities and Constraints

用户已确认采用轻量的本机浏览器向导。复用既有 Node.js 24 网关、TLS、一次性票据与四个平台适配器。保留原有 CLI。向导只在回环地址运行，网关监听选定的私有地址。远程模式沿用 EasyTier 的固定独立网络，不自动部署服务器。手机的既有交互和协议不在此次修改范围。

## Evidence on Hand

apps/gateway、packages/adapters、docs/HOST_SETUP.md、docs/EASYTIER.md、手机主题 apps/harmony/entry/src/main/ets/theme/DesignTokens.ets。当前环境是 Windows；其他系统需要实机运行验收。

## Product Principles

按顺序指导；实际检测后再显示成功；电脑身份各自独立；配置更新保留信任身份；分发只包含电脑端必需文件。
