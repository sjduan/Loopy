import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Command,
  ExternalLink,
  FileText,
  Gauge,
  Layers3,
  Loader2,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  Square,
  StopCircle,
  Trash2,
  Terminal,
  XCircle
} from "lucide-react";
import {
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_OPENCODE_MODEL,
  type CreateSessionInput,
  type AgentProfile,
  type AgentProfileInput,
  type Invocation,
  type InvocationLogs,
  type RemoteTarget,
  type RoutingMode,
  type RuntimeConfig,
  type Session,
  type SessionParticipant
} from "@loopy/shared";
import { api } from "./api";
import { AgentConnectionMap } from "./components/AgentConnectionMap";
import "./styles.css";

type View = "sessions" | "agents";

const emptyRuntimeConfig: RuntimeConfig = {
  configPresent: false,
  defaults: {
    workspace: "",
    remoteTarget: null
  }
};

const blankProfile: AgentProfileInput = {
  name: "",
  adapterType: "opencode_cli",
  command: "opencode",
  args: ["run", "-m", "{model}", "--dir", "{workspace}", "{prompt}"],
  cwd: "{workspace}",
  rolePrompt: "",
  model: DEFAULT_OPENCODE_MODEL,
  opencodeAgent: "",
  skipPermissions: false,
  timeoutMs: DEFAULT_INVOCATION_TIMEOUT_MS,
  remote: null
};

function App() {
  const [view, setView] = useState<View>("sessions");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [selectedInvocationId, setSelectedInvocationId] = useState<string>("");
  const [logs, setLogs] = useState<InvocationLogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>(emptyRuntimeConfig);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null;
  const selectedInvocation =
    selectedSession?.invocations?.find((invocation) => invocation.id === selectedInvocationId) ??
    selectedSession?.recentInvocation ??
    selectedSession?.invocations?.at(-1) ??
    null;

  async function refresh(focusSessionId = selectedSessionId) {
    setError("");
    const [health, nextRuntimeConfig, nextProfiles, nextSessions] = await Promise.all([
      api.health(),
      api.runtimeConfig(),
      api.profiles(),
      api.sessions()
    ]);
    setDataDir(health.dataDir);
    setRuntimeConfig(nextRuntimeConfig);
    setProfiles(nextProfiles);
    const focus = focusSessionId || nextSessions[0]?.id || "";
    const detailedSessions = focus
      ? nextSessions.map((session) => (session.id === focus ? null : session))
      : nextSessions;
    if (focus) {
      const detail = await api.session(focus);
      setSessions(detailedSessions.map((session) => session ?? detail));
    } else {
      setSessions(nextSessions);
    }
    setSelectedSessionId(focus);
  }

  useEffect(() => {
    refresh().catch((cause: Error) => setError(cause.message));
  }, []);

  useEffect(() => {
    if (!selectedInvocation) {
      setLogs(null);
      return;
    }
    api.logs(selectedInvocation.id).then(setLogs).catch((cause: Error) => setError(cause.message));
  }, [selectedInvocation?.id, selectedInvocation?.status]);

  useEffect(() => {
    if (!selectedInvocation || selectedInvocation.status !== "running") return;
    const timer = window.setInterval(() => {
      api.logs(selectedInvocation.id).then(setLogs).catch((cause: Error) => setError(cause.message));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedInvocation?.id, selectedInvocation?.status]);

  useEffect(() => {
    if (!sessions.some((session) => session.status === "running" || isRelayAdvancing(session))) return;
    const timer = window.setInterval(() => {
      refresh().catch((cause: Error) => setError(cause.message));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [sessions]);

  async function runAction(action: () => Promise<unknown>, focusId = selectedSession?.id ?? "") {
    setBusy(true);
    setError("");
    try {
      const result = await action();
      const nextFocus = isSessionResult(result) ? result.id : focusId;
      await refresh(nextFocus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const stats = useMemo(() => {
    const active = sessions.filter((session) => ["active", "running", "waiting_for_user"].includes(session.status)).length;
    const failed = sessions.filter((session) => ["failed", "timeout"].includes(session.status)).length;
    const paused = sessions.filter((session) => session.status === "paused").length;
    return { active, failed, paused };
  }, [sessions]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={20} />
          </div>
          <div>
            <h1>Loopy</h1>
            <p>multi-agent workbench</p>
          </div>
        </div>

        <nav className="nav">
          <button className={view === "sessions" ? "active" : ""} onClick={() => setView("sessions")}>
            <Layers3 size={18} /> Sessions
          </button>
          <button className={view === "agents" ? "active" : ""} onClick={() => setView("agents")}>
            <Settings size={18} /> Agents
          </button>
        </nav>

        <div className="stat-grid">
          <Metric label="Active" value={stats.active} icon={<Activity size={16} />} tone="green" />
          <Metric label="Paused" value={stats.paused} icon={<CirclePause size={16} />} tone="amber" />
          <Metric label="Failed" value={stats.failed} icon={<XCircle size={16} />} tone="red" />
        </div>

        <section className="session-list">
          <div className="section-title">
            <span>Sessions</span>
            <button className="icon-button" onClick={() => refresh()} title="Refresh">
              <RefreshCw size={15} />
            </button>
          </div>
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`session-pill ${selectedSession?.id === session.id ? "active" : ""}`}
              onClick={() => {
                setSelectedSessionId(session.id);
                setView("sessions");
              }}
            >
              <span>
                <strong>{session.name}</strong>
                <small>{session.recentMessage?.content?.slice(0, 54) || session.goal}</small>
              </span>
              <Status status={session.status} label={sessionStatusLabel(session.status)} />
            </button>
          ))}
        </section>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local macOS control plane</p>
            <h2>{view === "sessions" ? selectedSession?.name ?? "Create a session" : "Agent Settings"}</h2>
          </div>
          <div className="topbar-actions">
            {busy && <span className="loading"><Loader2 size={16} /> working</span>}
            <button className="secondary" onClick={() => refresh()}>
              <RefreshCw size={16} /> Refresh
            </button>
          </div>
        </header>

        {error && <div className="alert"><XCircle size={17} /> {error}</div>}

        {view === "sessions" ? (
          <SessionWorkspace
            profiles={profiles}
            sessions={sessions}
            selectedSession={selectedSession}
            selectedInvocation={selectedInvocation}
            logs={logs}
            dataDir={dataDir}
            runtimeConfig={runtimeConfig}
            onCreateSession={(input) => runAction(() => api.createSession(input), "")}
            onInvoke={(sessionId, payload) => runAction(() => api.invoke(sessionId, payload), sessionId)}
            onContinue={(sessionId, sourceInvocationId, toParticipantId) =>
              runAction(() => api.continue(sessionId, sourceInvocationId, toParticipantId), sessionId)
            }
            onStartRelay={(sessionId, toParticipantId, content) => runAction(() => api.startRelay(sessionId, toParticipantId, content), sessionId)}
            onStopRelay={(sessionId) => runAction(() => api.stopRelay(sessionId), sessionId)}
            onPause={(sessionId) => runAction(() => api.pause(sessionId), sessionId)}
            onCancel={(sessionId) => runAction(() => api.cancel(sessionId), sessionId)}
            onResume={(sessionId) => runAction(() => api.resume(sessionId), sessionId)}
            onEnd={(sessionId) => runAction(() => api.end(sessionId), sessionId)}
            onDelete={(sessionId) => runAction(() => api.deleteSession(sessionId), "")}
            onResetContext={(sessionId, participantId) => runAction(() => api.resetParticipantContext(sessionId, participantId), sessionId)}
            onSelectInvocation={setSelectedInvocationId}
          />
        ) : (
          <AgentSettings
            profiles={profiles}
            runtimeConfig={runtimeConfig}
            onSave={(input, id) => runAction(() => (id ? api.updateProfile(id, input) : api.createProfile(input)))}
            onDelete={(id) =>
              runAction(async () => {
                await api.deleteProfile(id);
              })
            }
            onTest={async (id) => {
              setBusy(true);
              setError("");
              try {
                const result = await api.testProfile(id);
                setError(result.ok ? "" : result.message);
                window.alert(`${result.ok ? "OK" : "Check failed"}\n${result.message}\n\n${result.commandPreview}`);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
          />
        )}
      </section>
    </main>
  );
}

function isSessionResult(value: unknown): value is Session {
  return Boolean(
    value &&
      typeof value === "object" &&
      "id" in value &&
      "goal" in value &&
      "workspace" in value &&
      "status" in value
  );
}

function isRelayAdvancing(session: Session) {
  return session.routingMode === "auto_relay" && Boolean(session.relayState?.enabled) && session.status !== "waiting_for_user";
}

function SessionWorkspace(props: {
  profiles: AgentProfile[];
  sessions: Session[];
  selectedSession: Session | null;
  selectedInvocation: Invocation | null;
  logs: InvocationLogs | null;
  dataDir: string;
  runtimeConfig: RuntimeConfig;
  onCreateSession: (input: CreateSessionInput) => void;
  onInvoke: (sessionId: string, payload: any) => void;
  onContinue: (sessionId: string, sourceInvocationId: string, toParticipantId: string) => void;
  onStartRelay: (sessionId: string, toParticipantId: string, content: string) => void;
  onStopRelay: (sessionId: string) => void;
  onPause: (sessionId: string) => void;
  onCancel: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  onEnd: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onResetContext: (sessionId: string, participantId: string) => void;
  onSelectInvocation: (id: string) => void;
}) {
	  const [showCreate, setShowCreate] = useState(false);
  const relayActive = props.selectedSession ? isRelayAdvancing(props.selectedSession) : false;
  const runningInvocation = props.selectedSession?.invocations?.find((invocation) => invocation.status === "running") ?? null;
  const canMutateSession =
    props.selectedSession && !["completed", "cancelled", "failed", "timeout"].includes(props.selectedSession.status);

  return (
    <div className="workspace-grid">
      <section className="canvas">
        <div className="toolbar">
          <div>
            <h3>Session Timeline</h3>
            <p>{props.selectedSession ? roundLabel(props.selectedSession) : "No session selected"}</p>
          </div>
          <div className="toolbar-actions">
            {props.selectedSession && (
	              <>
                {props.selectedSession.routingMode === "auto_relay" && relayActive && (
                  <button className="danger" title="Stop automatic relay handoffs. Running agents keep their logs." onClick={() => props.onStopRelay(props.selectedSession!.id)}>
                    <StopCircle size={16} /> Stop Relay
                  </button>
                )}
                {runningInvocation && (
	                  <button className="danger" title="Abort the currently running agent process." onClick={() => props.onCancel(props.selectedSession!.id)}>
                    <StopCircle size={16} /> Stop Running Agent
                  </button>
                )}
                {props.selectedSession.status === "paused" ? (
                  <button className="secondary" title="Resume this paused session." onClick={() => props.onResume(props.selectedSession!.id)}>
                    <CirclePlay size={16} /> Resume Session
                  </button>
                ) : canMutateSession && !runningInvocation ? (
                  <button className="secondary" title="Pause manual sends and automatic relay until resumed." onClick={() => props.onPause(props.selectedSession!.id)}>
                    <Pause size={16} /> Pause Automation
                  </button>
                ) : null}
                {canMutateSession && !runningInvocation && (
                  <button className="danger" title="End this session and keep its timeline and logs." onClick={() => props.onEnd(props.selectedSession!.id)}>
                    <Square size={15} /> End Session
                  </button>
                )}
                <button
                  className="danger"
                  title="Permanently delete this session record."
                  onClick={() => {
                    if (window.confirm(`Permanently delete session "${props.selectedSession!.name}"? Timeline records will be removed. Invocation artifact files may remain under data/.`)) {
                      props.onDelete(props.selectedSession!.id);
                    }
                  }}
                >
                  <Trash2 size={15} /> Delete Session
                </button>
              </>
            )}
            <button className="primary" onClick={() => setShowCreate((value) => !value)}>
              <Plus size={16} /> New Session
            </button>
          </div>
        </div>

        {showCreate && (
	          <CreateSessionForm
              profiles={props.profiles}
              runtimeConfig={props.runtimeConfig}
              onCreate={(input) => {
                props.onCreateSession(input);
                setShowCreate(false);
              }}
            />
	        )}

	        {props.selectedSession ? (
	          <>
	            <SessionHeader session={props.selectedSession} onResetContext={props.onResetContext} />
              <RelayPanel session={props.selectedSession} />
	            <Timeline
              session={props.selectedSession}
              onSelectInvocation={props.onSelectInvocation}
            />
		            <Composer session={props.selectedSession} onInvoke={props.onInvoke} onStartRelay={props.onStartRelay} />
          </>
        ) : (
          <EmptyState
            icon={<MessageSquareText size={34} />}
            title="Create your first agent session"
            body="Use the seeded opencode planner and reviewer profiles, then send a task to start the timeline."
          />
        )}
      </section>

      <aside className="inspector">
        <AgentConnectionMap
          session={props.selectedSession}
          selectedInvocationId={props.selectedInvocation?.id}
          onSelectInvocation={props.onSelectInvocation}
        />
        <InvocationPanel
          session={props.selectedSession}
          invocation={props.selectedInvocation}
          logs={props.logs}
          onContinue={props.onContinue}
          onCancel={props.onCancel}
        />
        <div className="data-note">
          <FileText size={16} />
          <span>Artifacts: {props.dataDir || "data/"}</span>
        </div>
      </aside>
    </div>
  );
}

function CreateSessionForm({
  profiles,
  runtimeConfig,
  onCreate
}: {
  profiles: AgentProfile[];
  runtimeConfig: RuntimeConfig;
  onCreate: (input: CreateSessionInput) => void;
}) {
  const [name, setName] = useState("Agent relay session");
  const [goal, setGoal] = useState("Let selected agents collaborate through a configured communication graph.");
  const [workspace, setWorkspace] = useState(runtimeConfig.defaults.workspace);
  const [locality, setLocality] = useState<"local" | "remote">("local");
  const [routingMode, setRoutingMode] = useState<RoutingMode>("manual");
  const [roundLimitEnabled, setRoundLimitEnabled] = useState(false);
  const [maxRounds, setMaxRounds] = useState(6);
  const visibleProfiles = profiles.filter((profile) => (locality === "remote" ? profile.remote : !profile.remote));
  const [selected, setSelected] = useState<string[]>([]);
  const [edges, setEdges] = useState<string[]>([]);

  useEffect(() => {
    setSelected((current) => {
      const allowed = current.filter((id) => visibleProfiles.some((profile) => profile.id === id));
      return allowed.length ? allowed : visibleProfiles.slice(0, 2).map((profile) => profile.id);
    });
    setEdges([]);
  }, [locality, profiles.length]);

  const selectedProfiles = visibleProfiles.filter((profile) => selected.includes(profile.id));
  const canCreate = Boolean(name.trim() && goal.trim() && workspace.trim() && selected.length > 0);
  const profilePairs = pairs(selectedProfiles);

  function toggleEdge(a: string, b: string, checked: boolean) {
    const key = edgeKey(a, b);
    setEdges((current) => (checked ? [...new Set([...current, key])] : current.filter((item) => item !== key)));
  }

  return (
    <div className="create-panel">
      <div className="helper-card">
        Create a local-only or remote-only session. Edges define which agents may hand off to each other; empty edges keep old manual behavior.
      </div>
      <div className="segmented">
        <button className={locality === "local" ? "active" : ""} onClick={() => setLocality("local")}>
          <Command size={15} /> Local
        </button>
        <button className={locality === "remote" ? "active" : ""} onClick={() => setLocality("remote")}>
          <Terminal size={15} /> {runtimeConfig.defaults.remoteTarget?.label ?? "Remote"}
        </button>
      </div>
      <div className="segmented">
        <button className={routingMode === "manual" ? "active" : ""} onClick={() => setRoutingMode("manual")}>
          <MessageSquareText size={15} /> Manual
        </button>
        <button className={routingMode === "auto_relay" ? "active" : ""} onClick={() => setRoutingMode("auto_relay")}>
          <Sparkles size={15} /> Auto Relay
        </button>
      </div>
      <label>
        Session name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        Goal
        <textarea value={goal} onChange={(event) => setGoal(event.target.value)} />
      </label>
      <label>
        Workspace
        <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
      </label>
      <label className="switch-row">
        <input
          type="checkbox"
          checked={roundLimitEnabled}
          onChange={(event) => setRoundLimitEnabled(event.target.checked)}
        />
        <span>
          Limit relay rounds
          <small>{roundLimitEnabled ? "Loopy stops automatically at this round count." : "Unlimited rounds. Stop relay manually when done."}</small>
        </span>
      </label>
      {roundLimitEnabled && (
        <label>
          Max rounds
          <input
            type="number"
            min={1}
            value={maxRounds}
            onChange={(event) => setMaxRounds(Math.max(1, Number(event.target.value) || 1))}
          />
        </label>
      )}
      <div className="checkbox-grid">
        {visibleProfiles.map((profile) => (
          <label key={profile.id} className="check-row">
            <input
              type="checkbox"
              checked={selected.includes(profile.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id)
                )
              }
            />
            <span>{profile.name}</span>
          </label>
        ))}
      </div>
      {visibleProfiles.length === 0 && <p className="form-note">No {locality} agents are configured yet.</p>}
      {selectedProfiles.length >= 2 && (
        <div className="edge-panel">
          <strong>Communication edges</strong>
          <p>Leave empty for manual free-routing. Auto relay with more than two agents should define at least one edge.</p>
          <div className="edge-grid">
            {profilePairs.map(([a, b]) => {
              const key = edgeKey(a.id, b.id);
              return (
                <label key={key} className="check-row">
                  <input
                    type="checkbox"
                    checked={edges.includes(key)}
                    onChange={(event) => toggleEdge(a.id, b.id, event.target.checked)}
                  />
                  <span>{a.name} ↔ {b.name}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      <button
        className="primary"
        disabled={!canCreate}
        onClick={() =>
          onCreate({
            name,
            goal,
            workspace,
            participantAgentProfileIds: selected,
            maxRounds: roundLimitEnabled ? Math.max(1, maxRounds) : 0,
            routingMode,
            edges: edges.map((key) => {
              const [fromAgentProfileId, toAgentProfileId] = key.split("::") as [string, string];
              return { fromAgentProfileId, toAgentProfileId };
            })
          })
        }
      >
        <Play size={16} /> Create Session
      </button>
    </div>
  );
}

function SessionHeader({
  session,
  onResetContext
}: {
  session: Session;
  onResetContext: (sessionId: string, participantId: string) => void;
}) {
  return (
    <div className="session-header">
      <div>
        <p className="eyebrow">Goal</p>
        <h3>{session.goal}</h3>
      </div>
      <div className="participant-row">
        {session.participants?.map((participant) => (
          <div key={participant.id} className="participant context-participant">
            <span className="participant-title"><Bot size={15} /> {participant.displayName}</span>
            <small>{contextStatusLabel(participant)}</small>
            {participant.runtimeSession?.contextMode === "native_cli" && (
              <button
                className="link-button"
                onClick={() => {
                  if (window.confirm(`Reset native CLI context for ${participant.displayName}? Next run will start a new CLI session.`)) {
                    onResetContext(session.id, participant.id);
                  }
                }}
              >
                Reset context
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RelayPanel({ session }: { session: Session }) {
  const state = session.relayState;
  const edgeLabels = session.edges.map((edge) => `${labelFor(session, edge.fromParticipantId)} ↔ ${labelFor(session, edge.toParticipantId)}`);
  return (
    <section className="auto-panel">
      <div className="auto-head">
        <div>
          <p className="eyebrow">Communication Graph</p>
          <h3>{session.routingMode === "auto_relay" ? "Auto Relay" : "Manual Routing"}</h3>
        </div>
        <div className="auto-badges">
          <span>{session.edges.length ? `${session.edges.length} edges` : "free routing"}</span>
          {state && <span className={state.enabled ? "ok" : ""}>{state.enabled ? "relay enabled" : "relay stopped"}</span>}
        </div>
      </div>
      <div className="edge-list">
        {edgeLabels.length ? edgeLabels.map((label) => <span key={label}>{label}</span>) : <span>All selected participants may communicate manually.</span>}
      </div>
      {state?.stopReason && <div className="alert compact"><XCircle size={16} /> {state.stopReason}</div>}
    </section>
  );
}

function Timeline({ session, onSelectInvocation }: { session: Session; onSelectInvocation: (id: string) => void }) {
  const messages = session.messages ?? [];
  return (
    <div className="timeline">
      {messages.length === 0 && (
        <EmptyState icon={<Terminal size={34} />} title="No messages yet" body="Send a prompt to one of the participants." />
      )}
      {messages.map((message) => (
        <TimelineMessage key={message.id} session={session} message={message} onSelectInvocation={onSelectInvocation} />
      ))}
    </div>
  );
}

function TimelineMessage({
  session,
  message,
  onSelectInvocation
}: {
  session: Session;
  message: NonNullable<Session["messages"]>[number];
  onSelectInvocation: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = messagePreview(message.content);
  const canExpand = preview !== message.content;

  return (
    <article className={`message ${message.fromType} ${expanded ? "expanded" : ""}`}>
      <button className="message-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <ChevronRight size={15} />
        <span className="message-route">
          <strong>{labelFor(session, message.fromId) || message.fromType}</strong>
          <ChevronRight size={13} />
          <strong>{labelFor(session, message.toId) || message.toType}</strong>
        </span>
        <span className="message-type">{message.messageType}</span>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
      </button>
      <div className={expanded ? "message-body full" : "message-body"}>
        {expanded ? message.content : preview}
      </div>
      <div className="message-actions">
        {canExpand && (
          <button className="link-button" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
        {message.relatedInvocationId && (
          <button className="link-button" onClick={() => onSelectInvocation(message.relatedInvocationId!)}>
            <ExternalLink size={14} /> Open invocation
          </button>
        )}
      </div>
    </article>
  );
}

function Composer({
  session,
  onInvoke,
  onStartRelay
}: {
  session: Session;
  onInvoke: (sessionId: string, payload: any) => void;
  onStartRelay: (sessionId: string, toParticipantId: string, content: string) => void;
}) {
  const participants = session.participants ?? [];
  const [toParticipantId, setToParticipantId] = useState(participants[0]?.id ?? "");
  const [content, setContent] = useState("你好，简单回复 OK");
  const isRelay = session.routingMode === "auto_relay";
  const relayRunning = isRelay && Boolean(session.relayState?.enabled) && session.status === "running";

  useEffect(() => {
    setToParticipantId(participants[0]?.id ?? "");
    setContent("你好，简单回复 OK");
  }, [session.id]);

  return (
    <div className="composer">
      <select value={toParticipantId} onChange={(event) => setToParticipantId(event.target.value)}>
        {participants.map((participant) => (
          <option key={participant.id} value={participant.id}>
            {participant.displayName}
          </option>
        ))}
      </select>
      <textarea value={content} onChange={(event) => setContent(event.target.value)} />
      <button
        className="primary"
        disabled={
          !content.trim() ||
          participants.length === 0 ||
          !toParticipantId ||
          session.status === "running" ||
          relayRunning
        }
        onClick={() =>
          isRelay
            ? onStartRelay(session.id, toParticipantId, content)
            : onInvoke(session.id, { toParticipantId, content })
        }
      >
        <Send size={16} /> {isRelay ? "Start Relay" : "Send"}
      </button>
      {isRelay && (
        <p className="form-note">Auto relay continues only when an agent ends its result with [NEXT: participant name].</p>
      )}
      {participants.length === 0 && <p className="form-note">This session has no participants. Create a new session with at least one agent.</p>}
    </div>
  );
}

function InvocationPanel({
  session,
  invocation,
  logs,
  onContinue,
  onCancel
}: {
  session: Session | null;
  invocation: Invocation | null;
  logs: InvocationLogs | null;
  onContinue: (sessionId: string, sourceInvocationId: string, toParticipantId: string) => void;
  onCancel: (sessionId: string) => void;
}) {
  const otherParticipants =
    session && invocation
      ? relayTargetsFor(session, invocation.participantId).filter((participant) => participant.id !== invocation.participantId)
      : [];
  const [target, setTarget] = useState("");

  useEffect(() => {
    setTarget(otherParticipants[0]?.id ?? "");
  }, [invocation?.id, session?.id]);

  if (!invocation) {
    return <EmptyState icon={<Command size={34} />} title="No invocation selected" body="Run an agent to inspect logs here." />;
  }

  return (
    <div className="invocation-panel">
      <div className="inspector-head">
        <div>
          <p className="eyebrow">Invocation Log</p>
          <h3>{invocation.agentProfile?.name ?? invocation.agentProfileId}</h3>
        </div>
        <Status status={invocation.status} />
      </div>
      <div className="kv">
        <span>Exit code</span>
        <strong>{invocation.exitCode ?? "-"}</strong>
        <span>Duration</span>
        <strong>{duration(invocation.startedAt, invocation.endedAt)}</strong>
        <span>Native context</span>
        <strong>{invocation.contextMode === "native_cli" ? invocation.nativeSessionId ?? "pending" : "none"}</strong>
        <span>Native title</span>
        <strong>{invocation.nativeTitle ?? "-"}</strong>
      </div>
      <code className="command-line">{invocation.commandSnapshot}</code>
      {session?.status === "running" && invocation.status === "running" && (
        <button className="danger wide" onClick={() => onCancel(session.id)}>
          <StopCircle size={16} /> Stop this agent
        </button>
      )}
      {otherParticipants.length > 0 && session && (
        <div className="continue-box">
          <select value={target} onChange={(event) => setTarget(event.target.value)}>
            {otherParticipants.map((participant) => (
              <option key={participant.id} value={participant.id}>
                Continue with {participant.displayName}
              </option>
            ))}
          </select>
          <button className="secondary" disabled={!target || session.status === "running"} onClick={() => onContinue(session.id, invocation.id, target)}>
            <Send size={15} /> Send result
          </button>
        </div>
      )}
      <LogBlock title="Prompt" content={logs?.prompt} />
      <LogBlock title="Stdout" content={logs?.stdout} />
      <LogBlock title="Stderr" content={logs?.stderr} />
      <LogBlock title="Result" content={logs?.result} />
    </div>
  );
}

function AgentSettings({
  profiles,
  runtimeConfig,
  onSave,
  onDelete,
  onTest
}: {
  profiles: AgentProfile[];
  runtimeConfig: RuntimeConfig;
  onSave: (input: AgentProfileInput, id?: string) => void;
  onDelete: (id: string) => void;
  onTest: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? "");
  const selectedProfile = profiles.find((profile) => profile.id === selectedId);
  const [draft, setDraft] = useState<AgentProfileInput>(blankProfile);
  const defaultRemote = runtimeConfig.defaults.remoteTarget;

  useEffect(() => {
    if (selectedProfile) {
      setDraft({
        name: selectedProfile.name,
        adapterType: selectedProfile.adapterType,
        command: selectedProfile.command,
        args: selectedProfile.args,
        cwd: selectedProfile.cwd,
        rolePrompt: selectedProfile.rolePrompt,
        model: selectedProfile.model,
        opencodeAgent: selectedProfile.opencodeAgent,
        skipPermissions: selectedProfile.skipPermissions,
        timeoutMs: selectedProfile.timeoutMs,
        remote: selectedProfile.remote ?? null
      });
    }
  }, [selectedProfile?.id]);

  return (
    <div className="agent-grid">
      <section className="profile-list">
        <button className="primary wide" onClick={() => {
          setSelectedId("");
          setDraft({ ...blankProfile, name: "new agent" });
        }}>
          <Plus size={16} /> New Agent
        </button>
        {profiles.map((profile) => (
          <button key={profile.id} className={`profile-card ${selectedId === profile.id ? "active" : ""}`} onClick={() => setSelectedId(profile.id)}>
            <Bot size={18} />
            <span>
              <strong>{profile.name}</strong>
              <small>{profile.model || profile.adapterType}</small>
            </span>
          </button>
        ))}
      </section>
      <section className="profile-editor">
        <label>Name<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>Adapter
          <select value={draft.adapterType} onChange={(event) => setDraft({ ...draft, adapterType: event.target.value as AgentProfileInput["adapterType"] })}>
            <option value="opencode_cli">opencode_cli</option>
            <option value="claude_cli">claude_cli</option>
            <option value="shell_command">shell_command</option>
          </select>
        </label>
        <label>Command<input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label>
        <label>Args<input value={draft.args.join(" ")} onChange={(event) => setDraft({ ...draft, args: splitArgs(event.target.value) })} /></label>
        <label>Model<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
        {draft.adapterType === "opencode_cli" && (
          <label>Opencode mode
            <select value={draft.opencodeAgent} onChange={(event) => setDraft({ ...draft, opencodeAgent: event.target.value })}>
              <option value="">default</option>
              <option value="build">build</option>
              <option value="plan">plan</option>
            </select>
          </label>
        )}
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.skipPermissions}
            onChange={(event) => setDraft({ ...draft, skipPermissions: event.target.checked })}
          />
          <span>
            Auto-approve permissions
            <small>Passes --dangerously-skip-permissions. Use only in trusted workspaces.</small>
          </span>
        </label>
        <label>Working directory<input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} /></label>
        <label>Timeout ms<input type="number" value={draft.timeoutMs} onChange={(event) => setDraft({ ...draft, timeoutMs: Number(event.target.value) })} /></label>
        <div className="remote-section">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={draft.remote !== null}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  remote: event.target.checked
                    ? defaultRemote
                      ? { host: defaultRemote.host, sshKey: defaultRemote.sshKey, remoteCwd: defaultRemote.remoteCwd }
                      : { host: "", sshKey: "", remoteCwd: "" }
                    : null
                })
              }
            />
            <span>
              Run on a remote host over SSH
              <small>
                {defaultRemote
                  ? `Configured default: ${defaultRemote.label}`
                  : "No local remote defaults configured. Fill the fields manually or add config/loopy.local.json."}
              </small>
            </span>
          </label>
          {draft.remote && (
            <div className="remote-fields">
              <label>SSH host
                <input
                  value={draft.remote.host}
                  onChange={(event) => setDraft({ ...draft, remote: { ...draft.remote!, host: event.target.value } })}
                />
              </label>
              <label>SSH key
                <input
                  value={draft.remote.sshKey ?? ""}
                  onChange={(event) => setDraft({ ...draft, remote: { ...draft.remote!, sshKey: event.target.value } })}
                />
              </label>
              <label>Remote working dir
                <input
                  value={draft.remote.remoteCwd}
                  onChange={(event) => setDraft({ ...draft, remote: { ...draft.remote!, remoteCwd: event.target.value } })}
                />
              </label>
              <button
                className="secondary"
                disabled={!defaultRemote}
                onClick={() =>
                  defaultRemote &&
                  setDraft({
                    ...draft,
                    remote: { host: defaultRemote.host, sshKey: defaultRemote.sshKey, remoteCwd: defaultRemote.remoteCwd }
                  })
                }
              >
                Use configured defaults
              </button>
            </div>
          )}
        </div>
        <label>Role prompt<textarea value={draft.rolePrompt} onChange={(event) => setDraft({ ...draft, rolePrompt: event.target.value })} /></label>
        <div className="command-preview">
          <Gauge size={16} />
          <code>{draft.command} {draft.args.join(" ")}</code>
        </div>
        <div className="editor-actions">
          {selectedProfile && <button className="secondary" onClick={() => onTest(selectedProfile.id)}><CheckCircle2 size={16} /> Test</button>}
          <button className="primary" onClick={() => onSave(draft, selectedProfile?.id)}><Send size={16} /> Save</button>
          {selectedProfile && (
            <button
              className="danger"
              onClick={() => {
                if (window.confirm(`Delete agent "${selectedProfile.name}"? This cannot be undone.`)) {
                  onDelete(selectedProfile.id);
                }
              }}
            >
              <Trash2 size={16} /> Delete
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone: string }) {
  return <div className={`metric ${tone}`}>{icon}<strong>{value}</strong><span>{label}</span></div>;
}

function Status({ status, label }: { status: string; label?: string }) {
  return <span className={`status ${status}`}>{label ?? status}</span>;
}

function LogBlock({ title, content }: { title: string; content?: string }) {
  return <details className="log-block" open={title === "Result"}>
    <summary>{title}</summary>
    <pre>{content || "(empty)"}</pre>
  </details>;
}

function EmptyState({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return <div className="empty-state">{icon}<h3>{title}</h3><p>{body}</p></div>;
}

function labelFor(session: Session, id: string | null) {
  if (!id) return "";
  return session.participants?.find((participant) => participant.id === id)?.displayName ?? "";
}

function relayTargetsFor(session: Session, fromParticipantId: string | null) {
  const participants = session.participants ?? [];
  if (!fromParticipantId || session.edges.length === 0) return participants;
  return participants.filter((participant) =>
    session.edges.some(
      (edge) =>
        (edge.fromParticipantId === fromParticipantId && edge.toParticipantId === participant.id) ||
        (edge.toParticipantId === fromParticipantId && edge.fromParticipantId === participant.id)
    )
  );
}

function roundLabel(session: Session) {
  return session.maxRounds > 0
    ? `${session.roundCount}/${session.maxRounds} rounds`
    : `${session.roundCount} rounds · unlimited`;
}

function sessionStatusLabel(status: Session["status"]) {
  return status === "cancelled" ? "ended" : status;
}

function contextStatusLabel(participant: SessionParticipant) {
  const runtime = participant.runtimeSession;
  if (!runtime && participantSupportsNativeContext(participant)) return "new context next run";
  if (!runtime || runtime.contextMode !== "native_cli") return "no native context";
  if (runtime.nativeSessionId) return `native context active · ${runtime.nativeSessionId}`;
  if (runtime.status === "missing") return "native context missing · will retry";
  if (runtime.status === "reset") return "new context next run";
  return "new context next run";
}

function participantSupportsNativeContext(participant: SessionParticipant) {
  const adapterType = participant.agentProfile?.adapterType;
  return adapterType === "opencode_cli" || adapterType === "claude_cli";
}

function messagePreview(content: string) {
  const trimmed = content.trim();
  const lines = trimmed.split(/\r?\n/);
  const firstLines = lines.slice(0, 3).join("\n");
  const clipped = firstLines.length > 240 ? `${firstLines.slice(0, 240).trimEnd()}...` : firstLines;
  return lines.length > 3 || clipped.length < firstLines.length ? `${clipped}${clipped.endsWith("...") ? "" : "\n..."}` : clipped;
}

function pairs<T>(items: T[]): Array<[T, T]> {
  const result: Array<[T, T]> = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      result.push([items[i]!, items[j]!]);
    }
  }
  return result;
}

function edgeKey(a: string, b: string) {
  return [a, b].sort().join("::");
}

function duration(start: string, end: string | null) {
  if (!end) return "-";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms)) return "-";
  return `${Math.max(0, ms / 1000).toFixed(1)}s`;
}

function splitArgs(value: string) {
  return value.match(/"[^"]+"|'[^']+'|\S+/g)?.map((item) => item.replace(/^["']|["']$/g, "")) ?? [];
}

createRoot(document.getElementById("root")!).render(<App />);
