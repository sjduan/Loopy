import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_CLAUDE_MODEL,
  type AgentProfile,
  type AgentProfileInput,
  type CreateSessionEdgeInput,
  type Invocation,
  type LoopyLocalConfig,
  type Message,
  type RemoteTarget,
  type RemoteTargetDefaults,
  type RelayState,
  type Session,
  type SessionEdge,
  type SessionParticipant,
  nowIso
} from "@loopy/shared";
import { makeId } from "./ids.js";

type Db = Database.Database;
type SeedProfile = {
  id: string;
  name: string;
  adapterType: string;
  command: string;
  argsJson: string;
  cwd: string;
  rolePrompt: string;
  model: string;
  opencodeAgent: string;
  skipPermissions: number;
  timeoutMs: number;
  remoteJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export function openDb(dbPath: string, localConfig: LoopyLocalConfig = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seed(db, localConfig);
  return db;
}

function migrate(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      role_prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      opencode_agent TEXT NOT NULL DEFAULT '',
      skip_permissions INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      workspace TEXT NOT NULL,
      status TEXT NOT NULL,
      routing_mode TEXT NOT NULL,
      max_rounds INTEGER NOT NULL,
      round_count INTEGER NOT NULL,
      max_failures INTEGER NOT NULL,
      failure_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
	      ended_at TEXT,
	      stop_reason TEXT,
	      auto_config_json TEXT,
	      auto_state_json TEXT,
	      edges_json TEXT,
	      relay_state_json TEXT
	    );

    CREATE TABLE IF NOT EXISTS session_participants (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      from_type TEXT NOT NULL,
      from_id TEXT,
      to_type TEXT NOT NULL,
      to_id TEXT,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      related_invocation_id TEXT,
      created_at TEXT NOT NULL
    );

	    CREATE TABLE IF NOT EXISTS invocations (
	      id TEXT PRIMARY KEY,
	      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	      agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
	      participant_id TEXT REFERENCES session_participants(id),
	      status TEXT NOT NULL,
      command_snapshot TEXT NOT NULL,
      prompt_path TEXT NOT NULL,
      stdout_path TEXT NOT NULL,
      stderr_path TEXT NOT NULL,
      result_path TEXT NOT NULL,
      exit_code INTEGER,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      summary TEXT NOT NULL,
	      suggested_next_recipient_id TEXT
	    );

	    CREATE TABLE IF NOT EXISTS app_meta (
	      key TEXT PRIMARY KEY,
	      value TEXT NOT NULL
	    );
	  `);
  addColumnIfMissing(db, "agent_profiles", "opencode_agent", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "agent_profiles", "skip_permissions", "INTEGER NOT NULL DEFAULT 0");
	  addColumnIfMissing(db, "agent_profiles", "remote_json", "TEXT");
	  addColumnIfMissing(db, "invocations", "participant_id", "TEXT REFERENCES session_participants(id)");
	  addColumnIfMissing(db, "sessions", "auto_config_json", "TEXT");
	  addColumnIfMissing(db, "sessions", "auto_state_json", "TEXT");
	  addColumnIfMissing(db, "sessions", "edges_json", "TEXT");
	  addColumnIfMissing(db, "sessions", "relay_state_json", "TEXT");
  db.prepare("UPDATE agent_profiles SET model = ? WHERE model = 'muprovider/GLM-5.2'").run(DEFAULT_OPENCODE_MODEL);
}

function addColumnIfMissing(db: Db, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function seed(db: Db, localConfig: LoopyLocalConfig) {
  const now = nowIso();
  const insert = db.prepare(`
    INSERT INTO agent_profiles
    (id, name, adapter_type, command, args_json, cwd, role_prompt, model, opencode_agent, skip_permissions, timeout_ms, remote_json, created_at, updated_at)
    VALUES (@id, @name, @adapterType, @command, @argsJson, @cwd, @rolePrompt, @model, @opencodeAgent, @skipPermissions, @timeoutMs, @remoteJson, @createdAt, @updatedAt)
  `);
  const opencodeBase = {
    command: "opencode",
    argsJson: JSON.stringify(["run", "-m", "{model}", "--dir", "{workspace}", "{prompt}"]),
    cwd: "{workspace}",
    model: DEFAULT_OPENCODE_MODEL,
    opencodeAgent: "",
    skipPermissions: 0,
    timeoutMs: DEFAULT_INVOCATION_TIMEOUT_MS,
    remoteJson: null as string | null,
    createdAt: now,
    updatedAt: now
  };
  const profiles: SeedProfile[] = [
    {
      ...opencodeBase,
      id: "agent_opencode_planner",
      name: "opencode planner",
      adapterType: "opencode_cli",
      rolePrompt: "You are the planner. Break down the task, propose implementation steps, and ask the reviewer for concrete critique."
    },
    {
      ...opencodeBase,
      id: "agent_opencode_reviewer",
      name: "opencode reviewer",
      adapterType: "opencode_cli",
      rolePrompt: "You are the reviewer. Challenge assumptions, inspect risks, request validation, and give practical next steps."
    },
    {
      ...opencodeBase,
      id: "agent_opencode_manager",
      name: "opencode manager",
      adapterType: "opencode_cli",
      opencodeAgent: "plan",
      rolePrompt: "You are the manager agent. Plan the work, define acceptance criteria, coordinate worker and reviewer, and produce the final user-facing summary."
    },
    {
      ...opencodeBase,
      id: "agent_opencode_worker",
      name: "opencode worker",
      adapterType: "opencode_cli",
      opencodeAgent: "build",
      rolePrompt: "You are the worker agent. Execute the manager's concrete task in the selected workspace. Keep changes focused and report what changed."
    },
    {
      ...opencodeBase,
      id: "agent_opencode_auto_reviewer",
      name: "opencode auto reviewer",
      adapterType: "opencode_cli",
      opencodeAgent: "plan",
      rolePrompt: "You are the reviewer agent. Verify the worker result against acceptance criteria and return a clear accepted/rejected decision with feedback."
    }
  ];

  const remoteTarget = configuredRemoteTarget(localConfig.defaults?.remoteTarget ?? null);
  if (remoteTarget) {
    const remoteClaudeBase = {
      command: "claude",
      argsJson: JSON.stringify(["-p", "{prompt}", "--output-format", "text"]),
      cwd: "{workspace}",
      model: DEFAULT_CLAUDE_MODEL,
      opencodeAgent: "",
      skipPermissions: 0,
      timeoutMs: DEFAULT_INVOCATION_TIMEOUT_MS,
      remoteJson: JSON.stringify(remoteTargetToProfileRemote(remoteTarget)),
      createdAt: now,
      updatedAt: now
    };
    profiles.push({
      ...remoteClaudeBase,
      id: "agent_claude_remote_planner",
      name: `claude planner (${remoteTarget.label})`,
      adapterType: "claude_cli",
      rolePrompt: "You are the planner. Break down the task, propose implementation steps, and ask the reviewer for concrete critique.",
      skipPermissions: 1
    });
    profiles.push({
      ...remoteClaudeBase,
      id: "agent_claude_remote_reviewer",
      name: `claude reviewer (${remoteTarget.label})`,
      adapterType: "claude_cli",
      rolePrompt: "You are the reviewer. Challenge assumptions, inspect risks, request validation, and give practical next steps.",
      skipPermissions: 1
    });
  }
  for (const profile of profiles) {
    if (!getAgentProfile(db, profile.id)) insert.run(profile);
  }
  markDefaultAgentsSeeded(db, remoteTarget !== null);
}

function configuredRemoteTarget(remoteTarget: RemoteTargetDefaults | null): RemoteTargetDefaults | null {
  if (!remoteTarget?.host.trim() || !remoteTarget.remoteCwd.trim()) return null;
  return remoteTarget;
}

function remoteTargetToProfileRemote(remoteTarget: RemoteTargetDefaults): RemoteTarget {
  return {
    host: remoteTarget.host,
    sshKey: remoteTarget.sshKey,
    remoteCwd: remoteTarget.remoteCwd
  };
}

function markDefaultAgentsSeeded(db: Db, remoteSeeded: boolean) {
  db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)").run("default_agents_seeded", "true");
  if (remoteSeeded) {
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)").run("remote_agents_seeded", "true");
  }
}

export function listAgentProfiles(db: Db): AgentProfile[] {
  return db.prepare("SELECT * FROM agent_profiles ORDER BY created_at ASC").all().map(mapAgentProfile);
}

export function getAgentProfile(db: Db, id: string): AgentProfile | null {
  const row = db.prepare("SELECT * FROM agent_profiles WHERE id = ?").get(id);
  return row ? mapAgentProfile(row) : null;
}

export function saveAgentProfile(db: Db, input: AgentProfileInput, id = makeId("agent")) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO agent_profiles
    (id, name, adapter_type, command, args_json, cwd, role_prompt, model, opencode_agent, skip_permissions, timeout_ms, remote_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.adapterType,
    input.command,
    JSON.stringify(input.args),
    input.cwd,
    input.rolePrompt,
    input.model,
    input.opencodeAgent,
    input.skipPermissions ? 1 : 0,
    input.timeoutMs,
    input.remote ? JSON.stringify(input.remote) : null,
    now,
    now
  );
  return getAgentProfile(db, id)!;
}

export function updateAgentProfile(db: Db, id: string, input: AgentProfileInput) {
  db.prepare(`
    UPDATE agent_profiles
    SET name = ?, adapter_type = ?, command = ?, args_json = ?, cwd = ?, role_prompt = ?, model = ?, opencode_agent = ?, skip_permissions = ?, timeout_ms = ?, remote_json = ?, updated_at = ?
    WHERE id = ?
  `).run(
    input.name,
    input.adapterType,
    input.command,
    JSON.stringify(input.args),
    input.cwd,
    input.rolePrompt,
    input.model,
    input.opencodeAgent,
    input.skipPermissions ? 1 : 0,
    input.timeoutMs,
    input.remote ? JSON.stringify(input.remote) : null,
    nowIso(),
    id
  );
  return getAgentProfile(db, id);
}

// 删除 agent profile。若被任何 session participant 引用则拒绝，返回冲突的 session 名供提示。
export function deleteAgentProfile(db: Db, id: string): { ok: boolean; usedBy?: string[] } {
  const conflicts = db
    .prepare(
      `SELECT s.name AS session_name
       FROM session_participants p JOIN sessions s ON s.id = p.session_id
       WHERE p.agent_profile_id = ?`
    )
    .all(id) as Array<{ session_name: string }>;
  if (conflicts.length > 0) {
    return { ok: false, usedBy: conflicts.map((row) => row.session_name) };
  }
  const result = db.prepare("DELETE FROM agent_profiles WHERE id = ?").run(id);
  return { ok: result.changes > 0 };
}

export function createSession(db: Db, input: {
  name: string;
  goal: string;
  workspace: string;
  participantAgentProfileIds: string[];
  edges?: CreateSessionEdgeInput[];
  maxRounds?: number;
  maxFailures?: number;
  routingMode?: Session["routingMode"];
}) {
  const id = makeId("session");
  const now = nowIso();
  const profiles = input.participantAgentProfileIds.map((agentProfileId) => {
    const profile = getAgentProfile(db, agentProfileId);
    if (!profile) throw new Error(`Agent profile not found: ${agentProfileId}`);
    return profile;
  });
  validateSessionLocality(profiles);
  const participantIdByProfileId = new Map<string, string>();
  const participantRows = profiles.map((profile) => {
    const participantId = makeId("participant");
    participantIdByProfileId.set(profile.id, participantId);
    return { participantId, profile };
  });
  const edges = normalizeCreateEdges(input.edges ?? [], participantIdByProfileId);
  const relayState: RelayState | null =
    input.routingMode === "auto_relay"
      ? { enabled: false, lastParticipantId: null, lastInvocationId: null, pendingNext: null, stopReason: null, autoStopped: false }
      : null;
  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions
      (id, name, goal, workspace, status, routing_mode, max_rounds, round_count, max_failures, failure_count, created_at, updated_at, edges_json, relay_state_json)
      VALUES (?, ?, ?, ?, 'active', ?, ?, 0, ?, 0, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.goal,
      input.workspace,
      input.routingMode ?? "manual",
      input.maxRounds ?? 6,
      input.maxFailures ?? 2,
      now,
      now,
      JSON.stringify(edges),
      relayState ? JSON.stringify(relayState) : null
    );

    for (const { participantId, profile } of participantRows) {
      db.prepare(`
        INSERT INTO session_participants
        (id, session_id, agent_profile_id, display_name, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(participantId, id, profile.id, profile.name, profile.name, now);
    }
  });
  transaction();
  return getSessionDetail(db, id)!;
}

export function listSessions(db: Db): Session[] {
  const rows = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all();
  return rows.map((row) => enrichSession(db, mapSession(row)));
}

export function getSessionDetail(db: Db, id: string): Session | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  if (!row) return null;
  const session = mapSession(row);
  session.participants = listParticipants(db, id);
  session.messages = listMessages(db, id);
  session.invocations = listInvocations(db, id);
  return enrichSession(db, session);
}

export function deleteSession(db: Db, id: string) {
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function updateRelayState(db: Db, id: string, state: RelayState | null) {
  db.prepare("UPDATE sessions SET relay_state_json = ?, updated_at = ? WHERE id = ?").run(
    state ? JSON.stringify(state) : null,
    nowIso(),
    id
  );
}

export function setSessionStatus(db: Db, id: string, status: Session["status"], stopReason?: string | null) {
  updateSessionStatus(db, id, status, stopReason);
}

function validateSessionLocality(profiles: AgentProfile[]) {
  const remotes = profiles.map((profile) => profile.remote);
  const localCount = remotes.filter((remote) => !remote).length;
  const remoteValues = remotes.filter(Boolean) as RemoteTarget[];
  if (localCount > 0 && remoteValues.length > 0) {
    throw new Error("Cannot mix local and remote agents in the same session.");
  }
  if (remoteValues.length > 1) {
    const firstKey = remoteIdentity(remoteValues[0]!);
    const mismatch = remoteValues.some((remote) => remoteIdentity(remote) !== firstKey);
    if (mismatch) throw new Error("Remote agents in one session must use the same host and SSH key.");
  }
}

function remoteIdentity(remote: RemoteTarget) {
  return `${remote.host}::${remote.sshKey ?? ""}`;
}

function normalizeCreateEdges(edges: CreateSessionEdgeInput[], participantIdByProfileId: Map<string, string>): SessionEdge[] {
  const normalized = new Map<string, SessionEdge>();
  for (const edge of edges) {
    const fromParticipantId = participantIdByProfileId.get(edge.fromAgentProfileId);
    const toParticipantId = participantIdByProfileId.get(edge.toAgentProfileId);
    if (!fromParticipantId || !toParticipantId) {
      throw new Error("Session edge references an agent profile that is not a participant.");
    }
    if (fromParticipantId === toParticipantId) continue;
    const [a, b] = [fromParticipantId, toParticipantId].sort() as [string, string];
    normalized.set(`${a}::${b}`, { fromParticipantId: a, toParticipantId: b });
  }
  return [...normalized.values()];
}

export function listParticipants(db: Db, sessionId: string): SessionParticipant[] {
  return db
    .prepare("SELECT * FROM session_participants WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId)
    .map((row) => {
      const participant = mapParticipant(row);
      participant.agentProfile = getAgentProfile(db, participant.agentProfileId) ?? undefined;
      return participant;
    });
}

export function getParticipant(db: Db, id: string): SessionParticipant | null {
  const row = db.prepare("SELECT * FROM session_participants WHERE id = ?").get(id);
  if (!row) return null;
  const participant = mapParticipant(row);
  participant.agentProfile = getAgentProfile(db, participant.agentProfileId) ?? undefined;
  return participant;
}

export function addMessage(db: Db, message: Omit<Message, "id" | "createdAt">) {
  const id = makeId("msg");
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO messages
    (id, session_id, from_type, from_id, to_type, to_id, message_type, content, related_invocation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    message.sessionId,
    message.fromType,
    message.fromId,
    message.toType,
    message.toId,
    message.messageType,
    message.content,
    message.relatedInvocationId,
    createdAt
  );
  touchSession(db, message.sessionId);
  return listMessages(db, message.sessionId).find((item) => item.id === id)!;
}

export function listMessages(db: Db, sessionId: string): Message[] {
  return db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId).map(mapMessage);
}

export function createInvocation(db: Db, input: Omit<Invocation, "agentProfile">) {
  db.prepare(`
    INSERT INTO invocations
    (id, session_id, agent_profile_id, participant_id, status, command_snapshot, prompt_path, stdout_path, stderr_path, result_path,
      exit_code, started_at, ended_at, summary, suggested_next_recipient_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.sessionId,
    input.agentProfileId,
    input.participantId,
    input.status,
    input.commandSnapshot,
    input.promptPath,
    input.stdoutPath,
    input.stderrPath,
    input.resultPath,
    input.exitCode,
    input.startedAt,
    input.endedAt,
    input.summary,
    input.suggestedNextRecipientId
  );
  return getInvocation(db, input.id)!;
}

export function updateInvocation(db: Db, invocation: Invocation) {
  db.prepare(`
    UPDATE invocations
    SET participant_id = ?, status = ?, command_snapshot = ?, exit_code = ?, started_at = ?, ended_at = ?, summary = ?, suggested_next_recipient_id = ?
    WHERE id = ?
  `).run(
    invocation.participantId,
    invocation.status,
    invocation.commandSnapshot,
    invocation.exitCode,
    invocation.startedAt,
    invocation.endedAt,
    invocation.summary,
    invocation.suggestedNextRecipientId,
    invocation.id
  );
  touchSession(db, invocation.sessionId);
  return getInvocation(db, invocation.id)!;
}

export function getInvocation(db: Db, id: string): Invocation | null {
  const row = db.prepare("SELECT * FROM invocations WHERE id = ?").get(id);
  if (!row) return null;
  const invocation = mapInvocation(row);
  invocation.agentProfile = getAgentProfile(db, invocation.agentProfileId) ?? undefined;
  return invocation;
}

export function listInvocations(db: Db, sessionId: string): Invocation[] {
  return db.prepare("SELECT * FROM invocations WHERE session_id = ? ORDER BY started_at ASC").all(sessionId).map((row) => {
    const invocation = mapInvocation(row);
    invocation.agentProfile = getAgentProfile(db, invocation.agentProfileId) ?? undefined;
    return invocation;
  });
}

export function hasRunningInvocation(db: Db, sessionId: string) {
  const row = db
    .prepare("SELECT id FROM invocations WHERE session_id = ? AND status = 'running' LIMIT 1")
    .get(sessionId);
  return Boolean(row);
}

export function updateSessionStatus(db: Db, id: string, status: Session["status"], stopReason?: string | null) {
  db.prepare("UPDATE sessions SET status = ?, stop_reason = ?, ended_at = ?, updated_at = ? WHERE id = ?").run(
    status,
    stopReason ?? null,
    ["completed", "failed", "timeout", "cancelled"].includes(status) ? nowIso() : null,
    nowIso(),
    id
  );
}

export function recordInvocationOutcome(db: Db, sessionId: string, status: Invocation["status"]) {
  const failed = status === "failed" || status === "timeout";
  const cancelled = status === "cancelled";
  db.prepare(`
    UPDATE sessions
    SET round_count = round_count + 1,
        failure_count = failure_count + ?,
        status = ?,
        updated_at = ?
    WHERE id = ?
  `).run(failed ? 1 : 0, cancelled ? "paused" : failed ? "failed" : "waiting_for_user", nowIso(), sessionId);

  const session = getSessionDetail(db, sessionId);
  if (!session) return;
  if (cancelled) {
    updateSessionStatus(db, sessionId, "paused", "Agent stopped by user.");
    return;
  }
  if (status === "timeout") updateSessionStatus(db, sessionId, "timeout", "Invocation timed out.");
  else if (session.failureCount >= session.maxFailures) updateSessionStatus(db, sessionId, "failed", "Maximum failures reached.");
  else if (session.roundCount >= session.maxRounds) updateSessionStatus(db, sessionId, "completed", "Maximum rounds reached.");
}

function touchSession(db: Db, id: string) {
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowIso(), id);
}

function enrichSession(db: Db, session: Session): Session {
  session.participants ??= listParticipants(db, session.id);
  session.recentMessage = db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1")
    .all(session.id)
    .map(mapMessage)[0] ?? null;
  const recentInvocation = db
    .prepare("SELECT * FROM invocations WHERE session_id = ? ORDER BY started_at DESC LIMIT 1")
    .all(session.id)
    .map(mapInvocation)[0] ?? null;
  if (recentInvocation) recentInvocation.agentProfile = getAgentProfile(db, recentInvocation.agentProfileId) ?? undefined;
  session.recentInvocation = recentInvocation;
  return session;
}

function mapAgentProfile(row: any): AgentProfile {
  return {
    id: row.id,
    name: row.name,
    adapterType: row.adapter_type,
    command: row.command,
    args: JSON.parse(row.args_json),
    cwd: row.cwd,
    rolePrompt: row.role_prompt,
    model: row.model,
    opencodeAgent: row.opencode_agent ?? "",
    skipPermissions: Boolean(row.skip_permissions),
    timeoutMs: row.timeout_ms,
    remote: parseJson<RemoteTarget | null>(row.remote_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSession(row: any): Session {
  const routingMode = row.routing_mode === "auto_relay" ? "auto_relay" : "manual";
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    workspace: row.workspace,
    status: row.status,
	    routingMode,
    maxRounds: row.max_rounds,
    roundCount: row.round_count,
    maxFailures: row.max_failures,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    stopReason: row.stop_reason,
	    edges: parseJson<SessionEdge[]>(row.edges_json, []),
	    relayState: parseJson<RelayState | null>(row.relay_state_json, null)
	  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapParticipant(row: any): SessionParticipant {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentProfileId: row.agent_profile_id,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at
  };
}

function mapMessage(row: any): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    fromType: row.from_type,
    fromId: row.from_id,
    toType: row.to_type,
    toId: row.to_id,
    messageType: row.message_type,
    content: row.content,
    relatedInvocationId: row.related_invocation_id,
    createdAt: row.created_at
  };
}

function mapInvocation(row: any): Invocation {
  return {
	    id: row.id,
	    sessionId: row.session_id,
	    agentProfileId: row.agent_profile_id,
	    participantId: row.participant_id ?? null,
	    status: row.status,
    commandSnapshot: row.command_snapshot,
    promptPath: row.prompt_path,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    resultPath: row.result_path,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    suggestedNextRecipientId: row.suggested_next_recipient_id
  };
}
