import type {
  AgentProfile,
  AgentProfileInput,
  AgentTestResult,
  CreateSessionInput,
  Invocation,
  InvocationLogs,
  InvokeSessionInput,
  RuntimeConfig,
  Session
} from "@loopy/shared";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    headers,
    ...init
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error ? `${data.error}${data.detail ? ` ${data.detail}` : ""}` : response.statusText);
  }
  return data as T;
}

export const api = {
  health: () => request<{ ok: boolean; dataDir: string }>("/api/health"),
  runtimeConfig: () => request<RuntimeConfig>("/api/runtime-config"),
  profiles: () => request<AgentProfile[]>("/api/agent-profiles"),
  createProfile: (input: AgentProfileInput) =>
    request<AgentProfile>("/api/agent-profiles", { method: "POST", body: JSON.stringify(input) }),
  updateProfile: (id: string, input: AgentProfileInput) =>
    request<AgentProfile>(`/api/agent-profiles/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteProfile: (id: string) =>
    request<{ ok: boolean }>(`/api/agent-profiles/${id}`, { method: "DELETE" }),
  testProfile: (id: string) => request<AgentTestResult>(`/api/agent-profiles/${id}/test`, { method: "POST" }),
  sessions: () => request<Session[]>("/api/sessions"),
  createSession: (input: CreateSessionInput) =>
    request<Session>("/api/sessions", { method: "POST", body: JSON.stringify(input) }),
  session: (id: string) => request<Session>(`/api/sessions/${id}`),
  invoke: (sessionId: string, input: InvokeSessionInput) =>
    request<Session>(`/api/sessions/${sessionId}/invoke`, { method: "POST", body: JSON.stringify(input) }),
  continue: (sessionId: string, sourceInvocationId: string, toParticipantId: string) =>
    request<Session>(`/api/sessions/${sessionId}/continue`, {
      method: "POST",
      body: JSON.stringify({ sourceInvocationId, toParticipantId })
    }),
  pause: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}/pause`, { method: "POST" }),
  cancel: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}/cancel`, { method: "POST" }),
  startRelay: (sessionId: string, toParticipantId: string, content: string) =>
    request<Session>(`/api/sessions/${sessionId}/relay/start`, {
      method: "POST",
      body: JSON.stringify({ toParticipantId, content })
    }),
  stopRelay: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}/relay/stop`, { method: "POST" }),
  resume: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}/resume`, { method: "POST" }),
  end: (sessionId: string) => request<Session>(`/api/sessions/${sessionId}/end`, { method: "POST" }),
  deleteSession: (sessionId: string) => request<{ ok: boolean }>(`/api/sessions/${sessionId}`, { method: "DELETE" }),
  resetParticipantContext: (sessionId: string, participantId: string) =>
    request<Session>(`/api/sessions/${sessionId}/participants/${participantId}/context/reset`, { method: "POST" }),
  invocation: (id: string) => request<Invocation>(`/api/invocations/${id}`),
  cancelInvocation: (id: string) => request<Invocation>(`/api/invocations/${id}/cancel`, { method: "POST" }),
  logs: (id: string) => request<InvocationLogs>(`/api/invocations/${id}/logs`)
};
