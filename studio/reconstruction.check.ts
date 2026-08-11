import { bridgeEvent, type AppEvent } from "./events.ts";
import { SessionManager } from "./sessions.ts";
import {
  DeliveryJournal,
  HandoffBuffer,
  parseRecoveryCursor,
  RECONSTRUCTION_GLOBAL_MAX_EVENTS,
  RECONSTRUCTION_PENDING_MAX_BYTES,
  RECONSTRUCTION_PENDING_MAX_EVENTS,
  RECONSTRUCTION_SESSION_MAX_BYTES,
  RECONSTRUCTION_SESSION_MAX_EVENTS,
  sseDeliveryFrame,
} from "./reconstruction.ts";

let passed = 0;
function check(name: string, condition: unknown) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

function event(type: string, sessionId: string, data: Record<string, unknown> = {}): AppEvent {
  return {
    type,
    wireKind: "",
    rail: "bridge",
    sessionId,
    replay: false,
    modelled: true,
    data,
    raw: null,
    t: 1_000,
  };
}

function retainedEvents(journal: DeliveryJournal, session: string | null = null) {
  const held = new Set(session === null ? ["a", "b", "s"] : [session]);
  return journal.plan(session, held, null).records.map((record) => journal.eventFor(record, "reconstruction"));
}

// Fresh reconstruction and Last-Event-ID catch-up are different plans.
{
  const journal = new DeliveryJournal();
  const first = journal.publish(event("turn.started", "s", { text: "one" }), true);
  const second = journal.publish(event("message.assistant", "s", { text: "answer" }), true);
  const fresh = journal.plan("s", new Set(["s"]), null);
  check("fresh connection reconstructs retained events once and in order",
    fresh.records.map((record) => record.id).join(",") === `${first.deliveryId},${second.deliveryId}`);
  const none = journal.plan("s", new Set(["s"]), second.deliveryId!);
  check("Last-Event-ID at high water receives no old event", none.records.length === 0);
  const third = journal.publish(event("turn.finished", "s", { stopReason: "end_turn" }), true);
  const catchup = journal.plan("s", new Set(["s"]), second.deliveryId!);
  check("Last-Event-ID reconnect receives only newer events",
    catchup.records.length === 1 && catchup.records[0].id === third.deliveryId);
  check("catch-up preserves transport provenance without changing upstream replay",
    journal.eventFor(catchup.records[0], "catchup").delivery === "catchup" &&
      journal.eventFor(catchup.records[0], "catchup").replay === false);
}

// A client registered before reconstruction finishes queues only post-cutoff events.
{
  const handoff = new HandoffBuffer(10);
  check("an older reconstruction frame is written directly", handoff.accept(9, "old") === "direct");
  check("an event arriving after cutoff is queued", handoff.accept(11, "new-11") === "queued");
  check("a second post-cutoff event is queued", handoff.accept(12, "new-12") === "queued");
  check("queued events flush in original delivery order",
    handoff.finish().join(",") === "new-11,new-12");
  check("events become direct after handoff", handoff.accept(13, "live") === "direct");
  const bounded = new HandoffBuffer(20);
  check("handoff queue refuses one frame beyond its serialized-byte bound",
    bounded.accept(21, "x".repeat(4 * 1024 * 1024 + 1)) === "overflow" &&
      bounded.snapshot().events === 0);
}

// The global serialized-byte bound accounts for every retained session.
{
  const journal = new DeliveryJournal();
  let publishedBytes = 0;
  for (let session = 0; session < 18; session++) {
    for (let item = 0; item < 2; item++) {
      const ev = event("wire.unknown_kind", `bytes-${session}`, {});
      ev.modelled = false;
      ev.raw = { hostile: "b".repeat(250 * 1024), item };
      const sent = journal.publish(ev, true);
      publishedBytes += Buffer.byteLength(JSON.stringify(sent), "utf8");
    }
  }
  const snapshot = journal.snapshot();
  const lostBytes = snapshot.sessions.reduce((sum, state) => sum + state.loss.bytes, 0);
  check("global serialized-byte bound is never exceeded", snapshot.retainedBytes <= 8 * 1024 * 1024);
  check("global byte eviction accounting is exact", snapshot.retainedBytes + lostBytes === publishedBytes);
}

// Session scope and unscoped merge use only AppEvent.sessionId plus held membership.
{
  const journal = new DeliveryJournal();
  const a1 = journal.publish(event("message.user", "a", { text: "A1" }), true);
  const b1 = journal.publish(event("message.user", "b", { text: "B1" }), true);
  const a2 = journal.publish(event("message.assistant", "a", { text: "A2" }), true);
  const scoped = journal.plan("a", new Set(["a", "b"]), null);
  check("session A scoped replay contains zero session B events",
    scoped.records.length === 2 && scoped.records.every((record) => record.sessionId === "a"));
  const all = journal.plan(null, new Set(["a", "b"]), null);
  check("unscoped replay merges held sessions by delivery ID",
    all.records.map((record) => record.id).join(",") ===
      `${a1.deliveryId},${b1.deliveryId},${a2.deliveryId}`);
  check("a session not currently held is excluded",
    journal.plan(null, new Set(["a"]), null).records.every((record) => record.sessionId === "a"));
}

// Count-bound eviction reports the exact serialized bytes removed.
{
  const journal = new DeliveryJournal();
  const first = event("message.assistant", "s", { text: "first" });
  const delivered = journal.publish(first, true);
  const firstBytes = Buffer.byteLength(JSON.stringify(delivered), "utf8");
  for (let i = 1; i <= RECONSTRUCTION_SESSION_MAX_EVENTS; i++) {
    journal.publish(event("message.assistant", "s", { text: `event-${i}` }), true);
  }
  const plan = journal.plan("s", new Set(["s"]), null);
  check("per-session event-count bound is never exceeded",
    plan.records.length === RECONSTRUCTION_SESSION_MAX_EVENTS);
  check("count-bound eviction reports exact event loss", plan.losses[0]?.events === 1);
  check("count-bound eviction reports exact serialized-byte loss", plan.losses[0]?.bytes === firstBytes);
}

// The byte bound accounts for the full serialized event, including raw payloads.
{
  const journal = new DeliveryJournal();
  const payload = "x".repeat(220 * 1024);
  const originals = [];
  for (let i = 0; i < 3; i++) {
    const ev = event("wire.unknown_kind", "s", {});
    ev.modelled = false;
    ev.raw = { hostile: payload, ordinal: i };
    originals.push(journal.publish(ev, true));
  }
  const plan = journal.plan("s", new Set(["s"]), null);
  const expectedLost = Buffer.byteLength(JSON.stringify(originals[0]), "utf8");
  check("full serialized-byte bound is never exceeded",
    plan.records.reduce((sum, record) => sum + record.bytes, 0) <= RECONSTRUCTION_SESSION_MAX_BYTES);
  check("byte-bound eviction reports exact event loss", plan.losses[0]?.events === 1);
  check("byte-bound eviction includes the hostile raw payload", plan.losses[0]?.bytes === expectedLost);
}

// An event larger than the session budget is live but never retained.
{
  const journal = new DeliveryJournal();
  const huge = event("wire.unknown_kind", "s", {});
  huge.modelled = false;
  huge.raw = { hostile: "z".repeat(RECONSTRUCTION_SESSION_MAX_BYTES + 1) };
  const delivered = journal.publish(huge, true);
  const exactBytes = Buffer.byteLength(JSON.stringify(delivered), "utf8");
  const plan = journal.plan("s", new Set(["s"]), null);
  check("oversized single event still receives a live delivery ID", delivered.deliveryId !== null);
  check("oversized single event is not retained", plan.records.length === 0);
  check("oversized single event reports exact loss",
    plan.losses[0]?.events === 1 && plan.losses[0]?.bytes === exactBytes &&
      plan.losses[0]?.oversizedEvents === 1 && plan.losses[0]?.oversizedBytes === exactBytes);
}

// The global count bound is independent of per-session limits.
{
  const journal = new DeliveryJournal();
  const sessions = Array.from({ length: 11 }, (_, i) => `global-${i}`);
  for (const sessionId of sessions) {
    for (let i = 0; i < RECONSTRUCTION_SESSION_MAX_EVENTS; i++) {
      journal.publish(event("message.assistant", sessionId, { text: "x" }), true);
    }
  }
  const snapshot = journal.snapshot();
  check("global event-count bound is never exceeded",
    snapshot.retainedEvents === RECONSTRUCTION_GLOBAL_MAX_EVENTS);
  check("every global eviction is assigned to a session",
    snapshot.sessions.reduce((sum, state) => sum + state.loss.events, 0) === 500);
}

// A session/load candidate supersedes old live retention only after success.
{
  const journal = new DeliveryJournal();
  journal.publish(event("turn.started", "s", { text: "prompt" }), true);
  journal.publish(event("message.assistant", "s", { text: "answer" }), true);
  journal.publish(event("interaction.abandoned", "s", { key: "interaction-1", reason: "gone" }), true);
  journal.publish(event("bridge.session_loading", "s"), true);
  const historicalUser = event("message.user", "s", { text: "prompt" });
  historicalUser.replay = true;
  journal.publish(historicalUser, true);
  const historicalAnswer = event("message.assistant", "s", { text: "answer" });
  historicalAnswer.replay = true;
  journal.publish(historicalAnswer, true);
  journal.publish(event("bridge.session_loaded", "s"), true);
  const final = retainedEvents(journal, "s");
  check("session_loading boundary removes pre-load plus replay duplication",
    final.filter((ev) => ev.type === "message.assistant" && ev.data.text === "answer").length === 1);
  const userIndex = final.findIndex((ev) => ev.type === "message.user");
  const abandonedIndex = final.findIndex((ev) => ev.type === "interaction.abandoned");
  check("recovery notice is retained after reconstructed history",
    userIndex !== -1 && abandonedIndex > userIndex);
  check("rebased recovery notice keeps its original timestamp and key",
    final[abandonedIndex].t === 1_000 && final[abandonedIndex].data.key === "interaction-1");
}

// A failed load leaves the previous generation authoritative.
{
  const journal = new DeliveryJournal();
  journal.publish(event("message.user", "s", { text: "old" }), true);
  journal.publish(event("bridge.session_loading", "s"), true);
  const partial = event("message.assistant", "s", { text: "partial" });
  partial.replay = true;
  journal.publish(partial, true);
  journal.publish(event("bridge.session_load_failed", "s", { error: "fixture" }), true);
  const final = retainedEvents(journal, "s");
  check("failed candidate replay is discarded", !final.some((ev) => ev.data.text === "partial"));
  check("failed load preserves previous canonical history", final.some((ev) => ev.data.text === "old"));
  check("failed load itself remains visible", final.some((ev) => ev.type === "bridge.session_load_failed"));
}

// Truncation beginning inside a turn is identified rather than numbered TURN 1.
{
  const journal = new DeliveryJournal();
  for (let i = 0; i < RECONSTRUCTION_SESSION_MAX_EVENTS + 1; i++) {
    journal.publish(event("message.assistant", "s", { text: String(i) }), true);
  }
  const loss = journal.plan("s", new Set(["s"]), null).losses[0];
  check("partial retained history is labelled as starting mid-turn",
    loss?.startsMidTurn === true && loss.firstConversationType === "message.assistant");
}

// Interrupted fresh reconstruction remains reconstruction, never live catch-up.
{
  const journal = new DeliveryJournal();
  const first = journal.publish(event("turn.started", "s", { text: "one" }), true);
  journal.publish(event("interaction.abandoned", "s", { key: "old", reason: "history" }), true);
  const resumed = journal.plan("s", new Set(["s"]), first.deliveryId!, "reconstruction");
  check("interrupted fresh delivery resumes with reconstruction provenance",
    resumed.mode === "reconstruction" &&
      resumed.records.every((record) => journal.eventFor(record, resumed.mode).delivery === "reconstruction"));
  const interrupted = parseRecoveryCursor(`r:${first.deliveryId}`, journal.highWater);
  const completed = parseRecoveryCursor(`l:${first.deliveryId}`, journal.highWater);
  check("SSE reconstruction cursor resumes reconstruction after interruption",
    interrupted.valid && interrupted.continuation === "reconstruction" && interrupted.afterId === first.deliveryId);
  check("SSE live cursor selects automatic reconnect catch-up",
    completed.valid && completed.continuation === "catchup" && completed.afterId === first.deliveryId);
  const frame = sseDeliveryFrame(journal.eventFor(resumed.records[0], "reconstruction"), "r");
  check("SSE frame carries the stable reconstruction-prefixed delivery ID",
    frame.startsWith(`id: r:${resumed.records[0].id}\ndata: `));
}

// Catch-up pre-reconciles requests that are resolved later in the same batch.
{
  const journal = new DeliveryJournal();
  journal.publish(event("interaction.permission_requested", "s", { key: "closed" }), true);
  journal.publish(event("interaction.answered", "s", { key: "closed" }), true);
  journal.publish(event("interaction.permission_requested", "s", { key: "open" }), true);
  const plan = journal.plan("s", new Set(["s"]), 0, "catchup");
  const events = journal.eventsFor(plan.records, "catchup");
  check("resolved request in one catch-up batch is marked state-inert",
    events.find((ev) => ev.data.key === "closed" && ev.type.endsWith("requested"))?.deliveryResolved === true);
  check("still-open request in catch-up retains live behavior",
    events.find((ev) => ev.data.key === "open")?.deliveryResolved !== true);
}

// Previous and candidate load generations share one per-session bound.
{
  const journal = new DeliveryJournal();
  for (let i = 0; i < 400; i++) journal.publish(event("message.assistant", "s", { text: `old-${i}` }), true);
  journal.publish(event("bridge.session_loading", "s"), true);
  for (let i = 0; i < 400; i++) journal.publish(event("message.assistant", "s", { text: `new-${i}` }), true);
  const duringLoad = journal.plan("s", new Set(["s"]), null);
  check("dual load generations cannot double the per-session event bound",
    duringLoad.records.length <= RECONSTRUCTION_SESSION_MAX_EVENTS);
  check("dual generation evictions remain counted",
    duringLoad.losses[0].events >= 300);
}

// Unheld hostile session IDs create neither retained events nor metadata.
{
  const journal = new DeliveryJournal();
  for (let i = 0; i < 2_000; i++) journal.publish(event("message.assistant", `foreign-${i}`), false);
  check("unheld session IDs cannot grow journal metadata",
    journal.snapshot().sessions.length === 0 && journal.snapshot().retainedEvents === 0);
}

// Setup events emitted before session/new returns are retained without a kind list.
{
  const journal = new DeliveryJournal();
  journal.beginSessionCreation();
  const setupKinds = [
    "mcp.initialized",
    "git.head_changed",
    "commands.updated",
    "commands.updated",
    "model.changed",
  ];
  const delivered = setupKinds.map((type, ordinal) =>
    journal.publish(event(type, "new-session", { ordinal }), false));
  const future = journal.publish(event("future.setup_kind", "new-session", { future: true }), false);
  journal.promoteSession("new-session");
  journal.endSessionCreation();
  const recovered = journal.plan("new-session", new Set(["new-session"]), null);
  check("all five current pre-registration setup events are promoted",
    recovered.records.slice(0, 5).map((record) => record.type).join(",") === setupKinds.join(","));
  check("arbitrary future pre-registration event kinds are promoted identically",
    recovered.records[5]?.type === "future.setup_kind");
  check("promoted setup events preserve their original delivery IDs",
    recovered.records.map((record) => record.id).join(",") ===
      [...delivered, future].map((ev) => ev.deliveryId).join(","));
}

// Concurrent session/new calls share pending retention but never attribution.
{
  const journal = new DeliveryJournal();
  journal.beginSessionCreation();
  journal.beginSessionCreation();
  const a1 = journal.publish(event("future.a1", "pending-a"), false);
  const b1 = journal.publish(event("future.b1", "pending-b"), false);
  const a2 = journal.publish(event("future.a2", "pending-a"), false);
  journal.promoteSession("pending-a");
  journal.endSessionCreation();
  check("first concurrent return promotes only its exact session id",
    journal.plan(null, new Set(["pending-a", "pending-b"]), null).records
      .map((record) => record.type).join(",") === "future.a1,future.a2");
  const b2 = journal.publish(event("future.b2", "pending-b"), false);
  journal.promoteSession("pending-b");
  journal.endSessionCreation();
  const merged = journal.plan(null, new Set(["pending-a", "pending-b"]), null).records;
  check("second concurrent return promotes only its matching session id",
    merged.filter((record) => record.sessionId === "pending-b").map((record) => record.id).join(",") ===
      `${b1.deliveryId},${b2.deliveryId}`);
  check("concurrent promotion preserves global delivery ordering",
    merged.map((record) => record.id).join(",") ===
      `${a1.deliveryId},${b1.deliveryId},${a2.deliveryId},${b2.deliveryId}`);
}

// An unknown id that no session/new returns is discarded, never reconstructed.
{
  const journal = new DeliveryJournal();
  journal.beginSessionCreation();
  journal.publish(event("future.orphan", "never-held"), false);
  journal.endSessionCreation();
  const plan = journal.plan("never-held", new Set(["never-held"]), null);
  check("an unknown session that is never held is never reconstructed",
    plan.records.length === 0 && plan.losses.length === 0 && journal.snapshot().pending.events === 0);
}

// Pending count eviction becomes exact session loss if that id is later held.
{
  const journal = new DeliveryJournal();
  journal.beginSessionCreation();
  const first = journal.publish(event("future.pending", "count-pending", { ordinal: 0 }), false);
  const firstBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
  for (let i = 1; i <= RECONSTRUCTION_PENDING_MAX_EVENTS; i++) {
    journal.publish(event("future.pending", "count-pending", { ordinal: i }), false);
  }
  check("pending event-count retention is bounded before promotion",
    journal.snapshot().pending.events === RECONSTRUCTION_PENDING_MAX_EVENTS);
  journal.promoteSession("count-pending");
  journal.endSessionCreation();
  const loss = journal.plan("count-pending", new Set(["count-pending"]), null).losses[0];
  check("pending count eviction attaches exact event and byte loss on promotion",
    loss?.events === 1 && loss.bytes === firstBytes && loss.firstLostDeliveryId === first.deliveryId);
}

// Pending bytes include the complete serialized hostile payload.
{
  const journal = new DeliveryJournal();
  journal.beginSessionCreation();
  const originals = [];
  for (let i = 0; i < 3; i++) {
    const ev = event("future.large_setup", "byte-pending");
    ev.modelled = false;
    ev.raw = { hostile: "p".repeat(220 * 1024), ordinal: i };
    originals.push(journal.publish(ev, false));
  }
  check("pending serialized-byte retention is bounded before promotion",
    journal.snapshot().pending.bytes <= RECONSTRUCTION_PENDING_MAX_BYTES);
  journal.promoteSession("byte-pending");
  journal.endSessionCreation();
  const plan = journal.plan("byte-pending", new Set(["byte-pending"]), null);
  const expected = Buffer.byteLength(JSON.stringify(originals[0]), "utf8");
  check("pending byte eviction attaches exact hostile-payload loss on promotion",
    plan.losses[0]?.events === 1 && plan.losses[0]?.bytes === expected);
}

// One pending event larger than the whole budget is loss, not silent absence.
{
  const journal = new DeliveryJournal();
  journal.beginSessionCreation();
  const huge = event("future.oversized_setup", "oversized-pending");
  huge.raw = { hostile: "q".repeat(RECONSTRUCTION_PENDING_MAX_BYTES + 1) };
  const sent = journal.publish(huge, false);
  const exactBytes = Buffer.byteLength(JSON.stringify(sent), "utf8");
  journal.promoteSession("oversized-pending");
  journal.endSessionCreation();
  const loss = journal.plan("oversized-pending", new Set(["oversized-pending"]), null).losses[0];
  check("oversized pending event reports exact loss after promotion",
    loss?.events === 1 && loss.bytes === exactBytes && loss.oversizedEvents === 1);
}

// Loss that predates an acknowledged cursor is not reported as reconnect loss.
{
  const journal = new DeliveryJournal();
  for (let i = 0; i <= RECONSTRUCTION_SESSION_MAX_EVENTS; i++) {
    journal.publish(event("message.assistant", "s", { text: String(i) }), true);
  }
  const cursor = journal.highWater;
  const current = journal.plan("s", new Set(["s"]), cursor, "catchup");
  check("current Last-Event-ID does not report old journal eviction as missed catch-up",
    current.records.length === 0 && current.losses.length === 0);
}

// Catch-up loss is exact inside the bounded recent-loss ledger, regardless of loss order.
{
  const journal = new DeliveryJournal();
  for (let i = 0; i < RECONSTRUCTION_SESSION_MAX_EVENTS; i++) {
    journal.publish(event("message.assistant", "s", { text: String(i) }), true);
  }
  const huge = event("wire.unknown_kind", "s", {});
  huge.modelled = false;
  huge.raw = { hostile: "z".repeat(RECONSTRUCTION_SESSION_MAX_BYTES + 1) };
  const oversized = journal.publish(huge, true);
  journal.publish(event("message.assistant", "s", { text: "forces-old-eviction" }), true);
  const interior = journal.plan("s", new Set(["s"]), oversized.deliveryId! - 1, "catchup");
  check("catch-up reports only losses after an interior cursor",
    interior.losses[0].exactForCursor === true && interior.losses[0].events === 1 &&
      interior.losses[0].firstLostDeliveryId === oversized.deliveryId);
  const allLoss = journal.plan("s", new Set(["s"]), null).losses[0];
  check("loss delivery range remains ordered when an old eviction follows a newer oversized event",
    allLoss.firstLostDeliveryId === 1 && allLoss.lastLostDeliveryId === oversized.deliveryId);
}

// Recovery notices keep stable turn anchors through repeated successful loads.
{
  const journal = new DeliveryJournal();
  journal.publish(event("turn.started", "s", { text: "turn one" }), true);
  journal.publish(event("turn.finished", "s", { stopReason: "end_turn" }), true);
  journal.publish(event("interaction.abandoned", "s", { key: "a", reason: "first" }), true);
  journal.publish(event("bridge.session_loading", "s"), true);
  const replayOne = event("message.user", "s", { text: "turn one" }); replayOne.replay = true;
  journal.publish(replayOne, true);
  const completeOne = event("turn.completed", "s", { stopReason: "end_turn" }); completeOne.replay = true;
  journal.publish(completeOne, true);
  journal.publish(event("bridge.session_loaded", "s"), true);

  journal.publish(event("turn.started", "s", { text: "turn two" }), true);
  journal.publish(event("turn.finished", "s", { stopReason: "end_turn" }), true);
  journal.publish(event("interaction.abandoned", "s", { key: "b", reason: "second" }), true);
  journal.publish(event("bridge.session_loading", "s"), true);
  for (const text of ["turn one", "turn two"]) {
    const user = event("message.user", "s", { text }); user.replay = true;
    journal.publish(user, true);
    const completed = event("turn.completed", "s", { stopReason: "end_turn" }); completed.replay = true;
    journal.publish(completed, true);
  }
  journal.publish(event("bridge.session_loaded", "s"), true);
  const recovered = retainedEvents(journal, "s").filter((ev) => ev.type === "interaction.abandoned");
  check("repeated loads retain every distinct recovery notice",
    recovered.map((ev) => ev.data.key).join(",") === "a,b");
  check("repeated loads retain each recovery notice's chronological turn anchor",
    recovered.map((ev) => ev.data.recoveryAfterTurn).join(",") === "1,2");
}

// Recovery notices survive the combined-generation bound during a successful load.
{
  const journal = new DeliveryJournal();
  journal.publish(event("interaction.abandoned", "s", { key: "protected", reason: "keep me" }), true);
  for (let i = 0; i < 399; i++) journal.publish(event("message.assistant", "s", { text: `old-${i}` }), true);
  journal.publish(event("bridge.session_loading", "s"), true);
  for (let i = 0; i < 399; i++) {
    const replay = event("message.assistant", "s", { text: `new-${i}` }); replay.replay = true;
    journal.publish(replay, true);
  }
  journal.publish(event("bridge.session_loaded", "s"), true);
  const final = retainedEvents(journal, "s");
  check("bounded successful load preserves prior abandonment evidence",
    final.some((ev) => ev.type === "interaction.abandoned" && ev.data.key === "protected"));
}

// Global pressure also protects recovery evidence until generation commit.
{
  const journal = new DeliveryJournal();
  journal.publish(event("interaction.abandoned", "s", { key: "global-protected", reason: "keep me" }), true);
  for (let session = 0; session < 10; session++) {
    const count = session === 0 ? 500 : 499;
    for (let i = 0; i < count; i++) {
      journal.publish(event("message.assistant", `pressure-${session}`, { text: String(i) }), true);
    }
  }
  journal.publish(event("bridge.session_loading", "s"), true);
  const replay = event("message.user", "s", { text: "history" }); replay.replay = true;
  journal.publish(replay, true);
  journal.publish(event("bridge.session_loaded", "s"), true);
  const held = new Set(["s", ...Array.from({ length: 10 }, (_, i) => `pressure-${i}`)]);
  const final = journal.plan("s", held, null).records.map((record) => journal.eventFor(record, "reconstruction"));
  check("global-bound successful load preserves prior abandonment evidence",
    final.some((ev) => ev.type === "interaction.abandoned" && ev.data.key === "global-protected"));
  check("global pressure remains within both global bounds",
    journal.snapshot().retainedEvents <= RECONSTRUCTION_GLOBAL_MAX_EVENTS &&
      journal.snapshot().retainedBytes <= 8 * 1024 * 1024);
}

// Agent-wide bridge.log is sequenced live but excluded from retained replay.
{
  const journal = new DeliveryJournal();
  journal.publish(bridgeEvent("bridge.log", { text: "agent-wide" }), false);
  check("agent-wide bridge.log does not duplicate on reconnect",
    journal.plan(null, new Set(["s"]), null).records.length === 0);
}

// A reverse request encountered during a failed first load is answered and removed.
{
  const manager = new SessionManager(process.cwd());
  (manager as any).requireReady = () => {};
  (manager.acp as any).request = async () => { throw new Error("fixture load failure"); };
  const responses: any[] = [];
  (manager.acp as any).respondError = (...args: any[]) => responses.push(args);
  const interactionEvent = event("interaction.permission_requested", "failed-load", {
    key: "interaction-fixture",
  });
  (manager as any).openInteractions.set("interaction-fixture", {
    id: 7,
    method: "session/request_permission",
    params: { sessionId: "failed-load", options: [] },
    sessionId: "failed-load",
    build: () => ({}),
    event: interactionEvent,
  });
  const emitted: AppEvent[] = [];
  manager.on("app", (ev) => emitted.push(ev));
  await manager.loadSession("failed-load", process.cwd()).catch(() => null);
  check("failed load sends an ACP error response to its open interaction",
    responses.length === 1 && responses[0][0] === 7 && responses[0][1] === -32000);
  check("failed first load leaves no orphan interaction or held session",
    manager.openInteractionEvents().length === 0 && !manager.sessions.has("failed-load"));
  check("failed load emits abandonment before the explicit load failure boundary",
    emitted.findIndex((ev) => ev.type === "interaction.abandoned") <
      emitted.findIndex((ev) => ev.type === "bridge.session_load_failed"));
}

console.log(`\n${passed} reconstruction checks passed`);
