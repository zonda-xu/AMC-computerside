export const PROTOCOL_VERSION = 2;
export const ENGINES = ['codex', 'claude-code', 'opencode', 'deepseek-harness'] as const;
export type EngineId = typeof ENGINES[number];
export type RunState = 'idle' | 'accepted' | 'running' | 'waiting_permission' | 'waiting_input' | 'cancel_requested' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
export const ACTIVE: RunState[] = ['accepted', 'running', 'waiting_permission', 'waiting_input', 'cancel_requested', 'uncertain'];
export const TERMINAL: RunState[] = ['completed', 'failed', 'cancelled'];
export interface ControlCapabilities { create: boolean; submit: boolean; observe: boolean; approve: boolean; answer: boolean; cancel: boolean; resume: boolean; configure?: boolean; attach?: boolean; slash?:boolean; steer?:boolean }
export const NO_CONTROL: ControlCapabilities = {create:false,submit:false,observe:false,approve:false,answer:false,cancel:false,resume:false};
export interface RuntimeBinding {
  accountScope?: string; historyNamespace?: string;
  runtimeInstanceId: string; generation: number; nativeSessionId: string;
  state: 'attached' | 'disconnected' | 'unbound'; capabilities: ControlCapabilities; reason?: string; nativeIdentity?: string;
}
export interface RunRecord { runId: string; sessionId: string; generation: number; clientRequestId?: string; deviceId?: string; nativeRunId?: string; nativeRequestId?: string; nativeStartedAt?:number; state: RunState; result?: Record<string, unknown> }
export interface SessionRef { hostId: string; workspaceId: string; runtimeInstanceId: string; engineId: EngineId; nativeSessionId: string }
export interface ModelIdentity { providerId: string; modelId: string; label: string; reasoningEffort?:string; catalogSource?:string; parameterCount?:number; parameterSource?:string }
export interface Workspace { id: string; hostId: string; name: string; path: string; writeRoots: string[]; engines?: EngineId[] }
export interface WorkspaceCreateRequest { clientRequestId: string; rootId: string; directoryName: string; name: string }
export interface ExternalSource { namespace: string; nativeId: string; generation: string; profile: string; readOnly: boolean }
export interface ExternalCapability { state: 'supported' | 'unsupported' | 'unverified'; reason: string }
export interface ExternalProfile {
  engineId: EngineId; version: string; profile: string; namespace: string; coverage: string; syncMode: string;
  discover: ExternalCapability; history: ExternalCapability; observe: ExternalCapability;
  continueManaged: ExternalCapability; submit: ExternalCapability; approve: ExternalCapability;
  answer: ExternalCapability; cancel: ExternalCapability; configure: ExternalCapability; stopVerification: ExternalCapability;
}
export interface ExternalCandidate { registeredSessionId?: string; candidateId: string; engineId: EngineId; workspaceId: string; title: string; cwd: string; source: ExternalSource }
export interface ExternalMessage { nativeEventId: string; role: 'user' | 'assistant' | 'reasoning'; text: string }
export interface ExternalTool { id:string; title?:string; status:string; detail?:string }
export interface ExternalPage { items: ExternalMessage[]; tools?: ExternalTool[]; cursor?: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'reasoning'; text: string; complete: boolean; model?: ModelIdentity; startSeq?:number; runId?:string; nativeKey?:string; temporary?:boolean; abandoned?:boolean; attemptId?:string; revision?:number }
export interface ToolState { runId?:string; id: string; title: string; status: string; detail: string }
export interface AgentState { runId?: string; id: string; title: string; state: string; detail: string }
export interface Choice { id: string; label: string; scope: string; allows?:boolean }
export interface Question { id: string; title: string; options: string[]; multiple: boolean; freeText: boolean }
export interface Interaction {
  id: string; sessionId: string; kind: 'permission' | 'question'; epoch: number;
  title: string; detail: string; choices: Choice[]; questions: Question[];
  status: 'pending' | 'responding' | 'resolved' | 'stale';
  nativeId: string | number; nativeMethod: string;
  canCancel?:boolean;
  writeRoots?:string[];
  generation?:number; runId?:string; runtimeInstanceId?:string; nativeRequest?:Record<string,unknown>; form?:FormField[];
}
export interface FormField { key:string; type:'string'|'number'|'integer'|'boolean'|'multiselect'|'external'; title?:string; description?:string; required?:boolean; hidden?:boolean; options?:Array<{value:string;label:string;description?:string}>; minLength?:number; maxLength?:number; pattern?:string; minimum?:number; maximum?:number; minItems?:number; maxItems?:number; custom?:boolean; when?:Array<{key:string;op:'eq'|'neq';value:string|number|boolean}>; [key:string]:unknown }
export interface Attachment { id: string; workspaceId: string; name: string; relativePath: string; mime: string; bytes: number; sha256: string }
export interface Session {
  archived?: boolean; pinned?: boolean; deletionPending?: boolean; catalogRevision?: number;
  id: string; ref: SessionRef; title: string; cwd: string; state: RunState; epoch: number;
  model?: ModelIdentity; nextModel?: ModelIdentity; runId?: string;
  messages: Message[]; tools: ToolState[]; agents: AgentState[]; interactions: Interaction[];
  watermark: number; updatedAt: number; historyStart: number; nativeCursor?:number; parentEndState?:RunState; writeRoots?:string[]; grantedRoots?:string[];
  externalSource?: ExternalSource;
  binding?: RuntimeBinding; nativeRunId?: string; runGeneration?:number; result?:Record<string,unknown>;
}
export type EventType = 'message.delta' | 'message.completed' | 'tool.updated' | 'agent.updated' | 'run.updated' | 'interaction.created' | 'interaction.closed' | 'model.confirmed' | 'error';
export interface LegacyConsoleEvent { protocolVersion?:2; eventId?:string; hostId?:string; runtimeInstanceId?:string; generation?:number; runId?:string; nativeEventId?:string; ref: SessionRef; sessionId: string; seq: number; time: number; type: EventType; data: Record<string, unknown> }
export interface ConsoleEvent extends LegacyConsoleEvent { protocolVersion:2; eventId:string; hostId:string; runtimeInstanceId:string; generation:number }
export interface Decision { interactionId: string; epoch: number; expectedGeneration?:number; runId?:string; choiceId?: string; answers?: Record<string, string[]>; cancelled?: boolean; answer?:Record<string,unknown> }
export interface Submission { text: string; attachments: Array<Attachment & {dataBase64?:string}>; requestId: string; runId?:string; generation?:number; nativeRequestId?:string; mode?:'queue'|'steer' }
export interface Receipt { clientRequestId: string; status: 'received' | 'native_accepted' | 'uncertain' | 'rejected'; runId?: string; detail?: string; generation?:number; nativeRunId?:string; nativeRequestId?:string; result?:unknown }
export interface Command {
  protocolVersion: 2; hostId: string; clientRequestId: string; sessionId: string; ref: SessionRef;
  action: 'submit' | 'cancel' | 'decide' | 'configure' | 'slash' | 'steer'; payload: Record<string, unknown>;
}
export interface Capabilities {
  text: boolean; image: boolean; files: boolean; history: boolean; permission: boolean;
  questions: boolean; cancelScope: string; models: boolean;
  slash?:boolean; steer?:boolean;
}
export interface RuntimeDescriptor {
  id: EngineId; runtimeInstanceId: string; version: string; installed: boolean;
  authentication: 'ready' | 'required' | 'unknown'; verified: boolean; detail: string;
  capabilities: Capabilities; models: ModelIdentity[];
  generation?:number; binding?:RuntimeBinding; controlCapabilities?:ControlCapabilities; connectionState?:RuntimeBinding['state']; nativeIdentity?:string;
}
export interface AdapterContext {
  runtimeInstanceId: string; epoch: number;
  openConnection(sessionIds?: string[], nativeIdentity?:string): number;
  generation?:number;
  bindSession?(sessionId:string,binding:RuntimeBinding):void;
  disconnect?(sessionIds?:string[],reason?:string):void;
  reconcileReceipt?(deviceId:string,clientRequestId:string,evidence:{status:'native_accepted'|'rejected';nativeRunId?:string;detail?:string;result?:unknown}):void;
  getRun?(runId:string):RunRecord|undefined;
  pendingCommands?(sessionId:string):Array<{deviceId:string;clientRequestId:string;command:Command;receipt:Receipt}>;
  emit(sessionId: string, type: EventType, data: Record<string, unknown>): void;
  getSession(sessionId: string): Session;
}
export interface AgentAdapter {
  engineId: EngineId; epoch: number;
  probe(): Promise<RuntimeDescriptor>;
  listModels?(workspace?: Workspace): Promise<ModelIdentity[]>;
  createSession(sessionId: string, workspace: Workspace, model?: ModelIdentity): Promise<{ nativeSessionId: string; model?: ModelIdentity; binding?:RuntimeBinding; nativeAccepted?:boolean }>;
  resumeSession(session: Session): Promise<void>;
  attachExistingSession?(session: Session, nativeIdentity: string): Promise<RuntimeBinding>;
  prepareSubmission?(session: Session): Promise<void>;
  submit(session: Session, input: Submission): Promise<void>;
  requestCancel(session: Session): Promise<void>;
  respond(session: Session, interaction: Interaction, decision: Decision): Promise<void>;
  configure(session: Session, model: ModelIdentity): Promise<void>;
  listNativeCommands?(session:Session):Promise<{commands:unknown[]}>;
  executeNativeCommand?(session:Session,line:string,input:Submission):Promise<unknown>;
  releaseSession?(session: Session): Promise<void>;
  prepareDelete?(session: Session): Promise<() => Promise<void>>;
  close(): void;
}
