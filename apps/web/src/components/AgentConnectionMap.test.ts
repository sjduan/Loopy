import { describe, expect, it } from "vitest";
import type { AgentProfile, Invocation, Message, Session, SessionParticipant } from "@loopy/shared";
import { deriveConnectionGraph } from "./AgentConnectionMap";

const profile: AgentProfile = {
  id: "profile_a",
  name: "profile",
  adapterType: "opencode_cli",
  command: "opencode",
  args: [],
  cwd: "{workspace}",
  rolePrompt: "",
  model: "test",
  opencodeAgent: "",
  skipPermissions: false,
  timeoutMs: 1000,
  remote: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function participant(id: string, name: string): SessionParticipant {
  return {
    id,
    sessionId: "session_a",
    agentProfileId: `profile_${id}`,
    displayName: name,
    role: name,
    agentProfile: { ...profile, id: `profile_${id}`, name },
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function invocation(id: string, participantId: string, status: Invocation["status"]): Invocation {
  return {
    id,
    sessionId: "session_a",
    agentProfileId: `profile_${participantId}`,
    participantId,
    status,
    commandSnapshot: "cmd",
    promptPath: "prompt",
    stdoutPath: "stdout",
    stderrPath: "stderr",
    resultPath: "result",
    exitCode: null,
    startedAt: `2026-01-01T00:00:0${id.at(-1) ?? "0"}.000Z`,
    endedAt: status === "running" ? null : "2026-01-01T00:01:00.000Z",
    summary: "",
    suggestedNextRecipientId: null,
    agentProfile: { ...profile, id: `profile_${participantId}` }
  };
}

function message(input: Partial<Message>): Message {
  return {
    id: input.id ?? "msg_a",
    sessionId: "session_a",
    fromType: input.fromType ?? "agent",
    fromId: input.fromId ?? "planner",
    toType: input.toType ?? "agent",
    toId: input.toId ?? "worker",
    messageType: input.messageType ?? "agent_to_agent",
    content: input.content ?? "work",
    relatedInvocationId: input.relatedInvocationId ?? null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z"
  };
}

function session(patch: Partial<Session> = {}): Session {
  const participants = [participant("planner", "Planner"), participant("worker", "Worker"), participant("reviewer", "Reviewer")];
  return {
    id: "session_a",
    name: "Session",
    goal: "Goal",
    workspace: "/tmp/work",
    status: "active",
    routingMode: "manual",
    maxRounds: 10,
    roundCount: 0,
    maxFailures: 3,
    failureCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    stopReason: null,
    edges: [],
    relayState: null,
    participants,
    messages: [],
    invocations: [],
    ...patch
  };
}

describe("deriveConnectionGraph", () => {
  it("creates free-routing display edges when no edges are configured", () => {
    const graph = deriveConnectionGraph(session());
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges.every((edge) => edge.state === "free")).toBe(true);
  });

  it("uses configured edges when present", () => {
    const graph = deriveConnectionGraph(session({
      edges: [{ fromParticipantId: "planner", toParticipantId: "worker" }]
    }));
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ fromId: "planner", toId: "worker", state: "configured" });
  });

  it("marks running invocations and active communication edges", () => {
    const graph = deriveConnectionGraph(session({
      invocations: [invocation("inv_1", "worker", "running")],
      messages: [message({ fromId: "planner", toId: "worker" })]
    }));
    expect(graph.runningCount).toBe(1);
    expect(graph.nodes.find((node) => node.id === "worker")?.state).toBe("running");
    expect(graph.edges.find((edge) => edge.fromId === "planner" && edge.toId === "worker")?.state).toBe("active");
  });

  it("uses relatedInvocationId when it directly links a message to an invocation", () => {
    const graph = deriveConnectionGraph(session({
      invocations: [invocation("inv_2", "reviewer", "running")],
      messages: [message({ fromId: "worker", toId: "reviewer", relatedInvocationId: "inv_2" })]
    }));
    expect(graph.edges.find((edge) => edge.fromId === "worker" && edge.toId === "reviewer")?.state).toBe("active");
  });

  it("adds relay activity from relayState", () => {
    const graph = deriveConnectionGraph(session({
      routingMode: "auto_relay",
      relayState: {
        enabled: true,
        lastParticipantId: "planner",
        lastInvocationId: "inv_1",
        pendingNext: "reviewer",
        stopReason: null,
        autoStopped: false
      }
    }));
    expect(graph.activities.some((activity) => activity.label === "relay waiting for Reviewer")).toBe(true);
  });

  it("supports multiple running invocations", () => {
    const graph = deriveConnectionGraph(session({
      invocations: [
        invocation("inv_1", "worker", "running"),
        invocation("inv_2", "reviewer", "running")
      ],
      messages: [
        message({ id: "msg_1", fromId: "planner", toId: "worker" }),
        message({ id: "msg_2", fromId: "worker", toId: "reviewer" })
      ]
    }));
    expect(graph.runningCount).toBe(2);
    expect(graph.activities.filter((activity) => activity.tone === "running")).toHaveLength(2);
    expect(graph.edges.filter((edge) => edge.state === "active")).toHaveLength(2);
  });
});
