import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import {
  DEFAULT_INVOCATION_TIMEOUT_MS,
  DEFAULT_OPENCODE_MODEL,
  DEFAULT_CLAUDE_MODEL,
  type AgentProfile,
  type AgentRuntimeSession,
  type AgentProfileInput,
  type ApiError,
  type CreateSessionInput,
  type InvokeSessionInput,
  type RelayState,
  type Session
} from "@loopy/shared";
import { buildPrompt, invokeAgent, testAgentProfile } from "./adapter.js";
import { ensureArtifactDir, invocationArtifacts, readText, writeText } from "./artifacts.js";
import { renderCommand } from "./command.js";
import type { ServerConfig } from "./config.js";
import {
  addMessage,
  createInvocation,
  createSession,
  deleteSession,
  ensureRuntimeSession,
  getAgentProfile,
  getInvocation,
  getParticipant,
  getRuntimeSessionForParticipant,
  getSessionDetail,
  hasRunningInvocation,
  listAgentProfiles,
  listSessions,
  openDb,
  recordInvocationOutcome,
  markRuntimeSessionUsed,
  resetRuntimeSessionForParticipant,
  saveAgentProfile,
  deleteAgentProfile,
  updateAgentProfile,
  updateInvocation,
  updateRelayState,
  updateSessionStatus
} from "./db.js";
import { makeId } from "./ids.js";

export function createApp(config: ServerConfig): FastifyInstance {
  const runtimeConfig = config.runtimeConfig ?? { configPresent: false, defaults: { workspace: "", remoteTarget: null } };
  const db = openDb(config.dbPath, config.localConfig ?? {});
  const runningInvocations = new Map<string, AbortController>();
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  app.addHook("onClose", async () => {
    for (const controller of runningInvocations.values()) {
      controller.abort();
    }
    db.close();
  });

  app.get("/api/health", async () => ({
    ok: true,
    dataDir: config.dataDir
  }));

  app.get("/api/runtime-config", async () => runtimeConfig);

  app.get("/api/agent-profiles", async () => listAgentProfiles(db));

  app.post<{ Body: Partial<AgentProfileInput>; Reply: AgentProfileInput | ApiError }>("/api/agent-profiles", async (request, reply) => {
    const input = normalizeAgentProfileInput(request.body);
    if (!input.name) return reply.code(400).send({ error: "Agent name is required." });
    return saveAgentProfile(db, input);
  });

  app.patch<{ Params: { id: string }; Body: Partial<AgentProfileInput> }>("/api/agent-profiles/:id", async (request, reply) => {
    const existing = getAgentProfile(db, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Agent profile not found." });
    const input = normalizeAgentProfileInput({ ...existing, ...request.body });
    return updateAgentProfile(db, request.params.id, input);
  });

  app.post<{ Params: { id: string } }>("/api/agent-profiles/:id/test", async (request, reply) => {
    const profile = getAgentProfile(db, request.params.id);
    if (!profile) return reply.code(404).send({ error: "Agent profile not found." });
    return testAgentProfile(profile, process.cwd());
  });

  app.delete<{ Params: { id: string }; Reply: { ok: boolean } | ApiError }>("/api/agent-profiles/:id", async (request, reply) => {
    const existing = getAgentProfile(db, request.params.id);
    if (!existing) return reply.code(404).send({ error: "Agent profile not found." });
    const result = deleteAgentProfile(db, request.params.id);
    if (!result.ok) {
      const where = result.usedBy?.length ? ` It is used by session(s): ${result.usedBy.join(", ")}.` : "";
      return reply.code(409).send({ error: `Cannot delete this agent.${where} Remove it from those sessions first.` });
    }
    return { ok: true };
  });

  app.get("/api/sessions", async () => listSessions(db));

  app.post<{ Body: CreateSessionInput }>("/api/sessions", async (request, reply) => {
    const body = request.body;
    if (!body?.name || !body.goal || !body.workspace) {
      return reply.code(400).send({ error: "Session name, goal, and workspace are required." });
    }
    if (!Array.isArray(body.participantAgentProfileIds) || body.participantAgentProfileIds.length === 0) {
      return reply.code(400).send({ error: "Choose at least one agent participant." });
    }
    try {
      return createSession(db, body);
    } catch (error) {
      return reply.code(400).send({ error: "Could not create session.", detail: String(error) });
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    return session;
  });

  app.post<{ Params: { sessionId: string; participantId: string } }>(
    "/api/sessions/:sessionId/participants/:participantId/context/reset",
    async (request, reply) => {
      const session = getSessionDetail(db, request.params.sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found." });
      const participant = getParticipant(db, request.params.participantId);
      if (!participant || participant.sessionId !== session.id) {
        return reply.code(404).send({ error: "Participant not found." });
      }
      const existing = getRuntimeSessionForParticipant(db, session.id, participant.id);
      if (!existing) return reply.code(409).send({ error: "This participant does not use native CLI context." });
      resetRuntimeSessionForParticipant(db, session.id, participant.id);
      addMessage(db, {
        sessionId: session.id,
        fromType: "system",
        fromId: null,
        toType: "user",
        toId: null,
        messageType: "system_event",
        content: `Native CLI context reset for ${participant.displayName}. The next run will start a new CLI session.`,
        relatedInvocationId: null
      });
      return getSessionDetail(db, session.id);
    }
  );

  app.post<{ Params: { id: string }; Body: InvokeSessionInput }>("/api/sessions/:id/invoke", async (request, reply) => {
    const result = await invokeForSession(config, request.params.id, request.body);
    if ("error" in result) return reply.code(result.code).send({ error: result.error, detail: result.detail });
    return result.session;
  });

  app.post<{ Params: { id: string }; Body: { toParticipantId: string; content: string } }>("/api/sessions/:id/relay/start", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    const result = await startRelay(session, request.body);
    if ("error" in result) return reply.code(result.code).send({ error: result.error, detail: result.detail });
    return getSessionDetail(db, session.id);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/relay/stop", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    const state = createRelayState(session.relayState, {
      enabled: false,
      stopReason: "Relay stopped by user.",
      autoStopped: false
    });
    updateRelayState(db, session.id, state);
    if (session.status !== "running") updateSessionStatus(db, session.id, "paused", "Relay stopped by user.");
    addMessage(db, {
      sessionId: session.id,
      fromType: "system",
      fromId: null,
      toType: "user",
      toId: null,
      messageType: "system_event",
      content: "Relay stopped by user. Existing logs are preserved.",
      relatedInvocationId: null
    });
    return getSessionDetail(db, session.id);
  });

  app.post<{ Params: { id: string }; Body: { sourceInvocationId: string; toParticipantId?: string; prefix?: string } }>(
    "/api/sessions/:id/continue",
    async (request, reply) => {
      const source = getInvocation(db, request.body?.sourceInvocationId);
      const session = getSessionDetail(db, request.params.id);
      if (!source || !session) return reply.code(404).send({ error: "Source invocation or session not found." });
      const participants = session.participants ?? [];
      const fromParticipant = source.participantId
        ? participants.find((item) => item.id === source.participantId)
        : participants.find((item) => item.agentProfileId === source.agentProfileId);
      const toParticipantId =
        request.body.toParticipantId ?? participants.find((item) => item.id !== fromParticipant?.id)?.id;
      if (!toParticipantId) return reply.code(400).send({ error: "No target participant available." });
      if (fromParticipant && !edgeAllows(session, fromParticipant.id, toParticipantId)) {
        return reply.code(400).send({ error: "This connection is not allowed by the session edges." });
      }
      const resultText = readText(source.resultPath) || source.summary;
      const content = [
        request.body.prefix ?? "Continue from the previous agent result.",
        "",
        `Source agent: ${source.agentProfile?.name ?? source.agentProfileId}`,
        "",
        resultText
      ].join("\n");
      const result = await invokeForSession(config, request.params.id, {
        toParticipantId,
        fromParticipantId: fromParticipant?.id ?? null,
        sourceInvocationId: source.id,
        content
      });
      if ("error" in result) return reply.code(result.code).send({ error: result.error, detail: result.detail });
      return result.session;
    }
  );

  app.post<{ Params: { id: string } }>("/api/sessions/:id/pause", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    updateSessionStatus(db, request.params.id, "paused", "Paused by user.");
    return getSessionDetail(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/cancel", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    const running = session.invocations?.find((invocation) => invocation.status === "running");
    if (!running) return reply.code(409).send({ error: "No running invocation to stop." });
    const controller = runningInvocations.get(running.id);
    if (!controller) return reply.code(409).send({ error: "Running process is no longer attached to this server." });
    controller.abort();
    return getSessionDetail(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/resume", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    updateSessionStatus(db, request.params.id, "waiting_for_user", null);
    return getSessionDetail(db, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/end", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    updateSessionStatus(db, request.params.id, "cancelled", "Ended by user.");
    return getSessionDetail(db, request.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = getSessionDetail(db, request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found." });
    for (const invocation of session.invocations ?? []) {
      runningInvocations.get(invocation.id)?.abort();
      runningInvocations.delete(invocation.id);
    }
    const deleted = deleteSession(db, request.params.id);
    if (!deleted) return reply.code(404).send({ error: "Session not found." });
    const sessionDir = `${config.dataDir}/sessions/${request.params.id}`;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/invocations/:id", async (request, reply) => {
    const invocation = getInvocation(db, request.params.id);
    if (!invocation) return reply.code(404).send({ error: "Invocation not found." });
    return invocation;
  });

  app.post<{ Params: { id: string } }>("/api/invocations/:id/cancel", async (request, reply) => {
    const invocation = getInvocation(db, request.params.id);
    if (!invocation) return reply.code(404).send({ error: "Invocation not found." });
    if (invocation.status !== "running") return reply.code(409).send({ error: "Invocation is not running." });
    const controller = runningInvocations.get(invocation.id);
    if (!controller) return reply.code(409).send({ error: "Running process is no longer attached to this server." });
    controller.abort();
    return getInvocation(db, request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/invocations/:id/logs", async (request, reply) => {
    const invocation = getInvocation(db, request.params.id);
    if (!invocation) return reply.code(404).send({ error: "Invocation not found." });
    return {
      prompt: readText(invocation.promptPath),
      stdout: readText(invocation.stdoutPath),
      stderr: readText(invocation.stderrPath),
      result: readText(invocation.resultPath)
    };
  });

  async function invokeForSession(
    serverConfig: ServerConfig,
    sessionId: string,
    body: InvokeSessionInput
  ): Promise<{ session: unknown } | { code: number; error: string; detail?: string }> {
    const session = getSessionDetail(db, sessionId);
    if (!session) return { code: 404, error: "Session not found." };
    if (["paused", "completed", "cancelled", "timeout"].includes(session.status)) {
      return { code: 409, error: `Session is ${session.status}. Resume or create a new session before invoking.` };
    }
    if (session.maxRounds > 0 && session.roundCount >= session.maxRounds) {
      updateSessionStatus(db, session.id, "completed", "Maximum rounds reached.");
      return { code: 409, error: "Maximum rounds reached." };
    }
    if (hasRunningInvocation(db, session.id)) {
      return { code: 409, error: "This session already has a running invocation." };
    }
    if (!body?.toParticipantId || !body.content?.trim()) {
      return { code: 400, error: "Target participant and content are required." };
    }

    const participant = getParticipant(db, body.toParticipantId);
    if (!participant || participant.sessionId !== session.id || !participant.agentProfile) {
      return { code: 404, error: "Target participant not found." };
    }
    if (body.fromParticipantId) {
      const fromParticipant = getParticipant(db, body.fromParticipantId);
      if (!fromParticipant || fromParticipant.sessionId !== session.id) {
        return { code: 404, error: "Source participant not found." };
      }
      if (!edgeAllows(session, fromParticipant.id, participant.id)) {
        return { code: 400, error: "This connection is not allowed by the session edges." };
      }
    }
    const fromType = body.fromParticipantId ? "agent" : "user";
    const messageType = body.fromParticipantId ? "agent_to_agent" : "user_to_agent";
    addMessage(db, {
      sessionId: session.id,
      fromType,
      fromId: body.fromParticipantId ?? null,
      toType: "agent",
      toId: participant.id,
      messageType,
      content: body.content,
      relatedInvocationId: body.sourceInvocationId ?? null
    });

    updateSessionStatus(db, session.id, "running", null);
    const invocationId = makeId("inv");
    const paths = invocationArtifacts(serverConfig.dataDir, session.id, invocationId);
    ensureArtifactDir(paths);
    const freshSession = getSessionDetail(db, session.id)!;
    const runtimeSession = ensureRuntimeSession(db, freshSession, participant);
    const prompt = buildPrompt(participant.agentProfile, freshSession, body.content);
    writeText(paths.promptPath, prompt);

    const preview = renderCommand({
      profile: participant.agentProfile,
      session: freshSession,
      prompt,
      promptPath: paths.promptPath,
      runtimeSession
    });
	    createInvocation(db, {
	      id: invocationId,
	      sessionId: session.id,
	      agentProfileId: participant.agentProfileId,
	      participantId: participant.id,
	      status: "running",
      commandSnapshot: preview.snapshot,
      promptPath: paths.promptPath,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      resultPath: paths.resultPath,
      exitCode: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      summary: "Invocation running...",
      suggestedNextRecipientId: null,
      nativeSessionId: runtimeSession?.nativeSessionId ?? null,
      nativeTitle: runtimeSession?.nativeTitle ?? null,
      contextMode: runtimeSession?.contextMode
    });

    const controller = new AbortController();
    runningInvocations.set(invocationId, controller);
    void runInvocation({
      sessionId: session.id,
      invocationId,
      participantId: participant.id,
      agentProfileId: participant.agentProfileId,
      profile: participant.agentProfile,
      session: freshSession,
      prompt,
      promptPath: paths.promptPath,
      paths,
      controller,
      shouldPostResultToUser: !body.fromParticipantId,
      runtimeSession
    });
    return { session: getSessionDetail(db, session.id) };
  }

  async function startRelay(
    session: Session,
    body: { toParticipantId?: string; content?: string }
  ): Promise<{ session: unknown } | { code: number; error: string; detail?: string }> {
    if (session.routingMode !== "auto_relay") {
      return { code: 400, error: "Session is not an auto relay session." };
    }
    if (session.status === "running" || hasRunningInvocation(db, session.id)) {
      return { code: 409, error: "This session already has a running invocation." };
    }
    if ((session.participants?.length ?? 0) > 2 && session.edges.length === 0) {
      return { code: 400, error: "Auto relay sessions with more than two participants must define communication edges." };
    }
    if (!body.toParticipantId || !body.content?.trim()) {
      return { code: 400, error: "Start relay requires a target participant and content." };
    }
    const state = createRelayState(session.relayState, {
      enabled: true,
      lastParticipantId: null,
      lastInvocationId: null,
      pendingNext: body.toParticipantId,
      stopReason: null,
      autoStopped: false
    });
    updateRelayState(db, session.id, state);
    return invokeForSession(config, session.id, {
      toParticipantId: body.toParticipantId,
      content: body.content,
      fromParticipantId: null
    });
  }

  async function runInvocation(input: {
    sessionId: string;
    invocationId: string;
    participantId: string;
    agentProfileId: string;
    profile: AgentProfile;
    session: Session;
    prompt: string;
    promptPath: string;
    paths: ReturnType<typeof invocationArtifacts>;
    controller: AbortController;
    shouldPostResultToUser: boolean;
    runtimeSession: AgentRuntimeSession | null;
  }) {
    try {
      const result = await invokeAgent({
        profile: input.profile,
        session: input.session,
        prompt: input.prompt,
        promptPath: input.promptPath,
        runtimeSession: input.runtimeSession,
        signal: input.controller.signal,
        onOutput: (chunk) => fs.appendFileSync(input.paths.stdoutPath, chunk, "utf8")
      });
      const runtimePatch = updateRuntimeAfterResult(input.runtimeSession, result.nativeSessionId, result.status);
      const nextRuntimeSession =
        input.runtimeSession && runtimePatch
          ? markRuntimeSessionUsed(db, input.runtimeSession, runtimePatch)
          : input.runtimeSession;
      writeText(input.paths.stdoutPath, result.stdout);
      writeText(input.paths.stderrPath, result.stderr);
      const resultBody = result.stdout.trim() || result.stderr.trim() || (result.status === "cancelled" ? "(Stopped by user)" : "(No output)");
      writeText(input.paths.resultPath, resultBody);
      const summary = result.status === "cancelled" ? "Stopped by user." : summarize(resultBody);

      updateInvocation(db, {
	        id: input.invocationId,
	        sessionId: input.sessionId,
	        agentProfileId: input.agentProfileId,
	        participantId: input.participantId,
	        status: result.status,
        commandSnapshot: result.commandSnapshot,
        promptPath: input.paths.promptPath,
        stdoutPath: input.paths.stdoutPath,
        stderrPath: input.paths.stderrPath,
        resultPath: input.paths.resultPath,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        summary,
        suggestedNextRecipientId: null,
        nativeSessionId: nextRuntimeSession?.nativeSessionId ?? result.nativeSessionId ?? input.runtimeSession?.nativeSessionId ?? null,
        nativeTitle: nextRuntimeSession?.nativeTitle ?? input.runtimeSession?.nativeTitle ?? null,
        contextMode: nextRuntimeSession?.contextMode ?? input.runtimeSession?.contextMode,
        agentProfile: input.profile
      });

      if (input.shouldPostResultToUser) {
        addMessage(db, {
          sessionId: input.sessionId,
          fromType: "agent",
          fromId: input.participantId,
          toType: "user",
          toId: null,
          messageType: "agent_to_user",
          content: resultBody,
          relatedInvocationId: input.invocationId
        });
      }

      recordInvocationOutcome(db, input.sessionId, result.status);
      void maybeAdvanceRelay(input.sessionId, input.invocationId, result.status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeText(input.paths.stderrPath, message);
      writeText(input.paths.resultPath, message);
      updateInvocation(db, {
	        id: input.invocationId,
	        sessionId: input.sessionId,
	        agentProfileId: input.agentProfileId,
	        participantId: input.participantId,
	        status: "failed",
        commandSnapshot: getInvocation(db, input.invocationId)?.commandSnapshot ?? "",
        promptPath: input.paths.promptPath,
        stdoutPath: input.paths.stdoutPath,
        stderrPath: input.paths.stderrPath,
        resultPath: input.paths.resultPath,
        exitCode: null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        summary: message,
        suggestedNextRecipientId: null,
        nativeSessionId: input.runtimeSession?.nativeSessionId ?? null,
        nativeTitle: input.runtimeSession?.nativeTitle ?? null,
        contextMode: input.runtimeSession?.contextMode,
        agentProfile: input.profile
      });
      recordInvocationOutcome(db, input.sessionId, "failed");
      void maybeAdvanceRelay(input.sessionId, input.invocationId, "failed");
    } finally {
      runningInvocations.delete(input.invocationId);
    }
  }

  async function maybeAdvanceRelay(sessionId: string, invocationId: string, status: string) {
    const session = getSessionDetail(db, sessionId);
    if (!session || session.routingMode !== "auto_relay" || !session.relayState?.enabled) return;
    if (["paused", "cancelled", "completed", "timeout"].includes(session.status)) return;
    const invocation = getInvocation(db, invocationId);
    if (!invocation) return;
    if (status !== "succeeded") {
      stopRelay(session, `Invocation ${invocationId} ended with ${status}.`, status !== "cancelled");
      return;
    }
    const fromParticipantId = invocation.participantId;
    if (!fromParticipantId) {
      stopRelay(session, "Invocation has no source participant.", false, invocationId);
      return;
    }
    const result = readText(invocation.resultPath) || invocation.summary;
    const nextTag = parseNextTag(result);
    if (!nextTag) {
      stopRelay(session, "Agent did not request a next recipient.", false, invocationId);
      return;
    }
    const nextParticipant = matchParticipantByName(session, nextTag);
    if (!nextParticipant) {
      stopRelay(session, `Agent requested unknown recipient: ${nextTag}.`, false, invocationId);
      return;
    }
    if (!edgeAllows(session, fromParticipantId, nextParticipant.id)) {
      stopRelay(session, `Agent requested a recipient that is not connected by session edges: ${nextParticipant.displayName}.`, false, invocationId);
      return;
    }
    const fromName = session.participants?.find((participant) => participant.id === fromParticipantId)?.displayName ?? "agent";
    const cleaned = stripNextTag(result);
    const state = createRelayState(session.relayState, {
      enabled: true,
      lastParticipantId: fromParticipantId,
      lastInvocationId: invocationId,
      pendingNext: nextParticipant.id,
      stopReason: null,
      autoStopped: false
    });
    updateRelayState(db, session.id, state);
    await invokeForSession(config, session.id, {
      toParticipantId: nextParticipant.id,
      fromParticipantId,
      sourceInvocationId: invocationId,
      content: [`Message from ${fromName}:`, "", cleaned].join("\n")
    });
  }

  function stopRelay(session: Session, reason: string, failed: boolean, invocationId?: string) {
    const state = createRelayState(session.relayState, {
      enabled: false,
      pendingNext: null,
      stopReason: reason,
      autoStopped: true
    });
    updateRelayState(db, session.id, state);
    updateSessionStatus(db, session.id, failed ? "failed" : "waiting_for_user", reason);
    addMessage(db, {
      sessionId: session.id,
      fromType: "system",
      fromId: null,
      toType: "user",
      toId: null,
      messageType: "system_event",
      content: reason,
      relatedInvocationId: invocationId ?? null
    });
  }

  return app;
}

function normalizeAgentProfileInput(input: Partial<AgentProfileInput>): AgentProfileInput {
  const adapterType = input.adapterType ?? "opencode_cli";
  const isClaude = adapterType === "claude_cli";
  return {
    name: input.name ?? "",
    adapterType,
    command: input.command ?? (isClaude ? "claude" : "opencode"),
    args: Array.isArray(input.args) && input.args.length > 0
      ? input.args
      : isClaude
        ? ["-p", "{prompt}", "--output-format", "text"]
        : ["run", "-m", "{model}", "--dir", "{workspace}", "{prompt}"],
    cwd: input.cwd ?? "{workspace}",
    rolePrompt: input.rolePrompt ?? "",
    model: input.model ?? (isClaude ? DEFAULT_CLAUDE_MODEL : DEFAULT_OPENCODE_MODEL),
    opencodeAgent: input.opencodeAgent ?? "",
    skipPermissions: Boolean(input.skipPermissions),
    timeoutMs: Number(input.timeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS),
    remote: input.remote ?? null
  };
}

function updateRuntimeAfterResult(
  runtimeSession: AgentRuntimeSession | null,
  nativeSessionId: string | null | undefined,
  status: string
): { nativeSessionId?: string | null; status?: AgentRuntimeSession["status"] } | null {
  if (!runtimeSession || runtimeSession.contextMode !== "native_cli") return null;
  const nextNativeId = nativeSessionId ?? runtimeSession.nativeSessionId;
  if (nextNativeId) return { nativeSessionId: nextNativeId, status: "active" };
  if (status === "succeeded" && runtimeSession.adapterType === "opencode_cli") {
    return { nativeSessionId: null, status: "missing" };
  }
  return { nativeSessionId: null, status: runtimeSession.status };
}

function createRelayState(current: RelayState | null | undefined, patch: Partial<RelayState>): RelayState {
  return {
    enabled: false,
    lastParticipantId: null,
    lastInvocationId: null,
    pendingNext: null,
    stopReason: null,
    autoStopped: false,
    ...(current ?? {}),
    ...patch
  };
}

export function parseNextTag(text: string): string | null {
  const trimmed = text.trimEnd();
  const match = trimmed.match(/\[NEXT:\s*([^\]]+?)\s*\]\s*$/i);
  return match?.[1]?.trim() || null;
}

function stripNextTag(text: string) {
  return text.trimEnd().replace(/\n?\[NEXT:\s*([^\]]+?)\s*\]\s*$/i, "").trimEnd();
}

function matchParticipantByName(session: Session, name: string) {
  const normalized = normalizeName(name);
  return session.participants?.find((participant) => normalizeName(participant.displayName) === normalized) ?? null;
}

function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export function edgeAllows(session: Session, fromParticipantId: string, toParticipantId: string) {
  if (fromParticipantId === toParticipantId) return false;
  if (session.edges.length === 0) return true;
  return session.edges.some(
    (edge) =>
      (edge.fromParticipantId === fromParticipantId && edge.toParticipantId === toParticipantId) ||
      (edge.fromParticipantId === toParticipantId && edge.toParticipantId === fromParticipantId)
  );
}

function summarize(content: string) {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.slice(0, 360) || "(No output)";
}

export function removeDataDirForTests(dataDir: string) {
  if (dataDir.includes("loopy-test-") && fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
