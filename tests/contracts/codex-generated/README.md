# Codex 协议依据

本目录 JSON Schema 来自源码环境中的 `codex-cli 0.167.0-alpha.4`，使用官方 `codex app-server generate-json-schema` 生成。该操作生成协议定义，没有编译 App 或执行编程任务。

这些文件用于审阅初始化、审批选项和用户问题字段。它们不代表在 Windows/macOS/Linux 三种用户主机上均已通过真实任务验收；正式部署仍需固定本机版本并运行完整契约及 E2E 用例。

## Exact alpha.4.1 External History Evidence

`alpha4.1/` contains verbatim upstream JSON schemas for thread/list, thread/read and thread/turns/list, from commit `d2c035639366e0bf2c316aa2065c24aabc12bcdc`, tag `rust-v0.167.0-alpha.4.1`. The npm provenance statement for `@openai/codex@0.167.0-alpha.4.1` names this exact gitCommit. The existing alpha.4 initialization/approval schemas above are not used as evidence of alpha.4.1 history compatibility.

Source: `https://github.com/openai/codex/tree/d2c035639366e0bf2c316aa2065c24aabc12bcdc/codex-rs/app-server-protocol/schema/json/v2`.
Provenance: `https://registry.npmjs.org/-/npm/v1/attestations/@openai%2fcodex@0.167.0-alpha.4.1`.
Regenerate public metadata only with `node --use-env-proxy scripts/fetch-native-evidence.mjs`. Contract tests validate actual provider read parameters and text/summary turn mapping against these schemas. Tests are synthetic and do not assert Mac binary execution or native task acceptance.
