export const DEFAULT_OPENCODE_MODEL = "zhipuai-coding-plan/glm-5.2";
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-5";
export const DEFAULT_INVOCATION_TIMEOUT_MS = 10 * 60 * 1000;

export const adapterTypes = ["opencode_cli", "claude_cli", "shell_command"] as const;
export type AdapterType = (typeof adapterTypes)[number];

// 跑在本机的 TUI 类 adapter（需要 PTY 包一层 + ANSI 剥离 + 实时流）。
export const tuiAdapterTypes = ["opencode_cli", "claude_cli"] as const;
export function isTuiAdapter(adapterType: string): boolean {
  return (tuiAdapterTypes as readonly string[]).includes(adapterType);
}

// 远端执行目标。为 null 表示本机执行。
// host 形如 "user@example.com"；sshKey 形如 "~/.ssh/example"；
// remoteCwd 是远端工作目录，会替换 {workspace} token。
export type RemoteTarget = {
  host: string;
  sshKey?: string;
  remoteCwd: string;
};

export type RemoteTargetDefaults = RemoteTarget & {
  label: string;
};

export type LoopyLocalConfig = {
  defaults?: {
    workspace?: string;
    remoteTarget?: RemoteTargetDefaults | null;
  };
};

export type RuntimeConfig = {
  configPresent: boolean;
  defaults: {
    workspace: string;
    remoteTarget: RemoteTargetDefaults | null;
  };
};

export const sessionStatuses = [
  "draft",
  "active",
  "running",
  "waiting_for_user",
  "paused",
  "completed",
  "failed",
  "timeout",
  "cancelled"
] as const;
export type SessionStatus = (typeof sessionStatuses)[number];

export const invocationStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "cancelled"
] as const;
export type InvocationStatus = (typeof invocationStatuses)[number];

export const messageTypes = [
  "user_to_agent",
  "agent_to_agent",
  "agent_to_user",
  "system_event",
  "human_override"
] as const;
export type MessageType = (typeof messageTypes)[number];

export type AgentProfile = {
  id: string;
  name: string;
  adapterType: AdapterType;
  command: string;
  args: string[];
  cwd: string;
  rolePrompt: string;
  model: string;
  opencodeAgent: string;
  skipPermissions: boolean;
  timeoutMs: number;
  remote: RemoteTarget | null;
  createdAt: string;
  updatedAt: string;
};

export type RuntimeContextMode = "native_cli" | "none";
export type RuntimeSessionStatus = "pending" | "active" | "missing" | "reset";

export type AgentRuntimeSession = {
  id: string;
  sessionId: string;
  participantId: string;
  adapterType: AdapterType;
  nativeSessionId: string | null;
  nativeTitle: string | null;
  contextMode: RuntimeContextMode;
  status: RuntimeSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

export type SessionParticipant = {
  id: string;
  sessionId: string;
  agentProfileId: string;
  displayName: string;
  role: string;
  agentProfile?: AgentProfile;
  runtimeSession?: AgentRuntimeSession | null;
  createdAt: string;
};

export type RoutingMode = "manual" | "auto_relay";

export type SessionEdge = {
  fromParticipantId: string;
  toParticipantId: string;
};

export type CreateSessionEdgeInput = {
  fromAgentProfileId: string;
  toAgentProfileId: string;
};

export type RelayState = {
  enabled: boolean;
  lastParticipantId: string | null;
  lastInvocationId: string | null;
  pendingNext: string | null;
  stopReason: string | null;
  autoStopped: boolean;
};

export type Session = {
  id: string;
  name: string;
  goal: string;
  workspace: string;
  status: SessionStatus;
  routingMode: RoutingMode;
  maxRounds: number;
  roundCount: number;
  maxFailures: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  stopReason: string | null;
  edges: SessionEdge[];
  relayState: RelayState | null;
  participants?: SessionParticipant[];
  messages?: Message[];
  invocations?: Invocation[];
  recentMessage?: Message | null;
  recentInvocation?: Invocation | null;
};

export type Message = {
  id: string;
  sessionId: string;
  fromType: "user" | "agent" | "system";
  fromId: string | null;
  toType: "agent" | "user" | "system";
  toId: string | null;
  messageType: MessageType;
  content: string;
  relatedInvocationId: string | null;
  createdAt: string;
};

export type Invocation = {
  id: string;
  sessionId: string;
  agentProfileId: string;
  participantId: string | null;
  status: InvocationStatus;
  commandSnapshot: string;
  promptPath: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  suggestedNextRecipientId: string | null;
  nativeSessionId?: string | null;
  nativeTitle?: string | null;
  contextMode?: RuntimeContextMode;
  agentProfile?: AgentProfile;
};

export type InvocationLogs = {
  prompt: string;
  stdout: string;
  stderr: string;
  result: string;
};

export type AgentProfileInput = {
  name: string;
  adapterType: AdapterType;
  command: string;
  args: string[];
  cwd: string;
  rolePrompt: string;
  model: string;
  opencodeAgent: string;
  skipPermissions: boolean;
  timeoutMs: number;
  remote: RemoteTarget | null;
};

export type CreateSessionInput = {
  name: string;
  goal: string;
  workspace: string;
  participantAgentProfileIds: string[];
  edges?: CreateSessionEdgeInput[];
  maxRounds?: number;
  maxFailures?: number;
  routingMode?: RoutingMode;
};

export type InvokeSessionInput = {
  toParticipantId: string;
  content: string;
  fromParticipantId?: string | null;
  sourceInvocationId?: string | null;
};

export type StartRelayInput = {
  toParticipantId: string;
  content: string;
};

export type AgentTestResult = {
  ok: boolean;
  commandPreview: string;
  version?: string;
  message: string;
};

export type ApiError = {
  error: string;
  detail?: string;
};

export function nowIso() {
  return new Date().toISOString();
}
