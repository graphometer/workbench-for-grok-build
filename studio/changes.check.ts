// WP11: changes, and undo — checked deterministically. No network, no agent,
// no dependencies:
//
//     node studio/changes.check.ts
//
// Part 1 exercises the SessionManager's hunk-tracker methods with the
// session-admin rig: the manager spawns nothing, every call it would put on
// the wire is captured, and each test feeds the reply the protocol would send —
// DOUBLE-WRAPPED at result.result, which is the 1.0.0 wire truth (F1,
// docs/evidence/wp11-probe/; the fixtures below are those captures, reduced).
// The read-back logic (rule 1 — never trust an acknowledgement) is exercised
// against acks that lie.
//
// Part 2 loads the real public/app.js into a fake DOM (the app-recovery
// precedent) and drives the changes pane and the turn-foot undo: hostile
// strings, the display-only external hunk, the two-click undo discipline, and
// the turn→promptIndex mapping that must come only from get-summary data.

import { SessionManager } from "./sessions.ts";
import type { AppEvent } from "./events.ts";
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
function check(name: string, ok: boolean) {
  if (!ok) {
    console.error(`FAIL ${name}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

// ══ PART 1 — the manager ══════════════════════════════════════════════════

interface Call {
  method: string;
  params: any;
  notify?: boolean;
}

/** The session-admin rig: spawn nothing, capture everything, reply by table. */
function rig() {
  const manager = new SessionManager(process.cwd());
  (manager as any).requireReady = () => {};
  const calls: Call[] = [];
  const emitted: AppEvent[] = [];
  const counts = { notes: 0, louds: 0 };
  const replies: Record<string, (params: any) => any> = {};
  (manager.acp as any).note = () => {
    counts.notes++;
  };
  (manager.acp as any).loud = () => {
    counts.louds++;
  };
  manager.on("app", (ev: AppEvent) => emitted.push(ev));
  (manager.acp as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    const fn = replies[method];
    return fn ? fn(params) : {};
  };
  return { manager, calls, emitted, replies, counts };
}

function held(manager: SessionManager, sessionId: string, cwd: string) {
  (manager as any).sessions.set(sessionId, {
    sessionId,
    cwd,
    acquired: "load",
    createdAt: 1,
    title: null,
    live: true,
    models: null,
    confirmedModeId: null,
    modeRequest: null,
    modelId: null,
    reasoningEffort: null,
    turn: null,
    turnEpoch: 0,
    seenPromptIndexes: new Set<number>(),
    acceptedByTurn: new Map<number, number>(),
    trackerSuspect: false,
    recovery: null,
    commands: null,
    commandsRevision: 0,
    replayedEvents: 0,
    liveEvents: 0,
    loading: null,
  });
}

/**
 * Seed a session's seenPromptIndexes the way the wire does: the agent stamps
 * its echo of the user's message with `_meta.promptIndex`, and onNotification
 * records it (replay excluded). This drives the REAL seeding path, not the
 * field.
 */
function seedPrompt(manager: SessionManager, sessionId: string, promptIndex: number, replay = false) {
  (manager as any).onNotification({
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "the prompt" },
        _meta: { promptIndex },
      },
      ...(replay ? { _meta: { isReplay: true } } : {}),
    },
  });
}

function refusal(fn: () => Promise<unknown>): Promise<any> {
  return fn().then(
    () => null,
    (err) => err,
  );
}

// Fixtures reduced from the 1.0.0 probe captures (run1/10, run1/11, run1/12),
// including the null oldText of a pure insertion.
const HUNK_ALPHA = {
  id: "h-alpha",
  path: "/repo/alpha.txt",
  lineInfo: { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 },
  source: { type: "agentEdit", prompt_index: 0 },
  oldText: "line RED\n",
  newText: "line BLUE\n",
  patch: null,
  createdAt: "2026-08-09T14:58:19.994850185Z",
};
const HUNK_BETA = {
  id: "h-beta",
  path: "/repo/beta.txt",
  lineInfo: { oldStart: 3, oldCount: 0, newStart: 3, newCount: 1 },
  source: { type: "agentEdit", prompt_index: 0 },
  oldText: null,
  newText: "agent was here\n",
  patch: null,
  createdAt: "2026-08-09T14:58:19.994159880Z",
};
const FILES_PENDING = [
  { path: "/repo/alpha.txt", isAgentFile: true, staged: false, hunkCount: 1, additions: 1, deletions: 1 },
  { path: "/repo/beta.txt", isAgentFile: true, staged: false, hunkCount: 1, additions: 1, deletions: 0 },
];
const SUMMARY_PENDING = {
  stats: { acceptedHunks: 0, rejectedHunks: 0 },
  turns: [
    { promptIndex: 0, files: ["/repo/alpha.txt", "/repo/beta.txt"], pendingHunks: [HUNK_ALPHA, HUNK_BETA], linesAdded: 2, linesRemoved: 1 },
  ],
  filesModified: 2,
  filesWithPending: 2,
  pendingHunks: 2,
  unattributedPending: 0,
};
const SUMMARY_CLEAN = { ...SUMMARY_PENDING, turns: [], pendingHunks: 0 };

/** Every hunk-tracker reply is double-wrapped at result.result (F1). */
const env = (payload: any) => ({ result: payload });

/** Wire the six-method reply table for a rig, from before/after readings. */
function wireChanges(
  replies: Record<string, (params: any) => any>,
  before: { files: any[]; summary: any },
  after?: { files: any[]; summary: any },
) {
  /* get-files is requested BEFORE get-summary inside changes(), so the switch
     to the after-reading keys off the SECOND get-files call. */
  let filesReads = 0;
  replies["_x.ai/hunk-tracker/get-files"] = () => {
    filesReads++;
    return env({ files: (after && filesReads >= 2 ? after : before).files });
  };
  replies["_x.ai/hunk-tracker/get-summary"] = () =>
    env((after && filesReads >= 2 ? after : before).summary);
  /* changes() also reads the no-path get-hunks (external-hunk identity,
     final round). Default to a readable empty set; cases override freely. */
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [] });
}

/** Stub the no-path get-hunks read (hunkAction's membership source), before/after. */
function wireAllHunks(replies: Record<string, (params: any) => any>, before: any[], after?: any[]) {
  let reads = 0;
  replies["_x.ai/hunk-tracker/get-hunks"] = (params: any) => {
    if (params && typeof params.path === "string") return env({ hunks: before }); // path-scoped: digest reads
    reads++;
    return env({ hunks: after && reads >= 2 ? after : before });
  };
}

// 1. changes() unwraps BOTH double-wrapped replies and sends both reads with
//    the sessionId. A consumer reading result.files off the raw reply would
//    get undefined — this is the F1 regression guard.
{
  const { manager, calls, replies, emitted } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  const reading = await manager.changes("s");
  check("changes() reads the files out of the double-wrapped get-files reply",
    reading.files.length === 2 && reading.files[0].path === "/repo/alpha.txt");
  check("changes() reads the summary out of the double-wrapped get-summary reply",
    reading.summary && reading.summary.turns[0].promptIndex === 0);
  check("changes() sent get-files and get-summary, each carrying the sessionId",
    calls.some((c) => c.method === "_x.ai/hunk-tracker/get-files" && c.params.sessionId === "s") &&
      calls.some((c) => c.method === "_x.ai/hunk-tracker/get-summary" && c.params.sessionId === "s"));
  check("changes() emits a bridge.changes_reading AppEvent with the reading",
    emitted.some((e) => e.type === "bridge.changes_reading" && e.sessionId === "s" &&
      Array.isArray((e.data as any).files)));
}

// 2. hunks() unwraps and passes baseline/current through verbatim (F6).
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () =>
    env({ hunks: [HUNK_ALPHA], baseline: { status: "full", content: "line RED\n" }, current: { status: "full", content: "line BLUE\n" } });
  const out = await manager.hunks("s", "/repo/alpha.txt");
  check("hunks() reads the hunk list out of the double-wrapped reply",
    out.hunks.length === 1 && out.hunks[0].id === "h-alpha");
  check("hunks() sent get-hunks with {sessionId, path} and nothing else needed",
    calls.some((c) => c.method === "_x.ai/hunk-tracker/get-hunks" &&
      c.params.sessionId === "s" && c.params.path === "/repo/alpha.txt"));
  check("hunks() passes baseline/current through verbatim",
    out.baseline?.content === "line RED\n" && out.current?.content === "line BLUE\n");
}

// 3. A FLAT reply where the table says double-wrapped triggers the loud path
//    (unwrapExt's recorded-contract tripwire) — never a silent misread.
{
  const { manager, replies, counts } = rig();
  held(manager, "s", "/repo");
  replies["_x.ai/hunk-tracker/get-files"] = () => ({ files: [] }); // FLAT — no envelope
  replies["_x.ai/hunk-tracker/get-summary"] = () => ({ turns: [] });
  await manager.changes("s");
  check("a flat reply against a double-wrapped table entry is loud", counts.louds >= 1);
}

// 4. Relative path refused locally BEFORE the wire (F13: the wire answers a
//    relative path with a successful EMPTY result, which would read as
//    "no changes"). Zero calls leave the client, on both path-taking methods.
{
  const { manager, calls } = rig();
  held(manager, "s", "/repo");
  const e1 = await refusal(() => manager.hunks("s", "alpha.txt"));
  check("hunks() refuses a relative path with badRequest", e1 && e1.badRequest === true);
  const e2 = await refusal(() => manager.fileAction("s", "alpha.txt", "accept"));
  check("fileAction() refuses a relative path with badRequest", e2 && e2.badRequest === true);
  check("a refused relative path put NOTHING on the wire (call count 0)", calls.length === 0);
}

// 5. Unknown / missing sessionId refused locally BEFORE the wire (F3's
//    inconsistent -32602/-32603 must never reach a caller).
{
  const { manager, calls } = rig();
  held(manager, "s", "/repo");
  const e1 = await refusal(() => manager.changes("ghost"));
  const e2 = await refusal(() => manager.turnAction("ghost", 0, "reject"));
  check("changes() refuses an unknown session id locally", e1 !== null);
  check("turnAction() refuses an unknown session id locally", e2 !== null);
  check("a refused unknown-id call put NOTHING on the wire", calls.length === 0);
}

// 6. success:true with affectedCount:0 is "nothing changed" — never a success,
//    never a throw (F13).
{
  const { manager, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING }); // unchanged before/after
  wireAllHunks(replies, [HUNK_ALPHA, HUNK_BETA]); // unchanged before/after
  replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 0 });
  const out = await manager.hunkAction("s", "h-alpha", "reject");
  check("affectedCount:0 does not throw", out !== null && typeof out === "object");
  check("affectedCount:0 is reported as changed:false", out.changed === false);
  check("affectedCount:0 surfaces as 'Nothing changed'", /Nothing changed/.test(out.note));
}

// 7. The read-back drives the verdict, not the ack: stub an ack LYING
//    affectedCount:1 with an unchanged pending set, and the manager must
//    report the re-read, loudly.
{
  const { manager, replies, counts } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING }); // unchanged before/after
  wireAllHunks(replies, [HUNK_ALPHA, HUNK_BETA]);
  replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 1 }); // lying
  const out = await manager.hunkAction("s", "h-alpha", "reject");
  check("a lying ack does not become a success", out.changed === false);
  check("the verdict names the re-read, not the ack", /STILL pending in the re-read/.test(out.note));
  check("an unconfirmed undo takes the loud path", counts.louds >= 1);
}

// 8. hunkAction happy path: the hunk was pending before and is gone in the
//    re-read — changed:true, the quiet note path, and a bridge.change_acted
//    AppEvent carrying the after-reading digest.
{
  const { manager, replies, counts, emitted } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies,
    { files: FILES_PENDING, summary: SUMMARY_PENDING },
    { files: FILES_PENDING.slice(1), summary: { ...SUMMARY_PENDING, turns: [{ ...SUMMARY_PENDING.turns[0], pendingHunks: [HUNK_BETA] }] } });
  wireAllHunks(replies, [HUNK_ALPHA, HUNK_BETA], [HUNK_BETA]);
  replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 1 });
  const out = await manager.hunkAction("s", "h-alpha", "reject");
  check("a hunk gone from the re-read is changed:true", out.changed === true);
  check("a confirmed undo takes the quiet note path", counts.notes >= 1 && counts.louds === 0);
  check("hunk-action went on the wire as {sessionId, hunkId, action:'reject'}",
    out.ack?.affectedCount === 1);
  const acted = emitted.find((e) => e.type === "bridge.change_acted");
  check("bridge.change_acted carries kind, target and the after-reading",
    !!acted && (acted.data as any).kind === "hunk" && (acted.data as any).target === "h-alpha" &&
      Array.isArray((acted.data as any).reading?.files));
}

// 8b. Grok R2-M3 + Opus N9: the all-hunks membership read covers
//     UNATTRIBUTED hunks — and the director's display-only rule is enforced
//     SERVER-side: a direct POST undoing a hunk the tracker does not
//     attribute to the agent is refused before the wire, with the source
//     named. (The verdict path for such ids is a refusal, never a blind
//     "not pending" and never a silent write.)
{
  const EXTERNAL = { ...HUNK_ALPHA, id: "h-ext", source: { type: "external" } };
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  wireAllHunks(replies, [EXTERNAL, HUNK_BETA]);
  const err = await refusal(() => manager.hunkAction("s", "h-ext", "reject"));
  check("undoing an external hunk is refused server-side with badRequest",
    err && err.badRequest === true && /only available for changes the tracker attributes to the agent/.test(err.message));
  check("…and hunk-action never went on the wire",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/hunk-action"));
}

// 8c. Opus final I1 — the attribution gate fails CLOSED on an unreadable
//     membership pre-read: refuse, don't fire blind.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () => ({}); // unreadable
  const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
  check("an unreadable membership pre-read refuses the undo (badRequest)",
    err && err.badRequest === true && /refused rather than fired blind/.test(err.message));
  check("…and hunk-action never went on the wire",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/hunk-action"));
}

// 9. The turn→promptIndex mapping comes ONLY from wire-stamped identity: an
//    index the summary does not carry is refused, an index the summary DOES
//    carry but the tracker never stamped (the B1 wrong-turn case) is refused,
//    and no turn-action ever leaves the client for either.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  seedPrompt(manager, "s", 0); // the tracker reported 0 — and only 0
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING }); // only promptIndex 0
  const e1 = await refusal(() => manager.turnAction("s", 7, "reject"));
  check("a promptIndex the summary does not list is refused with badRequest", e1 && e1.badRequest === true);
  for (const bad of [0.5, -1, "0", null, undefined]) {
    const e = await refusal(() => manager.turnAction("s", bad as any, "reject"));
    check(`a non-integer/negative promptIndex (${JSON.stringify(bad)}) is refused with badRequest`, e && e.badRequest === true);
  }
  check("no turn-action call EVER went on the wire for a refused index",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/turn-action"));
}

// 9b. B1's server gate: the summary lists promptIndex 0 with pending hunks,
//     but the tracker never stamped 0 in this lifetime (the stamp belongs to
//     a different tracker generation) → refused before the wire. And a
//     REPLAYED echo must not seed the set (a respawned tracker re-derives its
//     numbering; a historical index could then name a different turn).
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  seedPrompt(manager, "s", 0, true); // replayed — must NOT seed
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  const err = await refusal(() => manager.turnAction("s", 0, "reject"));
  check("an index in the summary but never stamped by THIS tracker is refused with badRequest",
    err && err.badRequest === true && /has not reported promptIndex/.test(err.message));
  check("a replayed echo does not seed the identity set",
    !(manager as any).sessions.get("s").seenPromptIndexes.has(0));
  check("the refused unstamped index never reached the wire",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/turn-action"));
}

// 10. turnAction happy path: promptIndex 0 stamped by the tracker AND listed
//     by the summary with pending hunks; the wire call carries exactly
//     {sessionId, promptIndex, action:"reject"} (camelCase, F5), and the
//     re-read showing the turn's hunks gone is the verdict.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  seedPrompt(manager, "s", 0);
  wireChanges(replies,
    { files: FILES_PENDING, summary: SUMMARY_PENDING },
    { files: [], summary: SUMMARY_CLEAN });
  replies["_x.ai/hunk-tracker/turn-action"] = () => env({ success: true, affectedCount: 2 });
  const out = await manager.turnAction("s", 0, "reject");
  const wire = calls.find((c) => c.method === "_x.ai/hunk-tracker/turn-action");
  check("turn-action params are exactly {sessionId, promptIndex, action} (camelCase)",
    !!wire && wire.params.sessionId === "s" && wire.params.promptIndex === 0 && wire.params.action === "reject" &&
      Object.keys(wire.params).length === 3);
  check("the turn gone from the re-read is changed:true", out.changed === true);
  check("the verdict says exactly what was reverted", /Reverted the 2 change\(s\) this turn still had pending/.test(out.note));
}

// 11. fileAction accept: the file leaving get-files is the verdict, and the
//     note keeps F11's honesty — content stays on disk, nothing is staged.
//     The accept carries the hunk ids the operator saw (Codex 5); the manager
//     re-reads them via get-hunks before anything is sent.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies,
    { files: FILES_PENDING, summary: SUMMARY_PENDING },
    { files: FILES_PENDING.slice(1), summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [HUNK_ALPHA] });
  replies["_x.ai/hunk-tracker/file-action"] = () => env({ success: true, affectedCount: 1 });
  const out = await manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]);
  check("file-action params are exactly {sessionId, path, action:'accept'}",
    calls.some((c) => c.method === "_x.ai/hunk-tracker/file-action" &&
      c.params.sessionId === "s" && c.params.path === "/repo/alpha.txt" && c.params.action === "accept" &&
      Object.keys(c.params).length === 3));
  check("the file gone from the re-read is changed:true", out.changed === true);
  check("the accept note says nothing was staged", /stays on disk/.test(out.note) && /staged/.test(out.note));
}

// 11b. Codex 5: a digest MISMATCH (the file changed since the operator read
//      it) is refused before the wire; a missing hunkIds field is refused too
//      — an accept must always name what it accepts.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [HUNK_ALPHA, HUNK_BETA] }); // one MORE than seen
  const e1 = await refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]));
  check("a hunk-id mismatch is refused with badRequest (changed since read)",
    e1 && e1.badRequest === true && /changed since you read it/.test(e1.message));
  const e2 = await refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", undefined));
  check("an accept with no hunk ids at all is refused with badRequest", e2 && e2.badRequest === true);
  check("a refused accept never sent file-action",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/file-action"));
}

// 11c. Codex 2 / Grok I4 — the mid-turn guard: with a turn in flight, ALL
//      three actions are refused locally and nothing goes on the wire.
{
  for (const [name, fn] of [
    ["hunkAction", (m: SessionManager) => m.hunkAction("s", "h-alpha", "reject")],
    ["fileAction", (m: SessionManager) => m.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"])],
    ["turnAction", (m: SessionManager) => m.turnAction("s", 0, "reject")],
  ] as [string, (m: SessionManager) => Promise<unknown>][]) {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    seedPrompt(manager, "s", 0);
    (manager as any).sessions.get("s").turn = { startedAt: 1, watchdog: null };
    wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
    const err = await refusal(() => fn(manager));
    check(`${name} is refused mid-turn with badRequest`, err && err.badRequest === true && /still running/.test(err.message));
    check(`${name} mid-turn put NOTHING on the wire`, calls.length === 0);
  }
}

// 11d. Opus I1 / Codex 3 — an UNREADABLE re-read is never a success:
//      "the action was sent but the result could not be verified".
{
  /* hunkAction: after-read (the no-path get-hunks membership read) unreadable */
  {
    const { manager, replies, counts } = rig();
    held(manager, "s", "/repo");
    wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
    wireAllHunks(replies, [HUNK_ALPHA, HUNK_BETA]);
    let hunkReads = 0;
    replies["_x.ai/hunk-tracker/get-hunks"] = () => {
      hunkReads++;
      return hunkReads >= 2 ? {} : env({ hunks: [HUNK_ALPHA, HUNK_BETA] }); // after-read unreadable
    };
    replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 1 });
    const out = await manager.hunkAction("s", "h-alpha", "reject");
    check("an unreadable after-read is changed:false, never success", out.changed === false);
    check("…and says the result could not be verified", /could not be verified/.test(out.note));
    check("…and takes the loud path", counts.louds >= 1);
  }
  /* turnAction: after-summary unreadable */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    seedPrompt(manager, "s", 0);
    let summaries = 0;
    replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: FILES_PENDING });
    replies["_x.ai/hunk-tracker/get-summary"] = () => {
      summaries++;
      return summaries >= 2 ? null : env(SUMMARY_PENDING);
    };
    replies["_x.ai/hunk-tracker/turn-action"] = () => env({ success: true, affectedCount: 2 });
    const out = await manager.turnAction("s", 0, "reject");
    check("turn-action with an unreadable after-read is changed:false", out.changed === false);
    check("…and says the result could not be verified", /could not be verified/.test(out.note));
  }
  /* turnAction: PRE-read unreadable → refuses to fire at all (500, not 400) */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    seedPrompt(manager, "s", 0);
    replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: FILES_PENDING });
    replies["_x.ai/hunk-tracker/get-summary"] = () => ({}); // unreadable
    const err = await refusal(() => manager.turnAction("s", 0, "reject"));
    check("an unreadable pre-read refuses to fire the turn-action",
      err !== null && err.badRequest !== true && /NOT sent/.test(err.message));
    check("…and turn-action never went on the wire",
      !calls.some((c) => c.method === "_x.ai/hunk-tracker/turn-action"));
  }
  /* fileAction: after-files unreadable */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    let filesReads = 0;
    replies["_x.ai/hunk-tracker/get-files"] = () => {
      filesReads++;
      return filesReads >= 2 ? {} : env({ files: FILES_PENDING });
    };
    replies["_x.ai/hunk-tracker/get-summary"] = () => env(SUMMARY_PENDING);
    replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [HUNK_ALPHA] });
    replies["_x.ai/hunk-tracker/file-action"] = () => env({ success: true, affectedCount: 1 });
    const out = await manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]);
    check("file-action with an unreadable after-read is changed:false", out.changed === false);
    check("…and says the result could not be verified (never 'Marked as reviewed')",
      /could not be verified/.test(out.note) && !/Marked as reviewed/.test(out.note));
  }
}

// 11e. Codex 1 — partially-accepted turn: accept one file, then undo the
//      turn. The sentence must say what was still pending AND what was
//      already reviewed — never a blanket "Undone".
{
  const { manager, replies } = rig();
  held(manager, "s", "/repo");
  seedPrompt(manager, "s", 0);
  /* Two files pending under promptIndex 0. Accept alpha first. */
  let filesReads = 0;
  replies["_x.ai/hunk-tracker/get-files"] = () => {
    filesReads++;
    return env({ files: filesReads >= 2 ? FILES_PENDING.slice(1) : FILES_PENDING });
  };
  replies["_x.ai/hunk-tracker/get-summary"] = () => env(SUMMARY_PENDING);
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [HUNK_ALPHA] });
  replies["_x.ai/hunk-tracker/file-action"] = () => env({ success: true, affectedCount: 1 });
  const accept = await manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]);
  check("the accept took", accept.changed === true);
  /* Now the turn has only beta's hunk pending; undo it. */
  const SUMMARY_AFTER_ACCEPT = {
    ...SUMMARY_PENDING,
    turns: [{ ...SUMMARY_PENDING.turns[0], pendingHunks: [HUNK_BETA] }],
  };
  let summaries = 0;
  replies["_x.ai/hunk-tracker/get-summary"] = () => {
    summaries++;
    return env(summaries >= 2 ? SUMMARY_CLEAN : SUMMARY_AFTER_ACCEPT);
  };
  replies["_x.ai/hunk-tracker/turn-action"] = () => env({ success: true, affectedCount: 1 });
  const out = await manager.turnAction("s", 0, "reject");
  check("the turn-undo after a partial accept is changed:true", out.changed === true);
  check("the sentence names the still-pending count", /Reverted the 1 change\(s\) this turn still had pending/.test(out.note));
  check("the sentence names the already-reviewed count",
    /1 hunk\(s\) you had already marked as reviewed were not pending and were outside this undo's scope/.test(out.note));
}

// 11f. Codex 6 — stale hunkId wording: absent before AND after is "not
//      pending (already resolved)", never "still pending".
{
  const { manager, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  wireAllHunks(replies, [HUNK_ALPHA, HUNK_BETA]); // "h-never-seen" is in neither read
  replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 0 });
  const out = await manager.hunkAction("s", "h-never-seen", "reject");
  check("a hunk absent before and after is changed:false", out.changed === false);
  check("…and says 'not pending', never 'still pending'",
    /was not pending before/.test(out.note) && !/still pending/.test(out.note));
}

// 11g. Opus I3 — the bridge events carry a DIGEST: no hunk text, ever.
{
  const { manager, emitted, replies } = rig();
  held(manager, "s", "/repo");
  seedPrompt(manager, "s", 0);
  wireChanges(replies,
    { files: FILES_PENDING, summary: SUMMARY_PENDING },
    { files: [], summary: SUMMARY_CLEAN });
  replies["_x.ai/hunk-tracker/turn-action"] = () => env({ success: true, affectedCount: 2 });
  await manager.turnAction("s", 0, "reject");
  const readingEv = emitted.find((e) => e.type === "bridge.changes_reading");
  const actedEv = emitted.find((e) => e.type === "bridge.change_acted");
  check("bridge.changes_reading is emitted", !!readingEv);
  check("bridge.change_acted is emitted with a reading digest", !!actedEv && !!(actedEv.data as any).reading);
  const blob = JSON.stringify(emitted.filter((e) => e.type.startsWith("bridge.change")).map((e) => e.data));
  check("no bridge changes event carries hunk text (oldText/newText/patch)",
    !/oldText|newText|patch|line RED|line BLUE/.test(blob));
  check("the digest still carries paths, counts and promptIndexes",
    blob.includes("/repo/alpha.txt") && blob.includes('"promptIndex":0') && blob.includes('"pending"'));
}

// 11h. Grok I2 — hunks() with no hunks array: hunksOk:false and loud, never
//      a silent empty list.
{
  const { manager, replies, counts } = rig();
  held(manager, "s", "/repo");
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ baseline: null, current: null }); // no hunks key
  const out = await manager.hunks("s", "/repo/alpha.txt");
  check("a hunks reply with no array is hunksOk:false", out.hunksOk === false && out.hunks.length === 0);
  check("…and takes the loud path", counts.louds >= 1);
}

// 12. The five routes exist in server.ts's pathname chain, each taking
//     sessionId from the body via the str() gate; the file-action route
//     passes the seen-hunk ids through; oversized/malformed bodies are caller
//     errors, not 500s (source grep — route behaviour is the manager's,
//     checked above; Codex 5/8).
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
  for (const route of ["/changes", "/changes/hunks", "/changes/hunk-action", "/changes/file-action", "/changes/turn-action"]) {
    check(`server.ts has a POST route for ${route}`, serverSrc.includes(`url.pathname === "${route}"`));
  }
  const chain = serverSrc.slice(serverSrc.indexOf(`url.pathname === "/changes"`));
  check("the /changes routes sit below the POST gate (sessionId via str(body, …))",
    chain.includes(`manager.changes(str(body, "sessionId"))`));
  check("the file-action route passes body.hunkIds to the manager",
    chain.includes(`manager.fileAction(str(body, "sessionId"), str(body, "path"), "accept", body.hunkIds)`));
  const readBody = serverSrc.slice(serverSrc.indexOf("function readBody"), serverSrc.indexOf("function json("));
  check("the body cap is in BYTES and rejects as badRequest (→ 400), never destroying the socket",
    /bytes \+= c\.length/.test(readBody) && /bytes > 1_000_000/.test(readBody) &&
      /err\.badRequest = true/.test(readBody) && !/req\.destroy/.test(readBody));
  check("a malformed JSON body is a 400, not a 500",
    /catch \{\s*const err: any = new Error\("the request body was not valid JSON"\);\s*err\.badRequest = true;/.test(serverSrc));
}

// 28. Codex 1 / Opus F3 / Grok R2-I1 — the TOCTOU guard: a turn that starts
//     DURING the pre-read round-trips moves the epoch, and the action is
//     refused BEFORE the write — in all three actions. (The stub mutates the
//     record exactly the way startTurn does: synchronously, turn + epoch.)
{
  const startTurnDuring = (manager: SessionManager) => {
    const rec = (manager as any).sessions.get("s");
    rec.turn = { startedAt: 1, watchdog: null };
    rec.turnEpoch++;
  };
  /* hunkAction: turn starts during the get-hunks membership read */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
    replies["_x.ai/hunk-tracker/get-hunks"] = () => {
      startTurnDuring(manager);
      return env({ hunks: [HUNK_ALPHA] });
    };
    const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
    check("hunkAction refuses when a turn starts mid-read (badRequest)",
      err && err.badRequest === true && /refused BEFORE the write/.test(err.message));
    check("…and hunk-action never went on the wire",
      !calls.some((c) => c.method === "_x.ai/hunk-tracker/hunk-action"));
  }
  /* fileAction: turn starts during the before-changes read */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [HUNK_ALPHA] });
    replies["_x.ai/hunk-tracker/get-files"] = () => {
      startTurnDuring(manager);
      return env({ files: FILES_PENDING });
    };
    replies["_x.ai/hunk-tracker/get-summary"] = () => env(SUMMARY_PENDING);
    const err = await refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]));
    check("fileAction refuses when a turn starts mid-read (badRequest)",
      err && err.badRequest === true && /refused BEFORE the write/.test(err.message));
    check("…and file-action never went on the wire",
      !calls.some((c) => c.method === "_x.ai/hunk-tracker/file-action"));
  }
  /* turnAction: turn starts during the summary pre-read */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    seedPrompt(manager, "s", 0);
    replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: FILES_PENDING });
    replies["_x.ai/hunk-tracker/get-summary"] = () => {
      startTurnDuring(manager);
      return env(SUMMARY_PENDING);
    };
    const err = await refusal(() => manager.turnAction("s", 0, "reject"));
    check("turnAction refuses when a turn starts mid-read (badRequest)",
      err && err.badRequest === true && /refused BEFORE the write/.test(err.message));
    check("…and turn-action never went on the wire",
      !calls.some((c) => c.method === "_x.ai/hunk-tracker/turn-action"));
  }
  /* The epoch also catches a turn that started AND finished inside the window
     (rec.turn is null again, but the epoch moved). */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
    replies["_x.ai/hunk-tracker/get-hunks"] = () => {
      (manager as any).sessions.get("s").turnEpoch++; // turn came and went
      return env({ hunks: [HUNK_ALPHA] });
    };
    const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
    check("a moved epoch alone (turn started and finished mid-read) also refuses",
      err && err.badRequest === true && /refused BEFORE the write/.test(err.message));
    check("…and nothing went on the wire for it either",
      !calls.some((c) => c.method === "_x.ai/hunk-tracker/hunk-action"));
  }
}

// 29. Codex I3 / Opus F2 — an UNREADABLE confirming get-hunks refuses the
//     accept (never []≡[] → send, never a false "changed since you read it").
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () => ({}); // no hunks array at all
  const err = await refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", []));
  check("an unreadable confirming read refuses even an empty expected digest",
    err && err.badRequest === true && /could not be read/.test(err.message));
  check("…and the refusal never says the file changed (nothing was read)",
    !/changed since you read it/.test(err.message));
  check("…and file-action never went on the wire",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/file-action"));
}

// 30. Codex B2 — malformed NESTED records are unreadable, not zero:
//     pendingHunks:"unreadable", a file row with no path, a hunk with no id.
{
  /* turnAction: after-summary with a non-array pendingHunks */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    seedPrompt(manager, "s", 0);
    let summaries = 0;
    replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: FILES_PENDING });
    replies["_x.ai/hunk-tracker/get-summary"] = () => {
      summaries++;
      return summaries >= 2
        ? env({ turns: [{ promptIndex: 0, pendingHunks: "unreadable" }] })
        : env(SUMMARY_PENDING);
    };
    replies["_x.ai/hunk-tracker/turn-action"] = () => env({ success: true, affectedCount: 2 });
    const out = await manager.turnAction("s", 0, "reject");
    check("a non-array pendingHunks in the after-read is changed:false, never success",
      out.changed === false);
    check("…and says the result could not be verified", /could not be verified/.test(out.note));
  }
  /* changes(): a file row with no path makes filesOk false */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: [{}] });
    replies["_x.ai/hunk-tracker/get-summary"] = () => env(SUMMARY_PENDING);
    const reading = await manager.changes("s");
    check("a file row without a string path makes filesOk:false", reading.filesOk === false);
  }
  /* changes(): a hunk without a string id makes summaryOk false */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: FILES_PENDING });
    replies["_x.ai/hunk-tracker/get-summary"] = () =>
      env({ turns: [{ promptIndex: 0, files: [], pendingHunks: [{ path: "/repo/alpha.txt" }] }] });
    const reading = await manager.changes("s");
    check("a pending hunk without a string id makes summaryOk:false", reading.summaryOk === false);
  }
}

// 31. Opus F7 — "400 ⇒ nothing was sent" is structural: once the action's
//     request has resolved, any downstream throw is re-raised WITHOUT
//     badRequest and with a message no caller-error regex matches (→ 500).
{
  const { manager, replies } = rig();
  held(manager, "s", "/repo");
  wireAllHunks(replies, [HUNK_ALPHA]);
  replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 1 });
  /* The post-send re-read dies with an error whose message WOULD map to a 400
     if it escaped raw (it matches the caller-error prefix). */
  replies["_x.ai/hunk-tracker/get-files"] = () => {
    throw new Error("the agent is not ready (state: gone)");
  };
  replies["_x.ai/hunk-tracker/get-summary"] = () => env(SUMMARY_PENDING);
  const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
  check("a post-send failure never carries badRequest", err && err.badRequest !== true);
  check("…and its message says the action was SENT (→ 500, never 'Nothing was changed')",
    !!err && /was SENT/.test(err.message) && !/^the agent is not ready/.test(err.message));
  check("…and it carries the structural sent flag (Opus M2: no message regex can flip it)",
    (err as any).sent === true);
}

// 31b. Opus M2 — the SEND itself failing is also structural: even when the
//      raw error text contains an unanchored caller-error phrase, the
//      surfaced error carries sent:true and the HTTP classifier checks that
//      flag FIRST (source-pinned), so a fired-or-maybe-fired action can
//      never come out as a 400 "nothing was changed".
{
  const { manager, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  wireAllHunks(replies, [HUNK_ALPHA]);
  replies["_x.ai/hunk-tracker/hunk-action"] = () => {
    throw new Error("hub error: is already live in this app"); // unanchored-regex bait
  };
  const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
  check("a send-time failure carries sent:true and no badRequest",
    err && (err as any).sent === true && err.badRequest !== true);
  check("…and says whether it reached the agent is unknown",
    !!err && /whether it reached the agent is unknown/.test(err.message));
  const HERE6 = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE6, "server.ts"), "utf8");
  check("the HTTP classifier honours the sent flag before any message regex",
    /e\?\.sent === true\s*\?\s*false/.test(serverSrc));
}

// 32. Codex 4 / Grok R2-M1 / Opus N8 — two CONCURRENT accepts of the same
//     file are serialized per session; the second one's late digest re-read
//     sees the file's hunks already gone (the fixture tracks the accept,
//     unlike round 2's constant one) and is refused pre-wire.
//     acceptedByTurn is counted exactly once.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  let alphaGone = false;
  replies["_x.ai/hunk-tracker/get-files"] = () =>
    env({ files: alphaGone ? FILES_PENDING.slice(1) : FILES_PENDING });
  replies["_x.ai/hunk-tracker/get-summary"] = () => env(SUMMARY_PENDING);
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: alphaGone ? [] : [HUNK_ALPHA] });
  replies["_x.ai/hunk-tracker/file-action"] = () => {
    alphaGone = true;
    return env({ success: true, affectedCount: 1 });
  };
  const [r1, r2] = await Promise.all([
    manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]),
    refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"])),
  ]);
  check("the first accept is confirmed", (r1 as any).changed === true);
  check("the second (serialized) accept is refused pre-wire by the late digest re-read",
    r2 && (r2 as any).badRequest === true && /changed since you read it/.test((r2 as any).message));
  check("the second accept never reached the wire",
    calls.filter((c) => c.method === "_x.ai/hunk-tracker/file-action").length === 1);
  check("acceptedByTurn counted the file's hunk exactly once",
    (manager as any).sessions.get("s").acceptedByTurn.get(0) === 1);
}

// 32b. Codex 1 (confirm round) — the digest re-read is the LAST read before
//      the send: nothing but synchronous guards separate them.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies,
    { files: FILES_PENDING, summary: SUMMARY_PENDING },
    { files: FILES_PENDING.slice(1), summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () => env({ hunks: [HUNK_ALPHA] });
  replies["_x.ai/hunk-tracker/file-action"] = () => env({ success: true, affectedCount: 1 });
  await manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"]);
  const methods = calls.map((c) => c.method);
  const sendAt = methods.indexOf("_x.ai/hunk-tracker/file-action");
  check("the digest get-hunks is the call immediately before file-action",
    sendAt >= 1 && methods[sendAt - 1] === "_x.ai/hunk-tracker/get-hunks");
}

// 32c. Opus N1 — the guard's scope is the FOLDER: a turn running on a second
//      session with the same cwd refuses the action, exactly like this
//      session's own turn. A turn in a DIFFERENT folder does not.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  held(manager, "s2", "/repo"); // same folder
  (manager as any).sessions.get("s2").turn = { startedAt: 1, watchdog: null };
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  wireAllHunks(replies, [HUNK_ALPHA]);
  const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
  check("a sibling session's turn in the same folder refuses the undo",
    err && err.badRequest === true && /same folder/.test(err.message));
  check("…and nothing went on the wire", calls.length === 0);

  const h2 = rig();
  held(h2.manager, "s", "/repo");
  held(h2.manager, "s3", "/elsewhere"); // different folder
  (h2.manager as any).sessions.get("s3").turn = { startedAt: 1, watchdog: null };
  wireChanges(h2.replies, { files: FILES_PENDING, summary: SUMMARY_PENDING },
    { files: FILES_PENDING.slice(1), summary: SUMMARY_PENDING });
  wireAllHunks(h2.replies, [HUNK_ALPHA, HUNK_BETA], [HUNK_BETA]);
  h2.replies["_x.ai/hunk-tracker/hunk-action"] = () => env({ success: true, affectedCount: 1 });
  const out = await h2.manager.hunkAction("s", "h-alpha", "reject");
  check("a turn in a DIFFERENT folder does not block the action", out.changed === true);
}

// 32d. Opus N5 — the queue re-checks liveness at dequeue: an action that
//      waited behind a slow one while the agent died is refused (400), not
//      fired into a dead process.
{
  const { manager, replies } = rig();
  held(manager, "s", "/repo");
  wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
  replies["_x.ai/hunk-tracker/get-hunks"] = () => {
    /* The first action's digest read is where the death lands. */
    (manager as any).sessions.get("s").live = false;
    return env({ hunks: [HUNK_ALPHA] });
  };
  replies["_x.ai/hunk-tracker/file-action"] = () => env({ success: true, affectedCount: 1 });
  const [r1, r2] = await Promise.all([
    refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"])),
    refusal(() => manager.fileAction("s", "/repo/alpha.txt", "accept", ["h-alpha"])),
  ]);
  check("the queued action is refused at dequeue with the not-live refusal",
    r2 && /not live/.test((r2 as any).message));
}

// 32e. Opus N2 — pre-wire failures carry notSent, even at 500: the
//      unreadable-pre-read refusal is marked, so the page's sentence can be
//      single-minded.
{
  const { manager, calls, replies } = rig();
  held(manager, "s", "/repo");
  seedPrompt(manager, "s", 0);
  replies["_x.ai/hunk-tracker/get-files"] = () => env({ files: FILES_PENDING });
  replies["_x.ai/hunk-tracker/get-summary"] = () => ({}); // unreadable
  const err = await refusal(() => manager.turnAction("s", 0, "reject"));
  check("the pre-send read failure carries the notSent marker",
    err && (err as any).notSent === true && err.badRequest !== true);
  check("…and turn-action never went on the wire",
    !calls.some((c) => c.method === "_x.ai/hunk-tracker/turn-action"));
}

// 32f. Round-3 hygiene pins: the chains map is cleared on agent death and on
//      session delete (Opus N4 / Grok C3-M3), and the round-2 report's claim
//      is now true.
{
  const HERE5 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE5, "sessions.ts"), "utf8");
  const gone = src.slice(src.indexOf("private async onAgentGone"));
  check("onAgentGone clears changeActionChains",
    gone.slice(0, gone.indexOf("for (const rec of this.sessions.values())")).includes("changeActionChains.clear()"));
  check("deleteSession drops the session's chain entry",
    src.includes("this.changeActionChains.delete(sessionId)"));
}

// 32h. WP12 F2 — the tracker-suspect mechanism: set on death mid-turn
//      (source-pinned; the respawn path cannot run in this rig), cleared only
//      by a positively non-empty reading, and a positively-empty reading on a
//      suspect session rides the git/status cross-check. Never on a
//      non-suspect session, never on a non-empty reading.
{
  const HERE7 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE7, "sessions.ts"), "utf8");
  const gone = src.slice(src.indexOf("private async onAgentGone"));
  check("a turn in flight at death marks the record trackerSuspect",
    gone.includes("rec.trackerSuspect = true"));

  /* Suspect + positively EMPTY + dirty git → annotated. */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () => env({ staged: [], unstaged: [{ path: "delta.txt" }] });
    const r = await manager.changes("s");
    check("a suspect session's empty reading is annotated suspect with the cross-check",
      r.suspect === true && r.gitDirty === true);
    check("the cross-check asked git/status with the sessionId and untracked included",
      calls.some((c) => c.method === "_x.ai/git/status" &&
        c.params.sessionId === "s" && c.params.includeUntracked === true));
    check("a dirty-but-seen tracker does NOT clear on the cross-check alone",
      (manager as any).sessions.get("s").trackerSuspect === true);
  }
  /* Suspect + clean git → gitDirty false (the clean sentence may stand). */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () => env({ staged: [], unstaged: [] });
    const r = await manager.changes("s");
    check("a suspect session with a clean cross-check reads gitDirty:false",
      r.suspect === true && r.gitDirty === false);
  }
  /* Suspect + non-empty reading → the flag CLEARS, and no git call is made. */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
    const r = await manager.changes("s");
    check("a non-empty reading clears the suspect flag (no false-positive on accepts/human edits)",
      (manager as any).sessions.get("s").trackerSuspect === false && r.suspect === undefined);
    check("…and the cross-check never fires on a non-empty reading",
      !calls.some((c) => c.method === "_x.ai/git/status"));
  }
  /* Non-suspect + empty → no git call, no annotation. */
  {
    const { manager, calls, replies } = rig();
    held(manager, "s", "/repo");
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    const r = await manager.changes("s");
    check("a NON-suspect session never triggers the cross-check",
      r.suspect === undefined && !calls.some((c) => c.method === "_x.ai/git/status"));
  }
  /* Unreadable git payload → gitDirty null, loud, never guessed. */
  {
    const { manager, replies, counts } = rig();
    held(manager, "s", "/repo");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () => env({ branch: "main" }); // no staged/unstaged arrays
    const r = await manager.changes("s");
    check("an unreadable cross-check payload is gitDirty:null, never a guess",
      r.gitDirty === null && counts.louds >= 1);
  }
}

// 32i. Opus B2 — the cross-check is repo-rooted but the sentence says
//      "this folder": the count is scoped to paths under the session's cwd.
{
  /* cwd IS the repo root → the whole reply counts. */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: "elsewhere.txt", type: "edit" }] });
    const r = await manager.changes("s");
    check("a session AT the repo root counts the whole reply", r.gitDirty === true);
  }
  /* Subdirectory session: dirt elsewhere in the repo does not count… */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo/services/api");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: "web/x.txt", type: "edit" }] });
    const r = await manager.changes("s");
    check("a subdirectory session ignores dirt outside its subtree", r.gitDirty === false);
  }
  /* …and dirt inside it counts. */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo/services/api");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: "services/api/x.txt", type: "edit" }] });
    const r = await manager.changes("s");
    check("…and dirt inside its own subtree counts", r.gitDirty === true);
  }
  /* A root that is not an ancestor of the cwd: the reply cannot answer the
     folder's question — null and loud, never a guess. */
  {
    const { manager, replies, counts } = rig();
    held(manager, "s", "/repo/services/api");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/elsewhere", staged: [], unstaged: [{ path: "x.txt" }] });
    const r = await manager.changes("s");
    check("a non-ancestor root makes the cross-check null + loud",
      r.gitDirty === null && counts.louds >= 1);
  }
}

// 32j. Codex round 2 — the gate semantics live SERVER-side: the snapshot
//      carries the resolved state, so a bare false never clobbers it for a
//      reloaded page, and a malformed update never touches it.
{
  const { manager } = rig();
  held(manager, "s", "/repo");
  const snap = () => (manager as any).snapshot().gate;
  const settings = (params: any) =>
    (manager as any).onNotification({ method: "_x.ai/settings/update", params });
  settings({ allow_access: false, gate_message: "Gated.", gate_url: null, gate_label: null, subscription_tier_display: null });
  check("1: a message-bearing false stores the gate", snap() && snap().gateMessage === "Gated.");
  settings({ allow_access: false, gate_message: null, gate_url: null, gate_label: null, subscription_tier_display: null });
  check("2: a bare false LEAVES the stored gate alone", snap() && snap().gateMessage === "Gated.");
  check("3: the snapshot carries the resolved state (an F5 page still banners)",
    snap().allowAccess === false);
  settings({ allow_access: true, gate_message: null, gate_url: null, gate_label: null, subscription_tier_display: null });
  check("4: a true CLEARS the stored gate", snap() === null);
  check("5: the snapshot after the clear carries no gate (an F5 page shows none)",
    snap() === null);
  settings({ allow_access: false, gate_message: "Gated.", gate_url: null, gate_label: null, subscription_tier_display: null });
  settings({ show_resolved_model: true }); // missing every gate field
  check("a malformed update never clobbers the stored state",
    snap() && snap().gateMessage === "Gated.");
}

// 32k. Opus B1 / M5 — source-pinned: a successful loadSession invalidates the
//      recovery outcome, and the manual-retry path stamps it symmetrically.
{
  const HERE8 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE8, "sessions.ts"), "utf8");
  const load = src.slice(src.indexOf("async loadSession"));
  check("a successful loadSession nulls rec.recovery (no stale 'could NOT be reloaded')",
    load.slice(0, load.indexOf("async setMode")).includes("rec.recovery = null"));
  const retry = src.slice(src.indexOf("async retryStart"));
  check("the manual-retry restore loop stamps recovery like the respawn does",
    retry.includes("rec.recovery = { generation, ok: true, error: null }") &&
      retry.includes("rec.recovery = { generation, ok: false, error: message }"));
  check("…off the CAPTURED generation AND death marker, aborted on a mid-loop death (CONFIRM3)",
    retry.includes("const deathSeq = this.acp.deathSeq") &&
      retry.includes("this.acp.deathSeq !== deathSeq"));
}

// 32l. Round 3 — the server is the single gate resolver: the RESOLVED state
//      is broadcast on change only; bare-false and malformed stay silent.
{
  const { manager, emitted } = rig();
  held(manager, "s", "/repo");
  const settings = (params: any) =>
    (manager as any).onNotification({ method: "_x.ai/settings/update", params });
  const gateEvents = () => emitted.filter((e) => e.type === "bridge.gate_state");
  settings({ allow_access: false, gate_message: "Gated.", gate_url: null, gate_label: null, subscription_tier_display: null });
  check("a set broadcasts the resolved gate",
    gateEvents().length === 1 && (gateEvents()[0].data as any).gate.gateMessage === "Gated.");
  settings({ allow_access: false, gate_message: null, gate_url: null, gate_label: null, subscription_tier_display: null });
  check("a bare false broadcasts NOTHING (leave-alone, live too)", gateEvents().length === 1);
  settings({ allow_access: true, gate_message: null, gate_url: null, gate_label: null, subscription_tier_display: null });
  check("a clear broadcasts gate:null", gateEvents().length === 2 && gateEvents()[1].data.gate === null);
  settings({ show_resolved_model: true }); // malformed: every gate field absent
  check("a malformed update broadcasts nothing and stores nothing", gateEvents().length === 2);
  /* Codex final M1: the SET branch is change-guarded too — an identical
     re-assert must not rebroadcast (each one rebuilds the banner and drops
     DOM focus); a genuinely changed one must. */
  settings({ allow_access: false, gate_message: "Gated again.", gate_url: null, gate_label: null, subscription_tier_display: null });
  const afterNewSet = gateEvents().length;
  settings({ allow_access: false, gate_message: "Gated again.", gate_url: null, gate_label: null, subscription_tier_display: null });
  check("an identical re-assert does NOT rebroadcast", gateEvents().length === afterNewSet);
  settings({ allow_access: false, gate_message: "Changed gate.", gate_url: null, gate_label: null, subscription_tier_display: null });
  check("a changed gate re-asserts (and broadcasts)", gateEvents().length === afterNewSet + 1);
}

// 32m. Round 3 cross-check edges: the untracked-directory collapse (NEW-1),
//      malformed string paths (Codex m2), the canonical cwd compare (C2/NEW-3),
//      and the once-per-cause loud latch (NEW-8).
{
  /* A collapsed wholly-untracked directory ABOVE the session folder counts. */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo/scratch/sub");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: "scratch/", type: "untracked" }] });
    const r = await manager.changes("s");
    check("a collapsed untracked DIRECTORY ancestor of the session counts as dirty (NEW-1)",
      r.gitDirty === true);
  }
  /* Malformed-but-string paths never read as clean. */
  {
    const { manager, replies } = rig();
    held(manager, "s", "/repo/services/api");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: "/absolute/elsewhere.txt" }] });
    const r1 = await manager.changes("s");
    check("an absolute (non-repo-relative) string path counts as in-scope", r1.gitDirty === true);
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: "./services/api/x.txt" }] });
    const r2 = await manager.changes("s");
    check("a ./-prefixed string path normalises and counts", r2.gitDirty === true);
  }
  /* The compare is against the CANONICAL cwd: a symlinked session folder and
     git's realpath'd root agree. */
  {
    const real = mkdtempSync(join(tmpdir(), "wp12-real-"));
    const alias = join(tmpdir(), `wp12-alias-${process.pid}`);
    symlinkSync(real, alias);
    try {
      const { manager, replies } = rig();
      held(manager, "s", alias);
      (manager as any).sessions.get("s").trackerSuspect = true;
      wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
      replies["_x.ai/git/status"] = () =>
        env({ root: real, staged: [], unstaged: [{ path: "x.txt", type: "edit" }] });
      const r = await manager.changes("s");
      check("a symlinked cwd compares canonically against the realpath'd root (C2/NEW-3)",
        r.gitDirty === true);
    } finally {
      rmSync(alias, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  }
  /* The loud latch: a failing cross-check louds ONCE per cause per session,
     however often the pane polls — and ALTERNATING causes each speak once
     (the latch is a Set, Codex final M2). */
  {
    const { manager, replies, counts } = rig();
    held(manager, "s", "/repo");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    let mode = "throw";
    replies["_x.ai/git/status"] = () => {
      if (mode === "throw") throw new Error("no git here");
      return env({ branch: "main" }); // unreadable: no staged/unstaged arrays
    };
    await manager.changes("s");
    await manager.changes("s");
    check("the cross-check louds once per cause, not per poll (NEW-8)", counts.louds === 1);
    mode = "unreadable";
    await manager.changes("s");
    check("a SECOND cause louds once", counts.louds === 2);
    mode = "throw";
    await manager.changes("s");
    check("…and alternating back does NOT re-loud the first cause", counts.louds === 2);
  }
  /* Malformed-but-string path shapes count as in-scope, never silent clean
     (Codex final M3 / Grok R2; R3 added the exotic shapes). */
  for (const bad of ["", ".", "./", "../outside", "...", "foo/../../x"]) {
    const { manager, replies } = rig();
    held(manager, "s", "/repo/services/api");
    (manager as any).sessions.get("s").trackerSuspect = true;
    wireChanges(replies, { files: [], summary: SUMMARY_CLEAN });
    replies["_x.ai/git/status"] = () =>
      env({ root: "/repo", staged: [], unstaged: [{ path: bad }] });
    const r = await manager.changes("s");
    check(`a malformed path shape (${JSON.stringify(bad)}) counts as in-scope`, r.gitDirty === true);
  }
}

// 32n. Codex final I1 — source-pinned: the respawn generation is captured
//      BEFORE the reload loop's awaits, and every stamp plus the
//      bridge.respawned payload uses the captured value. CONFIRM2 I1: the
//      loop re-reads the generation and ABORTS on mismatch — a dead
//      lifetime publishes no stamps and no event.
{
  const HERE9 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE9, "sessions.ts"), "utf8");
  const respawn = src.slice(src.indexOf("private async respawnAndReload"));
  check("the respawn generation is captured before the awaited reload loop",
    respawn.indexOf("const generation = this.agentGeneration") < respawn.indexOf("await this.loadSession"));
  check("stamps and the bridge.respawned payload use the CAPTURED generation",
    respawn.includes("rec.recovery = { generation, ok: true, error: null }") &&
      respawn.includes("agentGeneration: generation }"));
  check("the loop aborts silently when the lifetime changed mid-recovery (CONFIRM2 I1)",
    respawn.includes("this.acp.deathSeq !== deathSeq"));
  /* The marker's placement in acp.ts is the load-bearing half: it must move
     BEFORE failAllPending delivers any rejection. */
  const acpSrc = readFileSync(join(HERE9, "acp.ts"), "utf8");
  const exitAt = acpSrc.indexOf('child.on("exit"');
  check("acp.ts moves the death marker BEFORE failAllPending in the exit handler",
    exitAt >= 0 &&
      acpSrc.indexOf("this.deathSeqCounter++", exitAt) < acpSrc.indexOf("this.failAllPending", exitAt));
  check("the marker is read-only to the outside (private counter + getter)",
    acpSrc.includes("private deathSeqCounter = 0;") && acpSrc.includes("get deathSeq()"));
}

// 32o. Codex CONFIRM3 — the synchronous boundary, EXECUTED for real. A fake
//      agent child (node, never answers), a recovery reload in flight, then
//      the child is killed: the exit handler moves deathSeq BEFORE any
//      pending rejection is delivered, and `gone` (the generation bump)
//      trails it. The dead lifetime publishes nothing.
{
  const manager = new SessionManager(process.cwd(), {
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
    cleanupGraceMs: 50,
  } as any);
  const emitted: AppEvent[] = [];
  manager.on("app", (ev: AppEvent) => emitted.push(ev));
  (manager.acp as any).note = () => {};
  (manager.acp as any).loud = () => {};
  (manager as any).initialize = async () => {};
  (manager.acp as any).restart = () => {}; // never actually respawn in this rig
  (manager as any).stopping = true; // the post-gone cascade narrates nothing here
  held(manager, "s", "/repo");
  const rec = (manager as any).sessions.get("s");
  rec.live = false; /* onAgentGone clears live before any respawn — mirror it, or loadSession refuses as "already live" */

  let goneFired = false;
  manager.acp.once("gone", () => { goneFired = true; });
  (manager.acp as any).start();
  const pid = manager.acp.pid;
  check("the fake agent child is up", typeof pid === "number" && manager.acp.alive);
  const seqBefore = manager.acp.deathSeq;

  /* A probe request whose rejection timestamps the window: when the pending
     rejection is DELIVERED, the marker must already have moved and `gone`
     must NOT have fired yet. */
  let seqAtReject = -1;
  let goneAtReject: boolean | null = null;
  const probe = (manager.acp as any).request("session/load", {}).catch(() => {
    seqAtReject = manager.acp.deathSeq;
    goneAtReject = goneFired;
  });

  /* The recovery loop, started against the live-but-silent child: it parks
     on the loadSession await. */
  const recovery = (manager as any).respawnAndReload([rec]);
  await new Promise((r) => setImmediate(r)); // let it reach the wire
  process.kill(pid!); // the death: exit handler runs synchronously
  await recovery;
  await probe;
  /* Let the deferred `gone` land before we check what was published. */
  if (!goneFired) await new Promise((r) => manager.acp.once("gone", r));

  check("the marker moved before the pending rejection was DELIVERED",
    seqAtReject === seqBefore + 1);
  check("…and `gone` (the generation bump) had NOT fired yet at that moment",
    goneAtReject === false);
  check("the dead lifetime published no bridge.session_load_failed",
    !emitted.some((e) => e.type === "bridge.session_load_failed"));
  check("…no bridge.respawned", !emitted.some((e) => e.type === "bridge.respawned"));
  check("…and no rec.recovery stamp", rec.recovery === null);
}

/* Shared rig for the two CONFIRM4 scenarios: a real AcpClient driving a real
   silent child, stubs only where a respawn would spawn. */
function deathRig() {
  const manager = new SessionManager(process.cwd(), {
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
    cleanupGraceMs: 50,
  } as any);
  const emitted: AppEvent[] = [];
  const louds: string[] = [];
  manager.on("app", (ev: AppEvent) => emitted.push(ev));
  (manager.acp as any).note = () => {};
  (manager.acp as any).loud = (m: any) => { louds.push(String(m)); };
  (manager as any).initialize = async () => {};
  (manager.acp as any).restart = () => {};
  (manager.acp as any).stopForRetry = async () => {};
  (manager as any).stopping = true;
  return { manager, emitted, louds };
}

// 32p. Codex CONFIRM4 B1 — retryStart must not publish the aggregate line
//      after the marker moves: session A fails ORDINARILY, the child dies
//      during session B's restore, and the dead lifetime narrates nothing.
//      (CONFIRM5: both sessions are HELD — an unknown id would make
//      loadSession CREATE a record and park A on the wire, leaving B
//      unreached and the aggregate guard vacuous. A's failure is a stubbed
//      ordinary request error; B delegates to the real silent child.)
{
  const { manager, emitted, louds } = deathRig();
  held(manager, "a", "/repo");
  held(manager, "b", "/repo");
  (manager as any).sessions.get("a").live = false;
  (manager as any).sessions.get("b").live = false;
  (manager as any).state = "failed";
  (manager as any).failedRetrySessions = [
    { sessionId: "a", cwd: "/repo" },
    { sessionId: "b", cwd: "/repo" },
  ];
  let goneFired = false;
  manager.acp.once("gone", () => { goneFired = true; });
  (manager.acp as any).start();
  const pid = manager.acp.pid;
  /* A's session/load fails with an ORDINARY error (the stub throws only for
     A); B's goes to the real child and parks. The call order is recorded so
     the test proves B was reached before the kill. */
  const callOrder: string[] = [];
  const realRequest = (manager.acp as any).request.bind(manager.acp);
  (manager.acp as any).request = (method: string, params: any, ...rest: any[]) => {
    callOrder.push(params?.sessionId ?? "?");
    if (params?.sessionId === "a") throw new Error("history file unreadable");
    return realRequest(method, params, ...rest);
  };
  const retry = (manager as any).retryStart();
  await new Promise((r) => setImmediate(r)); // A fails ordinarily; B parks on the wire
  check("the restore loop reached A and then B before the kill (the scenario is real)",
    callOrder.join(",") === "a,b");
  process.kill(pid!);
  await retry;
  if (!goneFired) await new Promise((r) => manager.acp.once("gone", r));
  check("retryStart: no aggregate 'could NOT be reloaded' from the dead lifetime",
    !louds.some((m) => m.includes("could NOT be reloaded")));
  check("retryStart: no recovery stamp on the session that was mid-load",
    (manager as any).sessions.get("b").recovery === null);
  check("retryStart: no session_load_failed for B from the dead lifetime",
    !emitted.some((e) => e.type === "bridge.session_load_failed" && (e.data as any).sessionId === "b"));
}

// 32q. Codex CONFIRM4 M1 — a recovery-load that dies with an OPEN interaction
//      publishes nothing: no interaction.abandoned, no session_load_failed;
//      the open interaction is LEFT for onAgentGone's own sweep to narrate.
{
  const { manager, emitted } = deathRig();
  held(manager, "s", "/repo");
  const rec = (manager as any).sessions.get("s");
  rec.live = false;
  (manager as any).openInteractions.set("k1", {
    sessionId: "s", id: 42, method: "session/request_permission",
    event: { type: "interaction.permission_requested" },
  });
  let goneFired = false;
  manager.acp.once("gone", () => { goneFired = true; });
  (manager.acp as any).start();
  const pid = manager.acp.pid;
  const recovery = (manager as any).respawnAndReload([rec]);
  await new Promise((r) => setImmediate(r)); // the load parks on the wire
  process.kill(pid!);
  await recovery;
  check("the dead lifetime emitted NO interaction.abandoned",
    !emitted.some((e) => e.type === "interaction.abandoned"));
  check("…and no bridge.session_load_failed",
    !emitted.some((e) => e.type === "bridge.session_load_failed"));
  check("the open interaction was LEFT for the owning cycle",
    (manager as any).openInteractions.has("k1"));
  if (!goneFired) await new Promise((r) => manager.acp.once("gone", r));
  const abandoned = emitted.filter((e) => e.type === "interaction.abandoned");
  check("the abandonment that eventually lands is the DEATH's own narration",
    abandoned.length >= 1 &&
      abandoned.every((e) => String((e.data as any).reason || "").includes("exited")));
}

// 32g. Codex final-round 2 — the sibling guard compares CANONICAL folders:
//      a symlink alias of the same directory must not slip it.
{
  const real = mkdtempSync(join(tmpdir(), "wp11-real-"));
  const alias = join(tmpdir(), `wp11-alias-${process.pid}`);
  symlinkSync(real, alias);
  try {
    const { manager, calls, replies } = rig();
    held(manager, "s", real);
    held(manager, "s2", alias); // the same folder, spelled through a symlink
    (manager as any).sessions.get("s2").turn = { startedAt: 1, watchdog: null };
    wireChanges(replies, { files: FILES_PENDING, summary: SUMMARY_PENDING });
    wireAllHunks(replies, [HUNK_ALPHA]);
    const err = await refusal(() => manager.hunkAction("s", "h-alpha", "reject"));
    check("a sibling turn running through a SYMLINK alias refuses the undo",
      err && err.badRequest === true && /same folder/.test(err.message));
    check("…and nothing went on the wire", calls.length === 0);
  } finally {
    rmSync(alias, { force: true });
    rmSync(real, { recursive: true, force: true });
  }
}

// ══ PART 2 — the page (fake DOM, real app.js) ═════════════════════════════

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(HERE, "public", "app.js");
const APP_SOURCE = readFileSync(APP_PATH, "utf8");

class FakeElement {
  tagName: string;
  owner: FakeDocument;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  classList = { add() {}, remove() {}, toggle() {} };
  hidden = false;
  disabled = false;
  value = "";
  title = "";
  onclick: null | ((e?: any) => void) = null;
  onchange: null | (() => void) = null;
  oninput: null | (() => void) = null;
  onkeydown: null | ((e?: any) => void) = null;
  onmouseenter: null | (() => void) = null;
  onmouseleave: null | ((e?: any) => void) = null;
  selectedIndex = 0;
  selectionStart = 0;
  selectionEnd = 0;
  scrollHeight = 1_000;
  scrollTop = 1_000;
  clientHeight = 500;
  listeners: Record<string, ((event: any) => void)[]> = {};
  private content = "";
  private elementId = "";

  constructor(tag: string, owner: FakeDocument) {
    this.tagName = tag.toUpperCase();
    this.owner = owner;
    owner.created.push(this);
  }

  set id(value: string) {
    this.elementId = value;
    if (value) this.owner.byId.set(value, this);
  }
  get id() { return this.elementId; }

  set textContent(value: string) {
    this.content = String(value ?? "");
    this.children = [];
  }
  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }
  get firstChild() { return this.children[0] ?? null; }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeElement, before: FakeElement | null) {
    child.parentNode = this;
    const at = before ? this.children.indexOf(before) : -1;
    if (at === -1) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this);
    if (this.id) this.owner.byId.delete(this.id);
  }
  addEventListener(type: string, fn: (event: any) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  setAttribute(name: string, value: string) { (this as any)[name] = String(value); }
  getAttribute(name: string) { return (this as any)[name] ?? null; }
  removeAttribute(name: string) { delete (this as any)[name]; }
  focus() { this.owner.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  querySelectorAll(selector: string) { return this.owner.querySelectorAll(selector); }
  getBoundingClientRect() { return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; }
  contains(node: FakeElement | null): boolean {
    let cur: FakeElement | null = node;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }
}

class FakeDocument {
  byId = new Map<string, FakeElement>();
  created: FakeElement[] = [];
  body = new FakeElement("body", this);
  activeElement: FakeElement | null = null;
  listeners: Record<string, ((event: any) => void)[]> = {};

  getElementById(id: string) {
    let value = this.byId.get(id);
    if (!value) {
      value = new FakeElement("div", this);
      value.id = id;
      if (id === "app") { value.dataset.rail = "expanded"; value.dataset.drawer = "closed"; }
      this.body.appendChild(value);
    }
    return value;
  }
  createElement(tag: string) { return new FakeElement(tag, this); }
  createTextNode(text: string) {
    const node = new FakeElement("#text", this);
    node.textContent = text;
    return node;
  }
  addEventListener(type: string, fn: (event: any) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  querySelectorAll(selector: string) {
    const m = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
    if (m) return this.created.filter((node) => String(node.className).split(" ").includes(m[1]));
    return [];
  }
}

interface Harness {
  document: FakeDocument;
  api: any;
  posts: { path: string; body: any }[];
  route: (path: string, fn: (body: any) => any) => void;
  timeouts: { fn: () => void; ms: number }[];
}

/**
 * The app-recovery harness, reduced: the real app.js against a fake DOM, with
 * per-test POST routes and a RECORDING setTimeout (the F8 delayed re-read must
 * be schedulable without keeping this process alive for three real seconds).
 */
function harness(): Harness {
  const document = new FakeDocument();
  const posts: { path: string; body: any }[] = [];
  const customRoutes: Record<string, (body: any) => any> = {};
  const timeouts: { fn: () => void; ms: number }[] = [];
  class FakeEventSource {
    url: string;
    onopen: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onmessage: null | ((event: { data: string }) => void) = null;
    constructor(url: string) { this.url = url; }
  }
  const context: any = {
    console,
    document,
    location: { search: `?token=${"a".repeat(64)}` },
    URLSearchParams,
    fetch: async (url: string, init?: { body?: string }) => {
      let body: any = {};
      try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
      const path = String(url);
      posts.push({ path, body });
      if (customRoutes[path]) {
        const resp = customRoutes[path](body);
        /* A route may carry _status to simulate a non-200 (the page's post()
           reads the real response status into j.httpStatus). */
        return { status: resp && typeof resp._status === "number" ? resp._status : 200, json: async () => resp };
      }
      return { status: 200, json: async () => ({ error: "fixture" }) };
    },
    EventSource: FakeEventSource,
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    setTimeout: (fn: () => void, ms?: number) => { timeouts.push({ fn, ms: ms ?? 0 }); return timeouts.length; },
    clearTimeout: (id: number) => { if (timeouts[id - 1]) timeouts[id - 1].fn = () => {}; },
    setInterval: () => 1,
    clearInterval: () => {},
    isFinite,
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
  context.window = { innerHeight: 900, innerWidth: 1280, addEventListener() {} };
  context.globalThis = context;
  const expose = `\n;globalThis.__APP_TEST__ = {
    receive, handle, view, setActive: setActiveSession,
    setAgent: (value) => { agent = value; },
    notes: () => shellNotes.slice(),
    renderChangesPanel, renderTurnFoot, renderDrawer,
    applyChangesReading, changesEntryForTurn, refreshChanges, selectSession,
  };`;
  runInNewContext(APP_SOURCE + expose, context, { filename: APP_PATH });
  return {
    document, api: context.__APP_TEST__, posts, timeouts,
    route: (path, fn) => { customRoutes[path] = fn; },
  };
}

/** Microtask flush: the fake fetch resolves through two promise hops. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function appEvent(
  id: number,
  type: string,
  data: Record<string, unknown> = {},
  delivery = "current",
  sessionId: string | null = "s",
) {
  return {
    type,
    wireKind: "",
    rail: type.startsWith("bridge.") || type.startsWith("turn.") ? "bridge" : "acp",
    sessionId,
    replay: false,
    modelled: true,
    data,
    raw: null,
    t: 1_000 + id,
    deliveryId: id,
    delivery,
  };
}

/** Boot the page the way app-recovery does: channel_open, then select "s".
    turnInFlight:false is load-bearing: the changes actions fail CLOSED when
    the turn state is unknown (Codex 2), so a fixture that omits it locks
    every button. agentGeneration:0 likewise: stamps bind only when their
    minted generation matches the server's (round 3). */
function open(h: Harness, agentGeneration = 0) {
  h.api.handle({
    ...appEvent(0, "bridge.channel_open", {
      agent: { state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, agentGeneration, sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false }], openInteractions: [] },
      recovery: { mode: "reconstruction", losses: [] },
    }),
    deliveryId: null,
  });
  h.api.setActive("s");
}

const drawer = (h: Harness) => h.document.getElementById("drawerBody");
const drawerOpen = (h: Harness) => { h.document.getElementById("app").dataset.drawer = "open"; };
const buttonsIn = (node: FakeElement): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement) => {
    if (n.tagName === "BUTTON") out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
};

// 13. Empty state: a reading with no files says "No unreviewed changes" —
//     never a blank panel.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.applyChangesReading("s", { files: [], summary: SUMMARY_CLEAN });
  h.api.renderDrawer();
  check("an empty reading renders 'No unreviewed changes'", drawer(h).textContent.includes("No unreviewed changes"));
}

// 14. Never-read and could-not-read are NOT the empty state.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.renderDrawer();
  check("a never-read pane says so (not 'no changes')",
    drawer(h).textContent.includes("Not read yet") && !drawer(h).textContent.includes("No unreviewed changes"));
  h.api.view("s").changes = { at: 1, files: [], summary: null, error: "the agent is not ready" };
  h.api.renderDrawer();
  check("a failed read says 'Could not be read' (not the empty state)",
    drawer(h).textContent.includes("Could not be read") && !drawer(h).textContent.includes("No unreviewed changes"));
}

// 15. The file list carries +N/−M and honest attribution: "agent" when the
//     tracker says so, and the WEAKER truth — "not attributed to the agent" —
//     when isAgentFile is false (evidence wp11/11: the tracker re-admits
//     agent-authored dirty files with isAgentFile:false; never "you").
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.applyChangesReading("s", {
    files: [
      { path: "/repo/alpha.txt", isAgentFile: true, staged: false, hunkCount: 1, additions: 3, deletions: 2 },
      { path: "/repo/gamma.txt", isAgentFile: false, staged: false, hunkCount: 1, additions: 1, deletions: 0 },
    ],
    summary: SUMMARY_PENDING,
  });
  h.api.renderDrawer();
  const text = drawer(h).textContent;
  check("the pane shows +N/−M from the reading", text.includes("+3") && text.includes("−2"));
  check("isAgentFile:true renders 'agent'", text.includes("agent"));
  check("isAgentFile:false renders 'not attributed to the agent', never 'you'",
    text.includes("not attributed to the agent") && !text.includes("you wrote this"));
}

// 15b. Codex 3: an unreadable files list (filesOk:false) is a read failure on
//      the pane — never the empty state.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.applyChangesReading("s", { files: [], filesOk: false, summary: null, summaryOk: false });
  h.api.renderDrawer();
  check("filesOk:false renders 'Could not be read', never 'No unreviewed changes'",
    drawer(h).textContent.includes("Could not be read") && !drawer(h).textContent.includes("No unreviewed changes"));
}

// 15c. WP12 F2 (page half): a tracker-suspect empty reading never renders the
//      bare clean sentence unless the cross-check positively said clean.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.applyChangesReading("s", { files: [], summary: SUMMARY_CLEAN, externalIds: [], suspect: true, gitDirty: true });
  h.api.renderDrawer();
  check("suspect + dirty git → the honest warning, never 'No unreviewed changes'",
    drawer(h).textContent.includes("may not be tracked for this recovered session") &&
      drawer(h).textContent.includes("Start a fresh session here") &&
      !drawer(h).textContent.includes("No unreviewed changes"));
  h.api.applyChangesReading("s", { files: [], summary: SUMMARY_CLEAN, externalIds: [], suspect: true, gitDirty: null });
  h.api.renderDrawer();
  check("suspect + cross-check unreadable → the qualified sentence (never the clean one)",
    drawer(h).textContent.includes("change tracking may be blind") &&
      !drawer(h).textContent.includes("No unreviewed changes"));
  h.api.applyChangesReading("s", { files: [], summary: SUMMARY_CLEAN, externalIds: [], suspect: true, gitDirty: false });
  h.api.renderDrawer();
  check("suspect + positively clean cross-check → the clean sentence may stand",
    drawer(h).textContent.includes("No unreviewed changes."));
  h.api.applyChangesReading("s", { files: [], summary: SUMMARY_CLEAN, externalIds: [] });
  h.api.renderDrawer();
  check("a non-suspect empty reading keeps the ordinary sentence",
    drawer(h).textContent.includes("No unreviewed changes."));
}

// 16. Hostile strings in hunk oldText/newText/path reach the DOM as TEXT —
//     no element with a dangerous tag is ever created (D31, rule 10).
{
  const h = harness();
  open(h);
  drawerOpen(h);
  const hostilePath = "/repo/<img src=x onerror=alert(1)>.txt";
  h.route("/changes/hunks", () => ({
    hunks: [{
      id: "h-hostile", path: hostilePath,
      lineInfo: { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      source: { type: "agentEdit", prompt_index: 0 },
      oldText: "<script>evil()</script>",
      newText: "</pre><svg onload=alert(2)>",
      patch: null, createdAt: "x",
    }],
  }));
  h.api.applyChangesReading("s", {
    files: [{ path: hostilePath, isAgentFile: true, staged: false, hunkCount: 1, additions: 1, deletions: 1 }],
    summary: SUMMARY_PENDING,
  });
  h.api.renderDrawer();
  const before = h.document.created.filter((n) => ["SCRIPT", "IMG", "SVG", "IFRAME"].includes(n.tagName)).length;
  /* Expand the file (the head button's own click) and let the lazy read land. */
  buttonsIn(drawer(h)).find((b) => b.textContent.includes(hostilePath))!.onclick!();
  await flush();
  check("the hostile path, oldText and newText all reach the DOM as text",
    drawer(h).textContent.includes("<img src=x onerror=alert(1)>") &&
      drawer(h).textContent.includes("<script>evil()</script>") &&
      drawer(h).textContent.includes("</pre><svg onload=alert(2)>"));
  const after = h.document.created.filter((n) => ["SCRIPT", "IMG", "SVG", "IFRAME"].includes(n.tagName)).length;
  check("no SCRIPT/IMG/SVG/IFRAME element was created by the hunk render", after === before);
  check("the before/after blocks are <pre> elements (text, not markup)",
    h.document.created.some((n) => n.tagName === "PRE" && String(n.className).includes("chg-old")) &&
      h.document.created.some((n) => n.tagName === "PRE" && String(n.className).includes("chg-new")));
  check("the hostile path reaches NO attribute either (Codex 7 — text-only boundary)",
    h.document.created.every((n) => n.title !== hostilePath));
}

// 17. An external hunk is DISPLAY-ONLY (the director's GO): the honest line, and no
//     undo button anywhere in it.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({
    hunks: [{
      id: "h-ext", path: "/repo/gamma.txt",
      lineInfo: { oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 },
      source: { type: "external" },
      oldText: "hello\n", newText: "hello\nhuman was here\n",
      patch: null, createdAt: "x",
    }],
  }));
  h.api.applyChangesReading("s", {
    files: [{ path: "/repo/gamma.txt", isAgentFile: false, staged: false, hunkCount: 1, additions: 1, deletions: 0 }],
    summary: SUMMARY_CLEAN,
  });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/gamma.txt"))!.onclick!();
  await flush();
  check("an external hunk says 'undo is only available for agent changes'",
    drawer(h).textContent.includes("undo is only available for agent changes"));
  check("an external hunk offers NO 'Undo this change' button",
    !buttonsIn(drawer(h)).some((b) => b.textContent === "Undo this change"));
  check("an external hunk is attributed to you", drawer(h).textContent.includes("you wrote this"));
}

// 18. Undo this change confirms ONCE (D62/D63's model): the first click arms
//     and sends nothing; the second click sends hunk-action with the hunkId.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA] }));
  h.route("/changes/hunk-action", () => ({
    ack: { success: true, affectedCount: 1 }, affected: 1, changed: true,
    note: "Undone.", reading: { files: [], summary: SUMMARY_CLEAN },
  }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  const undo = buttonsIn(drawer(h)).find((b) => b.textContent === "Undo this change");
  check("an agent hunk offers 'Undo this change'", !!undo);
  undo!.onclick!();
  await flush();
  check("the first click sends NOTHING (it arms)", !h.posts.some((p) => p.path === "/changes/hunk-action"));
  check("the armed state carries the confirm sentence",
    drawer(h).textContent.includes("This rewrites the file on disk. Your own edits to other files are not touched."));
  const go = buttonsIn(drawer(h)).find((b) => b.textContent === "Undo it");
  check("the armed state offers the confirming 'Undo it'", !!go);
  go!.onclick!();
  await flush();
  const sent = h.posts.find((p) => p.path === "/changes/hunk-action");
  check("the second click posts hunk-action with the hunkId", !!sent && sent.body.hunkId === "h-alpha");
  check("the action schedules the ~3s delayed re-read (F8's rescan lag)",
    h.timeouts.some((t) => t.ms === 3000));
}

// 19. Looks good is the safe direction: immediate, one click, file-action
//     accept with the file's path AND the ids of the hunks on screen (Codex 5).
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h.route("/changes/file-action", () => ({
    ack: { success: true, affectedCount: 1 }, affected: 1, changed: true,
    note: "Marked as reviewed.", reading: { files: [], summary: SUMMARY_CLEAN },
  }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  const ok = buttonsIn(drawer(h)).find((b) => b.textContent === "Looks good");
  check("an expanded file offers 'Looks good'", !!ok);
  ok!.onclick!();
  await flush();
  const sent = h.posts.find((p) => p.path === "/changes/file-action");
  check("one click posts file-action accept with the absolute path",
    !!sent && sent.body.path === "/repo/alpha.txt" && !("action" in sent.body));
  check("…and with the ids of the hunks the operator saw",
    !!sent && Array.isArray(sent.body.hunkIds) && sent.body.hunkIds.join(",") === "h-alpha");
}

// 19b. Opus I2 — the 400/500 distinction: a pre-wire refusal (400) may say
//      "Nothing was changed"; a post-wire failure (500) must NOT — it says
//      the result could not be verified and the pane re-reads.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h.route("/changes", () => ({ files: [], summary: SUMMARY_CLEAN }));
  h.route("/changes/hunk-action", () => ({ _status: 500, error: "the agent died mid-request" }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  buttonsIn(drawer(h)).find((b) => b.textContent === "Undo this change")!.onclick!();
  await flush();
  buttonsIn(drawer(h)).find((b) => b.textContent === "Undo it")!.onclick!();
  await flush();
  const n500 = h.api.notes().find((n: any) => String(n.text).includes("Not undone"));
  check("a 500 after a fired action never claims 'Nothing was changed'",
    !!n500 && /could not be verified/.test(n500.text) && !/Nothing was changed/.test(n500.text));
  check("WP12/Codex I4: the quiet caller forwards the details payload to the note",
    typeof n500.details === "string" && n500.details.includes("/changes/hunk-action — HTTP 500"));

  const h2 = harness();
  open(h2);
  drawerOpen(h2);
  h2.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h2.route("/changes", () => ({ files: [], summary: SUMMARY_CLEAN }));
  h2.route("/changes/hunk-action", () => ({ _status: 400, error: "a turn is still running" }));
  h2.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h2.api.renderDrawer();
  buttonsIn(drawer(h2)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  buttonsIn(drawer(h2)).find((b) => b.textContent === "Undo this change")!.onclick!();
  await flush();
  buttonsIn(drawer(h2)).find((b) => b.textContent === "Undo it")!.onclick!();
  await flush();
  const n400 = h2.api.notes().find((n: any) => String(n.text).includes("Not undone"));
  check("a 400 pre-wire refusal earns 'Nothing was changed'",
    !!n400 && /Nothing was changed/.test(n400.text));
}

// 20. B1 — the turn foot binds the WIRE's promptIndex, never the ordinal.
//     A turn with no agent stamp gets no button, however neatly its number
//     lines up with a summary entry.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.applyChangesReading("s", { files: FILES_PENDING, summary: SUMMARY_PENDING }); // promptIndex 0 pending
  const base = { aside: false, replay: false, outcome: "ok", at: 1000, endedAt: 5000, cost: null, usage: null, items: [], error: null, stopReason: "end_turn" };
  const stamped = { ...base, n: 1, promptIndex: 0 };
  const stampedNoEntry = { ...base, n: 2, promptIndex: 1 };
  const unstamped = { ...base, n: 1, promptIndex: null }; // ordinal WOULD match — must not
  const replayedStamped = { ...base, n: 1, replay: true, promptIndex: 0 };
  check("a turn stamped with promptIndex 0 (pending) gets the undo button",
    buttonsIn(h.api.renderTurnFoot(v, stamped)).some((b) => b.textContent === "Undo everything from this turn"));
  check("a stamped turn with no summary entry gets NO undo button",
    !buttonsIn(h.api.renderTurnFoot(v, stampedNoEntry)).some((b) => b.textContent === "Undo everything from this turn"));
  check("an UNSTAMPED turn gets NO undo button even when the ordinal matches",
    !buttonsIn(h.api.renderTurnFoot(v, unstamped)).some((b) => b.textContent === "Undo everything from this turn"));
  check("a replayed turn WITH the wire stamp gets the button (identity re-established from live data)",
    buttonsIn(h.api.renderTurnFoot(v, replayedStamped)).some((b) => b.textContent === "Undo everything from this turn"));
  check("no reading at all means no undo button",
    !buttonsIn(h.api.renderTurnFoot(h.api.view("s2"), stamped)).some((b) => b.textContent === "Undo everything from this turn"));
  const running = { ...base, n: 1, promptIndex: 0, outcome: "running", endedAt: null };
  check("a RUNNING turn gets NO undo button even stamped and pending (Codex 2)",
    !buttonsIn(h.api.renderTurnFoot(v, running)).some((b) => b.textContent === "Undo everything from this turn"));
}

// 20b. B1's full regression: a truncated reconstruction (replayed turns, no
//      stamp in history) followed by a live turn whose stamp arrives on the
//      agent's echo — only the live turn gets a button, and it binds the
//      stamped index, not its ordinal.
{
  const h = harness();
  open(h);
  /* Reconstruct two historical turns WITHOUT the stamp (as pre-1.0.0 history
     or a history whose _meta was not retained would look). */
  h.api.receive(appEvent(1, "message.user", { text: "old prompt one" }, "reconstruction"));
  h.api.receive(appEvent(2, "message.assistant", { text: "old answer one" }, "reconstruction"));
  h.api.receive(appEvent(3, "turn.completed", { stopReason: "end_turn", usage: {} }, "reconstruction"));
  h.api.receive(appEvent(4, "message.user", { text: "old prompt two" }, "reconstruction"));
  h.api.receive(appEvent(5, "message.assistant", { text: "old answer two" }, "reconstruction"));
  h.api.receive(appEvent(6, "turn.completed", { stopReason: "end_turn", usage: {} }, "reconstruction"));
  /* Now the live turn: UI number 3 by ordinal, but the tracker says 0. The
     stamp carries the current generation (0), matching the channel snapshot. */
  h.api.receive(appEvent(7, "turn.started", { text: "new prompt" }));
  h.api.receive(appEvent(8, "message.user", { text: "new prompt", promptIndex: 0, agentGen: 0 }));
  h.api.receive(appEvent(9, "message.assistant", { text: "did work" }));
  h.api.receive(appEvent(10, "turn.completed", { stopReason: "end_turn", usage: {} }));
  h.api.receive(appEvent(11, "turn.finished", { stopReason: "end_turn" }));
  const v = h.api.view("s");
  h.api.applyChangesReading("s", { files: FILES_PENDING, summary: SUMMARY_PENDING }); // promptIndex 0 pending
  const foots = v.turns.filter((t: any) => !t.aside).map((t: any) => h.api.renderTurnFoot(v, t));
  check("the live turn binds the STAMPED index (0), not its ordinal (2)",
    v.turns.filter((t: any) => !t.aside).at(-1).promptIndex === 0);
  check("exactly one turn foot offers the undo — the live, stamped one",
    foots.filter((f: FakeElement) => buttonsIn(f).some((b) => b.textContent === "Undo everything from this turn")).length === 1);
  check("the drifted replayed turns offer NO undo button",
    !foots.slice(0, -1).some((f: FakeElement) => buttonsIn(f).some((b) => b.textContent === "Undo everything from this turn")));
}

// 20c. The mid-turn lock on the pane: with the session's turn in flight, the
//      hunk undo and Looks good buttons render disabled, and the turn foot
//      hides its undo (changesLocked fails closed on unknown state too).
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.setAgent({ state: "ready", failure: null, sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: true }] });
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  const undo = buttonsIn(drawer(h)).find((b) => b.textContent === "Undo this change");
  const ok = buttonsIn(drawer(h)).find((b) => b.textContent === "Looks good");
  check("mid-turn, 'Undo this change' renders disabled", !!undo && undo.disabled === true);
  check("mid-turn, 'Looks good' renders disabled", !!ok && ok.disabled === true);
  const v = h.api.view("s");
  const stamped = { n: 1, promptIndex: 0, aside: false, replay: false, outcome: "ok", at: 1000, endedAt: 5000, cost: null, usage: null, items: [], error: null, stopReason: "end_turn" };
  check("mid-turn, the turn foot offers NO undo even with a valid entry",
    !buttonsIn(h.api.renderTurnFoot(v, stamped)).some((b) => b.textContent === "Undo everything from this turn"));
}

// 20d. M2/M4 — a new reading disarms the turn-level confirm, and an
//      IDENTICAL reading is a no-op that does not wipe the hunks cache.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.applyChangesReading("s", { files: FILES_PENDING, summary: SUMMARY_PENDING, externalIds: [] });
  const t = { n: 1, promptIndex: 0, undoArmed: true };
  v.turns.push({ aside: false, replay: false, outcome: "ok", items: [], ...t });
  v.changesUi.hunks["/repo/alpha.txt"] = { loading: false, error: null, hunks: [HUNK_ALPHA] };
  const applied1 = h.api.applyChangesReading("s", { files: FILES_PENDING, summary: SUMMARY_PENDING, externalIds: [] });
  check("an identical reading is a no-op (M4: no cache wipe, no repaint)",
    applied1 === false && !!v.changesUi.hunks["/repo/alpha.txt"] && v.turns[0].undoArmed === true);
  const applied2 = h.api.applyChangesReading("s", { files: [], summary: SUMMARY_CLEAN, externalIds: [] });
  check("a CHANGED reading applies and disarms the turn-level confirm (M2)",
    applied2 === true && v.turns[0].undoArmed === false && !v.changesUi.hunks["/repo/alpha.txt"]);
}

// 20e. M3 — switching sessions with the drawer open on Detail re-reads.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes", () => ({ files: [], summary: SUMMARY_CLEAN }));
  h.api.selectSession({ sessionId: "s2", cwd: "/repo2" }, true);
  await flush();
  check("selecting a session re-reads /changes for it when the Detail drawer is open",
    h.posts.some((p) => p.path === "/changes" && p.body.sessionId === "s2"));
}

// 21. The turn-foot undo confirms once, then posts the STAMPED promptIndex —
//     the page never invents one.
{
  const h = harness();
  open(h);
  h.route("/changes/turn-action", () => ({
    ack: { success: true, affectedCount: 2 }, affected: 2, changed: true,
    note: "Reverted.", reading: { files: [], summary: SUMMARY_CLEAN },
  }));
  const v = h.api.view("s");
  h.api.applyChangesReading("s", { files: FILES_PENDING, summary: SUMMARY_PENDING });
  const turn1 = { n: 1, promptIndex: 0, aside: false, replay: false, outcome: "ok", at: 1000, endedAt: 5000, cost: null, usage: null, items: [], error: null, stopReason: "end_turn" };
  const foot1 = h.api.renderTurnFoot(v, turn1);
  const undo = buttonsIn(foot1).find((b) => b.textContent === "Undo everything from this turn");
  undo!.onclick!(); // arms — renderCanvas inside; the foot re-renders
  check("the first turn-foot click sends NOTHING", !h.posts.some((p) => p.path === "/changes/turn-action"));
  const foot2 = h.api.renderTurnFoot(v, turn1);
  check("the armed turn foot carries the confirm sentence",
    foot2.textContent.includes("This rewrites the file on disk. Your own edits to other files are not touched."));
  const go = buttonsIn(foot2).find((b) => b.textContent === "Undo it");
  go!.onclick!();
  await flush();
  const sent = h.posts.find((p) => p.path === "/changes/turn-action");
  check("the second click posts turn-action with the stamped promptIndex",
    !!sent && sent.body.promptIndex === 0 && sent.body.sessionId === "s");
}

// 22. Refresh discipline (F7): a LIVE turn.completed re-reads /changes; a
//     replayed one does not.
{
  const h = harness();
  open(h);
  h.route("/changes", () => ({ files: [], summary: SUMMARY_CLEAN }));
  h.api.receive(appEvent(1, "turn.started", { text: "work" }));
  h.api.receive(appEvent(2, "turn.completed", { stopReason: "end_turn", usage: {} }));
  await flush();
  check("a live turn.completed re-reads /changes", h.posts.some((p) => p.path === "/changes" && p.body.sessionId === "s"));
  const before = h.posts.filter((p) => p.path === "/changes").length;
  h.api.receive(appEvent(3, "turn.completed", { stopReason: "end_turn", usage: {} }, "reconstruction"));
  await flush();
  check("a REPLAYED turn.completed does not re-read", h.posts.filter((p) => p.path === "/changes").length === before);
}

// 23. The two new bridge event types are consumed by their own cases (D35):
//     they update the reading from the DIGEST shape and never fall through to
//     an unhandled card.
{
  const h = harness();
  open(h);
  h.api.receive(appEvent(1, "bridge.changes_reading", {
    files: FILES_PENDING,
    turns: [{ promptIndex: 0, files: ["/repo/alpha.txt"], pending: 2 }],
    filesOk: true, summaryOk: true,
  }));
  h.api.receive(appEvent(2, "bridge.change_acted", {
    kind: "hunk", target: "h-alpha", changed: true,
    reading: { files: [], turns: [], filesOk: true, summaryOk: true },
  }));
  await flush();
  const v = h.api.view("s");
  check("bridge.changes_reading then bridge.change_acted both land on the reading (digest shape)",
    v.changes && Array.isArray(v.changes.files) && v.changes.files.length === 0);
  check("neither bridge event became an unhandled card",
    !v.turns.some((t: any) => t.items.some((i: any) => i.kind === "unhandled")));
}

// 24. Attribution at the hunk level after review round 1: "you wrote this"
//     ONLY for source:"external" on a file the tracker does not class as the
//     agent's; externalEditOnAgentFile (evidence wp11/11) and unknown types
//     say "not attributed to the agent" and offer no undo.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({
    hunksOk: true,
    hunks: [{
      id: "h-x", path: "/repo/alpha.txt",
      lineInfo: { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 },
      source: { type: "externalEditOnAgentFile" },
      oldText: "a\n", newText: "b\n", patch: null, createdAt: "x",
    }],
  }));
  h.api.applyChangesReading("s", {
    files: [{ path: "/repo/alpha.txt", isAgentFile: false, staged: false, hunkCount: 1, additions: 1, deletions: 1 }],
    summary: SUMMARY_CLEAN,
  });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  check("externalEditOnAgentFile says 'not attributed to the agent', never 'you wrote this'",
    drawer(h).textContent.includes("not attributed to the agent") && !drawer(h).textContent.includes("you wrote this"));
  check("externalEditOnAgentFile offers NO undo button",
    !buttonsIn(drawer(h)).some((b) => b.textContent === "Undo this change"));
}

// 25. The generation boundary (round 3, Codex 3): a stamp binds only when
//     its minted generation matches the server's current one. In-session:
//     agent_gone moves the authority forward; stamps from the dead lifetime
//     never bind again, live post-respawn stamps do.
{
  const h = harness();
  open(h); // channel snapshot: agentGeneration 0
  h.api.receive(appEvent(1, "turn.started", { text: "work" }));
  h.api.receive(appEvent(2, "message.user", { text: "work", promptIndex: 0, agentGen: 0 }));
  const v = h.api.view("s");
  check("a live echo binds when the generations match", v.turns[0].promptIndex === 0);
  h.api.receive(appEvent(3, "bridge.agent_gone", { error: "killed", agentGeneration: 1 }, "current", null));
  h.api.receive(appEvent(4, "turn.failed", { error: "agent died" }));
  check("agent_gone nulls every turn's stamp",
    v.turns.every((t: any) => t.promptIndex === null));
  /* The post-respawn session/load replays history; the retained events carry
     the generation they were minted in (0) — no longer current. */
  h.api.receive(appEvent(5, "message.user", { text: "old prompt", promptIndex: 1, agentGen: 0 }, "reconstruction"));
  check("a stamp minted by the dead lifetime does NOT bind after the death",
    v.turns.at(-1).promptIndex === null);
  /* A retained event from BEFORE this mechanism existed carries no
     generation at all — also never bound (fail closed). */
  h.api.receive(appEvent(6, "message.user", { text: "older prompt", promptIndex: 2 }, "reconstruction"));
  check("an unstamped echo (no generation recorded) never binds",
    v.turns.at(-1).promptIndex === null);
  /* A new LIVE turn after the respawn is minted in the new generation. */
  h.api.receive(appEvent(7, "turn.started", { text: "new work" }));
  h.api.receive(appEvent(8, "message.user", { text: "new work", promptIndex: 3, agentGen: 1 }));
  check("a live stamp minted in the new generation binds (numbering continued)",
    v.turns.at(-1).promptIndex === 3);
}

// 25b. The same boundary across a FULL PAGE RELOAD (what page memory could
//      not do): a plain reload with the tracker intact re-binds history
//      (delta artifact 20 keeps working); a reload AFTER a respawn does not
//      (artifact 21 stays fail-closed) — even under a future build that
//      restarts numbering per process.
{
  /* Plain reload: generation never moved. */
  const h = harness();
  open(h, 0);
  h.api.receive(appEvent(1, "message.user", { text: "p1", promptIndex: 0, agentGen: 0 }, "reconstruction"));
  h.api.receive(appEvent(2, "message.assistant", { text: "a1" }, "reconstruction"));
  check("plain reload, tracker intact: the replayed stamp re-binds",
    h.api.view("s").turns.at(-1).promptIndex === 0);

  /* Reload after a death: the snapshot reports generation 1; the retained
     history was minted in 0. */
  const h2 = harness();
  open(h2, 1);
  h2.api.receive(appEvent(1, "message.user", { text: "p1", promptIndex: 0, agentGen: 0 }, "reconstruction"));
  h2.api.receive(appEvent(2, "message.assistant", { text: "a1" }, "reconstruction"));
  check("reload after a respawn: the dead lifetime's stamp does NOT bind",
    h2.api.view("s").turns.at(-1).promptIndex === null);
}

// 26. Delta finding 1 — the server mechanism behind the same rule: agent
//     death clears seenPromptIndexes (source-pinned inside onAgentGone's
//     per-record loop; the spawning path cannot run in this rig), so a stale
//     index after a respawn is refused by BOTH gates.
{
  const HERE2 = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE2, "sessions.ts"), "utf8");
  const gone = src.slice(src.indexOf("private async onAgentGone"));
  check("onAgentGone clears seenPromptIndexes per record",
    gone.slice(0, gone.indexOf("respawnAndReload")).includes("rec.seenPromptIndexes.clear()"));
  check("the record comment states the measured truth (numbering CONTINUES across a respawn)",
    src.includes("numbering CONTINUES across a respawn"));
  /* Opus M5: the generation mechanism's server half, source-pinned — a bad
     edit here (bump after the payload, minting replayed events, minting
     after emit) leaves every behavioural check green while pages silently
     bind dead-lifetime stamps. */
  check("the generation bump PRECEDES the agent_gone payload",
    gone.indexOf("this.agentGeneration++") < gone.indexOf(`"bridge.agent_gone"`));
  check("the agent_gone payload carries the new generation",
    gone.slice(0, gone.indexOf("respawnAndReload")).includes("agentGeneration: this.agentGeneration"));
  check("the snapshot carries the generation (channel_open re-establishes it on reload)",
    src.includes("agentGeneration: this.agentGeneration,"));
  check("stamps are minted on live echoes only (replay excluded)",
    /!ev\.replay && msg\.method === "session\/update"/.test(src));
  check("the stamp is minted BEFORE the event is emitted (so the journal retains it)",
    src.indexOf("agentGen = this.agentGeneration") < src.indexOf("this.out(ev)"));
}

// 27. Delta finding 4 — the path column wraps words, never one character per
//     line (source-pinned: `break-word`, not `anywhere`).
{
  const HERE3 = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(HERE3, "public", "app.css"), "utf8");
  const rule = css.slice(css.indexOf(".chg-path {"));
  check(".chg-path uses break-word, not anywhere",
    rule.slice(0, rule.indexOf("}")).includes("overflow-wrap: break-word") &&
      !rule.slice(0, rule.indexOf("}")).includes("anywhere"));
}

// 33. Opus F4 — an unreadable summary is SAID in the pane above the (still
//     honest) file list; turn-level undo is named as unavailable.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), filesOk: true, summary: null, summaryOk: false });
  h.api.renderDrawer();
  const text = drawer(h).textContent;
  check("summaryOk:false is painted in the pane",
    text.includes("per-turn summary could not be read"));
  check("…and the readable file list still renders beneath it",
    text.includes("/repo/alpha.txt"));
}

// 34. Opus F2 (page half) — a file with zero pending hunks offers NO Looks
//     good: an empty digest could spuriously match an unreadable re-read.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({ hunks: [], hunksOk: true }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  check("a zero-hunk file says 'No pending changes reported'",
    /* WP14: the pane speaks "change", never the wire's "hunk". */
    drawer(h).textContent.includes("No pending changes reported for this file"));
  check("…and offers no 'Looks good'", !buttonsIn(drawer(h)).some((b) => b.textContent === "Looks good"));
}

// 35. Grok R2-M2 — the ARMED hunk confirm honours the mid-turn lock: arming
//     while idle does not grandfather a click past a turn that has started.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  buttonsIn(drawer(h)).find((b) => b.textContent === "Undo this change")!.onclick!(); // arm while idle
  h.api.setAgent({ state: "ready", failure: null, sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: true }] });
  h.api.renderDrawer();
  const go = buttonsIn(drawer(h)).find((b) => b.textContent === "Undo it");
  check("the armed confirm is disabled once a turn is running", !!go && go.disabled === true);
}

// 36. Opus F6 — a lazy /changes/hunks response that lands AFTER a newer
//     reading is dropped, not repopulated into the cache.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  let hunksCalls = 0;
  h.route("/changes/hunks", () => {
    hunksCalls++;
    return { hunksOk: true, hunks: [{ ...HUNK_ALPHA, id: hunksCalls === 1 ? "h-stale" : "h-fresh" }] };
  });
  const v = h.api.view("s");
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  /* Before the lazy read resolves, a NEWER reading lands (the ~3s delayed
     re-read after an action) and wipes the cache. */
  h.api.applyChangesReading("s", { files: [{ ...FILES_PENDING[0], additions: 9 }], summary: SUMMARY_PENDING });
  await flush();
  const cached = v.changesUi.hunks["/repo/alpha.txt"];
  check("the superseded response never repopulates the cache (the fresh re-read did)",
    !!cached && cached.loading === false && cached.hunks[0].id === "h-fresh");
}

// 37. Opus F1 — REBUTTED with evidence, pinned so it stays rebutted:
//     bridge.agent_gone is emitted UNSCOPED (no sessionId argument), and
//     broadcast() retains only held-session events — so the event can never
//     be journal-replayed, no permanent trackerDied latch is possible, and a
//     fresh page always starts with the guard unset.
{
  const HERE4 = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE4, "server.ts"), "utf8");
  const sessSrc = readFileSync(join(HERE4, "sessions.ts"), "utf8");
  check("broadcast retains only held-session events (unscoped events are never replayed)",
    serverSrc.includes("ev.sessionId !== null && manager.sessions.has(ev.sessionId)"));
  const emit = sessSrc.slice(sessSrc.indexOf(`"bridge.agent_gone"`), sessSrc.indexOf(`"bridge.agent_gone"`) + 700);
  check("bridge.agent_gone is emitted without a sessionId (unscoped → unretained)",
    !/,\s*sessionId,?\s*\)/.test(emit));
}

// 38. Opus N1 (page half) — a sibling session in the SAME folder with a turn
//     in flight locks the pane's actions and hides the turn-foot undo; a
//     sibling in a different folder does not.
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.api.setAgent({ state: "ready", failure: null, sessions: [
    { sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false },
    { sessionId: "sib", cwd: "/repo", live: true, loading: false, turnInFlight: true },
  ] });
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  const ok = buttonsIn(drawer(h)).find((b) => b.textContent === "Looks good");
  check("a sibling turn in the same folder disables 'Looks good'", !!ok && ok.disabled === true);
  const v = h.api.view("s");
  const stamped = { n: 1, promptIndex: 0, aside: false, replay: false, outcome: "ok", at: 1000, endedAt: 5000, cost: null, usage: null, items: [], error: null, stopReason: "end_turn" };
  check("…and hides the turn-foot undo",
    !buttonsIn(h.api.renderTurnFoot(v, stamped)).some((b) => b.textContent === "Undo everything from this turn"));

  const h2 = harness();
  open(h2);
  h2.api.setAgent({ state: "ready", failure: null, sessions: [
    { sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false },
    { sessionId: "sib", cwd: "/elsewhere", live: true, loading: false, turnInFlight: true },
  ] });
  h2.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  check("a sibling turn in a DIFFERENT folder does not lock",
    h2.api.changesEntryForTurn(h2.api.view("s"), stamped) !== null);
}

// 39. Codex 2 (confirm round) — the reading signature carries hunk ids: same
//     counts, different ids = a DIFFERENT reading (applies, wipes, refetches).
{
  const h = harness();
  open(h);
  const reading = (id: string) => ({
    files: FILES_PENDING.slice(0, 1),
    summary: { turns: [{ promptIndex: 0, files: ["/repo/alpha.txt"], pendingHunks: [{ ...HUNK_ALPHA, id }] }] },
    externalIds: [],
  });
  check("the first reading applies", h.api.applyChangesReading("s", reading("h-a")) === true);
  check("an identical reading is a no-op", h.api.applyChangesReading("s", reading("h-a")) === false);
  check("same counts but a different hunk id is NOT a no-op",
    h.api.applyChangesReading("s", reading("h-b")) === true);
}

// 39b. Codex final-round 1 — EXTERNAL hunk ids are in the signature too:
//      an external-only replacement with identical counts must not collide
//      (external hunks never appear in summary.turns). And a reading whose
//      external-hunk read failed (null) never no-ops.
{
  const h = harness();
  open(h);
  const reading = (ext: any) => ({
    files: [{ path: "/repo/gamma.txt", isAgentFile: false, staged: false, hunkCount: 1, additions: 1, deletions: 1 }],
    summary: SUMMARY_CLEAN,
    externalIds: ext,
  });
  check("the first external-hunk reading applies", h.api.applyChangesReading("s", reading(["e-1"])) === true);
  check("an identical external-hunk reading is a no-op", h.api.applyChangesReading("s", reading(["e-1"])) === false);
  check("a different external hunk id with identical counts is NOT a no-op",
    h.api.applyChangesReading("s", reading(["e-2"])) === true);
  h.api.applyChangesReading("s", reading(["e-2"]));
  check("an unreadable external-hunk read (null) never no-ops",
    h.api.applyChangesReading("s", reading(null)) === true);
}

// 40. Opus N2 (page half) — a 500 carrying the server's notSent marker earns
//     the single-minded sentence; the conditional clause is reserved for the
//     genuinely ambiguous case (covered by 19b).
{
  const h = harness();
  open(h);
  drawerOpen(h);
  h.route("/changes/hunks", () => ({ hunks: [HUNK_ALPHA], hunksOk: true }));
  h.route("/changes", () => ({ files: [], summary: SUMMARY_CLEAN }));
  h.route("/changes/hunk-action", () => ({
    _status: 500, notSent: true,
    error: "get-summary could not be read — the undo was NOT sent.",
  }));
  h.api.applyChangesReading("s", { files: FILES_PENDING.slice(0, 1), summary: SUMMARY_PENDING });
  h.api.renderDrawer();
  buttonsIn(drawer(h)).find((b) => b.textContent.includes("/repo/alpha.txt"))!.onclick!();
  await flush();
  buttonsIn(drawer(h)).find((b) => b.textContent === "Undo this change")!.onclick!();
  await flush();
  buttonsIn(drawer(h)).find((b) => b.textContent === "Undo it")!.onclick!();
  await flush();
  const n = h.api.notes().find((x: any) => String(x.text).includes("Not undone"));
  check("a notSent 500 says 'Nothing was changed' with NO conditional clause",
    !!n && /Nothing was changed/.test(n.text) && !/could not be verified/.test(n.text));
}

/* The count, printed unambiguously (round-2 review found two different
   numbers quoted): checks EXECUTED — some call sites run inside loops — and
   the number of check( call sites in this file. */
const selfSrc = readFileSync(fileURLToPath(import.meta.url), "utf8");
const callSites = (selfSrc.match(/\bcheck\(/g) || []).length - 1; // minus the definition
console.log(`\nall passed — ${passed} checks executed (${callSites} check( call sites; loops execute some sites more than once)`);
