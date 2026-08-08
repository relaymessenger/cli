import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RelayApiError, type EventsPage, type RelayClient } from "./api.js";
import type { EngineAdapter, TurnCallbacks } from "./engine/types.js";
import {
  MAX_PERMISSION_PREVIEW_CHARS,
  PermissionBroker,
  buildPermissionCard,
  parseVerdictDataPart,
  parseVerdictText,
} from "./permissions.js";
import {
  ReceiveLoop,
  promptTextFromMessages,
  turnIdempotencyKey,
  undeliveredCursorTarget,
} from "./receive.js";
import {
  ApprovalStore,
  StateStore,
  type BridgeState,
  type PendingApproval,
  type RelayEvent,
} from "./store.js";

const OWNER = "usr_owner";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "relaymessenger-test-"));
}

function userMessageEvent(
  eventId: string,
  conversationId: string,
  text: string,
  sequence = 1,
  senderId = OWNER,
): RelayEvent {
  return {
    event_id: eventId,
    event_type: "message.received",
    created_at: new Date().toISOString(),
    data: {
      message: {
        id: `msg_${eventId}`,
        conversation_id: conversationId,
        sequence,
        sender: { kind: "user", id: senderId },
        parts: [{ type: "text", text }],
        fallback_text: text,
      },
    },
  };
}

function fakeClient(options: { pages?: EventsPage[] } = {}) {
  const pages = [...(options.pages ?? [])];
  const posted: Array<{ body: any; key: string }> = [];
  const typings: Array<{
    conversationId: string;
    started: boolean;
    label?: string;
    invocationId?: string;
  }> = [];
  const client = {
    origin: "http://fake",
    async getEvents(cursor: number): Promise<EventsPage> {
      const page = pages.shift();
      return page ?? { events: [], next_cursor: cursor };
    },
    pushPage(page: EventsPage) {
      pages.push(page);
    },
    async postMessage(body: any, key: string) {
      posted.push({ body, key });
      return {
        message_id: `msg_out_${posted.length}`,
        message: {
          id: `msg_out_${posted.length}`,
          conversation_id: body.conversation_id,
          sequence: 100 + posted.length,
          sender: { kind: "agent" as const, id: "agt_1" },
          parts: body.parts,
          fallback_text: "",
        },
      };
    },
    async setTyping(
      conversationId: string,
      started: boolean,
      label?: string,
      invocationId?: string,
    ) {
      typings.push({ conversationId, started, label, invocationId });
    },
    async listMessages() {
      return { messages: [] };
    },
  };
  return {
    client: client as unknown as RelayClient & { pushPage(p: EventsPage): void },
    posted,
    typings,
  };
}

function fakeEngine() {
  const turns: Array<{ conversationId: string; prompt: string }> = [];
  let permissionAsker: ((cb: TurnCallbacks) => Promise<void>) | undefined;
  let gate: Promise<void> | undefined;
  const engine: EngineAdapter = {
    engine: "claude",
    async startTurn(ref, promptText, callbacks) {
      turns.push({ conversationId: ref.conversationId, prompt: promptText });
      if (permissionAsker) await permissionAsker(callbacks);
      if (gate) await gate;
      return { text: `echo: ${promptText}`, stopReason: "end_turn" };
    },
    async abort() {},
    async dispose() {},
  };
  return {
    engine,
    turns,
    setPermissionAsker(fn: (cb: TurnCallbacks) => Promise<void>) {
      permissionAsker = fn;
    },
    setTurnGate(promise: Promise<void>) {
      gate = promise;
    },
  };
}

function makeLoop(home: string, pages: EventsPage[], debounceMs = 25) {
  const { client, posted, typings } = fakeClient({ pages });
  const state = new StateStore(home);
  const approvals = new ApprovalStore(home);
  const fake = fakeEngine();
  const broker = new PermissionBroker(client, approvals, 60_000);
  const loop = new ReceiveLoop(client, state, fake.engine, broker, {
    ownerUserId: OWNER,
    debounceMs,
    cwd: "/tmp",
  });
  return { loop, state, approvals, client, posted, typings, broker, ...fake };
}

function groupMessageEvent(
  eventId: string,
  conversationId: string,
  invocationId: string,
  text: string,
  sequence = 1,
): RelayEvent {
  const event = userMessageEvent(eventId, conversationId, text, sequence);
  event.data!.invocation_id = invocationId;
  return event;
}

function diskState(home: string): BridgeState {
  return JSON.parse(readFileSync(join(home, "state.json"), "utf8"));
}

function pendingApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "abcde",
    conversation_id: "cnv_a",
    created_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    options: [
      { option_id: "opt_allow", label: "Allow", kind: "allow_once" },
      { option_id: "opt_deny", label: "Deny", kind: "reject_once" },
    ],
    source: "acp",
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("cursor advances only with the durably persisted queue (single atomic write)", async () => {
  const home = tempHome();
  const { loop } = makeLoop(home, [
    { events: [userMessageEvent("evt_1", "cnv_a", "hello")], next_cursor: 7 },
  ]);
  await loop.pollOnce();
  const persisted = diskState(home);
  assert.equal(persisted.cursor, 7);
  assert.equal(persisted.pending_events.cnv_a?.length, 1);
  assert.equal(persisted.pending_events.cnv_a?.[0]?.event_id, "evt_1");
  loop.stop();
});

test("cursor is not acked when persistence fails", async () => {
  const home = tempHome();
  const { client } = fakeClient({
    pages: [{ events: [userMessageEvent("evt_1", "cnv_a", "hello")], next_cursor: 9 }],
  });
  const state = new StateStore(home);
  state.persist(); // seed disk with cursor 0
  const originalPersist = state.persist.bind(state);
  let fail = true;
  state.persist = () => {
    if (fail) throw new Error("disk full");
    originalPersist();
  };
  const { engine } = fakeEngine();
  const broker = new PermissionBroker(client, new ApprovalStore(home), 60_000);
  const loop = new ReceiveLoop(client, state, engine, broker, {
    ownerUserId: OWNER,
    debounceMs: 10,
  });
  await assert.rejects(() => loop.pollOnce(), /disk full/);
  fail = false;
  // The durable view — which feeds the next poll's cursor after a restart —
  // must still be at 0 with an empty queue.
  const persisted = diskState(home);
  assert.equal(persisted.cursor, 0);
  assert.equal(Object.keys(persisted.pending_events).length, 0);
  loop.stop();
});

test("events are processed in order within a conversation", async () => {
  const home = tempHome();
  const { loop, turns } = makeLoop(home, [
    {
      events: [
        userMessageEvent("evt_1", "cnv_a", "first", 1),
        userMessageEvent("evt_2", "cnv_a", "second", 2),
      ],
      next_cursor: 2,
    },
  ]);
  await loop.pollOnce();
  await sleep(80);
  await loop.settle();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.prompt, "first\n\nsecond");
  loop.stop();
});

test("event_id dedupe: repeated delivery is enqueued once", async () => {
  const home = tempHome();
  const duplicated = userMessageEvent("evt_dup", "cnv_a", "hello");
  const { loop, turns, state } = makeLoop(home, [
    { events: [duplicated, duplicated], next_cursor: 1 },
    { events: [duplicated], next_cursor: 1 },
  ]);
  await loop.pollOnce();
  await loop.pollOnce();
  assert.equal(state.current.pending_events.cnv_a?.length, 1);
  await sleep(80);
  await loop.settle();
  assert.equal(turns.length, 1);
  loop.stop();
});

test("debounce coalesces rapid messages into one turn; separate conversations stay separate", async () => {
  const home = tempHome();
  const { loop, turns, posted } = makeLoop(
    home,
    [
      { events: [userMessageEvent("evt_1", "cnv_a", "part one")], next_cursor: 1 },
      {
        events: [
          userMessageEvent("evt_2", "cnv_a", "part two", 2),
          userMessageEvent("evt_3", "cnv_b", "other convo"),
        ],
        next_cursor: 3,
      },
    ],
    40,
  );
  await loop.pollOnce();
  await loop.pollOnce(); // arrives within the debounce window
  await sleep(150);
  await loop.settle();
  assert.equal(turns.length, 2);
  const byConversation = Object.fromEntries(turns.map((turn) => [turn.conversationId, turn.prompt]));
  assert.equal(byConversation.cnv_a, "part one\n\npart two");
  assert.equal(byConversation.cnv_b, "other convo");
  // Quiet finalization: one POST per turn, keyed on the turn.
  assert.equal(posted.length, 2);
  assert.match(posted[0]!.key, /^relay-turn-[0-9a-f]{40}$/);
  // Queue drained durably.
  assert.equal(Object.keys(diskState(home).pending_events).length, 0);
  loop.stop();
});

test("H1 regression: a message arriving mid-turn is kept and triggers a follow-up turn", async () => {
  const home = tempHome();
  const { loop, turns, client, setTurnGate } = makeLoop(
    home,
    [{ events: [userMessageEvent("evt_1", "cnv_a", "first", 1)], next_cursor: 1 }],
    20,
  );
  let releaseFirstTurn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });
  setTurnGate(gate);

  await loop.pollOnce();
  await sleep(60); // debounce fires; first turn is now blocked on the gate
  assert.equal(turns.length, 1);

  // Second message lands while the first turn is still running.
  client.pushPage({ events: [userMessageEvent("evt_2", "cnv_a", "second", 2)], next_cursor: 2 });
  await loop.pollOnce();
  // It must be durably queued, not clobbered by the in-flight turn.
  assert.equal(diskState(home).pending_events.cnv_a?.length, 2);

  releaseFirstTurn();
  await sleep(80); // first turn finishes; its follow-up flush is scheduled
  await loop.settle();
  await sleep(80); // follow-up debounce window
  await loop.settle();

  assert.equal(turns.length, 2, "mid-turn message must start a follow-up turn");
  assert.equal(turns[1]!.prompt, "second");
  assert.equal(Object.keys(diskState(home).pending_events).length, 0);
  loop.stop();
});

test("owner gate: non-owner messages are ignored; first owner message pins the conversation", async () => {
  const home = tempHome();
  const { loop, turns, state } = makeLoop(home, [
    {
      events: [
        userMessageEvent("evt_intruder", "cnv_x", "ignore me", 1, "usr_intruder"),
        userMessageEvent("evt_owner", "cnv_a", "hello", 1, OWNER),
      ],
      next_cursor: 2,
    },
  ]);
  await loop.pollOnce();
  assert.equal(state.current.pending_events.cnv_x, undefined);
  assert.equal(state.current.pending_events.cnv_a?.length, 1);
  // Owner conversation pinned by the first OWNER message, not the intruder's.
  assert.equal(state.current.owner_conversation_id, "cnv_a");
  await sleep(80);
  await loop.settle();
  assert.equal(turns.length, 1);
  loop.stop();
});

test("turn failure is surfaced and not replayed because tools may have partially run", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient({
    pages: [{ events: [userMessageEvent("evt_1", "cnv_a", "hello")], next_cursor: 1 }],
  });
  const state = new StateStore(home);
  const engine: EngineAdapter = {
    engine: "claude",
    async startTurn() {
      throw new Error("engine crashed");
    },
    async abort() {},
    async dispose() {},
  };
  const broker = new PermissionBroker(client, new ApprovalStore(home), 60_000);
  const loop = new ReceiveLoop(client, state, engine, broker, {
    ownerUserId: OWNER,
    debounceMs: 10,
  });
  await loop.pollOnce();
  await sleep(60);
  await loop.settle();
  assert.equal(diskState(home).pending_events.cnv_a, undefined);
  assert.equal(diskState(home).attempted_turns?.cnv_a, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body.parts[0].text, /turn failed/i);
  loop.stop();
});

test("crash marker drops an interrupted tool turn instead of executing it twice", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const state = new StateStore(home);
  const event = userMessageEvent("evt_crash", "cnv_a", "deploy it");
  const key = turnIdempotencyKey("cnv_a", [event.event_id]);
  state.current.pending_events.cnv_a = [event];
  (state.current.attempted_turns ??= {}).cnv_a = {
    turn_key: key,
    event_ids: [event.event_id],
    started_at: new Date().toISOString(),
  };
  state.persist();
  const fake = fakeEngine();
  const loop = new ReceiveLoop(
    client,
    new StateStore(home),
    fake.engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp" },
  );
  await loop.runTurn("cnv_a");
  assert.equal(fake.turns.length, 0, "interrupted engine turn must not run again");
  assert.equal(diskState(home).pending_events.cnv_a, undefined);
  assert.equal(posted.length, 1);
  assert.match(posted[0]!.body.parts[0].text, /not retried automatically/);
  loop.stop();
});

test("crash recovery drops only the attempted prefix when a new message arrived", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const state = new StateStore(home);
  const attemptedEvent = userMessageEvent("evt_attempted", "cnv_a", "deploy it", 1);
  const laterEvent = userMessageEvent("evt_later", "cnv_a", "check status", 2);
  const key = turnIdempotencyKey("cnv_a", [attemptedEvent.event_id]);
  state.current.pending_events.cnv_a = [attemptedEvent, laterEvent];
  (state.current.attempted_turns ??= {}).cnv_a = {
    turn_key: key,
    event_ids: [attemptedEvent.event_id],
    started_at: new Date().toISOString(),
  };
  state.persist();
  const fake = fakeEngine();
  const loop = new ReceiveLoop(
    client,
    new StateStore(home),
    fake.engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp" },
  );

  await loop.runTurn("cnv_a");
  assert.equal(fake.turns.length, 0, "attempted prefix must not execute again");
  assert.deepEqual(
    diskState(home).pending_events.cnv_a?.map((event) => event.event_id),
    ["evt_later"],
  );
  await loop.runTurn("cnv_a");
  assert.deepEqual(fake.turns.map((turn) => turn.prompt), ["check status"]);
  assert.equal(posted.filter((entry) => entry.key.endsWith("-crashed")).length, 1);
  loop.stop();
});

test("completed reply outbox redelivers after restart without rerunning the engine", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const state = new StateStore(home);
  const event = userMessageEvent("evt_done", "cnv_a", "send it");
  const key = turnIdempotencyKey("cnv_a", [event.event_id]);
  state.current.pending_events.cnv_a = [event];
  (state.current.attempted_turns ??= {}).cnv_a = {
    turn_key: key,
    event_ids: [event.event_id],
    started_at: new Date().toISOString(),
  };
  (state.current.pending_replies ??= {})[key] = {
    conversation_id: "cnv_a",
    event_ids: [event.event_id],
    text: "finished before the crash",
    created_at: new Date().toISOString(),
  };
  state.persist();
  const fake = fakeEngine();
  const loop = new ReceiveLoop(
    client,
    new StateStore(home),
    fake.engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp" },
  );
  await loop.runTurn("cnv_a");
  assert.equal(fake.turns.length, 0);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.key, key);
  assert.equal(posted[0]!.body.parts[0].text, "finished before the crash");
  const persisted = diskState(home);
  assert.equal(persisted.pending_events.cnv_a, undefined);
  assert.equal(persisted.pending_replies?.[key], undefined);
  loop.stop();
});

test("permission card reply is consumed by the broker, not forwarded to the engine", async () => {
  const home = tempHome();
  const { loop, turns, posted, broker, approvals, setPermissionAsker } = makeLoop(home, [
    { events: [userMessageEvent("evt_1", "cnv_a", "do the thing")], next_cursor: 1 },
  ]);
  let decision: unknown;
  setPermissionAsker(async (callbacks) => {
    decision = await callbacks.onPermissionAsk({
      requestId: "perm_test1",
      toolName: "bash",
      options: [
        { optionId: "opt_allow", label: "Allow", kind: "allow_once" },
        { optionId: "opt_deny", label: "Deny", kind: "reject_once" },
      ],
    });
  });
  await loop.pollOnce();
  await sleep(80);
  // While the engine turn is blocked on the ask, the approval file is durable
  // and the card is posted.
  const pending = approvals.list();
  assert.equal(pending.length, 1);
  const requestId = pending[0]!.request_id;
  assert.match(requestId, /^[a-km-z]{5}$/);
  const card = posted.find((entry) => entry.key === `agent-perm-${requestId}`);
  assert.ok(card, "permission card was posted");
  // Channel-plugin wire shape: text part with the yes/no fallback + data part.
  assert.equal(card!.body.parts[0].type, "text");
  assert.match(card!.body.parts[0].text, new RegExp(`yes ${requestId}`));
  const data = card!.body.parts[1];
  assert.equal(data.type, "data");
  assert.equal(data.data.kind, "agent_permission_request");
  assert.equal(data.data.request_id, requestId);
  assert.deepEqual(
    data.data.options.map((option: any) => option.id),
    ["allow", "deny"],
  );
  assert.deepEqual(data.data.options[0].origin, {
    kind: "agent_permission_request",
    request_id: requestId,
  });

  // Phone taps Allow → text fallback reply "yes <id>".
  const tap = userMessageEvent("evt_tap", "cnv_a", `yes ${requestId}`, 3);
  assert.equal(broker.consumeReply(tap.data!.message!), true);
  await loop.settle();
  // The verdict reached the blocked engine callback mapped onto the ACP option.
  assert.deepEqual(decision, { behavior: "selected", optionId: "opt_allow" });
  // The tap never became an engine prompt, and the file was consumed.
  assert.equal(turns.length, 1);
  assert.equal(approvals.list().length, 0);
  loop.stop();
});

test("M1 regression: a verdict from the wrong conversation does not resolve the approval", () => {
  const home = tempHome();
  const { client } = fakeClient();
  const approvals = new ApprovalStore(home);
  approvals.create(pendingApproval({ request_id: "abcde", conversation_id: "cnv_a" }));
  const broker = new PermissionBroker(client, approvals, 60_000);

  const wrongConversation = userMessageEvent("evt_w", "cnv_other", "yes abcde", 5);
  // Verdict-shaped → swallowed (never an engine prompt) …
  assert.equal(broker.consumeReply(wrongConversation.data!.message!), true);
  // … but the approval stays pending and unresolved.
  const still = approvals.get("abcde");
  assert.ok(still);
  assert.equal(still!.resolution, undefined);

  // The right conversation resolves it.
  const right = userMessageEvent("evt_r", "cnv_a", "yes abcde", 6);
  assert.equal(broker.consumeReply(right.data!.message!), true);
  assert.equal(approvals.get("abcde")?.resolution?.behavior, "allow");
});

test("H2: hook-armed approval is resolved by the loop and consumed by the hook waiter", () => {
  const home = tempHome();
  const { client } = fakeClient();
  // Hook process arms the approval (create-once).
  const hookStore = new ApprovalStore(home);
  hookStore.create(pendingApproval({ request_id: "fghij", source: "hook" }));
  assert.throws(() => hookStore.create(pendingApproval({ request_id: "fghij" })), /EEXIST/);

  // Loop process (separate store instance) sees the tap and writes the resolution.
  const broker = new PermissionBroker(client, new ApprovalStore(home), 60_000);
  const tap = userMessageEvent("evt_tap", "cnv_a", "no fghij", 4);
  assert.equal(broker.consumeReply(tap.data!.message!), true);

  // Hook waiter reads the resolution and consumes the file.
  const resolved = hookStore.get("fghij");
  assert.equal(resolved?.resolution?.behavior, "deny");
  hookStore.consume("fghij");
  assert.equal(hookStore.get("fghij"), undefined);
});

test("M2 regression: sweep keeps unconsumed in-window resolutions, ages out only past grace", () => {
  const home = tempHome();
  const approvals = new ApprovalStore(home);
  // Resolved but unconsumed, deadline passed but inside grace → must survive.
  approvals.create(
    pendingApproval({
      request_id: "aaaaa",
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
      resolution: { behavior: "allow", decided_at: new Date().toISOString() },
    }),
  );
  // Deadline + grace long past → aged out even with a resolution.
  approvals.create(
    pendingApproval({
      request_id: "bbbbb",
      deadline_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      resolution: { behavior: "allow", decided_at: new Date().toISOString() },
    }),
  );
  const removed = approvals.sweep(Date.now(), 10 * 60 * 1000);
  assert.deepEqual(removed, ["bbbbb"]);
  assert.ok(approvals.get("aaaaa"), "in-grace unconsumed resolution must survive the sweep");
  assert.equal(approvals.get("bbbbb"), undefined);
});

test("approval timeout denies via the reject option and consumes the file", async () => {
  const home = tempHome();
  const { client, posted } = fakeClient();
  const approvals = new ApprovalStore(home);
  const broker = new PermissionBroker(client, approvals, 50);
  const decision = await broker.ask(
    "cnv_a",
    {
      requestId: "perm_t",
      toolName: "bash",
      options: [
        { optionId: "opt_allow", label: "Allow", kind: "allow_once" },
        { optionId: "opt_deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "claude",
  );
  assert.deepEqual(decision, { behavior: "selected", optionId: "opt_deny" });
  assert.equal(posted.length, 1);
  assert.equal(approvals.list().length, 0);
});

test("approval waiter is armed before posting, so an immediate phone reply wins", async () => {
  const home = tempHome();
  const approvals = new ApprovalStore(home);
  let broker!: PermissionBroker;
  const client = {
    origin: "https://api.relayapp.im",
    async postMessage(body: any) {
      const requestId = body.parts[1].data.request_id as string;
      const tap = userMessageEvent("evt_fast", "cnv_a", `yes ${requestId}`, 2);
      assert.equal(broker.consumeReply(tap.data!.message!), true);
      return { message_id: "msg_card", message: { sequence: 1 } };
    },
  } as unknown as RelayClient;
  broker = new PermissionBroker(client, approvals, 60_000);
  const decision = await broker.ask(
    "cnv_a",
    {
      requestId: "engine_request",
      toolName: "bash",
      inputPreview: "git status",
      options: [
        { optionId: "allow", label: "Allow", kind: "allow_once" },
        { optionId: "deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "claude",
  );
  assert.deepEqual(decision, { behavior: "selected", optionId: "allow" });
  assert.equal(approvals.list().length, 0);
});

test("security-sensitive approval input is complete or the ask fails closed", async () => {
  const full = `printf start\n${"x".repeat(2_000)}\nprintf dangerous-suffix`;
  const card = buildPermissionCard({
    requestId: "abcde",
    conversationId: "cnv_a",
    engineLabel: "Codex",
    toolName: "shell",
    inputPreview: full,
  });
  assert.equal(card.body.parts[1]!.data.input_preview, full);
  assert.match(card.body.parts[0]!.text as string, /dangerous-suffix$/m);
  assert.throws(
    () =>
      buildPermissionCard({
        requestId: "abcde",
        conversationId: "cnv_a",
        engineLabel: "Codex",
        inputPreview: "x".repeat(MAX_PERMISSION_PREVIEW_CHARS + 1),
      }),
    /only permits approval when the full/,
  );

  const { client, posted } = fakeClient();
  const broker = new PermissionBroker(client, new ApprovalStore(tempHome()), 60_000);
  const decision = await broker.ask(
    "cnv_a",
    {
      requestId: "too_large",
      inputPreview: "x".repeat(MAX_PERMISSION_PREVIEW_CHARS + 1),
      options: [
        { optionId: "allow", label: "Allow", kind: "allow_once" },
        { optionId: "deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "codex",
  );
  assert.deepEqual(decision, { behavior: "selected", optionId: "deny" });
  assert.equal(posted.length, 0, "unsafe partial card must never be sent");

  const incomplete = await broker.ask(
    "cnv_a",
    {
      requestId: "incomplete",
      toolName: "shell",
      title: "Run command",
      inputComplete: false,
      options: [
        { optionId: "allow", label: "Allow", kind: "allow_once" },
        { optionId: "deny", label: "Deny", kind: "reject_once" },
      ],
    },
    "claude",
  );
  assert.deepEqual(incomplete, { behavior: "selected", optionId: "deny" });
  assert.equal(posted.length, 0, "missing raw input must never post an approval");
});

test("verdict parsing matches the channel plugin: data-part tap and text fallback", () => {
  assert.deepEqual(parseVerdictText("  YES abcde "), { request_id: "abcde", behavior: "allow" });
  assert.deepEqual(parseVerdictText("n zzzzz"), { request_id: "zzzzz", behavior: "deny" });
  assert.equal(parseVerdictText("yes ablde"), null); // "l" is outside the alphabet
  assert.equal(parseVerdictText("sounds good"), null);
  assert.deepEqual(
    parseVerdictDataPart({
      origin: { kind: "agent_permission_request", request_id: "abcde" },
      option_id: "allow",
    }),
    { request_id: "abcde", behavior: "allow" },
  );
  assert.deepEqual(
    parseVerdictDataPart({ origin: { request_id: "abcde" }, option: "deny" }),
    { request_id: "abcde", behavior: "deny" },
  );
  assert.deepEqual(
    parseVerdictDataPart({ kind: "agent_permission_request", request_id: "mnopq", behavior: "reject" }),
    { request_id: "mnopq", behavior: "deny" },
  );
  assert.equal(parseVerdictDataPart({ request_id: "toolong", option: "allow" }), null);
});

test("idempotency key is stable for the exact event batch and prompt text falls back", () => {
  assert.equal(turnIdempotencyKey("cnv_a", ["evt_9"]), turnIdempotencyKey("cnv_a", ["evt_9"]));
  assert.notEqual(turnIdempotencyKey("cnv_a", ["evt_9"]), turnIdempotencyKey("cnv_a", ["evt_8"]));
  assert.notEqual(
    turnIdempotencyKey("cnv_a", ["evt_9"]),
    turnIdempotencyKey("cnv_a", ["evt_9", "evt_10"]),
  );
  const text = promptTextFromMessages([
    {
      id: "m1",
      conversation_id: "cnv_a",
      sequence: 1,
      sender: { kind: "user", id: "u" },
      parts: [{ type: "media", url: "https://x" }],
      fallback_text: "[photo]",
    },
  ]);
  assert.equal(text, "[photo]");
});

test("group reply and typing both carry the invocation the turn is answering", async () => {
  const home = tempHome();
  const { loop, posted, typings } = makeLoop(home, [
    {
      events: [groupMessageEvent("evt_g1", "cnv_group", "inv_01", "@claude ship it")],
      next_cursor: 3,
    },
  ]);
  await loop.pollOnce();
  await sleep(80);
  await loop.settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.conversation_id, "cnv_group");
  assert.equal(posted[0].body.invocation_id, "inv_01");
  assert.ok(typings.length >= 2);
  assert.ok(typings.every((call) => call.invocationId === "inv_01"));
  loop.stop();
});

test("a direct turn still sends no invocation_id", async () => {
  const home = tempHome();
  const { loop, posted, typings } = makeLoop(home, [
    { events: [userMessageEvent("evt_d1", "cnv_direct", "hey")], next_cursor: 2 },
  ]);
  await loop.pollOnce();
  await sleep(80);
  await loop.settle();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.invocation_id, undefined);
  assert.ok(typings.every((call) => call.invocationId === undefined));
  loop.stop();
});

test("two group invocations in one debounce window get one reply each, never sharing an id", async () => {
  const home = tempHome();
  const { loop, posted, turns } = makeLoop(home, [
    {
      events: [
        groupMessageEvent("evt_g1", "cnv_group", "inv_01", "first", 1),
        groupMessageEvent("evt_g2", "cnv_group", "inv_02", "second", 2),
      ],
      next_cursor: 5,
    },
  ]);
  await loop.pollOnce();
  await sleep(200);
  await loop.settle();
  // The server completes an invocation on its first message, so coalescing
  // these into one turn would strand inv_02 with no reply.
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.prompt), ["first", "second"]);
  assert.deepEqual(
    posted.map((post) => post.body.invocation_id),
    ["inv_01", "inv_02"],
  );
  assert.equal(Object.keys(diskState(home).pending_events).length, 0);
  loop.stop();
});

test("a group approval is asked in the owner's direct conversation, not the group", async () => {
  const home = tempHome();
  const { loop, posted, setPermissionAsker, broker, client } = makeLoop(home, [
    { events: [userMessageEvent("evt_d1", "cnv_direct", "hi")], next_cursor: 1 },
  ]);
  // Settle the direct turn first: it is only here to pin the owner's direct
  // conversation, and must not be the turn that asks.
  await loop.pollOnce();
  await sleep(80);
  await loop.settle();
  let decision: unknown;
  setPermissionAsker(async (callbacks) => {
    const pending = callbacks.onPermissionAsk({
      requestId: "ignored",
      toolName: "Bash",
      inputPreview: '{"command":"deploy"}',
      options: [
        { optionId: "opt_allow", label: "Allow", kind: "allow_once" },
        { optionId: "opt_deny", label: "Deny", kind: "reject_once" },
      ],
    });
    await sleep(30);
    const card = posted.find((post) => post.key.startsWith("agent-perm-"));
    assert.ok(card, "approval card was never posted");
    assert.equal(card.body.conversation_id, "cnv_direct");
    assert.equal(card.body.invocation_id, undefined);
    const requestId = card.body.parts[1].data.request_id;
    broker.consumeReply({
      id: "msg_reply",
      conversation_id: "cnv_direct",
      sequence: 9,
      sender: { kind: "user", id: OWNER },
      parts: [{ type: "text", text: `yes ${requestId}` }],
      fallback_text: `yes ${requestId}`,
    });
    decision = await pending;
  });
  client.pushPage({
    events: [groupMessageEvent("evt_g1", "cnv_group", "inv_01", "@claude deploy")],
    next_cursor: 2,
  });
  await loop.pollOnce();
  await sleep(200);
  await loop.settle();
  assert.deepEqual(decision, { behavior: "selected", optionId: "opt_allow" });
  const groupReply = posted.filter((post) => post.body.conversation_id === "cnv_group");
  assert.equal(groupReply.length, 1);
  assert.equal(groupReply[0].body.invocation_id, "inv_01");
  loop.stop();
});

test("a group approval with no direct conversation to ask in denies instead of burning the invocation", async () => {
  const home = tempHome();
  const { loop, posted, setPermissionAsker } = makeLoop(home, [
    {
      events: [groupMessageEvent("evt_g1", "cnv_group", "inv_01", "@claude deploy")],
      next_cursor: 2,
    },
  ]);
  let decision: unknown;
  setPermissionAsker(async (callbacks) => {
    decision = await callbacks.onPermissionAsk({
      requestId: "ignored",
      toolName: "Bash",
      inputPreview: '{"command":"deploy"}',
      options: [
        { optionId: "opt_allow", label: "Allow", kind: "allow_once" },
        { optionId: "opt_deny", label: "Deny", kind: "reject_once" },
      ],
    });
  });
  await loop.pollOnce();
  await sleep(200);
  await loop.settle();
  assert.deepEqual(decision, { behavior: "selected", optionId: "opt_deny" });
  assert.equal(posted.filter((post) => post.key.startsWith("agent-perm-")).length, 0);
  // The single message this invocation owes is still the reply.
  assert.equal(posted.length, 1);
  assert.equal(posted[0].body.invocation_id, "inv_01");
  loop.stop();
});

test("a group turn clears typing before the reply completes the invocation", async () => {
  const home = tempHome();
  const { loop, posted, typings } = makeLoop(home, [
    {
      events: [groupMessageEvent("evt_g1", "cnv_group", "inv_01", "@claude status")],
      next_cursor: 4,
    },
  ]);
  await loop.pollOnce();
  await sleep(80);
  await loop.settle();
  const stopped = typings.filter((call) => !call.started);
  assert.equal(stopped.length, 1, "typing was stopped exactly once");
  assert.equal(stopped[0].invocationId, "inv_01");
  // Relay completes the invocation on the reply, so a typing-off sent after it
  // would be rejected and the group would keep showing the indicator.
  const stopIndex = typings.findIndex((call) => !call.started);
  assert.equal(stopIndex, typings.length - 1);
  assert.equal(posted.length, 1);
  loop.stop();
});

function cursorFaultClient(options: {
  failures: RelayApiError[];
  onPoll?: (cursor: number) => void;
  reconciliation?: { reconciled: true; resume_cursor: number };
}) {
  const failures = [...options.failures];
  const polls: number[] = [];
  const historyReads: string[] = [];
  const reconciliations: number[] = [];
  let listings = 0;
  const client = {
    origin: "http://fake",
    async getEvents(cursor: number): Promise<EventsPage> {
      polls.push(cursor);
      const failure = failures.shift();
      if (failure) throw failure;
      options.onPoll?.(cursor);
      return { events: [], next_cursor: cursor };
    },
    async listConversations() {
      listings += 1;
      return { conversations: [{ id: "cnv_a", last_sequence: 12 }] };
    },
    async listMessages(conversationId: string) {
      historyReads.push(conversationId);
      return {
        messages: [
          {
            id: "msg_head",
            conversation_id: conversationId,
            sequence: 12,
            sender: { kind: "user" as const, id: OWNER },
            parts: [{ type: "text", text: "still here" }],
            fallback_text: "still here",
            created_at: "2026-08-04T00:00:00.000Z",
          },
        ],
      };
    },
    async reconcileEvents(expiredCursor: number) {
      reconciliations.push(expiredCursor);
      return options.reconciliation ?? { reconciled: true as const, resume_cursor: expiredCursor };
    },
    async setTyping() {},
    async postMessage() {
      throw new Error("a cursor fault must not post anything");
    },
  };
  return {
    client: client as unknown as RelayClient,
    polls,
    historyReads,
    reconciliations,
    listings: () => listings,
  };
}

function cursorFaultLoop(
  home: string,
  client: RelayClient,
  lines: string[],
  state = new StateStore(home),
) {
  return new ReceiveLoop(
    client,
    state,
    fakeEngine().engine,
    new PermissionBroker(client, new ApprovalStore(home), 60_000),
    { ownerUserId: OWNER, debounceMs: 10, cwd: "/tmp", log: (line) => lines.push(line) },
  );
}

test("an expired cursor reconciles history and resumes through Relay's explicit contract", async () => {
  const home = tempHome();
  const state = new StateStore(home);
  state.current.cursor = 42;
  state.current.owner_conversation_id = "cnv_owner";
  state.persist();
  let stop = () => {};
  const { client, polls, historyReads, reconciliations } = cursorFaultClient({
    failures: [
      new RelayApiError(
        410,
        "cursor_expired",
        "GET /v1/events → 410: cursor is older than the retained log",
        {
          highest_delivered_cursor: 42,
          resume_cursor: 45,
          reconciliation_required: true,
          reconciliation_endpoint: "/v1/events/reconcile",
        },
      ),
    ],
    reconciliation: { reconciled: true, resume_cursor: 45 },
    onPoll: () => stop(),
  });
  const lines: string[] = [];
  const loop = cursorFaultLoop(home, client, lines, state);
  stop = () => loop.stop();

  await loop.run();

  assert.deepEqual(polls, [42, 45], "the expired cursor resumes only after explicit reconciliation");
  assert.deepEqual(reconciliations, [42], "the bridge confirms Relay's highest delivered cursor");
  assert.ok(historyReads.includes("cnv_owner"), "the owner conversation is reconciled from history");
  assert.ok(historyReads.includes("cnv_a"), "conversations only Relay knows about are reconciled too");
  const gapLines = lines.filter((line) => line.includes("cursor_expired"));
  assert.equal(gapLines.length, 1, "the gap is reported on exactly one line");
  assert.match(gapLines[0]!, /cursor 42/);
  assert.match(gapLines[0]!, /confirmed the retention gap/);
  assert.match(gapLines[0]!, /head msg_head seq 12/);
  assert.equal(diskState(home).cursor, 45, "the server-provided resume cursor is durable");
  loop.stop();
});

test("an expired cursor without a reconciliation contract remains terminal", async () => {
  const home = tempHome();
  const state = new StateStore(home);
  state.current.cursor = 42;
  state.persist();
  const { client, polls } = cursorFaultClient({
    failures: [
      new RelayApiError(410, "cursor_expired", "GET /v1/events → 410: cursor is older than the retained log"),
    ],
  });
  const lines: string[] = [];
  const loop = cursorFaultLoop(home, client, lines, state);

  await assert.rejects(loop.run(), (error: any) => error.status === 410 && error.code === "cursor_expired");

  assert.deepEqual(polls, [42]);
  assert.match(lines.find((line) => line.includes("cursor_expired")) ?? "", /did not advertise/);
  assert.equal(diskState(home).cursor, 42);
  loop.stop();
});

test("an undelivered cursor resumes from Relay's highest delivered cursor", async () => {
  const home = tempHome();
  const state = new StateStore(home);
  state.current.cursor = 90;
  state.persist();
  let stop = () => {};
  const { client, polls, historyReads } = cursorFaultClient({
    failures: [
      new RelayApiError(
        422,
        "invalid_request",
        "GET /v1/events → 422: cursor 90 has not been delivered by Relay",
        { field: "cursor", received: 90, highest_delivered_cursor: 12 },
      ),
    ],
    onPoll: () => stop(),
  });
  const lines: string[] = [];
  const loop = cursorFaultLoop(home, client, lines, state);
  stop = () => loop.stop();

  await loop.run();

  assert.deepEqual(polls, [90, 12], "polling resumes from the ledger position Relay reported");
  assert.equal(diskState(home).cursor, 12, "the recovered cursor is durable before the next poll");
  assert.ok(historyReads.includes("cnv_a"), "history is reconciled before the cursor moves");
  const recoveryLines = lines.filter((line) => line.includes("was never delivered by Relay"));
  assert.equal(recoveryLines.length, 1);
  assert.match(recoveryLines[0]!, /resumed from Relay's highest delivered cursor 12/);
});

test("a cursor fault never raises the cursor past what this bridge has read", async () => {
  assert.equal(undeliveredCursorTarget({ status: 422, details: { highest_delivered_cursor: 12 } }, 90), 12);
  assert.equal(undeliveredCursorTarget({ status: 422, details: { latest_sequence: 5 } }, 9), 5);
  assert.equal(
    undeliveredCursorTarget({ status: 422, details: { highest_delivered_cursor: 99 } }, 9),
    undefined,
    "a target above the current cursor would acknowledge unread events",
  );
  assert.equal(undeliveredCursorTarget({ status: 422, details: { field: "timeout" } }, 9), undefined);
  assert.equal(undeliveredCursorTarget({ status: 410, details: {} }, 9), undefined);
});
