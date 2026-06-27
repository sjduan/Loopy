import { Activity, Bot, GitBranch, Radio, Sparkles } from "lucide-react";
import type { Invocation, Message, Session, SessionParticipant } from "@loopy/shared";

type NodeState = "idle" | "running" | "recent" | "selected";
type EdgeState = "configured" | "free" | "active" | "recent";

export type ConnectionNode = {
  id: string;
  label: string;
  meta: string;
  state: NodeState;
  runningInvocationIds: string[];
  x: number;
  y: number;
};

export type ConnectionEdge = {
  id: string;
  fromId: string;
  toId: string;
  state: EdgeState;
  invocationId: string | null;
  label: string;
};

export type ConnectionActivity = {
  id: string;
  label: string;
  tone: "running" | "active" | "relay" | "muted";
  invocationId: string | null;
};

export type ConnectionGraph = {
  nodes: ConnectionNode[];
  edges: ConnectionEdge[];
  activities: ConnectionActivity[];
  runningCount: number;
  edgeCount: number;
  routingLabel: string;
};

export function deriveConnectionGraph(session: Session | null, selectedInvocationId = ""): ConnectionGraph {
  if (!session) {
    return { nodes: [], edges: [], activities: [], runningCount: 0, edgeCount: 0, routingLabel: "No session" };
  }

  const participants = session.participants ?? [];
  const invocations = session.invocations ?? [];
  const messages = session.messages ?? [];
  const runningInvocations = invocations.filter((invocation) => invocation.status === "running");
  const runningByParticipant = groupRunningByParticipant(runningInvocations);
  const recentInvocation = latestInvocation(invocations);
  const recentParticipantId = recentInvocation?.participantId ?? null;
  const selectedParticipantId = invocations.find((invocation) => invocation.id === selectedInvocationId)?.participantId ?? null;

  const nodes = participants.map((participant, index) => {
    const runningIds = runningByParticipant.get(participant.id) ?? [];
    const state: NodeState = participant.id === selectedParticipantId
      ? "selected"
      : runningIds.length > 0
        ? "running"
        : participant.id === recentParticipantId
          ? "recent"
          : "idle";
    return {
      id: participant.id,
      label: participant.displayName,
      meta: nodeMeta(participant),
      state,
      runningInvocationIds: runningIds,
      ...nodePosition(index, participants.length)
    };
  });

  const displayEdges = session.edges.length > 0 ? session.edges : freeRoutingEdges(participants);
  const activeEdgeKeys = activeCommunicationEdges(runningInvocations, messages);
  const recentEdge = recentAgentMessage(messages);
  const edges = displayEdges.map((edge) => {
    const key = edgeKey(edge.fromParticipantId, edge.toParticipantId);
    const active = activeEdgeKeys.get(key);
    const isRecent = !active && recentEdge && edgeKey(recentEdge.fromId!, recentEdge.toId!) === key;
    const state: EdgeState = active ? "active" : isRecent ? "recent" : session.edges.length > 0 ? "configured" : "free";
    return {
      id: key,
      fromId: edge.fromParticipantId,
      toId: edge.toParticipantId,
      state,
      invocationId: active?.invocationId ?? (isRecent ? recentEdge?.relatedInvocationId ?? null : null),
      label: `${participantLabel(participants, edge.fromParticipantId)} to ${participantLabel(participants, edge.toParticipantId)}`
    };
  });

  const activities = [
    ...runningInvocations.map((invocation) => ({
      id: `running-${invocation.id}`,
      label: `${participantLabel(participants, invocation.participantId)} running`,
      tone: "running" as const,
      invocationId: invocation.id
    })),
    ...edges
      .filter((edge) => edge.state === "active")
      .map((edge) => ({
        id: `active-${edge.id}`,
        label: `${participantLabel(participants, edge.fromId)} to ${participantLabel(participants, edge.toId)} active`,
        tone: "active" as const,
        invocationId: edge.invocationId
      })),
    ...relayActivities(session, participants)
  ];

  if (activities.length === 0 && recentInvocation) {
    activities.push({
      id: `recent-${recentInvocation.id}`,
      label: `${participantLabel(participants, recentInvocation.participantId)} ${recentInvocation.status}`,
      tone: "muted",
      invocationId: recentInvocation.id
    });
  }

  return {
    nodes,
    edges,
    activities,
    runningCount: runningInvocations.length,
    edgeCount: displayEdges.length,
    routingLabel: session.routingMode === "auto_relay" ? "Auto relay" : "Manual"
  };
}

export function AgentConnectionMap({
  session,
  selectedInvocationId,
  onSelectInvocation
}: {
  session: Session | null;
  selectedInvocationId?: string;
  onSelectInvocation?: (id: string) => void;
}) {
  const graph = deriveConnectionGraph(session, selectedInvocationId);

  if (!session) {
    return (
      <section className="connection-map empty">
        <div className="connection-head">
          <div>
            <p className="eyebrow">Agent Map</p>
            <h3>No session</h3>
          </div>
          <GitBranch size={18} />
        </div>
        <p className="connection-empty">Create or select a session to see agent connectivity.</p>
      </section>
    );
  }

  return (
    <section className="connection-map">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Agent Map</p>
          <h3>{graph.routingLabel}</h3>
        </div>
        <div className="connection-badges">
          <span>{graph.runningCount} running</span>
          <span>{graph.edgeCount} edges</span>
        </div>
      </div>

      <div className="connection-stage">
        <svg className="connection-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((node) => node.id === edge.fromId);
            const to = graph.nodes.find((node) => node.id === edge.toId);
            if (!from || !to) return null;
            return (
              <line
                key={edge.id}
                className={`connection-line ${edge.state}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
        </svg>
        {graph.nodes.map((node) => (
          <div
            key={node.id}
            className={`agent-node ${node.state}`}
            style={{ left: `${node.x}%`, top: `${node.y}%` }}
            title={`${node.label} - ${node.meta}`}
          >
            <span className="agent-node-status" />
            <Bot size={15} />
            <strong>{node.label}</strong>
            <small>{node.meta}</small>
          </div>
        ))}
        {graph.nodes.length === 0 && <p className="connection-empty">This session has no participants.</p>}
      </div>

      <div className="activity-strip">
        {graph.activities.length > 0 ? (
          graph.activities.slice(0, 4).map((activity) => (
            <button
              key={activity.id}
              className={`activity-chip ${activity.tone}`}
              disabled={!activity.invocationId}
              onClick={() => activity.invocationId && onSelectInvocation?.(activity.invocationId)}
            >
              {activity.tone === "relay" ? <Sparkles size={13} /> : activity.tone === "running" ? <Radio size={13} /> : <Activity size={13} />}
              <span>{activity.label}</span>
            </button>
          ))
        ) : (
          <span className="activity-empty">No active communication yet</span>
        )}
      </div>
    </section>
  );
}

function groupRunningByParticipant(invocations: Invocation[]) {
  const result = new Map<string, string[]>();
  for (const invocation of invocations) {
    if (!invocation.participantId) continue;
    result.set(invocation.participantId, [...(result.get(invocation.participantId) ?? []), invocation.id]);
  }
  return result;
}

function activeCommunicationEdges(invocations: Invocation[], messages: Message[]) {
  const result = new Map<string, { invocationId: string }>();
  for (const invocation of invocations) {
    const exact = messages.find(
      (message) => message.relatedInvocationId === invocation.id && message.fromId && message.toId
    );
    const fallback = latestMessageToParticipant(messages, invocation.participantId);
    const message = exact ?? fallback;
    if (!message?.fromId || !message.toId) continue;
    result.set(edgeKey(message.fromId, message.toId), { invocationId: invocation.id });
  }
  return result;
}

function latestMessageToParticipant(messages: Message[], participantId: string | null) {
  if (!participantId) return null;
  return [...messages]
    .reverse()
    .find((message) => message.toId === participantId && message.fromType === "agent" && message.fromId);
}

function recentAgentMessage(messages: Message[]) {
  return [...messages].reverse().find((message) => message.fromId && message.toId && message.messageType === "agent_to_agent") ?? null;
}

function latestInvocation(invocations: Invocation[]) {
  return [...invocations].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
}

function freeRoutingEdges(participants: SessionParticipant[]) {
  const result: Array<{ fromParticipantId: string; toParticipantId: string }> = [];
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      result.push({ fromParticipantId: participants[i]!.id, toParticipantId: participants[j]!.id });
    }
  }
  return result;
}

function relayActivities(session: Session, participants: SessionParticipant[]): ConnectionActivity[] {
  const state = session.relayState;
  if (!state) return [];
  if (state.enabled) {
    return [{
      id: "relay-enabled",
      label: state.pendingNext
        ? `relay waiting for ${participantLabel(participants, state.pendingNext)}`
        : "relay waiting for [NEXT]",
      tone: "relay",
      invocationId: state.lastInvocationId
    }];
  }
  if (state.stopReason) {
    return [{ id: "relay-stopped", label: state.stopReason, tone: "muted", invocationId: state.lastInvocationId }];
  }
  return [];
}

function nodeMeta(participant: SessionParticipant) {
  const profile = participant.agentProfile;
  if (!profile) return participant.role;
  const locality = profile.remote ? "remote" : "local";
  const supportsNativeContext = profile.adapterType === "opencode_cli" || profile.adapterType === "claude_cli";
  const context = participant.runtimeSession?.contextMode === "native_cli"
    ? participant.runtimeSession.nativeSessionId
      ? "context active"
      : "new context"
    : supportsNativeContext
      ? "new context"
      : "no context";
  return `${profile.adapterType.replace("_cli", "")} / ${locality} / ${context}`;
}

function participantLabel(participants: SessionParticipant[], id: string | null) {
  if (!id) return "agent";
  return participants.find((participant) => participant.id === id)?.displayName ?? "agent";
}

function nodePosition(index: number, total: number) {
  if (total <= 1) return { x: 50, y: 50 };
  if (total === 2) return [{ x: 28, y: 50 }, { x: 72, y: 50 }][index]!;
  const angle = -Math.PI / 2 + (2 * Math.PI * index) / total;
  return {
    x: 50 + Math.cos(angle) * 34,
    y: 50 + Math.sin(angle) * 34
  };
}

function edgeKey(a: string, b: string) {
  return [a, b].sort().join("::");
}
