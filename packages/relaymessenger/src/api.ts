/**
 * Thin client for the Relay public API (https://docs.relayapp.im).
 * Wire shapes follow Relay's public OpenAPI contract at
 * https://docs.relayapp.im/api-reference/openapi.yaml.
 */
import type { RelayEvent, RelayMessage } from "./store.js";

export const PRODUCTION_ORIGIN = "https://api.relayapp.im";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "[::1]" || /^127\./.test(host);
}

/**
 * Bearer tokens may only leave over HTTPS. Plain HTTP is accepted solely for
 * explicit loopback development servers, and base URLs cannot smuggle a path,
 * query, credentials, or fragment into request construction.
 */
export function normalizeApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Relay API origin: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("Relay API origin must contain only scheme and host (no credentials, path, query, or fragment)");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("Relay API origin must use HTTPS (plain HTTP is allowed only on loopback)");
  }
  return url.origin;
}

/**
 * Development/testing override for the Relay API origin. Production stays the
 * default; when RELAY_API_ORIGIN is set it passes normalizeApiOrigin, so the
 * loopback carve-out there remains the only place plain HTTP is accepted.
 */
export function resolveApiOrigin(fallback: string = PRODUCTION_ORIGIN): string {
  const override = process.env.RELAY_API_ORIGIN?.trim();
  if (!override) return fallback;
  return normalizeApiOrigin(override);
}

export class RelayApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    /**
     * `error.details` from the Relay error body. The cursor faults carry the
     * recovery target there (`highest_delivered_cursor`, `latest_sequence`),
     * so it has to survive the throw.
     */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

export interface PairingCreated {
  pairing_id: string;
  code: string;
  url: string;
  poll_token: string;
  expires_in: number;
}

export type PairingStatus =
  | { status: "pending" }
  | { status: "claimed"; agent_token: string; agent?: Record<string, unknown> };

export interface EventsPage {
  events: RelayEvent[];
  next_cursor: number;
}

export interface EventCursorReconciliation {
  reconciled: true;
  resume_cursor: number;
}

/** One row of GET /v1/conversations (AgentConversation in the OpenAPI contract). */
export interface RelayConversation {
  id: string;
  kind?: "direct" | "group";
  last_sequence?: number;
  last_message_at?: string | null;
}

export interface PostMessageBody {
  conversation_id: string;
  parts: Array<Record<string, unknown>>;
  reply_to?: { message_id: string; part_index?: number };
  /**
   * Required in a group: the id Relay supplied on the invocation this message
   * answers. The server rejects a group agent message without it, and consumes
   * the invocation on commit, so exactly one message may carry a given id.
   */
  invocation_id?: string;
}

export class RelayClient {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly token?: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.origin = normalizeApiOrigin(origin);
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      bearer?: string;
      timeoutMs?: number;
      expectStatus?: number[];
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    const bearer = opts.bearer ?? this.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(`${this.origin}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const okStatuses = opts.expectStatus ?? [200, 201, 202, 204];
    if (!okStatuses.includes(res.status)) {
      const code = json?.error?.code ?? json?.code;
      const message = json?.error?.message ?? json?.message ?? text.slice(0, 300) ?? res.statusText;
      const details = json?.error?.details;
      throw new RelayApiError(
        res.status,
        code,
        `${method} ${path} → ${res.status}: ${message}`,
        details && typeof details === "object" && !Array.isArray(details) ? details : undefined,
      );
    }
    return json as T;
  }

  // — Pairing (unauthenticated create; poll_token bearer for polling) —

  createPairing(deviceName: string, engine?: string): Promise<PairingCreated> {
    return this.request("POST", "/v1/pairings", {
      body: { device_name: deviceName, ...(engine ? { engine } : {}) },
    });
  }

  waitPairing(pairingId: string, pollToken: string): Promise<PairingStatus> {
    return this.request("GET", `/v1/pairings/${pairingId}?wait=true`, {
      bearer: pollToken,
      timeoutMs: 45_000,
    });
  }

  // — Agent-authenticated surface —

  getMe(): Promise<Record<string, unknown>> {
    return this.request("GET", "/v1/agents/me");
  }

  getEvents(cursor: number, timeoutS = 25, limit = 100): Promise<EventsPage> {
    const qs = `cursor=${cursor}&timeout=${timeoutS}&limit=${limit}`;
    return this.request("GET", `/v1/events?${qs}`, { timeoutMs: (timeoutS + 15) * 1000 });
  }

  reconcileEvents(expiredCursor: number): Promise<EventCursorReconciliation> {
    return this.request("POST", "/v1/events/reconcile", {
      body: { expired_cursor: expiredCursor, history_reconciled: true },
      headers: { "idempotency-key": `event-cursor-reconcile:${expiredCursor}` },
    });
  }

  postMessage(
    body: PostMessageBody,
    idempotencyKey: string,
  ): Promise<{ message_id: string; message: RelayMessage }> {
    return this.request("POST", "/v1/messages", {
      body,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  /**
   * Conversations this agent still participates in, newest activity first.
   * The canonical inventory used to reconcile after a cursor fault, when the
   * event log can no longer say which conversations moved.
   */
  listConversations(limit = 50): Promise<{ conversations: RelayConversation[] }> {
    return this.request("GET", `/v1/conversations?limit=${limit}`);
  }

  listMessages(conversationId: string, limit = 20): Promise<{ messages: RelayMessage[] }> {
    return this.request("GET", `/v1/conversations/${conversationId}/messages?limit=${limit}`);
  }

  setTyping(
    conversationId: string,
    started: boolean,
    label?: string,
    invocationId?: string,
  ): Promise<void> {
    return this.request("POST", `/v1/conversations/${conversationId}/typing`, {
      // Group typing is gated on a still-pending invocation, so the id has to
      // ride along until the reply consumes it.
      body: {
        started,
        ...(label ? { label } : {}),
        ...(invocationId ? { invocation_id: invocationId } : {}),
      },
    });
  }

  markRead(conversationId: string, messageId: string): Promise<void> {
    return this.request("POST", `/v1/conversations/${conversationId}/read`, {
      body: { message_id: messageId },
    });
  }
}
