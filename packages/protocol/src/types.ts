export const PROTOCOL_VERSION = 1;
export const ENGINES = ['codex', 'claude-code', 'opencode', 'deepseek-harness'] as const;
export type EngineId = typeof ENGINES[number];
export type RunState = 'idle' | 'accepted' | 'running' | 'waiting_permission' | 'waiting_input' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export const ACTIVE: RunState[] = ['accepted', 'running', 'waiting_permission', 'waiting_input', 'cancel_requested', 'uncertain'];
export interface SessionRef { hostId: string; workspaceId: string; runtimeInstanceId: string; engineId: EngineId; nativeSessionId: string }
export interface ModelIdentity { providerId: string; modelId: string; label: string }
export interface Workspace { id: string; hostId: string; name: string; path: string; writeRoots: string[] }
export interface WorkspaceCreateRequest { clientRequestId: string; rootId: string; directoryName: string; name: string }
export interface ExternalSource { namespace: string; nativeId: string; generation: string; profile: string; readOnly: boolean }
export interface ExternalCapability { state: 'supported' | 'unsupported' | 'unverified'; reason: string }
export interface ExternalProfile {
  engineId: EngineId; version: string; profile: string; namespace: string; coverage: string; syncMode: string;
  discover: ExternalCapability; history: ExternalCapability; observe: ExternalCapability;
  continueManaged: ExternalCapability; submit: ExternalCapability; approve: ExternalCapability;
  answer: ExternalCapability; cancel: ExternalCapability; configure: ExternalCapability; stopVerification: ExternalCapability;
}
export interface ExternalCandidate { candidateId: string; engineId: EngineId; workspaceId: string; title: string; cwd: string; source: ExternalSource }
export interface ExternalMessage { nativeEventId: string; role: 'user' | 'assistant' | 'reasoning'; text: string }
export interface ExternalPage { items: ExternalMessage[]; cursor?: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'reasoning'; text: string; complete: boolean; model?: ModelIdentity; startSeq?:number; nativeKey?:string }
export interface ToolState { id: string; title: string; status: string; detail: string }
export interface AgentState { id: string; title: string; state: string; detail: string }
export interface Choice { id: string; label: string; scope: string; allows?:boolean }
export interface Question { id: string; title: string; options: string[]; multiple: boolean; freeText: boolean }
export interface Interaction {
  id: string; sessionId: string; kind: 'permission' | 'question'; epoch: number;
  title: string; detail: string; choices: Choice[]; questions: Question[];
  status: 'pending' | 'responding' | 'resolved' | 'stale';
  nativeId: string | number; nativeMethod: string;
  canCancel?:boolean;
  writeRoots?:string[];
}
export interface Attachment { id: string; workspaceId: string; name: string; relativePath: string; mime: string; bytes: number; sha256: string }
export interface Session {
  id: string; ref: SessionRef; title: string; cwd: string; state: RunState; epoch: number;
  model?: ModelIdentity; nextModel?: ModelIdentity; runId?: string;
  messages: Message[]; tools: ToolState[]; agents: AgentState[]; interactions: Interaction[];
  watermark: number; updatedAt: number; historyStart: number; nativeCursor?:number; parentEndState?:RunState; writeRoots?:string[]; grantedRoots?:string[];
  externalSource?: ExternalSource;
}
export type EventType = 'message.delta' | 'message.completed' | 'tool.updated' | 'agent.updated' | 'run.updated' | 'interaction.created' | 'interaction.closed' | 'model.confirmed' | 'error';
export interface ConsoleEvent { ref: SessionRef; sessionId: string; seq: number; time: number; type: EventType; data: Record<string, unknown> }
export interface Decision { interactionId: string; epoch: number; choiceId?: string; answers?: Record<string, string[]>; cancelled?: boolean }
export interface Submission { text: string; attachments: Array<Attachment & {dataBase64?:string}>; requestId: string }
export interface Receipt { clientRequestId: string; status: 'received' | 'native_accepted' | 'uncertain' | 'rejected'; runId?: string; detail?: string }
export interface Command {
  protocolVersion: 1; hostId: string; clientRequestId: string; sessionId: string; ref: SessionRef;
  action: 'submit' | 'cancel' | 'decide' | 'configure'; payload: Record<string, unknown>;
}
export interface Capabilities {
  text: boolean; image: boolean; files: boolean; history: boolean; permission: boolean;
  questions: boolean; cancelScope: string; models: boolean;
}
export interface RuntimeDescriptor {
  id: EngineId; runtimeInstanceId: string; version: string; installed: boolean;
  authentication: 'ready' | 'required' | 'unknown'; verified: boolean; detail: string;
  capabilities: Capabilities; models: ModelIdentity[];
}
export interface AdapterContext {
  runtimeInstanceId: string; epoch: number;
  openConnection(sessionIds?: string[]): number;
  emit(sessionId: string, type: EventType, data: Record<string, unknown>): void;
  getSession(sessionId: string): Session;
}
export interface AgentAdapter {
  engineId: EngineId; epoch: number;
  probe(): Promise<RuntimeDescriptor>;
  createSession(sessionId: string, workspace: Workspace, model?: ModelIdentity): Promise<{ nativeSessionId: string; model?: ModelIdentity }>;
  resumeSession(session: Session): Promise<void>;
  submit(session: Session, input: Submission): Promise<void>;
  requestCancel(session: Session): Promise<void>;
  respond(session: Session, interaction: Interaction, decision: Decision): Promise<void>;
  configure(session: Session, model: ModelIdentity): Promise<void>;
  close(): void;
}
