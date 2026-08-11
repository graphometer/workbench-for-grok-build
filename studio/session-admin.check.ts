// WP13: the session-administration control calls, checked deterministically.
// No network, no agent, no dependencies:
//
//     node studio/session-admin.check.ts
//
// These are OUTBOUND control calls (rename / delete / auto-approve / export /
// import), not reverse requests — so they are NOT tested with
// interactions.check.ts's rig() (which stubs the REVERSE direction). Instead
// they clone the outbound `.request`/`.notify` stub from reconstruction.check.ts:
// the manager spawns nothing, every call it would put on the wire is captured,
// and each test feeds the reply the protocol would send so the read-back logic
// (rule 1 — never trust an acknowledgement) is exercised against real answers.
//
// The reply shapes were SOURCE-grounded (agent-staging/fable/2026-08-02/
// WP13_WIRE_REFERENCE.json) and are now live-proven on the wire on 0.2.118 by
// the build's evidence run — no check here is left standing on inference alone.

import { SessionManager } from "./sessions.ts";
import type { AppEvent } from "./events.ts";
import { ArchiveStore, isValidArchiveId } from "./archive-store.ts";
import { pathRefusal } from "./fs-browse.ts";
import { bundleToMarkdown } from "./session-export.ts";
import { buildAssetMap, buildPageMap } from "./page-maps.ts";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolveFrom } from "node:path";
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
const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A captured outbound call. `notify` marks a one-way notification. */
interface Call {
  method: string;
  params: any;
  notify?: boolean;
}

/**
 * A manager that spawns nothing, captures every outbound call, and answers each
 * from a per-method reply table the test sets. `requireReady` is stubbed so the
 * control methods run without a live agent; `note`/`loud` are counted so a test
 * can assert which one a read-back verdict took (the note/loud split is how this
 * codebase says "verified" versus "could not verify").
 */
function rig() {
  const manager = new SessionManager(process.cwd());
  (manager as any).requireReady = () => {};
  const calls: Call[] = [];
  const emitted: AppEvent[] = [];
  const responds: { id: any; result: any }[] = [];
  const errors: { id: any; code: number; message: string }[] = [];
  const counts = { notes: 0, louds: 0 };
  const replies: Record<string, (params: any) => any> = {};
  (manager.acp as any).note = () => {
    counts.notes++;
  };
  (manager.acp as any).loud = () => {
    counts.louds++;
  };
  (manager.acp as any).respond = (id: any, result: any) => responds.push({ id, result });
  (manager.acp as any).respondError = (id: any, code: number, message: string) =>
    errors.push({ id, code, message });
  manager.on("app", (ev: AppEvent) => emitted.push(ev));
  (manager.acp as any).request = async (method: string, params: any) => {
    calls.push({ method, params });
    const fn = replies[method];
    return fn ? fn(params) : {};
  };
  (manager.acp as any).notify = (method: string, params: any) => {
    calls.push({ method, params, notify: true });
  };
  return { manager, calls, emitted, responds, errors, replies, counts };
}

/** Put a held session on the map, with a cwd so resolveCwd finds it locally. */
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
    commands: null,
    commandsRevision: 0,
    replayedEvents: 0,
    liveEvents: 0,
    loading: null,
  });
  return (manager as any).sessions.get(sessionId);
}

/** An enveloped sessions/list reply (EXT_ENVELOPE true → result.result). */
const roster = (rows: any[]) => ({ result: { sessions: rows } });

/** A minimal session.titled AppEvent, as waitForTitle consumes it. */
const titledEvent = (sessionId: string, title: string): any => ({
  type: "session.titled",
  wireKind: "",
  rail: "xai",
  sessionId,
  replay: false,
  modelled: true,
  data: { title },
  raw: null,
  t: 1,
});

function refusal(fn: () => Promise<unknown>): Promise<any> {
  return fn().then(
    () => null,
    (err) => err,
  );
}

// ══ PILLAR 1 — RENAME ═════════════════════════════════════════════════════

// 1. Wire shape + cwd-from-record. The wire method is the underscore-prefixed
//    ext name (_x.ai/session/rename), per PROJECT-STATE §5's proven rule that a
//    bare x.ai/... returns -32601 on a --no-leader connection. (The evidence
//    plan's shorthand "session/rename" is the logical name; the wire needs the
//    underscore.) cwd is the held record's, never a caller value.
{
  const { manager, calls, replies } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/session/rename"] = () => {
    manager.emit("app", titledEvent("s-live", "New Title"));
    return { success: true };
  };
  replies["_x.ai/sessions/list"] = () =>
    roster([{ sessionId: "s-live", cwd: "/tmp/s-live", title: "New Title" }]);
  const result = await manager.renameSession("s-live", "New Title");
  const renameCall = calls.find((c) => c.method === "_x.ai/session/rename");
  check("rename sends the underscore-prefixed ext method", !!renameCall);
  check(
    "rename params are exactly {sessionId,title,cwd} with cwd from the held record",
    !!renameCall && deepEq(renameCall.params, { sessionId: "s-live", title: "New Title", cwd: "/tmp/s-live" }),
  );
  check("rename verified + matched when the roster reports the new title", result.verified && result.matched);
  check("rename writes the held record's title from the read-back, not the request", (manager as any).sessions.get("s-live").title === "New Title");
}

// 2. Read-back-not-trust: {success:true} but the session is absent from the
//    roster and the agent pushes no title. verified must be false — the ack is
//    not evidence — and the verdict takes the loud path, not note.
{
  const { manager, calls, replies, counts } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/session/rename"] = () => ({ success: true }); // no pushed title
  replies["_x.ai/sessions/list"] = () => roster([]); // not present
  const result = await manager.renameSession("s-live", "Ghost Title");
  check("rename reports verified:false when nothing reads back", result.verified === false);
  check("rename reports matched:false when nothing reads back", result.matched === false);
  check("an unverified rename takes the loud path, never the quiet note", counts.louds >= 1 && counts.notes === 0);
  check("an unverified rename still put the request on the wire", calls.some((c) => c.method === "_x.ai/session/rename"));
}

// 3. Read-back via the agent's pushed session.titled, even when the roster row
//    lags (the held-session case). The record's title comes from the read-back,
//    never from the {success:true} ack.
{
  const { manager, replies } = rig();
  const rec = held(manager, "s-live", "/tmp/s-live");
  rec.title = "old";
  replies["_x.ai/session/rename"] = () => {
    manager.emit("app", titledEvent("s-live", "Pushed Title"));
    return { success: true };
  };
  replies["_x.ai/sessions/list"] = () => roster([]); // roster does not yet reflect it
  const result = await manager.renameSession("s-live", "Pushed Title");
  check("rename verified via the pushed session.titled when the roster lags", result.verified && result.matched);
  check("rename read-back is the pushed title", result.readBack === "Pushed Title");
  check("the held record took the pushed title, not the old one", (manager as any).sessions.get("s-live").title === "Pushed Title");
}

// 4. Read-back mismatch: the agent confirms a DIFFERENT title (a race with an
//    auto-title). matched is false and it is loud.
{
  const { manager, replies, counts } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/session/rename"] = () => {
    manager.emit("app", titledEvent("s-live", "agent-picked-this"));
    return { success: true };
  };
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-live", cwd: "/tmp/s-live", title: "agent-picked-this" }]);
  const result = await manager.renameSession("s-live", "what-we-asked");
  check("rename matched:false when the confirmed title differs from ours", result.verified && !result.matched);
  check("a mismatched rename is loud", counts.louds >= 1);
}

// 5. Advisory decoy: session.info_updated carries a title but is advisory and
//    echoes the prior one, so it must NOT satisfy the read-back. With only the
//    decoy fired and the roster silent, the rename cannot verify a match.
{
  const { manager, replies } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/session/rename"] = () => {
    // The advisory event, NOT session.titled — waitForTitle must ignore it.
    manager.emit("app", { ...titledEvent("s-live", "decoy-title"), type: "session.info_updated", data: { title: "decoy-title", advisoryOnly: true } });
    return { success: true };
  };
  replies["_x.ai/sessions/list"] = () => roster([]);
  const result = await manager.renameSession("s-live", "real-title");
  check("session.info_updated does not satisfy the rename read-back", !result.matched && result.verified === false);
}

// 6. Blank / whitespace title: refused locally BEFORE the wire. Assert the call
//    count is zero — nothing left the client — for both '' and '   '.
{
  const { manager, calls } = rig();
  held(manager, "s-live", "/tmp/s-live");
  const e1 = await refusal(() => manager.renameSession("s-live", ""));
  const e2 = await refusal(() => manager.renameSession("s-live", "   "));
  check("blank title is refused with badRequest", e1 && (e1 as any).badRequest === true);
  check("whitespace-only title is refused with badRequest", e2 && (e2 as any).badRequest === true);
  check("a refused-blank rename put NOTHING on the wire (call count 0)", calls.length === 0);
}

// 7. Unknown session id: neither held nor on the roster → resolveCwd refuses
//    before the rename ever goes out. (rosterEntry's sessions/list read is the
//    only wire call, and it is a read, not the rename.)
{
  const { manager, calls, replies } = rig();
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "someone-else", cwd: "/x", title: "x" }]);
  const err = await refusal(() => manager.renameSession("ghost", "X"));
  check("rename of an unknown session id is refused with badRequest", err && (err as any).badRequest === true);
  check("a refused unknown-id rename never sent the rename call", !calls.some((c) => c.method === "_x.ai/session/rename"));
}

// ══ PILLAR 2 — ARCHIVE / RESTORE (local hidden-list) ══════════════════════
//
// The store never touches the ACP wire (there is no protocol setter for a Build
// session's `hidden` flag), so these are pure local-state checks. A unique temp
// file per process keeps them hermetic.

const ARCHIVE_TMP = join(tmpdir(), `graphometer-archive-test-${process.pid}.json`);
const cleanupArchive = () => {
  for (const p of [ARCHIVE_TMP, `${ARCHIVE_TMP}.tmp`]) if (existsSync(p)) rmSync(p);
};
cleanupArchive();

// The archive routes must not put anything on the wire. Prove it structurally:
// the ArchiveStore has no AcpClient and no manager reference at all.
{
  const store = new ArchiveStore(ARCHIVE_TMP);
  check("the archive store has no ACP client (cannot reach the wire)", !("acp" in (store as any)) && !("manager" in (store as any)));
  cleanupArchive();
}

// Archive hides; restore un-hides; both are honest no-ops the second time.
{
  const store = new ArchiveStore(ARCHIVE_TMP);
  check("a fresh store is empty", store.list().length === 0 && !store.isArchived("s1"));
  check("archive adds the id", store.archive("s1") === true && store.isArchived("s1"));
  check("archiving the same id again is a no-op (changed:false)", store.archive("s1") === false);
  check("restore removes the id", store.restore("s1") === true && !store.isArchived("s1"));
  check("restoring an unarchived id is a no-op (changed:false)", store.restore("s1") === false);
  cleanupArchive();
}

// Survives a restart: a NEW store on the same path reads back the list. Proves
// real on-disk persistence, not an in-memory Set.
{
  const a = new ArchiveStore(ARCHIVE_TMP);
  a.archive("keep-me");
  a.archive("also-me");
  const b = new ArchiveStore(ARCHIVE_TMP); // fresh instance, same file
  check("archived ids survive a store restart", b.isArchived("keep-me") && b.isArchived("also-me"));
  check("the on-disk form is a sorted JSON array under 'archived'", deepEq(JSON.parse(readFileSync(ARCHIVE_TMP, "utf8")).archived, ["also-me", "keep-me"]));
  cleanupArchive();
}

// The atomic-write staging file does not linger after a write.
{
  const store = new ArchiveStore(ARCHIVE_TMP);
  store.archive("x");
  check("no .tmp staging file remains after an atomic write", !existsSync(`${ARCHIVE_TMP}.tmp`));
  cleanupArchive();
}

// A missing or corrupt file loads as an empty list, never a throw.
{
  const empty = new ArchiveStore(join(tmpdir(), `graphometer-archive-absent-${process.pid}.json`));
  check("a missing archive file loads as empty", empty.list().length === 0);
  writeFileSync(ARCHIVE_TMP, "{ this is not json", "utf8");
  const corrupt = new ArchiveStore(ARCHIVE_TMP);
  check("a corrupt archive file loads as empty, not a crash", corrupt.list().length === 0);
  cleanupArchive();
}

// Prototype-shaped ids: the exact class proven at interactions.check.ts. A bare
// object literal store would swallow "__proto__"; the Set-backed store does not.
{
  const store = new ArchiveStore(ARCHIVE_TMP);
  for (const hostile of ["__proto__", "constructor", "prototype", "toString"]) {
    check(`archive stores the hostile id '${hostile}' as an ordinary value`, store.archive(hostile) === true && store.isArchived(hostile));
  }
  // Persist and reload — the hostile ids must round-trip through JSON + the Set.
  const reloaded = new ArchiveStore(ARCHIVE_TMP);
  check("hostile ids survive persist + reload", ["__proto__", "constructor", "prototype", "toString"].every((h) => reloaded.isArchived(h)));
  check("a real Object.prototype was NOT polluted by an id named __proto__", ({} as any).__proto__ === Object.prototype && !Object.prototype.hasOwnProperty.call({}, "polluted"));
  for (const hostile of ["__proto__", "constructor", "prototype", "toString"]) {
    check(`restore removes the hostile id '${hostile}'`, reloaded.restore(hostile) === true && !reloaded.isArchived(hostile));
  }
  cleanupArchive();
}

// Invalid ids are refused with badRequest, before anything is written.
{
  const store = new ArchiveStore(ARCHIVE_TMP);
  const bad = (fn: () => unknown) => {
    try { fn(); return null; } catch (e) { return e as any; }
  };
  check("empty id refused", bad(() => store.archive(""))?.badRequest === true);
  check("control-char id refused", bad(() => store.archive("a\u0000b"))?.badRequest === true);
  check("over-long id refused", bad(() => store.archive("x".repeat(257)))?.badRequest === true);
  check("isValidArchiveId accepts a normal UUIDv7 and rejects the bad shapes", isValidArchiveId("019fa1db-2836-7d90-abcd-000000000000") && !isValidArchiveId("") && !isValidArchiveId(42 as any));
  check("no file was written by a refused archive", !existsSync(ARCHIVE_TMP));
  cleanupArchive();
}

// The SERVER's archive path is beside graphometer.env, never under ~/.grok and
// never CONFIG_PATH. Asserted by reading server.ts (there is no route harness).
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
  check("server ARCHIVE_PATH is graphometer-archive.json at the repo root", /ARCHIVE_PATH\s*=\s*join\(HERE,\s*"\.\.",\s*"graphometer-archive\.json"\)/.test(serverSrc));
  check("the archive path is not under ~/.grok and is not CONFIG_PATH", !/graphometer-archive[^\n]*\.grok/.test(serverSrc) && !/CONFIG_PATH\s*=\s*join\([^)]*graphometer-archive/.test(serverSrc));
}

// ══ PILLAR 3 — AUTO-APPROVE (connection-wide permission mode, D58/D62) ═════
//
// A one-way NOTIFICATION (no reply), so it clones cancel()'s notify pattern, not
// the request/read-back pattern. The only read-back is sessions/list.yolo, which
// exists for always-approve and its off states but NOT for 'auto'.

// 1. Notification shape for every canonical mode. The wire method is the
//    underscore-prefixed name (send-side underscore is the one open wire
//    question — gap 1 — the live run confirms _x.ai/ vs bare).
{
  const cases: [string, boolean, boolean][] = [
    ["default", false, false],
    ["ask", false, false],
    ["auto", false, true],
    ["always-approve", true, false],
  ];
  for (const [mode, yolo, auto] of cases) {
    const { manager, calls, replies } = rig();
    held(manager, "s-live", "/tmp/s-live");
    replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-live", cwd: "/tmp/s-live", yolo }]);
    await manager.setPermissionMode(mode);
    const notif = calls.find((c) => c.notify);
    check(`auto-approve '${mode}' sends a one-way _x.ai/yolo_mode_changed notification`, !!notif && notif.method === "_x.ai/yolo_mode_changed");
    check(`auto-approve '${mode}' params are exactly {yolo_mode,auto_mode,permission_mode}`, !!notif && deepEq(notif.params, { yolo_mode: yolo, auto_mode: auto, permission_mode: mode }));
  }
}

// 2. Whitelist: an unknown mode is refused locally, nothing on the wire.
{
  const { manager, calls } = rig();
  held(manager, "s-live", "/tmp/s-live");
  const err = await refusal(() => manager.setPermissionMode("yolo-everything"));
  check("an unknown permission mode is refused with badRequest", err && (err as any).badRequest === true);
  check("a refused mode put NOTHING on the wire", calls.length === 0);
}

// 3. always-approve verified + matched when the roster reads yolo=true back.
{
  const { manager, replies } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-live", cwd: "/tmp/s-live", yolo: true }]);
  const result = await manager.setPermissionMode("always-approve");
  check("always-approve verified connection-wide when yolo reads back true", result.verifiable && result.verified && result.matched);
  check("the read-back names the held session's yolo state", deepEq(result.yoloReadBack, [{ sessionId: "s-live", yolo: true }]));
  check("the requested mode is recorded on the manager (switch intent)", (manager as any).permissionMode === "always-approve");
  check("scope is always connection-wide, never per-session", result.scope === "connection-wide");
}

// 4. always-approve NOT matched when the roster still reads yolo=false: the
//    notify alone must not be claimed as effective (loud, not note).
{
  const { manager, replies, counts } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-live", cwd: "/tmp/s-live", yolo: false }]);
  const result = await manager.setPermissionMode("always-approve");
  check("always-approve is NOT matched when yolo reads back false (no effect claimed from the notify alone)", result.verified && !result.matched);
  check("an unconfirmed always-approve is loud", counts.louds >= 1);
}

// 5. 'auto' has no wire read-back: reported requested-not-verifiable, no
//    sessions/list read, and it is a note (honest caveat), not a loud failure.
{
  const { manager, calls, counts } = rig();
  held(manager, "s-live", "/tmp/s-live");
  const result = await manager.setPermissionMode("auto");
  check("'auto' is reported as not verifiable", result.verifiable === false && result.verified === false && result.matched === false);
  check("'auto' does not attempt a yolo read-back (no sessions/list call)", !calls.some((c) => c.method === "_x.ai/sessions/list"));
  check("'auto' is a note (honest caveat), not a loud failure", counts.notes >= 1 && counts.louds === 0);
}

// 6. Turning it OFF ('ask') is verified when yolo reads back false.
{
  const { manager, replies } = rig();
  held(manager, "s-live", "/tmp/s-live");
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-live", cwd: "/tmp/s-live", yolo: false }]);
  const result = await manager.setPermissionMode("ask");
  check("turning auto-approve off ('ask') is verified when yolo reads back false", result.verified && result.matched);
}

// 7. No config write, anywhere in the manager (D60 / AGENTS rule 4). The
//    auto-approve effect is notification-only. The strongest, comment-proof form
//    of the guard: sessions.ts imports NO filesystem module, so it structurally
//    cannot write config.toml — or any file. (A naive grep for the literal
//    "config.toml" would trip on the comments that explain WHY we never write it,
//    which is documentation, not a write.)
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, "sessions.ts"), "utf8");
  check("sessions.ts imports no filesystem module — it cannot write config.toml or anything else", !/from\s+"node:fs/.test(src) && !/require\(\s*["']node:fs/.test(src));
  check("sessions.ts calls no file-write primitive", !/\bwriteFileSync\b|\bwriteFile\b|\brenameSync\b|\bcreateWriteStream\b|\bappendFileSync\b/.test(src));
}

// ══ PILLAR 4 — DELETE (permanent; the one irreversible path) ══════════════

// 1. Wire shape + cwd-from-record + verified-gone read-back removes the record.
{
  const { manager, calls, emitted, replies } = rig();
  held(manager, "s-doomed", "/tmp/s-doomed");
  replies["_x.ai/session/delete"] = () => ({ success: true });
  replies["_x.ai/sessions/list"] = () => roster([]); // gone
  const result = await manager.deleteSession("s-doomed");
  const delCall = calls.find((c) => c.method === "_x.ai/session/delete");
  check("delete sends the underscore-prefixed ext method", !!delCall);
  check("delete params are exactly {sessionId,cwd} with cwd from the held record", !!delCall && deepEq(delCall.params, { sessionId: "s-doomed", cwd: "/tmp/s-doomed" }));
  check("delete verified when the id is GONE from the roster read-back", result.deleted && result.goneFromRoster);
  check("a verified delete drops the live record", !(manager as any).sessions.has("s-doomed"));
  // Scoped null on purpose: the session is gone, so there is no channel to scope
  // to — the client reads the id out of `data`, which is why data.sessionId is
  // asserted here and not just the event type.
  check("a verified delete fires a bridge.session_deleted carrying the id (scoped null)",
    emitted.some((e: any) =>
      e.type === "bridge.session_deleted" && e.sessionId === null &&
      e.data?.sessionId === "s-doomed" && e.data?.deleted === true && e.data?.goneFromRoster === true));
}

// 2. SILENT SUCCESS: {success:true} but the id is still in sessions/list. This
//    is a no-op, not a delete — do NOT report success, and do NOT drop the record.
{
  const { manager, replies, counts } = rig();
  held(manager, "s-stay", "/tmp/s-stay");
  replies["_x.ai/session/delete"] = () => ({ success: true }); // the lie
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-stay", cwd: "/tmp/s-stay" }]); // still present
  const result = await manager.deleteSession("s-stay");
  check("a still-present session is reported deleted:false despite {success:true}", result.deleted === false && result.goneFromRoster === false);
  check("a no-op delete does NOT drop the live record", (manager as any).sessions.has("s-stay"));
  check("a no-op delete is loud", counts.louds >= 1);
}

// 3. A THROWN request = the session is INTACT (remote-first: a remote failure
//    touches nothing local). Never reported as a delete; the record is kept.
{
  const { manager, calls, replies, counts } = rig();
  held(manager, "s-intact", "/tmp/s-intact");
  replies["_x.ai/session/delete"] = () => {
    throw new Error("remote unreachable");
  };
  const result = await manager.deleteSession("s-intact");
  check("a thrown delete request reports intact:true, deleted:false", result.deleted === false && result.intact === true);
  check("an INTACT delete keeps the live record", (manager as any).sessions.has("s-intact"));
  check("an INTACT delete never read the roster back (it errored first)",
    !calls.some((c) => c.method === "_x.ai/sessions/list"));
  check("an INTACT delete is loud", counts.louds >= 1);
}

// 4. Refuse while a turn is in flight — Stop first. Nothing reaches the wire.
{
  const { manager, calls } = rig();
  const rec = held(manager, "s-busy", "/tmp/s-busy");
  rec.turn = { startedAt: 1, watchdog: 0 as any };
  const err = await refusal(() => manager.deleteSession("s-busy"));
  check("delete of a mid-turn session is refused with badRequest", err && (err as any).badRequest === true);
  check("a refused mid-turn delete put NOTHING on the wire", !calls.some((c) => c.method === "_x.ai/session/delete"));
  check("a refused mid-turn delete kept the record", (manager as any).sessions.has("s-busy"));
}

// 4b. Refuse while a LOAD is replaying — the other half of the same race. A
//     delete that won it would drop the record and abandon interactions under a
//     session/load reply still to land.
{
  const { manager, calls } = rig();
  const rec = held(manager, "s-loading", "/tmp/s-loading");
  rec.loading = { startedAt: 1, reverseRequestsSeen: 0, untaggedHistory: 0, untaggedSetup: 0 };
  const err = await refusal(() => manager.deleteSession("s-loading"));
  check("delete of a mid-LOAD session is refused with badRequest", err && (err as any).badRequest === true);
  check("the mid-load refusal says to wait for the load, not to stop a turn", /still loading/.test(String((err as any)?.message)));
  check("a refused mid-load delete put NOTHING on the wire", !calls.some((c) => c.method === "_x.ai/session/delete"));
  check("a refused mid-load delete kept the record", (manager as any).sessions.has("s-loading"));
}

// 5. Unknown id: neither held nor on the roster → refused before the wire.
{
  const { manager, calls, replies } = rig();
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "someone-else", cwd: "/x" }]);
  const err = await refusal(() => manager.deleteSession("ghost"));
  check("delete of an unknown id is refused with badRequest", err && (err as any).badRequest === true);
  check("a refused unknown-id delete never sent the delete call", !calls.some((c) => c.method === "_x.ai/session/delete"));
}

// 6. Open interactions for a deleted session are abandoned (answered with an
//    error) so the agent is not left blocked and no card survives.
{
  const { manager, replies, errors } = rig();
  held(manager, "s-open", "/tmp/s-open");
  (manager as any).openInteractions.set("interaction-9", {
    id: 9,
    method: "session/request_permission",
    params: { sessionId: "s-open", options: [] },
    sessionId: "s-open",
    build: () => ({}),
    event: { type: "interaction.permission_requested", sessionId: "s-open", data: { key: "interaction-9" } },
  });
  replies["_x.ai/session/delete"] = () => ({ success: true });
  replies["_x.ai/sessions/list"] = () => roster([]); // gone
  await manager.deleteSession("s-open");
  check("a deleted session's open interaction is answered with an error, not left hanging", errors.some((e) => e.id === 9 && e.code === -32000));
  check("a deleted session's open interaction is removed", (manager as any).openInteractions.size === 0);
}

// 6b. A VERIFIED delete prunes archive membership — the id is a dead reference
//     once the session is gone, and "Archived (N)" would count it forever. This
//     is membership pruning, not a data delete: the store holds ids and nothing
//     else. The manager's verdict is produced for real; the prune predicate the
//     route applies is asserted against that verdict, and the route's own
//     wiring is pinned by source below (routes cannot be imported — server.ts
//     listens on import).
{
  const { manager, replies } = rig();
  held(manager, "s-archived", "/tmp/s-archived");
  replies["_x.ai/session/delete"] = () => ({ success: true });
  replies["_x.ai/sessions/list"] = () => roster([]); // gone
  const store = new ArchiveStore(ARCHIVE_TMP);
  store.archive("s-archived");
  store.archive("s-other");
  const verdict = await manager.deleteSession("s-archived");
  const pruned = verdict.deleted && verdict.goneFromRoster ? store.restore("s-archived") : false;
  check("a verified delete prunes the deleted id out of the archive list", pruned === true && !store.isArchived("s-archived"));
  check("pruning one id leaves every other archived id alone", store.isArchived("s-other"));
  cleanupArchive();
}

// 6c. A delete that did NOT verify leaves archive membership alone: the session
//     is still there, and dropping it out of the archive would un-hide it.
{
  const { manager, replies } = rig();
  held(manager, "s-stays", "/tmp/s-stays");
  replies["_x.ai/session/delete"] = () => ({ success: true }); // the silent-success lie
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: "s-stays", cwd: "/tmp/s-stays" }]);
  const store = new ArchiveStore(ARCHIVE_TMP);
  store.archive("s-stays");
  const verdict = await manager.deleteSession("s-stays");
  const pruned = verdict.deleted && verdict.goneFromRoster ? store.restore("s-stays") : false;
  check("a no-op delete leaves the id archived (nothing was deleted, so nothing is pruned)", pruned === false && store.isArchived("s-stays"));
  cleanupArchive();
}

// 6ci. The prune runs AFTER the delete has been verified GONE, so it must never
//      be able to change the answer. `restore` persists, and persisting can
//      throw — proven here for real by removing the store's directory out from
//      under it. If that throw escaped the route it would reach the generic
//      catch and the client would print "Not deleted — … The session is intact.
//      Try again." about a session that is permanently gone: a false claim on
//      the one irreversible path, and the exact class this project guards.
{
  const dir = mkdtempSync(join(tmpdir(), "graphometer-archive-throw-"));
  const store = new ArchiveStore(join(dir, "list.json"));
  store.archive("s-gone");
  rmSync(dir, { recursive: true, force: true }); // the store's own directory, never a shared one
  let threw = false;
  try { store.restore("s-gone"); } catch { threw = true; }
  check("archive pruning CAN throw on an unwritable store — so it must not decide the verdict", threw);
}

// 6d. The delete route's own wiring, read from source: the prune sits behind the
//     VERIFIED branch, cannot convert a completed delete into an "intact"
//     report, and reuses the same bridge.archive_changed broadcast the restore
//     route sends.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
  const route = serverSrc.slice(serverSrc.indexOf(`url.pathname === "/session/delete"`));
  const block = route.slice(0, route.indexOf("\n    // ── export"));
  check("the delete route prunes archive membership only after deleted && goneFromRoster",
    /verdict\.deleted && verdict\.goneFromRoster/.test(block) &&
      block.indexOf("archive.restore(sessionId)") > block.indexOf("verdict.deleted && verdict.goneFromRoster"));
  check("the delete route broadcasts the existing bridge.archive_changed on a real change",
    /bridgeEvent\("bridge\.archive_changed", \{ archivedIds: archive\.list\(\) \}\)/.test(block));
  check("the prune is wrapped in try/catch, so a failing archive write cannot reach the route's catch",
    block.indexOf("try {") < block.indexOf("archive.restore(sessionId)") &&
      block.indexOf("archive.restore(sessionId)") < block.indexOf("} catch (err) {"));
  check("the earned verdict is returned 200 OUTSIDE the prune's try/catch",
    block.indexOf("} catch (err) {") < block.indexOf("json(res, 200, verdict)"));
}

// 7. No accidental delete path in the client: /session/delete must be reachable
//    only from the confirm modal's own handler, never from a rail-row click or a
//    restore. (Grep of app.js — the client wiring lands in the UI phase; this
//    pins the invariant now so it cannot regress silently.)
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  const deleteCalls = (appSrc.match(/post\(\s*["']\/session\/delete["']/g) || []).length;
  const fetchDeletes = (appSrc.match(/fetch\(\s*["']\/session\/delete["']/g) || []).length;
  check("app.js calls POST /session/delete at most once (a single confirm handler)", deleteCalls <= 1 && fetchDeletes === 0);
}

// ══ PILLAR 5 — EXPORT / IMPORT (the native round-trip) ════════════════════

const UUID = "019fa1db-2836-7d90-abcd-000000000000";

// A hostile synthetic history: agent message, tool title, and summary title all
// carry injection probes. They must survive the bundle verbatim as DATA (the
// Markdown-render safety is proven separately in app-recovery.check.ts).
const HOSTILE_STATE = {
  plan: null,
  planMode: null,
  signals: null,
  goal: null,
  announcement: null,
  summary: {
    info: { id: UUID, cwd: "/tmp/export-src" },
    session_summary: "<img src=x onerror=alert(1)>",
    generated_title: "</title><script>owned()</script>",
    session_kind: "Build",
    title_is_manual: true,
  },
};
const HOSTILE_UPDATES = [
  { timestamp: 1, method: "session/update", params: { sessionId: UUID, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "please help" } } } },
  { timestamp: 2, method: "session/update", params: { sessionId: UUID, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "<script>evil()</script> and `code`" } } } },
  { timestamp: 3, method: "session/update", params: { sessionId: UUID, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "<svg onload=1>rm -rf", kind: "execute" } } },
];

// 1. Export builds a well-formed, pure-JSON, round-trippable bundle; every
//    hostile string survives verbatim as data.
{
  const { manager, calls, replies } = rig();
  held(manager, UUID, "/tmp/export-src");
  replies["_x.ai/session/state"] = () => HOSTILE_STATE;
  replies["_x.ai/session/updates"] = () => ({ updates: HOSTILE_UPDATES, totalCount: 3, hasMore: false });
  const bundle = await manager.exportSession(UUID);
  check("export marks the bundle so import can refuse foreign shapes", bundle.kind === "graphometer-session-bundle" && bundle.version === 1);
  check("export carries sessionId, cwd, state and the RAW updates", bundle.sessionId === UUID && bundle.cwd === "/tmp/export-src" && !!bundle.state?.summary && bundle.updates.length === 3);
  check("the bundle round-trips through JSON.parse(JSON.stringify()) unchanged", deepEq(JSON.parse(JSON.stringify(bundle)), bundle));
  check("the hostile agent/tool/summary strings survive the bundle verbatim (as DATA)", JSON.stringify(bundle).includes("<script>evil()</script>") && JSON.stringify(bundle).includes("<svg onload=1>rm -rf") && JSON.stringify(bundle).includes("</title><script>owned()"));
  check("export sent session/state then session/updates on the wire", calls.some((c) => c.method === "_x.ai/session/state") && calls.some((c) => c.method === "_x.ai/session/updates"));
}

// 2. A summary-less state is not an exportable bundle — refused before updates.
{
  const { manager, calls, replies } = rig();
  held(manager, UUID, "/tmp/export-src");
  replies["_x.ai/session/state"] = () => ({ plan: null, summary: null }); // no summary
  const err = await refusal(() => manager.exportSession(UUID));
  check("export of a summary-less state is refused (not a valid bundle)", err && (err as any).badRequest === true);
  check("a summary-less export never asks for the transcript", !calls.some((c) => c.method === "_x.ai/session/updates"));
}

// 3. hasMore:true is surfaced loudly — a truncated transcript is an incomplete bundle.
{
  const { manager, replies, counts } = rig();
  held(manager, UUID, "/tmp/export-src");
  replies["_x.ai/session/state"] = () => HOSTILE_STATE;
  replies["_x.ai/session/updates"] = () => ({ updates: HOSTILE_UPDATES, totalCount: 999, hasMore: true });
  const bundle = await manager.exportSession(UUID);
  check("export reports hasMore when the transcript was truncated", bundle.hasMore === true);
  check("a truncated export is loud (the bundle would be incomplete)", counts.louds >= 1);
}

// 4. Import validation is LOCAL, before the wire: foreign shape, non-UUID id,
//    and a summary-less bundle are each refused with badRequest and zero calls.
{
  const foreign = { messages: [{ role: "user", content: "hi" }], title: "an OpenWebUI export" };
  const nonUuid = { kind: "graphometer-session-bundle", sessionId: "not-a-uuid", cwd: "/x", state: { summary: {} }, updates: [] };
  const noSummary = { kind: "graphometer-session-bundle", sessionId: UUID, cwd: "/x", state: {}, updates: [] };
  const markdownFile = "# a markdown export\n\nnot a bundle";
  for (const [name, b] of [["a foreign (OpenWebUI) JSON", foreign], ["a non-UUID id", nonUuid], ["a summary-less bundle", noSummary], ["a Markdown string", markdownFile]] as [string, any][]) {
    const { manager, calls } = rig();
    const err = await refusal(() => manager.importSession(b));
    check(`import refuses ${name} locally with badRequest`, err && (err as any).badRequest === true);
    check(`import of ${name} put NOTHING on the wire`, !calls.some((c) => c.method === "_x.ai/session/import"));
  }
}

// 5. Import read-back (rule 1): {imported:true} is only reported as success when
//    the id is actually present in sessions/list afterward.
{
  const bundle = { kind: "graphometer-session-bundle", version: 1, sessionId: UUID, cwd: "/tmp/dest", state: HOSTILE_STATE, updates: HOSTILE_UPDATES };
  // (a) imported + present → confirmed success
  {
    const { manager, replies, counts } = rig();
    replies["_x.ai/session/import"] = () => ({ imported: true });
    replies["_x.ai/sessions/list"] = () => roster([{ sessionId: UUID, cwd: "/tmp/dest" }]);
    const result = await manager.importSession(bundle);
    check("import confirmed only when the id reads back present", result.imported && result.present && !result.alreadyExisted && counts.notes >= 1);
  }
  // (b) imported:true but ABSENT → not a confirmed import (loud)
  {
    const { manager, replies, counts } = rig();
    replies["_x.ai/session/import"] = () => ({ imported: true });
    replies["_x.ai/sessions/list"] = () => roster([]);
    const result = await manager.importSession(bundle);
    check("import claiming success while absent is NOT confirmed", result.imported && !result.present && counts.louds >= 1);
  }
}

// 6. Refuse-overwrite: {imported:false} with the id already present is a silent
//    left-unchanged, reported as alreadyExisted — NOT an error, NOT a fresh
//    success. Live-proven on 0.2.118: the second import of the same id went out
//    as wire id=33 and came back {"imported":false}, which the app reported as
//    alreadyExisted=true (evidence under docs/evidence/wp13/).
{
  const bundle = { kind: "graphometer-session-bundle", version: 1, sessionId: UUID, cwd: "/tmp/dest", state: HOSTILE_STATE, updates: HOSTILE_UPDATES };
  const { manager, replies } = rig();
  replies["_x.ai/session/import"] = () => ({ imported: false }); // refuse-overwrite
  replies["_x.ai/sessions/list"] = () => roster([{ sessionId: UUID, cwd: "/tmp/dest" }]); // already there
  const result = await manager.importSession(bundle);
  check("refuse-overwrite is reported as alreadyExisted, not a fresh success", result.imported === false && result.present === true && result.alreadyExisted === true);
  check("a refuse-overwrite import never claims it imported", !(result.imported && result.present));
}

// 7. A bundle with no destination cwd is refused locally, before the wire — and
//    it is the MANAGER that refuses it (400), not the path gate, which has
//    nothing to judge. See check 9 for the gate's half of this split.
{
  const noCwd = { kind: "graphometer-session-bundle", version: 1, sessionId: UUID, state: HOSTILE_STATE, updates: [] };
  const { manager, calls } = rig();
  const err = await refusal(() => manager.importSession(noCwd));
  check("import of a bundle with no cwd is refused with badRequest", err && (err as any).badRequest === true);
  check("import of a cwd-less bundle put NOTHING on the wire", !calls.some((c) => c.method === "_x.ai/session/import"));
}

// 8. A TRUNCATED transcript (hasMore) splits the two formats. The bundle is
//    round-trippable or it is nothing, so it is refused; the Markdown saves but
//    says INCOMPLETE in its own first lines and carries it in the filename.
//    The route holds the format, so its half is read from source (server.ts
//    listens on import and cannot be imported here); the document marker is
//    exercised for real through bundleToMarkdown.
{
  const truncated = { kind: "graphometer-session-bundle", version: 1, sessionId: UUID, cwd: "/tmp/export-src", state: HOSTILE_STATE, updates: HOSTILE_UPDATES, totalCount: 999, hasMore: true };
  const md = bundleToMarkdown(truncated);
  check("a truncated transcript is marked INCOMPLETE at the top of the Markdown, above the first turn",
    /INCOMPLETE/.test(md) && md.indexOf("INCOMPLETE") < md.indexOf("## You"));
  check("the incomplete marker names the cause (only part of the history was returned)", /truncated/.test(md) && /hasMore/.test(md));
  const whole = bundleToMarkdown({ ...truncated, hasMore: false });
  check("a complete transcript carries no incomplete marker", !/INCOMPLETE/.test(whole));

  const HERE = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
  const route = serverSrc.slice(serverSrc.indexOf(`url.pathname === "/session/export"`));
  const block = route.slice(0, route.indexOf("\n    // ── import"));
  check("the export route REFUSES a truncated bundle in the caller-error family (400)",
    /format === "bundle" && bundle\.hasMore/.test(block) && /json\(res, 400,/.test(block));
  check("the refusal sentence says the bundle could not round-trip faithfully",
    /could not round-trip faithfully/.test(block));
  check("a truncated Markdown filename carries -incomplete before the extension",
    /bundle\.hasMore \? "-incomplete" : ""\}\.md/.test(block));
}

// 9. THE IMPORT PATH GATE (D50). A bundle names its own destination cwd, so
//    importing is session CREATION at a caller-chosen path — the same class
//    /session/new closed. The gate is the ONE shared `pathRefusal` the listing
//    and creation routes call, exercised here on a stand-in excluded root (a
//    neutral name; the real list is per-machine configuration, empty by
//    default). The route's own wiring — gate BEFORE the manager, 403, the same
//    EXCLUDED_DIRS list — is read from source, since server.ts listens on
//    import and cannot be called here.
//
//    Two facts make this gate harder than /session/new's, and both are checked
//    below for real before the source assertions: a bundle carries its
//    destination TWICE (`cwd` and `state.summary.info.cwd`, and the manager
//    forwards `state` verbatim), and a non-absolute cwd resolves against a
//    different base for the gate than for the agent child. So the route judges
//    an ABSOLUTE, RESOLVED cwd, ships that same value, and refuses a bundle
//    whose two destinations disagree.
{
  const root = mkdtempSync(join(tmpdir(), "graphometer-import-gate-"));
  try {
    const excludedRoot = join(root, "excluded-zone");
    mkdirSync(excludedRoot);
    mkdirSync(join(excludedRoot, "inner"));
    const EX = [excludedRoot];
    check("a bundle cwd that IS an excluded root is refused (403 class)", pathRefusal(excludedRoot, EX)?.code === "FORBIDDEN");
    check("a bundle cwd UNDER an excluded root is refused", pathRefusal(join(excludedRoot, "inner"), EX)?.code === "FORBIDDEN");
    check("a bundle cwd that names a not-yet-existing child of an excluded root is refused",
      pathRefusal(join(excludedRoot, "not-created-yet"), EX)?.code === "FORBIDDEN");
    check("an ordinary bundle cwd still imports (the gate does not over-block)", pathRefusal(root, EX) === null);
    check("with nothing configured excluded, no bundle cwd is refused", pathRefusal(excludedRoot, []) === null);
    let aliasMade = true;
    try { symlinkSync(excludedRoot, join(root, "alias-zone")); } catch { aliasMade = false; }
    if (aliasMade) {
      check("a symlink alias to an excluded root cannot smuggle a bundle in", pathRefusal(join(root, "alias-zone"), EX)?.code === "FORBIDDEN");
    } else {
      console.log(`ok ${++passed} - symlink-alias bundle case skipped (platform cannot symlink)`);
    }

    // A RELATIVE cwd is judged against one base and used against another: the
    // gate resolves it against the studio server's directory, the agent child
    // against its own. Demonstrated for real, so the "absolute only" rule is
    // not taken on faith — the same spelling that pathRefusal allows lands
    // exactly on the excluded root once the child's base is applied.
    {
      const serverBase = join(root, "repo");
      const agentBase = join(serverBase, "studio", "scratch");
      const escape = "../../../excluded-zone";
      check("a relative bundle cwd resolves to a DIFFERENT folder for the gate than for the agent",
        resolveFrom(serverBase, escape) !== resolveFrom(agentBase, escape) &&
          resolveFrom(agentBase, escape) === excludedRoot);
      check("a non-absolute bundle cwd is refused before the gate ever runs (isAbsolute is the rule)",
        !isAbsolute(escape) && !isAbsolute("./inner") && isAbsolute(excludedRoot));
      // A leading space defeats isAbsolute too, and pathRefusal would then
      // resolve the padded spelling relative to the server — so the same rule
      // catches it. The untrimmed string is what would otherwise ship.
      check("a space-padded absolute cwd is not absolute, so it is refused rather than trimmed",
        !isAbsolute(`  ${excludedRoot}`));
    }

    // The manager does NOT gate paths — it sends the bundle's cwd as given, and
    // it forwards `state` VERBATIM, so a bundle's second destination
    // (state.summary.info.cwd) reaches the wire untouched. That is why the
    // route's gate is load-bearing on BOTH strings, and this pins the boundary
    // so a future reader does not assume the manager covers either one.
    {
      const { manager, calls, replies } = rig();
      replies["_x.ai/session/import"] = () => ({ imported: true });
      replies["_x.ai/sessions/list"] = () => roster([{ sessionId: UUID, cwd: excludedRoot }]);
      const twoFaced = {
        kind: "graphometer-session-bundle", version: 1, sessionId: UUID,
        cwd: root, // the ordinary folder the route would judge
        state: { ...HOSTILE_STATE, summary: { ...HOSTILE_STATE.summary, info: { id: UUID, cwd: excludedRoot } } },
        updates: [],
      };
      await manager.importSession(twoFaced);
      const sent = calls.find((c) => c.method === "_x.ai/session/import");
      check("the manager itself does not judge paths — it sends the bundle's cwd verbatim", !!sent && sent.params.cwd === root);
      check("the manager forwards state verbatim, so a bundle's SECOND destination reaches the wire unjudged",
        !!sent && sent.params.state?.summary?.info?.cwd === excludedRoot);
      check("the two destinations of a crafted bundle disagree — which is the rule the route refuses on",
        resolveFrom(".", twoFaced.cwd) !== resolveFrom(".", excludedRoot));
    }

    const HERE = dirname(fileURLToPath(import.meta.url));
    const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
    const route = serverSrc.slice(serverSrc.indexOf(`url.pathname === "/session/import"`));
    const block = route.slice(0, route.indexOf("\n    // ── answer a blocking interaction"));
    check("the import route runs pathRefusal BEFORE it calls the manager",
      block.indexOf("pathRefusal(") !== -1 &&
        block.indexOf("pathRefusal(") < block.indexOf("manager.importSession("));
    check("the import route refuses with 403 and the new/load sentence family",
      /json\(res, 403, \{ error: `a session cannot be imported there — \$\{refusal\.error\}` \}\)/.test(block));
    check("the import route returns on refusal — the manager and the wire are never reached",
      /json\(res, 403[\s\S]{0,200}?return;/.test(block) &&
        block.indexOf("return;") < block.indexOf("manager.importSession("));
    check("the import route uses the SAME excluded list as /session/new and /session/load",
      /pathRefusal\(cwd, EXCLUDED_DIRS\)/.test(block));
    // The string the gate judges must be the string that ships. /session/new
    // gates rawCwd and ships resolvePath(rawCwd); import cannot do that, because
    // the value it ships is inside a bundle — so it resolves FIRST, gates the
    // resolved value, and puts that value back into the bundle.
    check("the import route resolves the cwd BEFORE it gates it",
      block.indexOf("const cwd = resolvePath(rawCwd)") !== -1 &&
        block.indexOf("const cwd = resolvePath(rawCwd)") < block.indexOf("pathRefusal(cwd, EXCLUDED_DIRS)"));
    check("the import route hands the manager the RESOLVED cwd, not the caller's string",
      /bundle = \{ \.\.\.bundle, cwd \}/.test(block) &&
        block.indexOf("bundle = { ...bundle, cwd }") < block.indexOf("manager.importSession("));
    check("the import route refuses a non-absolute bundle cwd in the caller-error family (400)",
      /if \(!isAbsolute\(rawCwd\)\)/.test(block) && /not an absolute path/.test(block));
    check("the import route refuses a bundle whose two destinations disagree (400)",
      /state\?\.summary\?\.info\?\.cwd/.test(block) &&
        /resolvePath\(infoCwd\) !== cwd/.test(block) &&
        /names two different destination folders/.test(block));
    check("both extra refusals return before the manager is called",
      block.lastIndexOf("json(res, 400,") < block.indexOf("manager.importSession("));
    // The doc comment over EXCLUDED_DIRS is the map a reader trusts for "which
    // routes are gated". It listed three; import was the fourth all along.
    const excludedDoc = serverSrc.slice(
      serverSrc.indexOf("Directories no route may list"),
      serverSrc.indexOf("const EXCLUDED_DIRS"),
    );
    check("the gated-routes doc comment names /session/import alongside list, new and load",
      /`\/fs\/list`/.test(excludedDoc) && /`\/session\/new`/.test(excludedDoc) &&
        /`\/session\/load`/.test(excludedDoc) && /`\/session\/import`/.test(excludedDoc));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// WP7 §2 — the command catalogue is READABLE or it is not. It is never a
// confident zero.
//
// The old code coerced every unreadable shape to `[]` in three places at once:
// the query returned `commands: []` with a 200, a live update overwrote a good
// catalogue with `[]`, and the normaliser counted it as 0. A launcher drawn
// from any of those would have told the operator "the agent reports no commands
// for this session" — a sentence about the agent assembled out of a payload we
// could not read. Grok's 1.0.0 audit called this out as blocking; these are the
// checks that keep it closed. The normaliser's half is in events.check.ts.
// ─────────────────────────────────────────────────────────────────────────

/** The flat `commands/list` result shape (EXT_ENVELOPE false — no envelope). */
const CMD_ROW = { name: "compact", description: "Compress conversation history", input: { hint: "what to keep" } };

// A valid empty array is a real answer and still succeeds.
{
  const { manager, replies } = rig();
  held(manager, "s-cmd-empty", "/tmp/s");
  replies["_x.ai/commands/list"] = () => ({ commands: [], tools: [] });
  const out = await manager.listCommands("s-cmd-empty");
  check("a VALID empty catalogue is returned as an empty catalogue, not an error",
    Array.isArray(out.commands) && out.commands.length === 0 && out.scope === "session");
  const rec = (manager as any).sessions.get("s-cmd-empty");
  check("and it is recorded as a real, queried, empty list",
    rec.commands !== null && rec.commands.commands.length === 0 && rec.commands.source === "query");
}

// Every malformed shape throws, marked so the route can answer 502.
for (const [label, payload] of [
  ["no commands key", { tools: [] }],
  ["commands: null", { commands: null }],
  ["commands: {}", { commands: {} }],
  ["commands: a string", { commands: "compact" }],
  ["commands: a nameless row", { commands: [{}] }],
  ["commands: a whitespace-only name", { commands: [{ name: "   " }] }],
  ["a non-object result", 42],
] as [string, any][]) {
  const { manager, replies, emitted, counts } = rig();
  held(manager, "s-cmd-bad", "/tmp/s");
  replies["_x.ai/commands/list"] = () => payload;
  let thrown: any = null;
  try { await manager.listCommands("s-cmd-bad"); } catch (err) { thrown = err; }
  check(`commands/list with ${label} throws instead of returning zero commands`, thrown !== null);
  check(`commands/list with ${label} is marked unreadable for the route`,
    thrown?.unreadableCatalogue === true);
  check(`commands/list with ${label} says "unreadable, not empty" in its message`,
    /unreadable, not empty/.test(String(thrown?.message)));
  check(`commands/list with ${label} is loud`, counts.louds === 1);
  check(`commands/list with ${label} puts a visible diagnostic on the stream`,
    emitted.some((ev) => ev.type === "bridge.commands_unreadable" && ev.sessionId === "s-cmd-bad"));
  const rec = (manager as any).sessions.get("s-cmd-bad");
  check(`commands/list with ${label} writes nothing to the record`, rec.commands === null);
}

// A malformed LIVE update never replaces a good catalogue.
{
  const { manager, emitted, counts } = rig();
  const rec = held(manager, "s-cmd-live", "/tmp/s");
  const update = (commands: any) => (manager as any).onNotification({
    method: "session/update",
    params: { sessionId: "s-cmd-live", update: { sessionUpdate: "available_commands_update", availableCommands: commands, _meta: { tools: ["read"] } } },
  });

  update([CMD_ROW]);
  check("a valid live update fills the catalogue",
    rec.commands.commands.length === 1 && rec.commands.source === "agent-notification");

  const before = rec.commands;
  for (const bad of [null, undefined, {}, "compact", 7, [{}], [{ name: "   " }]]) {
    update(bad);
    check(`a malformed live update (${JSON.stringify(bad) ?? "undefined"}) keeps the last good catalogue`,
      rec.commands === before && rec.commands.commands.length === 1);
  }
  check("each malformed update is loud", counts.louds === 7);
  check("each malformed update says so on the stream",
    emitted.filter((ev) => ev.type === "bridge.commands_unreadable").length === 7);
  check("the diagnostic names how many commands were kept",
    emitted.filter((ev) => ev.type === "bridge.commands_unreadable")
      .every((ev) => (ev.data as any).keptCount === 1));

  // …and a VALID empty update still replaces it. Empty is a reading.
  update([]);
  check("a valid EMPTY live update does replace the catalogue — empty is a real answer",
    rec.commands !== before && rec.commands.commands.length === 0);
}

// With no prior good list, a malformed update leaves "unreadable", not "empty".
{
  const { manager, emitted } = rig();
  const rec = held(manager, "s-cmd-first", "/tmp/s");
  (manager as any).onNotification({
    method: "session/update",
    params: { sessionId: "s-cmd-first", update: { sessionUpdate: "available_commands_update", availableCommands: null } },
  });
  check("a malformed first update leaves the catalogue unset, never an empty list",
    rec.commands === null);
  check("and the diagnostic says there was no earlier good catalogue",
    emitted.some((ev) => ev.type === "bridge.commands_unreadable" &&
      (ev.data as any).keptCount === null && /UNREADABLE/.test(String(ev.note))));
}

// The launcher's list is session-scoped. The global list is a different truth.
{
  const { manager, calls, replies } = rig();
  held(manager, "s-cmd-scope", "/tmp/s");
  replies["_x.ai/commands/list"] = (params: any) =>
    params.sessionId ? { commands: [CMD_ROW, CMD_ROW], tools: ["read"] } : { commands: [CMD_ROW] };
  const scoped = await manager.listCommands("s-cmd-scope");
  const global = await manager.listCommands();
  check("a session-scoped query sends the sessionId", calls[0].params.sessionId === "s-cmd-scope");
  check("a global query sends no sessionId", Object.keys(calls[1].params).length === 0);
  check("the two lists are reported under their own scope, and can differ",
    scoped.scope === "session" && global.scope === "global" &&
      scoped.commands.length === 2 && global.commands.length === 1);
}

// A query begun before a live update may still return to its HTTP caller, but
// it must not roll the manager's retained catalogue back over the newer event.
{
  const { manager, replies } = rig();
  const rec = held(manager, "s-cmd-race", "/tmp/s");
  let resolveQuery: (value: any) => void = () => {};
  replies["_x.ai/commands/list"] = () => new Promise((resolve) => { resolveQuery = resolve; });
  const pending = manager.listCommands("s-cmd-race");
  await Promise.resolve();
  (manager as any).onNotification({
    method: "session/update",
    params: {
      sessionId: "s-cmd-race",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "new-live", description: "newer event" }],
      },
    },
  });
  resolveQuery({ commands: [{ name: "old-query", description: "stale response" }], tools: [] });
  const returned = await pending;
  check("a pending command query may return its valid response to its own caller",
    (returned.commands[0] as any).name === "old-query");
  check("but that stale query cannot overwrite the newer retained live catalogue",
    rec.commands.source === "agent-notification" && rec.commands.commands[0].name === "new-live");
}

// The route turns the marked error into a 502 with `unreadable`, and leaves
// every other failure to the existing caller-error/500 split.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
  const block = serverSrc.slice(
    serverSrc.indexOf('if (url.pathname === "/commands/list")'),
    serverSrc.indexOf('if (url.pathname === "/session/info")'),
  );
  check("the /commands/list route answers 502 for an unreadable catalogue",
    /json\(res, 502, \{ error: redact\(String\(\(err as Error\)\.message\)\), unreadable: true \}\)/.test(block));
  check("the /commands/list route rethrows anything that is not an unreadable catalogue",
    /if \(\(err as any\)\?\.unreadableCatalogue !== true\) throw err;/.test(block));
  check("the /commands/list route still answers 200 for a readable one",
    /json\(res, 200, await manager\.listCommands\(sessionId\)\)/.test(block));
}

// ══ WP15 — setCodingDataRetention (D87) ═════════════════════════════════
//
// Flat reply CONFIRMED Phase 0. The manager only talks to the agent; the
// server re-reads the file and names one of three outcomes. Here we check
// the manager's wire shape and reply handling.

// 1. Wire shape: underscore method, camelCase param, ≥30s path is PRIVACY.
{
  const { manager, calls, replies } = rig();
  replies["_x.ai/privacy/setCodingDataRetention"] = (p: any) => ({
    codingDataRetentionOptOut: p.codingDataRetentionOptOut,
  });
  const result = await manager.setCodingDataRetention(true);
  const call = calls.find((c) => c.method === "_x.ai/privacy/setCodingDataRetention");
  check("WP15: setCodingDataRetention sends the underscore-prefixed ext method", !!call);
  check("WP15: params are exactly {codingDataRetentionOptOut:bool}",
    !!call && deepEq(call.params, { codingDataRetentionOptOut: true }));
  check("WP15: a matching flat reply is replyAgreed",
    result.sent === true && result.replyAgreed === true && result.replyOptOut === true);
  check("WP15: the requested value is recorded on the result",
    result.requested === true);
}

// 2. Reply disagreed with the request → replyAgreed false (loud).
{
  const { manager, replies, counts } = rig();
  replies["_x.ai/privacy/setCodingDataRetention"] = () => ({
    codingDataRetentionOptOut: false, // agent said the opposite
  });
  const result = await manager.setCodingDataRetention(true);
  check("WP15: a disagreeing reply is NOT replyAgreed",
    result.replyAgreed === false && result.replyOptOut === false);
  check("WP15: a disagreeing reply is loud", counts.louds >= 1);
}

// 3. Malformed / missing reply field → replyOptOut null, not agreed.
{
  const { manager, replies } = rig();
  replies["_x.ai/privacy/setCodingDataRetention"] = () => ({ ok: true });
  const result = await manager.setCodingDataRetention(false);
  check("WP15: a reply without the field is replyOptOut null",
    result.replyOptOut === null && result.replyAgreed === false);
}

// 4. Non-boolean argument is refused locally, nothing on the wire.
{
  const { manager, calls } = rig();
  const err = await refusal(() => manager.setCodingDataRetention("yes" as any));
  check("WP15: a non-boolean is refused with badRequest", err && (err as any).badRequest === true);
  check("WP15: a refused set put NOTHING on the wire", calls.length === 0);
}

// 5. Agent throw (refusal) propagates — the server turns it into outcome:refused.
{
  const { manager, replies } = rig();
  replies["_x.ai/privacy/setCodingDataRetention"] = () => {
    const e: any = new Error("Cannot change: Zero Data Retention enabled");
    throw e;
  };
  let threw: any = null;
  try { await manager.setCodingDataRetention(false); } catch (e) { threw = e; }
  check("WP15: an agent refusal throws (server maps it to outcome:refused)",
    !!threw && /Zero Data Retention/.test(String(threw.message)));
}

// 6. Envelope table + method constant + no fs import (sessions still cannot write auth.json).
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, "sessions.ts"), "utf8");
  check("WP15: EXT_ENVELOPE records setCodingDataRetention as FLAT",
    /"_x\.ai\/privacy\/setCodingDataRetention":\s*false/.test(src));
  check("WP15: M.setCodingDataRetention is the underscore method",
    /setCodingDataRetention:\s*"_x\.ai\/privacy\/setCodingDataRetention"/.test(src));
  check("WP15: PRIVACY_TIMEOUT_MS is ≥ 30000",
    /PRIVACY_TIMEOUT_MS\s*=\s*30_000/.test(src));
  check("WP15: sessions.ts still imports no filesystem module (cannot write auth.json)",
    !/from\s+"node:fs/.test(src) && !/require\(\s*["']node:fs/.test(src));
}

// ══ WP14 — the /bridge development gate (D46) ═══════════════════════════
//
// The ungated route tables contain no bridge route at all — not a redirect,
// not a stub page, no served assets. The tables are built in page-maps.ts
// precisely so they can be imported and built both ways here (server.ts
// listens on import, so it can never be imported).
{
  const pagesOff = buildPageMap(false);
  const assetsOff = buildAssetMap(false);
  check("WP14: the ungated page map has no /bridge route",
    !pagesOff.has("/bridge") && pagesOff.get("/") === "index.html");
  check("WP14: the ungated asset map serves no bridge asset",
    !assetsOff.has("/bridge.css") && !assetsOff.has("/bridge.js"));
  check("WP14: the ungated asset map still serves the shell's own assets",
    assetsOff.has("/app.css") && assetsOff.has("/app.js"));
  const pagesOn = buildPageMap(true);
  const assetsOn = buildAssetMap(true);
  check("WP14: the dev-gated page map has /bridge",
    pagesOn.get("/bridge") === "bridge.html");
  check("WP14: the dev-gated asset map serves both bridge assets",
    assetsOn.has("/bridge.css") && assetsOn.has("/bridge.js"));
  // server.ts keys the gate off exactly STUDIO_DEV === "1" and builds its
  // tables from these builders (source-read; there is no route harness).
  const HERE = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(HERE, "server.ts"), "utf8");
  check("WP14: server.ts takes the gate from STUDIO_DEV === '1'",
    /const DEV = process\.env\.STUDIO_DEV === "1";/.test(serverSrc));
  check("WP14: server.ts builds both route tables from page-maps.ts with the flag",
    /const PAGES = buildPageMap\(DEV\);/.test(serverSrc) && /const ASSETS = buildAssetMap\(DEV\);/.test(serverSrc));
}

// ─────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} session-admin checks passed`);
