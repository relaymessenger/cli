/**
 * Relay wire shapes used by the channel server. These mirror the /v1 contract
 * from Relay's public agent API. The plugin keeps its own copies because the
 * installed runtime is standalone under ${CLAUDE_PLUGIN_ROOT}.
 */

export type RelayPartType = "text" | "media" | "voice_memo" | "link_preview" | "data";

export interface RelayPart {
  part_index?: number;
  type: RelayPartType;
  text?: string;
  url?: string;
  attachment_id?: string;
  duration_ms?: number;
  data?: unknown;
}

export interface RelaySender {
  kind: "user" | "agent" | "system";
  id: string;
}

export interface RelayMessage {
  id: string;
  conversation_id: string;
  sequence: number;
  sender: RelaySender;
  parts: RelayPart[];
  reply_to?: { message_id: string; part_index?: number } | null;
  fallback_text?: string;
  status?: string;
  created_at: string;
}

/** Developer-facing event envelope from GET /v1/events (AgentEventEnvelope). */
export interface RelayEvent {
  event_id: string;
  event_type: string;
  agent_id: string;
  created_at: string;
  data: unknown;
}

export interface PollEventsResponse {
  events: RelayEvent[];
  next_cursor: number;
}

/** Body for POST /v1/messages (agent bearer auth). */
export interface SendMessageBody {
  conversation_id: string;
  parts: RelayPart[];
  /** Required in a group, and spent by the message that carries it. */
  invocation_id?: string;
}

/** Fields of notifications/claude/channel/permission_request params. */
export interface PermissionRequest {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export type PermissionBehavior = "allow" | "deny";

export interface PermissionVerdict {
  request_id: string;
  behavior: PermissionBehavior;
}
