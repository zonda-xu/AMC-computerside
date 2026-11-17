# Protocol 2 Coordination Contract

All network endpoints use `/v2`. Protocol 1 is rejected, not served in parallel. Existing TLS material, pairing credentials, workspaces, historical sessions, and historical event rows are retained. Existing storage namespaces ending in `-v1` identify persisted data, not an active wire protocol.

## HTTP and WSS

Responses retain `{ protocolVersion: 2, hostId, data }`. Authentication remains `Authorization: Bearer ...` and `X-AMC-Host` over verified TLS. The device ID is taken from authentication, never from a command body.

- `GET /v2/bootstrap`: workspaces, session summaries, runtime descriptors, devices.
- `POST /v2/sessions`: `{ protocolVersion: 2, hostId, clientRequestId, workspaceId, runtimeInstanceId, engineId, model? }`. The session is returned only after native creation confirms its actual native ID.
- `GET /v2/sessions/{id}`: windowed session snapshot including binding, current run, interactions, watermark, and result.
- `GET /v2/sessions/{id}/events?afterSeq=N`: persisted events with pagination metadata. Follow `hasMore` until caught up.
- `POST /v2/commands`: the existing command envelope with protocol version 2.
- `GET /v2/commands/{clientRequestId}`: receipt scoped to the authenticated device.
- `POST /v2/sessions/{id}/reconcile`: serialized native reconciliation, never resubmission.
- `WSS /v2/events`: subscription and replay described below.
- Pairing, files, workspace operations, external discovery/history, push binding, and revocation retain their existing semantics under `/v2`.

Every mutation command requires `payload.expectedGeneration`. Submit accepts `{ text, attachmentIds?, expectedGeneration }`. Cancel requires `{ runId, expectedGeneration }`. Decide requires `{ interactionId, expectedGeneration, answer }`; optional `runId` may also be supplied. Permission answers use `{ choiceId }`, question answers use `{ answers: { questionId: string[] }, cancelled? }`. Native typed forms use the original field-key/value object as `answer`, retaining numbers, booleans, and string arrays. Existing adapter-facing top-level decision fields remain accepted within protocol 2; this is not a second protocol.

A subscription is `{ protocolVersion: 2, type: 'subscribe', hostId, sessionIds: string[], afterSeq?: Record<string, number> }`. Omit `afterSeq` for initial snapshots. When supplied, provide a cursor for every requested session. The server replays all persisted events beyond each cursor in pages, then sends `{ type: 'ready', watermarks: Record<string, number> }`; events thereafter are live. Cursors below zero or beyond the current watermark are rejected. Replay and registration share a synchronous SQLite/JS cut, with no asynchronous snapshot gap. Slow peers are closed with 1013 and must reconnect from their last applied sequence.

## Runtime Ownership

`Session.binding` is the authority for control. `externalSource` describes historical provenance only. Its presence never grants or permanently denies control. Imported history starts `uncertain` and `unbound`, not falsely idle. Automatic historical polling stops once an owning native adapter binds that session.

`RuntimeBinding` contains `runtimeInstanceId`, `generation`, `nativeSessionId`, `state: attached | disconnected | unbound`, `capabilities`, optional `reason`, and optional `nativeIdentity`. Capability keys are `create`, `submit`, `observe`, `approve`, `answer`, `cancel`, `resume`, and optional `configure`. Missing control capability means unavailable.

Adapters must explicitly report `RuntimeDescriptor.controlCapabilities` or `descriptor.binding.capabilities`. In particular, `create` must be true before creation is dispatched. CLI version availability is not proof of creation/control. `createSession` may return `binding` and `nativeAccepted`; `nativeAccepted: false` cannot produce a successful local session. If binding is omitted after a confirmed create, the gateway constructs one from the explicit descriptor control capabilities.

`epoch` remains available internally for existing adapters; it mirrors binding generation. It is not an alternative mobile concurrency token.

## Adapter Extension Points

Existing adapter method names and arguments are retained. The following additions are optional in TypeScript to avoid breaking parallel adapter work, but control adapters must use the relevant fields correctly:

- `context.openConnection(sessionIds?, nativeIdentity?)`: returns persisted generation. A stable native process/plugin identity preserves generation across bridge reconnects. A changed identity increments it and invalidates old interactions. Omitting identity declares control-handle reconstruction and increments generation.
- `context.bindSession(id, binding)`: confirms ownership after native attachment/reconciliation. It restores attached state; reconnect alone does not. For an unbound imported session, a trusted adapter may adopt it into this engine's registered runtime while preserving its actual native session ID and historical provenance.
- `context.disconnect(sessionIds?, reason?)`: marks binding disconnected without ending native execution or invalidating still-live callbacks.
- `context.getRun(runId)` and `context.pendingCommands(sessionId)`: expose durable identity/delivery evidence for recovery.
- `context.reconcileReceipt(deviceId, clientRequestId, { status: native_accepted | rejected, nativeRunId?, detail? })`: settles a persisted delivery intent using actual native evidence. Never invoke this based only on loading history.

`Submission` retains `requestId`, text, and attachments, adding `runId`, `generation`, and a persisted UUID `nativeRequestId`. Use `nativeRequestId` when the native protocol requires a UUID. Preserve the original command correlation through `requestId`.

## Run and Event Identity

`Session.runId` is a stable gateway UUID, never a native turn ID or client request ID. `Session.nativeRunId` holds the native turn/message identity. `Session.runGeneration` identifies its owning generation. `RunRecord` persists device/request IDs, native request/run IDs, state, and result. Native interrupt must target `session.nativeRunId`, not `session.runId`.

Emit `run.updated` with `runId` equal to the gateway ID and `nativeRunId` for the native identity. Existing adapter events that put a native turn in `data.runId` are normalized, but adapters must not compare that native value against `Session.runId`. Reliable late-event rejection requires explicit run/generation correlation on all asynchronous callbacks. Native event IDs, where actually stable, are deduplicated by session and generation.

A native `running` event carrying `nativeAccepted: true` and a new `nativeRunId` can establish a separately observed run after an idle/terminal state. This supports native-owned subsequent inbox turns without attributing them to the previous phone command. It does not create a phone input or duplicate submission.

Persisted/output events retain the existing `ref`, numeric millisecond `time`, and typed `data` envelope. They add `protocolVersion: 2`, `eventId`, `hostId`, `runtimeInstanceId`, `generation`, optional `runId`, and optional `nativeEventId`. There is no parallel `payload` event envelope or ISO time conversion. Historical event reads receive deterministic event IDs without deleting or rewriting the original history.

Stale/out-of-order state changes are retained as evidence with `data.ignored: true` and `data.ignoredUpdate`. Consumers must advance the sequence cursor but not apply an ignored event's payload to the projection. Terminal states do not regress; late token deltas do not append after authoritative completed text. A cancel acknowledgement is not a cancelled terminal.

## Delivery and Recovery

`received`, `native_accepted`, `rejected`, and `uncertain` describe delivery, not task success. Submit returning a Promise alone does not imply native acceptance. Emit actual `nativeAccepted` evidence. Cancellation/configuration/decision methods must resolve only on their native acceptance contract.

Commands are serialized per session. Different workspaces may progress concurrently subject to directory overlap locks. Idempotency is scoped to `(pairedDeviceId, clientRequestId)` and a canonical full request hash. Same key/different body conflicts. Intents are persisted before native writes, with no automatic retry after restart. Recovery marks active runs uncertain and bindings disconnected, preserves pending interaction evidence, and requires native reconciliation before control. Unresolved prior submit/cancel delivery blocks a new submit even if a natural completion arrived.

## Atomic Notification Hook

`Store.notificationIntent?: (event: ConsoleEvent, session: Session) => void` is invoked after event insertion and session projection persistence, before transaction commit. It runs only for effective `run.updated` and `interaction.created` events, excluding ignored events, `historical`/`silentBaseline` events, and external sources without attached ownership. Duplicate native events do not invoke it again. Throwing from the hook rolls back event, projection, native dedup/run mappings, and notification intent together. Broadcast happens only after the event transaction returns successfully. The hook must perform synchronous transaction-local enqueue work, not network I/O or a nested transaction.

The lifecycle owner installs `store.notificationIntent = (event, session) => push.enqueue(session.id, event.seq)`. Managed bindings need no historical baseline. The push coordinator still decides which terminal/interaction transitions warrant a notification; receipt acceptance is never proof of device delivery.
