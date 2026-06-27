import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, edgeAllows, parseNextTag, removeDataDirForTests } from "./app.js";
import { getConfig, loadLocalConfig } from "./config.js";
import type { LoopyLocalConfig, RuntimeConfig } from "@loopy/shared";

let dataDir = "";

function makeTestApp(localConfig?: LoopyLocalConfig, runtimeConfig?: RuntimeConfig) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopy-test-"));
  return createApp({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    dbPath: path.join(dataDir, "loopy.db"),
    localConfig,
    runtimeConfig
  });
}

async function waitForSession(app: ReturnType<typeof makeTestApp>, sessionId: string, done: (session: any) => boolean) {
  for (let i = 0; i < 100; i += 1) {
    const response = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    const session = response.json();
    if (done(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for session state.");
}

afterEach(() => {
  removeDataDirForTests(dataDir);
});

describe("Loopy API", () => {
  it("parses relay NEXT tags and checks undirected edges", () => {
    expect(parseNextTag("Done\n[NEXT: reviewer]")).toBe("reviewer");
    expect(parseNextTag("Done\n[next: Planner Agent]   ")).toBe("Planner Agent");
    expect(parseNextTag("[NEXT: reviewer]\nmore text")).toBeNull();
    expect(
      edgeAllows(
        {
          edges: [{ fromParticipantId: "a", toParticipantId: "b" }]
        } as any,
        "b",
        "a"
      )
    ).toBe(true);
    expect(edgeAllows({ edges: [{ fromParticipantId: "a", toParticipantId: "b" }] } as any, "a", "c")).toBe(false);
  });

  it("starts without local config and does not seed remote profiles", async () => {
    const app = makeTestApp();
    const runtime = await app.inject({ method: "GET", url: "/api/runtime-config" });
    expect(runtime.statusCode).toBe(200);
    expect(runtime.json()).toEqual({
      configPresent: false,
      defaults: { workspace: "", remoteTarget: null }
    });

    const profiles = await app.inject({ method: "GET", url: "/api/agent-profiles" });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.json().some((profile: any) => profile.remote)).toBe(false);
    await app.close();
  });

  it("uses local config for runtime defaults and remote seed profiles", async () => {
    const localConfig: LoopyLocalConfig = {
      defaults: {
        workspace: "/workspace/example",
        remoteTarget: {
          label: "Example remote",
          host: "user@example.test",
          sshKey: "~/.ssh/example",
          remoteCwd: "/srv/example"
        }
      }
    };
    const runtimeConfig: RuntimeConfig = {
      configPresent: true,
      defaults: {
        workspace: "/workspace/example",
        remoteTarget: localConfig.defaults!.remoteTarget!
      }
    };
    const app = makeTestApp(localConfig, runtimeConfig);

    const runtime = await app.inject({ method: "GET", url: "/api/runtime-config" });
    expect(runtime.json()).toEqual(runtimeConfig);

    const profiles = await app.inject({ method: "GET", url: "/api/agent-profiles" });
    const remoteProfiles = profiles.json().filter((profile: any) => profile.remote);
    expect(remoteProfiles).toHaveLength(2);
    expect(remoteProfiles[0].remote).toEqual({
      host: "user@example.test",
      sshKey: "~/.ssh/example",
      remoteCwd: "/srv/example"
    });
    await app.close();
  });

  it("loads local config files and rejects invalid JSON", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopy-test-"));
    const configPath = path.join(dataDir, "loopy.local.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaults: {
          workspace: "/workspace/example",
          remoteTarget: {
            label: "Example remote",
            host: "user@example.test",
            sshKey: "~/.ssh/example",
            remoteCwd: "/srv/example"
          }
        }
      })
    );
    expect(loadLocalConfig(configPath)).toEqual({
      present: true,
      config: {
        defaults: {
          workspace: "/workspace/example",
          remoteTarget: {
            label: "Example remote",
            host: "user@example.test",
            sshKey: "~/.ssh/example",
            remoteCwd: "/srv/example"
          }
        }
      }
    });

    const badConfigPath = path.join(dataDir, "bad.local.json");
    fs.writeFileSync(badConfigPath, "{");
    expect(() => loadLocalConfig(badConfigPath)).toThrow(/Could not parse Loopy local config/);
  });

  it("uses LOOPY_LOCAL_CONFIG to override the default config path", () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "loopy-test-"));
    const oldLocalConfig = process.env.LOOPY_LOCAL_CONFIG;
    const oldDataDir = process.env.LOOPY_DATA_DIR;
    const configPath = path.join(dataDir, "custom.local.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaults: {
          workspace: "/workspace/from-env"
        }
      })
    );
    process.env.LOOPY_LOCAL_CONFIG = configPath;
    process.env.LOOPY_DATA_DIR = dataDir;
    try {
      const config = getConfig();
      expect(config.localConfigPath).toBe(configPath);
      expect(config.runtimeConfig).toEqual({
        configPresent: true,
        defaults: {
          workspace: "/workspace/from-env",
          remoteTarget: null
        }
      });
    } finally {
      if (oldLocalConfig === undefined) delete process.env.LOOPY_LOCAL_CONFIG;
      else process.env.LOOPY_LOCAL_CONFIG = oldLocalConfig;
      if (oldDataDir === undefined) delete process.env.LOOPY_DATA_DIR;
      else process.env.LOOPY_DATA_DIR = oldDataDir;
    }
  });

  it("creates shell agents, invokes, continues, and persists logs", async () => {
    const app = makeTestApp();
    const createAgent = async (name: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agent-profiles",
        payload: {
          name,
          adapterType: "shell_command",
          command: process.execPath,
          args: ["-e", "process.stdout.write('result from '+process.argv[1])", "{prompt}"],
          cwd: process.cwd(),
          rolePrompt: `${name} role`,
          model: "none",
          timeoutMs: 5000
        }
      });
      expect(response.statusCode).toBe(200);
      return response.json();
    };

    const planner = await createAgent("planner");
    const reviewer = await createAgent("reviewer");
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Test session",
        goal: "Exercise API",
        workspace: process.cwd(),
        participantAgentProfileIds: [planner.id, reviewer.id],
        maxRounds: 3
      }
    });
    expect(sessionResponse.statusCode).toBe(200);
    const session = sessionResponse.json();
    const plannerParticipant = session.participants.find((item: any) => item.agentProfileId === planner.id);
    const reviewerParticipant = session.participants.find((item: any) => item.agentProfileId === reviewer.id);

    const invokeResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/invoke`,
      payload: {
        toParticipantId: plannerParticipant.id,
        content: "Start here"
      }
    });
    expect(invokeResponse.statusCode).toBe(200);
	    const afterPlanner = await waitForSession(app, session.id, (item) => item.invocations?.[0]?.status === "succeeded");
	    expect(afterPlanner.messages.length).toBe(2);
	    expect(afterPlanner.invocations[0].status).toBe("succeeded");
	    expect(afterPlanner.invocations[0].participantId).toBe(plannerParticipant.id);

    const continueResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/continue`,
      payload: {
        sourceInvocationId: afterPlanner.invocations[0].id,
        toParticipantId: reviewerParticipant.id
      }
    });
    expect(continueResponse.statusCode).toBe(200);
	    const afterReviewer = await waitForSession(app, session.id, (item) => item.invocations?.length === 2 && item.invocations[1].status === "succeeded");
	    expect(afterReviewer.invocations.length).toBe(2);
	    expect(afterReviewer.invocations[1].participantId).toBe(reviewerParticipant.id);
	    expect(afterReviewer.messages.some((message: any) => message.messageType === "agent_to_agent")).toBe(true);
    expect(
      afterReviewer.messages.some(
        (message: any) =>
          message.messageType === "agent_to_user" && message.relatedInvocationId === afterReviewer.invocations[1].id
      )
    ).toBe(false);

    const logsResponse = await app.inject({
      method: "GET",
      url: `/api/invocations/${afterReviewer.invocations[1].id}/logs`
    });
    expect(logsResponse.statusCode).toBe(200);
    expect(logsResponse.json().prompt).toContain("Exercise API");
    await app.close();
  });

  it("defaults sessions to unlimited rounds", async () => {
    const app = makeTestApp();
    const agent = await createShellAgent(app, "unlimited rounds", `process.stdout.write("ok");`);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Unlimited",
        goal: "No automatic round limit",
        workspace: process.cwd(),
        participantAgentProfileIds: [agent.id]
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().maxRounds).toBe(0);
    await app.close();
  });

  it("creates, reuses, and resets native CLI runtime context for claude profiles", async () => {
    const app = makeTestApp();
    const profileResponse = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: {
        name: "fake claude",
        adapterType: "claude_cli",
        command: "/bin/echo",
        args: ["ok"],
        cwd: process.cwd(),
        rolePrompt: "Fake claude.",
        model: "sonnet",
        timeoutMs: 5000
      }
    });
    const profile = profileResponse.json();
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Native context",
        goal: "Reuse context",
        workspace: process.cwd(),
        participantAgentProfileIds: [profile.id]
      }
    });
    const session = created.json();
    const participantId = session.participants[0].id;

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/invoke`,
      payload: { toParticipantId: participantId, content: "first" }
    });
    const afterFirst = await waitForSession(app, session.id, (item) => item.invocations?.[0]?.status === "succeeded");
    const firstNativeId = afterFirst.participants[0].runtimeSession.nativeSessionId;
    expect(firstNativeId).toMatch(/[0-9a-f-]{36}/);
    expect(afterFirst.participants[0].runtimeSession.status).toBe("active");
    expect(afterFirst.invocations[0].nativeSessionId).toBe(firstNativeId);
    expect(afterFirst.invocations[0].commandSnapshot).toContain("--session-id");

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/invoke`,
      payload: { toParticipantId: participantId, content: "second" }
    });
    const afterSecond = await waitForSession(app, session.id, (item) => item.invocations?.length === 2 && item.invocations[1].status === "succeeded");
    expect(afterSecond.participants[0].runtimeSession.nativeSessionId).toBe(firstNativeId);
    expect(afterSecond.invocations[1].nativeSessionId).toBe(firstNativeId);
    expect(afterSecond.invocations[1].commandSnapshot).toContain("--resume");
    expect(afterSecond.invocations[1].commandSnapshot).not.toContain("--session-id");

    const reset = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/participants/${participantId}/context/reset`
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().participants[0].runtimeSession.nativeSessionId).toBeNull();
    expect(reset.json().participants[0].runtimeSession.status).toBe("reset");

    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/invoke`,
      payload: { toParticipantId: participantId, content: "third" }
    });
    const afterThird = await waitForSession(app, session.id, (item) => item.invocations?.length === 3 && item.invocations[2].status === "succeeded");
    expect(afterThird.participants[0].runtimeSession.nativeSessionId).not.toBe(firstNativeId);
    await app.close();
  });

  it("does not create native runtime context for shell profiles", async () => {
    const app = makeTestApp();
    const agent = await createShellAgent(app, "plain shell", `process.stdout.write("ok");`);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Shell context",
        goal: "No native context",
        workspace: process.cwd(),
        participantAgentProfileIds: [agent.id]
      }
    });
    expect(created.json().participants[0].runtimeSession).toBeNull();
    await app.close();
  });

  it("records timeout state and readable logs", async () => {
    const app = makeTestApp();
    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: {
        name: "slow agent",
        adapterType: "shell_command",
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('late'), 1000)"],
        cwd: process.cwd(),
        rolePrompt: "Slow.",
        model: "none",
        timeoutMs: 50
      }
    });
    const agent = agentResponse.json();
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Timeout session",
        goal: "Exercise timeout",
        workspace: process.cwd(),
        participantAgentProfileIds: [agent.id],
        maxFailures: 1
      }
    });
    const session = sessionResponse.json();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/invoke`,
      payload: {
        toParticipantId: session.participants[0].id,
        content: "Run slowly"
      }
    });
    expect(response.statusCode).toBe(200);
    const result = await waitForSession(app, session.id, (item) => item.invocations?.[0]?.status === "timeout");
    expect(result.status).toBe("timeout");
    expect(result.invocations[0].status).toBe("timeout");
    await app.close();
  });

  it("cancels a running invocation from the session", async () => {
    const app = makeTestApp();
    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: {
        name: "cancel agent",
        adapterType: "shell_command",
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('late'), 5000)"],
        cwd: process.cwd(),
        rolePrompt: "Slow.",
        model: "none",
        timeoutMs: 10000
      }
    });
    const agent = agentResponse.json();
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Cancel session",
        goal: "Exercise cancel",
        workspace: process.cwd(),
        participantAgentProfileIds: [agent.id]
      }
    });
    const session = sessionResponse.json();
    const invokeResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/invoke`,
      payload: {
        toParticipantId: session.participants[0].id,
        content: "Run slowly"
      }
    });
    expect(invokeResponse.statusCode).toBe(200);
    const cancelResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/cancel`
    });
    expect(cancelResponse.statusCode).toBe(200);
    const result = await waitForSession(app, session.id, (item) => item.invocations?.[0]?.status === "cancelled");
    expect(result.status).toBe("paused");
    expect(result.invocations[0].summary).toBe("Stopped by user.");
    await app.close();
  });

  it("deletes a session and cascades its records", async () => {
    const app = makeTestApp();
    const profiles = await app.inject({ method: "GET", url: "/api/agent-profiles" });
    const profile = profiles.json()[0];
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Delete me",
        goal: "Exercise delete",
        workspace: process.cwd(),
        participantAgentProfileIds: [profile.id]
      }
    });
    const session = created.json();
    const deleted = await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    expect(deleted.statusCode).toBe(200);
    const missing = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it("runs auto relay until maximum rounds are reached", async () => {
    const app = makeTestApp();
    const agentA = await createShellAgent(app, "relay a", `
      const prompt = process.argv[1] || "";
      process.stdout.write("A heard " + prompt.slice(0, 20) + "\\n[NEXT: relay b]");
    `);
    const agentB = await createShellAgent(app, "relay b", `
      const prompt = process.argv[1] || "";
      process.stdout.write("B heard " + prompt.slice(0, 20) + "\\n[NEXT: relay a]");
    `);

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Relay session",
        goal: "Relay twice",
        workspace: process.cwd(),
        participantAgentProfileIds: [agentA.id, agentB.id],
        edges: [{ fromAgentProfileId: agentA.id, toAgentProfileId: agentB.id }],
        routingMode: "auto_relay",
        maxRounds: 3
      }
    });
    expect(created.statusCode).toBe(200);
    const session = created.json();
    expect(session.routingMode).toBe("auto_relay");
    expect(session.edges).toHaveLength(1);

    const started = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/relay/start`,
      payload: { toParticipantId: session.participants[0].id, content: "Start relay" }
    });
    expect(started.statusCode).toBe(200);
    const result = await waitForSession(app, session.id, (item) => item.status === "completed");
    expect(result.status).toBe("completed");
    expect(result.invocations.length).toBe(3);
    expect(result.messages.some((message: any) => message.messageType === "agent_to_agent")).toBe(true);
    await app.close();
  });

  it("stops auto relay when an agent does not declare NEXT", async () => {
    const app = makeTestApp();
    const agent = await createShellAgent(app, "quiet relay", `process.stdout.write("done without next");`);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "No next",
        goal: "Stop cleanly",
        workspace: process.cwd(),
        participantAgentProfileIds: [agent.id],
        routingMode: "auto_relay"
      }
    });
    const session = created.json();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/relay/start`,
      payload: { toParticipantId: session.participants[0].id, content: "Start" }
    });
    const result = await waitForSession(app, session.id, (item) => item.status === "waiting_for_user");
    expect(result.status).toBe("waiting_for_user");
    expect(result.relayState.stopReason).toContain("did not request");
    await app.close();
  });

  it("stops auto relay when NEXT points outside allowed edges", async () => {
    const app = makeTestApp();
    const agentA = await createShellAgent(app, "edge a", `process.stdout.write("try bad\\n[NEXT: edge c]");`);
    const agentB = await createShellAgent(app, "edge b", `process.stdout.write("b");`);
    const agentC = await createShellAgent(app, "edge c", `process.stdout.write("c");`);
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Bad edge",
        goal: "Reject C",
        workspace: process.cwd(),
        participantAgentProfileIds: [agentA.id, agentB.id, agentC.id],
        edges: [{ fromAgentProfileId: agentA.id, toAgentProfileId: agentB.id }],
        routingMode: "auto_relay"
      }
    });
    const session = created.json();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/relay/start`,
      payload: { toParticipantId: session.participants[0].id, content: "Start" }
    });
    const result = await waitForSession(app, session.id, (item) => item.status === "waiting_for_user");
    expect(result.invocations.length).toBe(1);
    expect(result.relayState.stopReason).toContain("not connected");
    await app.close();
  });

  it("rejects mixed local and remote sessions", async () => {
    const app = makeTestApp();
    const local = await createShellAgent(app, "local only", `process.stdout.write("local");`);
    const remoteResponse = await app.inject({
      method: "POST",
      url: "/api/agent-profiles",
      payload: {
        name: "remote shell",
        adapterType: "shell_command",
        command: process.execPath,
        args: ["-e", "process.stdout.write('remote')"],
        cwd: process.cwd(),
        rolePrompt: "Remote.",
        model: "none",
        remote: { host: "user@example.test", sshKey: "~/.ssh/example", remoteCwd: "/tmp" }
      }
    });
    const remote = remoteResponse.json();
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        name: "Mixed",
        goal: "Reject mixed locality",
        workspace: process.cwd(),
        participantAgentProfileIds: [local.id, remote.id]
      }
    });
    expect(created.statusCode).toBe(400);
    await app.close();
  });
});

async function createShellAgent(app: ReturnType<typeof makeTestApp>, name: string, script: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/agent-profiles",
    payload: {
      name,
      adapterType: "shell_command",
      command: process.execPath,
      args: ["-e", script, "{prompt}"],
      cwd: process.cwd(),
      rolePrompt: `${name} role`,
      model: "none",
      opencodeAgent: "",
      skipPermissions: false,
      timeoutMs: 5000
    }
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}
