# Runtime Compatibility Policy

The user's automatic tracking choice is represented by `latest-compatible`, the default policy in `packages/protocol/src/compatibility.ts`. Automatic tracking means evaluating locally available newer runtimes against required protocol evidence. It does **not** mean blindly upgrading processes, trusting a release number, or promising compatibility with future versions.

This module is a reusable, pure policy layer. It performs no network requests, package installation, native execution, process replacement, authentication, or cloud-provider calls. Its tests use synthetic evidence, not native verification. No existing adapter or gateway is changed by these three new files; the native/main agent must integrate the policy before behavior changes.

## Profiles

| Engine | Required component baselines | Profile ID |
| --- | --- | --- |
| Codex | CLI `0.169.0` | `codex-app-server-0.169.0` |
| Claude Code | SDK `0.3.325`, CLI `2.1.325` | `claude-sdk-0.3.325-cli-2.1.325` |
| OpenCode | Client `2.3.0`, CLI `2.3.0` | `opencode-client-cli-2.3.0` |
| DeepSeek Harness | Controller `0.2.1-rc.5` | `dsh-controller-0.2.1-rc.5` |

These are protocol profile baselines from the plan, not claims that those releases have been verified on this machine. Every required component must be reported independently. A CLI version is not evidence of its SDK/client version. The descriptor's `version` denotes CLI for Codex, Claude and OpenCode, and controller for DSH. If an explicit primary component version disagrees with it, assessment fails closed.

## Version Policy

- `latest-compatible`: every required installed component must be at least its profile baseline. Equal versions only set `permittedToProbe`. Newer versions, including arbitrary major changes and higher-version prereleases, are candidates requiring protocol evidence, not automatically supported versions.
- `pinned`: all of the above checks still apply, and every component must match an explicitly supplied target. `configurationId` must be nonempty and exactly match the descriptor. Missing targets fail closed. A newer release may be explicitly pinned, but still needs protocol evidence.
- `candidate` is true only for an eligible combination with at least one newer-than-baseline component. It is false for an exact baseline or a blocked combination. Component assessments also expose the individual decisions.
- Invalid/missing/older versions fail closed even when supplied evidence claims success. Pinned mode cannot override a baseline with an older release.
- SemVer ordering includes numeric prerelease identifiers (`rc.10` is newer than `rc.5`); a release is newer than its prereleases. DSH `0.2.1-rc.4` is too old; `0.2.1-rc.6` and `0.2.1` are candidates. `0.169.0-rc.1` is below the Codex stable baseline.
- Build metadata does not affect ordering but does participate in exact pin and evidence identity matching. Native labels are normalized, so `codex-cli 0.169.0` and `0.169.0` identify the same version.

The parser accepts full three-part SemVer, optional `v`, supported native command prefixes, and Claude's ` (Claude Code)` suffix. It rejects arbitrary text containing a version, leading-zero numeric identifiers, malformed prereleases, and core version integers beyond JavaScript's safe integer range. New output formats must be explicitly normalized or added deliberately, not guessed from arbitrary logs.

## Evidence Contract

`ProtocolEvidence` is a typed assertion produced by a **trusted local adapter/probe**, not an untrusted remote descriptor and not a cryptographic proof. The validator checks its binding, freshness and group results; it cannot determine whether a producer actually performed an operation. Do not manufacture `proven` entries from schema presence, method names, configured versions, fixtures, transport connection, or handshake metadata.

Evidence is bound to engine, profile ID, runtime instance, generation, configuration ID, and all required component versions. `configurationId` should be a stable local fingerprint of the effective executable/module paths, transport endpoint, adapter/protocol implementation revision, and relevant configuration. Do not place secrets in this field. Rotate generation on reconnect/replacement and invalidate evidence on relevant changes. If session-specific behavior changes, narrow the runtime/evidence scope or perform additional session checks.

Callers supply `now` explicitly. The default evidence age limit is 300,000 ms; `maxAgeMs` can tighten or change it. Future timestamps, nonfinite times, invalid age limits, stale evidence and mismatched versions/configuration/generation fail closed. Use a consistent local clock and re-evaluate at the point of use; a cached assessment does not expire itself. Evidence does not survive a runtime restart merely because a version number is unchanged.

`valid` means the evidence envelope is correctly scoped and fresh, **not** that every group passed. `passiveHandshake` means a single accepted handshake entry exists (passive or proven); it does not enable any operation by itself. Other groups require exactly one `proven` entry. Missing, `passive`, `unsupported`, `unverified`, or duplicate entries cannot prove those groups. `protocolComplete` requires all groups below. Partial evidence can yield a deliberately degraded capability set.

| Group | Evidence the native agent must actually establish |
| --- | --- |
| `handshake` | Profile/transport negotiation with this runtime; passive evidence is sufficient only for this group |
| `session` | Native session creation and stable native identity, not merely a local ID allocation |
| `submission` | Correlated native acceptance of a submission, not local queue insertion |
| `observation` | Correctly scoped native event/history observation and correlation |
| `permission-callback` | Round-trip permission callback with native request correlation and resolution |
| `question-callback` | Round-trip question/form callback with native request correlation and resolution |
| `terminal` | Authoritative, correctly correlated terminal run outcomes, not inferred silence/disconnection |
| `cancellation` | Native cancellation acknowledgement and correct run/scope handling, not merely sending an interrupt |
| `resume` | Native session resume/reconciliation without duplicate submissions |
| `configuration` | Native configuration/model change with authoritative confirmation |

Every evidence entry has a `detail` field for provenance or a local evidence reference. The native agent owns the actual engine-specific probes, safe test sessions and result capture. Terminal and cancellation proof must remain distinct: terminal completion alone cannot acknowledge a cancellation, and cancellation acceptance alone cannot invent a terminal outcome.

`requiredProtocolOperations()` maps groups to capabilities. All operations also require handshake. `submit` requires session, submission, observation and terminal evidence; `cancel` requires cancellation and terminal evidence. `approve` and `answer` independently require their respective callback group. `observe`, `resume`, `create` and `configure` are independently gated by their listed groups. Missing permission proof therefore disables `approve` without pretending `answer` failed. Missing terminal proof disables both `submit` and `cancel`. `protocolComplete` can be false while independently proven operations remain usable; consumers requiring full-profile support must additionally check it explicitly.

No policy output sets `nativeVerified`, descriptor `verified`, authentication status, model availability or native acceptance receipts. Capability results are an upper bound, not authorization: intersect them with current connection state, binding/session capabilities, permissions, authentication, implementation support and operational safety checks. Do not turn missing values into true or copy an entire candidate profile into a live control binding.

## Exports

```ts
compatibilityProfile(engineId: EngineId): CompatibilityProfile
parseNativeVersion(raw: string): NativeVersion | undefined
compareNativeVersions(left: NativeVersion, right: NativeVersion): -1 | 0 | 1
requiredProtocolOperations(): readonly OperationRequirement[]
validateProtocolEvidence(
  descriptor: CompatibilityDescriptor,
  evidence: ProtocolEvidence | undefined,
  options: EvidenceOptions
): ProtocolEvidenceAssessment
assessCompatibility(
  descriptor: CompatibilityDescriptor,
  options: EvidenceOptions,
  policy?: CompatibilityPolicy,
  evidence?: ProtocolEvidence
): CompatibilityAssessment
compareLatestMetadata(
  actual: string,
  latest: string,
  baseline: string
): LatestVersionComparison
```

Also exported: `DEFAULT_COMPATIBILITY_POLICY`, `REQUIRED_PROTOCOL_GROUPS`, and explicit types for policies, parsed versions, components/profiles, descriptors, evidence/groups, assessments, operation results and metadata comparison. Import directly from `packages/protocol/src/compatibility.ts`; existing exports/files are intentionally untouched.

## Native Integration

1. Build a `CompatibilityDescriptor` from the actual installed runtime and independently observed SDK/client/controller versions. Existing `RuntimeDescriptor` fields are structurally reusable, but generation and a nonempty configuration fingerprint are required here. Do not substitute configured target versions for installed versions.
2. Call `assessCompatibility(descriptor, { now: Date.now() }, selectedPolicy)` without evidence. Only `permittedToProbe` permits moving to a controlled protocol probe. A blocked result must remain non-controllable. Do not use `candidate` as a support flag.
3. Collect native protocol evidence in safe, explicitly controlled sessions. Passive discovery/handshake is not permission to submit production work. A separate native probe harness may need to exercise otherwise disabled operations to establish proof; do not bypass production safety gates to do so.
4. Reassess with `assessCompatibility(descriptor, { now: Date.now() }, selectedPolicy, evidence)`. Use `assessment.evidence.operations` for per-operation diagnostics, `missingGroups` for coverage, and intersect `assessment.evidence.capabilities` with live adapter/binding restrictions. Preserve the returned reason, profile, actual, baseline and candidate fields for diagnostics/UI.
5. Reassess after runtime/configuration changes and before enabling controls. Keep verification badges and model/authentication reporting in the native evidence layer. `validateProtocolEvidence` alone validates evidence against the automatic baseline floor; it does **not** enforce a selected pinned policy. Use `assessCompatibility` for production policy decisions.

For strict mode, construct a complete explicit policy, for example:

```ts
const policy: PinnedPolicy = {
  mode: 'pinned',
  targets: { sdk: '0.3.325', cli: '2.1.325' },
  configurationId: descriptor.configurationId,
};
const assessment = assessCompatibility(descriptor, { now: Date.now() }, policy, evidence);
```

For automatic tracking, omit the policy argument or pass `{ mode: 'latest-compatible' }`. The UI's automatic choice should not silently rewrite a user's explicitly pinned configuration.

## Latest Metadata

`compareLatestMetadata` optionally compares caller-supplied latest-version metadata against installed and baseline versions. `relation` describes **latest relative to installed**. Its `candidate` requires latest to be newer than installed and at least the baseline. This is advisory version information only, not protocol evidence or an installation instruction. An invalid installed version cannot be used to infer an upgrade path.

Metadata may come from local manifests, an offline cache, a user-approved registry, or another separately owned source. No cloud vendor is required by this policy, and no provider account or cloud model response is needed to make its decisions. Runtime-specific authentication remains a separate native concern. An unavailable registry must not invalidate otherwise fresh local evidence. Future release compatibility depends on retained protocol behavior and proven operations, not vendor claims.

## Verification

Run from repository root with the required Node 24 installation:

```powershell
& "C:\Program Files\nodejs\node.exe" --test tests/contracts/compatibility.test.ts
& "C:\Program Files\nodejs\node.exe" node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node packages/protocol/src/compatibility.ts tests/contracts/compatibility.test.ts
```

These focused checks do not execute native engines, perform network requests or verify live protocol behavior.
