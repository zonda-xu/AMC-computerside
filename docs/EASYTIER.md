# 独立 App 网络

本仓只提供配置生成，未连接或部署用户 VPS。现有 `cailab-easytier-relay`、`cailab-personal`、TCP 11010 和 `10.88.88.0/24` 均不由代码修改。

1. 在 VPS 只读检查 12080、18541、18542、18543 的占用及 10.89.90.0/24 的冲突，记录原服务和默认路由基线。
2. 使用新的 `/opt/agent-console-easytier/` 目录和 Compose project。
3. 为 App 网络独立生成 256 位随机密钥。不要沿用个人网络密钥，也不打印到日志。
4. 以 `profile.example.json` 为样本，替换受控域名与三个真实 hostId。
5. 设置私有环境变量 `ET_NETWORK_SECRET`，运行：

```bash
node deploy/easytier/render.mjs deploy/easytier/profile.example.json data/easytier
```

生成的 TOML 包含密钥，权限 0600，不进入 Git。把 Compose 文件和 TOML 放入新的部署目录。`ET_IMAGE` 必须填入实测 EasyTier 2.6.4 镜像的固定 digest；代码没有填写未经核实的镜像 digest，也不使用 `latest`。

VPS 使用 no-TUN / Docker Bridge，12080 只接收 App mesh 节点，三条 `[[port_forward]]` 规则透明转发 TCP，不终止应用 TLS。手机不加入 mesh、不请求 VPN 权限。三个目标主机需按实际系统安装 EasyTier 并加入新网络，分别取得 `.2/.3/.4` 地址。

生成器只校验计划中的独立配置，不能代替 VPS 端口、网段、镜像参数和主机防火墙实测。部署后按 [验收清单](VALIDATION.md) 检查公网 HTTPS/WSS、故障隔离，以及 WordPress、2FAuth、校园网、aTrust 和 WSL 的既有连通性。
