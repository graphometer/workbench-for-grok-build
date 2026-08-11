// Many sessions on one agent connection.
//
// This file owns the agent: one `AcpClient`, one child `grok` process, and a
// map of sessions living inside it. Everything it has to say goes out as an
// `AppEvent` on the `app` event, so the server above it is HTTP plumbing and
// nothing more.
//
// The rule that shapes every method below: THIS API RETURNS SUCCESS FOR CALLS
// THAT DID NOTHING. Not occasionally — as a house style. So no method here
// returns "ok" on the strength of a response. Each one names what it read back,
// or says plainly that it could not read anything back, and every result
// carries the reading so a caller cannot mistake an acknowledgement for a fact.
//
// Provenance for the protocol facts: probed against `grok 0.2.114` on
// 2026-07-29. The three that were NOT what this package's brief said they were
// are marked CORRECTION and are recorded in `PROJECT-STATE.md` §5.

import {
  AcpClient,
  AcpRpcError,
  type AcpClientOptions,
  type AcpEvent,
  type ReverseRequest,
} from "./acp.ts";
import {
  notificationToAppEvent,
  reverseRequestToAppEvent,
  bridgeEvent,
  type AppEvent,
} from "./events.ts";
import { EventEmitter } from "node:events";
import { isAbsolute, relative } from "node:path";
import { canonicalPath } from "./fs-browse.ts";

// ── the ext envelope, per method, because there is no rule ───────────────
//
// The brief for this package says "ext results arrive at `result.result`".
// CORRECTION: that is true of some ext methods and false of others, and the
// difference is per-handler upstream, not per-namespace. Measured on 0.2.114:
//
//   _x.ai/sessions/list   -> {"result":{"result":{"sessions":[…]}}}   enveloped
//   _x.ai/session/info    -> {"result":{"result":{"sessionId":…}}}    enveloped
//   _x.ai/commands/list   -> {"result":{"commands":[…],"tools":[…]}}  FLAT
//
// Upstream reads exactly that way: `handle_roster_list` and
// `handle_session_info` return `ExtMethodResult::success(…).to_ext_response()`,
// while `handle_commands_list` returns `acp::ExtResponse::new(…)` directly with
// no envelope at all. So the shape is a property of the individual handler.
//
// Which means a shape heuristic is not just inelegant here, it is wrong: an
// "unwrap if there is a `result` key" rule mangles any flat payload that
// happens to have its own `result` field, and this table is the only thing
// standing between us and that. A method missing from the table is reported,
// not guessed at.
const EXT_ENVELOPE: Record<string, boolean> = {
  "_x.ai/session/info": true,
  "_x.ai/sessions/list": true,
  "_x.ai/commands/list": false,
  "_x.ai/compact_conversation": false,
  // WP13 (D58–D61). All five are FLAT at msg.result: upstream returns them via
  // `to_raw_response` (rename/delete/state/import) or `ExtResponse::new`
  // (updates), never the enveloped `ExtMethodResult::success(...).to_ext_response()`.
  // SOURCE-grounded (WP13_WIRE_REFERENCE.json); the build's live run confirms
  // the flat shape on the wire before each is treated as wire-proven, and the
  // unwrapExt table says so loudly if an observation ever disagrees.
  "_x.ai/session/rename": false,
  "_x.ai/session/delete": false,
  "_x.ai/session/state": false,
  "_x.ai/session/updates": false,
  "_x.ai/session/import": false,
  // WP11: the hunk tracker (changes and undo). ALL SIX are DOUBLE-WRAPPED at
  // result.result on 1.0.0 — CONFIRMED by the wp11-probe wire captures
  // (docs/evidence/wp11-probe/, F1). A consumer reading `result.hunks` off the
  // raw reply gets undefined silently; run 1's own action phase fell into
  // exactly that hole. Only error replies are ordinary unwrapped JSON-RPC.
  "_x.ai/hunk-tracker/get-files": true,
  "_x.ai/hunk-tracker/get-summary": true,
  "_x.ai/hunk-tracker/get-hunks": true,
  "_x.ai/hunk-tracker/hunk-action": true,
  "_x.ai/hunk-tracker/file-action": true,
  "_x.ai/hunk-tracker/turn-action": true,
  // WP12 F2's cross-check. CONFIRMED on the wire in the WP12 delta run
  // (artifact 32-gitstatus-wire-raw.txt): double-wrapped, payload
  // {root, branch, commit, staged[], unstaged[]}.
  "_x.ai/git/status": true,
  // WP15 Phase 0 wire probe (docs/evidence/wp15/probe/): FLAT reply
  // {"codingDataRetentionOptOut":bool} via upstream to_raw_response.
  // Method needs the leading underscore on --no-leader (same convention).
  "_x.ai/privacy/setCodingDataRetention": false,
};

// ── method names ────────────────────────────────────────────────────────
// Ext methods need the leading underscore. `x.ai/session/info` returns
// `-32601 Method not found` on a direct --no-leader connection; the
// underscore-prefixed name works. Tested both directions — PROJECT-STATE §5.

const M = {
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel", // a NOTIFICATION, not a request
  setMode: "session/set_mode",
  setModel: "session/set_model",
  sessionInfo: "_x.ai/session/info",
  sessionsList: "_x.ai/sessions/list",
  commandsList: "_x.ai/commands/list",
  compact: "_x.ai/compact_conversation",
  // ── WP13: session management & portability (D58–D61) ──
  // All ext REQUESTS take the leading underscore on a --no-leader connection,
  // proven for `_x.ai/session/info` (bare `x.ai/...` → -32601, PROJECT-STATE §5).
  sessionRename: "_x.ai/session/rename",
  sessionDelete: "_x.ai/session/delete",
  sessionState: "_x.ai/session/state",
  sessionUpdates: "_x.ai/session/updates",
  sessionImport: "_x.ai/session/import",
  // A one-way NOTIFICATION (no reply), sent via `acp.notify` like sessionCancel.
  // The send-side underscore is UNVERIFIED (the received-direction convention
  // implies it; the live run confirms) — WP13_WIRE_REFERENCE gap 1.
  yoloModeChanged: "_x.ai/yolo_mode_changed",
  // ── WP11: changes and undo (the hunk tracker) ──
  // sessionId is REQUIRED on all six, and the two read methods fail with
  // DIFFERENT error codes when it is missing (-32602 from get-hunks, -32603
  // from get-summary — wp11-probe F3). require() gates them all locally, so
  // that split never reaches a caller.
  changesFiles: "_x.ai/hunk-tracker/get-files",
  changesSummary: "_x.ai/hunk-tracker/get-summary",
  changesHunks: "_x.ai/hunk-tracker/get-hunks",
  hunkAction: "_x.ai/hunk-tracker/hunk-action",
  fileAction: "_x.ai/hunk-tracker/file-action",
  turnAction: "_x.ai/hunk-tracker/turn-action",
  // WP12 F2: read-only, and called ONLY as the tracker-suspect cross-check
  // (changes() annotates a positively-empty reading on a suspect session).
  // Params are camelCase (GitStatusRequest has rename_all camelCase, upstream
  // extensions/git.rs:63).
  gitStatus: "_x.ai/git/status",
  // WP15: coding-data retention switch (D87). Network PUT; FLAT reply
  // CONFIRMED Phase 0 2026-08-11. Params camelCase codingDataRetentionOptOut.
  setCodingDataRetention: "_x.ai/privacy/setCodingDataRetention",
} as const;

// ── timeouts ────────────────────────────────────────────────────────────
//
// CORRECTION, and this one has teeth. The brief says `set_mode` "returns
// success for ANY string, including typos and nonexistent sessions". The first
// half is true. The second half is not, and the truth is worse:
//
//   --> {"id":12,"method":"session/set_mode",
//        "params":{"sessionId":"no-such-session","modeId":"plan"}}
//   <-- (nothing, ever)
//
// It never answers, and the reason is an upstream deadlock rather than a wait.
// `set_session_mode` at `acp_agent.rs:3336` reads:
//
//   let handle = self.session_handle_waiting_for_load(&args.session_id).await;
//   let (tx, rx) = oneshot::channel();
//   if let Some(handle) = handle { /* … moves tx into the send … */ }
//   let _ = rx.await.map_err(…)?;
//
// For an unknown id the lookup returns `None` immediately, so the `if let` body
// never runs and `tx` is never moved and never dropped — it stays alive in the
// enclosing scope. `rx.await` is then waiting on a sender that exists and will
// never send. That await never completes, so the request is held forever with
// no response and no error. `_x.ai/compact_conversation` has the identical
// shape at `extensions/memory.rs:27` and behaves the identical way. Both
// confirmed on the wire and in the source.
//
// `session/set_model` is NOT affected — it does `ok_or_else(invalid_params)` on
// the same lookup and returns a proper error.
//
// Two defences, because either alone is thin. Every method that takes a
// sessionId checks it against our own map first and refuses locally; and every
// control method carries an explicit short timeout so that if the check is ever
// wrong, the wedge surfaces as an error in seconds instead of a hang.
const CONTROL_TIMEOUT_MS = 15_000;
/** A load replays an entire conversation before it answers. Weeks of turns, potentially. */
const LOAD_TIMEOUT_MS = 180_000;
/** How long to wait for `current_mode_update` before reporting "no confirmation". */
const MODE_CONFIRM_MS = 3_000;
/** WP15: setCodingDataRetention is a network PUT via the agent (≥30s per D87). */
const PRIVACY_TIMEOUT_MS = 30_000;

/** How often to check for a wedged turn, and how much silence counts as wedged. */
const STALL_CHECK_MS = 30_000;
const STALL_WARN_MS = 120_000;

/** Debounce for the roster refresh triggered by `_x.ai/sessions/changed`. */
const ROSTER_REFRESH_DEBOUNCE_MS = 400;

/** Periodic roster re-read (WP8). `_x.ai/sessions/changed` only ever fires for
    THIS process's own lifecycle — every emission site is session_lifecycle.rs,
    and a foreign `grok -p` session produced no event here in 150s of watching
    (measured on 1.0.0, 2026-08-08). Without a poll, a session started in a
    terminal would reach the rail only on our own next turn or a page reload.
    One quiet re-read on an interval: the same sessions/list the debounce
    reads, broadcast to every channel — and only when the roster actually
    changed, so an idle page is not repainted every interval. */
const ROSTER_POLL_MS = 30_000;

// ── respawn policy ──────────────────────────────────────────────────────
//
// A child that dies is respawned and its sessions reloaded. A child that dies
// immediately, repeatedly, is a broken install or a bad config, and respawning
// it in a tight loop turns one clear failure into an unreadable flood. So: a
// child that lived longer than RESPAWN_MIN_UPTIME_MS resets the counter, and
// MAX_FAST_DEATHS consecutive quick deaths stop us trying and say why.
const RESPAWN_MIN_UPTIME_MS = 15_000;
const MAX_FAST_DEATHS = 3;

// ── state ───────────────────────────────────────────────────────────────

export interface TurnState {
  startedAt: number;
  /** Cleared when the turn ends, whatever ends it. */
  watchdog: NodeJS.Timeout;
}

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  /** How this app got hold of it: created here, or loaded from disk. */
  acquired: "new" | "load";
  createdAt: number;
  /**
   * The session's title, as last read back — from the roster (`sessions/list`)
   * or, after a rename, from the roster re-read that verified it. null until a
   * title has been read back for a held session; the rail still reads titles
   * from the machine-wide roster, so this is the local landing spot rename needs
   * so a just-renamed held session shows its new name before the next poll.
   * Operator or agent text either way, so it reaches the DOM as text only (D31).
   */
  title: string | null;
  /**
   * True while the agent process we are talking to hosts this session. Goes
   * false the moment the child dies, and only goes true again if a reload
   * actually succeeded — never on the strength of having attempted one.
   */
  live: boolean;
  /**
   * The agent's own model list for this session, verbatim from `session/new`.
   * Carries `reasoningEfforts` with the agent's own labels and which one is the
   * default, so nothing about models or effort levels is hardcoded anywhere.
   */
  models: unknown;
  /**
   * The last mode id the agent CONFIRMED, by emitting `current_mode_update`.
   * null means no mode change has ever been confirmed on this session — which
   * is the normal state, because that event fires only on plan enter and exit.
   *
   * Read this and nothing else for mode state. The response to `set_mode` is
   * an empty success for every string, so it cannot be the source.
   */
  confirmedModeId: string | null;
  /** The last mode change we asked for, and whether the agent ever confirmed it. */
  modeRequest: { modeId: string; at: number; confirmed: boolean } | null;
  /** Read back from `sessions/list`, never from the `set_model` response. */
  modelId: string | null;
  reasoningEffort: string | null;
  /** Non-null while a turn is in flight. One turn per session. */
  turn: TurnState | null;
  /**
   * The cwd resolved canonically (symlinks out), computed lazily by
   * canonCwd and cached here. undefined until first use; falls back to the
   * string form when the folder is gone or unreadable.
   */
  cwdReal?: string;
  /** WP12: the causes the git cross-check has louded for, once each (a Set — alternating causes must not defeat the latch). */
  crossCheckLouded?: Set<string>;
  /**
   * WP11 (review round 2, Codex 1): bumped synchronously in startTurn. The
   * changes actions capture it at entry and re-check it immediately before
   * their wire send — a turn that starts (even one that starts AND finishes)
   * during the pre-read round-trips moves the epoch and the action refuses
   * before writing.
   */
  turnEpoch: number;
  /**
   * WP11 (B1): the promptIndexes this tracker lifetime has actually reported,
   * learned from the agent's own stamp on the echoed user message
   * (`user_message_chunk`'s `_meta.promptIndex`, CONFIRMED on 1.0.0 in the
   * wp11-probe notification census — every prompt, including no-change ones).
   * turnAction refuses any index absent from this set, so a turn-undo can
   * never be aimed by ordinal arithmetic.
   *
   * Respawn semantics, MEASURED on 1.0.0 (delta run, artifact 21): tracker
   * numbering CONTINUES across a respawn (the first post-respawn turn was
   * stamped 3, not 0), and what actually refuses a stale index is the
   * get-summary pending-hunks match — not this set. The set is still cleared
   * on agent death (onAgentGone) and replayed echoes are still never seeded
   * in: at the moment of death this build cannot verify the next process's
   * numbering, and a future grok build could restart it per process, in which
   * case a historical index would name a different turn. Fail-closed by
   * design; the measured continuation just means the guard rarely has to
   * bite.
   */
  seenPromptIndexes: Set<number>;
  /**
   * WP11 (Codex 1): hunks confirmed accepted via fileAction, per promptIndex,
   * in this process lifetime — so a turn-undo after a partial accept can say
   * exactly how much of the turn was already reviewed instead of claiming
   * "everything" was undone.
   */
  acceptedByTurn: Map<number, number>;
  /**
   * WP12 F2 (Codex B1/B2, reconciled): set when the agent died with a turn in
   * flight on this session — the recovered session's tracker may be wedged
   * (evidence wp12 F2: empty readings over a dirty tree while a fresh session
   * on the same process tracks fine). Cleared ONLY by a positively non-empty
   * get-files reading in changes(): accepting a file requires seeing it
   * listed first, and a healthy human edit surfaces as a non-empty reading,
   * so neither false-positives the flag away — and an always-clean suspect
   * session keeps it harmlessly (the cross-check says clean and the ordinary
   * sentence stands).
   */
  trackerSuspect: boolean;
  /**
   * WP12 (Codex I3): this session's outcome of the LATEST respawn-reload,
   * keyed by the agent generation it happened in, so a reconstructed page can
   * re-derive the durable marker exactly once and an older lifetime's outcome
   * never re-stamps. null when no respawn has reloaded this session.
   */
  recovery: { generation: number; ok: boolean; error: string | null } | null;
  /**
   * The latest command catalogue, rebuilt from every `commands.updated` event
   * and from every explicit query. Never the first one cached: the list is
   * rebuilt upstream from the live skill list, the live tool list and whether
   * any workflow runs exist, so installing a skill changes it mid-session.
   */
  commands: {
    commands: unknown[];
    tools: unknown;
    at: number;
    source: "query" | "agent-notification";
  } | null;
  /** Orders explicit command queries against each other and live updates. */
  commandsRevision: number;
  /** Counted so "replayed" versus "live" is a measurement, not a claim. */
  replayedEvents: number;
  liveEvents: number;
  /** Non-null while a `session/load` is in flight, so a replay can be bracketed. */
  loading: {
    startedAt: number;
    reverseRequestsSeen: number;
    /** Untagged CONVERSATION events during the load. Non-zero is WP3 trap 5, live. */
    untaggedHistory: number;
    /** Untagged setup events. Normal — see IS_HISTORY. */
    untaggedSetup: number;
  } | null;
}

/**
 * Which AppEvent types are conversation history, as opposed to session setup.
 *
 * This matters for exactly one judgement: an untagged event during a
 * `session/load` is only the WP3 trap-5 failure if it is something that would
 * RENDER as if it had just happened. Measured on 0.2.114, a load of a session
 * with four turns of history produced 4 correctly-tagged replayed events and
 * five untagged ones: `_x.ai/mcp_initialized`, `_x.ai/git_head_changed`,
 * `available_commands_update` twice, and `model_changed`. Every one of those is
 * a live fact about the session coming up right now, and every one of them is
 * correctly untagged.
 *
 * So counting "untagged events during a load" and calling it a trap-5 warning
 * cries wolf on every single load. The number that means something is the count
 * of untagged HISTORY, which has been zero every time it has been measured.
 *
 * Prefix-matched on our own type names, never the wire's.
 */
function isHistory(type: string): boolean {
  return (
    type.startsWith("message.") || type.startsWith("tool.") || type.startsWith("interaction.")
  );
}

/** The question reply outcomes, tagged on `outcome`. Two are plan-mode-only. */
const QUESTION_OUTCOMES = ["accepted", "cancelled", "chat_about_this", "skip_interview"];

/**
 * The canonical permission modes (D58), from the pager's `as_canonical` (probe
 * Q3). `always-approve` ⇔ yolo (approve every tool); `auto` ⇔ the LLM-classifier
 * subset; `default`/`ask` ⇔ interactive. Only `always-approve` and its off
 * states are yolo-read-back-verifiable via `sessions/list.yolo`; `auto` has NO
 * wire read-back, so it is never presented as confirmed (WP13_RISK_REVIEW).
 */
const PERMISSION_MODES = ["default", "ask", "auto", "always-approve"];

/** A session id must be a UUID (import rejects a non-UUID before any write). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reverse request waiting on a human, and how to turn their choice into a reply. */
interface OpenInteraction {
  id: number | string;
  method: string;
  params: any;
  sessionId: string | null;
  build: (choice: string) => unknown;
  event: AppEvent;
}

export type AgentState =
  | "starting"
  | "ready"
  | "gone" // the child died and we have not got a replacement up
  | "respawning"
  | "failed"; // bring-up failed, or we have stopped trying to respawn

export type AgentFailureCause =
  | { kind: "startup_failed"; reason: string }
  | { kind: "respawn_failed"; reason: string; lostSessions: string[] }
  | {
      kind: "crash_loop";
      reason: string;
      fastDeaths: number;
      threshold: number;
      fastDeathWindowMs: number;
    };

/** What a read-back-verified control call reports. Never just "ok". */
export interface Verified<T> {
  /** The agent said yes. On this API that means very little on its own. */
  acknowledged: true;
  /** Did we manage to read the state back at all? */
  verified: boolean;
  /** Does the state we read match what we asked for? */
  matched: boolean;
  /** What we read. Present even when it does not match. */
  readBack: T;
  /** A sentence for a human, always. */
  note: string;
}

/**
 * WP11: one reading of the hunk tracker's pending state. The Ok flags are
 * false when the corresponding reply could not be READ — a read failure,
 * never a silent zero (rule 1; review round 1, Opus I1 / Codex 3). The
 * /changes route returns this shape verbatim.
 */
interface ChangesReading {
  files: any[];
  filesOk: boolean;
  summary: any;
  summaryOk: boolean;
  /**
   * Sorted ids of pending hunks the tracker does NOT attribute to the agent
   * (external / unattributed — they never appear in summary.turns, Codex
   * final-round 1). The page's reading signature needs them: two readings
   * that differ only in which external hunk a file holds must not collide.
   * null when the read failed — never a silent empty set.
   */
  externalIds: string[] | null;
  externalIdsOk: boolean;
  /**
   * WP12 F2: present only when the session is tracker-suspect AND the reading
   * is positively empty — `suspect` marks the state, `gitDirty` is the
   * git/status cross-check (true/false; null = could not be taken).
   */
  suspect?: boolean;
  gitDirty?: boolean | null;
}

export class SessionManager extends EventEmitter {
  readonly acp: AcpClient;
  readonly sessions = new Map<string, SessionRecord>();
  private readonly openInteractions = new Map<string, OpenInteraction>();

  state: AgentState = "starting";
  /** Why, when `state` is "failed". */
  failure: string | null = null;
  /** Machine-readable failure cause, preserved in `/state` across page reloads. */
  failureCause: AgentFailureCause | null = null;

  /** Verbatim `initialize` result. Model list, capabilities, agent version. */
  initializeResult: unknown = null;

  /**
   * The permission mode this app last REQUESTED for the whole connection
   * (D58/D62). Connection-wide by protocol — the yolo notification carries no
   * sessionId, so it applies to every held session — and EPHEMERAL: it lives
   * only on the agent's live handles and drops to the spawn default on respawn.
   * Reset to null there (never carried across a reload). This is the requested
   * intent for the switch's own state; the TRUTH of whether a session is
   * approve-everything is read from `sessions/list.yolo`, not from here.
   */
  permissionMode: string | null = null;

  private consecutiveFastDeaths = 0;

  /** WP12 (Opus I1): the latest modelled settings.updated payload, for the snapshot. */
  private gateState: unknown = null;

  /**
   * WP11 (round 3, Codex 3): which agent-process lifetime we are talking to.
   * Bumped in onAgentGone, BEFORE the bridge event carries it to every page.
   * The user-message echo's promptIndex stamp is only meaningful within one
   * lifetime — on 1.0.0 the numbering is measured to CONTINUE across a
   * respawn, but a page cannot verify that at bind time — so every stamp is
   * recorded with the generation it was minted in, and the page binds a stamp
   * to a turn only when the generations match. This is what survives a full
   * page reload (trackerDied, page memory, did not): the current generation
   * re-arrives in the channel_open snapshot, and replayed stamps carry their
   * minted generation inside the retained event.
   */
  private agentGeneration = 0;
  /** Sessions open when a crash loop was declared — the manual retry reloads them. */
  private failedRetrySessions: { sessionId: string; cwd: string }[] = [];
  /** Browser-facing interaction keys never repeat when ACP request ids restart. */
  private nextInteractionKey = 1;
  private childStartedAt = 0;
  private rosterRefreshTimer: NodeJS.Timeout | null = null;
  private rosterPollTimer: NodeJS.Timeout | null = null;
  /** Signature of the last roster we broadcast; identical re-reads stay silent. */
  private lastRosterSignature: string | null = null;
  private stopping = false;

  constructor(agentCwd: string, acpOptions: Omit<AcpClientOptions, "cwd"> = {}) {
    super();
    this.acp = new AcpClient({ cwd: agentCwd, ...acpOptions });

    this.acp.on("event", (ev: AcpEvent) => this.onAcpEvent(ev));
    this.acp.on("notification", (msg: any) => this.onNotification(msg));
    this.acp.on("reverseRequest", (req: ReverseRequest) => this.onReverseRequest(req));
    this.acp.on("gone", (how: any) =>
      this.onAgentGone(how).catch((err) =>
        // The death handler is the last thing that should be able to die.
        this.acp.loud(`handling the agent's exit itself failed: ${(err as Error).stack ?? err}`),
      ),
    );
    // One permanent listener from the server, plus a transient one per in-flight
    // set_mode read-back. Several sessions changing mode at once is legitimate
    // and must not print a MaxListenersExceededWarning.
    this.setMaxListeners(64);
  }

  // ── outbound ──────────────────────────────────────────────────────────

  /** Everything this manager has to say leaves by this door, as an AppEvent. */
  private out(ev: AppEvent) {
    this.emit("app", ev);
  }

  private bridge(
    type: string,
    data: Record<string, unknown>,
    note?: string,
    sessionId: string | null = null,
  ) {
    this.out(bridgeEvent(type, data, note, sessionId));
  }

  // ── inbound ───────────────────────────────────────────────────────────

  private onAcpEvent(ev: AcpEvent) {
    // The bridge narrating itself. Not attributable to one session, so it is
    // deliberately unscoped and every channel sees it.
    this.out(
      bridgeEvent("bridge.log", {
        seq: ev.seq,
        logKind: ev.kind,
        text: ev.text,
        json: ev.json,
        at: ev.t,
      }),
    );
    if (ev.kind === "error") console.error(`[acp:error] ${ev.text}`);
    else if (ev.kind === "stderr") console.error(`[grok:stderr] ${ev.text}`);
    else if (ev.kind === "info" || ev.kind === "exit") console.log(`[acp] ${ev.text}`);
  }

  private onNotification(msg: any) {
    const ev = notificationToAppEvent(msg.method, msg.params);

    // Per-session bookkeeping, driven off OUR event names — never the wire's.
    const rec = ev.sessionId ? this.sessions.get(ev.sessionId) : undefined;
    if (rec) {
      if (ev.replay) rec.replayedEvents++;
      else rec.liveEvents++;
      // Bracket the load so trap 5 is a measurement rather than an assertion.
      if (rec.loading && !ev.replay) {
        if (isHistory(ev.type)) rec.loading.untaggedHistory++;
        else rec.loading.untaggedSetup++;
      }
    }

    if (rec && ev.type === "mode.changed") this.absorbModeChange(rec, ev);
    if (rec && ev.type === "commands.updated") this.absorbCommands(rec, ev);
    // `session.titled` is what a rename pushes (SessionSummaryGenerated), the
    // same event an agent-generated title uses — so a held record's title stays
    // current whether the human renamed it or the agent named it. Advisory-only
    // `session.info_updated` carries a title too but must NOT retitle (it echoes
    // the prior title after it; PROJECT-STATE 0.2.117 rows), so only session.titled.
    if (rec && ev.type === "session.titled") {
      const t = ev.data?.title;
      if (typeof t === "string" && t.trim() !== "") rec.title = t;
    }
    if (ev.type === "sessions.changed") this.scheduleRosterRefresh();

    /* WP12 (Opus I1): the latest gate state, held the way permissionMode is
       held, so a reloaded page reads it back from the snapshot instead of
       forgetting the gate on F5. The set/clear/leave-alone semantics are
       applied HERE (Codex round 2) and the RESOLVED state is broadcast
       (bridge.gate_state) so the page never applies a raw payload — one
       resolver, no divergence on partial/malformed updates (Codex round 3,
       Opus NEW-7). A bare allow_access:false with no gate_message cannot
       clobber a stored gate, and a modelled update with missing fields never
       touches the stored state either — its loud note already says the read
       was incomplete. The account gate is account-level, so this survives a
       respawn; a fresh server re-learns it on the next settings/update. */
    if (ev.type === "settings.updated" && ev.modelled === true) {
      if (ev.missing && ev.missing.length) {
        /* incomplete read — leave the stored state alone, tell no one */
      } else if (ev.data.allowAccess === true) {
        if (this.gateState !== null) {
          this.gateState = null;
          this.bridge("bridge.gate_state", { gate: null });
        }
      } else if (typeof ev.data.gateMessage === "string" && ev.data.gateMessage !== "") {
        /* Broadcast on CHANGE only (Codex final M1 / Opus M2): the settings
           update re-asserts on a timer upstream, and every rebroadcast makes
           the page rebuild the banner — a rebuild drops DOM focus mid-
           confirm. An identical re-assert changes nothing and tells no one. */
        const same = this.gateState !== null &&
          JSON.stringify(this.gateState) === JSON.stringify(ev.data);
        if (!same) {
          this.gateState = ev.data;
          this.bridge("bridge.gate_state", { gate: this.gateState });
        }
      }
      /* anything else — bare false included — leaves the stored state alone */
    }

    /* WP11 (B1): the tracker stamps the agent's echo of the user's own message
       with the prompt's real promptIndex (`_meta.promptIndex` on
       user_message_chunk — CONFIRMED on 1.0.0, wp11-probe census). Record it
       per session so turnAction can refuse an index this tracker lifetime
       never reported. REPLAYED echoes are excluded on purpose: on 1.0.0 the
       numbering is measured to CONTINUE across a respawn (delta artifact 21),
       but that cannot be verified at the moment a replay arrives, and a
       future build that restarts numbering per process would let a replayed
       index name a different turn. */
    if (rec && !ev.replay && msg.method === "session/update" &&
        msg.params?.update?.sessionUpdate === "user_message_chunk") {
      const pi = msg.params?.update?._meta?.promptIndex;
      if (Number.isInteger(pi)) rec.seenPromptIndexes.add(pi);
      /* Round 3 (Codex 3): the stamp also carries the agent-process generation
         it was minted in. The journal retains it with the event, so a page
         reload can tell a pre-death stamp from a post-respawn one — the
         generation survives where page memory (trackerDied) could not. Only
         LIVE events are stamped: a replayed echo's true generation is
         unknowable here, and unstamped never binds (fail closed). */
      if (ev.data) (ev.data as any).agentGen = this.agentGeneration;
    }

    // An update for a session we have never heard of. Not dropped, and not
    // silently attributed to anything: with several sessions live, guessing
    // would be the leak this package has to prove does not happen.
    if (ev.sessionId && !rec) {
      this.bridge(
        "bridge.unrouted_event",
        { sessionId: ev.sessionId, type: ev.type, wireKind: ev.wireKind },
        `An event arrived for session ${ev.sessionId}, which this app does not have in its ` +
          `session map. It is not being attributed to any other session. It goes out unscoped ` +
          `so it cannot vanish, but no per-session channel will treat it as its own.`,
      );
    }

    this.out(ev);
  }

  /**
   * The ONLY place a session's mode state is written.
   *
   * And note what confirmation does and does not prove. `current_mode_update`
   * fires on plan enter and on plan exit, and on exit it echoes back whatever id
   * you sent — including one that does not exist. So an event means "plan mode
   * was entered or left", and the id in it is the id we asked for, not proof
   * that the agent understood it as a mode. Recorded that way.
   */
  private absorbModeChange(rec: SessionRecord, ev: AppEvent) {
    const modeId = ev.data?.modeId;
    if (typeof modeId !== "string") return;
    rec.confirmedModeId = modeId;
    if (rec.modeRequest && rec.modeRequest.modeId === modeId) {
      rec.modeRequest.confirmed = true;
    }
  }

  /**
   * Rebuild from the latest event. Never cache the first, never assume a stable
   * count — and never let a malformed one become an empty catalogue.
   *
   * A valid empty array IS a genuine empty catalogue and replaces the record.
    * A payload with no readable command array is UNREADABLE, which is a different fact:
   * this code used to coerce it to `[]` and hand the launcher a confident "this
   * agent has no commands", which is the one thing we did not read. So a
   * malformed update keeps the last good list, says so loudly, and says so on
   * the stream where the operator can see it (WP7 §2).
   */
  private absorbCommands(rec: SessionRecord, ev: AppEvent) {
    const commands = ev.data?.commands;
    if (!Array.isArray(commands) || !commands.every((command: any) =>
      command && typeof command === "object" &&
      typeof command.name === "string" && command.name.trim() !== "")) {
      const kept = rec.commands ? rec.commands.commands.length : null;
      const note =
        `an available_commands_update for ${rec.sessionId} carried no readable command array with non-empty names, so nothing ` +
        `was absorbed. ` +
        (kept === null
          ? `There is no earlier good catalogue for this session, so the command list is ` +
            `UNREADABLE — which is not the same statement as "this agent has no commands".`
          : `The last good catalogue (${kept} command(s)) is kept exactly as it was.`);
      this.acp.loud(note, ev.data ?? null);
      this.bridge(
        "bridge.commands_unreadable",
        {
          sessionId: rec.sessionId,
          source: "agent-notification",
          keptCount: kept,
          payload: ev.data ?? null,
        },
        note,
        rec.sessionId,
      );
      return;
    }
    rec.commandsRevision++;
    rec.commands = {
      commands,
      tools: ev.data?.toolNames ?? null,
      at: Date.now(),
      source: "agent-notification",
    };
  }

  private onReverseRequest(req: ReverseRequest) {
    const key = `interaction-${this.nextInteractionKey++}`;
    const bare = req.method.startsWith("_") ? req.method.slice(1) : req.method;
    const sessionId =
      typeof req.params?.sessionId === "string" ? req.params.sessionId : null;

    // A reverse request during a replay would be the WP3 trap-5 failure showing
    // up in the one place the replay flag cannot help: reverse requests carry no
    // `isReplay`. It has never been observed — a load replays notifications, not
    // requests — so if it happens, say so rather than discovering it as a
    // mystery card on screen. It is still answered; a refusal that hangs the
    // agent would be a worse bug than the one we are watching for.
    const rec = sessionId ? this.sessions.get(sessionId) : undefined;
    if (rec?.loading) {
      rec.loading.reverseRequestsSeen++;
      this.acp.loud(
        `the agent sent a reverse request ('${req.method}') for session ${sessionId} while a ` +
          `session/load replay was still running. Reverse requests carry no isReplay flag, so ` +
          `this cannot be filtered by the replay tag — it is being answered normally and ` +
          `counted. If a card appeared on screen for something that happened last week, this ` +
          `is why.`,
      );
    }

    if (
      (bare === "x.ai/exit_plan_mode" ||
        bare === "session/request_permission" ||
        bare === "x.ai/ask_user_question") &&
      (sessionId === null || sessionId.trim() === "" || !rec || (!rec.live && !rec.loading))
    ) {
      const reason = sessionId === null || sessionId.trim() === ""
        ? "params.sessionId was missing"
        : `session '${sessionId}' is not live or loading in this app`;
      const message = `client cannot present '${req.method}': ${reason}`;
      this.acp.respondError(req.id, -32602, message, { received: req.params });
      const refused = reverseRequestToAppEvent(key, req.method, req.params, {
        refusedWith: -32602,
      });
      refused.note = `${message}. The request was refused so the agent is not left waiting.`;
      this.out(refused);
      return;
    }

    if (bare === "x.ai/exit_plan_mode") {
      // No `options` array on this request. The three strings below are the
      // protocol's own outcome values, not labels we invented, and anything
      // unrecognised fails closed to staying in plan mode.
      const options = [
        { optionId: "approved", name: "approved", kind: "protocol-outcome" },
        { optionId: "cancelled", name: "cancelled", kind: "protocol-outcome" },
        { optionId: "abandoned", name: "abandoned", kind: "protocol-outcome" },
      ];
      const event = reverseRequestToAppEvent(key, req.method, req.params, {
        options,
        note: "Plan-mode exit. These are the protocol's outcome values, not invented labels.",
      });
      this.openInteractions.set(key, {
        id: req.id,
        method: req.method,
        params: req.params,
        sessionId,
        // FLAT. The payload IS the JSON-RPC result: {"outcome":"approved"}.
        // Wrapping it as {result:{outcome:…}} does not error and does not hang:
        // the shell fails closed to "cancelled", so the human clicks Approve,
        // the turn continues, and the agent is told they wanted changes. Caught
        // on the wire, never by an error. See PROJECT-STATE §5.
        build: (choice) => ({ outcome: choice }),
        event,
      });
      this.acp.note(`agent asked to exit plan mode on ${sessionId} — waiting for the human`);
      this.out(event);
      return;
    }

    if (bare === "session/request_permission") {
      const options = Array.isArray(req.params?.options) ? req.params.options : [];
      if (options.length === 0) {
        // We render the agent's options and only the agent's options. With none
        // to render there is nothing a human could click, so fail loudly rather
        // than inventing a button or auto-approving — and say so on the stream,
        // like every other refusal path. This used to be the one refusal that
        // left no modelled event behind.
        const message =
          "client cannot present this permission request: params.options was empty";
        this.acp.respondError(req.id, -32602, message, { received: req.params });
        const refused = reverseRequestToAppEvent(key, req.method, req.params, {
          refusedWith: -32602,
        });
        refused.note = `${message}. The request was refused so the agent is not left waiting.`;
        this.out(refused);
        return;
      }
      const event = reverseRequestToAppEvent(key, req.method, req.params);
      this.openInteractions.set(key, {
        id: req.id,
        method: req.method,
        params: req.params,
        sessionId,
        build: (choice) => ({ outcome: { outcome: "selected", optionId: choice } }),
        event,
      });
      this.acp.note(
        `permission requested on ${sessionId} — ${options.length} option(s) from the agent; waiting for the human`,
      );
      this.out(event);
      return;
    }

    if (bare === "x.ai/ask_user_question") {
      const questions = Array.isArray(req.params?.questions) ? req.params.questions : [];
      // Answers go back keyed by question text, so a request we cannot answer
      // unambiguously is refused loudly up front — same "never invent an
      // answer" rule as the empty permission options above.
      const texts = questions.map((q: any) => String(q?.question ?? ""));
      const problem =
        questions.length === 0
          ? "params.questions was empty"
          : questions.some((q: any) => !Array.isArray(q?.options) || q.options.length === 0)
            ? "a question offered no options"
            : new Set(texts).size !== texts.length
              ? "two questions share the same text, and answers are keyed by question text — a reply would be ambiguous"
              : null;
      if (problem) {
        const message = `client cannot present this question: ${problem}`;
        this.acp.respondError(req.id, -32602, message, { received: req.params });
        const refused = reverseRequestToAppEvent(key, req.method, req.params, {
          refusedWith: -32602,
        });
        refused.note = `${message}. The request was refused so the agent is not left waiting.`;
        this.out(refused);
        return;
      }
      const event = reverseRequestToAppEvent(key, req.method, req.params);
      this.openInteractions.set(key, {
        id: req.id,
        method: req.method,
        params: req.params,
        sessionId,
        // Flat, like the plan exit. "accepted" additionally carries the answers
        // map; answerInteraction's question branch attaches it after validating
        // every value against the labels the agent actually offered.
        build: (outcome) => ({ outcome }),
        event,
      });
      this.acp.note(
        `agent asked ${questions.length} question(s) on ${sessionId} — waiting for the human`,
      );
      this.out(event);
      return;
    }

    // Anything else: refuse explicitly. The agent is unblocked and the method
    // name is on screen. Silence here is the hang we are avoiding.
    const refused = reverseRequestToAppEvent(key, req.method, req.params, {
      refusedWith: -32601,
    });
    this.acp.respondError(
      req.id,
      -32601,
      `this client does not implement the reverse request '${req.method}'`,
      { params: req.params },
    );
    refused.note =
      `This build refused '${req.method}' so the agent is not left waiting. The agent is ` +
      `unblocked, but whatever it wanted from the human is not being asked properly — ` +
      `if it was a question, expect it to reappear as plain text and the turn to end.`;
    this.out(refused);
  }

  // ── the child dying, and coming back ──────────────────────────────────

  private async onAgentGone(how: any) {
    const uptime = Date.now() - this.childStartedAt;
    const wasOpen = [...this.sessions.values()].filter((s) => s.live);

    /* WP11 round 3: the tracker lifetime is over — bump the generation BEFORE
       the bridge event below carries it to every page, so no stamp minted
       from here on can be confused with one from before the death. */
    this.agentGeneration++;
    /* Round-3 hygiene (Opus N4 / Grok C3-M3): drop the action queues too.
       In-flight actions settle on their own (ACP timeouts); the map entries
       are tails of settled chains and must not accumulate per dead lifetime. */
    this.changeActionChains.clear();

    for (const rec of this.sessions.values()) {
      rec.live = false;
      if (rec.turn) {
        /* WP12 F2: a turn in flight at death leaves the recovered session's
           tracker SUSPECT — the recovered session can report empty over a
           dirty tree (evidence wp12 F2). Cleared only by a non-empty reading
           (see changes()). */
        rec.trackerSuspect = true;
        clearInterval(rec.turn.watchdog);
        rec.turn = null;
      }
      rec.loading = null;
      /* WP11 (delta finding 1): the tracker lived in the dead process, so the
         set of promptIndexes it reported dies with it. Measured on 1.0.0
         (delta artifact 21): numbering CONTINUES across a respawn — the first
         post-respawn turn was stamped 3, not 0 — so these indexes would very
         likely stay valid, and the summary-pending-hunks match is the guard
         that actually bites on a stale aim. The set is cleared anyway: at the
         moment of death this build cannot verify the NEXT process's numbering
         (a future build could restart it per process), and "only indexes this
         process lifetime reported" is the claim the set makes. Live echoes
         after the respawn re-seed it. acceptedByTurn is cleared too (Opus
         F5): under that same unverifiable boundary its counts could attach a
         "you had already marked as reviewed" sentence to a DIFFERENT turn —
         wrong words produced by the honesty machinery. */
      rec.seenPromptIndexes.clear();
      rec.acceptedByTurn.clear();
    }

    if (this.openInteractions.size > 0) {
      const reason = "The agent process exited before this interaction could be answered.";
      this.acp.loud(
        `${this.openInteractions.size} interaction(s) were still waiting on a human when the ` +
          `agent exited — they can no longer be answered`,
      );
      for (const [key, open] of this.openInteractions) {
        this.bridge(
          "interaction.abandoned",
          {
            key,
            sessionId: open.sessionId,
            method: open.method,
            interactionType: open.event.type,
            reason,
          },
          reason,
          open.sessionId,
        );
      }
      this.openInteractions.clear();
    }

    /* A terminal failure verdict is never overwritten by the corpse of the
       process that produced it: a spawn failure rejects initialize AND reaps
       the child, and without this pin the page would watch "could not start —
       here is the command" flicker into the generic "gone" banner (WP10 audit
       found the overwrite path). Pinned for ANY settled failure — startup or
       crash loop alike (Grok WP10 review H4). The session/interaction cleanup
       above has already run; what follows is the gone banner and the respawn
       logic, which is exactly what must not fire. The pin sits before the
       "gone" assignment so the state never even transiently reads gone. */
    if (this.failureCause !== null) {
      this.state = "failed";
      return;
    }
    this.state = "gone";
    this.bridge(
      "bridge.agent_gone",
      {
        how,
        uptimeMs: uptime,
        sessionsThatWereOpen: wasOpen.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd })),
        /* WP11 round 3: the NEW generation, already bumped. Pages move their
           binding authority to it immediately; stamps minted before the death
           no longer match. */
        agentGeneration: this.agentGeneration,
      },
      `The grok child process exited after ${Math.round(uptime / 1000)}s. ` +
        (wasOpen.length === 0
          ? "No sessions were open."
          : `${wasOpen.length} session(s) were open and every turn on them has been abandoned.`),
    );

    if (this.stopping) return;

    // Crash-loop guard. A child that lived a while is an accident; a child that
    // dies instantly, three times running, is a broken install and respawning it
    // again only buries the message.
    if (uptime < RESPAWN_MIN_UPTIME_MS) this.consecutiveFastDeaths++;
    else this.consecutiveFastDeaths = 0;

    if (this.consecutiveFastDeaths >= MAX_FAST_DEATHS) {
      this.state = "failed";
      this.failure =
        `the agent process has died within ${RESPAWN_MIN_UPTIME_MS / 1000}s of starting, ` +
        `${this.consecutiveFastDeaths} times in a row`;
      this.failureCause = {
        kind: "crash_loop",
        reason: this.failure,
        fastDeaths: this.consecutiveFastDeaths,
        threshold: MAX_FAST_DEATHS,
        fastDeathWindowMs: RESPAWN_MIN_UPTIME_MS,
      };
      /* The manual retry (WP10) reloads exactly these, the way the automatic
         respawn would have. */
      this.failedRetrySessions = wasOpen.map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
      this.acp.loud(
        `NOT respawning: ${this.failure}. This is a broken agent, not a transient crash — ` +
          `respawning again would flood the log instead of telling you that. Fix the agent ` +
          `and restart the server.`,
      );
      this.bridge(
        "bridge.respawn_abandoned",
        { fastDeaths: this.consecutiveFastDeaths, cause: this.failureCause },
        this.failure,
      );
      return;
    }

    await this.respawnAndReload(wasOpen);
  }

  /**
   * Bring a replacement child up and put the open sessions back into it.
   *
   * Every step can fail independently and each failure is reported on its own,
   * because "the agent came back but three of your five sessions did not" is a
   * different fact from "the agent did not come back".
   */
  private async respawnAndReload(wasOpen: SessionRecord[]) {
    this.state = "respawning";
    this.bridge(
      "bridge.respawning",
      { sessions: wasOpen.map((s) => s.sessionId) },
      `Respawning the agent and trying to reload ${wasOpen.length} session(s).`,
    );

    /* Codex WP12 final I1: capture the generation BEFORE any await. A
       replacement child that dies again mid-recovery bumps agentGeneration
       in onAgentGone, and a stamp read off the mutable field afterwards
       would attribute this lifetime's outcomes to the next one. Every stamp
       and the bridge.respawned payload below use this captured value.
       CONFIRM3: the death marker is captured alongside — the generation bump
       is DEFERRED behind acp cleanup, so a rejected await can resume with
       agentGeneration unmoved; deathSeq is the only boundary visible in that
       window, and every publish point below checks it. */
    const generation = this.agentGeneration;
    const deathSeq = this.acp.deathSeq;

    try {
      this.acp.restart();
      this.childStartedAt = Date.now();
      await this.initialize();
    } catch (err) {
      const message = (err as Error).message;
      this.state = "failed";
      this.failure = `respawn failed: ${message}`;
      this.failureCause = {
        kind: "respawn_failed",
        reason: message,
        lostSessions: wasOpen.map((s) => s.sessionId),
      };
      this.acp.loud(
        `COULD NOT RESPAWN THE AGENT: ${message}. The sessions that were open are gone with ` +
          `it and this server cannot recover them: ` +
          (wasOpen.map((s) => s.sessionId).join(", ") || "(none were open)"),
      );
      this.bridge(
        "bridge.respawn_failed",
        {
          error: message,
          lostSessions: wasOpen.map((s) => s.sessionId),
          cause: this.failureCause,
        },
        this.failure,
      );
      return;
    }

    this.state = "ready";
    this.failure = null;
    this.failureCause = null;
    this.startRosterPoll();
    // Auto-approve is EPHEMERAL (WP13_RISK_REVIEW): it lived only on the dead
    // child's handles, and the replacement's sessions come up at the spawn
    // default (interactive). Reset the requested mode so the switch cannot show
    // a pre-crash "on" that no longer holds; the client re-reads sessions/list.yolo.
    this.permissionMode = null;
    const reloaded: string[] = [];
    const failed: { sessionId: string; error: string }[] = [];

    for (const rec of wasOpen) {
      /* Codex WP12 CONFIRM2/CONFIRM3: the ACP exit handler rejects pending
         requests SYNCHRONOUSLY and the `gone` emission (which bumps the
         generation) is deferred — so the check is the death marker, not the
         generation. A moved marker means this recovery belongs to a dead
         lifetime: the new gone/respawn cycle owns every session's narration
         from here, and this loop publishes nothing. */
      if (this.agentGeneration !== generation || this.acp.deathSeq !== deathSeq) return;
      try {
        await this.loadSession(rec.sessionId, rec.cwd, deathSeq);
        reloaded.push(rec.sessionId);
        /* The marker did not move during a SUCCESSFUL load (the child
           answered), so this stamp needs no re-check. */
        rec.recovery = { generation, ok: true, error: null };
      } catch (err) {
        if (this.acp.deathSeq !== deathSeq) return; // dead lifetime: publish nothing
        const message = (err as Error).message;
        failed.push({ sessionId: rec.sessionId, error: message });
        rec.recovery = { generation, ok: false, error: message };
      }
    }

    /* Same guard before narrating: a death in the last iteration's await
       must not reach the aggregate line or the event. */
    if (this.agentGeneration !== generation || this.acp.deathSeq !== deathSeq) return;

    if (failed.length > 0) {
      this.acp.loud(
        `the agent is back but ${failed.length} of ${wasOpen.length} session(s) could NOT be ` +
          `reloaded:\n` +
          failed.map((f) => `    ${f.sessionId}: ${f.error}`).join("\n"),
      );
    }
    this.bridge(
      "bridge.respawned",
      { reloaded, failed, restarts: this.acp.restarts,
        /* WP12 (Opus NEW-4 + Codex final I1): the generation these outcomes
           belong to, captured before the reload loop's awaits — a
           replacement child that dies again DURING the loop bumps the
           generation in onAgentGone, and carrying the captured value means
           the page never stamps a dead lifetime's outcome as the live one. */
        agentGeneration: generation },
      failed.length === 0
        ? `The agent process was respawned and ${reloaded.length} session(s) were reloaded from disk.`
        : `The agent process was respawned and ${reloaded.length} session(s) came back, but ` +
          `${failed.length} could NOT be reloaded: ` +
          failed.map((f) => `${f.sessionId} (${f.error})`).join("; "),
    );
  }

  // ── bring-up ──────────────────────────────────────────────────────────

  /**
   * Client capabilities. The extension flags live under `_meta` — WITH the
   * leading underscore. The Rust builder calls the field `.meta()` but the wire
   * format serializes it as `_meta`; writing `meta` here produces a field the
   * agent never reads and never complains about.
   */
  private buildInitializeParams() {
    return {
      protocolVersion: 1,
      clientCapabilities: {
        // We are not a filesystem or a terminal for the agent. It uses its own
        // tools, which is what puts files on disk.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: {
          "x.ai/bashOutputNoColor": true,
          // ── CONNECT-TIME AND ONLY CONNECT-TIME ──────────────────────────
          //
          // These two cannot be turned on later. The agent reads them once, out
          // of `initialize`, and wires the session accordingly — so a session
          // that connected without them is permanently deaf with no error
          // anywhere to say so. That includes a session created after a
          // respawn: this is why `initialize` is re-sent on every restart
          // rather than assumed to have carried over.
          //
          // Measured both ways on 0.2.114, same prompt, same workspace:
          //   undeclared -> {"files":[]}, filesModified 0, pendingHunks 0
          //   declared   -> 2 files, 4 hunks, +36/-5, with before/after text
          "x.ai/hunkTracker": { mode: "all_dirty" },
          "x.ai/gitHeadChanged": true,
        },
      },
      _meta: {
        clientType: "graphometer",
        clientVersion: "0.0.1-bridge",
      },
    };
  }

  /**
   * Prove on the serialized bytes that the underscore is there and that both
   * connect-time capabilities are in what we are about to send.
   *
   * This exists because the failure it guards is invisible: the agent accepts an
   * `initialize` with no hunkTracker declaration exactly as happily as one with
   * it, and the difference only shows up later as a tracker that successfully
   * reports nothing. These bytes are the last moment we can tell.
   */
  private assertMetaOnWire(params: ReturnType<typeof this.buildInitializeParams>): boolean {
    const caps = params.clientCapabilities as Record<string, unknown>;
    const hasUnderscore = Object.hasOwn(caps, "_meta");
    const hasBare = Object.hasOwn(caps, "meta");
    const serialized = JSON.stringify(params);
    const inSerialized = serialized.includes('"_meta"');

    const metaOk = hasUnderscore && !hasBare && inSerialized;
    const line =
      `_meta check [${metaOk ? "PASS" : "FAIL"}] — clientCapabilities._meta present: ${hasUnderscore}; ` +
      `bare 'meta' present: ${hasBare}; '"_meta"' in serialized bytes: ${inSerialized}`;
    if (metaOk) this.acp.note(line);
    else this.acp.loud(line);

    const meta = (caps._meta ?? {}) as Record<string, any>;
    const hunkMode = meta["x.ai/hunkTracker"]?.mode;
    const gitHead = meta["x.ai/gitHeadChanged"];
    const bothNamed =
      serialized.includes('"x.ai/hunkTracker"') && serialized.includes('"x.ai/gitHeadChanged"');
    const capsOk =
      typeof hunkMode === "string" && hunkMode.length > 0 && gitHead === true && bothNamed;
    const capsLine =
      `connect-time capability check [${capsOk ? "PASS" : "FAIL"}] — ` +
      `hunkTracker.mode: ${JSON.stringify(hunkMode)}; gitHeadChanged: ${JSON.stringify(gitHead)}; ` +
      `both names in the serialized bytes: ${bothNamed}. These cannot be added after this ` +
      `call — a session that connects without them tracks nothing, successfully, forever.`;
    if (capsOk) this.acp.note(capsLine);
    else this.acp.loud(capsLine);

    return metaOk && capsOk;
  }

  private async initialize() {
    const params = this.buildInitializeParams();
    this.assertMetaOnWire(params);
    const result = await this.acp.request(M.initialize, params, CONTROL_TIMEOUT_MS);
    this.initializeResult = result;
    this.acp.note("initialize returned", result);
    this.bridge("bridge.initialized", { result });
  }

  /** Spawn the agent and initialize it. Creates no session — that is on demand now. */
  async start(): Promise<void> {
    this.acp.start();
    this.childStartedAt = Date.now();
    try {
      await this.initialize();
      this.state = "ready";
      this.failure = null;
      this.failureCause = null;
      this.startRosterPoll();
      this.bridge(
        "bridge.agent_ready",
        { pid: this.acp.pid, cwd: this.acp.cwd },
        `The agent process is up (pid ${this.acp.pid}). No session exists yet — create one ` +
          `with a working directory, or load one from disk.`,
      );
    } catch (err) {
      this.state = "failed";
      this.failure = (err as Error).message;
      this.failureCause = { kind: "startup_failed", reason: this.failure };
      throw err;
    }
  }

  /**
   * WP10: the failure screen's "Try again". A failed start leaves the dead (or
   * wedged) child generation attached, so a plain `start()` refuses with
   * "already started" — and a wedged-but-alive child (an initialize that timed
   * out) makes `restart()` refuse too. So: verified cleanup of the old
   * generation (no shutdown latch), then the respawn door.
   *
   * Sessions: a STARTUP failure never created any, so there is nothing to
   * reload. A CRASH LOOP is different — sessions were open when the agent
   * died, and the automatic respawn would have reloaded them, so the manual
   * retry does the same (Opus WP10 final-confirmation note), with per-session
   * failure sentences, never a silent loss. A failure lands back in the same
   * honest screen with the new reason.
   */
  async retryStart(): Promise<void> {
    if (this.state !== "failed") {
      throw new Error("the agent is not in a failed state — nothing to retry");
    }
    this.bridge("bridge.respawning", { sessions: [] }, "Trying the agent bring-up again on request.");
    try {
      /* Verify the old generation gone before the respawn door — stopForRetry
         signals a live-but-wedged child and marks a spawn-failed one, without
         latching the client shut (Opus WP10 confirmation M3, found live). */
      await this.acp.stopForRetry();
      this.acp.restart();
      this.childStartedAt = Date.now();
      await this.initialize();
    } catch (err) {
      const message = (err as Error).message;
      this.state = "failed";
      this.failure = message;
      this.failureCause = { kind: "startup_failed", reason: message };
      this.bridge("bridge.respawn_failed",
        { error: message, lostSessions: [], cause: this.failureCause },
        `the retry failed: ${message}`);
      throw err;
    }
    this.state = "ready";
    this.failure = null;
    this.failureCause = null;
    this.startRosterPoll();
    /* Auto-approve lived on the dead child's handles; the replacement comes up
       at the spawn default. Same rule as the automatic respawn. */
    this.permissionMode = null;
    this.bridge(
      "bridge.agent_ready",
      { pid: this.acp.pid, cwd: this.acp.cwd },
      `The agent process is up after the manual retry (pid ${this.acp.pid}).`,
    );

    /* The crash-loop case: put back the sessions that were open when the
       agent died, exactly as the automatic respawn would have. The generation
       AND the death marker are captured BEFORE the loop's awaits (Opus
       CONFIRM2 M1 / Grok R1; Codex CONFIRM3 — the generation bump is
       deferred behind acp cleanup, so the marker is the boundary that is
       visible the moment a rejected await resumes), and the loop stops when
       either moves: a child that dies mid-retry has its own gone/respawn
       cycle, which owns those sessions' narration from there. */
    const toRestore = this.failedRetrySessions;
    this.failedRetrySessions = [];
    const generation = this.agentGeneration;
    const deathSeq = this.acp.deathSeq;
    const failed: { sessionId: string; error: string }[] = [];
    for (const s of toRestore) {
      /* Codex CONFIRM4 B1: `return`, not `break` — on a lifetime mismatch
         there is nothing left to narrate, and the aggregate line below must
         never run for a dead lifetime ("the agent is back" after it died
         again). The final guard after the loop is the same shape as
         respawnAndReload's. */
      if (this.agentGeneration !== generation || this.acp.deathSeq !== deathSeq) return;
      /* WP12 round 2 (Opus M5): the manual-retry reload stamps the same
         generation-keyed recovery outcome as the automatic respawn, so its
         sessions get the same durable markers. No bridge.respawned is
         emitted here — the markers reach the page because each loadSession
         emits bridge.session_loaded, whose handler refreshes state (live),
         and the snapshot sweep re-derives from these stamps. (The
         bridge.agent_ready above fires BEFORE this loop, so its sweep sees
         only stale stamps and correctly rejects them — round-3 review.) One
         honest asymmetry, stated: this path has no aggregate "N of M
         reloaded" log line, only the per-session markers. */
      try {
        await this.loadSession(s.sessionId, s.cwd, deathSeq);
        const rec = this.sessions.get(s.sessionId);
        if (rec) rec.recovery = { generation, ok: true, error: null };
      } catch (err) {
        if (this.acp.deathSeq !== deathSeq) return; // dead lifetime: publish nothing
        const message = (err as Error).message;
        failed.push({ sessionId: s.sessionId, error: message });
        const rec = this.sessions.get(s.sessionId);
        if (rec) rec.recovery = { generation, ok: false, error: message };
      }
    }
    /* The last publish point: no aggregate from a dead lifetime. */
    if (this.agentGeneration !== generation || this.acp.deathSeq !== deathSeq) return;
    if (failed.length > 0) {
      this.acp.loud(
        `the agent is back after the retry, but ${failed.length} of ${toRestore.length} session(s) ` +
          `could NOT be reloaded:\n` +
          failed.map((f) => `    ${f.sessionId}: ${f.error}`).join("\n"),
      );
    }
  }

  // ── the ext envelope ──────────────────────────────────────────────────

  /** Unwrap an ext result by METHOD NAME, from the observed table. Never by shape. */
  private unwrapExt(method: string, raw: any): any {
    if (!method.startsWith("_")) return raw; // core ACP method, no envelope
    const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
    const hasResult = isObject && "result" in raw;

    if (!Object.hasOwn(EXT_ENVELOPE, method)) {
      this.acp.loud(
        `ext method '${method}' is not in the envelope table, so this build does not know ` +
          `whether its payload is wrapped. Passing it through unwrapped. Probe it and add it ` +
          `to EXT_ENVELOPE in studio/sessions.ts.`,
        raw,
      );
      return raw;
    }

    if (EXT_ENVELOPE[method]) {
      if (hasResult) return raw.result;
      this.acp.loud(
        `ext method '${method}' is recorded as returning a wrapped payload at result.result, ` +
          `but no 'result' envelope arrived. Either the wire changed or the table is wrong. ` +
          `Passing the payload through unwrapped rather than guessing.`,
        raw,
      );
      return raw;
    }

    if (hasResult) {
      this.acp.loud(
        `ext method '${method}' is recorded as returning a FLAT payload, but a 'result' key ` +
          `arrived. Following the recorded contract rather than a shape heuristic — a flat ` +
          `payload may legitimately have its own 'result' field. If the wire changed, fix ` +
          `EXT_ENVELOPE in studio/sessions.ts.`,
        raw,
      );
    }
    return raw;
  }

  // ── guards ────────────────────────────────────────────────────────────

  private requireReady() {
    if (this.state !== "ready" || !this.acp.alive) {
      throw new Error(
        `the agent is not ready (state: ${this.state}${this.failure ? ` — ${this.failure}` : ""})`,
      );
    }
  }

  /**
   * Refuse a session id we do not hold, locally, before it goes on the wire.
   *
   * Not defensive tidiness — this is the fix for a hang. `session/set_mode` and
   * `_x.ai/compact_conversation` with an unknown session id never answer at
   * all: upstream awaits a oneshot receiver whose sender it never dropped. See
   * the CORRECTION at the top of this file.
   */
  private require(sessionId: string): SessionRecord {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      throw new Error(
        `this app does not hold a session with id '${sessionId}'. Refused locally and NOT ` +
          `sent: several methods never answer at all for an unknown session id, so sending ` +
          `it would wedge the request rather than return an error.`,
      );
    }
    if (!rec.live) {
      throw new Error(
        `session '${sessionId}' is in the map but is not live — the agent process that held ` +
          `it exited. Load it again before using it.`,
      );
    }
    return rec;
  }

  // ── sessions ──────────────────────────────────────────────────────────

  private newRecord(sessionId: string, cwd: string, acquired: "new" | "load"): SessionRecord {
    const rec: SessionRecord = {
      sessionId,
      cwd,
      acquired,
      createdAt: Date.now(),
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
    };
    this.sessions.set(sessionId, rec);
    return rec;
  }

  /** Public snapshot of one session, safe to serialize (no timers). */
  describe(rec: SessionRecord) {
    return {
      sessionId: rec.sessionId,
      cwd: rec.cwd,
      acquired: rec.acquired,
      createdAt: rec.createdAt,
      title: rec.title,
      live: rec.live,
      models: rec.models,
      confirmedModeId: rec.confirmedModeId,
      modeRequest: rec.modeRequest,
      modelId: rec.modelId,
      reasoningEffort: rec.reasoningEffort,
      turnInFlight: rec.turn !== null,
      commandCount: rec.commands?.commands.length ?? null,
      commandsFrom: rec.commands?.source ?? null,
      replayedEvents: rec.replayedEvents,
      liveEvents: rec.liveEvents,
      loading: rec.loading !== null,
      /* WP12: the latest respawn-reload outcome, generation-keyed (Codex I3). */
      recovery: rec.recovery,
    };
  }

  snapshot() {
    return {
      state: this.state,
      failure: this.failure,
      failureCause: this.failureCause,
      pid: this.acp.pid ?? null,
      restarts: this.acp.restarts,
      agentCwd: this.acp.cwd,
      /* WP11 round 3: the agent-process generation the page binds promptIndex
         stamps against (channel_open carries this snapshot). */
      agentGeneration: this.agentGeneration,
      /* WP12 (Opus I1): the latest gate state, so a reloaded page shows it. */
      gate: this.gateState,
      /* The agent's own reported version, lifted from the initialize result
         (WP10). null until the handshake lands; never hardcoded. */
      agentVersion: (() => {
        const r: any = this.initializeResult;
        const v = r?._meta?.agentVersion;
        return typeof v === "string" && v !== "" ? v : null;
      })(),
      // The REQUESTED connection-wide permission mode (D62), for the switch's own
      // state. The client derives the honest "is any session hot" from each
      // roster row's `yolo`, never from this alone.
      permissionMode: this.permissionMode,
      sessions: [...this.sessions.values()].map((r) => this.describe(r)),
      openInteractions: [...this.openInteractions.entries()].map(([key, o]) => ({
        key,
        method: o.method,
        sessionId: o.sessionId,
      })),
    };
  }

  /** Every open interaction's event, so a browser connecting late sees the same cards. */
  openInteractionEvents(): AppEvent[] {
    return [...this.openInteractions.values()].map((o) => o.event);
  }

  async newSession(cwd: string): Promise<SessionRecord> {
    this.requireReady();
    const result = await this.acp.request(
      M.sessionNew,
      { cwd, mcpServers: [] },
      CONTROL_TIMEOUT_MS,
    );

    // Silent-success trap. Read the id back out rather than assuming the
    // acknowledgement means what we wanted it to.
    const id = result?.sessionId;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `session/new returned success but no usable sessionId: ${JSON.stringify(result)}`,
      );
    }

    const rec = this.newRecord(id, cwd, "new");
    // The agent's own model list, including its own effort ids, labels and
    // which is the default. Nothing about models or effort is hardcoded.
    rec.models = result?.models ?? null;
    rec.modelId =
      typeof result?.models?.currentModelId === "string" ? result.models.currentModelId : null;

    this.acp.note(`session created — ${id}, cwd ${cwd}`);
    this.bridge("bridge.session_opened", { session: this.describe(rec), raw: result }, undefined, id);
    return rec;
  }

  /**
   * Load a session from disk. This REPLAYS THE ENTIRE CONVERSATION as update
   * events before it returns.
   *
   * Every one of those arrives with `_meta.isReplay` set, which the boundary
   * lifts to `AppEvent.replay`, so a consumer can tell a week-old event from a
   * live one. The counts on the record are how we prove that rather than assert
   * it: `replayedEvents` should be non-zero for a session with history and
   * `liveEvents` should still be zero straight after the load.
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    /* WP12 CONFIRM3: recovery loops pass the death marker they captured, and a
       failure published only if the lifetime is still the one they started
       in. Operator-driven loads pass nothing and always narrate. */
    expectedDeathSeq?: number,
  ): Promise<SessionRecord> {
    this.requireReady();

    const existing = this.sessions.get(sessionId);
    if (existing?.live) {
      throw new Error(
        `session '${sessionId}' is already live in this app — loading it again would replay ` +
          `the whole conversation a second time on top of itself`,
      );
    }
    if (existing?.loading) {
      throw new Error(
        `session '${sessionId}' is already loading — a second load would replay the same ` +
          `conversation into the active generation twice`,
      );
    }

    const createdForLoad = existing === undefined;
    const rec = existing ?? this.newRecord(sessionId, cwd, "load");
    rec.cwd = cwd;
    rec.live = false;
    const before = { replayed: rec.replayedEvents };
    rec.loading = {
      startedAt: Date.now(),
      reverseRequestsSeen: 0,
      untaggedHistory: 0,
      untaggedSetup: 0,
    };

    this.bridge(
      "bridge.session_loading",
      { sessionId, cwd },
      `Loading ${sessionId} from disk. The agent replays the whole conversation as events; ` +
        `every replayed event is tagged so nothing renders as if it just happened.`,
      sessionId,
    );

    try {
      const result = await this.acp.request(
        M.sessionLoad,
        { sessionId, cwd, mcpServers: [] },
        LOAD_TIMEOUT_MS,
      );
      const replayedNow = rec.replayedEvents - before.replayed;
      const untaggedHistory = rec.loading?.untaggedHistory ?? 0;
      const untaggedSetup = rec.loading?.untaggedSetup ?? 0;
      const reverse = rec.loading?.reverseRequestsSeen ?? 0;
      rec.loading = null;
      rec.live = true;
      /* WP12 round 2 (Opus B1): a successful load — manual or respawn-driven —
         INVALIDATES any earlier recovery outcome. Without this, a session that
         failed the respawn reload but then loaded by hand kept {ok:false} in
         the snapshot, and the session_loaded re-derivation stamped "could NOT
         be reloaded" at the foot of a session that visibly just loaded. (The
         respawn loop stamps its own outcome AFTER this call returns, so its
         markers are unaffected.) */
      rec.recovery = null;
      rec.models = result?.models ?? rec.models;
      if (typeof result?.models?.currentModelId === "string") {
        rec.modelId = result.models.currentModelId;
      }

      const line =
        `session loaded — ${sessionId}: ${replayedNow} replayed event(s) tagged as history, ` +
        `${untaggedHistory} untagged history event(s), ${untaggedSetup} untagged setup event(s), ` +
        `${reverse} reverse request(s) during the replay`;
      if (untaggedHistory > 0) this.acp.loud(line);
      else this.acp.note(line);
      this.bridge(
        "bridge.session_loaded",
        {
          session: this.describe(rec),
          replayedDuringLoad: replayedNow,
          untaggedHistoryDuringLoad: untaggedHistory,
          untaggedSetupDuringLoad: untaggedSetup,
          reverseRequestsDuringLoad: reverse,
          raw: result,
        },
        `${sessionId} loaded: ${replayedNow} event(s) replayed and tagged as history.` +
          (untaggedHistory > 0
            ? ` ${untaggedHistory} CONVERSATION event(s) arrived during the load with NO replay ` +
              `tag — those render as if they just happened, which is WP3 trap 5 happening live ` +
              `and the tag is not enough on its own.`
            : ` No conversation event arrived untagged.`) +
          (untaggedSetup > 0
            ? ` ${untaggedSetup} untagged setup event(s) also arrived (MCP init, git HEAD, the ` +
              `command list, the model) — those are live facts about the session coming up now, ` +
              `and being untagged is correct for them.`
            : "") +
          (reverse > 0
            ? ` ${reverse} reverse request(s) came in during the replay — see the log.`
            : ""),
        sessionId,
      );
      return rec;
    } catch (err) {
      const message = (err as Error).message;
      rec.loading = null;
      rec.live = false;
      /* Codex CONFIRM4 M1: when the recovery loop's death marker moved, this
         lifetime publishes NOTHING — no respondError attempts against a dead
         child, no interaction.abandoned, no session_load_failed. The open
         interactions are LEFT in the map: onAgentGone's own sweep abandons
         them with the death's sentence, which is the narration that owns
         this lifetime's end. The record/queue cleanup is bookkeeping, not
         narration, and still runs. */
      const lifetimeDied =
        expectedDeathSeq !== undefined && this.acp.deathSeq !== expectedDeathSeq;
      if (createdForLoad) this.sessions.delete(sessionId);
      this.changeActionChains.delete(sessionId); // WP11: no queue tail outlives the session
      if (!lifetimeDied) {
        const interactionReason = `Loading ${sessionId} failed before this interaction could be answered.`;
        for (const [key, open] of [...this.openInteractions]) {
          if (open.sessionId !== sessionId) continue;
          try {
            this.acp.respondError(
              open.id,
              -32000,
              interactionReason,
              { sessionId, loadError: message },
            );
          } catch (responseError) {
            this.acp.loud(
              `could not send the failure response for interaction ${key}: ` +
                `${(responseError as Error).message}`,
            );
          }
          this.bridge(
            "interaction.abandoned",
            {
              key,
              sessionId,
              method: open.method,
              interactionType: open.event.type,
              reason: interactionReason,
            },
            interactionReason,
            sessionId,
          );
          this.openInteractions.delete(key);
        }
        this.bridge(
          "bridge.session_load_failed",
          { sessionId, cwd, error: message },
          `Loading ${sessionId} failed: ${message}. The previous retained generation remains ` +
            `authoritative; no partial replay is being presented as complete history.`,
          sessionId,
        );
      }
      throw err;
    }
  }

  /**
   * `session/cancel` is a NOTIFICATION, not a request — there is no response to
   * wait for and none to trust. Confirmation comes from the turn ending, which
   * arrives as `session/prompt` returning with a `stopReason` that is not
   * `end_turn`.
   */
  cancel(sessionId: string): { sent: true; turnWasInFlight: boolean; note: string } {
    const rec = this.require(sessionId);
    const turnWasInFlight = rec.turn !== null;
    this.acp.notify(M.sessionCancel, { sessionId });
    const note = turnWasInFlight
      ? `Cancel sent for ${sessionId}. It is a notification, so there is nothing to confirm ` +
        `it — watch for the turn to end with a stopReason other than 'end_turn'.`
      : `Cancel sent for ${sessionId}, but no turn was in flight here, so it may do nothing. ` +
        `Nothing will report that either way: cancel is fire-and-forget.`;
    this.acp.note(note);
    this.bridge("bridge.cancel_sent", { sessionId, turnWasInFlight }, note, sessionId);
    return { sent: true, turnWasInFlight, note };
  }

  // ── mode ──────────────────────────────────────────────────────────────

  /**
   * Set the mode, then wait to see whether the agent confirms it.
   *
   * The response is worthless: `set_session_mode` returns an empty success
   * unconditionally, for any string, without validating the mode id. Twelve ids
   * were sent at one session and all twelve returned `{}`; two produced a
   * `current_mode_update` and ten produced nothing at all.
   *
   * So the only confirmation that exists is the event, and it fires only on
   * plan enter and plan exit. `verified: false` here does NOT mean the call
   * failed — it means the agent has not told us anything changed, which for
   * every mode except plan is the normal, permanent state. Never write mode
   * state from this method's return value; `absorbModeChange` is the only
   * writer, and it only runs on an event.
   */
  async setMode(sessionId: string, modeId: string): Promise<Verified<string | null>> {
    const rec = this.require(sessionId);
    const previous = rec.confirmedModeId;
    rec.modeRequest = { modeId, at: Date.now(), confirmed: false };

    const confirmation = this.waitForModeChange(sessionId, MODE_CONFIRM_MS);
    await this.acp.request(M.setMode, { sessionId, modeId }, CONTROL_TIMEOUT_MS);
    const observed = await confirmation;

    const verified = observed !== null;
    const matched = observed === modeId;
    const note = verified
      ? matched
        ? `set_mode('${modeId}') was confirmed: the agent emitted a mode change to '${observed}'. ` +
          `Note what that does and does not prove — the event fires on plan enter and exit, and ` +
          `on exit it echoes back whatever id was sent, so this confirms a plan-mode transition, ` +
          `not that '${modeId}' is a mode the agent recognises.`
        : `set_mode('${modeId}') produced a mode change to '${observed}' instead. The agent's own ` +
          `event is the truth; what we asked for is not.`
      : `set_mode('${modeId}') returned success and the agent emitted NO mode change within ` +
        `${MODE_CONFIRM_MS}ms. The response proves nothing — this API returns an empty success ` +
        `for any string, including typos and ids that do not exist. Either '${modeId}' is not a ` +
        `plan-mode transition (Ask mode and named agent profiles work but are silent), or it was ` +
        `ignored. Mode state is unchanged at '${previous ?? "never confirmed"}'.`;

    if (verified) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.mode_set_attempted",
      { sessionId, requested: modeId, confirmedModeId: observed, verified, matched },
      note,
      sessionId,
    );
    return { acknowledged: true, verified, matched, readBack: observed, note };
  }

  /** Resolve to the mode id the agent announces, or null if it announces nothing in time. */
  private waitForModeChange(sessionId: string, ms: number): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (v: string | null) => {
        clearTimeout(timer);
        this.off("app", listener);
        resolve(v);
      };
      const listener = (ev: AppEvent) => {
        if (ev.type === "mode.changed" && ev.sessionId === sessionId && !ev.replay) {
          const modeId = ev.data?.modeId;
          done(typeof modeId === "string" ? modeId : null);
        }
      };
      const timer = setTimeout(() => done(null), ms);
      this.on("app", listener);
    });
  }

  // ── model and reasoning effort ────────────────────────────────────────

  /**
   * Set the model and, optionally, the reasoning effort — then read the effort
   * back out of `sessions/list`, because that is the only place it can be read.
   *
   * Effort does NOT go through `set_mode`. Sending `set_mode {modeId:"medium"}`
   * returns success and changes nothing. It rides on `set_model` as
   * `_meta.reasoningEffort`, and a value the agent does not recognise is
   * silently discarded and the model default restored. Measured on 0.2.114:
   *
   *   set_model(grok-4.5, effort "low")   -> sessions/list reasoningEffort "low"
   *   set_model(grok-4.5, effort "ULTRA") -> sessions/list reasoningEffort "high"
   *
   * Both calls returned the identical success payload. The read-back is the
   * only thing that separates them.
   */
  async setModel(
    sessionId: string,
    modelId: string,
    reasoningEffort?: string,
  ): Promise<Verified<{ modelId: string | null; reasoningEffort: string | null }>> {
    const rec = this.require(sessionId);

    const params: Record<string, unknown> = { sessionId, modelId };
    if (reasoningEffort !== undefined) params._meta = { reasoningEffort };
    // Unlike set_mode, this one does validate: an unknown session id or a model
    // outside `allowed_models` comes back as invalid_params rather than a lie.
    const ack = await this.acp.request(M.setModel, params, CONTROL_TIMEOUT_MS);

    const entry = await this.rosterEntry(sessionId);
    const readBack = {
      modelId: typeof entry?.modelId === "string" ? entry.modelId : null,
      reasoningEffort:
        typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : null,
    };
    if (entry) {
      rec.modelId = readBack.modelId;
      rec.reasoningEffort = readBack.reasoningEffort;
    }

    const verified = entry !== null;
    const modelMatched = readBack.modelId === modelId;
    const effortMatched =
      reasoningEffort === undefined ? true : readBack.reasoningEffort === reasoningEffort;
    const matched = verified && modelMatched && effortMatched;

    let note: string;
    if (!verified) {
      note =
        `set_model succeeded but ${sessionId} was not in the sessions/list read-back, so ` +
        `nothing has been verified. The response payload is not evidence — it is the same for ` +
        `a value that took and one that was discarded.`;
    } else if (matched) {
      note =
        `set_model verified by read-back: sessions/list reports model '${readBack.modelId}'` +
        (reasoningEffort === undefined
          ? ` (effort left alone, currently '${readBack.reasoningEffort ?? "default"}')`
          : ` and reasoningEffort '${readBack.reasoningEffort}'`) +
        `.`;
    } else {
      note =
        `set_model RETURNED SUCCESS AND THE STATE DOES NOT MATCH. Asked for model ` +
        `'${modelId}'` +
        (reasoningEffort === undefined ? "" : ` with effort '${reasoningEffort}'`) +
        `; sessions/list reports model '${readBack.modelId}' with effort ` +
        `'${readBack.reasoningEffort}'. A reasoning effort the agent does not recognise is ` +
        `discarded without an error and the model default is used instead — that is the most ` +
        `likely explanation, and it is exactly the failure a success response hides.`;
    }

    if (matched) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.model_set_attempted",
      {
        sessionId,
        requested: { modelId, reasoningEffort: reasoningEffort ?? null },
        readBack,
        verified,
        matched,
        ack,
      },
      note,
      sessionId,
    );
    return { acknowledged: true, verified, matched, readBack, note };
  }

  // ── the roster ────────────────────────────────────────────────────────

  /**
   * Every session on this machine, from every process — not just ours.
   *
   * Served by the agent from its resident sessions merged with on-disk
   * summaries, and it works on a direct `--no-leader` connection: 63 sessions
   * across 22 working directories came back on a connection that had created
   * exactly one. That closes the open question behind decision D5.
   */
  async listSessions(): Promise<{ sessions: any[]; ours: number; foreign: number }> {
    this.requireReady();
    const raw = await this.acp.request(M.sessionsList, {}, CONTROL_TIMEOUT_MS);
    const payload = this.unwrapExt(M.sessionsList, raw);
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    if (!Array.isArray(payload?.sessions)) {
      this.acp.loud(
        `sessions/list returned no 'sessions' array — reporting an empty roster would claim ` +
          `this machine has no sessions, which is a different statement from "we could not read it"`,
        payload,
      );
    }

    let ours = 0;
    for (const s of sessions) {
      if (typeof s?.sessionId === "string" && this.sessions.has(s.sessionId)) ours++;
      // Reconcile the roster's reading of effort and model into our own record.
      // sessions/list is where those two can be read; nothing else reports them.
      const rec = typeof s?.sessionId === "string" ? this.sessions.get(s.sessionId) : undefined;
      if (rec) {
        if (typeof s.modelId === "string") rec.modelId = s.modelId;
        rec.reasoningEffort = typeof s.reasoningEffort === "string" ? s.reasoningEffort : null;
        // The roster is where a title can be read for a held session too, so it
        // is reconciled here alongside model/effort. Blank stays null.
        if (typeof s.title === "string" && s.title.trim() !== "") rec.title = s.title;
      }
    }

    /* Broadcast only when the roster moved. The WP8 poll re-reads on an
       interval; pushing every identical answer would repaint every channel's
       canvas every interval — and a canvas repaint destroys a half-typed
       plan-feedback note (the §0 repaint hazard). Callers still get the full
       return value either way; only the push is conditional. */
    const signature = JSON.stringify(sessions);
    if (signature !== this.lastRosterSignature) {
      this.lastRosterSignature = signature;
      this.bridge(
        "bridge.sessions_listed",
        {
          count: sessions.length,
          ours,
          foreign: sessions.length - ours,
          sessions,
        },
      );
    }
    return { sessions, ours, foreign: sessions.length - ours };
  }

  /** One roster row, or null. The only place `reasoningEffort` can be read. */
  private async rosterEntry(sessionId: string): Promise<any | null> {
    try {
      const { sessions } = await this.listSessions();
      return sessions.find((s) => s?.sessionId === sessionId) ?? null;
    } catch (err) {
      this.acp.loud(`could not read the roster back: ${(err as Error).message}`);
      return null;
    }
  }

  // ── session administration (WP13: rename / delete / auto-approve / portability) ──
  //
  // Every method here reads state back before it reports success — the house
  // style, and rule 1 (never trust an acknowledgement). Each also works on
  // UNHELD rows, because most of the machine's sessions are on disk, not held
  // by this app: `require()` throws for those, so cwd is resolved from the held
  // record when there is one and from the roster otherwise. cwd never comes
  // from the browser — a browser-supplied cwd could aim a rename or a permanent
  // delete at the wrong on-disk directory.

  /** The on-disk cwd for a session — held record first, then the roster row. */
  private async resolveCwd(sessionId: string): Promise<string> {
    const held = this.sessions.get(sessionId);
    if (held && typeof held.cwd === "string" && held.cwd !== "") return held.cwd;
    const entry = await this.rosterEntry(sessionId);
    if (entry && typeof entry.cwd === "string" && entry.cwd !== "") return entry.cwd;
    const err: any = new Error(
      `no cwd for session '${sessionId}': it is neither held by this app nor on this machine's ` +
        `roster, so there is no on-disk location to act on. Refused before any wire call.`,
    );
    err.badRequest = true;
    throw err;
  }

  /**
   * Resolve to the title the agent announces via `session.titled`, or null if it
   * announces none in time. The read-back proof for a rename: the agent pushes
   * `session_summary_generated` (→ our `session.titled`) whenever a title
   * changes, and for a HELD session that push is more reliable than the roster,
   * whose resident row may still carry the pre-rename title until the next poll.
   * `session.info_updated` is deliberately ignored — it is advisory and echoes
   * the prior title after it (PROJECT-STATE 0.2.117 rows), so treating it as a
   * confirmation would let a stale value pass as the read-back.
   */
  private waitForTitle(sessionId: string, ms: number): Promise<string | null> {
    return new Promise((resolve) => {
      const done = (v: string | null) => {
        clearTimeout(timer);
        this.off("app", listener);
        resolve(v);
      };
      const listener = (ev: AppEvent) => {
        if (ev.type === "session.titled" && ev.sessionId === sessionId && !ev.replay) {
          const t = ev.data?.title;
          done(typeof t === "string" ? t : null);
        }
      };
      const timer = setTimeout(() => done(null), ms);
      this.on("app", listener);
    });
  }

  /**
   * Rename a session, then read the new title back — the ack proves nothing.
   *
   * `session/rename` answers a bare `{success:true}` (rule 1: not evidence). Two
   * independent read-backs, either of which confirms it: the `session.titled`
   * the agent pushes back (the same event an agent-generated title rides, so the
   * rail retitles for free), and the roster row's title re-read from
   * `sessions/list`. `matched` is true when either reports the title we set —
   * which covers both the unheld case (the on-disk summary, and therefore the
   * roster, updates immediately) and the held case (the push is reliable even if
   * the resident roster row lags).
   *
   * Blank is refused locally BEFORE the wire (the server refuses it too, but a
   * blank must never leave the browser). cwd comes from the record or the
   * roster; a browser-supplied cwd is ignored (the server route drops it).
   * The title is operator text but still hostile-by-policy — it reaches the DOM
   * as text (D31), and this method never renders it, only carries it.
   */
  async renameSession(sessionId: string, title: string): Promise<Verified<string | null>> {
    this.requireReady();
    const trimmed = typeof title === "string" ? title.trim() : "";
    if (trimmed === "") {
      const err: any = new Error("title must not be blank");
      err.badRequest = true;
      throw err;
    }
    const cwd = await this.resolveCwd(sessionId);

    // Start listening before the request, so a push that arrives while the call
    // is in flight is not missed (same ordering as setMode/waitForModeChange).
    const titled = this.waitForTitle(sessionId, MODE_CONFIRM_MS);
    const raw = await this.acp.request(
      M.sessionRename,
      { sessionId, title: trimmed, cwd },
      CONTROL_TIMEOUT_MS,
    );
    this.unwrapExt(M.sessionRename, raw); // the ack; discarded, it is not evidence.
    const pushed = await titled;

    const entry = await this.rosterEntry(sessionId);
    const rosterTitle = typeof entry?.title === "string" ? entry.title : null;
    const readBack = rosterTitle ?? pushed;
    const held = this.sessions.get(sessionId);
    if (held && readBack !== null && readBack.trim() !== "") held.title = readBack;

    const verified = entry !== null || pushed !== null;
    const matched = rosterTitle === trimmed || pushed === trimmed;
    const note = !verified
      ? `rename returned success but nothing could be read back — ${sessionId} was not in ` +
        `sessions/list and the agent pushed no title within ${MODE_CONFIRM_MS}ms. The ` +
        `{success:true} response is not evidence that the rename took.`
      : matched
        ? `rename verified by read-back: the title is now '${trimmed}'` +
          (pushed === trimmed && rosterTitle !== trimmed
            ? ` (confirmed by the agent's pushed title; the roster row still reads ` +
              `'${rosterTitle ?? "(none)"}' and will catch up on the next poll).`
            : `.`)
        : `rename RETURNED SUCCESS AND THE TITLE DOES NOT MATCH. Asked for '${trimmed}'; the ` +
          `roster reads '${rosterTitle ?? "(none)"}' and the agent pushed ` +
          `'${pushed ?? "(nothing)"}'. The response is the same whether a rename took or not — ` +
          `only the read-back separates them.`;
    if (matched) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.session_renamed",
      { sessionId, requested: trimmed, readBack, rosterTitle, pushed, verified, matched },
      note,
      sessionId,
    );
    return { acknowledged: true, verified, matched, readBack, note };
  }

  /**
   * Set the connection-wide permission mode (D58/D62), then read the effect back.
   *
   * `_x.ai/yolo_mode_changed` is a NOTIFICATION — one-way, no id, no reply — so
   * there is nothing to trust on the call itself. It carries NO sessionId and the
   * shell applies it to EVERY held session (CONFIRMED, turn.rs:356-378), so it is
   * connection-wide by protocol: there is no honest per-session form on this wire.
   * That is exactly D62 — ONE global switch labelled "applies to all sessions",
   * never a per-session-looking control that silently flips the rest.
   *
   * NO config.toml write. The shell applies the mode to live handles from the
   * notification alone; the pager's `[ui].permission_mode` write is a separate
   * step this app deliberately does not perform (D60), which keeps the start/exit
   * config.toml md5-unchanged invariant intact and avoids persisting
   * approve-everything as the machine default after this app exits.
   *
   * Read-back (rule 1): the only wire-readable trace is `sessions/list.yolo`,
   * which reflects a resident handle's live yolo state. So `always-approve` and
   * its off states (`default`/`ask`) ARE verifiable — held rows read back
   * yolo true/false — while `auto` is NOT (nothing exposes `auto_mode`), so
   * `auto` is reported as requested-but-not-verifiable and never as confirmed.
   * The send-side underscore prefix is the one open wire question (gap 1); the
   * live evidence run confirms `_x.ai/` vs bare and the connection-wide scope.
   */
  /**
   * WP15 / D87: set coding-data retention via the agent's own protocol request.
   * This method only talks to the agent — it never opens auth.json. The server
   * re-reads the file through config-read after the call and reports one of
   * three honest outcomes (verified / acknowledged_not_confirmed / refused).
   *
   * Phase 0 (2026-08-11): flat reply `{codingDataRetentionOptOut:bool}`; the
   * agent rewrites auth.json; upstream DISCARDS its local save result
   * (`let _ =` in privacy.rs) so "reply agreed, file stale" is a real state.
   */
  async setCodingDataRetention(codingDataRetentionOptOut: boolean): Promise<{
    sent: true;
    requested: boolean;
    replyOptOut: boolean | null;
    replyAgreed: boolean;
    rawResult: unknown;
    note: string;
  }> {
    this.requireReady();
    if (typeof codingDataRetentionOptOut !== "boolean") {
      const err: any = new Error("codingDataRetentionOptOut must be a boolean");
      err.badRequest = true;
      throw err;
    }
    const raw = await this.acp.request(
      M.setCodingDataRetention,
      { codingDataRetentionOptOut },
      PRIVACY_TIMEOUT_MS,
    );
    const payload = this.unwrapExt(M.setCodingDataRetention, raw);
    const replyOptOut =
      payload && typeof payload === "object" && typeof (payload as any).codingDataRetentionOptOut === "boolean"
        ? (payload as any).codingDataRetentionOptOut as boolean
        : null;
    const replyAgreed = replyOptOut === codingDataRetentionOptOut;
    const note = replyAgreed
      ? `agent replied codingDataRetentionOptOut=${replyOptOut} (matches request). ` +
        `File confirmation is the caller's job — this method never opens auth.json.`
      : `agent replied codingDataRetentionOptOut=${JSON.stringify(replyOptOut)} ` +
        `for requested ${codingDataRetentionOptOut} — reply did not agree.`;
    if (replyAgreed) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.retention_set_attempted",
      {
        requested: codingDataRetentionOptOut,
        replyOptOut,
        replyAgreed,
      },
      note,
      null,
    );
    return {
      sent: true,
      requested: codingDataRetentionOptOut,
      replyOptOut,
      replyAgreed,
      rawResult: payload,
      note,
    };
  }

  async setPermissionMode(mode: string): Promise<{
    sent: true;
    mode: string;
    scope: "connection-wide";
    verifiable: boolean;
    verified: boolean;
    matched: boolean;
    yoloReadBack: { sessionId: string; yolo: boolean }[];
    note: string;
  }> {
    this.requireReady();
    if (!PERMISSION_MODES.includes(mode)) {
      const err: any = new Error(
        `'${mode}' is not a permission mode — expected one of ${PERMISSION_MODES.join(", ")}`,
      );
      err.badRequest = true;
      throw err;
    }
    const yolo_mode = mode === "always-approve";
    const auto_mode = mode === "auto";
    // One-way. clientIdentifier is deliberately OMITTED — omitting it is what
    // makes the shell apply the mode to every session (matches_sender is true
    // when sender_id is None). Sent via notify, like cancel(): no reply to read.
    this.acp.notify(M.yoloModeChanged, { yolo_mode, auto_mode, permission_mode: mode });
    this.permissionMode = mode; // the REQUESTED intent, not proof it took.

    const verifiable = mode !== "auto";
    let verified = false;
    let matched = false;
    let yoloReadBack: { sessionId: string; yolo: boolean }[] = [];
    if (verifiable) {
      const { sessions } = await this.listSessions();
      const held = sessions.filter(
        (s: any) => typeof s?.sessionId === "string" && this.sessions.has(s.sessionId),
      );
      yoloReadBack = held.map((s: any) => ({ sessionId: s.sessionId, yolo: s.yolo === true }));
      verified = held.length > 0;
      matched = verified && held.every((s: any) => (s.yolo === true) === yolo_mode);
    }

    const note = !verifiable
      ? `permission mode requested '${mode}' (connection-wide). 'auto' has NO wire read-back — ` +
        `nothing in sessions/list or session/info exposes it — so this is REQUESTED, not verified. ` +
        `Confirm it behaviourally: a following tool call should run a safe subset without a card.`
      : verified && matched
        ? `permission mode '${mode}' verified connection-wide: ${yoloReadBack.length} held ` +
          `session(s) read back yolo=${yolo_mode} from sessions/list. This covers EVERY session ` +
          `this window holds (D62), because the notification carries no sessionId.`
        : verified
          ? `permission mode requested '${mode}' but the read-back does NOT match: sessions/list ` +
            `reports yolo=${JSON.stringify(yoloReadBack.map((r) => r.yolo))} where ${yolo_mode} was ` +
            `expected. The notification is one-way, so this read-back is the only check — and it ` +
            `did not confirm the change took.`
          : `permission mode requested '${mode}' but there is no held session to read yolo back ` +
            `from, so nothing is verified. The notification was sent; whether it took cannot be ` +
            `confirmed from here.`;
    if (matched || !verifiable) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.permission_mode_set",
      {
        mode,
        yolo_mode,
        auto_mode,
        scope: "connection-wide",
        covers: [...this.sessions.keys()],
        verifiable,
        verified,
        matched,
        yoloReadBack,
      },
      note,
      null, // connection-wide — belongs to no single session
    );
    return { sent: true, mode, scope: "connection-wide", verifiable, verified, matched, yoloReadBack, note };
  }

  /**
   * Delete a session — PERMANENTLY. The one irreversible method here.
   *
   * `session/delete` is remote-first and authoritative: for a non-ZDR writeback
   * account it deletes the xAI server copy first and only then the local dir +
   * FTS entry; for a ZDR/non-writeback account it is local-only. Build sessions
   * (Graphometer's kind) have NO soft-delete, NO archive, NO protocol undo.
   *
   * Every guard here is load-bearing (WP13_RISK_REVIEW, all BLOCKING):
   *
   *  - **Refuse mid-turn.** Deleting races an in-flight `session/prompt`. The
   *    operator must Stop first; this refuses locally (400) rather than racing.
   *  - **Refuse mid-load.** Same race, other direction: a `session/load` in
   *    flight is still replaying, and its reply would rebuild a record for a
   *    session the delete had just removed. Refused locally (400) until it ends.
   *  - **A thrown request = the session is INTACT.** Remote-first means a remote
   *    failure touches nothing local, so a caught error is NOT a delete and must
   *    never be reported as one. Returned as `{deleted:false, intact:true}`.
   *  - **Silent success.** `{success:true}` returns even on a no-op (wrong/stale
   *    id, or a mismatched cwd — the match is by globally-unique UUIDv7 id, so a
   *    wrong cwd only UNDER-deletes). So the ack proves nothing: read back GONE
   *    from `sessions/list` before reporting success. A still-present row is a
   *    loud no-op, not a delete.
   *  - **No stale record/card.** Only AFTER a verified-gone read-back is the live
   *    record dropped, the turn watchdog cleared, and any open interactions for
   *    the id abandoned — so the app never holds a live handle for a session the
   *    agent has shut down, and the active view can fall to empty rather than a
   *    card for a session that no longer exists.
   */
  async deleteSession(sessionId: string): Promise<{
    deleted: boolean;
    goneFromRoster: boolean;
    intact?: boolean;
    wasHeld: boolean;
    error?: string;
    note: string;
  }> {
    this.requireReady();
    const held = this.sessions.get(sessionId);
    // Refuse while a turn is in flight — Stop it first.
    if (held?.turn) {
      const err: any = new Error(
        `session '${sessionId}' has a turn in flight — Stop the turn before deleting, so the ` +
          `delete does not race the running prompt.`,
      );
      err.badRequest = true;
      throw err;
    }
    // And while a load is replaying: session/load is still in flight, so a
    // delete that won the race would drop the record and abandon interactions
    // under a reply that then lands and rebuilds a live record for a session the
    // agent may already have removed.
    if (held?.loading) {
      const err: any = new Error(
        `session '${sessionId}' is still loading — wait for the load to finish before deleting, ` +
          `so the delete does not race the replay.`,
      );
      err.badRequest = true;
      throw err;
    }
    const cwd = await this.resolveCwd(sessionId);

    // Send the delete. A THROWN error = remote delete failed = session INTACT.
    let raw: any;
    try {
      raw = await this.acp.request(M.sessionDelete, { sessionId, cwd }, CONTROL_TIMEOUT_MS);
    } catch (err) {
      const message = (err as Error).message;
      const note =
        `delete did NOT happen — the session is INTACT. The delete errored (${message}), and ` +
        `this method is remote-first, so a remote failure leaves the local copy untouched too. ` +
        `This is not a delete; nothing was removed.`;
      this.acp.loud(note);
      this.bridge(
        "bridge.session_delete_failed",
        { sessionId, error: message, intact: true },
        note,
        sessionId,
      );
      return { deleted: false, goneFromRoster: false, intact: true, wasHeld: !!held, error: message, note };
    }
    this.unwrapExt(M.sessionDelete, raw); // {success:true} — silent-success ack, not evidence.

    // Read back GONE before claiming anything (rule 1).
    const { sessions } = await this.listSessions();
    const goneFromRoster = !sessions.some((s: any) => s?.sessionId === sessionId);

    if (!goneFromRoster) {
      const note =
        `delete returned {success:true} but ${sessionId} is STILL in sessions/list — a no-op, not ` +
        `a delete. That call returns success even when it removed nothing (a stale id, or a cwd ` +
        `that did not match the on-disk directory). Reporting failure, not success: the session is ` +
        `still here and INTACT.`;
      this.acp.loud(note);
      this.bridge(
        "bridge.session_deleted",
        { sessionId, deleted: false, goneFromRoster: false, wasHeld: !!held },
        note,
        null,
      );
      return { deleted: false, goneFromRoster: false, wasHeld: !!held, note };
    }

    // Verified gone. Drop our own live state so nothing stale survives.
    const wasHeld = !!held;
    if (held) {
      if (held.turn) {
        clearInterval(held.turn.watchdog);
        held.turn = null;
      }
      this.sessions.delete(sessionId);
      this.changeActionChains.delete(sessionId); // WP11: no queue tail outlives the session
    }
    for (const [key, open] of [...this.openInteractions]) {
      if (open.sessionId !== sessionId) continue;
      const reason = "The session was deleted before this interaction could be answered.";
      try {
        this.acp.respondError(open.id, -32000, reason, { sessionId });
      } catch (responseError) {
        this.acp.loud(
          `could not send the failure response for interaction ${key} after delete: ` +
            `${(responseError as Error).message}`,
        );
      }
      this.bridge(
        "interaction.abandoned",
        { key, sessionId, method: open.method, interactionType: open.event.type, reason },
        reason,
        sessionId,
      );
      this.openInteractions.delete(key);
    }

    const note = `delete verified: ${sessionId} is GONE from sessions/list. Permanent — there is no protocol undo.`;
    this.acp.note(note);
    this.bridge(
      "bridge.session_deleted",
      { sessionId, deleted: true, goneFromRoster: true, wasHeld },
      note,
      null, // the session no longer exists to scope to; the client reads data.sessionId
    );
    return { deleted: true, goneFromRoster: true, wasHeld, note };
  }

  // ── export / import portability (D61) ──
  // The native round-trip: `session/state` + `session/updates` OUT →
  // `session/import` BACK, all on the same ACP wire, no network. This is Grok
  // Build's own designed cross-host path (fork and remote pull prove on-disk
  // files alone yield a loadable session). Read-backs per rule 1.

  /**
   * The metadata half of a bundle. `summary` is mandatory — a summary-less reply
   * is not a valid bundle (import requires it to reconstruct a session). Private:
   * a read used only by exportSession, never a user action on its own.
   */
  private async readSessionState(sessionId: string, cwd: string): Promise<any> {
    const raw = await this.acp.request(M.sessionState, { sessionId, cwd }, CONTROL_TIMEOUT_MS);
    const state = this.unwrapExt(M.sessionState, raw);
    const ok =
      state && typeof state === "object" && state.summary && typeof state.summary === "object";
    if (!ok) {
      const note =
        `session/state for ${sessionId} returned no valid 'summary' column, so this is not an ` +
        `exportable bundle — import requires a summary. Nothing was exported.`;
      this.acp.loud(note);
      this.bridge("bridge.session_state_empty", { sessionId, raw: state }, note, sessionId);
      const err: any = new Error(note);
      err.badRequest = true;
      throw err;
    }
    return state;
  }

  /**
   * The transcript half — the full raw update set, no paging. Each element is the
   * whole JSONL envelope, kept RAW: it plugs straight into import's `updates` and
   * must NOT flow through events.ts (that boundary is the live SSE stream only).
   * `hasMore` true means the transcript was truncated and any bundle would be
   * INCOMPLETE, which is said loudly.
   */
  private async readSessionUpdates(
    sessionId: string,
    cwd: string,
  ): Promise<{ updates: any[]; totalCount: number | null; hasMore: boolean }> {
    const raw = await this.acp.request(M.sessionUpdates, { sessionId, cwd }, LOAD_TIMEOUT_MS);
    const payload = this.unwrapExt(M.sessionUpdates, raw);
    if (!Array.isArray(payload?.updates)) {
      const note =
        `session/updates for ${sessionId} returned no 'updates' array — reporting an empty ` +
        `transcript would falsely claim a blank history, so the export is treated as unavailable.`;
      this.acp.loud(note);
      throw new Error(note);
    }
    const hasMore = payload.hasMore === true;
    if (hasMore) {
      this.acp.loud(
        `session/updates for ${sessionId} reports hasMore=true — the transcript is truncated and ` +
          `any bundle built from it would be INCOMPLETE.`,
      );
    }
    return {
      updates: payload.updates,
      totalCount: typeof payload.totalCount === "number" ? payload.totalCount : null,
      hasMore,
    };
  }

  /**
   * Export a session to a self-contained, round-trippable bundle — exactly what
   * `session/import` consumes: `{state, updates}` with a marker so import can
   * refuse a foreign shape. The updates stay RAW (whole envelopes).
   */
  async exportSession(sessionId: string): Promise<{
    kind: "graphometer-session-bundle";
    version: 1;
    sessionId: string;
    cwd: string;
    state: any;
    updates: any[];
    totalCount: number | null;
    hasMore: boolean;
  }> {
    this.requireReady();
    const cwd = await this.resolveCwd(sessionId);
    const state = await this.readSessionState(sessionId, cwd);
    const { updates, totalCount, hasMore } = await this.readSessionUpdates(sessionId, cwd);
    this.acp.note(
      `exported ${sessionId}: ${updates.length} update(s), summary present, hasMore=${hasMore}`,
    );
    this.bridge(
      "bridge.session_exported",
      { sessionId, updateCount: updates.length, totalCount, hasMore },
      undefined,
      sessionId,
    );
    return { kind: "graphometer-session-bundle", version: 1, sessionId, cwd, state, updates, totalCount, hasMore };
  }

  /**
   * Import a bundle BACK into a loadable local session. Pure local file
   * reconstruction, no network. Foreign shapes and invalid bundles are refused
   * LOCALLY before the wire. `{imported:false}` is a SILENT refuse-overwrite — a
   * session with that id already existed and was left unchanged — NOT an error
   * and NOT a fresh success; it is reported as `alreadyExisted`. Read back
   * present in `sessions/list` either way (rule 1): the ack alone proves nothing,
   * and `{imported:true}` with the id absent is a claim we do not repeat.
   */
  async importSession(bundle: any): Promise<{
    imported: boolean;
    present: boolean;
    alreadyExisted: boolean;
    note: string;
  }> {
    this.requireReady();
    const bad = (message: string) => {
      const e: any = new Error(message);
      e.badRequest = true;
      return e;
    };
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      throw bad("import needs a bundle object");
    }
    if (bundle.kind !== "graphometer-session-bundle") {
      throw bad(
        "this is not a Grok session bundle (the graphometer-session-bundle marker is missing). A " +
          "Markdown export cannot be imported, and a foreign format (e.g. an OpenWebUI JSON) has no " +
          "ACP-shaped updates to reconstruct a Grok session from.",
      );
    }
    const sessionId = bundle.sessionId;
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
      throw bad("import: sessionId must be a UUID");
    }
    const state = bundle.state;
    if (!state || typeof state !== "object" || !state.summary || typeof state.summary !== "object") {
      throw bad("import: the bundle has no valid summary (state.summary) — required to reconstruct a session");
    }
    if (!Array.isArray(bundle.updates)) throw bad("import: the bundle has no updates array");
    const cwd = typeof bundle.cwd === "string" && bundle.cwd.trim() !== "" ? bundle.cwd : null;
    if (cwd === null) throw bad("import: the bundle has no destination cwd");

    const raw = await this.acp.request(
      M.sessionImport,
      { sessionId, cwd, state, updates: bundle.updates },
      LOAD_TIMEOUT_MS,
    );
    const ack = this.unwrapExt(M.sessionImport, raw);
    const imported = ack?.imported === true;

    // Read back present regardless of the ack (rule 1).
    const { sessions } = await this.listSessions();
    const present = sessions.some((s: any) => s?.sessionId === sessionId);
    const alreadyExisted = !imported && present;

    const note = imported
      ? present
        ? `imported — ${sessionId} is present in sessions/list.`
        : `import returned {imported:true} but ${sessionId} is NOT in sessions/list — nothing to ` +
          `show, so this is not a confirmed import.`
      : present
        ? `not imported — a session with id ${sessionId} already exists on this machine. It was ` +
          `left unchanged; nothing was overwritten (import refuses to overwrite, by the protocol's ` +
          `own design).`
        : `import returned {imported:false} and ${sessionId} is not present — nothing was imported.`;
    const clean = (imported && present) || alreadyExisted;
    if (clean) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.session_imported",
      { sessionId, imported, present, alreadyExisted },
      note,
      present ? sessionId : null,
    );
    return { imported, present, alreadyExisted, note };
  }

  /**
   * `_x.ai/sessions/changed` is a hint, not a payload to render. Upstream emits
   * it at turn boundaries with a roster delta, and its own clients treat it as
   * "re-read the list". We do the same, debounced, because a burst of turn-start
   * and turn-end deltas across several sessions would otherwise be a burst of
   * round trips.
   */
  private scheduleRosterRefresh() {
    if (this.rosterRefreshTimer) return;
    this.rosterRefreshTimer = setTimeout(() => {
      this.rosterRefreshTimer = null;
      if (this.state !== "ready") return;
      this.listSessions().catch((err) =>
        this.acp.loud(`roster refresh after sessions/changed failed: ${(err as Error).message}`),
      );
    }, ROSTER_REFRESH_DEBOUNCE_MS);
  }

  /**
   * The interval companion to the debounce above (WP8): sessions/changed only
   * ever covers THIS process, so foreign sessions are learned by re-reading.
   * Unref'd so it never holds the process open; identical rosters are not
   * broadcast (listSessions signatures), so an idle page stays unpainted.
   */
  private startRosterPoll() {
    if (this.rosterPollTimer) return;
    this.rosterPollTimer = setInterval(() => {
      if (this.state !== "ready") return;
      this.listSessions().catch((err) =>
        this.acp.loud(`roster poll failed: ${(err as Error).message}`),
      );
    }, ROSTER_POLL_MS);
    this.rosterPollTimer.unref();
  }

  // ── commands ──────────────────────────────────────────────────────────

  /**
   * The authoritative slash-command list for one session.
   *
   * Queried, never hardcoded — and never cached from the first answer either.
   * The agent rebuilds this list from three live inputs (the slash-skill list,
   * the live tool-name list, and whether any workflow runs exist) and re-sends
   * it as `available_commands_update` when any of them changes, so installing a
   * skill changes it while a session is open. `absorbCommands` keeps the record
   * current from those events; this method is the on-demand read.
   *
   * The payload is FLAT — `{commands, tools}`, no ext envelope. See
   * EXT_ENVELOPE at the top of this file.
   *
    * A read that returns no readable command array THROWS (WP7 §2). It used to return a
   * successful `commands: []`, which the launcher would have drawn as "the
   * agent reports no commands for this session" — a confident statement about
   * the agent made out of a payload we could not read. `err.unreadableCatalogue`
   * is the marker the route turns into a 502 the page renders as unavailable.
   * A VALID empty array is untouched by this: it returns normally, because an
   * agent with no commands is a real thing and it is what we read.
   */
  async listCommands(sessionId?: string): Promise<{
    commands: unknown[];
    tools: unknown;
    scope: "session" | "global";
  }> {
    this.requireReady();
    // An unknown session id here is an explicit invalid_request rather than a
    // hang — but check anyway, so the caller gets our own clearer message.
    if (sessionId !== undefined) this.require(sessionId);

    const params = sessionId === undefined ? {} : { sessionId };
    const rec = sessionId ? this.sessions.get(sessionId) : undefined;
    const queryRevision = rec ? ++rec.commandsRevision : null;
    const raw = await this.acp.request(M.commandsList, params, CONTROL_TIMEOUT_MS);
    const payload = this.unwrapExt(M.commandsList, raw);
    if (!Array.isArray(payload?.commands) || !payload.commands.every((command: any) =>
      command && typeof command === "object" &&
      typeof command.name === "string" && command.name.trim() !== "")) {
      const note =
        `commands/list returned no readable 'commands' array with non-empty names, so the command list could not be read. ` +
        `Reporting zero commands would tell the operator this agent has none, which is not ` +
        `what we read — this is unreadable, not empty.`;
      this.acp.loud(note, payload);
      this.bridge(
        "bridge.commands_unreadable",
        { sessionId: sessionId ?? null, source: "query", keptCount: null, payload: payload ?? null },
        note,
        sessionId ?? null,
      );
      const err = new Error(note) as Error & { unreadableCatalogue?: boolean };
      err.unreadableCatalogue = true;
      throw err;
    }
    const commands = payload.commands;
    const tools = payload?.tools ?? null;

    /* A live update or newer query that arrived while this request was pending
       is newer truth. Return this valid response to its caller, but never let
       it roll the manager's retained catalogue back. */
    if (rec && rec.commandsRevision === queryRevision) {
      rec.commands = { commands, tools, at: Date.now(), source: "query" };
    }

    this.bridge(
      "bridge.commands_listed",
      { sessionId: sessionId ?? null, count: commands.length, commands, tools },
      undefined,
      sessionId ?? null,
    );
    return { commands, tools, scope: sessionId === undefined ? "global" : "session" };
  }

  // ── session/info ──────────────────────────────────────────────────────

  /**
   * The context reading for one session.
   *
   * Two traps in one method, and they compound.
   *
   * 1. An unknown session id returns `{}` with a SUCCESS status. An empty object
   *    is not a reading of zero, and a context bar drawn from it would show a
   *    confident, wrong 0%. Detected by the absence of `sessionId` in the
   *    payload, which the real response always carries.
   *
   * 2. Called with NO sessionId, it does not fail — it picks
   *    `agent.sessions.keys().next()`, the first key of a hash map. With one
   *    session that is invisible. With three it silently reports a different
   *    session's context than the one on screen. So `sessionId` is required
   *    here even though the protocol makes it optional.
   */
  async sessionInfo(sessionId: string): Promise<{ info: any; summary: string } | null> {
    this.require(sessionId);
    const raw = await this.acp.request(M.sessionInfo, { sessionId }, CONTROL_TIMEOUT_MS);
    const info = this.unwrapExt(M.sessionInfo, raw);

    const isReading =
      info !== null && typeof info === "object" && typeof info.sessionId === "string";
    if (!isReading) {
      const note =
        `session/info for ${sessionId} returned a success with no reading in it ` +
        `(${JSON.stringify(info)}). That is what this method does for a session id it does not ` +
        `know — it does NOT mean the context is empty. Nothing has been read.`;
      this.acp.loud(note);
      this.bridge("bridge.session_info_empty", { sessionId, raw: info }, note, sessionId);
      return null;
    }
    if (info.sessionId !== sessionId) {
      const note =
        `session/info was asked about ${sessionId} and answered about ${info.sessionId}. ` +
        `Discarding it: attributing one session's context to another is exactly the ` +
        `cross-session leak this package has to not have.`;
      this.acp.loud(note);
      this.bridge("bridge.session_info_mismatch", { asked: sessionId, answered: info.sessionId }, note, sessionId);
      return null;
    }

    const summary = summarizeContext(info);
    this.acp.note(`session/info ${sessionId} — ${summary}`, info);
    this.bridge("bridge.context_reading", { info, summary }, undefined, sessionId);
    return { info, summary };
  }

  /**
   * Compact now. Returns when the agent says it has, which on this method does
   * mean something: an unknown session id does not return a lie, it never
   * returns at all (see the CORRECTION at the top of this file), so the local
   * check in `require` is what keeps this from wedging.
   *
   * The reading afterwards is the point. `session/info` before and after is the
   * only way to see whether anything was actually compacted.
   */
  async compact(sessionId: string, userContext?: string) {
    this.require(sessionId);
    const before = await this.sessionInfo(sessionId);
    const params: Record<string, unknown> = { sessionId };
    if (userContext !== undefined) params.userContext = userContext;
    const raw = await this.acp.request(M.compact, params, LOAD_TIMEOUT_MS);
    const ack = this.unwrapExt(M.compact, raw);
    const after = await this.sessionInfo(sessionId);

    const usedBefore = contextOf(before?.info)?.used ?? null;
    const usedAfter = contextOf(after?.info)?.used ?? null;
    const note =
      usedBefore === null || usedAfter === null
        ? `compact_conversation returned, but the before/after context reading could not be ` +
          `taken, so there is no evidence anything was compacted.`
        : usedAfter < usedBefore
          ? `Compacted: context went from ${usedBefore} to ${usedAfter} tokens.`
          : `compact_conversation returned success and the context did NOT go down ` +
            `(${usedBefore} -> ${usedAfter} tokens). The call succeeded; the compaction did not ` +
            `do what the word implies.`;

    if (usedAfter !== null && usedBefore !== null && usedAfter < usedBefore) this.acp.note(note);
    else this.acp.loud(note);
    this.bridge(
      "bridge.compacted",
      { sessionId, usedBefore, usedAfter, ack },
      note,
      sessionId,
    );
    return { usedBefore, usedAfter, note };
  }

  // ── changes and undo (WP11) ───────────────────────────────────────────
  //
  // The hunk tracker holds a pre-edit baseline for every file the session
  // touched; these reads and the three actions below are ALL of it this app
  // uses, and none of them is a git operation (D25) — a reject rewrites the
  // file on disk to its baseline and never touches git state. The wire facts
  // that shape every method here are CONFIRMED on 1.0.0 by the wp11-probe
  // captures (docs/evidence/wp11-probe/):
  //
  //   F1   every reply is double-wrapped at result.result — the EXT_ENVELOPE
  //        rows above, consumed through unwrapExt by name.
  //   F7   there is NO push notification for hunk changes. A reading exists
  //        only because someone asked; the page polls after a turn ends and
  //        on drawer open, never on an idle timer.
  //   F13  an action's {success:true} is an acknowledgement, not a verdict —
  //        affectedCount:0 means nothing changed, and the verdict comes from
  //        re-reading get-files/get-summary afterwards (rule 1). A re-read
  //        that could not be READ is reported as "could not be verified",
  //        never as success and never as an empty state (review round 1,
  //        Opus I1 / Codex 3).

  /**
   * Shape validation, nested (Codex B2 / Grok R2-I2): an outer array whose
   * RECORDS are malformed is unreadable, not zero. A file row without a
   * string path, a turn without an integer promptIndex or a pendingHunks
   * array, a hunk without a string id — each makes its whole reading a read
   * failure, so no verdict is ever computed from a half-parsed payload.
   */
  private filesReadable(payload: any): boolean {
    return (
      Array.isArray(payload?.files) &&
      payload.files.every((f: any) => f && typeof f === "object" && typeof f.path === "string")
    );
  }

  private summaryReadable(summary: any): boolean {
    return (
      summary !== null &&
      typeof summary === "object" &&
      Array.isArray(summary.turns) &&
      summary.turns.every(
        (t: any) =>
          t &&
          typeof t === "object" &&
          Number.isInteger(t.promptIndex) &&
          Array.isArray(t.pendingHunks) &&
          t.pendingHunks.every((h: any) => h && typeof h === "object" && typeof h.id === "string"),
      )
    );
  }

  private hunksReadable(payload: any): boolean {
    return (
      Array.isArray(payload?.hunks) &&
      payload.hunks.every((h: any) => h && typeof h === "object" && typeof h.id === "string")
    );
  }

  /**
   * Every pending hunk, from get-hunks WITHOUT a path — the only read that
   * covers unattributed (external) hunks too (Grok R2-M3: a summary walks
   * turns[] only). Maps id → source.type (null when the record has none), so
   * hunkAction can enforce the director's display-only rule server-side (Opus N9).
   * `ok` false means the read failed, never that the set is empty.
   */
  private async pendingHunksLive(sessionId: string): Promise<{ byId: Map<string, string | null>; ok: boolean }> {
    const raw = await this.acp.request(M.changesHunks, { sessionId }, CONTROL_TIMEOUT_MS);
    const payload = this.unwrapExt(M.changesHunks, raw);
    const ok = this.hunksReadable(payload);
    if (!ok) {
      this.acp.loud(
        `get-hunks (all files) for ${sessionId} returned a success with no readable hunks ` +
          `array in it (${JSON.stringify(payload)}). That is not a reading of zero pending ` +
          `hunks — nothing has been read.`,
      );
    }
    const byId = new Map<string, string | null>();
    if (ok) {
      for (const h of payload.hunks) {
        byId.set(h.id, typeof h.source?.type === "string" ? h.source.type : null);
      }
    }
    return { byId, ok };
  }

  /**
   * Serialize the changes actions per session (Codex 4 / Grok R2-M1): two
   * concurrent accepts of the same file must not both read "listed" before
   * and "gone" after and double-count acceptedByTurn. Queued, never
   * concurrent; a failed action does not block the queue behind it.
   */
  private changeActionChains = new Map<string, Promise<unknown>>();

  private runChangeAction<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.changeActionChains.get(sessionId) ?? Promise.resolve();
    const gated = () => {
      /* Opus N5: dequeue-time liveness. An action that waited behind a slow
         one while the agent died must not fire into a dead (or freshly
         respawned) process — re-verify at the front of the queue, not only
         at enqueue. Both are pre-wire refusals (400). */
      this.requireReady();
      this.require(sessionId);
      return fn();
    };
    const next = prev.then(gated, gated);
    this.changeActionChains.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * The second half of the mid-turn guard (Codex 1 / Opus F3 / Grok R2-I1).
   * The entry check is separated from the wire send by pre-read round-trips,
   * and startTurn is SYNCHRONOUS — a prompt posted from another window during
   * those awaits sets rec.turn before the action fires. Re-checked against
   * the epoch captured at entry, immediately before the send; an epoch that
   * moved means a turn started (and possibly already finished) in the window.
   * Refusal here is pre-wire, so badRequest (400) is earned: nothing was sent.
   */
  private requireStillIdle(rec: SessionRecord, epoch: number, what: string) {
    if (rec.turn || this.cwdEpoch(rec) !== epoch || this.busySibling(rec)) {
      const err: any = new Error(
        `a turn started on ${rec.turn ? "this session" : "a session in the same folder"} while ` +
          `the pre-action reads were in flight — ${what} is refused BEFORE the write. ` +
          `Nothing was sent; try again when the turn ends.`,
      );
      err.badRequest = true;
      throw err;
    }
  }

  /**
   * Post-send error shield (Opus F7): once the action request has resolved,
   * NOTHING thrown downstream may map to a 400 — the page reads 400 as
   * "nothing was sent", which after a send would be a lie about the disk.
   * Re-raised without badRequest, marked `sent` (the HTTP classifier honours
   * that flag before any message regex — Opus M2; agent text embedded in an
   * error message can match an unanchored pattern, and this makes that
   * irrelevant), so it lands as a 500: "sent, could not be verified".
   */
  private async postSend<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e: any = new Error(
        `the ${what} was SENT, but a post-send step failed: ${(err as Error).message} — ` +
          `the result could not be verified.`,
      );
      e.sent = true;
      throw e;
    }
  }

  /**
   * The action send itself, shielded the same way (Opus M2): a rejection here
   * is the genuinely ambiguous case — the request may have reached the agent
   * — so it must never surface as a 400 "nothing was changed", and its
   * (possibly agent-supplied) message text must never reach the caller-error
   * regex. The `sent` flag makes that structural.
   */
  private async sendAction(what: string, method: string, params: Record<string, unknown>): Promise<any> {
    try {
      return await this.acp.request(method, params, CONTROL_TIMEOUT_MS);
    } catch (err) {
      const e: any = new Error(
        `the ${what} request itself failed: ${(err as Error).message} — whether it reached ` +
          `the agent is unknown.`,
      );
      e.sent = true;
      throw e;
    }
  }

  /**
   * Refuse a changes ACTION while a turn is in flight on the session (Codex
   * 2, Grok I4): the tracker can list a running turn's pending hunks, and an
   * undo fired into a turn that is still writing races the agent on the same
   * files. Reads stay allowed — the pane may show pending state mid-turn; it
   * just must not act on it.
   *
   * The scope is the FOLDER, not the record (Opus N1): a turn running on a
   * SECOND session with the same cwd writes the same files, so it blocks the
   * action exactly as this session's own turn would.
   */
  private requireIdle(rec: SessionRecord, what: string) {
    if (rec.turn) {
      const err: any = new Error(
        `a turn is still running on session ${rec.sessionId} — ${what} is refused until it ` +
          `ends. An undo fired mid-turn would race the agent's own writes on disk.`,
      );
      err.badRequest = true;
      throw err;
    }
    const sibling = this.busySibling(rec);
    if (sibling) {
      const err: any = new Error(
        `a turn is still running on session ${sibling.sessionId}, which is open in the same ` +
          `folder — ${what} is refused until it ends. An undo fired now could race that ` +
          `session's writes on the same files.`,
      );
      err.badRequest = true;
      throw err;
    }
  }

  /**
   * The record's canonical folder, resolved once and cached on the record
   * (Codex, final round: symlink aliases of the same folder must not slip
   * the sibling-turn guard). A gone or unreadable cwd falls back to the
   * string form — this never throws; a fallback just means "compared as
   * spelled", which is the old behaviour and fails open only toward
   * DIFFERENT folders.
   */
  private canonCwd(rec: SessionRecord): string {
    if (rec.cwdReal === undefined) {
      /* canonicalPath (fs-browse) realpaths the longest existing prefix and
         never throws — a gone folder degrades to the string spelling, which
         fails open only toward DIFFERENT folders. */
      rec.cwdReal = canonicalPath(rec.cwd);
    }
    return rec.cwdReal;
  }

  /** Another live held session in the same folder with a turn in flight, if any. */
  private busySibling(rec: SessionRecord): SessionRecord | null {
    for (const s of this.sessions.values()) {
      if (s !== rec && s.live && this.canonCwd(s) === this.canonCwd(rec) && s.turn) return s;
    }
    return null;
  }

  /** The sum of turn epochs across the session and its same-folder siblings. */
  private cwdEpoch(rec: SessionRecord): number {
    let sum = rec.turnEpoch;
    for (const s of this.sessions.values()) {
      if (s !== rec && this.canonCwd(s) === this.canonCwd(rec)) sum += s.turnEpoch;
    }
    return sum;
  }

  /**
   * Refuse a non-absolute path locally, before the wire. Not tidiness: the
   * tracker answers a relative path with a SUCCESSFUL EMPTY result (F13),
   * which would render on the page as "no changes" while the file sits
   * changed — the silent-empty trap this method exists to close.
   */
  private requireAbsolutePath(path: string) {
    if (typeof path !== "string" || !isAbsolute(path)) {
      const err: any = new Error(
        `'${path}' is not an absolute path. The hunk tracker answers a relative path with a ` +
          `successful EMPTY result, which would read as "no changes" while the file is ` +
          `changed — refused locally and NOT sent.`,
      );
      err.badRequest = true;
      throw err;
    }
  }

  /**
   * The bridge-event shape of a reading: paths, counts, flags and turn
   * digests — NEVER hunk text (Opus I3). Bridge events are journaled and
   * bounded, and a reading with every hunk's old/new text would evict the
   * conversation history page-reload recovery depends on. The pane lazy-
   * fetches hunk text via /changes/hunks when a file is expanded.
   */
  private changesDigest(reading: ChangesReading) {
    return {
      files: reading.files.map((f) => ({
        path: typeof f?.path === "string" ? f.path : null,
        isAgentFile: typeof f?.isAgentFile === "boolean" ? f.isAgentFile : null,
        staged: typeof f?.staged === "boolean" ? f.staged : null,
        hunkCount: typeof f?.hunkCount === "number" ? f.hunkCount : null,
        additions: typeof f?.additions === "number" ? f.additions : null,
        deletions: typeof f?.deletions === "number" ? f.deletions : null,
      })),
      turns: (Array.isArray(reading.summary?.turns) ? reading.summary.turns : []).map((t: any) => ({
        promptIndex: typeof t?.promptIndex === "number" ? t.promptIndex : null,
        files: Array.isArray(t?.files) ? t.files.filter((p: any) => typeof p === "string") : [],
        pending: Array.isArray(t?.pendingHunks) ? t.pendingHunks.length : 0,
        /* Sorted ids only — the page's reading signature needs them to tell
           same-count/different-hunk readings apart (Codex 2, confirm round).
           Still no hunk TEXT anywhere in a bridge event (Opus I3). */
        hunkIds: Array.isArray(t?.pendingHunks)
          ? t.pendingHunks.map((h: any) => h?.id).filter((id: any) => typeof id === "string").sort()
          : [],
      })),
      filesOk: reading.filesOk,
      summaryOk: reading.summaryOk,
      externalIds: reading.externalIds,
      externalIdsOk: reading.externalIdsOk,
      /* WP12 F2: ride the digest too, so every window's pane sees it. */
      suspect: reading.suspect === true,
      gitDirty: typeof reading.gitDirty === "boolean" ? reading.gitDirty : null,
    };
  }

  /**
   * One reading of the pending changes: the changed-file list plus the
   * per-turn summary, taken together so a caller never holds one without the
   * other.
   *
   * `filesOk` / `summaryOk` are the reading's honesty flags (Opus I1, Codex
   * 3): a successful reply with no files array, or a summary with no turns
   * array, is NOT a reading of zero — it is a read failure, flagged false
   * and said loudly, and every verdict below requires a positively-read
   * absence rather than treating "could not parse" as "nothing pending".
   */
  async changes(sessionId: string): Promise<ChangesReading> {
    this.requireReady();
    const rec = this.require(sessionId);
    const rawFiles = await this.acp.request(M.changesFiles, { sessionId }, CONTROL_TIMEOUT_MS);
    const rawSummary = await this.acp.request(M.changesSummary, { sessionId }, CONTROL_TIMEOUT_MS);
    /* The no-path get-hunks read joins them (Codex, final round): external /
       unattributed hunks never appear in summary.turns, and without their
       ids two readings that differ only in an external hunk collide in the
       page's signature and show stale text. One more loopback read per
       poll, and polls happen only at the four refresh moments (F7) — never
       on an idle timer — so this is bounded by user action. */
    const rawAll = await this.acp.request(M.changesHunks, { sessionId }, CONTROL_TIMEOUT_MS);
    const filesPayload = this.unwrapExt(M.changesFiles, rawFiles);
    const summary = this.unwrapExt(M.changesSummary, rawSummary);
    const allPayload = this.unwrapExt(M.changesHunks, rawAll);

    const filesOk = this.filesReadable(filesPayload);
    if (!filesOk) {
      this.acp.loud(
        `get-files for ${sessionId} returned a success with no readable files array in it ` +
          `(${JSON.stringify(filesPayload)}). That is not a reading of zero changes — ` +
          `nothing has been read.`,
      );
    }
    const summaryOk = this.summaryReadable(summary);
    if (!summaryOk) {
      this.acp.loud(
        `get-summary for ${sessionId} returned a success with no readable turns array in it ` +
          `(${JSON.stringify(summary)}). Malformed records are unreadable, not zero — ` +
          `nothing has been read.`,
      );
    }
    const externalIdsOk = this.hunksReadable(allPayload);
    if (!externalIdsOk) {
      this.acp.loud(
        `get-hunks (all files) for ${sessionId} returned a success with no readable hunks ` +
          `array in it (${JSON.stringify(allPayload)}). External-hunk identity is unknown — ` +
          `the reading is flagged, never treated as "no external changes".`,
      );
    }
    const reading: ChangesReading = {
      files: filesOk ? filesPayload.files : [],
      filesOk,
      summary: summaryOk ? summary : null,
      summaryOk,
      externalIds: externalIdsOk
        ? allPayload.hunks
            .filter((h: any) => h.source?.type !== "agentEdit")
            .map((h: any) => h.id)
            .sort()
        : null,
      externalIdsOk,
    };

    /* WP12 F2 (Codex B1/B2, reconciled): a suspect session's EMPTY reading is
       not evidence of clean — cross-check it. The flag clears ONLY on a
       positively non-empty get-files reading: accepting a file requires
       seeing it listed first, and a healthy human edit surfaces as non-empty,
       so neither false-positives the clear. The cross-check rides THIS path,
       so it happens on every poll of a suspect session — the drawer opens,
       the turn.completed reads, and the ~3s delayed re-reads after actions
       all re-check WHILE THE FLAG IS SET. The flag arms only at
       death-with-turn-in-flight and never re-arms: a tracker that wedges
       later, without a death, is not caught — that gap is recorded, not
       papered over. Never on non-suspect sessions, never on non-empty
       readings — the always-on check both Grok and Opus rejected is not
       built. */
    if (rec.trackerSuspect && reading.filesOk && reading.files.length > 0) {
      /* ANY non-empty reading clears — including one holding an unattributed
         hunk a different session wrote into the same folder. That is correct,
         not a hole: the flag means "this tracker may be blind", and a
         non-empty reading disproves blindness. (PM ruling, WP12 delta.) */
      rec.trackerSuspect = false;
    }
    if (rec.trackerSuspect && reading.filesOk && reading.files.length === 0) {
      reading.suspect = true;
      reading.gitDirty = await this.gitDirty(rec);
    }
    this.bridge("bridge.changes_reading", { sessionId, ...this.changesDigest(reading) }, undefined, sessionId);
    return reading;
  }

  /** Loud once per cause per session — a polled suspect session must not
      flood the log on every reading (Opus NEW-8). A SET of causes, not the
      last one: alternating causes (a flaky agent timing out, then returning
      junk, then timing out) must each speak exactly once (Codex final M2). */
  private loudCrossCheck(rec: SessionRecord, cause: string, message: string) {
    (rec.crossCheckLouded ??= new Set());
    if (rec.crossCheckLouded.has(cause)) return;
    rec.crossCheckLouded.add(cause);
    this.acp.loud(message);
  }

  /**
   * The F2 cross-check: is this session's folder dirty per `_x.ai/git/status`?
   * true / false / null (unreadable — never guessed). The reply is
   * double-wrapped and the payload is GitStatusData — CONFIRMED from wire
   * bytes in the WP12 delta run (artifact 32-gitstatus-wire-raw.txt:
   * `{root, mainRoot, isWorktree, branch, commit, staged[], unstaged[]}`,
   * entry paths repo-relative).
   *
   * The reply is REPO-rooted and the sentence says "this folder" (Opus B2),
   * so the count is scoped to paths under the session's cwd: when `root`
   * equals the cwd the whole reply counts; a subdirectory session counts
   * only its own subtree; a root that is not an ancestor of the cwd means
   * the reply cannot answer the folder's question, and the check is null.
   * Untracked files count (upstream's includeUntracked default), because a
   * human's edit is exactly what the wedge hides. The call is awaited inline
   * in changes() — bounded by CONTROL_TIMEOUT_MS, and only ever on a suspect
   * session's empty reading, so the pane never pays it otherwise.
   *
   * Two more CONFIRMED wire facts from the same probe round: untracked
   * entries arrive as full file paths, never collapsed directory entries
   * (38-gitstatus-untracked-*.json/txt), and the reply is served from a
   * SECONDS-SCALE cache (39-gitstatus-cache-cadence.json) — a read taken
   * immediately after a write can miss the dirt. In practice the pane's
   * existing ~3s-delayed re-reads after its own actions are what cover that
   * window; the first read is the possibly-stale one. Stated honestly (Opus
   * final M6): those re-reads fire after the pane's OWN actions — a suspect
   * session whose first read lands inside the cache window reads clean and
   * stays that way until something re-reads it. The window is seconds and
   * the respawn path is slow; the hole is recorded, not closed.
   */
  private async gitDirty(rec: SessionRecord): Promise<boolean | null> {
    try {
      const raw = await this.acp.request(
        M.gitStatus,
        { sessionId: rec.sessionId, includeUntracked: true },
        CONTROL_TIMEOUT_MS,
      );
      const payload = this.unwrapExt(M.gitStatus, raw);
      if (
        !payload || typeof payload !== "object" ||
        !Array.isArray(payload.staged) || !Array.isArray(payload.unstaged)
      ) {
        this.loudCrossCheck(rec, "unreadable",
          `git/status for ${rec.sessionId} returned an unreadable payload ` +
            `(${JSON.stringify(payload)}) — the tracker-suspect cross-check could not be taken.`,
        );
        return null;
      }
      const entries = [...payload.staged, ...payload.unstaged];
      const root = typeof payload.root === "string" ? payload.root : null;
      if (root === null) return entries.length > 0; // no root to scope by — count as read
      /* Grok C2 / Opus NEW-3: compare against the CANONICAL cwd — git
         reports a realpath'd root, and an as-spelled symlink cwd would make
         every check a non-ancestor null. */
      const rel = relative(root, this.canonCwd(rec));
      if (rel === "") return entries.length > 0; // the session sits AT the repo root
      if (rel.startsWith("..") || isAbsolute(rel)) {
        this.loudCrossCheck(rec, "non-ancestor",
          `git/status for ${rec.sessionId} answered about root ${root}, which is not an ` +
            `ancestor of the session's folder ${rec.cwd} — the cross-check cannot be scoped, ` +
            `so it is not taken.`);
        return null;
      }
      /* The session is a subdirectory: count only its own subtree. Counted as
         IN-SCOPE (the warning is the safe direction): an entry with no
         string path, an absolute path, or a "./"-relative one (Codex round
         3 — a malformed-but-string path must never read as clean). And a
         collapsed wholly-untracked DIRECTORY entry is an ANCESTOR of the
         session's subtree and counts too (Opus NEW-1). The collapse shape
         turned out NOT to occur on 1.0.0 — CONFIRMED by the wire probe
         (docs/evidence/wp12/38-gitstatus-untracked-shapes.json +
         38-gitstatus-untracked-wire.txt): with includeUntracked:true the
         reply carries full file paths (a/b/x.txt), never the collapsed a/
         entry shell `git status --short` shows. The ancestor clause stays as
         deliberate defense — it is correct under both shapes and costs
         nothing. */
      const prefix = rel + "/";
      return entries.some((e: any) => {
        const p = e?.path;
        if (typeof p !== "string" || isAbsolute(p)) return true;
        const norm = p.startsWith("./") ? p.slice(2) : p;
        /* Shape validation (Codex final M3 / Grok R2): anything that is not a
           plain repo-relative path — "", ".", "./", "../outside" — counts as
           in-scope. A malformed string must never read as clean. */
        if (norm === "" || norm === "." || norm === ".." || norm.startsWith("../")) return true;
        /* Grok R3 (round 5): dot-only or dot-segment shapes ("...",
           "foo/../../x") are not plain repo-relative paths either — the same
           in-scope rule. Residual, stated: a hostile shape outside BOTH
           shape gates could still read as clean, but every path shape
           confirmed on 1.0.0 (artifacts 32/38) is a plain repo-relative file
           path, and this gate only ever fires for a suspect session. */
        if (/^[./]+$/.test(norm) || norm.split("/").includes("..")) return true;
        const d = norm.endsWith("/") ? norm.slice(0, -1) : norm;
        return d === rel || norm.startsWith(prefix) || rel.startsWith(d + "/");
      });
    } catch (err) {
      this.loudCrossCheck(rec, "request-failed",
        `git/status for ${rec.sessionId} failed: ${(err as Error).message} — the ` +
          `tracker-suspect cross-check could not be taken.`);
      return null;
    }
  }

  /**
   * The hunks of one file. Path-scoped get-hunks also returns the file's
   * baseline/current contents (F6); they are passed through verbatim, though
   * the pane draws only the hunks' own old/new text. `hunksOk` is the same
   * honesty flag as changes()'s: a reply with no hunks array is a read
   * failure, not an empty file (Grok I2).
   */
  async hunks(sessionId: string, path: string) {
    this.requireReady();
    this.require(sessionId);
    this.requireAbsolutePath(path);
    const raw = await this.acp.request(M.changesHunks, { sessionId, path }, CONTROL_TIMEOUT_MS);
    const payload = this.unwrapExt(M.changesHunks, raw);
    const hunksOk = this.hunksReadable(payload);
    if (!hunksOk) {
      this.acp.loud(
        `get-hunks for ${path} returned a success with no readable hunks array in it ` +
          `(${JSON.stringify(payload)}). That is not a reading of zero hunks — nothing has ` +
          `been read.`,
      );
    }
    return {
      hunks: hunksOk ? payload.hunks : [],
      hunksOk,
      baseline: payload?.baseline ?? null,
      current: payload?.current ?? null,
    };
  }

  /**
   * Undo one of the agent's hunks (reject → the file on disk is rewritten to
   * its pre-edit baseline for that hunk; siblings are byte-untouched, F9).
   *
   * The verdict is the read-back's, never the ack's (F13, rule 1):
   * affectedCount:0 is "nothing changed" — not a success, not a thrown error
   * — an ack that claims an effect the re-read cannot see is said as exactly
   * that, and a re-read that could not be read is "the action was sent but
   * the result could not be verified", NEVER a success (Opus I1).
   */
  async hunkAction(sessionId: string, hunkId: string, action: "reject") {
    this.requireReady();
    const rec = this.require(sessionId);
    if (typeof hunkId !== "string" || hunkId.trim() === "") {
      const err: any = new Error("hunkId is required and must be a non-empty string");
      err.badRequest = true;
      throw err;
    }
    return this.runChangeAction(sessionId, async () => {
      let raw: any;
      let before: { byId: Map<string, string | null>; ok: boolean };
      try {
        const epoch = this.cwdEpoch(rec);
        this.requireIdle(rec, "undoing a hunk");
        /* Membership — and SOURCE — come from get-hunks WITHOUT a path: the
           read that also covers unattributed (external) hunks (Grok R2-M3),
           and the only place a server-side answer to "is this the agent's
           hunk" exists. The director's GO is enforced HERE, not only in the page
           (Opus N9): a pending hunk the tracker does not attribute to the
           agent is refused before the wire. */
        before = await this.pendingHunksLive(sessionId);
        /* Opus final I1: an unreadable membership read refuses too. Every
           sibling gate fails closed on an unreadable read; this one must not
           be the exception — the tracker re-attributes hunks on rescan
           (evidence wp11/11), and firing blind could reject a hunk that now
           holds the operator's own work. */
        if (!before.ok) {
          const err: any = new Error(
            `the pre-action read of the pending hunks could not be read — the undo is refused ` +
              `rather than fired blind (an unreadable read cannot say whether this hunk is the ` +
              `agent's). Nothing was sent; try again.`,
          );
          err.badRequest = true;
          throw err;
        }
        if (before.byId.has(hunkId) && before.byId.get(hunkId) !== "agentEdit") {
          const err: any = new Error(
            `undo is only available for changes the tracker attributes to the agent — this ` +
              `hunk's source is '${before.byId.get(hunkId) ?? "unknown"}'. Refused locally and NOT sent.`,
          );
          err.badRequest = true;
          throw err;
        }
        this.requireStillIdle(rec, epoch, "undoing a hunk");
      } catch (err) {
        /* Provably pre-wire (the action request has not run): marked so the
           page never appends its "may have been sent" clause (Opus N2). */
        (err as any).notSent = true;
        throw err;
      }
      raw = await this.sendAction("hunk undo", M.hunkAction, { sessionId, hunkId, action });
      const ack = this.unwrapExt(M.hunkAction, raw);
      /* Everything past the send is shielded: a failure there is a 500 "sent
         but could not be verified", never a 400 (postSend — Opus F7). */
      const after = await this.postSend("hunk undo", () => this.pendingHunksLive(sessionId));
      const reading = await this.postSend("hunk undo", () => this.changes(sessionId));

      const affected = typeof ack?.affectedCount === "number" ? ack.affectedCount : null;
      /* before.ok is guaranteed (an unreadable pre-read refused above), so
         wasPending is a certain boolean; only the AFTER read can be unknown. */
      const wasPending = before.byId.has(hunkId);
      const stillPending = after.ok ? after.byId.has(hunkId) : null;
      /* A positively-READ absence is required for success: was pending before,
         gone after, both halves readable. */
      const changed = wasPending && stillPending === false;
      const note = !after.ok
        ? `The undo was sent, but the result could not be verified — the post-action re-read ` +
          `came back unreadable. The ack claimed affectedCount ${affected ?? "?"}; check the ` +
          `pane (it re-reads) before assuming anything about the file on disk.`
        : changed
          ? `Undone — the hunk left the pending set in the re-read (affectedCount: ${affected ?? "?"}).`
          : stillPending === true
            ? affected === 0
              ? `Nothing changed: hunk-action was acknowledged with affectedCount 0 and the hunk ` +
                `is still pending in the re-read.`
              : `hunk-action reported affectedCount ${affected ?? "?"} but the hunk is STILL pending ` +
                `in the re-read. The ack is not evidence — the undo cannot be confirmed.`
            : `Nothing changed that this build can see: the hunk was not pending before the ` +
              `action and is not after it — already resolved, or never in this session's ` +
              `pending set. The ack reported affectedCount ${affected ?? "?"}.`;
      if (changed) this.acp.note(note);
      else this.acp.loud(note);
      this.bridge(
        "bridge.change_acted",
        { sessionId, kind: "hunk", target: hunkId, affected, changed, reading: this.changesDigest(reading) },
        note,
        sessionId,
      );
      return { ack, affected, changed, note, reading };
    });
  }

  /**
   * Mark one file reviewed (accept): the content stays on disk exactly as it
   * is and the file leaves the pending list. Accept never stages — git status
   * is untouched (F11). The safe direction, so the page fires it without a
   * confirm (D63).
   *
   * `expectedHunkIds` binds the accept to what the operator actually SAW
   * (Codex 5): the page sends the hunk ids of the reading it displayed, and
   * they are compared against a fresh get-hunks before anything is sent. A
   * mismatch means the file changed since it was read — refused locally with
   * "re-read it", never applied to hunks nobody reviewed.
   */
  async fileAction(sessionId: string, path: string, action: "accept", expectedHunkIds?: unknown) {
    this.requireReady();
    const rec = this.require(sessionId);
    this.requireAbsolutePath(path);
    if (!Array.isArray(expectedHunkIds) || expectedHunkIds.some((id) => typeof id !== "string")) {
      const err: any = new Error(
        `fileAction requires the hunk ids of the reading the operator saw (an array of ` +
          `strings, empty included) — an accept without them would apply to hunks nobody ` +
          `reviewed. Refused locally and NOT sent.`,
      );
      err.badRequest = true;
      throw err;
    }
    return this.runChangeAction(sessionId, async () => {
      let before: ChangesReading;
      let raw: any;
      try {
        const epoch = this.cwdEpoch(rec);
        this.requireIdle(rec, "marking a file reviewed");
        before = await this.changes(sessionId);
        /* Codex 1 (confirm round): the digest is verified as LATE as the flow
           allows — after the before-read, with only synchronous guards
           between it and the send. A filesystem write landing earlier in the
           action can no longer swap the hunk set under an approval given for
           a different one. (Still not a true compare-and-swap: the wire gets
           no ids, so a write landing DURING the send is a window no client
           can close.) */
        const seen = await this.hunks(sessionId, path);
        /* Codex I3 / Opus F2: an UNREADABLE confirming read must refuse —
           never compare []≡[] and send, and never call it "changed since you
           read it" when nothing was read at all. */
        if (!seen.hunksOk) {
          const err: any = new Error(
            `the confirming re-read of this file's hunks could not be read — the accept is ` +
              `refused rather than compared against a read failure. Nothing was sent; try again.`,
          );
          err.badRequest = true;
          throw err;
        }
        const seenIds = seen.hunks.map((h: any) => h.id).sort();
        const expected = [...(expectedHunkIds as string[])].sort();
        if (seenIds.length !== expected.length || seenIds.some((id, i) => id !== expected[i])) {
          const err: any = new Error(
            `this file changed since you read it — the pending hunks are no longer the ones you ` +
              `saw (${expected.length} then, ${seenIds.length} now). Re-read it before marking it ` +
              `reviewed. Refused locally and NOT sent.`,
          );
          err.badRequest = true;
          throw err;
        }
        this.requireStillIdle(rec, epoch, "marking a file reviewed");
      } catch (err) {
        /* Provably pre-wire (the action request has not run): marked so the
           page never appends its "may have been sent" clause (Opus N2). */
        (err as any).notSent = true;
        throw err;
      }
      raw = await this.sendAction("accept", M.fileAction, { sessionId, path, action });
      const ack = this.unwrapExt(M.fileAction, raw);
      /* Everything past the send is shielded (postSend — Opus F7). */
      const after = await this.postSend("accept", () => this.changes(sessionId));

      const affected = typeof ack?.affectedCount === "number" ? ack.affectedCount : null;
      const listed = (r: ChangesReading) => r.filesOk && r.files.some((f) => f?.path === path);
      const wasListed = listed(before);
      const stillListed = listed(after);
      /* A positively-READ absence is required: an unreadable after-read is
         never "the file left the list" (Codex 3). */
      const changed = after.filesOk && wasListed && !stillListed;
      /* Codex 1's bookkeeping: a confirmed accept counts this file's hunks
         against the turns they were pending under, so a later turn-undo can
         say how much of the turn was already reviewed instead of promising
         "everything". Actions are serialized per session (runChangeAction),
         so two concurrent accepts cannot both see "listed → gone" and
         double-count (Codex 4). */
      if (changed && before.summaryOk) {
        for (const t of before.summary.turns) {
          if (!Number.isInteger(t?.promptIndex) || !Array.isArray(t?.pendingHunks)) continue;
          const n = t.pendingHunks.filter((h: any) => h?.path === path).length;
          if (n > 0) rec.acceptedByTurn.set(t.promptIndex, (rec.acceptedByTurn.get(t.promptIndex) ?? 0) + n);
        }
      }
      const note = !after.filesOk
        ? `The accept was sent, but the result could not be verified — the post-action re-read ` +
          `came back unreadable. The ack claimed affectedCount ${affected ?? "?"}; check the ` +
          `pane (it re-reads) before assuming the file left the pending list.`
        : changed
          ? `Marked as reviewed — the file left the pending list in the re-read. Its content ` +
            `stays on disk exactly as it is; nothing was staged.`
          : !before.filesOk
            ? `The file is not in the pending list in the re-read, but the pre-action read was ` +
              `unreadable — whether the accept did that cannot be confirmed.`
            : stillListed
              ? affected === 0
                ? `Nothing changed: file-action was acknowledged with affectedCount 0 and the file ` +
                  `is still in the pending list.`
                : `file-action reported affectedCount ${affected ?? "?"} but the file is STILL in the ` +
                  `pending list in the re-read. The ack is not evidence — the accept cannot be confirmed.`
              : `Nothing changed: the file was not in the pending list before the action and is ` +
                `not after it.`;
      if (changed) this.acp.note(note);
      else this.acp.loud(note);
      this.bridge(
        "bridge.change_acted",
        { sessionId, kind: "file", target: path, affected, changed, reading: this.changesDigest(after) },
        note,
        sessionId,
      );
      return { ack, affected, changed, note, reading: after };
    });
  }

  /**
   * Undo everything still pending from one turn (reject by promptIndex):
   * exactly that turn's PENDING agent edits revert, across files; a human's
   * external edit is never in a turn's scope and survives (F10 — the WP11
   * acceptance property).
   *
   * Two identity gates, both fail-closed, before anything goes on the wire
   * (B1 — an ordinal-mapped index can name the WRONG turn after a reload):
   *
   *   1. The promptIndex must be one this tracker lifetime actually reported
   *      on the agent's echo of the user's message (seenPromptIndexes —
   *      replayed history is never seeded in, and the set is cleared when the
   *      agent process dies; on 1.0.0 numbering is measured to CONTINUE
   *      across a respawn, but that is only knowable after the fact, so the
   *      gate stays fail-closed against a build that restarts it).
   *   2. get-summary must list that index with pending hunks.
   *
   * The sentence is built from the read-back and scoped honestly (Codex 1):
   * it says how many changes were still pending and reverted, and how many
   * had already been marked as reviewed — never "everything was undone".
   */
  async turnAction(sessionId: string, promptIndex: number, action: "reject") {
    this.requireReady();
    const rec = this.require(sessionId);
    if (!Number.isInteger(promptIndex) || (promptIndex as number) < 0) {
      const err: any = new Error(
        `promptIndex is required and must be a non-negative integer taken from get-summary's ` +
          `turns[] — got ${JSON.stringify(promptIndex)}. Refused locally and NOT sent.`,
      );
      err.badRequest = true;
      throw err;
    }
    return this.runChangeAction(sessionId, async () => {
      let before: ChangesReading;
      let pending: number;
      let raw: any;
      try {
        const epoch = this.cwdEpoch(rec);
        this.requireIdle(rec, "undoing a turn");
        if (!rec.seenPromptIndexes.has(promptIndex)) {
          const err: any = new Error(
            `the tracker has not reported promptIndex ${promptIndex} for this session in this ` +
              `process's lifetime (it stamps it on the echo of the user's message). Without that ` +
              `stamp the index cannot be tied to a turn this build can vouch for — refused ` +
              `locally and NOT sent, because an index aimed by ordinal arithmetic can name the ` +
              `wrong turn after a reload.`,
          );
          err.badRequest = true;
          throw err;
        }
        before = await this.changes(sessionId);
        if (!before.summaryOk) {
          /* Fail closed: the membership gate below is meaningless without a
             readable summary, and firing anyway would be aiming blind. This is a
             read failure, not a caller error — hence no badRequest (500). The
             notSent marker from the surrounding catch keeps the page's
             sentence single-minded (Opus N2). */
          throw new Error(
            `get-summary could not be read, so the turn's pending membership cannot be verified ` +
              `— the undo was NOT sent.`,
          );
        }
        const turns = before.summary.turns;
        const entry = turns.find((t: any) => t?.promptIndex === promptIndex);
        pending = Array.isArray(entry?.pendingHunks) ? entry.pendingHunks.length : 0;
        if (!entry || pending === 0) {
          const err: any = new Error(
            `get-summary lists no turn with promptIndex ${promptIndex} and pending hunks, so there ` +
              `is nothing to undo for it. The page takes a promptIndex only from that summary — ` +
              `refused locally and NOT sent.`,
          );
          err.badRequest = true;
          throw err;
        }
        this.requireStillIdle(rec, epoch, "undoing a turn");
      } catch (err) {
        /* Provably pre-wire (the action request has not run): marked so the
           page never appends its "may have been sent" clause (Opus N2). */
        (err as any).notSent = true;
        throw err;
      }
      raw = await this.sendAction("turn undo", M.turnAction, { sessionId, promptIndex, action });
      const ack = this.unwrapExt(M.turnAction, raw);
      /* Everything past the send is shielded (postSend — Opus F7). */
      const after = await this.postSend("turn undo", () => this.changes(sessionId));

      const affected = typeof ack?.affectedCount === "number" ? ack.affectedCount : null;
      const afterEntry = after.summaryOk
        ? after.summary.turns.find((t: any) => t?.promptIndex === promptIndex)
        : undefined;
      const stillPending = after.summaryOk
        ? Array.isArray(afterEntry?.pendingHunks)
          ? afterEntry.pendingHunks.length
          : 0
        : null;
      const changed = stillPending === 0;
      const alreadyReviewed = rec.acceptedByTurn.get(promptIndex) ?? 0;
      const note = !after.summaryOk
        ? `The undo was sent, but the result could not be verified — the post-action re-read ` +
          `came back unreadable. The ack claimed affectedCount ${affected ?? "?"}; check the ` +
          `pane (it re-reads) before assuming anything about the files on disk.`
        : changed
          ? `Reverted the ${pending} change(s) this turn still had pending — the re-read shows ` +
            `none left for it (affectedCount: ${affected ?? "?"}).` +
            (alreadyReviewed > 0
              ? ` ${alreadyReviewed} hunk(s) you had already marked as reviewed were not pending ` +
                `and were outside this undo's scope.`
              : ``)
          : affected === 0
            ? `Nothing changed: turn-action was acknowledged with affectedCount 0 and the turn's ` +
              `hunks are still pending in the re-read.`
            : `turn-action reported affectedCount ${affected ?? "?"} but ${stillPending} of the turn's ` +
              `hunks are STILL pending in the re-read. The ack is not evidence — the undo cannot ` +
              `be confirmed.`;
      if (changed) this.acp.note(note);
      else this.acp.loud(note);
      this.bridge(
        "bridge.change_acted",
        { sessionId, kind: "turn", target: promptIndex, affected, changed, reading: this.changesDigest(after) },
        note,
        sessionId,
      );
      return { ack, affected, changed, note, reading: after };
    });
  }

  // ── turns ─────────────────────────────────────────────────────────────

  /** Start a turn. Resolves as soon as it is accepted; the turn runs out of band. */
  startTurn(sessionId: string, text: string): void {
    const rec = this.require(sessionId);
    if (rec.turn) {
      throw new Error(`a turn is already running on session ${sessionId}`);
    }

    // session/prompt is deliberately not timed out — a turn can legitimately
    // take as long as a conversation. But an agent that has gone quiet and an
    // agent that is thinking look identical from here, so say which. Per
    // session, because "quiet" is now a question about one session among several.
    const watchdog = setInterval(() => {
      if (this.openInteractions.size > 0) return; // silence is expected: waiting on a human
      const quietFor = Date.now() - this.acp.lastInboundAt;
      if (quietFor > STALL_WARN_MS) {
        this.acp.loud(
          `no output from the agent for ${Math.round(quietFor / 1000)}s while a turn is in ` +
            `flight on ${sessionId} — it may be wedged`,
        );
      }
    }, STALL_CHECK_MS);
    rec.turn = { startedAt: Date.now(), watchdog };
    rec.turnEpoch++; // WP11: the changes actions re-check this before their wire send

    // The prompt text rides along on the turn's own start event (D36), so a pane
    // can draw the user's message from an event rather than from the fact that it
    // was the tab that typed it. A second window, or the same window after a
    // reload, otherwise shows a turn with no question in it. The consumer
    // deduplicates this against any `message.user` that arrives for the same
    // turn, because whether the agent echoes the prompt back live was not known
    // when this was written.
    this.bridge("turn.started", { sessionId, text }, undefined, sessionId);

    void (async () => {
      try {
        const result = await this.acp.request(M.sessionPrompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        const stop = result?.stopReason;
        this.acp.note(
          `session/prompt on ${sessionId} returned — stopReason: ${stop ?? "(none)"}`,
          result,
        );
        // A turn that ends for any reason other than finishing its work is not
        // a success, even though the request succeeded.
        if (stop && stop !== "end_turn") {
          this.acp.loud(`turn on ${sessionId} ended early — stopReason '${stop}'`);
        }
        this.bridge(
          "turn.finished",
          { sessionId, stopReason: stop ?? null, result },
          stop && stop !== "end_turn"
            ? `The turn ended with stopReason '${stop}'. The request succeeded; the turn did ` +
              `not finish its work.`
            : undefined,
          sessionId,
        );
      } catch (err) {
        const message = (err as Error).message;
        this.acp.loud(`turn on ${sessionId} failed: ${message}`);
        this.bridge("turn.failed", { sessionId, error: message }, message, sessionId);
      } finally {
        const current = this.sessions.get(sessionId);
        if (current?.turn) {
          clearInterval(current.turn.watchdog);
          current.turn = null;
        }
      }

      // Every turn, whatever happened to it — but only if the session survived
      // it. After a mid-turn death the session is not live and asking would
      // either hang or read somebody else's context.
      if (this.sessions.get(sessionId)?.live) {
        await this.sessionInfo(sessionId).catch(() => null);
      }
    })();
  }

  // ── interactions ──────────────────────────────────────────────────────

  answerInteraction(
    key: string,
    optionId: string | null,
    cancel: boolean,
    extras: { feedback?: unknown; outcome?: unknown; answers?: unknown } = {},
  ): { ok: true; sessionId: string | null } {
    const open = this.openInteractions.get(key);
    if (!open) throw new Error(`no open interaction with key ${key}`);

    const bare = open.method.startsWith("_") ? open.method.slice(1) : open.method;
    const isPlanExit = bare === "x.ai/exit_plan_mode";
    const isQuestion = bare === "x.ai/ask_user_question";

    // A refused answer is the caller's mistake, not an incident — 400, not 500.
    const bad = (message: string) => {
      const err: any = new Error(message);
      err.badRequest = true;
      return err;
    };

    if (isQuestion) return this.answerQuestion(key, open, cancel, extras, bad);

    // `feedback` exists on exactly one wire shape: a plan exit answered
    // "cancelled" — {"outcome":"cancelled","feedback":"…"}. Anywhere else it
    // would be a wrong-but-possibly-silent shape, so it is refused loudly.
    const feedbackRaw = extras.feedback;
    if (feedbackRaw !== undefined && typeof feedbackRaw !== "string") {
      throw bad("feedback must be a string");
    }
    if (extras.outcome !== undefined || extras.answers !== undefined) {
      throw bad(`only a question interaction takes 'outcome' or 'answers'; ${key} is ${open.method}`);
    }
    // Empty or whitespace feedback is not feedback: send plain "cancelled".
    const feedback =
      typeof feedbackRaw === "string" && feedbackRaw.trim() !== "" ? feedbackRaw : null;
    if (feedback !== null && (!isPlanExit || cancel || optionId !== "cancelled")) {
      throw bad("feedback is only valid when a plan exit is answered 'cancelled'");
    }

    if (cancel) {
      this.openInteractions.delete(key);
      this.acp.respond(
        open.id,
        // Flat for a plan exit, for the same reason as `build` above.
        // "cancelled" is also what the shell falls back to when it cannot parse
        // a reply at all, so a mistake here fails in the safe direction.
        isPlanExit ? { outcome: "cancelled" } : { outcome: { outcome: "cancelled" } },
      );
      this.acp.note(`interaction ${key} cancelled by the human`);
      this.bridge(
        "interaction.answered",
        { key, optionId: null, cancelled: true, method: open.method },
        undefined,
        open.sessionId,
      );
      return { ok: true, sessionId: open.sessionId };
    }

    // Only accept a choice that was actually on offer: the agent's own options
    // array for a permission, the protocol's fixed outcome set for a plan exit.
    const offered = isPlanExit
      ? ["approved", "cancelled", "abandoned"]
      : (open.params?.options ?? []).map((o: any) => o.optionId);
    if (optionId === null || !offered.includes(optionId)) {
      const err: any = new Error(`optionId '${optionId}' was not offered by the agent`);
      err.offered = offered;
      throw err;
    }

    this.openInteractions.delete(key);
    const result =
      feedback !== null ? { outcome: "cancelled", feedback } : open.build(optionId);
    this.acp.respond(open.id, result);
    this.acp.note(`interaction ${key} answered — '${optionId}' for ${open.method}`);
    this.bridge(
      "interaction.answered",
      {
        key,
        optionId,
        cancelled: false,
        method: open.method,
        ...(feedback !== null ? { feedback } : {}),
      },
      undefined,
      open.sessionId,
    );
    return { ok: true, sessionId: open.sessionId };
  }

  /**
   * The question branch of answerInteraction. Everything the browser sends is
   * validated against what the agent actually offered — outcome whitelist,
   * plan-mode gating, and every answer value a label from that question's own
   * options. Values are arrays always (canonical 0.2.118 shape,
   * `IndexMap<String, Vec<String>>`): exactly one element for single-select,
   * one-or-more for multiSelect. Completeness on "accepted" is our stricter
   * rule — upstream omits unanswered questions; we never send a partial.
   */
  private answerQuestion(
    key: string,
    open: OpenInteraction,
    cancel: boolean,
    extras: { feedback?: unknown; outcome?: unknown; answers?: unknown },
    bad: (message: string) => Error,
  ): { ok: true; sessionId: string | null } {
    if (extras.feedback !== undefined) {
      throw bad("feedback is only valid when a plan exit is answered 'cancelled'");
    }
    const outcome = cancel ? "cancelled" : extras.outcome;
    if (typeof outcome !== "string" || !QUESTION_OUTCOMES.includes(outcome)) {
      const err: any = bad(`outcome '${String(outcome)}' is not a question outcome`);
      err.offered = QUESTION_OUTCOMES;
      throw err;
    }
    if (
      (outcome === "chat_about_this" || outcome === "skip_interview") &&
      open.params?.mode !== "plan"
    ) {
      throw bad(`'${outcome}' is only valid when the question was asked in plan mode`);
    }

    if (outcome !== "accepted") {
      if (extras.answers !== undefined) {
        throw bad("answers are only valid with outcome 'accepted'");
      }
      this.openInteractions.delete(key);
      this.acp.respond(open.id, open.build(outcome));
      this.acp.note(`interaction ${key} answered — '${outcome}' for ${open.method}`);
      this.bridge(
        "interaction.answered",
        {
          key,
          optionId: null,
          outcome,
          cancelled: outcome === "cancelled",
          method: open.method,
        },
        undefined,
        open.sessionId,
      );
      return { ok: true, sessionId: open.sessionId };
    }

    const questions: any[] = Array.isArray(open.params?.questions)
      ? open.params.questions
      : [];
    const answersRaw = extras.answers;
    if (answersRaw === null || typeof answersRaw !== "object" || Array.isArray(answersRaw)) {
      throw bad("outcome 'accepted' needs an 'answers' object keyed by question text");
    }
    const answers = answersRaw as Record<string, unknown>;

    const knownTexts = new Set(questions.map((q) => String(q?.question ?? "")));
    for (const sent of Object.keys(answers)) {
      if (!knownTexts.has(sent)) throw bad(`'${sent}' is not a question the agent asked`);
    }

    // NULL PROTOTYPE, and it is load-bearing. Question text is agent-controlled
    // (rule 10), and answers go back keyed by it. On a plain object literal,
    // `validated["__proto__"] = […]` hits Object.prototype's setter: it creates
    // no own property, so JSON.stringify emits `{}` and the agent is told the
    // human accepted and answered nothing — a wrong-but-silent reply, the exact
    // class of bug PROJECT-STATE §5 records. Object.create(null) has no such
    // accessor, so the key becomes an ordinary own property and serialises.
    const validated: Record<string, string[]> = Object.create(null);
    for (const q of questions) {
      const text = String(q?.question ?? "");
      const value = answers[text];
      // Our completeness rule: every question answered, always.
      if (value === undefined) throw bad(`no answer for the question '${text}'`);
      if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string")) {
        throw bad(`the answer to '${text}' must be a non-empty array of the offered labels`);
      }
      const offered = (Array.isArray(q?.options) ? q.options : []).map((o: any) =>
        String(o?.label ?? ""),
      );
      for (const label of value) {
        if (!offered.includes(label)) {
          const err: any = bad(`'${label}' was not offered for the question '${text}'`);
          err.offered = offered;
          throw err;
        }
      }
      if (q?.multiSelect !== true && value.length !== 1) {
        throw bad(`'${text}' is single-select — exactly one answer, not ${value.length}`);
      }
      if (new Set(value).size !== value.length) {
        throw bad(`the answer to '${text}' repeats a label`);
      }
      validated[text] = value as string[];
    }

    this.openInteractions.delete(key);
    // Flat, like the plan exit: the payload IS the JSON-RPC result. A malformed
    // reply here does NOT fail closed — upstream fails the agent's tool call
    // loudly (MalformedResponse), the opposite of exit_plan_mode. See the WP6
    // probe record.
    this.acp.respond(open.id, { outcome: "accepted", answers: validated });
    this.acp.note(
      `interaction ${key} answered — ${Object.keys(validated).length} question(s) for ${open.method}`,
    );
    this.bridge(
      "interaction.answered",
      {
        key,
        optionId: null,
        outcome: "accepted",
        answers: validated,
        cancelled: false,
        method: open.method,
      },
      undefined,
      open.sessionId,
    );
    return { ok: true, sessionId: open.sessionId };
  }

  // ── shutdown ──────────────────────────────────────────────────────────

  async stop() {
    this.stopping = true;
    if (this.rosterRefreshTimer) clearTimeout(this.rosterRefreshTimer);
    if (this.rosterPollTimer) clearInterval(this.rosterPollTimer);
    for (const rec of this.sessions.values()) {
      if (rec.turn) clearInterval(rec.turn.watchdog);
      rec.turn = null;
    }
    return this.acp.stop();
  }
}

/**
 * A context reading in one line.
 *
 * The response is FLAT. Upstream builds it as `{session_id, cwd, data}` with
 * `data` serde-flattened, so on the wire `context`, `turns`, `model` and
 * `agentName` all sit at the top level next to `sessionId` — measured on
 * 0.2.114. Reading `info.data.context` finds nothing and reports an empty box.
 */
export function summarizeContext(info: any): string {
  const ctx = contextOf(info);
  if (!ctx) return "session/info returned no context block";
  return (
    `context ${ctx.used} / ${ctx.total} tokens (${ctx.usagePct}% used, ${ctx.freeTokens} free) · ` +
    `turns ${info?.turns ?? "?"} · model ${info?.model ?? "?"}`
  );
}

/** The context block, or null. One reader, so the flat shape is asserted once. */
export function contextOf(info: any): any | null {
  const ctx = info?.context;
  return ctx !== null && typeof ctx === "object" ? ctx : null;
}
