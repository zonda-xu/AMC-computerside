# Desktop Runtime Handoff

## Scope

Desktop implementation follows the root four-platform offline plan dated 2026-11-16. No adapter, gateway, protocol, Harmony or push implementation was edited for this task.

The desktop admin API uses `/v2`, with no `/api` fallback. Pairing QR payloads use `protocolVersion: 2`; gateway verification requires `/v2/hello`, protocol 2, the configured TLS CA and matching envelope/data host IDs. Existing host identity, CA, paired devices, SQLite data, native environment, executable/module paths, model configuration and disabled-runtime settings are retained. `HostConfig.push` uses the gateway's `HuaweiPushConfig` type, and existing `serviceAccountFile`, `category` and `testMessage` settings round-trip without requiring browser input. Push service-account content is never loaded into browser state. Existing three-host EasyTier addresses and forwarding ports are unchanged.

## Integration Interface

`apps/desktop/src/runtime.ts` exports `RuntimeManager`, `ManagedRuntimeConfig`, `RuntimeRegistration`, `RuntimeStatus`, `runtimeVersions` and `codexEndpoint`.

```ts
const manager = new RuntimeManager(config.dataDir);
const status = await manager.probe('codex', config.runtimes.codex);
const connection = await manager.connect('codex', config.runtimes.codex);
```

`probe(engine, config)` never starts, replaces or stops a native service, and never writes a registration. It checks the CLI version and connects only to an existing service. Authentication/model/task capabilities remain the adapter's responsibility; a connected service is not proof of those capabilities.

`connect(engine, config)` is also non-starting. It requires a matching persisted registration, returning `runtimeInstanceId`, `generation`, `endpoint`, `version`, `identity`, optional `pid`, and host-only `headers`. Gateway lifecycle assembly can use these values to establish adapter contexts/bindings. Do not return `headers` or the complete connection to the phone. Gateway main/context assembly is owned by the other agent and is not changed here.

`start(engine, config)` is exclusively a host lifecycle operation. Desktop exposes it through the authenticated `POST /v2/runtime/start` endpoint with `{ "engine": "codex" }` or `{ "engine": "opencode" }`. Starting the gateway or reading desktop state does not call this method. Hosts starting from another management entry point may call it explicitly; ordinary bootstrap/session/probe handlers must not.

Registrations are stored as `<dataDir>/codex.runtime.json` and `<dataDir>/opencode.runtime.json`, using private atomic writes and per-engine exclusive startup locks. A stale lock fails closed and requires host inspection, not automatic replacement. IDs/generations survive gateway/desktop reconnects. Changing native service identity requires explicit registration and advances the generation. OpenCode authentication headers are hashed for identity comparison, not stored in the registration or returned in desktop state.

## Lifecycle Rules

Codex requires exactly `codex-cli 0.169.0` and uses `codex app-server --listen ws://127.0.0.1:8897`. Explicit startup checks port occupancy, launches detached, records its PID/identity and performs `initialize` then `initialized`. An occupied unregistered port is rejected, not adopted or killed. An existing registered live process with a failed handshake is retained and never restarted. A newly launched process that fails its handshake remains recorded for inspection. A later explicit start may launch again only after its registered PID is gone. There is no native kill/stop method in this manager. Desktop CLI sharing command: `codex --remote ws://127.0.0.1:8897`.

OpenCode requires CLI and client 2.3.0. It loads only the locally installed `@opencode/client/service`, and uses `Service.discover()` plus `Service.headers()`. Existing services are registered/reused without `ensure()`. Failed discovery never calls `ensure()` in a probe or connection read. Even explicit startup refuses replacement if an earlier project registration exists, or if a native service registration exists but is incompatible/unresponsive.

For first-time explicit OpenCode startup only, `serviceRegistrationFile` must be configured as the verified absolute path of the native 2.3.0 service registration file. Missing configuration blocks startup. A present or unreadable native registration blocks startup. Only a confirmed absent file permits `ensure()`, and only with the standard `opencode` command. The actual native registration path/format and ensure contract could not be tested without the target package; do not guess a path or pass an arbitrary nonexistent file. Simultaneous native startup by unrelated tools remains outside the project lock and requires target-version native validation.

## Offline Dependencies

Actual test runtime: cached Node `24.13.0` at `C:\Users\lenovo\AppData\Local\npm-cache\_npx\cee224165f95995d\node_modules\node\bin\node.exe`. Default PATH and the DevEco bundled Node are `18.20.1`, outside the project engine range. No package installation or network fetch was performed.

| Requirement | Local Evidence | Result |
| --- | --- | --- |
| Codex 0.169.0 | Installed `codex --version` returns `codex-cli 0.167.1` | Version mismatch; shared native startup/control validation blocked |
| Claude Agent SDK 0.3.325 | Absent from project node_modules and inspected npm cache listing | Local dependency not provided |
| Claude Code 2.1.325 | No `claude` command on PATH | Local executable not provided |
| OpenCode client 2.3.0 | Absent from project node_modules and inspected npm cache listing | Local dependency not provided |
| OpenCode CLI 2.3.0 | No `opencode` command; target package absent from inspected npm cache listing | Local dependency not provided |
| `@anthropic-ai/sdk >=0.93.0` | No package entry in inspected npm cache listing | Concrete peer version cannot be resolved offline |
| `@modelcontextprotocol/sdk ^1.29.0` | npm cache lists tarball 1.30.0 | Candidate only; target SDK dependency closure not resolved |
| `zod ^4.0.0` | npm cache lists tarballs 4.1.8 and 4.5.4 | Candidates only; target SDK dependency closure not resolved |

Inspected pnpm-cache filename searches also found no Claude/OpenCode artifacts; this is not a claim that every opaque cache on the machine was decoded. Cached legacy `@opencode-ai/sdk`/`plugin` 1.17.9 are not substitutes for the required `@opencode/client`/`cli` 2.3.0.

The existing root manifest direct dependencies and lockfile remain at their existing exact versions. Only desktop verification scripts were added to `package.json`. Required new SDK/CLI/peer dependency installation and lockfile pinning are **blocked**, not completed. `package-lock.json` was deliberately not populated with invented package records, transitive dependencies or integrity metadata from the plan. Provide the actual target package archives and their dependency closure before producing a new offline-resolved lockfile.

## Verification

Use Node 24.13.0 or another locally supplied Node satisfying the root engine range.

```text
node node_modules/typescript/bin/tsc --noEmit -p apps/desktop/tsconfig.json
node --test tests/desktop/*.test.ts
node --check apps/desktop/public/app.js
node scripts/check-source.mjs
```

Desktop tests include real local TLS pairing/QR redemption, expired-ticket replacement, device revocation, configuration identity/data preservation, loopback WebSocket initialize/initialized, synthetic runtime registration/reconnect, no-start read probes, incompatible/unknown OpenCode registration refusal, explicit first-start ensure and concurrent-start locking. Synthetic runtime tests do not demonstrate native model execution or desktop/mobile control of a real Codex turn.

Full repository typecheck initially reported old adapter test references under `tests/contracts/`, outside this task's ownership. The latest full repository typecheck passes after concurrent agent updates. Desktop-only typecheck, browser JavaScript syntax and source checks pass. Desktop tests pass 15/15, including push-configuration round-trip coverage. No target-native Codex/OpenCode/Claude control, real model task, public-network or Harmony device validation is claimed.
