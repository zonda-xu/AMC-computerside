# Host Directory Identity Confirmation

Automation persists authorized root and workspace fingerprints (device, inode and birth time). A normal directory replacement at the same path fails closed across rounds and gateway restarts. Turning automation off and on does not reset these records. New automatically discovered projects bind their identity in the workspace registration transaction. Existing manual projects without fingerprints remain usable manually but cannot be discovered for reuse or automatically synchronized until explicitly confirmed on the host.

Stop the gateway before confirmation. Inspect the physical directories, ownership, repository contents and retained sessions on the host. Confirmation intentionally associates the reviewed directory with existing history; do not confirm an unrelated replacement project. Back up `console.sqlite` first. Use Node 24 and the same working directory, configuration and `AMC_STATE_DIR` as the gateway. The command takes the gateway lock and refuses to run while a gateway holds it. It does not clear stale locks.

For a legacy manual project, explicitly confirm its stored workspace ID and exact path:

```powershell
node apps/gateway/src/confirm-workspace-identity.ts --config host.config.json --root D:\projects --workspace WORKSPACE_ID --confirm-path D:\projects\project
```

The root must already be configured. An unbound root is pinned during this explicit confirmation or the first enabled discovery scan. A previously bound root is never silently repinned. After a deliberately reviewed root replacement, confirm the root separately, then confirm each project whose retained history should be associated with its current directory:

```powershell
node apps/gateway/src/confirm-workspace-identity.ts --config host.config.json --root D:\projects --confirm-root --confirm-path D:\projects
node apps/gateway/src/confirm-workspace-identity.ts --config host.config.json --root D:\projects --workspace WORKSPACE_ID --confirm-path D:\projects\project
```

No workspace grants or sessions are deleted or expanded. Revoked roots must be explicitly restored in host configuration before confirmation can succeed. Restart the gateway after confirmation.

`core.workspaceIdentities.verify(workspaceId, true)` requires an automation fingerprint and revalidates the current grant, persisted root binding and both physical directories. Use it before and after external history reads and before Push delivery for automated projects. `verify(workspaceId)` enforces bound identities but permits legacy unbound manual workspaces; `Core.workspace()` uses this compatible mode, including existing history read pre/post checks. These synchronous methods throw on failure and never establish trust. `directoryIdentity` and `verifyDirectory` are also exported from `workspace-identity.ts`. `authorizeRoot` is reserved for explicitly enabled discovery; `confirmRoot` and `confirm` are explicit host trust operations, not remote request handlers.

Discovery timer failures are visible as `discovery.status.state = partial` with `discovery_failed`. Synchronization timer failures are exposed as `externalSync.lastFailureCode` and `lastFailureAt`; candidate backoff and safe error codes are exposed in `candidateStatuses`. Candidate failures do not trigger workspace-level exponential backoff. Source invalidation, authorization loss and round cancellation terminate the affected workspace/provider round.

Automation event listeners are individually isolated, including asynchronous rejections. Asynchronous rejections from other Core listeners invoked during history projection are captured as `core.lastListenerFailure` with a safe code and timestamp, without forwarding exception details.
