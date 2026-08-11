"use strict";
/* ══════════════════════════════════════════════════════════════════════
   The shell's behaviour.

   FOUR RULES THIS FILE OBEYS, in order of how expensive they are to break:

   1. **EVERY STRING THE AGENT SENDS IS HOSTILE INPUT.** Message text, plan
      markdown, tool names, arguments, filenames, session titles, unknown
      event payloads. All of it is attacker-controlled the moment the agent
      reads a prompt-injected file in somebody's repository, and this page
      holds a token that drives an agent with write access to the disk. So:
      agent content reaches the DOM as TEXT — `textContent`, or a text node,
      or `el(tag, cls, text)` below, which uses `textContent`. There is no
      `innerHTML` in this file and there is no exception for debug surfaces,
      which are the easiest ones to forget. `text()` and `pre()` are the two
      sanctioned ways in. Standing rule 10 in AGENTS.md, D31–D33.

   2. No wire-format string appears below. This page reads `AppEvent.type`,
      which is ours. `studio/events.ts` is the only file that knows what the
      agent actually calls things. (`docs/APP-EVENTS.md` has the grep.)

   3. Nothing the agent reports at runtime is hardcoded: no model list, no
      effort list, no permission labels, no command list, no context total,
      no mode set. Every one of those is rendered from what arrived.

   4. Nothing is invented to fill a gap. Where there is no reading there is
      no number — "not reported", never 0. *(The STUB rule that once stood
      here is historical: WP11 shipped the last stubbed surface, and WP14
      removed the stub styling.)*
   ══════════════════════════════════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);

/* The token comes out of this page's own URL, which is the only way the page
   can have been served at all — `GET /` without it is a 403 (D10). It is not
   substituted into this file: under the Content-Security-Policy this script
   is a separate file with no inline script anywhere, and a static asset the
   server never rewrites cannot leak a secret it never contained.

   Opened straight off disk there is no token, every request is refused, and
   the banner says so — which is the behaviour we want, not a bug. */
const TOKEN = new URLSearchParams(location.search).get("token") || "";
/* Shape test rather than a presence test: a truncated or mangled token would
   otherwise look present and fail on every request with nothing on screen. */
const TOKEN_OK = /^[0-9a-f]{64}$/.test(TOKEN);
/* WP14 (D46): development surfaces — the Shell drawer tab — exist only when
   the server marked this page a development build. The flag rides the page
   the same way the run token does, substituted in at serve time; anything
   else, including a page opened straight off disk, is off. */
const DEV_BUILD = (() => {
  const m = document.getElementById("studioDev");
  return !!m && m.getAttribute("content") === "1";
})();
const SELECTED_SESSION_KEY = "graphometer.selectedSessionId";

function safeStoredSessionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function readStoredSessionId() {
  try { return safeStoredSessionId(sessionStorage.getItem(SELECTED_SESSION_KEY)); }
  catch { return null; }
}

/* `opts.quiet` suppresses the automatic error note. Only for callers that render
   the SAME failure themselves in the shipped "Not <verb> — {reason}. Try again."
   family: without it one failure produces two notices on the strip, the
   automatic sentence and the written one. Every other caller keeps the
   automatic note. */
function post(path, body, opts) {
  const quiet = !!(opts && opts.quiet);
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-studio-token": TOKEN },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    const j = await r.json().catch(() => ({ error: "response was not JSON" }));
    /* The status rides along (WP11, Opus I2): a 400 is a PRE-WIRE refusal —
       nothing was sent — while a 500 can mean the action fired and the
       re-read died. A caller that reports disk effects needs the difference.
       WP12: a failure also carries `details` (path, status, the server's
       sentence) so an error note can offer "Copy details" without the caller
       assembling anything. */
    if (j && typeof j === "object") {
      j.httpStatus = r.status;
      if (j.error) j.details = path + " — HTTP " + r.status + "\n" + j.error;
    }
    /* WP14: the line is the server's own sentence; the raw route and status
       ride in the details behind Copy details, not in the sentence itself —
       wire vocabulary is not user copy. */
    if (j && j.error && !quiet) note("error", j.error, j.details);
    return j;
  }).catch((e) => {
    if (!quiet) note("error", "Could not reach the server — " + e.message + ".", path + " failed — " + e.message);
    return { error: e.message, details: path + " failed — " + e.message };
  });
}

/**
 * After a fresh reconstruction the retained bridge.context_reading events are
 * historical and correctly refused by the live gate — so the meter would stay
 * blank until the next turn. Request a real session/info read-back for the
 * exact selected session. Never omit sessionId (without it the agent answers
 * about an arbitrary hash-map key). Never apply the HTTP body to the meter:
 * only the resulting live bridge.context_reading event may set v.context.
 * catchup_finished must not call this.
 */
function requestFreshContextReading(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  if (contextRefreshInFlight.has(sessionId)) return;
  contextRefreshInFlight.add(sessionId);
  post("/session/info", { sessionId }).finally(() => {
    contextRefreshInFlight.delete(sessionId);
  });
}

const esc = (s) => String(s == null ? "" : s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  /* textContent, always. This is the one place an element gets its content in
     this file, and it cannot produce markup. Rule 1 at the top. */
  if (text !== undefined) n.textContent = String(text);
  return n;
};
const base = (p) => { const s = esc(p).replace(/\/+$/, ""); return s.slice(s.lastIndexOf("/") + 1) || s || "/"; };

/* ── THE TWO SANCTIONED WAYS AGENT TEXT REACHES THE SCREEN ────────────────

   Everything the agent sends goes through one of these. Both end at
   `textContent` or a text node, so a `<script>` tag in a file the agent read
   is five printable characters on screen and nothing else. Rule 1, D31.

   `blockText` exists because a wall of agent prose with its fenced code
   blocks inlined is hard to read, and the alternative — a markdown renderer —
   is a sanitiser we would have to get right (D32). So: split the string on
   fence lines and put the pieces in different elements. There is no parser
   here, nothing is interpreted, and the worst a malformed fence can do is
   put the rest of the message in a monospace box.
   ─────────────────────────────────────────────────────────────────────── */

/** One text node. The floor. */
function textNode(s) { return document.createTextNode(String(s == null ? "" : s)); }

/** A <pre> whose content is text. Used for raw payloads and code fences. */
function pre(cls, s) {
  const n = document.createElement("pre");
  n.className = cls;
  n.textContent = String(s == null ? "" : s);
  return n;
}

/**
 * Agent prose into `parent`: plain segments as text nodes, ``` fenced segments
 * as <pre class="code">. An unclosed fence puts the remainder in a code block,
 * which is what the agent's own output looks like mid-stream anyway.
 */
function blockText(parent, s) {
  const src = String(s == null ? "" : s);
  const lines = src.split("\n");
  let buf = [];
  let fence = null;          /* null, or the info string after the ``` */
  const flushPlain = () => {
    if (!buf.length) return;
    parent.appendChild(textNode(buf.join("\n")));
    buf = [];
  };
  const flushCode = () => {
    const box = pre("code", buf.join("\n"));
    if (fence) {
      /* The language tag, if the agent gave one. Rendered, not trusted: it is
         a caption, it is inserted with textContent, and nothing matches on it. */
      const tag = el("span", "code-lang", fence);
      box.insertBefore(tag, box.firstChild);
    }
    parent.appendChild(box);
    buf = [];
  };
  for (const line of lines) {
    const m = /^\s*```(.*)$/.exec(line);
    if (m) {
      if (fence === null) { flushPlain(); fence = m[1].trim(); }
      else { flushCode(); fence = null; }
      continue;
    }
    buf.push(line);
  }
  if (fence === null) flushPlain(); else flushCode();
  return parent;
}

/** JSON for a debug surface. Never `raw` straight into the DOM. */
function jsonText(x) {
  try { return JSON.stringify(x, null, 2); }
  catch (e) { return "(this payload could not be serialised: " + e.message + ")"; }
}

/* ── THE D44 CONSTRUCTIVE MARKDOWN RENDERER (WP6, plan surface ONLY) ──────
   D44's exact grammar and nothing else: bold, italic, inline code, fenced
   code, headings, one-level lists, blockquotes. CONSTRUCTIVE means: this
   builds only allowlisted elements whose content is text nodes; it never
   parses or passes through HTML; no links, no images, no tables; no attribute
   is ever derived from agent content. Unrecognised syntax remains literal
   text — a malformed plan degrades to readable text, never to markup.

   One licence note (D54 records pass): the legibility pass recorded "zero
   italics" as a page invariant; D44's grammar includes italic, so <em> here
   is the one licensed italic surface on the page. */
function renderPlanMarkdown(src) {
  const root = el("div", "md");
  const lines = String(src == null ? "" : src).split("\n");
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = el("p", "md-p");
    para.forEach((line, n) => {
      if (n > 0) p.appendChild(textNode("\n"));
      mdInline(p, line);
    });
    root.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    /* Fenced code: same fence rule as blockText. Nothing inside is parsed. */
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const info = fence[1].trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      if (i < lines.length) i++; /* consume the closing fence if there was one */
      const box = pre("code", buf.join("\n"));
      if (info) box.insertBefore(el("span", "code-lang", info), box.firstChild);
      root.appendChild(box);
      continue;
    }

    /* Heading. The level caps at 3 visually — a plan's #### is still a
       heading, just not a fourth size. */
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length, 3);
      const node = el("div", "md-h md-h" + level);
      mdInline(node, h[2]);
      root.appendChild(node);
      i++;
      continue;
    }

    /* Blockquote: a run of `>` lines becomes one quote block. */
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const q = el("blockquote", "md-quote");
      let first = true;
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        if (!first) q.appendChild(textNode("\n"));
        mdInline(q, lines[i].replace(/^\s*>\s?/, ""));
        first = false;
        i++;
      }
      root.appendChild(q);
      continue;
    }

    /* One-level lists (D44). Indentation is not a second level — every item
       renders flat, which is the approved grammar, not a shortcoming. */
    const isBullet = (s) => /^\s*[-*]\s+/.test(s);
    const isNumbered = (s) => /^\s*\d+[.)]\s+/.test(s);
    if (isBullet(line) || isNumbered(line)) {
      flushPara();
      const numbered = isNumbered(line);
      const list = el(numbered ? "ol" : "ul", "md-list");
      while (i < lines.length && (numbered ? isNumbered(lines[i]) : isBullet(lines[i]))) {
        const item = el("li", "md-li");
        mdInline(item, lines[i].replace(numbered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, ""));
        list.appendChild(item);
        i++;
      }
      root.appendChild(list);
      continue;
    }

    if (line.trim() === "") { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();
  return root;
}

/* Inline grammar: `code` (protects its contents), then **bold**, then
   *italic*. Underscores, links, images and everything else stay literal. */
function mdInline(parent, s) {
  for (const part of String(s).split(/(`[^`]+`)/)) {
    if (/^`[^`]+`$/.test(part)) { parent.appendChild(el("code", "md-code", part.slice(1, -1))); continue; }
    mdBold(parent, part);
  }
}
function mdBold(parent, s) {
  for (const part of String(s).split(/(\*\*[^*]+\*\*)/)) {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      const b = el("strong", "md-b");
      mdItalic(b, part.slice(2, -2));
      parent.appendChild(b);
      continue;
    }
    mdItalic(parent, part);
  }
}
function mdItalic(parent, s) {
  for (const part of String(s).split(/(\*[^*]+\*)/)) {
    if (/^\*[^*]+\*$/.test(part)) { parent.appendChild(el("em", "md-i", part.slice(1, -1))); continue; }
    if (part) parent.appendChild(textNode(part));
  }
}
/* Elapsed time, in words a person reads at a glance: seconds under a minute,
   then m/s, then h/m. Never a bare millisecond count. */
function fmtDuration(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}
function durationSince(at) { return fmtDuration(Date.now() - at); }

/* The one-second ticker. It rewrites the TEXT of live elapsed elements and
   nothing else — no canvas rebuild, so a half-typed plan note and the caret
   inside it both survive a running turn. Started once, runs for the life of
   the page, and costs one querySelectorAll per second over a handful of
   nodes. */
setInterval(() => {
  for (const node of document.querySelectorAll(".live-elapsed")) {
    const since = Number(node.dataset.since);
    if (Number.isFinite(since)) node.textContent = durationSince(since);
  }
}, 1000);

function kfmt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "?";
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
}
/* The per-turn cost, short. Four places is enough for the real figures (0.0156,
   0.0249, 0.0858) and never rounds a positive amount to $0.0000 — events.ts
   already yields null, never 0, when nothing was reported, so a value that
   reaches here is genuinely positive. D18: the sentence around it still says it
   is not a charge. */
function fmtUsd(usd) {
  if (typeof usd !== "number" || !isFinite(usd)) return "?";
  return usd >= 0.0001 ? "$" + usd.toFixed(4) : "<$0.0001";
}
function ago(ms) {
  if (typeof ms !== "number" || !ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

/* ── STATUS STRINGS ───────────────────────────────────────────────────
   All fourteen from spec §2, verbatim, each with the state token the spec
   assigns it and the real thing that puts the shell into it.

   Context filling has no state token in the spec. LEGIBILITY (D45): it is a
   non-blocking status, so it uses the steel `--state-filling`, NOT the waiting
   amber it used to borrow — gold now means only "the machine is waiting for
   you". Same reason the meter's near-full border and threshold marker are no
   longer gold.
   ─────────────────────────────────────────────────────────────────── */
const STATES = {
  connecting: { text: "Connecting…",            tone: "--state-connecting", src: "/state says the agent is starting, or the event stream is not open yet" },
  ready:      { text: "Session ready",          tone: "--state-ready",      src: "this session was opened or loaded and has done nothing since" },
  idle:       { text: "Idle",                   tone: "--state-idle",       src: "agent ready, no session selected, or a selected session with no turn history in this window" },
  thinking:   { text: "Thinking…",              tone: "--state-thinking",   src: "a live message.thinking event", pulse: true },
  streaming:  { text: "Streaming response",     tone: "--state-streaming",  src: "a live message.assistant event" },
  tool:       { text: "Calling tool",           tone: "--state-tool",       src: "tool.started — the name comes from the agent's own tool label", detailed: true },
  editing:    { text: "Editing files",          tone: "--state-editing",    src: "a running tool whose own readOnly flag is false. There is no edit state on the wire (reconciliation §E.3); this is the agent's flag, not a list of tool names we made up" },
  permission: { text: "Awaiting permission",    tone: "--state-permission", src: "an unanswered session/request_permission reverse request" },
  plan:       { text: "Awaiting plan approval", tone: "--state-plan",       src: "an unanswered exit_plan_mode reverse request" },
  question:   { text: "Awaiting your answer",   tone: "--state-permission", src: "an unanswered ask_user_question reverse request. The possessive is deliberate (D54): gold means the machine is waiting for YOU, and this is the one state where the user is the subject" },
  complete:   { text: "Turn complete",          tone: "--state-complete",   src: "turn.finished with stopReason end_turn" },
  cancelled:  { text: "Turn cancelled",         tone: "--state-cancelled",  src: "turn.finished with a non-end_turn stopReason AFTER this app sent a cancel. The wire does not label a cancel; our own cancel is the only thing that can distinguish it from a failure" },
  failed:     { text: "Turn failed",            tone: "--state-failed",     src: "turn.failed, or turn.finished with a non-end_turn stopReason and no cancel from us", detailed: true },
  filling:    { text: "Context filling",        tone: "--state-filling",     src: "no event exists (reconciliation §E.3). Derived: usagePct is within 10 points of the agent's own autoCompactThresholdPercent" },
  compacting: { text: "Compacting context…",    tone: "--state-compacting", src: "context.compact_started, cleared by compact_completed / failed / cancelled" },
  gone:       { text: "Agent process gone",     tone: "--state-gone",       src: "/state reports gone or failed, or a bridge.agent_gone event arrived" },
  respawning: { text: "Restarting agent…",      tone: "--state-connecting", src: "bridge.respawning — the server is bringing a replacement agent process up and will reload the open sessions from disk. Distinct from gone (WP12): the recovery window is not the death" },
  agent_failed: { text: "Agent could not start", tone: "--state-failed",    src: "/state reports failed; the strip text varies with the cause (startup_failed / crash_loop / unexplained) — the banner carries the sentence and the command", detailed: true },
  recovering: { text: "Restoring conversation history", tone: "--state-connecting", src: "a fresh page is receiving the server's retained reconstruction" },
  working:    { text: "Turn in progress", tone: "--state-connecting", src: "the server snapshot says this session has a turn in flight, before a newer live phase event reaches this page" },
};

/* Highest first. The strip shows one state; this is which one wins. */
const PRIORITY = ["gone", "respawning", "permission", "plan", "question", "compacting", "editing", "tool",
                  "thinking", "streaming", "failed", "cancelled", "complete",
                  "filling", "ready", "idle", "connecting"];

/* ── LOCAL STATE ──────────────────────────────────────────────────────
   The server is the authority on all of it. This page never decides that a
   mode changed, a turn ended, or an effort took; it renders what it was
   told, and every field below is written by an event or a read-back.
   ─────────────────────────────────────────────────────────────────── */
let agent = { state: "starting", failure: null, failureCause: null, pid: null, restarts: 0, sessions: [], openInteractions: [] };
let roster = [];
let rosterRead = false;          /* has a roster read actually landed yet? */
let activeId = null;
let rememberedActiveId = readStoredSessionId();
let streamUp = false;
let streamLost = false;          /* the stream dropped after having been up */
/* WP11 (round 3, Codex 3): the agent-process generation the server is
   talking to, learned from the channel_open snapshot and from
   bridge.agent_gone (which carries the NEW generation, already bumped
   server-side). A turn's promptIndex stamp binds only when the stamp's
   minted generation matches — the stamp carries it inside the retained
   event (d.agentGen), so the boundary survives a full page reload, which
   page memory could not (the round-2 trackerDied latch this replaces):
   plain reload with the tracker intact → generations match → history
   binding works (delta artifact 20); death + respawn → generations differ →
   no bind, fail closed (delta artifact 21). What it still cannot promise: a
   future grok that restarts tracker numbering per process AND reuses the
   same generation counter semantics is unobservable from here — the
   server's seenPromptIndexes + summary membership remain the backstop. */
let currentAgentGen = null;

/* Opus final M1: the "WIRE FORMAT CHANGED?" shell note is latched once per
   event type per page lifetime — a repeating notification with a missing
   field must not flood the log. */
const missingNoted = new Set();
let recoveryActive = false;
let recoveryText = "";
let recoveryPainted = false;
let lastDeliveryId = 0;
let forcedState = null;          /* the Shell tab's screenshot override */
let drawerTab = "detail";
/* The folder picker (WP5.5). null when closed; otherwise the current listing and
   UI state. Directories only; every name reaches the DOM through el()/textContent
   like all other filesystem-or-agent strings (rule 1, D31). */
let picker = null;

/* ── WP13 client state (session management & portability) ──────────────────
   All of it is view state with no wire behind it until the operator acts; every
   session title / cwd / id it renders is hostile text and reaches the DOM as
   text (rule 1, D31). */
let rowMenu = null;      /* sessionId whose inline action strip is open, or null */
let renaming = null;     /* { sessionId, draft, error } while renaming inline, or null */
let showArchived = false;/* is the "Archived (N)" panel expanded */
let modal = null;        /* { kind: "delete"|"export"|"import", ... } or null */
/* The one piece of state with no event behind it: the window between a prompt
   POST leaving and its 202 coming back. Declared with the rest of the state so
   nothing can read it before it exists. */
let sending = false;

/* ── WP7 composer state ────────────────────────────────────────────────────
   Three controls, and between them exactly four pieces of local state — all of
   it about a request that is IN FLIGHT or an outcome that has words of its own.
   None of it is a claim about the agent: the Plan face is written by
   `current_mode_update`, the effort face by the roster read-back, and the
   launcher by the agent's own command list. */
const planBusy = new Map();     /* sessionId -> { want }, between click and answer */
const planNotice = new Map();   /* sessionId -> { word, tip, extra } */
const effortBusy = new Map();   /* sessionId -> { id }, while set_model is in flight */
const effortNotice = new Map(); /* sessionId -> { text }, mismatch / refusal */
/* The launcher: { sessionId, query, rows, active, total, dropped } or null. Page
   memory only, per tab, never restored across a reload. */
let launcher = null;
/* The newest connection-wide `models/update` the agent has pushed, if any:
   { seq, payload }. A session-scoped one lands on that session's view instead.
   Both only ever supply the effort OPTIONS — the selected value is the roster's. */
let modelsUpdate = null;
let modelsUpdateSeq = 0;
/* In-flight post-reconstruction context refreshes, keyed by the exact sessionId
   sent to POST /session/info. Prevents a duplicate reconstruction_finished (or a
   redraw that somehow re-enters) from stacking uncontrolled requests. The HTTP
   body is never applied to the meter — only a subsequent live bridge.context_reading
   may set v.context. */
const contextRefreshInFlight = new Set();
const collapsedGroups = new Set();
const agentWide = [];            /* bridge.log — agent-wide, never per-session */
const shellNotes = [];
const sess = new Map();          /* sessionId -> per-session view state */

/* Unscoped events this build does not model. They cannot go into a session's
   stream — that is the [agent-wide] routing mistake — so they land here, are
   counted in the strip, and are listed in the Agent-wide panel. */
const unhandledWide = [];

function setActiveSession(sessionId) {
  activeId = safeStoredSessionId(sessionId);
  rememberedActiveId = activeId;
  try {
    if (activeId === null) sessionStorage.removeItem(SELECTED_SESSION_KEY);
    else sessionStorage.setItem(SELECTED_SESSION_KEY, activeId);
  } catch {
    /* Selection still works when browser storage is unavailable. */
  }
}

function reconcileActiveSession() {
  const available = new Set([
    ...(agent.sessions || []).map((session) => session.sessionId),
    ...roster.map((session) => session.sessionId),
  ].filter((sessionId) => safeStoredSessionId(sessionId) !== null));
  if (activeId !== null && available.has(activeId)) return;
  if (rememberedActiveId !== null && available.has(rememberedActiveId)) {
    setActiveSession(rememberedActiveId);
    return;
  }
  /* A remembered id may be dormant and therefore present only in the roster.
     Wait for that authoritative read before calling it stale. */
  if (rememberedActiveId !== null && !rosterRead) return;
  const fallback = (agent.sessions || []).find((session) =>
    safeStoredSessionId(session.sessionId) !== null)?.sessionId || null;
  setActiveSession(fallback);
}

/* Bounds. Same rule as the server's (PROJECT-STATE §9): a bound is about how
   much we RETAIN, never about how much we ACCEPT, and nothing is dropped
   without something on screen saying what went. */
const MAX_TURNS_RETAINED = 200;   /* per session */
const MAX_TURNS_RENDERED = 40;    /* the rest are counted, not drawn */
const MAX_ABANDONMENTS_RETAINED = 40;

function view(id) {
  if (!id) return null;
  if (!sess.has(id)) sess.set(id, {
    phase: null, detail: "", awaiting: null, compacting: false,
    currentInteractionKey: null,
    cancelSent: false, subagents: 0, runningWrites: 0,
    /* THE CONVERSATION. An ordered list of turns; each turn an ordered list of
       blocks. See openTurn() for the shape. `turnsDropped` counts what aged
       out of the front so the pane can say so instead of quietly shortening
       the user's history. */
    turns: [], turnsDropped: 0, turnSeq: 0,
    abandonments: [],
    historyMissing: null, partialNextTurn: false, loadBackup: null,
    context: null, contextAt: 0, contextRefused: null,
    title: null, opened: false,
    /* WP7. The session's own slash-command catalogue, as the agent last
       reported it. `null` is "we have not read one", which is NOT the same as
       the empty array an agent with no commands really sends —
       `commandsFailed` carries the third state, "we tried and could not read
       it". `modelsUpdate` is a session-scoped models/update, if one arrives. */
    commands: null, commandsFailed: false, commandsRevision: 0, modelsUpdate: null,
    /* WP11: the last /changes reading. null = never read in this window, which
       is NOT a reading of zero — the pane says "not read yet" instead. There
       is no push notification for hunk changes (F7), so this fills only at
       the refresh moments: a live turn.completed, the drawer opening on the
       Detail tab, selecting a session while that drawer is open (M3), and one
       delayed re-read after our own undo/accept (F8's rescan lag). Never on
       an idle timer. */
    changes: null,
    /* The pane's own UI state: which files are expanded, their lazily-read
       hunks, the armed undo (two-step confirm), and an in-flight action. A new
       reading invalidates the hunks cache in applyChangesReading. */
    changesUi: { expanded: Object.create(null), hunks: Object.create(null), armedHunk: null, busy: false },
  });
  return sess.get(id);
}

function clearTransient(v) {
  if (!v) return;
  v.phase = null;
  v.detail = "";
  v.awaiting = null;
  v.currentInteractionKey = null;
  v.compacting = false;
  v.runningWrites = 0;
}

function appendAbandonmentNotice(v, ev, abandoned) {
  for (const turn of v.turns) {
    if (turn.items.some((item) => item.abandonmentKey === abandoned.key)) return;
  }
  let target = null;
  if (isHistoricalDelivery(ev) && Number.isInteger(abandoned.afterTurn)) {
    let turns = 0;
    let insertAt = 0;
    for (let i = 0; i < v.turns.length; i++) {
      if (!v.turns[i].aside) turns++;
      if (turns <= abandoned.afterTurn) insertAt = i + 1;
    }
    if (v.turns[insertAt] && v.turns[insertAt].aside) target = v.turns[insertAt];
    else {
      target = openTurn(v, ev, true);
      v.turns.pop();
      v.turns.splice(insertAt, 0, target);
    }
  }
  (target || asideFor(v, ev)).items.push({
    kind: "notice", label: "ABANDONED", text: abandoned.reason,
    abandonmentKey: abandoned.key, at: abandoned.at,
    replay: isHistoricalDelivery(ev), sealed: true,
  });
}

function rememberAbandonment(v, ev, key, reason, afterTurn) {
  const existing = v.abandonments.find((item) => item.key === key);
  if (existing) { appendAbandonmentNotice(v, ev, existing); return; }
  const abandoned = {
    key,
    reason,
    at: ev.t,
    afterTurn: Number.isInteger(afterTurn)
      ? afterTurn
      : v.turns.filter((turn) => !turn.aside).length,
  };
  v.abandonments.push(abandoned);
  const evicted = v.abandonments.length > MAX_ABANDONMENTS_RETAINED
    ? v.abandonments.shift()
    : null;
  if (evicted) {
    for (const turn of v.turns) {
      turn.items = turn.items.filter((item) =>
        item.abandonmentKey !== evicted.key || item.at !== evicted.at);
    }
  }
  appendAbandonmentNotice(v, ev, abandoned);
}

function isReconstruction(ev) { return ev && ev.delivery === "reconstruction"; }
function isHistoricalDelivery(ev) { return !!(ev && (ev.replay || isReconstruction(ev))); }
function hasLiveEffects(ev) {
  return !!(ev && !ev.replay && !isReconstruction(ev) && ev.deliveryResolved !== true);
}

function reconcileOpenInteractions(keys) {
  /* No list is not an empty list. A finished frame that carries no
     currentInteractionKeys says nothing about what is open, and sealing every
     card on it would silently strip the buttons off requests the agent is
     still blocked on. Fail in the direction that keeps a real card answerable. */
  if (!Array.isArray(keys)) return;
  const current = new Set(keys);
  for (const v of sess.values()) {
    /* Seal any card the server no longer lists as open. The server is the
       authority; a card with live buttons for a request it no longer holds
       would post into `no open interaction with key …`. */
    for (const turn of v.turns) {
      for (const item of turn.items) {
        if (item.kind !== "interaction" || item.resolved || !item.key) continue;
        if (current.has(item.key)) continue;
        item.resolved = {
          how: "reconciled",
          note: "This request is no longer open on the server — it was resolved elsewhere or lost with the agent.",
        };
        if (item.ikind === "plan") item.planFolded = true;
      }
    }
    if (!v.currentInteractionKey || current.has(v.currentInteractionKey)) continue;
    v.currentInteractionKey = null;
    v.awaiting = null;
  }
}

/* ── THE INTERACTION ITEMS (WP6) ──────────────────────────────────────────
   One stream item per open request, deduped by the server-minted key. The
   dedup is load-bearing, not defensive: a still-open interaction arrives
   TWICE on every reload (the retained copy tagged delivery "reconstruction"
   plus a `current` re-send with a fresh deliveryId) and again on every SSE
   reconnect. Scan all turns, the same shape as appendAbandonmentNotice(). */

function findInteractionItem(v, key) {
  for (let i = v.turns.length - 1; i >= 0; i--) {
    const item = v.turns[i].items.find((it) => it.kind === "interaction" && it.key === key);
    if (item) return item;
  }
  return null;
}

/** How a card seals. `stamped` is the generic catch-up marker and may be
 *  overwritten by the real resolution arriving later in the same batch. */
function sealInteraction(v, key, resolved) {
  const item = findInteractionItem(v, key);
  if (!item) return;
  if (item.resolved && item.resolved.how !== "stamped") return;
  item.resolved = resolved;
  /* The seal is the authority on what happened, so a stale "Not sent" from a
     lost HTTP response must not sit above it contradicting it. */
  item.error = null;
  item.sending = false;
  if (item.ikind === "plan") item.planFolded = true;
}

function interactionItemFor(ev, d, key) {
  const ikind =
    ev.type === "interaction.plan_approval_requested" ? "plan"
    : ev.type === "interaction.question_asked" ? "question"
    : ev.type === "interaction.permission_requested" ? "permission"
    : "unknown-request";
  return {
    kind: "interaction", ikind, key,
    /* The payload, retained — the card is drawn from this, not re-read off
       any event. All of it is agent text and reaches the DOM as text. */
    method: ev.wireKind || null,
    title: d.title ?? null,
    toolCallId: d.toolCallId ?? null,
    rawInput: d.rawInput,
    tool: d.tool ?? null,
    options: Array.isArray(d.options) ? d.options : [],
    planContent: d.planContent ?? null,
    questions: Array.isArray(d.questions) ? d.questions : [],
    mode: d.mode ?? null,
    at: ev.t,
    replay: isHistoricalDelivery(ev),
    /* deliveryResolved: resolved earlier in the same catch-up batch. The
       batch's own answered/abandoned event may upgrade this to the real
       narration — see sealInteraction. */
    resolved: ev.deliveryResolved === true
      ? { how: "stamped", note: "Resolved earlier in this session." }
      : null,
    /* Per-card UI state. On the item, never the DOM: the canvas is wiped and
       rebuilt on every paint, and this is what survives it — including
       half-typed plan feedback (the §0 repaint hazard).

       `picks` is keyed by AGENT-CONTROLLED question text, so it has a null
       prototype: on a plain object `picks["__proto__"] = […]` writes through
       Object.prototype's setter and stores nothing, which would strand a card
       nobody could answer. Same reason the posted answers map is built with
       Object.create(null), and the same reason the server's validated map is. */
    sending: false, sent: false, error: null,
    feedbackOpen: false, feedbackText: "",
    picks: Object.create(null), previewOpen: Object.create(null),
    planFolded: false, inputExpanded: false,
  };
}

/* Flip ONLY with a live 0.2.118 wire capture of both reply shapes (WP6 brief
   §3/§6): the two plan-mode-only question outcomes ship dark until proven.
   The server path exists and is check-covered either way. */
const PLAN_MODE_QUESTION_OUTCOMES_PROVEN = false;

/* WP11 round 3: a stamp binds only when it was minted by the agent lifetime
   the server is CURRENTLY talking to. Stamps carry their generation inside
   the (retained) event; the current one arrives via channel_open and
   bridge.agent_gone. Anything else — unstamped, unknown current generation,
   or a mismatch — fails closed: no bind, no button. */
function promptStampBinds(d) {
  return typeof d.promptIndex === "number" &&
    typeof d.agentGen === "number" &&
    currentAgentGen !== null &&
    d.agentGen === currentAgentGen;
}

/* ── THE TURN MODEL ───────────────────────────────────────────────────────

   A turn is opened by `turn.started` (ours, live) or implicitly by the first
   piece of content that has nowhere else to go — which is what a `session/load`
   replay is, a stream of history with no turn markers of its own.

   It is closed by `turn.finished` / `turn.failed` (ours). Upstream replay has
   no Graphometer finish event, so its `turn.completed` closes immediately.
   Delivery reconstruction waits for a retained finish, then finalizes from a
   completed event at the reconstruction boundary only when the server does not
   still report that turn in flight.
   ─────────────────────────────────────────────────────────────────────── */

function openTurn(v, ev, aside) {
  const partial = !aside && v.partialNextTurn === true;
  if (partial) v.partialNextTurn = false;
  const t = {
    /* An ASIDE IS NOT A TURN and does not take a turn number.
       Five of a new session's own setup events arrive BEFORE `session/new`
       returns — MCP init, git HEAD, two command lists and the model — each
       stamped with the new session's id. They are real, they belong to this
       session, and they are not a turn. Numbering them TURN 1 pushed the
       user's first prompt to TURN 2 and printed "Running · cost pending"
       under a group of notifications. Seen live in WP5, and it is WP4's own
       trap 1 arriving in a place nobody had looked. */
    n: aside ? null : ++v.turnSeq,
    aside: !!aside,
    at: ev ? ev.t : Date.now(),
    replay: isHistoricalDelivery(ev),
    partial,
    items: [],
    outcome: "running",
    stopReason: null,
    error: null,
    cancelled: false,
    cost: null,               /* { usd: number|null, incomplete: boolean } */
    usage: null,
    userFromServer: false,    /* the prompt text came off turn.started (D36) */
    userEchoed: false,        /* …and the agent echoed it back as chunks too */
    /* WP11 (B1): the turn's REAL promptIndex, stamped by the agent on its echo
       of the user's message (user_message_chunk _meta.promptIndex — see
       events.ts). null until the wire provides it; ordinal arithmetic is
       never used, because it drifts after a truncated reconstruction. A stamp
       binds only when the generation it was minted in is the one the server
       is currently talking to (promptStampBinds) — replayed echoes from the
       intact lifetime bind (delta artifact 20); anything minted by a dead
       lifetime never matches (artifact 21). */
    promptIndex: null,
    cancelRequested: false,
    completionSeen: false,
  };
  v.turns.push(t);
  while (v.turns.length > MAX_TURNS_RETAINED) { v.turns.shift(); v.turnsDropped++; }
  return t;
}

function currentTurn(v) { return v.turns.length ? v.turns[v.turns.length - 1] : null; }

/**
 * The turn a piece of CONVERSATION belongs to — a message, a thought, a tool
 * call. Content always belongs to a real, numbered turn, so an open aside does
 * not swallow it.
 */
function turnFor(v, ev) {
  const t = currentTurn(v);
  if (t && t.outcome === "running" && !t.aside) return t;
  return openTurn(v, ev, false);
}

function turnToClose(v, ev) {
  for (let i = v.turns.length - 1; i >= 0; i--) {
    const t = v.turns[i];
    if (!t.aside && t.outcome === "running") return t;
  }
  const latest = [...v.turns].reverse().find((turn) => !turn.aside) || null;
  if (ev.type === "turn.finished" && latest && latest.stopReason !== null) return latest;
  return openTurn(v, ev, false);
}

/**
 * Where a notice or an unhandled event goes: into the turn that is running, or
 * into an aside when nothing is. An aside before the first prompt is the
 * session coming up; one after a turn is whatever the agent said next.
 */
function asideFor(v, ev) {
  const t = currentTurn(v);
  if (t && t.outcome === "running") return t;
  if (t && t.aside) return t;
  return openTurn(v, ev, true);
}

function closeTurn(t, outcome, endedAt) {
  if (!t) return;
  /* First close wins. `turn.completed` and `turn.finished` both arrive for a
     healthy turn, in that order, and the second must not overwrite a verdict
     the first one already reached. */
  if (t.outcome === "running") {
    t.outcome = outcome;
    /* How long it took, from the CLOSING EVENT's own timestamp — never the
       wall clock. A replayed turn from last week must report the duration it
       actually had, and a live turn and its reconstruction must report the
       same one; reading Date.now() here would make both wrong. */
    if (typeof endedAt === "number" && endedAt > t.at) t.endedAt = endedAt;
  }
}

function closeFromStopEvidence(t, cancelRequested, endedAt) {
  const hasStopReason = typeof t.stopReason === "string";
  t.cancelled = hasStopReason && t.stopReason !== "end_turn" && cancelRequested === true;
  closeTurn(t, t.stopReason === "end_turn" ? "ok" : t.cancelled ? "cancelled" : "failed", endedAt);
}

function finalizeReconstructedCompletions(onlySessionId) {
  for (const [sessionId, v] of sess) {
    /* session/load is for ONE session; other sessions may be genuinely live in
       this app, so a load must not reach across and close their turns. F5
       reconstruction passes nothing and finalizes everything, which is right
       because every session is being rebuilt at once. */
    if (onlySessionId && sessionId !== onlySessionId) continue;
    const rec = (agent.sessions || []).find((item) => item.sessionId === sessionId);
    if (rec && rec.turnInFlight === true) continue;
    for (const t of v.turns) {
      if (t.aside || t.outcome !== "running") continue;
      sealAll(t);
      if (t.completionSeen === true) {
        closeFromStopEvidence(t, t.cancelRequested, t.completedAt);
      } else {
        /* A running turn with no recorded completion, in a session the server
           does not report as in flight: the loaded or reconstructed history
           simply ends here. This is the phantom-"Working" bug the director's walk found
           on a terminal-started session — the last turn had no turn.finished on
           disk, so it stayed "running" and the working indicator span forever.
           Saying "Working" invents a state; saying "failed" invents an outcome.
           "ended" is the honest terminal state: it stopped, and the record does
           not say how. */
        closeTurn(t, "ended");
      }
    }
  }
}

/**
 * The last turn that finished, for the status strip.
 *
 * Replayed turns are excluded deliberately: after a `session/load` the strip
 * would otherwise announce "Turn complete" about something that happened last
 * week. WP4's rule — a replayed event never drives a state change — holds here.
 */
function lastTurn(v) {
  if (!v) return null;
  for (let i = v.turns.length - 1; i >= 0; i--) {
    const t = v.turns[i];
    if (!t.replay && t.outcome !== "running") return t;
  }
  return null;
}

/**
 * The growing block of this kind to append to, or a new one.
 *
 * Searching backwards rather than only checking the last block, because a
 * notice or an unhandled event can land in the middle of a message that is
 * still streaming. Checking only the last block split one live agent sentence
 * across two blocks mid-word — "Creating a short `gre" / TITLE / "et.py`" —
 * when the agent named the session while it was talking. Notices and unhandled
 * cards are therefore transparent to this search; a TOOL CARD is not, because
 * the agent's text before and after a tool call genuinely are two things and
 * the card between them is the reason.
 */
function blockFor(t, kind, ev, seed) {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i];
    if (it.kind === kind) { if (!it.sealed) return it; break; }
    if (it.kind === "notice" || it.kind === "unhandled") continue;
    break;
  }
  const b = Object.assign({ kind, at: ev ? ev.t : Date.now(), replay: isHistoricalDelivery(ev), sealed: false }, seed || {});
  t.items.push(b);
  return b;
}

/** Anything that is not the user's own message. */
function hasAgentContent(t) { return t.items.some((i) => i.kind !== "user"); }

function note(kind, text, details) {
  /* WP12: `details` is the optional machine payload behind "Copy details" —
     the line itself stays one readable sentence. post() supplies it
     automatically on failures (path, HTTP status, the server's sentence). */
  shellNotes.unshift({
    kind, text,
    details: typeof details === "string" && details !== "" ? details : null,
    at: Date.now(),
    seq: ++noteSeq,
  });
  while (shellNotes.length > 40) shellNotes.pop();
  renderNoticeStrip();
  if (drawerTab === "shell") renderDrawer();
}

/* ── WP14: THE NOTICE STRIP ───────────────────────────────────────────
   The visible home for note()'s sentences. Until WP14 they were written
   only to shellNotes, which only the dev Shell tab reads — so a failed
   Send, rename, archive, compact, import or export showed nothing on any
   product surface. The strip mirrors the latest note above the composer;
   the sentences are the same ones, no new copy. Dismissal hides the strip
   until a NEWER note arrives — dismissing must not mute the next failure.
   The dev tab keeps the full log either way. */

/* The sequence of the note the operator dismissed. Notes carry a monotonic
   `seq`, not a Date.now() tie-risk — two notes in the same millisecond would
   compare equal, and a dismissed-at tie would wrongly keep the NEWER note
   hidden. A newer note always re-shows the strip. */
let stripDismissedSeq = 0;
let noteSeq = 0;

function renderNoticeStrip() {
  const strip = $("noticeStrip");
  if (!strip) return;
  const latest = shellNotes[0];
  if (!latest || latest.seq <= stripDismissedSeq) { strip.hidden = true; return; }
  strip.textContent = "";
  strip.dataset.kind = latest.kind === "error" ? "error" : "info";
  strip.appendChild(el("span", "notice-text t-caption", latest.text));
  if (latest.kind === "error" && latest.details) strip.appendChild(copyDetailsButton(latest.details));
  const dismiss = el("button", "notice-dismiss", "×");
  dismiss.title = "Dismiss this notice";
  dismiss.setAttribute("aria-label", "Dismiss this notice");
  dismiss.onclick = () => { stripDismissedSeq = latest.seq; renderNoticeStrip(); };
  strip.appendChild(dismiss);
  strip.hidden = false;
}

/* The "Copy details" button, shared by the notice strip and the dev Shell
   log (WP12's shape, extracted in WP14). The sentence stays on the line; the
   machine detail rides behind the button, copied as text. The clipboard can
   be absent or refuse — both are said on the button itself. */
function copyDetailsButton(details) {
  const b = el("button", "copy-details", "Copy details");
  b.title = "Copy the technical detail for this failure.";
  b.onclick = () => {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      b.textContent = "No clipboard here";
      return;
    }
    /* Codex WP12: writeText can throw SYNCHRONOUSLY (or return a non-Promise)
       in an unusual embedded implementation — the try/catch plus
       Promise.resolve normalisation makes every failure path land on the same
       sentence. */
    try {
      Promise.resolve(navigator.clipboard.writeText(details)).then(
        () => { b.textContent = "Copied"; },
        () => { b.textContent = "Copy failed"; },
      );
    } catch {
      b.textContent = "Copy failed";
    }
  };
  return b;
}

/* ── RESOLVING THE STATE ──────────────────────────────────────────── */

function resolveState() {
  if (forcedState) return { key: forcedState, detail: forcedState === "tool" ? "example_tool" : "forced for a screenshot", forced: true };
  if (agent.state === "failed") {
    /* WP10: a failed start is not "gone", a crash loop is not "could not
       start", and an unexplained failure is the weakest true statement
       (Opus WP10 re-review M1). The banner carries the sentence + command. */
    const kind = agent.failureCause && agent.failureCause.kind;
    if (kind === "crash_loop") return { key: "agent_failed", detail: "", labelOverride: "Agent keeps crashing" };
    if (kind !== "startup_failed") return { key: "agent_failed", detail: "", labelOverride: "Agent not running" };
    return { key: "agent_failed", detail: "startup failed" };
  }
  if (agent.state === "respawning") return { key: "respawning", detail: "" };
  if (agent.state === "gone") return { key: "gone", detail: "" };
  if (recoveryActive) return { key: "recovering", detail: "" };
  if (!streamUp || agent.state === "starting") return { key: "connecting", detail: "" };

  const v = view(activeId);
  if (!v) return { key: "idle", detail: "" };

  if (v.awaiting === "permission") return { key: "permission", detail: "" };
  if (v.awaiting === "plan") return { key: "plan", detail: "" };
  if (v.awaiting === "question") return { key: "question", detail: "" };
  if (v.compacting) return { key: "compacting", detail: "" };
  if (v.phase && PRIORITY.indexOf(v.phase) >= 0) {
    /* A live phase (thinking / streaming / tool / editing) outranks any
       finished-turn state, which is what the ordering in PRIORITY says. */
    if (["editing", "tool", "thinking", "streaming"].includes(v.phase)) return { key: v.phase, detail: v.detail };
  }
  const rec = agent.sessions.find((session) => session.sessionId === activeId) || null;
  if (rec && rec.turnInFlight) return { key: "working", detail: "" };
  const t = lastTurn(v);
  if (t) {
    if (t.error !== null && t.error !== undefined) return { key: "failed", detail: t.error };
    if (t.stopReason === "end_turn") return { key: "complete", detail: "" };
    if (t.cancelled) return { key: "cancelled", detail: "" };
    return { key: "failed", detail: t.stopReason == null ? "" : "stopped: " + t.stopReason };
  }
  if (contextNear(v)) return { key: "filling", detail: "" };
  if (v.opened) return { key: "ready", detail: "" };
  return { key: "idle", detail: "" };
}

/* Reconciliation §E.3: no event says "context filling". It is a comparison
   against the agent's own threshold, which is per-model and has been seen
   as 85, 80 and 65 — so it is read, never assumed. */
function contextNear(v) {
  const ctx = ctxOf(v);
  if (!ctx) return false;
  const pct = num(ctx.usagePct), thr = num(ctx.autoCompactThresholdPercent);
  if (pct === null || thr === null) return false;
  return pct >= thr - 10;
}
function num(x) { return typeof x === "number" && isFinite(x) ? x : null; }

/* ── THE STATUS STRIP ─────────────────────────────────────────────── */

function renderStrip() {
  const st = resolveState();
  const spec = STATES[st.key];
  const label = (st.labelOverride || spec.text) + (spec.detailed && st.detail ? " · " + st.detail : "");
  $("stateLabel").textContent = label;
  /* ≤700px can ellipsize the label (WP9 narrow strip, the director's call): the full
     words stay one hover away. */
  $("stateLabel").title = label;
  $("dot").style.background = "var(" + spec.tone + ")";
  $("dot").dataset.pulse = spec.pulse ? "true" : "false";
  $("stateLabel").style.color = st.key === "gone" || st.key === "failed" || st.key === "agent_failed"
    ? "var(--state-failed)" : "var(--text-primary)";

  const rec = agent.sessions.find((s) => s.sessionId === activeId) || null;
  const row = roster.find((s) => s.sessionId === activeId) || null;
  const v = view(activeId);

  $("sessionName").textContent = activeId
    ? ((v && v.title) || (row && row.title) || "(untitled session)")
    : "No session open";
  $("sessionCwd").textContent = activeId
    ? ((rec && rec.cwd) || (row && row.cwd) || "")
    : "";

  const sub = $("subagents");
  if (v && v.subagents > 0) { sub.hidden = false; sub.textContent = "+" + v.subagents + " subagents"; }
  else sub.hidden = true;

  /* Unscoped events this build does not handle. Counted here rather than shown
     in a session's stream, because attributing an event with no session on it
     to whichever session happens to be selected is the one thing the routing
     rules forbid. D14, D35. D84: the two known background kinds never inflate
     the count, even if one ever arrives unscoped — the badge means "something
     unseen needs eyes", and background noise is not that. Loud rows always
     count (isQuietUnhandled excludes them by construction). */
  const ub = $("unhandledBadge");
  const unseenWide = unhandledWide.filter((i) => !isQuietUnhandled(i));
  if (unseenWide.length) {
    ub.hidden = false;
    ub.textContent = unseenWide.length + " unhandled";
    ub.title = "Event kinds this build does not handle, with no session on them. "
      + "Listed in the Agent-wide panel with their payloads.";
  } else ub.hidden = true;

  /* Context filling is one of the fourteen strings, and it is also a
     condition that persists while other things happen. It wins the strip
     only when nothing louder is going on; the rest of the time it stays
     visible as its own badge rather than being hidden. */
  $("fillingBadge").hidden = !(v && contextNear(v)) || st.key === "filling";

  renderMeter(v);
  renderBanner();
  renderComposer(rec, v);
}

/* ── THE CONTEXT METER ────────────────────────────────────────────────
   Spec §4's visual, reconciliation §A.3's arithmetic.

   FOUR segments, and these are the four that genuinely sum to `total`:
     system prompt · messages · reasoning/overhead · free

   `usageCategories` are NOT a fifth segment. xAI's own doc comment says
   those rows already overlap `messageTokens`, so stacking them would add
   up to more than `used` and overstate how full the context is — and that
   single number is the thing this product exists to get right. They are
   informational rows below the bar, in one muted colour, mapped straight
   over the array with no palette and no name matching.
   ─────────────────────────────────────────────────────────────────── */

function ctxOf(v) { return v && v.context ? v.context : null; }

function segmentsOf(ctx) {
  const total = num(ctx.total);
  const used = num(ctx.used);
  if (total === null || total <= 0 || used === null) return null;
  const sys = num(ctx.systemPromptTokens) || 0;
  const msg = num(ctx.messageTokens) || 0;
  /* A partial snapshot carries only used/total/usagePct/freeTokens; every
     breakdown field is zero. That is "breakdown not available yet", not a
     session with no system prompt — so it gets one segment, not four of
     which three are empty. */
  const partial = sys === 0 && msg === 0;
  /* Saturating, and omitted when zero — the derivation upstream uses. */
  const overhead = Math.max(0, used - (sys + msg));
  const free = num(ctx.freeTokens);
  const list = partial
    ? [{ key: "used", label: "Used", tokens: used, tone: "--ctx-messages" }]
    : [
        { key: "system",   label: "System prompt",        tokens: sys,      tone: "--ctx-system" },
        { key: "messages", label: "Messages",             tokens: msg,      tone: "--ctx-messages" },
        { key: "overhead", label: "Reasoning / overhead", tokens: overhead, tone: "--ctx-overhead" },
      ].filter((s) => s.tokens > 0);
  list.push({ key: "free", label: "Free", tokens: free === null ? Math.max(0, total - used) : free, tone: "--ctx-free" });
  return { total, used, partial, list };
}

function renderMeter(v) {
  const ctx = ctxOf(v);
  const bar = $("bar"), fill = $("barFill"), thr = $("barThreshold"), read = $("meterRead");
  fill.textContent = "";
  bar.dataset.compacting = v && v.compacting ? "true" : "false";

  if (!ctx) {
    /* No reading is not a reading of zero. An empty bar drawn at 0% for a
       session that is nearly full is the exact failure this guard exists
       for — session/info answers an unknown id with {} and a success. */
    bar.dataset.near = "false";
    thr.hidden = true;
    read.textContent = "no reading";
    read.className = "t-mono-sm dimr";
    read.title = "No full context reading yet — the server reads session/info after every turn.";
    bar.setAttribute("aria-label", "context usage — no reading");
    /* Indeterminate, never 0: no reading is not a reading of zero. */
    bar.removeAttribute("aria-valuenow");
    if (ctxpopOpen) renderCtxPop();
    return;
  }
  read.className = "t-mono-sm";
  const seg = segmentsOf(ctx);
  if (!seg) {
    read.textContent = "reading incomplete";
    read.title = "The last reading could not be drawn — it carried no usable totals.";
    bar.removeAttribute("aria-valuenow");
    thr.hidden = true;
    if (ctxpopOpen) renderCtxPop();
    return;
  }

  for (const s of seg.list) {
    const i = el("i");
    /* Clamped: an informational row can in principle exceed `used`, and
       nothing is ever allowed to push the bar past 100%. */
    i.style.width = Math.max(0, Math.min(100, (s.tokens / seg.total) * 100)) + "%";
    i.style.background = "var(" + s.tone + ")";
    i.title = s.label + " · " + s.tokens.toLocaleString() + " tokens";
    fill.appendChild(i);
  }
  const t = num(ctx.autoCompactThresholdPercent);
  if (t !== null) {
    thr.hidden = false;
    thr.style.left = Math.max(0, Math.min(100, t)) + "%";
    thr.title = "Auto-compact at " + t + "%";
  } else thr.hidden = true;

  bar.dataset.near = contextNear(v) ? "true" : "false";
  /* Absolute numbers, never percent-only. The total comes off the payload:
     500,000 is right for this model today and wrong the day it changes. */
  read.textContent = kfmt(seg.used) + " / " + kfmt(seg.total);
  read.title = "The session's last full context reading.";
  bar.setAttribute("aria-label",
    "context " + seg.used + " of " + seg.total + " tokens" + (seg.partial ? ", breakdown not available yet" : ""));
  bar.setAttribute("aria-valuenow", String(Math.round(Math.max(0, Math.min(100, (seg.used / seg.total) * 100)))));
  if (ctxpopOpen) renderCtxPop();
}

/* ── THE METER POPOVER + MANUAL COMPACT (WP9) ─────────────────────────────
   Spec §4's 240px popover, fed reconciliation §A.3's arithmetic: the four
   real segments, the informational rows BELOW them (never stacked), the
   agent's own threshold number, and the Compact control. Everything is
   built with el()/textContent — agent-supplied category labels are hostile
   text like everything else (D31). */

let ctxpopOpen = false;
let ctxpopPinned = false;   /* click pins; a hover-opened popover closes on leave */
let ctxpopHoverTimer = null;
let ctxpopCloseTimer = null;
let ctxpopSig = "";

function openCtxPop(pinned, focusCompact) {
  ctxpopOpen = true;
  if (pinned) ctxpopPinned = true;
  renderCtxPop();
  /* Keyboard-opened (Enter/Space on the meter): move focus to the Compact
     control so the dialog is operable without a mouse (Opus WP9 review M7). */
  if (focusCompact) {
    const b = document.querySelectorAll(".ctxpop-compact")[0];
    if (b) b.focus();
  }
}
function closeCtxPop() {
  ctxpopOpen = false;
  ctxpopPinned = false;
  ctxpopSig = "";
  if (ctxpopHoverTimer) { clearTimeout(ctxpopHoverTimer); ctxpopHoverTimer = null; }
  if (ctxpopCloseTimer) { clearTimeout(ctxpopCloseTimer); ctxpopCloseTimer = null; }
  const host = $("ctxpopHost");
  /* Focus inside the closing popover returns to the meter, its opener. */
  const focusInside = host && document.activeElement && host.contains(document.activeElement);
  if (host) { host.hidden = true; host.textContent = ""; }
  const meter = $("meter");
  if (meter) {
    meter.setAttribute("aria-expanded", "false");
    if (focusInside) meter.focus();
  }
}

function renderCtxPop() {
  const host = $("ctxpopHost");
  const meter = $("meter");
  if (!host || !meter) return;
  if (!ctxpopOpen) return; /* self-enforcing: a stray caller can't leak an unclosable popover */
  const v = view(activeId);
  const ctx = ctxOf(v);

  /* Opus WP9 review H2: an open popover must not be torn down and rebuilt on
     every strip render — renderStrip fires on state events all through a
     turn, and a rebuild between pointerdown and pointerup eats the Compact
     click, resets the panel's scroll, and drops keyboard focus. Rebuild only
     when one of the content inputs actually changed. */
  const sig = JSON.stringify([
    activeId, agent.state, compactInFlightFor,
    v ? v.compacting : null, v ? v.contextAt : null, v ? v.contextRefused : null,
    ctx ? [ctx.used, ctx.total, ctx.usagePct, ctx.autoCompactThresholdPercent,
           ctx.systemPromptTokens, ctx.messageTokens, ctx.freeTokens,
           ctx.toolDefinitionsTokens, ctx.toolDefinitionsCount,
           /* Content, not just count (Grok re-review): the rows are the agent's
              own labels/numbers, and a same-count swap must still re-render. */
           Array.isArray(ctx.usageCategories)
             ? ctx.usageCategories.map((c) => [c && c.label, c && c.tokens, c && c.detail]) : -1] : null,
  ]);
  if (host.hidden === false && sig === ctxpopSig) return;
  ctxpopSig = sig;

  /* A rebuild with focus inside the panel (keyboard activation of Compact
     changes the sig — the compacting flag) destroys the focused node
     mid-use. Remember and restore it (Opus WP9 re-review). */
  const refocus = host.hidden === false && document.activeElement && host.contains(document.activeElement);

  host.textContent = "";
  host.hidden = false;
  meter.setAttribute("aria-expanded", "true");

  const seg = ctx ? segmentsOf(ctx) : null;

  const pop = el("div", "ctxpop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Context window details");

  /* Anchor: under the strip, right-aligned to the meter. Fixed, so the
     canvas scroll never moves it; 240px fits a 600px viewport whole. */
  const rect = meter.getBoundingClientRect();
  pop.style.top = Math.round(rect.bottom) + 6 + "px";
  pop.style.right = Math.max(8, Math.round(window.innerWidth - rect.right)) + "px";

  /* Spec §4: when the state is filling or compacting the header says so, in
     the state colour — steel-strong border for filling (non-blocking, D45),
     the compacting tone while a compact runs. */
  const head = el("div", "ctxpop-head");
  head.appendChild(el("span", "t-med", "Context window"));
  if (v && v.compacting) head.appendChild(el("span", "t-caption ctxpop-state-compacting", "Compacting…"));
  else if (contextNear(v)) head.appendChild(el("span", "t-caption ctxpop-state-filling", "Context filling"));
  pop.appendChild(head);

  if (!ctx || !seg) {
    pop.appendChild(el("p", "t-caption dim",
      (v && v.contextRefused) || (ctx ? "The last reading was incomplete." :
        "No reading yet. The server reads session/info after every turn; nothing has been read for this session in this window. This is not a reading of zero.")));
  } else {
    /* The agent's own percent when it reported one (the strip's near-threshold
       logic reads the same field — one source, no divergence); the derived
       ratio is the fallback for a reading that carries none. Segment rows
       below keep the derived share, because they must sum to the whole. */
    const agentPct = num(ctx.usagePct);
    const usedPct = agentPct !== null ? Math.min(100, agentPct)
      : seg.total > 0 ? Math.min(100, Math.round((seg.used / seg.total) * 100)) : null;
    const tot = el("p", "t-mono-sm ctxpop-total");
    tot.textContent = seg.used.toLocaleString()
      + " / " + seg.total.toLocaleString() + (usedPct === null ? "" : " · " + usedPct + "%");
    pop.appendChild(tot);
    if (v.contextAt) pop.appendChild(el("p", "t-caption dimr", "Read " + ago(v.contextAt) + " ago."));
    if (seg.partial) {
      pop.appendChild(el("p", "t-caption dim",
        "This reading carries only the totals, so the bar is one segment — not a breakdown of zeros."));
    }

    const tbl = el("table", "grid");
    for (const s of seg.list) {
      const tr = el("tr");
      const sw = el("td");
      const chip = el("span", "swatch");
      chip.style.background = "var(" + s.tone + ")";
      if (s.tone === "--ctx-free") chip.style.border = "var(--hairline) solid var(--border-default)";
      sw.appendChild(chip);
      tr.appendChild(sw);
      tr.appendChild(el("td", "t-caption", s.label));
      tr.appendChild(el("td", "num", s.tokens.toLocaleString()));
      tr.appendChild(el("td", "num", Math.min(100, Math.round((s.tokens / seg.total) * 100)) + "%"));
      tbl.appendChild(tr);
    }
    pop.appendChild(tbl);

    const t = num(ctx.autoCompactThresholdPercent);
    pop.appendChild(el("p", "t-caption dim",
      t === null ? "The agent did not report an auto-compact threshold."
                 : "Compacts automatically at " + t + "% — the agent's own number, per model."));

    /* The informational rows. They overlap what is already in the bar (xAI's
       own comment), so they are listed, never stacked — one muted swatch,
       the agent's labels verbatim, zero rows is normal. */
    const tdCount = num(ctx.toolDefinitionsCount);
    const cats = Array.isArray(ctx.usageCategories) ? ctx.usageCategories : [];
    if (num(ctx.toolDefinitionsTokens) !== null || cats.length) {
      pop.appendChild(el("p", "t-caption dim ctxpop-infohead",
        "Already counted in the bar — listed, never added in:"));
      const it = el("table", "grid");
      const infoRow = (label, tokens, detail) => {
        const tr = el("tr");
        const sw = el("td");
        const chip = el("span", "swatch");
        chip.style.background = "var(--ctx-info-row)";
        sw.appendChild(chip);
        tr.appendChild(sw);
        const l = el("td", "t-caption");
        l.textContent = label;
        if (detail) l.appendChild(el("span", "dimr", " · " + detail));
        tr.appendChild(l);
        /* Agent-supplied token counts: a non-number renders "—", never "NaN". */
        const tn = num(tokens);
        tr.appendChild(el("td", "num", tn === null ? "—" : tn.toLocaleString()));
        it.appendChild(tr);
      };
      if (num(ctx.toolDefinitionsTokens) !== null) {
        infoRow("Tool definitions", num(ctx.toolDefinitionsTokens), tdCount === null ? "" : tdCount + " tools");
      }
      /* esc() here is string coercion, NOT HTML-escaping — the safety comes
         from the textContent/text-node sink (D31), never from the helper. */
      for (const cat of cats) infoRow(esc(cat && cat.label), cat && cat.tokens, esc(cat && cat.detail));
      pop.appendChild(it);
    }
  }

  const cb = el("button", "btn btn-sm ctxpop-compact",
    v && v.compacting ? "Compacting…" : "Compact now");
  cb.disabled = compactDisabled(v);
  cb.title = "Ask the agent to summarise this conversation to free context. "
    + "The before and after readings are shown when it finishes.";
  cb.onclick = () => compactNow(activeId);
  pop.appendChild(cb);
  pop.appendChild(el("p", "t-caption dimr",
    "Summarising is what the agent does by itself at the threshold; doing it sooner frees room now. The conversation on disk is not touched."));

  host.appendChild(pop);
  if (refocus) cb.focus(); /* cb is always built and appended above */
}

/* The manual Compact control (WP9). One click sends it — compacting is what
   the agent does unprompted at the threshold, so the dangerous direction
   does not exist here. Honest outcomes on two independent rails: the
   server's before/after session/info sentence (bridge.compacted → a note),
   and the agent's own completion numbers (context.compact_completed → the
   stream). 1.0.0 sends no "started" notice on the manual path (source read
   + live capture), so the hatch and the strip's "Compacting context…" run
   from the click itself, and a JSON-RPC failure comes back as an error,
   never a notice. */
/* True while a compact this page asked for is in flight — the single guard
   every Compact control reads, so a second one can never be started. */
function compactDisabled(v) {
  return !activeId || !!(v && v.compacting) || compactInFlightFor !== null
    || agent.state === "gone" || agent.state === "failed" || agent.state === "respawning";
}

let compactInFlightFor = null;
async function compactNow(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return;
  if (compactInFlightFor) { note("info", "A compact is already running."); return; }
  if (agent.state === "gone") {
    /* D86 reality: recovery is the automatic bounded respawn, not a Reconnect
       control — the sentence points at what actually happens. */
    note("error", "Not compacted — the agent process is gone. It restarts on its own; compact again when it is back.");
    return;
  }
  if (agent.state === "failed") {
    /* A failed start is the one state with a real Try again (D86). */
    note("error", "Not compacted — the agent is not running. Try again on the banner, then compact again.");
    return;
  }
  if (agent.state === "respawning") {
    note("error", "Not compacted — the agent is restarting; try again in a moment.");
    return;
  }
  const v = view(sessionId);
  compactInFlightFor = sessionId;
  if (v) v.compacting = true;
  renderStrip(); scheduleCanvas();
  /* try/finally (Grok WP9 review H1): whatever happens below — a transport
     throw, a wedged request timing out, a render hiccup — the flags clear and
     the surfaces re-render. A stuck "compacting" is a false runtime claim. */
  try {
    /* The server's own ceiling on the compact request is LOAD_TIMEOUT_MS
       (180s). A fetch that outlives that + margin means the SERVER is wedged,
       not the agent — say so and stop waiting (Opus WP9 review H1). The timer
       is cleared the moment the real answer wins the race. */
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ error: "no answer after 190s — the server may be wedged" }), 190_000);
    });
    let res = null;
    try {
      res = await Promise.race([post("/session/compact", { sessionId }, { quiet: true }), timeout]);
    } catch (err) {
      /* post() is built never to reject — but if a future change breaks that,
         the operator still gets the sentence (Grok WP9 re-review). */
      res = { error: (err && err.message) || "the request failed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || res.error) {
      note("error", "Not compacted — " + ((res && res.error) || "no answer from the server") + ". Try again.", res && res.details);
    } else if (typeof res.note !== "string" || !res.note) {
      /* A 200 with no sentence is not an outcome (Opus WP9 review H3). The
         bridge.compacted rail normally carries the sentence to the stream;
         if it ever goes quiet, the operator still gets told something. */
      note("info", "Compact returned, but no before/after sentence came with it — the meter's next reading is the evidence.");
    }
    /* Success otherwise says nothing here: the outcome arrives on its own
       rails — the agent's auto_compact_completed numbers in the stream and
       the server's before/after session/info sentence (bridge.compacted),
       including its "the context did NOT go down" variant when that is what
       happened (sessions.ts compact()). */
  } finally {
    compactInFlightFor = null;
    /* The completed notice may already have cleared the flag; clearing again
       is harmless, and if the notice never arrives this is what stops the
       hatch. renderStrip re-renders the open popover through renderMeter. */
    if (v) v.compacting = false;
    renderStrip(); scheduleCanvas();
  }
}


/* ── THE BANNER ───────────────────────────────────────────────────── */

function renderBanner() {
  const b = $("banner");
  const gone = forcedState === "gone" || forcedState === "respawning" ||
    (!forcedState && (agent.state === "gone" || agent.state === "failed" || agent.state === "respawning"));

  /* Two different failures with two different sentences, and the spec gives
     both. "Agent process gone" is the child dying underneath a server that
     is still answering; "Could not connect" is this page unable to reach the
     server at all. Conflating them tells the user to fix the wrong thing. */
  if (!gone && streamLost) {
    b.dataset.show = "true";
    $("bannerTitle").textContent = "Could not connect";
    $("bannerBody").textContent = "Unable to reach the local agent.";
    $("bannerNote").textContent = TOKEN_OK
      ? "The event stream is disconnected. The browser retries on its own; reload if it does not come back."
      : agent.failure;
    const rb0 = $("btnReconnect");
    rb0.hidden = false;
    rb0.textContent = "Retry";
    rb0.disabled = true;  /* still no reconnect method — the browser retries; the label is spec §2's */
    rb0.onclick = null;
    return;
  }
  $("btnReconnect").textContent = "Reconnect";
  b.dataset.show = gone ? "true" : "false";
  if (!gone) {
    /* A hidden banner never leaves a live handler behind (Grok WP10 M3). */
    const rb1 = $("btnReconnect");
    rb1.hidden = false;
    rb1.disabled = true;
    rb1.onclick = null;
    return;
  }

  /* Spec §2's words for this state, then what the server is actually doing
     underneath them — which the spec could not know about, because the
     bounded respawn (D15) did not exist when it was written. */
  $("bannerTitle").textContent =
    (forcedState === "respawning" || (!forcedState && agent.state === "respawning"))
      ? STATES.respawning.text
      : STATES.gone.text;
  $("bannerBody").textContent = "The local agent process is no longer running. Sessions are preserved.";
  const rb = $("btnReconnect");
  /* WP12 (the director's call): in the gone/respawning states there is NO reconnect
     method, so there is no button — a control that can never be pressed is a
     lie of affordance, and the banner narration already says what is
     happening. The real Try again on the failure states below is untouched. */
  rb.hidden = agent.state !== "failed" || forcedState === "gone" || forcedState === "respawning";
  rb.disabled = true;
  rb.onclick = null;
  let n;
  if (forcedState === "gone" || forcedState === "respawning") {
    n = "FORCED from the Shell tab for a screenshot. The agent is actually '" + agent.state + "'.";
  } else if (agent.state === "respawning") {
    n = "The server is bringing a replacement up now and will reload the open sessions from disk. Restarts so far: " + agent.restarts + ".";
  } else if (agent.state === "failed") {
    /* WP10: a failed start gets one screen, one sentence, and one command —
       and "Try again" is real here (POST /agent/restart re-runs the bring-up;
       a still-broken install fails back into this same screen). */
    const cause = agent.failureCause && agent.failureCause.kind;
    /* Stays disabled while a retry is in flight — a re-render in that window
       must not re-arm a button whose click would be swallowed (Opus M5). */
    rb.disabled = restartInFlightPage;
    rb.textContent = "Try again";
    rb.onclick = retryAgentStart;
    if (cause === "startup_failed") {
      $("bannerTitle").textContent = "The agent could not start";
      const reason = agent.failure || "no reason given";
      /* Only the true not-found shapes get the PATH sentence; any other spawn
         or handshake failure gets the run-it-by-hand command. A wrong command
         is a dishonest diagnosis (Grok WP10 review H5). */
      const notFound = /\bENOENT\b/.test(reason);
      $("bannerBody").textContent = reason + (/[.!?]$/.test(reason) ? "" : ".");
      n = notFound
        ? "The `grok` command was not found on this machine's PATH. Check the install: run `grok --version` in a terminal. When it answers, come back and Try again."
        : "The agent did not come up. Run it by hand to see why: `grok agent --no-leader stdio`. When it starts cleanly, come back and Try again.";
    } else if (cause === "crash_loop") {
      /* The strip and composer already say "keeps crashing" — the banner
         agrees (Grok WP10 re-review L1). */
      $("bannerTitle").textContent = "Agent keeps crashing";
      $("bannerBody").textContent = "The agent died repeatedly; the server stopped restarting it.";
      n = "The server has STOPPED trying to respawn: " + (agent.failure || "no reason given")
        + (/[.!?]$/.test(agent.failure || "") ? "" : ".")
        + " Three fast deaths in a row reached the crash-loop limit, so another respawn was not attempted (D15). Run the agent by hand to see why: `grok agent --no-leader stdio`. When it starts cleanly, come back and Try again.";
    } else {
      /* A failed state the server did not explain gets the weakest true
         wording on the banner too (Codex WP10 confirmation). */
      $("bannerTitle").textContent = "Agent not running";
      $("bannerBody").textContent = "The agent is not running, and the server did not report a cause.";
      n = "The server has STOPPED trying to respawn: " + (agent.failure || "no reason given")
        + (/[.!?]$/.test(agent.failure || "") ? "" : ".")
        + " Run the agent by hand to see why: `grok agent --no-leader stdio`. When it starts cleanly, come back and Try again.";
    }
  } else {
    n = "The server respawns automatically. Restarts so far: " + agent.restarts + "." +
        (agent.failure ? " " + agent.failure : "");
  }
  $("bannerNote").textContent = n;
}

/* WP10: the failure screen's one real action. Single-flight: the button
   re-arms only when the state read-back says the outcome. */
let restartInFlightPage = false;
async function retryAgentStart() {
  if (restartInFlightPage) return;
  restartInFlightPage = true;
  const rb = $("btnReconnect");
  if (rb) rb.disabled = true;
  try {
    const r = await post("/agent/restart", {}, { quiet: true });
    if (!r || r.error) note("error", "Not restarted — " + ((r && r.error) || "no answer from the server") + ". Try again.", r && r.details);
    await refreshState();
  } finally {
    /* Grok WP10 re-review M1: without this, a rejected post or a failed
       read-back leaves the recovery action silently dead until reload. */
    restartInFlightPage = false;
    renderBanner();
  }
}

/* ── WP10/WP15: THE AGENT FACTS PANEL ─────────────────────────────────────
   The instrument's own credentials, shown before any session exists (the
   first-run surface) and permanently in the Agent-wide drawer tab. Every row
   is a reading with its source named and its real lever named; a reading that
   could not be taken says so rather than wearing a default. Nothing here is
   hardcoded (rule 2). WP15 replaces the single privacy row with one row per
   fact and adds the D87 retention switch. */
function renderAgentFacts() {
  /* Staleness fix (WP15): re-read facts when the panel is drawn, so an
     external change (CLI /privacy, upstream enrichment) is not frozen at
     startup. Single-flight so a re-render storm does not stampede the route. */
  requestAgentConfigRefresh();

  const pan = el("div", "panel agent-facts");
  pan.appendChild(el("div", "t-med", "The agent"));
  const tbl = el("table", "grid kv");
  const row = (k, val, tip, hot) => {
    const tr = el("tr");
    tr.appendChild(el("th", "", k));
    const td = el("td", "t-mono-sm");
    td.textContent = val;
    if (tip) td.title = tip;
    if (hot) td.style.color = "var(--state-failed)";
    tr.appendChild(td);
    tbl.appendChild(tr);
    return tr;
  };
  /* A row whose value cell can hold a text reading AND a control (the switch).
     Text is always textContent; the button is a separate node. */
  const rowWithControl = (k, val, tip, control, hot) => {
    const tr = el("tr");
    tr.appendChild(el("th", "", k));
    const td = el("td", "t-mono-sm fact-with-control");
    const span = el("span", "fact-value");
    span.textContent = val;
    if (tip) span.title = tip;
    if (hot) span.style.color = "var(--state-failed)";
    td.appendChild(span);
    if (control) td.appendChild(control);
    tr.appendChild(td);
    tbl.appendChild(tr);
    return tr;
  };

  /* Agent/config strings are unbounded; the panel clamps the visible text,
     and a clamped value's full string rides the tooltip (Grok re-review M2).
     esc() below is string coercion, not HTML-escaping — the sink is
     textContent, always (D31). */
  const clamp60 = (s) => (typeof s === "string" && s.length > 60 ? s.slice(0, 59) + "…" : s);
  const full = (label, s, rest) => (typeof s === "string" && s.length > 60 ? label + ": " + s + " — " + rest : rest);
  row("version",
    agent.agentVersion ? "Grok Build " + clamp60(esc(agent.agentVersion)) : "not reported yet",
    full("Reported version", agent.agentVersion,
      "The version the agent reported in its own initialize handshake. Read off the wire, never hardcoded."));
  row("process",
    agent.pid ? "grok agent --no-leader stdio · pid " + agent.pid
      : agent.state === "starting" ? "starting…" : "not reported",
    "The child process this app spawned, disclosed by name and PID. It is killed when the server exits.");

  const cfg = agent.agentConfig || {};

  /* ── coding-data retention (WP15) ── */
  const rt = cfg.retention || {};
  let optText;
  let optHot = false;
  if (rt.problem) {
    optText = "not read — " + rt.problem;
  } else if (rt.retentionOptOut === undefined) {
    optText = "not read yet";
  } else if (rt.retentionOptOut === true) {
    /* Upstream status.rs: opted out → "your code data will not be trained on…" */
    optText = "Opted out — your code data will not be trained on or used to improve the product";
  } else if (rt.retentionOptOut === false) {
    optText = "Opted in — usage and code data may be used to improve the product";
    optHot = true;
  } else {
    /* Strict booleans only (Grok WP10 C2): null / missing → not stated. */
    optText = "not stated";
  }
  const optTip =
    "Value: coding_data_retention_opt_out, read by name from ~/.grok/auth.json " +
    "(only the named fields ever leave the reader — D81/D88). " +
    "Source: the file at panel open and after every set. " +
    "Lever: this switch, or /privacy opt-out|opt-in in the Grok Build CLI, " +
    "or its Settings → Privacy → Coding data sharing row.";
  const switchBtn = buildRetentionSwitch(rt);
  rowWithControl("coding-data retention", optText, optTip, switchBtn, optHot);

  /* ── zero-data retention / ZDR (WP15, D88) ── */
  let zdrText;
  if (rt.problem) {
    zdrText = "not read — " + rt.problem;
  } else if (rt.isZdr === undefined) {
    zdrText = "not read yet";
  } else if (rt.isZdr === true) {
    zdrText = "ON — your data is not retained or used for training";
  } else if (rt.isZdr === false) {
    zdrText = "OFF";
  } else {
    zdrText = "not stated";
  }
  row("zero-data retention (ZDR)", zdrText,
    "Value: derived from team_blocked_reasons in ~/.grok/auth.json the way upstream does (D88). " +
    "Source: read by name at panel open. " +
    "Lever: set by your team's xAI account — not changeable from any client.");

  /* ── permission default ── */
  const pm = cfg.permissionMode || {};
  let pmText, pmHot = false;
  if (pm.mode == null) {
    pmText = pm.problem ? "not read — " + pm.problem : "not read yet";
  } else if (pm.mode === "ask" || pm.mode === "default") {
    pmText = "Ask before running";
  } else if (pm.mode === "always-approve") {
    pmText = "⚠ Approving everything";
    pmHot = true;
  } else if (pm.mode === "auto") {
    /* A real, known value (upstream permissions.rs): the classifier decides
       per action what needs approval — neither "asks" nor "approves
       everything", and not a warning state (Opus WP10 confirmation M2). */
    pmText = "Auto — the agent decides what needs approval";
  } else {
    /* The agent's own word, verbatim — "auto" or anything a future config adds. */
    pmText = clamp60(esc(pm.mode)) + " (the config's own word)";
  }
  row("permission default", pmText + (pm.problem && pm.mode != null ? " — note: " + pm.problem : ""),
    full("Configured mode", pm.mode,
      "Value: [ui].permission_mode in ~/.grok/config.toml. " +
      "Source: read at panel open and on every Try again."
      + (pm.source && pm.source !== "permission_mode" ? " Set by the legacy '" + pm.source + "' key." : "")
      + " Lever: [ui].permission_mode in ~/.grok/config.toml — this app never writes it (D60)."
      + " The live always-approve state is the switch in the strip, not this row."),
    pmHot);

  /* ── always-true product sentence ── */
  row("inference",
    "Always remote — a local UI changes nothing about where the model runs",
    "Owned by this product, not a reading. Grok Build's inference is remote regardless of this app.");

  pan.appendChild(tbl);
  return pan;
}

/* Single-flight re-read of agentConfig when the facts panel is shown. */
let agentConfigRefreshInFlight = false;
let agentConfigRefreshAt = 0;
function requestAgentConfigRefresh() {
  const now = Date.now();
  /* Debounce: not more than once per 2s from re-renders of the same open panel. */
  if (agentConfigRefreshInFlight || now - agentConfigRefreshAt < 2000) return;
  agentConfigRefreshInFlight = true;
  agentConfigRefreshAt = now;
  post("/agent/config-facts", {}, { quiet: true }).then((r) => {
    agentConfigRefreshInFlight = false;
    if (!r || r.error || !r.agentConfig) return;
    const prev = JSON.stringify(agent.agentConfig || null);
    const next = JSON.stringify(r.agentConfig);
    if (prev === next) return;
    agent.agentConfig = r.agentConfig;
    renderAll();
  }).catch(() => { agentConfigRefreshInFlight = false; });
}

/** The D87 retention switch. Opt-OUT (safe) commits on one click; opt-IN
    (privacy-degrading) opens an explicit confirm. Never flips optimistically. */
function buildRetentionSwitch(rt) {
  if (rt.problem) return null;
  if (rt.retentionOptOut !== true && rt.retentionOptOut !== false) return null;
  const optedOut = rt.retentionOptOut === true;
  const btn = el("button", "btn fact-switch");
  btn.type = "button";
  btn.dataset.variant = optedOut ? "ghost" : "primary";
  /* Current state is opted-out → the action is opt-IN (needs confirm).
     Current state is opted-in  → the action is opt-OUT (one click). */
  btn.textContent = optedOut ? "Opt in…" : "Opt out";
  btn.title = optedOut
    ? "Share usage and code data to improve the product. Requires confirmation."
    : "Stop sharing coding data for training. Safe direction — one click.";
  btn.disabled = retentionSwitchBusy || agent.state !== "ready";
  btn.onclick = (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    if (retentionSwitchBusy) return;
    if (optedOut) {
      /* Privacy-degrading direction — explicit confirm (D87 asymmetry). */
      modal = { kind: "retentionOptIn" };
      renderModal();
    } else {
      /* Safe direction — commit directly. */
      void setRetention(true);
    }
  };
  return btn;
}

let retentionSwitchBusy = false;

/**
 * Drive the D87 switch. Three honest outcomes only — never an optimistic flip.
 *   verified | acknowledged_not_confirmed | refused
 */
async function setRetention(codingDataRetentionOptOut) {
  if (retentionSwitchBusy) return;
  retentionSwitchBusy = true;
  renderAll();
  try {
    const res = await post("/agent/retention", { codingDataRetentionOptOut }, { quiet: true });
    if (res && res.agentConfig) agent.agentConfig = res.agentConfig;
    if (!res || res.error && !res.outcome) {
      note("error", "Retention change failed — " + ((res && res.error) || "no response") + ".", res && res.details);
    } else if (res.outcome === "verified") {
      note("info", res.note || "Verified — the local file matches the request.");
    } else if (res.outcome === "acknowledged_not_confirmed") {
      note("error", res.note || "Acknowledged, not confirmed — the account may have changed while the local file did not.");
    } else if (res.outcome === "refused") {
      /* Agent error, verbatim, as text (hostile input, rule 10). */
      note("error", res.note || ("Refused — " + (res.error || "the agent refused.")), res.details);
    } else {
      note("error", "Retention change returned an unexpected shape — nothing was assumed.", res && res.details);
    }
  } finally {
    retentionSwitchBusy = false;
    /* Force a fresh facts read so the panel cannot show a pre-click value. */
    agentConfigRefreshAt = 0;
    await refreshState();
    renderAll();
  }
}

/* ── THE COMPOSER ─────────────────────────────────────────────────── */

function renderComposer(rec, v) {
  const gone = agent.state === "gone" || agent.state === "failed" || forcedState === "gone";
  /* Spec §1: on "agent process gone" the input is disabled and the left
     rail stays usable. */
  $("prompt").placeholder = activeId
    ? "Continue or give a new instruction…"
    : "What do you want to build?";

  /* ── WHAT MAKES SEND POSSIBLE ────────────────────────────────────────
     Four conditions, and each of them is a real thing that can be false:

       · a token, or every request is a 403 (D10)
       · an agent that is up
       · a session selected AND held open by this app — a row in the rail
         that this app has not loaded receives no events, so a prompt sent
         into it would run with nothing on screen
       · no turn already running. `session/prompt` is one-at-a-time per
         session and the server throws rather than queueing.

     `rec.turnInFlight` is the server's answer, not ours: it is set when the
     request goes out and cleared in a `finally`, so it survives a turn that
     fails in a way no event describes. */
  const held = !!(rec && rec.live);
  const running = !!(rec && rec.turnInFlight);
  const canSend = TOKEN_OK && !gone && held && !running && !sending;
  $("prompt").disabled = !TOKEN_OK || gone || !held;
  $("btnSend").disabled = !canSend;
  /* `sending` is the one piece of state with no event behind it: the window
     between the POST leaving and the 202 coming back. Naming it keeps the button
     honest for that window instead of inviting a second send into it. */
  $("btnSend").textContent = sending ? "Sending…" : "Send";
  /* Stop is `session/cancel`, which is a NOTIFICATION — there is nothing to
     confirm it and nothing that acknowledges it. It is enabled exactly while a
     turn is in flight, because sending it at any other time does nothing and
     the server says so. */
  $("btnStop").disabled = !(TOKEN_OK && !gone && held && running);

  /* WP7. The plan toggle and the effort selector, both of them drawn from
     agent-reported state and never from an acknowledgement. */
  renderPlanToggle(rec, !TOKEN_OK || gone || !held);
  renderEffort(rec, !TOKEN_OK || gone || !held);

  /* The model's own display name, falling back to the raw id. The effort no
     longer rides here as a suffix — it has its own control now, and one fact
     with two homes is one fact that can disagree with itself. */
  $("modelReadout").textContent = rec ? modelDisplayName(rec) : "";

  /* One short line, because this sits in a wrapping flex row and the composer
     has a 72px floor to keep. The long version is the title attribute. */
  const n = $("composerNote");
  const effortSaid = rec && effortNotice.has(rec.sessionId)
    ? effortNotice.get(rec.sessionId).text
    /* The other thing the effort control cannot say on its own face: the agent
       has replaced its option list and the effort this session is on is no
       longer in it. The box keeps showing the agent's own reading either way. */
    : (rec && effortIsOrphaned(rec) ? "Effort options changed — showing what the agent reports." : null);
  let short, long;
  if (!TOKEN_OK) {
    short = "No run token — every request is refused.";
    long = "This page was not served by the studio. Use the URL it printed at startup.";
  } else if (gone) {
    /* WP10: "gone", "could not start", "keeps crashing" and "we were not told"
       are different truths (Opus WP10 re-review M1). */
    const failedKind = agent.failureCause && agent.failureCause.kind;
    short = agent.state !== "failed"
      ? "Input disabled — the agent process is gone."
      : failedKind === "crash_loop"
        ? "Input disabled — the agent keeps crashing."
        : failedKind === "startup_failed"
          ? "Input disabled — the agent could not start."
          : "Input disabled — the agent is not running.";
    long = agent.state !== "failed"
      ? "The local agent process is no longer running. Sessions are preserved."
      : failedKind === "crash_loop"
        ? "The agent died repeatedly and the server stopped restarting it. The banner names the command to run by hand."
        : failedKind === "startup_failed"
          ? "The agent never came up. The banner above names the command to run."
          : "The agent is not running and the server did not say why. The banner has what is known.";
  } else if (!activeId) {
    short = "Select a session on the left.";
    long = "Nothing is selected, so there is nowhere to send a prompt.";
  } else if (!held) {
    short = "This session is on disk — open it to send anything.";
    long = "This app is not holding this session open, so it receives no events for it and a prompt would run invisibly. Click it in the rail to load it.";
  } else if (running) {
    short = "A turn is running · Stop cancels it.";
    long = "One turn runs at a time per session. Stop asks the agent to cancel — a notification, so nothing acknowledges it; the turn's own ending is the confirmation.";
  } else if (effortSaid) {
    /* The one outcome that has no other home: what the agent kept instead of
       what was asked for. It is agent text and it reaches the DOM as text. */
    short = effortSaid;
    long = effortSaid;
  } else {
    short = "Ctrl+Enter sends · type / for commands.";
    long = "Enter inserts a line break; Ctrl+Enter or Cmd+Enter sends. Typing / as the first character opens the agent's own command list. Permission, plan and question requests are answered on their cards in the conversation.";
  }
  n.textContent = short;
  n.title = long;
  /* Phone layout may hide routine help, but never the only visible reason a
     control is unavailable or an effort request was not confirmed. */
  n.dataset.important = (!TOKEN_OK || gone || !activeId || !held || !!effortSaid) ? "true" : "false";

  /* The launcher belongs to one session and to a composer that can be typed
     into. Anything else closes it — including a session switch, which is the
     one case where leaving it open would paint session A's list over B. */
  if (launcher && (launcher.sessionId !== activeId || $("prompt").disabled)) launcher = null;
  renderLauncher();
}

/* ── WP7: THE PLAN TOGGLE ─────────────────────────────────────────────────

   One control, one wire fact, and a permanent honest gap between them.

   `session/set_mode` returns an empty success for ANY string, including typos
   and ids that do not exist, so the response is not evidence and the click is
   not evidence either. The only evidence is `current_mode_update`, and that
   fires on plan ENTER and plan EXIT and at no other time — on exit it echoes
   back whatever id was sent, including a garbage one (CONFIRMED, grok 1.0.0).

   So: plan is on IFF the last announced id is exactly `plan`. Every other
   announced id, garbage included, is off — and a garbage id is never displayed
   as a recognised mode. Before any announcement there is nothing to report, and
   D72 says so in words rather than claiming a confident off.
   ─────────────────────────────────────────────────────────────────────── */

const PLAN_TIPS = {
  unknown: "The agent only announces plan mode when it turns on or off. Nothing has been announced for this session, which almost always means plan mode is off.",
  on: "Plan mode is on. The agent will propose a plan and wait for your approval before changing anything.",
  off: "The agent announced plan mode is off.",
  turningOn: "Waiting for the agent to announce plan mode. Its answer to the request proves nothing, so only the announcement counts.",
  turningOff: "Waiting for the agent to announce that plan mode is off.",
  noAnswer: "The agent never announced a change. Asking always succeeds even when nothing changes, so plan mode is shown as it was.",
  unavailable: "No session is open here.",
  /* The composer's existing sentences already say WHY input is dead — no run
     token, agent gone, session not held — so this points at them rather than
     writing a fourth copy that can drift out of step with the other three. */
  blocked: "Plan mode cannot be changed right now. The note beside the composer says why.",
};

/** What the toggle should say right now. Pure — it reads state, it writes none. */
function planFace(rec) {
  if (!rec) return { available: false, on: false, busy: false, word: "", tip: PLAN_TIPS.unavailable };
  /* Anything that is not a string id is "never announced" — the same state as
     null, and never a confident off. */
  const confirmed = typeof rec.confirmedModeId === "string" ? rec.confirmedModeId : null;
  const on = confirmed === "plan";
  const pending = planBusy.get(rec.sessionId);
  if (pending) {
    return {
      available: true, busy: true, on,
      word: pending.want === "plan" ? "turning on…" : "turning off…",
      tip: pending.want === "plan" ? PLAN_TIPS.turningOn : PLAN_TIPS.turningOff,
    };
  }
  const never = confirmed === null;
  let word = never ? "off · not confirmed" : (on ? "on" : "off");
  let tip = never ? PLAN_TIPS.unknown : (on ? PLAN_TIPS.on : PLAN_TIPS.off);
  const notice = planNotice.get(rec.sessionId) || null;
  if (notice) {
    if (notice.word) word = notice.word;
    if (notice.tip) tip = notice.tip;
    /* A mismatch keeps the ordinary on/off word — the EVENT is the truth — and
       explains itself in the tooltip, where the agent's own id is text. */
    if (notice.extra) tip = notice.extra + " " + tip;
  }
  return { available: true, busy: false, on, word, tip };
}

function renderPlanToggle(rec, composerDead) {
  const btn = $("btnPlan");
  const state = $("planState");
  const face = planFace(rec);
  /* Steel only. Gold means "the machine is waiting for you" (D45) and a mode
     toggle never is. */
  btn.dataset.toggle = face.on ? "on" : "off";
  /* Unavailable is a real disable. A request in flight is NOT: disabling a
     focused button hands focus back to the document, and the brief asks for the
     control to be disabled AND to keep focus. aria-disabled plus the guard in
     togglePlan() is the pattern that delivers both. */
  const unavailable = !face.available || composerDead;
  btn.disabled = unavailable;
  btn.dataset.busy = face.busy ? "true" : "false";
  btn.setAttribute("aria-disabled", face.busy || unavailable ? "true" : "false");
  /* aria-pressed is the CONFIRMED state only — false for unknown, because a
     control that says "not pressed" is a weaker claim than one that says
     "unknown", and unknown has its own words beside it. */
  btn.setAttribute("aria-pressed", face.on ? "true" : "false");
  /* Unavailable carries NO state word: a mode reading beside a control that
     cannot be used, on a session this app is not holding, would be a claim
     about something we are not listening to. */
  btn.title = unavailable ? (face.available ? PLAN_TIPS.blocked : PLAN_TIPS.unavailable) : face.tip;
  /* The state word is part of the accessible name, so a screen reader hears
     "Plan mode, off · not confirmed" rather than a bare toggle. */
  btn.setAttribute("aria-label", unavailable || !face.word ? "Plan mode" : "Plan mode · " + face.word);
  state.textContent = unavailable ? "" : face.word;
  state.title = state.textContent ? face.tip : "";
}

async function togglePlan() {
  const rec = heldRecord(activeId);
  if (!rec) return;
  /* The guard the aria-disabled face promises. A second click inside the
     pending window would start a second set_mode against the same session. */
  if (planBusy.has(rec.sessionId)) return;
  const sessionId = rec.sessionId;
  /* The two fixed constants this app owns — the only mode ids it ever sends. */
  const want = rec.confirmedModeId === "plan" ? "default" : "plan";
  planBusy.set(sessionId, { want });
  planNotice.delete(sessionId);
  renderComposerNow();

  const r = await post("/session/mode", { sessionId, modeId: want }, { quiet: true });
  planBusy.delete(sessionId);

  if (!r || r.error) {
    const why = esc(r && r.error ? r.error : "no reason given");
    planNotice.set(sessionId, { word: "not sent", tip: "Not sent — " + why + ". Try again.", extra: null });
    if (activeId === sessionId) announce("Plan mode was not changed. Not sent — " + why + ".");
  } else if (!r.verified) {
    /* Success and silence. The most common honest outcome there is. */
    planNotice.set(sessionId, { word: "no answer — unchanged", tip: PLAN_TIPS.noAnswer, extra: null });
    if (activeId === sessionId) announce("No answer from the agent — plan mode unchanged.");
  } else if (!r.matched) {
    /* An announcement arrived naming something else. The face follows the
       announcement; this says why it differs from what was clicked. */
    const said = esc(r.readBack);
    planNotice.set(sessionId, {
      word: null, tip: null,
      extra: "You asked for plan mode " + (want === "plan" ? "on" : "off") +
             "; the agent announced '" + said + "' instead. What the agent announced is what is shown.",
    });
    if (activeId === sessionId) announce("The agent announced '" + said + "' instead.");
  } else {
    planNotice.delete(sessionId);
    if (activeId === sessionId) announce(want === "plan" ? "Plan mode is on." : "Plan mode is off.");
  }
  await refreshState();
  renderComposerNow();
}

/* ── WP7: THE RUNTIME EFFORT SELECTOR (D71) ───────────────────────────────

   Every option in this control is the agent's own: its ids, its order, its
   labels, its descriptions and its own `default` flag. There is no
   Quick/Balanced/Careful map — a fixed three-level alias becomes a lie the day
   a model renames a level or adds a fourth, and the runtime labels are already
   plain English.

   The face is the ROSTER read-back and nothing else. `set_model` returns the
   identical success payload for an effort that took and one that was silently
   discarded (CONFIRMED: "ULTRA" → the model default), so the acknowledgement
   is the one thing that cannot be believed.
   ─────────────────────────────────────────────────────────────────────── */

/** The newest full model catalogue for this session. Options only, never the value. */
function modelCatalogue(rec) {
  if (!rec) return null;
  let best = null;
  const consider = (payload, seq) => {
    if (!payload || !Array.isArray(payload.availableModels)) return;
    if (best === null || seq >= best.seq) best = { seq, payload };
  };
  /* The snapshot taken at session/new or session/load is the floor. */
  consider(rec.models, 0);
  if (modelsUpdate) consider(modelsUpdate.payload, modelsUpdate.seq);
  const v = sess.get(rec.sessionId);
  if (v && v.modelsUpdate) consider(v.modelsUpdate.payload, v.modelsUpdate.seq);
  return best ? best.payload : null;
}

function currentModelEntry(rec) {
  const cat = modelCatalogue(rec);
  if (!cat) return null;
  const id = rec.modelId || (typeof cat.currentModelId === "string" ? cat.currentModelId : null);
  if (!id) return null;
  return cat.availableModels.find((m) => m && m.modelId === id) || null;
}

function modelDisplayName(rec) {
  const entry = currentModelEntry(rec);
  const name = entry && typeof entry.name === "string" && entry.name !== "" ? entry.name : null;
  return name || rec.modelId || "model not reported";
}

/**
 * The agent's effort levels for the current model, or null when it reports
 * none. Null means NO CONTROL — never an invented "Default" option.
 */
function effortOptions(rec) {
  const entry = currentModelEntry(rec);
  const meta = entry && entry._meta && typeof entry._meta === "object" ? entry._meta : null;
  if (!meta) return null;
  if (meta.supportsReasoningEffort === false) return null;
  if (!Array.isArray(meta.reasoningEfforts)) return null;
  const out = [];
  for (const e of meta.reasoningEfforts) {
    if (!e || typeof e !== "object") continue;
    const id = typeof e.id === "string" && e.id !== "" ? e.id
      : (typeof e.value === "string" && e.value !== "" ? e.value : null);
    if (id === null) continue;
    out.push({
      id,
      label: typeof e.label === "string" && e.label !== "" ? e.label : id,
      description: typeof e.description === "string" ? e.description : "",
      isDefault: e.default === true,
    });
  }
  return out.length ? out : null;
}

/** What the roster says this session's effort IS. Never metadata or a request. */
function currentEffort(rec) {
  if (rec && typeof rec.reasoningEffort === "string" && rec.reasoningEffort !== "") {
    return rec.reasoningEffort;
  }
  return null;
}

/** True when the session's own effort is not in the list the agent now offers. */
function effortIsOrphaned(rec) {
  const opts = effortOptions(rec);
  if (!opts) return false;
  const cur = currentEffort(rec);
  return cur !== null && !opts.some((o) => o.id === cur);
}

/** The agent's label for an effort id, falling back to the id it reported. */
function effortLabel(rec, id) {
  if (typeof id !== "string" || id === "") return "";
  const found = (effortOptions(rec) || []).find((o) => o.id === id);
  return found ? found.label : id;
}

function renderEffort(rec, composerDead) {
  const wrap = $("effortWrap");
  const sel = $("effortSelect");
  const opts = rec ? effortOptions(rec) : null;
  if (!opts) {
    /* No metadata, an empty list, or the model saying it has no effort axis.
       The control does not exist — there is nothing honest to put in it. */
    wrap.hidden = true;
    sel.textContent = "";
    sel.dataset.sig = "";
    return;
  }
  wrap.hidden = false;
  const cur = currentEffort(rec);
  const busy = effortBusy.has(rec.sessionId);
  sel.disabled = busy || composerDead;

  /* Rebuilt only when the runtime data actually changed: a select rebuilt on
     every repaint would close itself under the operator's hand. */
  const known = opts.some((o) => o.id === cur);
  const sig = JSON.stringify([opts.map((o) => [o.id, o.label, o.description, o.isDefault]), cur, known]);
  if (sel.dataset.sig !== sig) {
    sel.textContent = "";
    if (cur !== null && !known) {
      /* The roster reports an effort this option list does not contain — after
         a models/update that dropped it, most likely. Roster truth wins: its
         own id goes in the box rather than some other option being selected
         silently on the operator's behalf. */
      const orphan = el("option", null, cur);
      orphan.value = cur;
      orphan.title = "The agent reports this effort for the session, but it is not one of the options it is offering now.";
      sel.appendChild(orphan);
    }
    for (const o of opts) {
      /* " (default)" is the agent's own `default: true`, displayed. It is not
         a label we chose. */
      const opt = el("option", null, o.isDefault ? o.label + " (default)" : o.label);
      opt.value = o.id;
      if (o.description) opt.title = o.description;
      sel.appendChild(opt);
    }
    sel.dataset.sig = sig;
  }
  /* A native select changes its own face before `change` fires. Restore the
     roster reading on every render so the requested value is never displayed
     as if it were already confirmed. */
  if (cur === null) sel.selectedIndex = -1;
  else sel.value = cur;

  const chosen = opts.find((o) => o.id === cur);
  sel.title = busy
    ? "Waiting for the agent to report which effort it kept."
    : (cur === null
        ? "The agent has not reported which effort this session is using."
        : (chosen && chosen.description ? chosen.description : "Reported by the agent: " + cur));
}

async function setEffort(id) {
  const rec = heldRecord(activeId);
  if (!rec || typeof id !== "string" || id === "") return;
  if (effortBusy.has(rec.sessionId)) return;
  const sessionId = rec.sessionId;
  const cat = modelCatalogue(rec);
  /* Effort rides on set_model, so the model id must go with it — the CURRENT
     one, read back from the roster or the agent's own catalogue. Sending a
     different model as a side effect of changing effort is the trap here. */
  const modelId = rec.modelId || (cat && typeof cat.currentModelId === "string" ? cat.currentModelId : null);
  if (!modelId) {
    effortNotice.set(sessionId, { text: "The agent has not reported which model this session uses, so the effort cannot be changed without guessing one." });
    renderComposerNow();
    return;
  }
  effortBusy.set(sessionId, { id });
  effortNotice.delete(sessionId);
  renderComposerNow();

  const r = await post("/session/model", { sessionId, modelId, reasoningEffort: id }, { quiet: true });
  effortBusy.delete(sessionId);

  if (!r || r.error) {
    const why = esc(r && r.error ? r.error : "no reason given");
    effortNotice.set(sessionId, { text: "Not set — " + why + ". Try again." });
    if (activeId === sessionId) announce("Effort was not changed. Not sent — " + why + ".");
    renderComposerNow();
    return;
  }
  if (!r.verified || !r.readBack || typeof r.readBack.reasoningEffort !== "string") {
    effortNotice.set(sessionId, {
      text: "The agent did not report which effort this session is using, so the change is unverified.",
    });
    if (activeId === sessionId) announce(effortNotice.get(sessionId).text);
    await refreshState();
    renderComposerNow();
    return;
  }
  /* This result is the server's roster read-back, not the set_model ack. */
  const back = r.readBack.reasoningEffort;
  await refreshState();
  const after = heldRecord(sessionId) || (agent.sessions || []).find((s) => s.sessionId === sessionId) || rec;
  /* If the follow-up /state refresh failed, preserve the same verified reading
     locally rather than leaving an older face beside a newer outcome. */
  after.modelId = typeof r.readBack.modelId === "string" ? r.readBack.modelId : after.modelId;
  after.reasoningEffort = back;
  if (back === id) {
    effortNotice.delete(sessionId);
    if (activeId === sessionId) announce("Effort set to " + effortLabel(after, back) + ".");
  } else if (back === null) {
    /* Not a mismatch — an unread. Saying "the agent kept ''" would put a
       sentence about the agent on screen that nothing on the wire supports. */
    effortNotice.set(sessionId, {
      text: "The agent did not report which effort this session is using, so the change is unverified.",
    });
    if (activeId === sessionId) announce(effortNotice.get(sessionId).text);
  } else {
    effortNotice.set(sessionId, {
      text: "The agent kept '" + esc(effortLabel(after, back)) + "' — it did not recognise the requested effort.",
    });
    if (activeId === sessionId) announce(effortNotice.get(sessionId).text);
  }
  renderComposerNow();
}

/* ── WP7: THE SLASH LAUNCHER ──────────────────────────────────────────────

   Typing `/` as the FIRST character opens the agent's own command list above
   the box. Everything in it — names, descriptions, argument hints — is the
   agent's text, live-queried per session, never curated, never filtered, never
   rewritten, and never hardcoded. Choosing a row inserts ordinary prompt text;
   there is no command API to call and nothing runs until the operator sends.

   The list is hostile input twice over: a poisoned repository can define a
   skill whose description is an instruction, and a menu is exactly the surface
   where that is easiest to forget. Every row is built with el(), which is
   textContent, and nothing here derives an attribute from agent text except
   `title`, which is a property assignment and not markup.
   ─────────────────────────────────────────────────────────────────────── */

const LAUNCHER_WORDS = {
  loading: "Reading the command list…",
  empty: "The agent reports no commands for this session.",
  failed: "The command list could not be read. Type the command if you know it — it will still be sent as text.",
};

/** The record for a session this app is holding open, or null. */
function heldRecord(sessionId) {
  if (!sessionId) return null;
  const rec = (agent.sessions || []).find((s) => s.sessionId === sessionId) || null;
  return rec && rec.live ? rec : null;
}

/** Rank a catalogue against a query. Substring, three groups, agent order inside each. */
function rankCommands(list, query) {
  const q = String(query || "").toLowerCase();
  const prefix = [], substring = [], text = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const name = typeof c.name === "string" ? c.name : "";
    /* A row the agent sent with no name cannot be inserted as `/name`, so it is
       not offered. It is still counted, and the footer says how many. */
    if (name === "") continue;
    const desc = typeof c.description === "string" ? c.description : "";
    const hint = c.input && typeof c.input.hint === "string" ? c.input.hint : "";
    const row = { name, desc, hint };
    if (q === "") { prefix.push(row); continue; }
    const n = name.toLowerCase();
    if (n.indexOf(q) === 0) prefix.push(row);
    else if (n.indexOf(q) !== -1) substring.push(row);
    else if (desc.toLowerCase().indexOf(q) !== -1 || hint.toLowerCase().indexOf(q) !== -1) text.push(row);
  }
  return prefix.concat(substring, text);
}

function readableCommands(list) {
  return Array.isArray(list) && list.every((command) =>
    command && typeof command === "object" &&
    typeof command.name === "string" && command.name.trim() !== "");
}

/** A replacement agent generation must not inherit the old one's option list. */
function clearModelUpdates() {
  modelsUpdate = null;
  modelsUpdateSeq = 0;
  for (const sessionView of sess.values()) sessionView.modelsUpdate = null;
}

function launcherStatus() {
  if (!launcher) return "closed";
  const v = sess.get(launcher.sessionId);
  if (v && Array.isArray(v.commands)) return "ready";
  if (v && v.commandsFailed) return "failed";
  return "loading";
}

/**
 * Rebuild the visible rows from whatever catalogue is current.
 * `keepActive` preserves the highlighted command BY NAME across a live update;
 * a query change starts again at the first result.
 */
function rebuildLauncherRows(keepActive) {
  if (!launcher) return;
  const was = keepActive && launcher.rows && launcher.rows[launcher.active]
    ? launcher.rows[launcher.active].name : null;
  const v = sess.get(launcher.sessionId);
  const list = v && Array.isArray(v.commands) ? v.commands : [];
  launcher.total = v && Array.isArray(v.commands) ? list.length : null;
  launcher.rows = rankCommands(list, launcher.query);
  launcher.dropped = list.filter((c) => !c || typeof c !== "object" || typeof c.name !== "string" || c.name === "").length;
  const at = was === null ? -1 : launcher.rows.findIndex((r) => r.name === was);
  launcher.active = at === -1 ? 0 : at;
}

/** Ask the agent for this session's list. Only a valid array ever replaces one. */
function queryCommands(sessionId) {
  const started = view(sessionId);
  if (!started) return;
  const revision = ++started.commandsRevision;
  post("/commands/list", { sessionId }).then((r) => {
    const v = view(sessionId);
    if (!v || v.commandsRevision !== revision) return;
    if (r && readableCommands(r.commands)) {
      v.commands = r.commands;
      v.commandsFailed = false;
    } else if (!Array.isArray(v.commands)) {
      /* A read failure with no earlier good list: unavailable, never empty. */
      v.commandsFailed = true;
    }
    if (launcher && launcher.sessionId === sessionId) {
      rebuildLauncherRows(true);
      renderLauncher();
      if (!launcher.announced) {
        launcher.announced = true;
        const status = launcherStatus();
        announce(status === "ready"
          ? launcher.total + (launcher.total === 1 ? " command" : " commands")
          : (status === "failed" ? LAUNCHER_WORDS.failed : LAUNCHER_WORDS.loading));
      }
    }
  });
}

/** Open, refilter, or close, decided entirely by what is in the box. */
function syncLauncher() {
  const box = $("prompt");
  const value = String(box.value || "");
  /* A command occupies one slash-prefixed token. A second slash or backslash
     inside that token means a path, not launcher intent. */
  const token = value.split(/\s/, 1)[0];
  const commandIntent = value.charAt(0) === "/" &&
    token.slice(1).indexOf("/") === -1 && token.slice(1).indexOf("\\") === -1;
  if (box.disabled || !activeId || !commandIntent) {
    if (launcher) { launcher = null; renderLauncher(); }
    return;
  }
  const caret = typeof box.selectionStart === "number" ? box.selectionStart : value.length;
  const query = value.slice(1, Math.max(1, caret));
  if (!launcher || launcher.sessionId !== activeId) {
    launcher = { sessionId: activeId, query, rows: [], active: 0, total: null, dropped: 0, announced: false };
    rebuildLauncherRows(false);
    renderLauncher();
    /* Re-queried on every open. A cached list is drawn immediately so the
       overlay is never blank, and replaced the moment a valid one arrives. */
    queryCommands(activeId);
    if (launcherStatus() === "ready") {
      launcher.announced = true;
      announce(launcher.total + (launcher.total === 1 ? " command" : " commands"));
    }
    return;
  }
  launcher.query = query;
  rebuildLauncherRows(false);
  renderLauncher();
}

function closeLauncher() {
  launcher = null;
  renderLauncher();
}

function renderLauncher() {
  const host = $("launcherHost");
  const box = $("prompt");
  const status = launcherStatus();
  /* Repainted only when something it shows actually changed.
     `renderComposer` runs on EVERY event, so an unconditional rebuild would
     throw the list away on every streamed chunk — losing the scroll position
     under the operator's hand mid-turn — and would let a hover handler that
     repaints the row it is hovering chase itself. */
  const signature = launcher === null ? "closed" : JSON.stringify([
    launcher.sessionId, launcher.query, launcher.active, launcher.total,
    launcher.dropped, status, launcher.rows.map((r) => [r.name, r.desc, r.hint]),
  ]);
  if (host.dataset.sig === signature) return;
  host.dataset.sig = signature;

  host.textContent = "";
  if (!launcher) {
    host.hidden = true;
    box.removeAttribute("role");
    box.removeAttribute("aria-expanded");
    box.removeAttribute("aria-controls");
    box.removeAttribute("aria-activedescendant");
    box.removeAttribute("aria-autocomplete");
    return;
  }
  host.hidden = false;
  const panel = el("div", "launcher");
  const list = el("div", "launcher-list");
  list.id = "launcherList";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Commands the agent reports");

  if (status === "loading") {
    panel.appendChild(el("div", "launcher-msg t-caption", LAUNCHER_WORDS.loading));
  } else if (status === "failed") {
    panel.appendChild(el("div", "launcher-msg t-caption", LAUNCHER_WORDS.failed));
  } else if (launcher.total === 0) {
    panel.appendChild(el("div", "launcher-msg t-caption", LAUNCHER_WORDS.empty));
  } else if (launcher.rows.length === 0) {
    panel.appendChild(el("div", "launcher-msg t-caption", "No commands match '" + esc(launcher.query) + "'."));
  } else {
    launcher.rows.forEach((row, i) => {
      const active = i === launcher.active;
      const btn = el("button", "launcher-row");
      btn.id = "lcmd-" + i;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.type = "button";
      btn.tabIndex = -1;
      const head = el("div", "lr-head");
      /* Not colour alone: the active row carries a text marker as well. */
      head.appendChild(el("span", "lr-mark", active ? "›" : " "));
      head.appendChild(el("span", "lr-name", "/" + row.name));
      if (row.hint) head.appendChild(el("span", "lr-hint trunc", row.hint));
      btn.appendChild(head);
      if (row.desc) btn.appendChild(el("div", "lr-desc", row.desc));
      /* The whole of a truncated description stays reachable without a pointer
         — the row's accessible name carries it in full. */
      btn.title = row.desc || "";
      btn.setAttribute("aria-label",
        "/" + row.name + (row.hint ? " " + row.hint : "") + (row.desc ? " — " + row.desc : ""));
      btn.onmouseenter = () => { if (launcher) { launcher.active = i; renderLauncher(); } };
      btn.onclick = () => acceptCommand(i);
      list.appendChild(btn);
    });
  }
  panel.appendChild(list);

  if (status === "ready") {
    /* The honesty line, and the evidence hook: this number is the agent's own
       count, and it can be held up next to commands/list. */
    const foot = el("div", "launcher-foot",
      launcher.total + " commands · from the agent, unfiltered");
    if (launcher.dropped > 0) {
      foot.appendChild(el("div", null,
        launcher.dropped + " of them arrived with no name and cannot be inserted."));
    }
    panel.appendChild(foot);
  }
  host.appendChild(panel);

  /* Combobox semantics, and only while there is a popup to describe. The
     textarea never loses focus — that is the whole point of the pattern. */
  box.setAttribute("role", "combobox");
  box.setAttribute("aria-expanded", "true");
  box.setAttribute("aria-controls", "launcherList");
  box.setAttribute("aria-autocomplete", "list");
  if (status === "ready" && launcher.rows.length > 0) {
    box.setAttribute("aria-activedescendant", "lcmd-" + launcher.active);
  } else {
    box.removeAttribute("aria-activedescendant");
  }
}

function moveLauncher(delta) {
  if (!launcher || !launcher.rows.length) return;
  /* Clamped, never wrapping: predictable beats clever at ninety rows. */
  launcher.active = Math.max(0, Math.min(launcher.rows.length - 1, launcher.active + delta));
  renderLauncher();
  const row = $("lcmd-" + launcher.active);
  if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
}

/**
 * Put the chosen command in the box as ordinary prompt text. NOTHING RUNS.
 * Everything from the leading `/` to the caret is replaced; anything the
 * operator had typed after the caret is left alone.
 */
function acceptCommand(index) {
  if (!launcher) return;
  const row = launcher.rows[index];
  if (!row) return;
  const box = $("prompt");
  const value = String(box.value || "");
  const caret = typeof box.selectionStart === "number" ? box.selectionStart : value.length;
  /* A trailing space only when the command takes an argument — the caret then
     sits where the argument goes. */
  const inserted = "/" + row.name + (row.hint ? " " : "");
  box.value = inserted + value.slice(Math.max(0, caret));
  launcher = null;
  renderLauncher();
  box.focus();
  if (typeof box.setSelectionRange === "function") box.setSelectionRange(inserted.length, inserted.length);
  growPrompt();
  announce("Inserted " + inserted.trim() + ". Nothing has been sent.");
  renderComposerNow();
}

/** One visually hidden polite region for plan, effort and launcher outcomes. */
function announce(text) {
  const region = $("liveRegion");
  if (region) region.textContent = String(text == null ? "" : text);
}

/* ── WP12: THE GATE (settings.updated) ────────────────────────────────────
   The latest gate state the agent has reported. allowAccess === true clears
   it; a NON-EMPTY gateMessage sets it; allow_access === false with no
   gate_message leaves it alone — upstream's own semantics, mirrored. The
   banner is the only consequence (the director's call): the composer stays enabled,
   because the agent does not itself refuse prompts mid-session, and blocking
   would be our claim, not the wire's. */
let gateNotice = null;  /* { message, url, label, tier, armed } | null */

/* The resolved gate state, from the server (bridge.gate_state live, or the
   snapshot's `gate`). null/undefined means the server holds NO gate — and
   that must CLEAR a stale banner (Opus NEW-2: the snapshot can set and it
   can clear; a server restart or a dropped clear event must not leave
   "Your subscription has run out." on screen against a server holding
   nothing). */
function applyResolvedGate(g) {
  /* EVERY application bumps the revision — live bridge.gate_state AND the
     snapshot paths (Opus M2 / Grok R2, round 5): a reconnect's channel_open
     applies the snapshot gate, and an older in-flight /state body must not
     be allowed to paint over that later application. The bump lives here so
     no caller can forget it. */
  gateRevision++;
  if (g === null || g === undefined) { gateNotice = null; return; }
  applyGateNotice(g);
}

/* Bumped on every LIVE bridge.gate_state application. The snapshot path
   captures it before its /state await and skips the gate application when a
   live change landed meanwhile — a state body built BEFORE the change must
   not re-apply the older gate (Grok R1 / Opus M3). The rest of the snapshot
   (markers) is generation-keyed and unaffected by the race. */
let gateRevision = 0;

function applyGateNotice(d) {
  if (d.allowAccess === true) { gateNotice = null; return; }
  if (typeof d.gateMessage === "string" && d.gateMessage !== "") {
    /* Bounds, and they are SAID (Opus M2 / Grok R3): a truncated message,
       label or tier is ellipsised AND the banner carries a truncated clause —
       a lone "…" at 400 characters is exactly where the actionable part would
       be cut. Array.from keeps the cut on a code-point boundary. A
       whitespace-only label counts as absent. The scheme check is
       case-insensitive (HTTPS:// is legitimate); a URL that fails it is
       REFUSED OUT LOUD (linkRefused), never dropped in silence. */
    const chars = Array.from(d.gateMessage);
    const truncatedMsg = chars.length > 400;
    const message = truncatedMsg ? chars.slice(0, 400).join("") + "…" : d.gateMessage;
    const rawLabel = typeof d.gateLabel === "string" && d.gateLabel.trim() !== "" ? d.gateLabel : null;
    const labelChars = rawLabel ? Array.from(rawLabel) : [];
    const truncatedLabel = labelChars.length > 60;
    const label = rawLabel ? (truncatedLabel ? labelChars.slice(0, 60).join("") + "…" : rawLabel) : null;
    const tierChars = typeof d.subscriptionTierDisplay === "string" ? Array.from(d.subscriptionTierDisplay) : [];
    const truncatedTier = tierChars.length > 60;
    const tier = truncatedTier ? tierChars.slice(0, 60).join("") + "…"
      : tierChars.length > 0 ? d.subscriptionTierDisplay : null;
    const rawUrl = typeof d.gateUrl === "string" && d.gateUrl !== "" ? d.gateUrl : null;
    const urlOk = rawUrl !== null && /^https?:\/\//i.test(rawUrl);
    /* An identical re-application (the snapshot sweep runs on every
       refreshState, and refreshState fires on turn boundaries) keeps the
       ARMED confirmation — a background refresh must not snap the URL away
       mid-confirm (Opus M1, round 2). Any real change re-arms to closed. */
    const same = gateNotice !== null &&
      gateNotice.message === message && gateNotice.url === (urlOk ? rawUrl : null) &&
      gateNotice.label === label && gateNotice.tier === tier;
    gateNotice = {
      message,
      url: urlOk ? rawUrl : null,
      linkRefused: rawUrl !== null && !urlOk,
      label,
      tier,
      truncated: truncatedMsg || truncatedLabel || truncatedTier,
      armed: same ? gateNotice.armed : false,
    };
  }
  /* anything else — including allowAccess false with no message — leaves the
     current state untouched. */
}

function renderGate() {
  const g = $("gateBanner");
  if (!g) return;
  g.textContent = "";
  if (!gateNotice) { g.dataset.show = "false"; return; }
  g.dataset.show = "true";
  /* Remote-server content: textContent only, everywhere (D31). A refused
     link is SAID (Opus M1) — never a message pointing at a link that is not
     there. */
  g.appendChild(el("span", "grow",
    gateNotice.message + (gateNotice.tier ? " (plan: " + gateNotice.tier + ")" : "") +
    (gateNotice.truncated ? " (truncated — the full text was longer)" : "") +
    (gateNotice.linkRefused ? " The message included a link this app would not open (it was not http/https)." : "")));
  if (gateNotice.url) {
    if (!gateNotice.armed) {
      const b = el("button", "btn btn-sm", gateNotice.label || "Open the link");
      b.title = "This link came from the agent's server. One more click shows it before anything opens.";
      b.onclick = () => { gateNotice.armed = true; renderGate(); };
      g.appendChild(b);
    } else {
      /* The confirmation step: the FULL URL, as text, then the choice. Never
         truncated — the confirm exists so the operator can check the
         destination, and a userinfo-field trick pushes the real host past
         any cut (Opus final I1). The banner wraps it (CSS overflow-wrap). */
      g.appendChild(el("span", "t-mono-sm dim", gateNotice.url));
      const back = el("button", "btn btn-sm", "Not now");
      back.dataset.variant = "ghost";
      back.onclick = () => { gateNotice.armed = false; renderGate(); };
      const go = el("button", "btn btn-sm", "Open it");
      go.onclick = () => { try { window.open(gateNotice.url, "_blank", "noopener"); } catch {} };
      g.appendChild(back);
      g.appendChild(go);
    }
  }
}

/* ── THE RAIL ─────────────────────────────────────────────────────────
   Grouped by cwd, groups ordered by their most recent change, rows inside
   a group the same. No project entity is invented — reconciliation §D.
   ─────────────────────────────────────────────────────────────────── */

const ACTIVITY_TONE = {
  working: "--state-thinking", idle: "--state-idle", needs_input: "--state-permission",
  dormant: "--text-tertiary", completed: "--state-complete", dead: "--state-failed",
};

/* The roster's activity word, with the meaning the agent's own docs give it
   (RosterActivity in roster.rs). "dormant" especially must not read as
   "finished": a session live in ANOTHER process arrives from the on-disk
   summaries and reports dormant (source: merge_roster; OBSERVED on 1.0.0 —
   every row of the real roster read dormant while the director's own app held
   sessions live). The gloss says only what this window knows, never what
   another process is doing. */
const ACTIVITY_GLOSS = {
  working: "a turn is running",
  idle: "open, no turn running",
  needs_input: "waiting for you",
  dormant: "on disk, not open in this window",
  completed: "finished and resumable",
  dead: "the agent reports it dead",
};

function activityText(activity) {
  if (activity == null) return "not reported";
  const gloss = ACTIVITY_GLOSS[activity];
  return gloss ? activity + " — " + gloss : String(activity);
}

/* ── WP13 read-helpers ─────────────────────────────────────────────────────
   The archive list and per-session yolo state come from the server snapshot
   (/state) and the roster (/sessions/list). The honest truth of "is a session
   approve-everything" is the roster's own `yolo` flag, never our requested
   intent — a respawn drops the mode and the roster is re-read. */
function archivedSet() {
  return new Set(Array.isArray(agent.archivedIds) ? agent.archivedIds : []);
}
function rosterRow(sessionId) {
  return roster.find((r) => r && r.sessionId === sessionId) || null;
}
/** True only when the ROSTER confirms this session is approve-everything. */
function rosterYolo(sessionId) {
  const r = rosterRow(sessionId);
  return !!(r && r.yolo === true);
}
/** Any session on this connection currently approve-everything (roster truth). */
function anyHot() {
  return roster.some((r) => r && r.yolo === true);
}
/* A respawn drops the agent's permission mode (the server clears it too), so
   every cached yolo flag and the requested intent are pre-crash memory rather
   than truth. Unknown reads as OFF until sessions/list answers again: the
   indicator must never carry an approve-everything claim across a crash, when
   the machine has gone back to asking. */
function resetAutoApproveIndicator() {
  for (const r of roster) if (r) r.yolo = false;
  agent.permissionMode = null;
}

function renderRail() {
  const body = $("railBody");
  body.textContent = "";
  /* Fold-all is re-armed by the populated path below; any empty state leaves
     it off, because there is nothing to fold. */
  const foldAllBtn = $("foldAll");
  if (foldAllBtn) foldAllBtn.disabled = true;
  const held = new Map(agent.sessions.map((s) => [s.sessionId, s]));

  /* The roster is machine-wide. Sessions this app holds are merged in, so a
     session created here before the first sessions/list still appears. A held
     session carries its own title now (rename's local landing spot), so a
     just-renamed one shows its name before the next roster poll. */
  const rows = roster.slice();
  for (const s of agent.sessions) {
    if (!rows.some((r) => r.sessionId === s.sessionId)) {
      rows.push({ sessionId: s.sessionId, cwd: s.cwd, title: s.title || null, activity: null,
                  resident: true, isWorktree: false, modelId: s.modelId,
                  reasoningEffort: s.reasoningEffort, lastChangeUnixMs: s.createdAt });
    }
  }

  /* Archived sessions (WP13 §2) drop out of the main list — a local hidden-list,
     nothing deleted, nothing sent. They return through the "Archived (N)" reveal
     at the foot, where each still loads if selected. */
  const archived = archivedSet();
  const archivedRows = rows.filter((r) => archived.has(r.sessionId));
  const visibleRows = rows.filter((r) => !archived.has(r.sessionId));

  /* THE FILTER (acceptance walk, 2026-08-02). The roster is machine-wide and
     capped at 200, so after a week of real use it is a wall — the director's word was
     "cluttered", and the thing he could not do was find where he had just
     been. This filters what is DISPLAYED and nothing else: no session is
     hidden permanently, nothing is deleted, and clearing the box brings
     everything back. Matches title, folder path, and session id.

     The box lives outside the rebuilt list (index.html), so typing in it never
     destroys the node being typed into. */
  const filterInput = $("railFilter");
  const needle = String(filterInput && filterInput.value || "").trim().toLowerCase();
  const total = visibleRows.length;
  const shown = needle === ""
    ? visibleRows
    : visibleRows.filter((r) =>
        String(r.title || "").toLowerCase().includes(needle) ||
        String(r.cwd || "").toLowerCase().includes(needle) ||
        String(r.sessionId || "").toLowerCase().includes(needle));

  if (!visibleRows.length && !archivedRows.length) {
    /* Reconciliation §D.4: the spec's "No projects yet" first-open screen is
       wrong twice — it offers a concept that does not exist, and the roster
       is machine-wide so it is almost never true. This is the genuinely
       empty case and it gets its own sentence. */
    const p = el("div", "t-caption dimr");
    p.style.padding = "16px 12px";
    /* Only claim the machine is empty once a read has actually landed. Until
       then this is "we have not looked yet", which is a different sentence. */
    p.textContent = rosterRead
      ? "No sessions on this machine yet."
      : "Waiting for the roster…";
    body.appendChild(p);
    $("railFootNote").textContent = "";
    renderArchivedReveal(archivedRows);
    return;
  }

  if (!visibleRows.length && archivedRows.length) {
    /* Everything is archived — the list is not empty, it is put away. */
    const p = el("div", "t-caption dimr");
    p.style.padding = "16px 12px";
    p.textContent = "Every session is archived. Open “Archived” below to bring one back.";
    body.appendChild(p);
    $("railFootNote").textContent = archivedRows.length + " archived";
    renderArchivedReveal(archivedRows);
    return;
  }

  if (needle !== "" && !shown.length) {
    const p = el("div", "t-caption dimr");
    p.style.padding = "16px 12px";
    p.textContent = "No session matches “" + needle + "”. " + total + " on this machine.";
    body.appendChild(p);
    $("railFootNote").textContent = "0 of " + total + " shown";
    renderArchivedReveal(archivedRows);
    return;
  }

  const groups = new Map();
  for (const r of shown) {
    const k = r.cwd || "(no cwd)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const ordered = [...groups.entries()].map(([cwd, list]) => {
    list.sort((a, b) => (b.lastChangeUnixMs || 0) - (a.lastChangeUnixMs || 0));
    return { cwd, list, last: Math.max(...list.map((x) => x.lastChangeUnixMs || 0)) };
  }).sort((a, b) => b.last - a.last);

  for (const g of ordered) {
    const open = !collapsedGroups.has(g.cwd);
    const h = el("button", "group-head t-caption");
    h.title = g.cwd;
    h.appendChild(el("span", "group-caret", open ? "▾" : "▸"));
    h.appendChild(el("span", "group-name trunc", base(g.cwd)));
    h.appendChild(el("span", "group-count t-mono-sm",
      g.list.length + (g.list.length === 1 ? " session" : " sessions")));
    h.onclick = () => {
      if (open) collapsedGroups.add(g.cwd); else collapsedGroups.delete(g.cwd);
      renderRail();
    };
    body.appendChild(h);
    if (!open) continue;

    for (const r of g.list) appendSessionRow(body, r, held.has(r.sessionId), false);
  }

  const footArchived = archivedRows.length ? " · " + archivedRows.length + " archived" : "";
  /* The on-disk half of the roster is capped at the 200 most recent summaries
     (roster.rs: list_recent_summaries(200)) and RosterListResponse carries no
     truncation flag — at exactly 200 the wire cannot say whether older
     sessions exist. So at the cap the foot discloses the bound itself rather
     than claiming either "everything" or "truncated" (WP8 trap 4). */
  const footCap = visibleRows.length >= 200
    ? " · the agent lists at most its 200 most recent on-disk sessions"
    : "";
  $("railFootNote").textContent = needle === ""
    ? visibleRows.length + " sessions · " + ordered.length + " folders · " +
      agent.sessions.length + " open here" + footArchived + footCap
    : shown.length + " of " + total + " shown · " + ordered.length + " folders" + footCap;
  const foldBtn = $("foldAll");
  if (foldBtn) {
    /* Fold all / Unfold all (the director, WP8 rail gate): one control that tidies a
       machine-wide roster. It acts on the groups currently SHOWN — with a
       filter active, only the matching folders fold, which is what the
       operator is looking at. In-memory only: a reload restores the default
       all-open view. */
    const allFolded = ordered.length > 0 && ordered.every((g) => collapsedGroups.has(g.cwd));
    foldBtn.disabled = ordered.length === 0;
    foldBtn.textContent = allFolded ? "Unfold all" : "Fold all";
    foldBtn.title = allFolded
      ? "Open every folder's session list"
      : "Fold every folder's session list";
    foldBtn.onclick = () => {
      if (allFolded) collapsedGroups.clear();
      else for (const g of ordered) collapsedGroups.add(g.cwd);
      renderRail();
    };
  }
  renderArchivedReveal(archivedRows);
}

/* One session row: the select button, a hover ⋯ actions control, and — when the
   operator opens it — an inline action strip and/or an inline rename field. All
   session titles, folders and ids are hostile text and reach the DOM as text
   (el()/textContent, rule 1, D31). `inArchivePanel` rows offer only Restore. */
function appendSessionRow(body, r, isHeld, inArchivePanel) {
  /* Inline rename replaces the row's face while active. */
  if (renaming && renaming.sessionId === r.sessionId) {
    body.appendChild(renderRenameRow(r));
    return;
  }
  const wrap = el("div", "s-row-wrap");
  const b = el("button", "s-row");
  b.setAttribute("aria-current", r.sessionId === activeId ? "true" : "false");
  b.title = (r.title || "(untitled)") + "\n" + r.cwd + "\n" + r.sessionId +
    "\nactivity: " + activityText(r.activity) +
    (r.resident ? " · resident" : "") + (r.isWorktree ? " · worktree" : "") +
    (isHeld ? "\nheld open by this app" : "\non disk — opening it loads it");

  /* The activity marker (WP8, the director's rail gate 2026-08-08): it exists only
     when there is something to say. On a machine-wide roster almost every row
     is dormant, and an identical grey square on 169 of 172 rows communicated
     nothing while shouting over the rows that mattered — the director's words were
     "confusing and messy". Dormant and unreported rows carry no marker; the
     full activity line stays verbatim in the tooltip, and a marker appears
     the moment the roster reports a live state. Nothing is invented: the
     states that show are the roster's own words, in D45's colours. */
  if (r.activity != null && r.activity !== "dormant") {
    const dot = el("span", "dot");
    dot.style.background = "var(" + (ACTIVITY_TONE[r.activity] || "--text-tertiary") + ")";
    b.appendChild(dot);
  }
  b.appendChild(el("span", "s-row-initial t-mono-sm", base(r.cwd).slice(0, 1).toUpperCase()));

  /* An untitled session is not a broken one: the agent names a session from its
     first real turn (session_summary_generated), so anything newer has no name
     to show. "Not yet named" says which of those it is, quietly. */
  const nm = el("span", "s-row-name trunc t-body", r.title || "Not yet named");
  if (!r.title) nm.classList.add("dimr");
  b.appendChild(nm);

  /* Running-hot marker (WP13 §3 honesty rail): whenever the ROSTER confirms this
     session is approve-everything, say so on its row — the danger signal that
     auto-approve otherwise suppresses. Sourced from sessions/list.yolo, never
     from our requested intent. */
  /* Never the word "auto": `auto` is a permission mode of its own, one the wire
     gives no read-back for, and a chip carrying that name would read as a
     confirmed state we cannot confirm. This marker is the always-approve one. */
  if (rosterYolo(r.sessionId)) {
    const hot = el("span", "s-row-hot t-caption", "skips asks");
    hot.title = "Auto-approve is on — this session acts without asking. Applies to all sessions.";
    b.appendChild(hot);
  }

  /* Worktree distinction (WP8): shown only when the PROTOCOL says so. OBSERVED
     on 1.0.0 (2026-08-08): sessions genuinely created with `grok --worktree`
     arrive with isWorktree:false — the on-disk summary never persists
     session_kind, so merge_roster cannot set the flag. We render the wire's
     value and nothing else: no badge from a path guess, and no hidden truth
     when the flag is wrong — the limitation is on the record (PROJECT-STATE §3). */
  if (r.isWorktree) {
    const wt = el("span", "s-row-wt t-caption", "worktree");
    wt.title = "The agent reports this session runs in a git worktree.";
    b.appendChild(wt);
  }

  if (r.sessionId === activeId) {
    b.appendChild(el("span", "s-row-here t-caption", "here"));
  } else if (isHeld) {
    b.appendChild(el("span", "s-row-held t-caption", "open"));
  }
  b.appendChild(el("span", "s-row-meta t-mono-sm", ago(r.lastChangeUnixMs)));
  b.onclick = () => selectSession(r, isHeld);
  wrap.appendChild(b);

  if (inArchivePanel) {
    /* Archived rows carry one action: Restore. Everything else waits until the
       session is back in the list. */
    const restore = el("button", "s-row-actions", "Restore");
    restore.title = "Bring this session back into the list.";
    restore.onclick = (e) => { e.stopPropagation(); restoreSession(r.sessionId); };
    wrap.appendChild(restore);
    body.appendChild(wrap);
    return;
  }

  const menuBtn = el("button", "s-row-actions", "⋯");
  menuBtn.setAttribute("aria-label", "Session actions");
  menuBtn.title = "Rename, archive, export or delete this session";
  menuBtn.setAttribute("aria-expanded", rowMenu === r.sessionId ? "true" : "false");
  menuBtn.onclick = (e) => {
    e.stopPropagation();
    rowMenu = rowMenu === r.sessionId ? null : r.sessionId;
    renderRail();
  };
  wrap.appendChild(menuBtn);
  body.appendChild(wrap);

  if (rowMenu === r.sessionId) body.appendChild(renderRowActions(r, isHeld));
}

/* The inline action strip under a row (WP13). Rename / Archive / Export /
   Delete — every one names the session it acts on, and Delete is the only one
   that is destructive (it opens a confirm; it never deletes on this click). */
function renderRowActions(r, isHeld) {
  const strip = el("div", "s-actions");
  const add = (label, cls, title, fn) => {
    const btn = el("button", "s-action " + cls, label);
    if (title) btn.title = title;
    btn.onclick = (e) => { e.stopPropagation(); rowMenu = null; fn(); };
    strip.appendChild(btn);
  };
  add("Rename", "", "Give this session a name.", () => startRename(r));
  add("Archive", "", "Hide this from the list on this machine. Deletes nothing.", () => archiveSession(r.sessionId));
  add("Export", "", "Save this session to a portable file.", () => openExportModal(r));
  add("Delete session", "danger", "Delete this session permanently.", () => openDeleteModal(r));
  return strip;
}

/* The inline rename field: seeded with the current title, Enter commits, Esc
   cancels, blank refused client-side with a caption. The value is operator text
   but still reaches the DOM through the input's own value, never as markup. */
function renderRenameRow(r) {
  const wrap = el("div", "s-row-wrap s-rename");
  const inp = el("input", "input s-rename-input t-body");
  inp.type = "text";
  inp.value = renaming.draft;
  inp.setAttribute("aria-label", "Session title");
  inp.placeholder = "Session title";
  inp.oninput = () => { renaming.draft = inp.value; };
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRename(r); }
    else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
  };
  inp.onclick = (e) => e.stopPropagation();
  wrap.appendChild(inp);
  if (renaming.error) {
    const cap = el("div", "s-rename-cap t-caption", renaming.error);
    wrap.appendChild(cap);
  }
  /* Focus after the paint. requestAnimationFrame is stubbed to fire immediately
     in the test harness, so this is inert there and real in the browser. */
  requestAnimationFrame(() => { try { inp.focus(); } catch {} });
  return wrap;
}

/* The "Archived (N)" reveal + panel at the foot of the rail. Collapsed by
   default; each archived row offers Restore and still loads if selected. */
function renderArchivedReveal(archivedRows) {
  const host = $("railArchived");
  if (!host) return;
  host.textContent = "";
  if (!archivedRows.length) { showArchived = false; return; }
  const head = el("button", "archived-head t-caption");
  head.setAttribute("aria-expanded", showArchived ? "true" : "false");
  head.appendChild(el("span", "group-caret", showArchived ? "▾" : "▸"));
  head.appendChild(el("span", "grow", "Archived (" + archivedRows.length + ")"));
  head.onclick = () => { showArchived = !showArchived; renderRail(); };
  host.appendChild(head);
  if (!showArchived) return;
  const cap = el("div", "archived-cap t-caption dimr",
    "Hidden from this list on this machine. Nothing is deleted, nothing leaves this machine.");
  host.appendChild(cap);
  const panel = el("div", "archived-panel");
  archivedRows.sort((a, b) => (b.lastChangeUnixMs || 0) - (a.lastChangeUnixMs || 0));
  for (const r of archivedRows) appendSessionRow(panel, r, false, true);
  host.appendChild(panel);
}

/* ── WP13 row actions ──────────────────────────────────────────────────────
   Rename is reversible; archive/restore touch nothing in Grok; delete is
   permanent and always goes through the confirm modal. Every failure reuses the
   shipped "Not <verb> — {reason}. Try again." family (WP6 voice). */

function startRename(r) {
  renaming = { sessionId: r.sessionId, draft: r.title || "", error: null };
  renderRail();
}
function cancelRename() { renaming = null; renderRail(); }

async function commitRename(r) {
  if (!renaming || renaming.sessionId !== r.sessionId) return;
  const title = String(renaming.draft || "").trim();
  if (title === "") { renaming.error = "Title can't be blank."; renderRail(); return; }
  const sessionId = renaming.sessionId;
  renaming = null;
  renderRail();
  const res = await post("/session/rename", { sessionId, title }, { quiet: true });
  if (res && res.error) note("error", "Not sent — " + res.error + ". Try again.", res.details);
  await refreshRoster();
  await refreshState();
}

async function archiveSession(sessionId) {
  const res = await post("/session/archive", { sessionId }, { quiet: true });
  if (res && res.error) { note("error", "Not archived — " + res.error + ". Try again.", res.details); return; }
  if (activeId === sessionId) showArchived = false; /* it drops out of view; don't strand */
  await refreshState(); /* archivedIds live on /state */
}
async function restoreSession(sessionId) {
  const res = await post("/session/restore", { sessionId }, { quiet: true });
  if (res && res.error) { note("error", "Not restored — " + res.error + ". Try again.", res.details); return; }
  await refreshState();
}

/* ── WP13 auto-approve (D62) ────────────────────────────────────────────────
   ONE global switch. Its truth is the roster's own yolo flag (sessions/list),
   never our requested intent — a respawn drops the mode and the roster is
   re-read. Turning ON is dangerous (it suppresses the permission cards that are
   the operator's danger signal for EVERY session), so it confirms first; turning
   OFF is the safe direction and is immediate. */

function renderAutoApprove() {
  const pill = $("autoApprove");
  const banner = $("autoApproveBanner");
  const on = anyHot();
  const requested = agent.permissionMode === "always-approve";
  if (pill) {
    pill.textContent = "";
    /* The scope belongs on the face of the control, not only in its title and
       banner: D62 accepted one global switch on the condition that the switch
       itself says it is global. At ≤700px the face shortens to "Auto-approve ·
       all" (the director's WP9 narrowing, the D68 precedent): the scope word "all"
       stays on the control, the full sentence stays in this tooltip, and
       whenever it is ON the banner below says "for every session in this
       window" in full. CSS swaps the two spans; both are always in the DOM. */
    pill.appendChild(el("span", "aa-key aa-key-wide", "Auto-approve — all sessions"));
    pill.appendChild(el("span", "aa-key aa-key-narrow", "Auto-approve · all"));
    pill.appendChild(el("span", "aa-state", on ? "ON" : "OFF"));
    pill.dataset.on = on ? "true" : "false";
    pill.setAttribute("aria-pressed", on ? "true" : "false");
    pill.title =
      "Auto-approve applies to ALL sessions in this window — global, not per-session. " +
      "While on, the agent acts without asking first. " +
      (on ? "It is ON now." : "It is off; sessions ask before acting, as usual.");
    pill.hidden = false;
  }
  if (banner) {
    const show = on || requested;
    banner.dataset.show = show ? "true" : "false";
    banner.textContent = "";
    if (show) {
      banner.appendChild(el("span", "grow t-body", on
        ? "Auto-approve is ON for every session in this window — the agent acts without asking first, on all sessions."
        : "Auto-approve was requested for all sessions, but no open session confirms it yet."));
      const off = el("button", "btn btn-sm", "Turn off");
      off.onclick = () => setAutoApprove("ask");
      banner.appendChild(off);
    }
  }
}

function toggleAutoApprove() {
  if (agent.state === "gone" || agent.state === "failed") {
    note("error", "Auto-approve not changed — the agent process is gone.");
    return;
  }
  if (anyHot() || agent.permissionMode === "always-approve") {
    setAutoApprove("ask"); /* off — safe direction, immediate */
  } else {
    modal = { kind: "autoApprove" }; /* on — confirm first */
    renderModal();
  }
}

async function setAutoApprove(mode) {
  if (modal && modal.kind === "autoApprove") closeModal();
  const res = await post("/session/permission-mode", { mode }, { quiet: true });
  if (res && res.error) { note("error", "Auto-approve not changed — " + res.error + ". Try again.", res.details); }
  else if (res && mode === "always-approve" && res.verifiable && !res.matched) {
    note("info", "Auto-approve was sent but no open session confirmed it yet — it applies to the next session that runs.");
  }
  await refreshRoster();
  await refreshState();
}

/* ── WP13 modals (delete / export / import / auto-approve confirm) ──────────
   One host, mirroring the folder picker. Escape and the backdrop close it —
   closing is always safe (it does nothing). The destructive delete button is
   never the default focus and Enter never triggers it. */

function closeModal() {
  /* Focus restore (WP14), closeCtxPop's pattern: focus inside a closing
     surface returns to the element that opened it. */
  const host = $("modalHost");
  const focusInside = host && document.activeElement && typeof host.contains === "function" &&
    host.contains(document.activeElement);
  const returnTo = modalReturnFocus;
  modal = null;
  modalReturnFocus = null;
  renderModal();
  if (focusInside && returnTo && typeof returnTo.focus === "function") {
    try { returnTo.focus(); } catch { /* focus is a nicety, not a requirement */ }
  }
}

/* The element that opened the current modal — closeModal hands focus back to
   it (WP14). */
let modalReturnFocus = null;

function renderModal() {
  const host = $("modalHost");
  if (!host) return;
  host.textContent = "";
  if (!modal) { host.hidden = true; return; }
  host.hidden = false;
  /* Focus restore on close (WP14), closeCtxPop's pattern: remember who opened
     the dialog so closeModal can hand focus back. Set once per opening —
     renderModal re-runs on every renderAll while the modal is up. */
  if (!modalReturnFocus) modalReturnFocus = document.activeElement || null;
  const backdrop = el("div", "modal-backdrop");
  backdrop.onclick = () => closeModal();
  host.appendChild(backdrop);
  const dialog = el("div", "modal");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  /* The accessible name is the title div each modal renderer stamps with
     id="modalTitle" (WP14 — a role="dialog" with no name announced nothing). */
  dialog.setAttribute("aria-labelledby", "modalTitle");
  dialog.onclick = (e) => e.stopPropagation();
  /* The folder picker's trap, copied (WP14): Tab stays inside the dialog. */
  dialog.onkeydown = (e) => {
    if (e.key !== "Tab" || typeof dialog.querySelectorAll !== "function") return;
    const focusables = Array.from(dialog.querySelectorAll("button, input")).filter((n) => !n.disabled);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
    else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
  };
  host.appendChild(dialog);
  if (modal.kind === "delete") renderDeleteModal(dialog);
  else if (modal.kind === "export") renderExportModal(dialog);
  else if (modal.kind === "import") renderImportModal(dialog);
  else if (modal.kind === "autoApprove") renderAutoApproveConfirm(dialog);
  else if (modal.kind === "retentionOptIn") renderRetentionOptInConfirm(dialog);
}

/* A row → the immutable facts the confirm modal must show. Everything here is
   agent-forgeable EXCEPT the id, cwd and times — which is exactly why the modal
   leans on those, not the title (WP13_RISK_REVIEW hostile-title misdirection). */
function sessionFacts(sessionId) {
  /* Roster rows and held rows carry DIFFERENT time facts — the roster reports
     last change and no birth time at all; only a session this app holds knows
     when and how it was acquired. Read both, rather than whichever answered
     first, and keep `acquired` so the modal can label the time honestly. */
  const r = rosterRow(sessionId) || {};
  const h = (agent.sessions || []).find((s) => s && s.sessionId === sessionId) || {};
  return {
    sessionId,
    cwd: r.cwd || h.cwd || "(unknown folder)",
    title: r.title || h.title || null,
    acquired: h.acquired || null,
    created: h.createdAt || null,
    lastActive: r.lastChangeUnixMs || null,
  };
}

function openDeleteModal(r) { modal = { kind: "delete", sessionId: r.sessionId }; renderModal(); }

function renderDeleteModal(dialog) {
  const f = sessionFacts(modal.sessionId);
  const title = el("div", "modal-title t-title", "Delete this session permanently?");
  title.id = "modalTitle"; /* the dialog's accessible name (aria-labelledby) */
  dialog.appendChild(title);
  dialog.appendChild(el("div", "modal-body t-body",
    "This deletes the session from this machine and, if your account syncs to xAI, from xAI's " +
    "servers. There is no undo. To hide it without deleting it, choose Archive instead."));
  /* The immutable identity the agent cannot forge — NOT the title. */
  const id = el("div", "modal-facts t-mono-sm");
  if (f.title) id.appendChild(el("div", "mf-row", "Title (agent-set, can be misleading): " + f.title));
  id.appendChild(el("div", "mf-row", "Folder: " + f.cwd));
  id.appendChild(el("div", "mf-row", "Session id: " + f.sessionId));
  /* Both time rows always print, "not reported" included: an absent row reads as
     "this session has no such time", which is a different and wrong claim. */
  id.appendChild(el("div", "mf-row", "Last active: " +
    (f.lastActive ? new Date(f.lastActive).toLocaleString() : "not reported")));
  /* Two facts that are easy to conflate and must not be: a held row's createdAt
     is when THIS app acquired the session, so it is a birth time only when this
     app created it. For a session opened from disk it is when it was opened
     here — never labelled Created. */
  if (f.created && f.acquired === "new") {
    id.appendChild(el("div", "mf-row", "Created: " + new Date(f.created).toLocaleString()));
  } else if (f.created && f.acquired === "load") {
    id.appendChild(el("div", "mf-row", "Opened here: " + new Date(f.created).toLocaleString()));
  } else {
    id.appendChild(el("div", "mf-row", "Created: not reported"));
  }
  dialog.appendChild(id);
  const foot = el("div", "modal-foot");
  const del = el("button", "btn", "Delete permanently");
  del.dataset.variant = "danger";
  del.onclick = () => confirmDelete(f.sessionId);
  const arch = el("button", "btn", "Archive instead");
  arch.dataset.variant = "ghost";
  arch.onclick = () => { closeModal(); archiveSession(f.sessionId); };
  const cancel = el("button", "btn", "Cancel");
  cancel.dataset.variant = "ghost";
  cancel.onclick = () => closeModal();
  /* Cancel first in the DOM and given focus: the destructive button is never the
     default, and Enter (which would fire a focused button) lands on Cancel. */
  foot.appendChild(cancel);
  foot.appendChild(arch);
  foot.appendChild(del);
  dialog.appendChild(foot);
  requestAnimationFrame(() => { try { cancel.focus(); } catch {} });
}

async function confirmDelete(sessionId) {
  closeModal();
  const res = await post("/session/delete", { sessionId }, { quiet: true });
  if (!res || res.error) { note("error", "Not deleted — " + ((res && res.error) || "no response") + ". The session is intact. Try again.", res && res.details); return; }
  if (res.deleted && res.goneFromRoster) {
    note("info", "Deleted — the session is gone.");
  } else if (res.intact) {
    note("error", "Not deleted — the session is INTACT. " + (res.note || "The delete failed; nothing was removed."), res.details);
  } else {
    note("error", "Not deleted — the session is still here. " + (res.note || ""), res.details);
  }
  await refreshRoster();
  await refreshState();
}

function openExportModal(r) { modal = { kind: "export", sessionId: r.sessionId }; renderModal(); }

function renderExportModal(dialog) {
  const title = el("div", "modal-title t-title", "Export this session");
  title.id = "modalTitle"; /* the dialog's accessible name (aria-labelledby) */
  dialog.appendChild(title);
  const a = el("button", "btn export-opt", "Export session bundle");
  a.onclick = () => runExport(modal.sessionId, "bundle");
  dialog.appendChild(a);
  dialog.appendChild(el("div", "modal-cap t-caption dimr",
    "Round-trips — import this file to bring the session back, here or on another machine. Not human-readable."));
  const b = el("button", "btn export-opt", "Export as Markdown");
  b.dataset.variant = "ghost";
  b.onclick = () => runExport(modal.sessionId, "markdown");
  dialog.appendChild(b);
  dialog.appendChild(el("div", "modal-cap t-caption dimr",
    "Readable anywhere. One-way — this file can't be imported back."));
  const foot = el("div", "modal-foot");
  const cancel = el("button", "btn", "Cancel");
  cancel.dataset.variant = "ghost";
  cancel.onclick = () => closeModal();
  foot.appendChild(cancel);
  dialog.appendChild(foot);
}

async function runExport(sessionId, format) {
  const res = await post("/session/export", { sessionId, format }, { quiet: true });
  if (!res || res.error || typeof res.content !== "string") {
    note("error", "Not exported — " + ((res && res.error) || "no file was produced") + ". Try again.", res && res.details);
    return;
  }
  downloadFile(res.filename || ("graphometer-session." + (format === "markdown" ? "md" : "json")),
    res.content, format === "markdown" ? "text/markdown" : "application/json");
  closeModal();
  /* A truncated transcript never reaches here as a BUNDLE — the server refuses
     that outright, and the refusal lands in the failure branch above. Markdown
     does save, and the note says what was saved: a partial reading copy, in the
     warning voice, not the quiet "Exported — saved" of a whole one. */
  if (res.hasMore) {
    note("error", "Saved INCOMPLETE — the agent returned only part of this session's transcript, so " +
      (res.filename || "the file") + " is missing turns. It is a partial reading copy, marked at the top of the file.");
  } else {
    note("info", "Exported — saved " + (res.filename || "the file") + ".");
  }
}

/* Trigger a browser download of text content. A Blob + object URL + a
   programmatic <a download> click; downloads are not governed by the CSP fetch
   directives the way a navigation would be. The URL is revoked after the click. */
function downloadFile(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = el("a", "hidden-dl");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 5000);
  } catch (e) {
    note("error", "Could not save the file in this browser — " + e.message);
  }
}

function openImportModal() {
  if (agent.state === "starting") { note("error", "Not imported yet — still connecting. Try again in a moment."); return; }
  modal = { kind: "import" };
  renderModal();
}

function renderImportModal(dialog) {
  const title = el("div", "modal-title t-title", "Import a session");
  title.id = "modalTitle"; /* the dialog's accessible name (aria-labelledby) */
  dialog.appendChild(title);
  dialog.appendChild(el("div", "modal-body t-body",
    "Choose a Grok session bundle (.json) exported from Graphometer or Grok Build. A Markdown " +
    "export can't be imported. A session that already exists here is left unchanged — nothing is overwritten."));
  const pick = el("button", "btn", "Choose a bundle file…");
  pick.onclick = () => { const inp = $("importFile"); if (inp) inp.click(); };
  dialog.appendChild(pick);
  const foot = el("div", "modal-foot");
  const cancel = el("button", "btn", "Cancel");
  cancel.dataset.variant = "ghost";
  cancel.onclick = () => closeModal();
  foot.appendChild(cancel);
  dialog.appendChild(foot);
}

async function onImportFileChosen(file) {
  closeModal();
  if (!file) return;
  let text;
  try { text = await file.text(); } catch (e) { note("error", "Not imported — could not read that file."); return; }
  let bundle;
  try { bundle = JSON.parse(text); } catch { note("error", "Not imported — that file isn't valid JSON. A Markdown export can't be imported."); return; }
  const res = await post("/session/import", { bundle }, { quiet: true });
  if (!res || res.error) {
    /* The server's own message names what's missing (foreign shape, no summary,
       non-UUID). Reuse it verbatim under the shipped failure family. */
    note("error", "Not imported — " + ((res && res.error) || "no response") + ".", res && res.details);
  } else if (res.imported && res.present) {
    note("info", "Imported — the session is back in the list.");
  } else if (res.alreadyExisted) {
    note("info", "Not imported — a session with this id already exists on this machine. It was left unchanged; nothing was overwritten.");
  } else {
    note("error", "Not imported — " + (res.note || "nothing was reconstructed."), res.details);
  }
  await refreshRoster();
  await refreshState();
}

function renderAutoApproveConfirm(dialog) {
  const title = el("div", "modal-title t-title", "Turn on auto-approve for every session?");
  title.id = "modalTitle"; /* the dialog's accessible name (aria-labelledby) */
  dialog.appendChild(title);
  dialog.appendChild(el("div", "modal-body t-body",
    "Global, not per-session — this covers every session open in this window, including ones " +
    "pointed at other folders. While on, the agent acts without asking first: the permission " +
    "cards that warn you before a file change or a command stop appearing, on all sessions."));
  const foot = el("div", "modal-foot");
  const cancel = el("button", "btn", "Cancel");
  cancel.dataset.variant = "ghost";
  cancel.onclick = () => closeModal();
  const on = el("button", "btn", "Turn on — all sessions");
  on.dataset.variant = "danger";
  on.onclick = () => setAutoApprove("always-approve");
  foot.appendChild(cancel);
  foot.appendChild(on);
  dialog.appendChild(foot);
  requestAnimationFrame(() => { try { cancel.focus(); } catch {} });
}

/* WP15 / D87: opt-IN is privacy-degrading — explicit confirm naming the
   consequence. Mirrors upstream's toast asymmetry. Modal meets the WP14 a11y
   bar (accessible name, focus trap, focus restore). */
function renderRetentionOptInConfirm(dialog) {
  const title = el("div", "modal-title t-title", "Share coding data to improve the product?");
  title.id = "modalTitle";
  dialog.appendChild(title);
  dialog.appendChild(el("div", "modal-body t-body",
    "This opts IN to coding-data retention. Usage and code data may be used to improve the " +
    "product — including training. The agent will send a request to xAI and rewrite the local " +
    "auth file. You can opt out again at any time from this panel or with /privacy opt-out."));
  const foot = el("div", "modal-foot");
  const cancel = el("button", "btn", "Cancel");
  cancel.dataset.variant = "ghost";
  cancel.onclick = () => closeModal();
  const go = el("button", "btn", "Opt in — share coding data");
  go.dataset.variant = "danger";
  go.onclick = () => {
    closeModal();
    void setRetention(false); /* codingDataRetentionOptOut: false = opted in */
  };
  foot.appendChild(cancel);
  foot.appendChild(go);
  dialog.appendChild(foot);
  requestAnimationFrame(() => { try { cancel.focus(); } catch {} });
}

/* Selecting a session this app already holds is local navigation and costs
   nothing. Selecting one off disk is session/load, which re-streams the
   whole conversation — so it is never done implicitly. */
function selectSession(row, isHeld) {
  if (isHeld) { setActiveSession(row.sessionId); renderAll(); refreshChangesOnSelect(row.sessionId); return; }
  const prev = activeId;
  setActiveSession(row.sessionId);
  renderAll();
  refreshChangesOnSelect(row.sessionId);
  note("info", "Opening this session — the agent replays the whole conversation, and every replayed event is tagged as history.");
  post("/session/load", { sessionId: row.sessionId, cwd: row.cwd }).then((r) => {
    /* The server can now REFUSE a load (an excluded cwd, D50). A tab must not
       sit selected on a session the server rejected — put the selection back,
       unless the operator has already moved somewhere else. */
    if (r && r.error && prev && activeId === row.sessionId) {
      setActiveSession(prev);
      renderAll();
    }
  });
}

/* WP11 (M3): switching sessions while the drawer sits open on Detail is none
   of the three refresh moments, so without this the pane showed "Not read
   yet" until the drawer was toggled. One read on select, same discipline. */
function refreshChangesOnSelect(sessionId) {
  if ($("app").dataset.drawer === "open" && drawerTab === "detail") refreshChanges(sessionId);
}

/* ── THE FOLDER PICKER (WP5.5 / D47 · WP5.6 / D49–D51) ────────────────────
   New Session opens an in-app, directories-only browser — never a native dialog
   and never a path textbox. Navigation and selection are two different gestures
   on two different targets (D49): clicking a folder row SELECTS it — the row
   highlights and the Start button names that exact folder — while the row's ▸
   button LOOKS INSIDE it. Starting goes through the existing `session/new`, and
   the result is VERIFIED against /state before this tab selects it — the API
   returns success for calls that did nothing, so a wrong cwd would otherwise
   start work in the wrong place silently (a cwd mismatch is never selected).
   Other tabs never navigate on the creation broadcast. */

function pickerStartPath() {
  /* D51: the picker always opens at the workspace root the server names. Never
     the active session's cwd — "new session" means new work, and opening in the
     old session's folder stranded the first user twice; that folder is offered
     as a Places chip instead. */
  if (typeof agent.browseRoot === "string" && agent.browseRoot) return agent.browseRoot;
  return ""; // no root named: the server maps an empty path to home
}

/* The rows the list is currently showing, after the filter. One definition, so
   the keyboard and the rendered list can never disagree. */
function pickerShownEntries() {
  const f = picker.filter.trim().toLowerCase();
  return picker.entries.filter((e) => !f || String(e.name).toLowerCase().includes(f));
}

/* A chip label needs its parent only when two Places share a basename. */
function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}

function openPicker() {
  const gone = agent.state === "gone" || agent.state === "failed";
  if (!TOKEN_OK || gone) {
    note("error", "Not started — " + (!TOKEN_OK ? "no run token" : "the agent process is gone") + ".");
    return;
  }
  /* Before the first /state lands there is no workspace root, no Places, and
     no excluded-chip filter — a picker opened now would silently break the
     D51 promise. Say so instead. */
  if (agent.state === "starting") {
    note("error", "Not started yet — still connecting to the agent. Try again in a moment.");
    return;
  }
  picker = { path: null, parent: null, entries: [], error: null, code: null, filter: "", selected: null, loading: true, creating: false };
  renderPicker();
  pickerFetch(pickerStartPath(), true);
}

function closePicker() { picker = null; renderPicker(); }

async function pickerFetch(path, isInitial) {
  if (!picker) return;
  picker.loading = true;
  picker.creating = false;
  renderPicker();
  const r = await post("/fs/list", { path });
  if (!picker) return; // closed while the request was in flight
  if (!r || typeof r.path !== "string") {
    picker.error = (r && r.error) || "Could not reach the folder service.";
    picker.code = "TRANSPORT";
    picker.entries = [];
    picker.filter = "";
  } else {
    picker.path = r.path;
    picker.parent = typeof r.parent === "string" ? r.parent : null;
    picker.entries = Array.isArray(r.entries) ? r.entries : [];
    picker.error = typeof r.error === "string" ? r.error : null;
    picker.code = typeof r.code === "string" ? r.code : null;
    picker.filter = "";
  }
  /* Every navigation shows a new listing, so the old selection no longer points
     at a visible row: clear it. Choosing is always explicit (D49). */
  picker.selected = null;
  picker.loading = false;
  /* Don't strand the operator on a gone/unreadable workspace root (a stale
     config, an unplugged drive): fall back once to home via an empty path —
     never in a loop. The start path is always the root (D51), so home is the
     only remaining fallback. */
  if (isInitial && picker.error && path !== "") {
    note("info", "That folder isn't available — opening your home folder instead.");
    return pickerFetch("", false);
  }
  renderPicker();
}

function fillPickerList(list) {
  list.textContent = "";
  if (picker.loading) { list.appendChild(el("div", "picker-note t-body", "Reading…")); return; }
  if (picker.parent) {
    const up = el("div", "picker-row");
    const upBtn = el("button", "pr-select");
    upBtn.appendChild(el("span", "pr-icon", "↰"));
    upBtn.appendChild(el("span", "pr-name t-body", ".. parent folder"));
    upBtn.title = picker.parent;
    upBtn.onclick = () => pickerFetch(picker.parent);
    up.appendChild(upBtn);
    list.appendChild(up);
  }
  /* A failed listing keeps the parent row (the way back up) but nothing else —
     the sentence itself lives in the footer, beside the Start button it
     disables, with the Back-to-root action next to it. */
  if (picker.error) return;
  const shown = pickerShownEntries();
  if (!shown.length) {
    list.appendChild(el("div", "picker-note t-body",
      picker.entries.length
        ? "No folders match the filter."
        : "No sub-folders inside this folder."));
  }
  for (const e of shown) {
    /* Click the name to CHOOSE the folder; double-click it (or press ▸) to LOOK
       INSIDE — the same convention every file dialog uses, so the tiny ▸ is a
       shortcut, never the only way in (D49). Single-click updates the highlight
       and the Start button in place (no rebuild), so the second click of a
       double lands on the same element and opens instead of re-selecting. */
    const row = el("div", "picker-row");
    if (picker.selected === e.path) row.dataset.selected = "true";
    const pick = el("button", "pr-select");
    /* The folder name, as text. A directory named `<img onerror=…>` is that many
       printable characters and nothing else. Rule 1, D31. */
    pick.appendChild(el("span", "pr-name t-body", e.name));
    pick.title = e.path;
    pick.onclick = () => selectPickerFolder(e.path);
    pick.ondblclick = () => pickerFetch(e.path);
    row.appendChild(pick);
    const open = el("button", "pr-nav", "▸");
    open.title = "Look inside " + e.name;
    open.ariaLabel = "Look inside " + e.name;
    open.onclick = () => pickerFetch(e.path);
    row.appendChild(open);
    list.appendChild(row);
  }
}

/* The Start button always names the folder it will use — self-checking at the
   moment of commitment (D49). One definition so the initial render and the
   in-place update after a click can never disagree. */
function pickerStartLabel() {
  return picker.creating ? "Starting…"
    : picker.selected ? "Start session in " + base(picker.selected)
    : "Pick a folder above";
}

/* Choose a folder WITHOUT rebuilding the panel: move the highlight and refresh
   the Start button in place. Rebuilding on every click would replace the row
   the pointer is still on, so a double-click's second half would miss. */
function selectPickerFolder(path) {
  if (!picker) return;
  picker.selected = path;
  const list = $("pickerList");
  if (list) {
    for (const row of Array.from(list.children)) {
      const btn = row.children && row.children[0];
      if (row.dataset) row.dataset.selected = btn && btn.title === path ? "true" : "";
    }
  }
  const start = $("pickerStart");
  if (start) { start.textContent = pickerStartLabel(); start.disabled = picker.creating || !picker.selected; }
  const tgt = $("pickerTarget");
  if (tgt) { tgt.textContent = picker.selected || "—"; if (picker.selected) tgt.title = picker.selected; }
}

function renderPicker() {
  const host = $("pickerHost");
  host.textContent = "";
  if (!picker) { host.hidden = true; return; }
  host.hidden = false;

  const backdrop = el("div", "picker-backdrop");
  backdrop.onclick = (e) => { if (e.target === backdrop) closePicker(); };
  const panel = el("div", "picker");
  backdrop.appendChild(panel);

  const head = el("div", "picker-head");
  head.appendChild(el("div", "picker-title t-title", "Start a new session"));
  const x = el("button", "picker-x", "×");
  x.title = "Cancel (Esc)";
  x.onclick = closePicker;
  head.appendChild(x);
  panel.appendChild(head);

  /* Breadcrumbs from the absolute path. Each ancestor is a button; the current
     folder is plain text. Segments are rendered with textContent. */
  const loc = el("div", "picker-loc");
  const path = picker.path || "";
  if (path) {
    const rootBtn = el("button", "crumb", "/");
    rootBtn.title = "/";
    rootBtn.onclick = () => pickerFetch("/");
    loc.appendChild(rootBtn);
    const parts = path.split("/").filter((s) => s !== "");
    let acc = "";
    parts.forEach((seg, i) => {
      acc += "/" + seg;
      const full = acc;
      if (i < parts.length - 1) {
        const b = el("button", "crumb", seg);
        b.title = full;
        b.onclick = () => pickerFetch(full);
        loc.appendChild(b);
        loc.appendChild(el("span", "crumb-sep", "/"));
      } else {
        loc.appendChild(el("span", "crumb-cur", seg));
      }
    });
  } else {
    loc.appendChild(el("span", "crumb-cur", picker.loading ? "loading…" : "—"));
  }
  panel.appendChild(loc);

  /* Places — the pinned workspace root plus recent working directories, ABOVE
     the list so the one-step way back (D49) exists before anything else. The
     root chip comes from the server at runtime, never a hardcoded path, and is
     present even on a fresh machine with an empty roster. */
  const rootPath = typeof agent.browseRoot === "string" && agent.browseRoot ? agent.browseRoot : null;
  const chips = rootPath ? [rootPath] : [];
  const seen = new Set(chips);
  /* Do not ADVERTISE folders the server will refuse (display filter only — the
     enforcement is the server's shared gate, and a stale chip still just gets
     an honest refusal + Back-to-root). */
  const excluded = Array.isArray(agent.excludedDirs) ? agent.excludedDirs : [];
  const isExcludedCwd = (c) => excluded.some((x) => c === x || c.startsWith(x + "/"));
  for (const s of [...roster, ...agent.sessions]) {
    if (s && typeof s.cwd === "string" && s.cwd && !seen.has(s.cwd) && !isExcludedCwd(s.cwd)) { seen.add(s.cwd); chips.push(s.cwd); }
  }
  if (chips.length) {
    const places = el("div", "picker-quick");
    places.appendChild(el("div", "picker-quick-label t-caption", "Jump to Home, or a recent folder"));
    const prow = el("div", "picker-quick-row");
    const visible = chips.slice(0, 8);
    const counts = {};
    for (const c of visible) { const l = base(c); counts[l] = (counts[l] || 0) + 1; }
    for (const c of visible) {
      const b = el("button", "btn btn-sm");
      if (c === rootPath) {
        /* The one-tap way back. A house is recognised instantly where a folder
           basename ("vault") is not — the director looked for a Home chip and did not
           see one. The real path stays in the tooltip. */
        b.dataset.pinned = "true";
        b.appendChild(el("span", "", "⌂ Home"));
      } else {
        const lbl = base(c);
        /* Two chips named "work" from different parents must stay tellable apart. */
        b.appendChild(el("span", "", counts[lbl] > 1 ? lbl + " — " + parentOf(c) : lbl));
      }
      b.title = c;
      b.onclick = () => pickerFetch(c);
      prow.appendChild(b);
    }
    places.appendChild(prow);
    panel.appendChild(places);
  }

  const filter = el("input", "picker-filter t-body");
  filter.type = "text";
  filter.placeholder = "Filter folders…";
  filter.value = picker.filter;
  panel.appendChild(filter);

  const list = el("div", "picker-list");
  list.id = "pickerList";
  /* Filtering rebuilds only the list, so the input keeps focus and the caret —
     unless it just hid the selected row: a selection out of sight must not stay
     startable, so it clears and the footer re-renders with it. */
  filter.oninput = () => {
    picker.filter = filter.value;
    if (picker.selected && !pickerShownEntries().some((e) => e.path === picker.selected)) {
      picker.selected = null;
      renderPicker();
      return;
    }
    fillPickerList(list);
  };
  fillPickerList(list);
  panel.appendChild(list);

  const foot = el("div", "picker-foot");
  const tgt = el("div", "picker-target");
  tgt.appendChild(el("span", "t-caption dimr", "The agent will work in:"));
  const pt = el("div", "pt-path", picker.selected || "—");
  pt.id = "pickerTarget";
  if (picker.selected) pt.title = picker.selected;
  tgt.appendChild(pt);
  foot.appendChild(tgt);
  if (picker.error && !picker.loading) {
    /* The reason Start is unavailable belongs beside the button, with a
       one-step way back to the workspace root (D49). */
    foot.appendChild(el("span", "picker-foot-error t-caption", picker.error));
    if (rootPath) {
      const back = el("button", "btn btn-sm", "Back to " + base(rootPath));
      back.dataset.variant = "ghost";
      back.onclick = () => pickerFetch(rootPath);
      foot.appendChild(back);
    }
  }
  /* The commit action names the exact folder it will use — self-checking at
     the moment of commitment, without reading a path (D49). */
  const start = el("button", "btn", pickerStartLabel());
  start.id = "pickerStart";
  start.disabled = picker.creating || !picker.selected;
  start.onclick = startPickedSession;
  foot.appendChild(start);
  const cancel = el("button", "btn", "Cancel");
  cancel.dataset.variant = "ghost";
  cancel.onclick = closePicker;
  foot.appendChild(cancel);
  panel.appendChild(foot);

  /* Keyboard: ↑/↓ move the selection through the visible rows; Enter in the
     filter selects the first match; Tab stays inside the panel; Esc closes
     (the global handler). */
  filter.onkeydown = (e) => {
    if (e.key !== "Enter" || !picker) return;
    const shown = pickerShownEntries();
    if (shown.length) { picker.selected = shown[0].path; renderPicker(); }
    e.preventDefault();
  };
  panel.onkeydown = (e) => {
    if (!picker) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const shown = pickerShownEntries();
      if (!shown.length) return;
      const i = shown.findIndex((x) => x.path === picker.selected);
      const next = e.key === "ArrowDown" ? Math.min(i + 1, shown.length - 1) : Math.max(i - 1, 0);
      picker.selected = shown[next].path;
      renderPicker();
      e.preventDefault();
    } else if (e.key === "Tab" && typeof panel.querySelectorAll === "function") {
      const focusables = Array.from(panel.querySelectorAll("button, input")).filter((n) => !n.disabled);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  };

  host.appendChild(backdrop);
  try { filter.focus(); } catch { /* focus is a nicety, not a requirement */ }
}

async function startPickedSession() {
  if (!picker || !picker.selected || picker.creating) return;
  const cwd = picker.selected;
  picker.creating = true;
  renderPicker();
  const rec = await createSession(cwd);
  if (rec) closePicker();
  else if (picker) { picker.creating = false; renderPicker(); }
}

/**
 * Create a session in `cwd` through the existing `session/new`, then VERIFY it
 * against the server's own state before this tab selects it.
 *
 * The success response is not the evidence — this API returns success for calls
 * that did nothing (standing rule 1). So: read /state back, confirm the returned
 * id is actually held, confirm its cwd is the folder that was asked for, and only
 * then select it. Selection happens ONLY here, in the tab that created the
 * session — never on the `bridge.session_opened` broadcast, which every tab sees.
 */
async function createSession(cwd) {
  /* quiet: the failure sentence below is the better one (it says what to do);
     the machine detail still reaches the Shell log's Copy details via
     r.details (WP12). */
  const r = await post("/session/new", { cwd }, { quiet: true });
  if (!r || r.error || !r.session || typeof r.session.sessionId !== "string") {
    note("error", "New session failed" + (r && r.error ? " — " + r.error : "") + ".", r && r.details);
    return null;
  }
  const newId = r.session.sessionId;

  const s = await post("/state");
  if (!s || s.error || !Array.isArray(s.sessions)) {
    note("error", "New session " + newId + " could not be confirmed — the server's state could not be read back. Not selecting it.");
    return null;
  }
  agent = s;
  for (const rec2 of s.sessions) { const held = view(rec2.sessionId); if (rec2.live) held.opened = true; }
  const rec = s.sessions.find((x) => x.sessionId === newId) || null;
  if (!rec) {
    note("error", "New session " + newId + " could not be confirmed — the server's state does not hold it. Not selecting it.");
    renderAll();
    return null;
  }
  if (rec.cwd !== cwd) {
    /* Standing rule 1, all the way: the id alone is not verification. A session
       whose read-back cwd is not the folder that was asked for is NEVER
       selected — selecting it would put the conversation surface on a folder
       the operator did not choose. It exists server-side; say so and stop. */
    note("error", "New session " + newId + " was created, but its cwd (" + rec.cwd + ") is not the folder asked for (" + cwd + "). Not selecting it — it exists on the server in that other folder.");
    renderAll();
    refreshRoster();
    return null;
  }
  note("info", "New session " + newId + " confirmed in " + rec.cwd + ".");
  /* Select it — in THIS tab only, and only after id AND cwd verified. */
  setActiveSession(newId);
  reconcileActiveSession();
  renderAll();
  refreshRoster();
  return rec;
}

/* ── THE CANVAS: THE CONVERSATION STREAM (WP5) ────────────────────────────

   Spec §1's active-session layout, built out of `v.turns`. Nothing here reads
   an event; the reducer in handle() has already turned events into turns and
   blocks, and this function only draws them. That split is why a replay and a
   live turn render through the same code and why the drawing can be batched.

   FOUR THINGS THIS FUNCTION IS CAREFUL ABOUT

   1. **Agent text is text.** Every string that came off the wire reaches the
      DOM through `el()`, `blockText()` or `pre()`, all of which end at
      `textContent`. That includes the raw payload on an unhandled-event card,
      which is the easiest one to forget because it looks like debug output
      rather than product surface. Rule 1, D31.

   2. **A missing value says so.** "not reported", never a plausible zero. The
      cost line is the one that matters most and it has its own comment.

   3. **State the user set survives a redraw.** The canvas is rebuilt whole on
      every event, so "I expanded that thinking block" lives on the block
      object, not on the DOM node.

   4. **Scroll position survives a redraw too**, and it follows the stream only
      if the user was already at the bottom. Yanking the view down while
      somebody is reading a tool result three turns back is how a live pane
      becomes unusable.
   ─────────────────────────────────────────────────────────────────────── */

/* One paint per frame however many events arrived in it. A one-command turn
   produced 39 thought chunks in WP4's run; without this that is 39 full
   rebuilds of the pane. */
let canvasQueued = false;
function scheduleCanvas() {
  if (recoveryActive) return;
  if (canvasQueued) return;
  canvasQueued = true;
  requestAnimationFrame(() => {
    canvasQueued = false;
    renderCanvas();
    /* The drawer draws from the same state and used to lag a whole turn behind
       the stream, so it goes in the same frame. Cheap: it is 320px of table and
       it is closed most of the time. */
    if ($("app").dataset.drawer === "open") renderDrawer();
  });
}

function renderCanvas() {
  const c = $("canvasInner");
  const scroller = $("canvas");
  if (recoveryActive && recoveryPainted) return;
  /* 40px of slack: "at the bottom" has to survive sub-pixel layout and the
     block that is still growing as the agent streams into it. */
  const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
  const wasScrollTop = scroller.scrollTop;
  c.textContent = "";

  if (!activeId) {
    const w = el("div", "centred");
    if (agent.state === "starting") {
      /* WP10 first run: the wait is named, and the instrument's credentials
         are on screen while it happens — not a bare "Connecting…". */
      w.appendChild(el("h1", "t-display", "Starting the agent…"));
      w.appendChild(el("p", "t-body dim", "The first handshake can take about ten seconds."));
    } else {
      w.appendChild(el("h1", "t-display", "No session open"));
      w.appendChild(el("p", "t-body dim", "Select a session from the left or start a new session."));
      const b = el("button", "btn", "New session");
      b.title = "Start a new session in a folder you pick.";
      b.onclick = openPicker;
      w.appendChild(b);
    }
    /* The WP10 facts panel: version, process + pid, the configured permission
       default, the privacy reading — visible before any session exists. */
    w.appendChild(renderAgentFacts());
    c.appendChild(w);
    return;
  }

  const rec = agent.sessions.find((s) => s.sessionId === activeId) || null;
  const v = view(activeId);
  const st = resolveState();

  if (recoveryActive) {
    recoveryPainted = true;
    c.appendChild(el("div", "stream-note t-caption",
      recoveryText || "Restoring this page from the server's retained history."));
    return;
  }

  /* A row selected out of the rail that this app does not hold. It receives no
     events, so there is no conversation to draw and saying "Session ready"
     would be a lie about a session we are not listening to. */
  if (!rec) {
    const w = el("div", "centred");
    w.appendChild(el("h1", "t-title", "This session is on disk"));
    w.appendChild(el("p", "t-body dim",
      "This app is not holding it open, so it receives no events for it. Clicking it in the rail "
      + "loads it, and the agent then replays the whole conversation as history."));
    c.appendChild(w);
    return;
  }

  if (rec.loading) c.appendChild(el("div", "stream-note t-caption",
    "Loading this session — the agent is replaying its conversation as history."));

  if (v.historyMissing) {
    c.appendChild(el("div", "stream-note t-caption", v.historyMissing));
  }

  if (!v.turns.length) {
    /* Spec §2's empty state, but only when the session really is idle. */
    const w = el("div", "centred");
    w.appendChild(el("h1", "t-title", "Session ready"));
    w.appendChild(el("p", "t-body dim", "Type what you want the agent to do."));
    if (rec.replayedEvents > 0) {
      w.appendChild(el("p", "t-caption dimr",
        rec.replayedEvents + (rec.replayedEvents === 1
          ? " event was replayed for this session; it carried no "
          : " events were replayed for this session; none of them carried ")
        + "conversation content. An empty history is a real answer, not a missing one."));
    }
    c.appendChild(w);
  } else {
    c.appendChild(renderStream(v));
  }

  /* Context nearly full. Spec §2's error-and-recovery copy, shown only when
     the agent's own threshold says so. */
  if (contextNear(v)) {
    const pan = el("div", "panel");
    /* LEGIBILITY (D45): "Context nearly full" is a non-blocking advisory, not
       "the machine is waiting for you" — neutral strong border, not gold. */
    pan.style.borderColor = "var(--border-strong)";
    pan.appendChild(el("div", "t-med", "Context nearly full"));
    pan.appendChild(el("p", "t-body dim", "Compact now or start a new session."));
    const b = el("button", "btn", v && v.compacting ? "Compacting…" : "Compact now");
    /* Wired in WP9. Same flow and the same enablement as the meter popover's
       button (Grok review M1): the honest before/after sentence arrives as a
       note, and the agent's own completion numbers land in the stream. */
    b.disabled = compactDisabled(v);
    b.title = "Ask the agent to summarise this conversation to free context. "
      + "The before and after readings are shown when it finishes.";
    b.onclick = () => compactNow(activeId);
    pan.appendChild(b);
    c.appendChild(pan);
  }

  /* The blocking surfaces render as cards INSIDE the stream at the point they
     arrived (WP6, D54) — there is no bottom-of-canvas interrupt any more. The
     strip's gold state and the rail's needs-input dot still say someone is
     waiting when the card is scrolled out of view. */

  if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = wasScrollTop;
}

function renderStream(v) {
  const wrap = el("div", "stream");
  const shown = v.turns.slice(-MAX_TURNS_RENDERED);
  const hidden = v.turns.length - shown.length + v.turnsDropped;
  if (hidden > 0) {
    wrap.appendChild(el("div", "stream-note t-caption",
      hidden + (hidden === 1 ? " earlier turn" : " earlier turns") + " not shown"
      + (v.turnsDropped ? " · " + v.turnsDropped + " of them are no longer held in this page" : "")));
  }
  for (const t of shown) wrap.appendChild(renderTurn(v, t));
  return wrap;
}

/* ── ONE TURN ─────────────────────────────────────────────────────────── */

function renderTurn(v, t) {
  const box = el("div", "turn");
  box.dataset.outcome = t.aside ? "aside" : t.outcome;
  box.dataset.replay = String(t.replay);
  box.dataset.aside = String(t.aside);

  const head = el("div", "turn-head t-caption");
  /* An aside carries no turn number and no cost line, because it is not a turn:
     nothing was asked and nothing was billed. Before the first prompt it is the
     session coming up; after one it is whatever the agent said next. */
  head.appendChild(el("span", "turn-n",
    t.aside
      ? (t.n === null && v.turnSeq === 0 ? "SESSION SETUP" : "BETWEEN TURNS")
      : t.partial ? "PARTIAL TURN" : v.historyMissing && t.replay ? "RETAINED TURN " + t.n : "TURN " + t.n));
  head.appendChild(el("span", "dimr", t.replay ? "history" : ago(t.at) + " ago"));
  box.appendChild(head);

  /* Draw the items, coalescing a run of consecutive routine-activity notices
     into one Activity fold (D47), and a run of consecutive KNOWN background
     events into one calm quiet line (D84). Everything else — messages,
     thinking, tool cards, stop/refused/recovery/abandoned notices, genuinely
     unhandled cards — renders in place, in order. */
  for (let i = 0; i < t.items.length; ) {
    if (isActivityNotice(t.items[i])) {
      const run = [];
      while (i < t.items.length && isActivityNotice(t.items[i])) run.push(t.items[i++]);
      box.appendChild(renderActivityGroup(run));
      continue;
    }
    if (isQuietUnhandled(t.items[i])) {
      const run = [];
      while (i < t.items.length && isQuietUnhandled(t.items[i])) run.push(t.items[i++]);
      box.appendChild(renderQuietGroup(run));
      continue;
    }
    const node = renderBlock(v, t, t.items[i]);
    if (node) box.appendChild(node);
    i++;
  }

  /* A turn with NOTHING in it. Reachable only when a turn closes (or the
     record ends) before any content was ever assigned to it — turnToClose
     can open a turn for a finish event that has no home. While a turn is
     running, zero items is normal (the first chunk has not landed) and the
     working indicator already says what is happening, so the sentence is
     only for a turn that will never get content. */
  if (t.items.length === 0 && t.outcome !== "running") {
    box.appendChild(el("p", "t-caption dim",
      "Nothing was recorded for this turn — no prompt text and no events."));
  }

  if (!t.aside) box.appendChild(renderTurnFoot(v, t));
  return box;
}

/**
 * The turn's closing line: what happened, then what it cost.
 *
 * THE COST (D18, and the reason this project exists in miniature). The agent
 * reports `costUsdTicks` as an integer count of ten-billionths of a dollar, and
 * `studio/events.ts` has already divided it. That field is **absent rather than
 * zero** when nothing was reported — xAI's own code filters non-positive values
 * to None precisely so "unreported" cannot be read as "free". So the two cases
 * get two different sentences, and `$0.000000` is never printed. If you are
 * editing this and a zero appears, that is the regression.
 */
function renderTurnFoot(v, t) {
  const foot = el("div", "turn-foot t-caption");

  /* THE WORKING INDICATOR (acceptance walk, 2026-08-02). A running turn used
     to say "Running · Cost: pending" in static text, so the only way to know
     the machine was alive was to read a busy page and find that line. It now
     leads with a moving mark and a clock that ticks.

     But it only "works" when it GENUINELY does. The authority is the server's
     own `rec.turnInFlight`, not merely `t.outcome === "running"`: a turn loaded
     from disk whose history had no recorded ending, or one recovered by F5 into
     a dormant session, is not running now. finalizeReconstructedCompletions
     closes those to "ended", but this guard is the belt to that suspenders —
     the animation NEVER shows for a turn the server does not report in flight,
     so a stale "running" cannot spin the needle on an idle session (the exact
     bug the director's walk found on a terminal-started session). */
  const rec = agent.sessions.find((s) => s.sessionId === activeId) || null;
  /* Genuinely working = running AND either a live turn this app is driving
     (`!t.replay`, immediate, no dependency on snapshot timing) OR one the
     server still reports in flight (the rare case of an F5 landing mid-turn,
     where the recovered turn is tagged replay but is really live). A loaded
     dangling turn is replay AND not in flight → never animates. */
  const liveWorking = t.outcome === "running" &&
    (!t.replay || !!(rec && rec.turnInFlight === true));

  if (liveWorking) {
    const mark = el("span", "working-mark");
    mark.setAttribute("aria-hidden", "true");
    foot.appendChild(mark);
  }

  let verdict;
  if (liveWorking) verdict = "Working";
  else if (t.outcome === "running" || t.outcome === "ended") verdict = "Turn ended";
  else if (t.outcome === "ok") verdict = "Turn complete";
  else if (t.outcome === "cancelled") verdict = "Turn cancelled";
  else verdict = "Turn failed";
  foot.appendChild(el("span", "turn-verdict t-med", verdict));

  /* A turn whose recorded history simply ends — no outcome on the wire — says
     so plainly rather than claiming success or failure. */
  if (t.outcome === "ended" || (t.outcome === "running" && !liveWorking)) {
    foot.appendChild(el("span", "dim grow",
      "the loaded history did not record how this turn ended"));
  }

  /* Elapsed, live. `data-since` is the turn's own start; the one-second ticker
     rewrites ONLY this element's text, never the canvas — a full repaint would
     destroy a half-typed plan-feedback note (the §0 repaint hazard). A finished
     turn keeps its final duration, static; a turn with no recorded ending shows
     no duration, because we do not have one. */
  if (t.at) {
    const elapsed = el("span", "elapsed t-mono-sm");
    if (liveWorking) {
      elapsed.className += " live-elapsed";
      elapsed.dataset.since = String(t.at);
      elapsed.textContent = durationSince(t.at);
    } else if (t.endedAt && t.outcome !== "ended" && t.endedAt - t.at >= 1000) {
      /* Only when it is a real, ≥1s duration. A replayed turn whose recorded
         start and end timestamps collapse would otherwise read "took 0s". */
      elapsed.textContent = "took " + fmtDuration(t.endedAt - t.at);
    }
    if (elapsed.textContent) foot.appendChild(elapsed);
  }

  /* Why it is not a success, in the agent's own words where it gave any. A
     stopReason that is not end_turn is not a success even though the request
     succeeded — WP5 trap 4. */
  if (t.outcome === "failed" || t.outcome === "cancelled") {
    const why = t.error
      ? t.error
      : t.stopReason == null
        ? "the agent did not say why"
        : "stopped: " + t.stopReason;
    foot.appendChild(el("span", "dim grow", why));
  }

  /* The cost line, concise (D18/D48). Still an honesty statement at
     --text-secondary, still worded so it cannot be read as a charge, and still
     "not reported" — never $0.000000 — when the agent gave no figure. The director's
     dogfood asked for less text; this is the same honesty in a shorter sentence,
     and the "Agent-reported / not billed to your plan" framing keeps D18. */
  const cost = el("span", "dim");
  if (t.cost && t.cost.usd !== null && t.cost.usd !== undefined) {
    cost.textContent = "Agent-reported: " + fmtUsd(t.cost.usd) + " · not billed to your plan"
      + (t.cost.incomplete ? " · may under-count" : "");
  } else if (liveWorking) {
    cost.textContent = "Cost: pending";
  } else {
    cost.textContent = "Cost: not reported";
  }
  foot.appendChild(cost);

  /* Per-turn token usage moves off the turn's face behind a small fold (D47:
     less text). The cost stays visible; the breakdown is one click away, and its
     expanded state lives on the turn so it survives a redraw. */
  if (t.usage) {
    const u = t.usage;
    const bits = [];
    if (num(u.inputTokens) !== null) bits.push(num(u.inputTokens).toLocaleString() + " in");
    if (num(u.outputTokens) !== null) bits.push(num(u.outputTokens).toLocaleString() + " out");
    if (num(u.reasoningTokens) !== null) bits.push(num(u.reasoningTokens).toLocaleString() + " reasoning");
    if (num(u.modelCalls) !== null) bits.push(num(u.modelCalls) + (num(u.modelCalls) === 1 ? " model call" : " model calls"));
    if (bits.length) {
      const tog = el("button", "fold t-caption");
      tog.appendChild(el("span", "fold-caret", t.usageExpanded ? "▾" : "▸"));
      tog.appendChild(el("span", "dimr", "tokens"));
      tog.setAttribute("aria-expanded", String(!!t.usageExpanded));
      tog.onclick = () => { t.usageExpanded = !t.usageExpanded; renderCanvas(); };
      foot.appendChild(tog);
      if (t.usageExpanded) foot.appendChild(el("span", "dim t-mono-sm", bits.join(" · ")));
    }
  }

  /* WP11: undo everything this turn still has pending. Shown ONLY when the
     changes reading lists pending hunks for this turn's WIRE promptIndex
     (changesEntryForTurn — stamped by the agent, never ordinal), never
     mid-turn, and never while another changes action is in flight (one
     session-level lock, Grok I6). Undo writes disk, so it confirms once
     (D62/D63): the first click arms, the second acts. */
  const chgEntry = changesEntryForTurn(v, t);
  if (chgEntry && !changesLocked(activeId)) {
    if (t.undoArmed !== true) {
      const undo = el("button", "btn btn-sm", "Undo everything from this turn");
      undo.title = "Rewrite the files this turn changed back to how they were before it ran.";
      undo.disabled = v.changesUi.busy === true;
      undo.onclick = () => { t.undoArmed = true; renderCanvas(); };
      foot.appendChild(undo);
    } else {
      foot.appendChild(el("span", "dim",
        "This rewrites the file on disk. Your own edits to other files are not touched."));
      const keep = el("button", "btn btn-sm", "Keep it");
      keep.dataset.variant = "ghost";
      keep.onclick = () => { t.undoArmed = false; renderCanvas(); };
      foot.appendChild(keep);
      const go = el("button", "btn btn-sm", "Undo it");
      go.dataset.variant = "danger";
      go.disabled = t.undoBusy === true || v.changesUi.busy === true;
      go.onclick = () => undoTurn(activeId, chgEntry.promptIndex, t);
      foot.appendChild(go);
    }
  }

  /* Reconciliation §C: "Retry" understates it. A turn that failed mid-way may
     already have written files, so the label has to say that it re-sends. */
  if (t.outcome === "failed") {
    const again = el("button", "btn btn-sm", "Send this prompt again");
    const u = t.items.find((i) => i.kind === "user");
    again.disabled = !u || !u.text;
    again.title = "There is no retry method. This puts the same text back in the composer so you "
      + "can send it again — and a turn that failed mid-way may already have changed files.";
    again.onclick = () => {
      $("prompt").value = u.text;
      $("prompt").focus();
    };
    foot.appendChild(again);
  }
  return foot;
}

/* ── ONE BLOCK ────────────────────────────────────────────────────────── */

function renderBlock(v, t, b) {
  if (b.kind === "user")      return renderMessage(b, "user", "YOU");
  if (b.kind === "agent")     return renderMessage(b, "agent", "AGENT");
  if (b.kind === "thinking")  return renderThinking(b);
  if (b.kind === "tool")      return renderToolCard(b);
  if (b.kind === "notice")    return renderNotice(b);
  if (b.kind === "unhandled") return renderUnhandled(b);
  if (b.kind === "interaction") return renderInteractionCard(v, b);
  /* Unreachable by construction, and it still renders rather than vanishing —
     the same rule the wire gets. */
  return el("div", "stream-note t-caption", "a block of kind '" + esc(b.kind) + "' with no renderer");
}

function renderMessage(b, who, label) {
  const box = el("div", "blk");
  box.dataset.who = who;
  box.dataset.replay = String(b.replay);
  const head = el("div", "blk-head t-caption");
  head.appendChild(el("span", "blk-who", label));
  if (b.note) head.appendChild(el("span", "blk-note dimr", b.note));
  box.appendChild(head);
  const body = el("div", "msg t-body");
  /* Text, with fenced code segmented into <pre>. No markdown renderer, so no
     sanitiser to get wrong (D32). */
  blockText(body, b.text);
  box.appendChild(body);
  return box;
}

/**
 * Thinking, folded behind its own chunk count (D34).
 *
 * Not streamed visibly by default: a one-command turn produced 39 chunks in
 * WP4's run and 57 in an earlier one, and on an unstyled page they buried the
 * answer. The count is the honest summary — it says how much thinking happened
 * without making the reader scroll through it.
 */
function renderThinking(b) {
  const box = el("div", "blk");
  box.dataset.who = "thinking";
  box.dataset.replay = String(b.replay);

  const btn = el("button", "fold t-caption");
  btn.appendChild(el("span", "fold-caret", b.expanded ? "▾" : "▸"));
  btn.appendChild(el("span", "blk-who", "THINKING"));
  btn.appendChild(el("span", "dimr",
    b.chunks + (b.chunks === 1 ? " chunk" : " chunks")
    + " · " + b.text.length.toLocaleString() + " characters"
    + (b.sealed ? "" : " · still arriving")));
  btn.setAttribute("aria-expanded", String(!!b.expanded));
  btn.onclick = () => { b.expanded = !b.expanded; renderCanvas(); };
  box.appendChild(btn);

  const body = el("div", "fold-body");
  body.hidden = !b.expanded;
  const txt = el("div", "think-text t-body");
  txt.textContent = b.text;
  body.appendChild(txt);
  box.appendChild(body);
  return box;
}

/**
 * A tool call.
 *
 * BUILT ENTIRELY FROM `_meta["x.ai/tool"]`, which `studio/events.ts` normalises
 * into `data.tool` as `{name, kind, label, namespace, readOnly, version}`:
 * `label` is the heading, `kind` is the type line, `readOnly` is the treatment.
 * No tool name is compared against anything in this file — WP5 trap 1. If the
 * string "bash" ever appears here, it is wrong and it breaks on the next CLI
 * release.
 *
 * Two shapes the wire actually has, both of which this handles:
 *   · `status` is ABSENT on the first `tool_call` and normalises to null, which
 *     means "not started" and must never be read as a value.
 *   · the TERMINAL `tool_call_update` carries no descriptor and no title, only
 *     the id, the status and the content — so the descriptor is carried forward
 *     by `toolCallId` in the reducer, not expected on every update.
 */
function renderToolCard(b) {
  const box = el("div", "tool-card");
  box.dataset.status = b.status || "unreported";
  box.dataset.writes = String(b.readOnly === false);

  const row = el("div", "tool-row");
  /* The agent's own label, and its own name when the two differ. Never ours. */
  row.appendChild(el("span", "tool-label t-med", b.label || b.name || b.title || "tool"));

  /* read_only. Three states on purpose: rendering a missing flag as "writes"
     cries wolf, and rendering it as read-only lies in the dangerous direction.
     The reconciliation calls this the single most decision-relevant bit on the
     surface, and it appears nowhere in the design spec. */
  /* D57: the marker mirrors the field. "changes files" overclaimed
     read_only:false — an Execute-echo call changes nothing — so the shared
     vocabulary is the field-mirroring trio, here and on the permission card. */
  row.appendChild(roMarker(b.readOnly));

  const target = targetOf(b);
  row.appendChild(el("span", "tool-target", target || "no target reported"));

  const stat = el("span", "tool-status t-caption");
  if (b.status === "completed") { stat.dataset.s = "completed"; stat.textContent = "done"; }
  else if (b.status === "failed") { stat.dataset.s = "failed"; stat.textContent = "failed"; }
  else if (b.status === null || b.status === undefined) { stat.dataset.s = "unreported"; stat.textContent = "no status yet"; stat.title = "The agent has not reported a status for this call yet. Absent is not a value — it is not 'pending' and it is not 'done'."; }
  else { stat.dataset.s = "running"; stat.textContent = esc(b.status); }
  row.appendChild(stat);
  box.appendChild(row);

  /* Files the agent said this call touches. Spec §1's "file-edit summaries",
     built out of the agent's own `locations` array plus its own readOnly flag —
     not out of a list of tool names we decided were edits. */
  const paths = pathsOf(b);
  if (paths.length) {
    const files = el("div", "files");
    for (const p of paths) {
      const r = el("div", "file-row");
      r.appendChild(el("span", "file-mark t-caption", b.readOnly === false ? "changed" : "read"));
      r.appendChild(el("span", "file-path", p));
      files.appendChild(r);
    }
    box.appendChild(files);
  }

  /* The fold. LEGIBILITY (D45): the card FACE stays label / read-only / target /
     status. The kind, namespace and internal name are metadata, so they move in
     here with the exact input and result. The exact input matters — it is the
     thing a permission decision is actually about — but it is long, and every
     byte of it is agent-controlled text going in through textContent.

     If a tool carries metadata but no raw input or output, the fold is still
     offered — truthfully, as "show tool details" — rather than the metadata
     being silently dropped from the card. */
  const meta = [];
  if (b.kindStr) meta.push("kind " + b.kindStr);
  if (b.namespace) meta.push(b.namespace);
  if (b.name && b.name !== b.label) meta.push(b.name);
  const hasIn = b.rawInput !== undefined && b.rawInput !== null;
  const hasOut = b.rawOutput !== undefined && b.rawOutput !== null;
  if (hasIn || hasOut || meta.length) {
    const inputly = hasIn || hasOut;
    const btn = el("button", "fold t-caption");
    btn.appendChild(el("span", "fold-caret", b.expanded ? "▾" : "▸"));
    const label = b.expanded
      ? (inputly ? "hide the exact input" : "hide tool details")
      : (inputly ? "show the exact input" + (hasOut ? " and what came back" : "") : "show tool details");
    btn.appendChild(el("span", "", label));
    btn.setAttribute("aria-expanded", String(!!b.expanded));
    btn.onclick = () => { b.expanded = !b.expanded; renderCanvas(); };
    box.appendChild(btn);

    const body = el("div", "fold-body");
    body.hidden = !b.expanded;
    if (meta.length) {
      body.appendChild(el("div", "t-caption dimr", "kind / namespace / internal name"));
      body.appendChild(el("div", "t-caption dim", meta.join(" · ")));
    }
    if (hasIn) {
      body.appendChild(el("div", "t-caption dimr", "arguments, exactly as the agent sent them"));
      body.appendChild(pre("raw", typeof b.rawInput === "string" ? b.rawInput : jsonText(b.rawInput)));
    }
    if (hasOut) {
      body.appendChild(el("div", "t-caption dimr", "result"));
      body.appendChild(pre("raw", typeof b.rawOutput === "string" ? b.rawOutput : jsonText(b.rawOutput)));
    }
    box.appendChild(body);
  }
  return box;
}

/**
 * The one line a tool card most needs: what is this call about?
 *
 * There is no "target" field. `title` is the agent's own sentence for the call
 * (e.g. "Execute `echo hi`"), the location paths are the files, and rawInput is
 * whatever the tool takes. Preference order, and never a guess: title, then the
 * first location, then nothing — with "no target reported" said out loud rather
 * than an empty space that reads as "nothing to see".
 */
function targetOf(b) {
  if (b.title) return b.title;
  const p = pathsOf(b);
  if (p.length) return p.length === 1 ? p[0] : p[0] + " (+" + (p.length - 1) + " more)";
  return null;
}

/** Paths out of `locations`, which is ACP's own `[{path, line?}]`. */
function pathsOf(b) {
  const out = [];
  const list = Array.isArray(b.locations) ? b.locations : [];
  for (const loc of list) {
    if (!loc) continue;
    if (typeof loc === "string") { out.push(loc); continue; }
    if (typeof loc.path === "string") {
      out.push(loc.path + (num(loc.line) !== null ? ":" + loc.line : ""));
    }
  }
  return out;
}

/**
 * A one-line notice inside the stream: mode changes, compaction, subagents,
 * the session being titled. Modelled events that are not conversation content
 * but are things a director needs to see happen.
 */
function renderNotice(b) {
  const box = el("div", "blk");
  box.dataset.who = "notice";
  box.dataset.replay = String(b.replay);
  const head = el("div", "blk-head t-caption");
  head.appendChild(el("span", "blk-who", b.label || "NOTICE"));
  box.appendChild(head);
  box.appendChild(el("div", "msg t-body dim", b.text));
  return box;
}

/* ── THE ACTIVITY FOLD (D47) ──────────────────────────────────────────────
   Routine recognised activity collapses into one labelled, expandable row so
   the conversation dominates and the machinery recedes — the density the director asked
   for. The full text of every grouped notice is inside the fold; NOTHING IS
   DROPPED. Only routine recognised activity is grouped; the notices that are a
   failure, a recovery, a stop, or an interaction still waiting are NOT — they
   keep their own visible row, as do messages, tool cards, and the D35 unhandled
   card. The set below is our own notice labels (never wire strings). This is a
   render-time grouping: the items themselves are untouched in the turn model, so
   replay, abandonment insertion and the retention bounds are all unchanged. */
const ACTIVITY_NOTICE_LABELS = new Set(["TITLE", "MODE", "MODEL", "CONTEXT", "SUBAGENT", "ANSWERED", "SETUP"]);
function isActivityNotice(b) {
  return !!b && b.kind === "notice" && ACTIVITY_NOTICE_LABELS.has(b.label);
}

/* D84: the two KNOWN background kinds. Both are first-class AppEvents
   (events.ts NOTIFICATION_KINDS, verified:true) that fire on every turn,
   carry no operator decision, and their payloads are noise to read
   (queue.changed carries the whole prompt text). Consecutive ones compress
   into ONE calm line — dim, no flag — because the "UNHANDLED EVENT" flag
   read as an error message to the first user, on every turn. A LOUD row
   (b.loud — "WIRE PROBLEM") is NEVER quieted, even for these types:
   failures out-shout noise stays absolute. And D35 stands: nothing is
   dropped — every member and its payload stays inside the fold. */
const QUIET_BACKGROUND = new Set(["queue.changed", "turn.prompt_complete"]);
function isQuietUnhandled(b) {
  return !!b && b.kind === "unhandled" && !b.loud && QUIET_BACKGROUND.has(b.type);
}

/** One calm line for a run of background events, with per-kind counts. */
function renderQuietGroup(run) {
  const box = el("div", "quietbg");
  const first = run[0];
  const expanded = !!first._quietExpanded;

  const counts = new Map();
  for (const it of run) counts.set(it.type, (counts.get(it.type) || 0) + 1);
  const summary = [...counts.entries()]
    .map(([k, n]) => (n > 1 ? k + " ×" + n : k)).join(" · ");
  const allReplay = run.every((it) => it.replay);

  const btn = el("button", "fold t-caption");
  btn.appendChild(el("span", "fold-caret", expanded ? "▾" : "▸"));
  btn.appendChild(el("span", "quietbg-label", "background events"));
  btn.appendChild(el("span", "dimr", summary));
  if (allReplay) btn.appendChild(el("span", "dimr", "from history"));
  btn.setAttribute("aria-expanded", String(expanded));
  btn.onclick = () => { first._quietExpanded = !first._quietExpanded; renderCanvas(); };
  box.appendChild(btn);

  const body = el("div", "fold-body");
  body.hidden = !expanded;
  for (const it of run) appendQuietMember(body, it);
  box.appendChild(body);
  return box;
}

/* One member inside the quiet fold: type and replay marker on the row, the
   SAME fold body renderUnhandled uses (note, missing fields, payload) inside.
   The alarming flag is the thing D84 quiets, so the row does not carry it. */
function appendQuietMember(body, it) {
  const wrap = el("div", "quietbg-item");
  const row = el("button", "fold t-caption");
  row.appendChild(el("span", "fold-caret", it.expanded ? "▾" : "▸"));
  row.appendChild(el("span", "t-mono-sm", it.type));
  if (it.replay) row.appendChild(el("span", "dimr", "from history"));
  row.setAttribute("aria-expanded", String(!!it.expanded));
  row.onclick = () => { it.expanded = !it.expanded; renderCanvas(); };
  wrap.appendChild(row);
  const sub = el("div", "fold-body");
  sub.hidden = !it.expanded;
  unhandledFoldBody(sub, it);
  wrap.appendChild(sub);
  body.appendChild(wrap);
}

function renderActivityGroup(run) {
  const box = el("div", "activity");
  const first = run[0];
  const expanded = !!first._actExpanded;

  /* A terse summary in the header — kind ×count — so what happened is legible
     without expanding, while the full prose stays folded. */
  const counts = new Map();
  for (const it of run) {
    const k = (it.label || "NOTICE").toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([k, n]) => (n > 1 ? k + " ×" + n : k)).join(", ");

  const btn = el("button", "fold t-caption");
  btn.appendChild(el("span", "fold-caret", expanded ? "▾" : "▸"));
  btn.appendChild(el("span", "act-label", "ACTIVITY"));
  btn.appendChild(el("span", "dimr",
    run.length + (run.length === 1 ? " event · " : " events · ") + summary));
  btn.setAttribute("aria-expanded", String(expanded));
  btn.onclick = () => { first._actExpanded = !first._actExpanded; renderCanvas(); };
  box.appendChild(btn);

  const body = el("div", "fold-body");
  body.hidden = !expanded;
  for (const it of run) {
    const row = el("div", "act-item t-caption");
    /* label is our own; text is agent-or-protocol content — both reach the DOM
       through el()/textContent, so a hostile session title in a TITLE notice is
       five printable characters, never markup. Rule 1, D31. */
    row.appendChild(el("span", "act-k", it.label || "NOTICE"));
    row.appendChild(el("span", "act-v", it.text || ""));
    body.appendChild(row);
  }
  box.appendChild(body);
  return box;
}

/**
 * AN EVENT KIND THIS BUILD DOES NOT HANDLE (D35).
 *
 * An event kind this build has not handled before must look unhandled rather
 * than invisible: a `switch` written against what somebody happened to have
 * seen drops the rest silently, and a silently dropped update is how a release
 * breaks the pane with no error anywhere. That rule caught five unmodelled kinds
 * in WP3a and it survives here.
 *
 * LEGIBILITY (D45): `data-loud`, derived only from the existing b.loud flag,
 * drives the presentation. A routine recognised-but-unmodelled kind is neutral
 * and calm; a WIRE PROBLEM is red, so failures out-shout noise. Classification
 * and payload retention are unchanged — this only styles the card.
 *
 * The payload is rendered with `pre()`, which is `textContent`. This is the
 * path most likely to be forgotten — it looks like debug output rather than
 * product surface — and it is the one an injected payload arrives on.
 */
/** The unhandled card's fold body — shared with the D84 quiet member rows. */
function unhandledFoldBody(body, b) {
  const bits = [];
  if (b.wireKind) bits.push("the agent calls it '" + b.wireKind + "'");
  bits.push(b.modelled ? "normalised" : "recognised by name, never captured — the payload is all there is");
  body.appendChild(el("div", "t-caption dimr", bits.join(" · ")));
  if (b.note) body.appendChild(el("p", "t-body dim", b.note));
  if (b.missing && b.missing.length) {
    body.appendChild(el("p", "t-caption",
      "fields a normaliser expected and did not find: " + b.missing.join(", ")));
  }
  body.appendChild(pre("raw", jsonText(b.payload)));
}

function renderUnhandled(b) {
  const box = el("div", "unhandled");
  /* Presentation only, from the existing b.loud boolean. No effect on what the
     event is or what it retains. */
  box.dataset.loud = b.loud ? "true" : "false";

  /* ONE ROW, COLLAPSED, ALWAYS VISIBLE.
     The first build printed this as a bordered block with a paragraph of
     explanation and the payload open. Live, `_x.ai/queue/changed` alone fired
     three times in a single turn, each copy carrying the whole prompt text —
     so two amber blocks stood between the operator's question and the agent's
     answer, every turn. The requirement is that an unknown kind is VISIBLE and
     carries its payload (D35). It is not that it dominates the reading column.
     So: a flag, the type, and a fold. Everything else is inside the fold.
     (D84: the two known background kinds no longer take this path at all in
     the stream — they compress into one calm line via renderQuietGroup; a
     LOUD row never does.) */
  const row = el("button", "fold t-caption");
  row.appendChild(el("span", "fold-caret", b.expanded ? "▾" : "▸"));
  const flag = el("span", "u-flag t-caption", b.loud ? "WIRE PROBLEM" : "UNHANDLED EVENT");
  row.appendChild(flag);
  row.appendChild(el("span", "t-mono-sm", b.type));
  if (b.replay) row.appendChild(el("span", "dimr", "from history"));
  row.setAttribute("aria-expanded", String(!!b.expanded));
  row.onclick = () => { b.expanded = !b.expanded; renderCanvas(); };
  box.appendChild(row);

  const body = el("div", "fold-body");
  body.hidden = !b.expanded;
  unhandledFoldBody(body, b);
  box.appendChild(body);
  return box;
}

/* ── THE BLOCKING-INTERACTION CARDS (WP6) ─────────────────────────────────

   The three moments the agent stops and waits, inline in the stream at the
   point they arrived — spec §1's full-width interrupt, never a modal. The
   card is the surface: the drawer no longer auto-opens (D54).

   The rules every card obeys:
   · Every agent string is text (el()/textNode/pre — D31). The one rendered
     grammar is D44's, on planContent only.
   · Nothing is invented: permission buttons are the agent's own labels
     verbatim; the plan card's words are OURS because the protocol sends
     none; question options are the agent's labels.
   · Buttons disable during the POST and re-enable on failure, and failure
     is SAID: "Not sent…. Try again." (D54 — the bridge's permanently-dead
     buttons are the shortcut this card does not copy.)
   · The seal narrates the user's own act, never the agent's receipt — the
     answered event, not the HTTP ack, is what seals (rule 1).
   ─────────────────────────────────────────────────────────────────────── */

function renderInteractionCard(v, b) {
  /* `sent` locks the card between a successful POST and the answered event —
     the answer is gone, so nothing here may be clicked again. */
  const open = !b.resolved && !b.replay && !b.sent;
  const box = el("div", "icard");
  box.dataset.ikind = b.ikind;
  box.dataset.replay = String(b.replay);
  box.dataset.open = String(open);
  if (open) box.dataset.interrupt = "true";

  const header =
    b.ikind === "plan" ? "Plan approval required"
    : b.ikind === "question" ? "Questions from the agent"
    : b.ikind === "permission" ? "Permission required"
    : "A request this build cannot answer";
  const head = el("div", "icard-head");
  head.appendChild(el("span", "t-title", header));
  if (b.replay) head.appendChild(el("span", "t-caption dimr", "from history"));
  box.appendChild(head);

  if (b.ikind === "permission") renderPermissionBody(box, v, b, open);
  else if (b.ikind === "plan") renderPlanBody(box, v, b, open);
  else if (b.ikind === "question") renderQuestionBody(box, v, b, open);
  else {
    box.appendChild(el("p", "t-body dim",
      "The agent sent a request this build does not implement"
      + (b.method ? " ('" + esc(b.method) + "')" : "") + ". There is nothing here to answer."));
    appendRawFold(box, b, "raw request JSON");
  }

  if (b.error) box.appendChild(el("p", "icard-error t-caption", b.error));
  if (b.sent && !b.resolved) {
    box.appendChild(el("p", "t-caption dim",
      "Your answer was sent. Waiting for the agent to confirm it."));
  }
  if (b.resolved) box.appendChild(renderInteractionSeal(b));
  return box;
}

/* One button per entry of the agent's own options array, labelled with each
   option's `name` VERBATIM and answered by its optionId. The read-only
   marker mirrors the field (D57): three states, no interpretation. */
function renderPermissionBody(box, v, b, open) {
  const row = el("div", "tool-row");
  row.appendChild(el("span", "tool-label t-med",
    (b.tool && (b.tool.label || b.tool.name)) || "tool"));
  row.appendChild(roMarker(b.tool ? b.tool.readOnly : null));
  box.appendChild(row);

  if (b.title) box.appendChild(el("p", "t-body", b.title));
  appendRawFold(box, b, "the exact input");

  const actions = el("div", "icard-actions");
  for (const opt of b.options) {
    const col = el("div", "icard-action");
    const btn = el("button", "btn", esc(opt && opt.name));
    /* D83: prominence follows the option's wire `kind` — runtime data, never
       the label text (rule 2) and never the order (the agent's array order is
       kept). The per-action approval (allow_once) is the card's primary
       control; the session-wide one (allow_always) quiets to ghost; reject
       kinds and anything unknown keep the default styling. */
    if (opt && opt.kind === "allow_once") btn.dataset.variant = "primary";
    else if (opt && opt.kind === "allow_always") btn.dataset.variant = "ghost";
    btn.disabled = !open || b.sending;
    btn.onclick = () => sendInteractionAnswer(v, b, { optionId: opt.optionId });
    col.appendChild(btn);
    actions.appendChild(col);
  }
  if (!b.options.length) {
    /* Unreachable live — the server refuses empty options before any card
       exists — but a card with no buttons must say so rather than hang. */
    actions.appendChild(el("p", "t-body dim",
      "The agent offered no options, so there is nothing to click."));
  }
  if (open || b.sending) box.appendChild(actions);
}

/* The one card whose button labels are OURS (D54): the protocol sends three
   outcome values and no words. planContent renders through D44's grammar. */
function renderPlanBody(box, v, b, open) {
  const showBody = !b.resolved || !b.planFolded;
  if (b.resolved) {
    /* Sealed: the plan is a receipt, not a focus — it folds (D54/Kimi 9).
       An OPEN card never folds the thing being approved. */
    const tog = el("button", "fold t-caption");
    tog.appendChild(el("span", "fold-caret", b.planFolded ? "▸" : "▾"));
    tog.appendChild(el("span", "", b.planFolded ? "Show the plan" : "Hide the plan"));
    tog.setAttribute("aria-expanded", String(!b.planFolded));
    tog.onclick = () => { b.planFolded = !b.planFolded; renderCanvas(); };
    box.appendChild(tog);
  }
  if (showBody) {
    box.appendChild(
      typeof b.planContent === "string" && b.planContent.trim() !== ""
        ? renderPlanMarkdown(b.planContent)
        : el("p", "t-body dim", "The agent sent no plan content."),
    );
  }
  if (!open && !b.sending) return;

  const actions = el("div", "icard-actions");

  const approve = el("div", "icard-action");
  const ab = el("button", "btn", "Approve plan");
  ab.disabled = b.sending;
  ab.onclick = () => sendInteractionAnswer(v, b, { optionId: "approved" });
  approve.appendChild(ab);
  actions.appendChild(approve);

  const request = el("div", "icard-action");
  const rb = el("button", "btn", "Request changes");
  rb.disabled = b.sending;
  rb.setAttribute("aria-expanded", String(!!b.feedbackOpen));
  /* A toggle (Kimi 11): a second click collapses the box, text preserved.
     Text typed and then abandoned by approving is simply not sent. */
  rb.onclick = () => { b.feedbackOpen = !b.feedbackOpen; renderCanvas(); };
  request.appendChild(rb);
  actions.appendChild(request);

  const quit = el("div", "icard-action");
  const qb = el("button", "btn", "Quit plan mode");
  qb.disabled = b.sending;
  qb.onclick = () => sendInteractionAnswer(v, b, { optionId: "abandoned" });
  quit.appendChild(qb);
  quit.appendChild(el("div", "t-caption dim", "Abandons this plan and turns plan mode off."));
  actions.appendChild(quit);

  box.appendChild(actions);

  if (b.feedbackOpen) {
    const wrap = el("div", "icard-feedback");
    const ta = document.createElement("textarea");
    ta.className = "input icard-textarea";
    ta.rows = 3;
    ta.placeholder = "Tell the agent what to change in the plan.";
    ta.value = b.feedbackText;
    /* Mirror on input, never re-render on input: the canvas is wiped on
       every paint, and this mirror is what puts the text back (§0 hazard). */
    ta.oninput = () => { b.feedbackText = ta.value; };
    wrap.appendChild(ta);
    const send = el("button", "btn", "Send changes back");
    send.disabled = b.sending;
    send.onclick = () =>
      sendInteractionAnswer(v, b, { optionId: "cancelled", feedback: b.feedbackText });
    wrap.appendChild(send);
    wrap.appendChild(el("div", "t-caption dim",
      "Your note goes back to the agent. Plan mode stays on."));
    box.appendChild(wrap);
  }
}

/* The question card. Control grammar pinned (D54/Kimi 6): action buttons
   only on a single-question single-select card (answers on click, permission
   muscle-memory); radio rows only when a "Send answers" step exists;
   checkboxes only for multiSelect. */
function renderQuestionBody(box, v, b, open) {
  const clickToAnswer =
    b.questions.length === 1 && b.questions[0] && b.questions[0].multiSelect !== true;

  b.questions.forEach((q, qi) => {
    const sect = el("div", "q-section");
    sect.appendChild(el("div", "t-med", esc(q && q.question)));
    const opts = Array.isArray(q && q.options) ? q.options : [];

    if (clickToAnswer) {
      const actions = el("div", "icard-actions");
      for (const opt of opts) {
        const col = el("div", "icard-action");
        const btn = el("button", "btn", esc(opt && opt.label));
        btn.disabled = !open || b.sending;
        btn.onclick = () => {
          const answers = Object.create(null);
          answers[String(q.question)] = [String(opt.label)];
          sendInteractionAnswer(v, b, { outcome: "accepted", answers });
        };
        col.appendChild(btn);
        if (opt && opt.description) col.appendChild(el("div", "t-caption dim", opt.description));
        appendPreviewFold(col, b, qi, opts.indexOf(opt), opt);
        actions.appendChild(col);
      }
      sect.appendChild(actions);
    } else {
      const qKey = String(q && q.question);
      opts.forEach((opt, oi) => {
        const row = el("label", "q-row");
        const inp = document.createElement("input");
        inp.type = q && q.multiSelect === true ? "checkbox" : "radio";
        /* Grouping name from OUR key and index — never from agent content. */
        inp.name = b.key + "-q" + qi;
        inp.disabled = !open || b.sending;
        /* A resolved card shows no ticks. On "Closed without answering" the
           selections were discarded, and a ticked box reads as submitted —
           the seal says one thing and the boxes would say another (D54). */
        const picked = !b.resolved && Array.isArray(b.picks[qKey]) ? b.picks[qKey] : [];
        inp.checked = picked.includes(String(opt && opt.label));
        inp.onchange = () => {
          const label = String(opt && opt.label);
          if (q.multiSelect === true) {
            const set = new Set(Array.isArray(b.picks[qKey]) ? b.picks[qKey] : []);
            if (inp.checked) set.add(label); else set.delete(label);
            b.picks[qKey] = [...set];
          } else {
            b.picks[qKey] = [label];
          }
          renderCanvas(); /* safe here: no free-typing input on this card */
        };
        row.appendChild(inp);
        const text = el("span", "q-opt");
        text.appendChild(el("span", "t-body", esc(opt && opt.label)));
        if (opt && opt.description) text.appendChild(el("span", "t-caption dim", opt.description));
        row.appendChild(text);
        sect.appendChild(row);
        appendPreviewFold(sect, b, qi, oi, opt);
      });
    }
    box.appendChild(sect);
  });

  if (!open && !b.sending) return;

  const actions = el("div", "icard-actions");
  if (!clickToAnswer) {
    const n = b.questions.length;
    const answered = b.questions.every((q) => {
      const picked = b.picks[String(q && q.question)];
      return Array.isArray(picked) && picked.length > 0;
    });
    const col = el("div", "icard-action");
    const send = el("button", "btn", "Send answers");
    send.disabled = !answered || b.sending;
    send.onclick = () => {
      const answers = Object.create(null);
      for (const q of b.questions) answers[String(q.question)] = b.picks[String(q.question)];
      sendInteractionAnswer(v, b, { outcome: "accepted", answers });
    };
    col.appendChild(send);
    if (!answered) {
      col.appendChild(el("div", "t-caption dim",
        "Answer all " + n + " question" + (n === 1 ? "" : "s") + " to send."));
    }
    actions.appendChild(col);
  }

  const closeCol = el("div", "icard-action");
  const close = el("button", "btn btn-sm", "Close without answering");
  close.disabled = b.sending;
  close.onclick = () => sendInteractionAnswer(v, b, { outcome: "cancelled" });
  closeCol.appendChild(close);
  actions.appendChild(closeCol);

  /* The two plan-mode-only outcomes ship DARK until a live capture proves
     their reply shapes (WP6 brief §3/§6) — two never-verified wire shapes do
     not get real buttons on the strength of a source read. */
  if (PLAN_MODE_QUESTION_OUTCOMES_PROVEN && b.mode === "plan") {
    for (const [label, outcome] of [
      ["Chat about this", "chat_about_this"],
      ["Skip interview and plan immediately", "skip_interview"],
    ]) {
      const col = el("div", "icard-action");
      const btn = el("button", "btn btn-sm", label);
      btn.disabled = b.sending;
      btn.onclick = () => sendInteractionAnswer(v, b, { outcome });
      col.appendChild(btn);
      actions.appendChild(col);
    }
  }
  box.appendChild(actions);
}

/* The seal: the user's own act — the one thing we know happened — never the
   agent's receipt (§2.5 discipline; the wording family is D54's). */
function renderInteractionSeal(b) {
  const r = b.resolved;
  const seal = el("div", "icard-seal");
  const line = (text) => seal.appendChild(el("div", "t-med", text));

  if (r.how === "abandoned") {
    line("Never answered.");
    seal.appendChild(el("p", "t-caption dim", r.note || ""));
    return seal;
  }
  if (r.how === "reconciled" || r.how === "stamped") {
    line(r.how === "stamped" ? "Resolved earlier in this session." : "No longer waiting.");
    if (r.note) seal.appendChild(el("p", "t-caption dim", r.note));
    return seal;
  }

  if (b.ikind === "permission") {
    const opt = b.options.find((o) => o && o.optionId === r.optionId) || null;
    line(r.how === "cancelled"
      ? "Cancelled without answering."
      : "You chose: " + esc(opt ? opt.name : r.optionId));
    return seal;
  }
  if (b.ikind === "plan") {
    if (r.optionId === "approved") line("You approved this plan.");
    else if (r.optionId === "abandoned") line("You quit plan mode — this plan was abandoned.");
    else if (r.feedback) {
      line("You sent the plan back with this note:");
      const note = el("div", "msg t-body");
      blockText(note, r.feedback);
      seal.appendChild(note);
    } else line("You sent the plan back.");
    return seal;
  }
  if (b.ikind === "question") {
    if (r.outcome === "accepted" && r.answers) {
      line("You answered:");
      for (const [q, a] of Object.entries(r.answers)) {
        seal.appendChild(el("p", "t-body dim",
          esc(q) + " — " + (Array.isArray(a) ? a.map(esc).join(", ") : esc(a))));
      }
    } else if (r.outcome === "cancelled" || r.how === "cancelled") {
      /* No discarded selections shown — displaying them would imply they
         were sent (D54/Kimi 7). */
      line("Closed without answering.");
    } else if (r.outcome) {
      line("Sent '" + esc(r.outcome) + "'.");
    } else line("Answered.");
    return seal;
  }
  line("Resolved.");
  return seal;
}

/* The three-state read-only marker, mirroring the field (D57): the agent
   declared it, declared it not, or did not say. No interpretation. */
function roMarker(readOnly) {
  const ro = el("span", "ro t-caption");
  if (readOnly === true) { ro.dataset.ro = "true"; ro.textContent = "Read-only"; ro.title = "The agent says this call only reads."; }
  else if (readOnly === false) { ro.dataset.ro = "false"; ro.textContent = "Not read-only"; ro.title = "The agent says this call is not read-only. That may mean writing files, running a command, or nothing at all — it is the agent's own declaration, mirrored."; }
  else { ro.dataset.ro = "unknown"; ro.textContent = "Read-only not stated"; ro.title = "The agent did not say whether this call is read-only. That is a third state, not a no — it is neither claimed safe nor claimed dangerous."; }
  return ro;
}

function appendRawFold(box, b, label) {
  if (b.rawInput === undefined || b.rawInput === null) return;
  const btn = el("button", "fold t-caption");
  btn.appendChild(el("span", "fold-caret", b.inputExpanded ? "▾" : "▸"));
  btn.appendChild(el("span", "", (b.inputExpanded ? "hide " : "show ") + label));
  btn.setAttribute("aria-expanded", String(!!b.inputExpanded));
  btn.onclick = () => { b.inputExpanded = !b.inputExpanded; renderCanvas(); };
  box.appendChild(btn);
  const body = el("div", "fold-body");
  body.hidden = !b.inputExpanded;
  body.appendChild(pre("raw",
    typeof b.rawInput === "string" ? b.rawInput : jsonText(b.rawInput)));
  box.appendChild(body);
}

/* An option's `preview`, folded text when present. SOURCE-only field — never
   yet seen on a live request — but if one arrives it renders as text. */
function appendPreviewFold(parent, b, qi, oi, opt) {
  if (!opt || typeof opt.preview !== "string" || opt.preview === "") return;
  const k = qi + ":" + oi;
  const btn = el("button", "fold t-caption");
  btn.appendChild(el("span", "fold-caret", b.previewOpen[k] ? "▾" : "▸"));
  btn.appendChild(el("span", "", "preview"));
  btn.setAttribute("aria-expanded", String(!!b.previewOpen[k]));
  btn.onclick = () => { b.previewOpen[k] = !b.previewOpen[k]; renderCanvas(); };
  parent.appendChild(btn);
  const body = el("div", "fold-body");
  body.hidden = !b.previewOpen[k];
  body.appendChild(pre("raw", opt.preview));
  parent.appendChild(body);
}

/* The POST. The card SEALS on the interaction.answered event, never on this
   ack — rule 1, and the seal narrates what the server says it sent.

   But a successful POST still locks the card. The event can be late or lost
   (the SSE stream and this fetch are different connections), and re-arming the
   buttons in that window would let the operator answer a second time: the
   first answer already reached the agent, so the second is refused with "no
   open interaction" and the operator walks away believing they refused a call
   they in fact allowed. So on success the card says, honestly, that the answer
   went and we are waiting for the agent to confirm. On failure — and only on
   failure — the buttons come back and the failure is said. */
async function sendInteractionAnswer(v, b, payload) {
  if (b.sending || b.sent || b.resolved) return;
  b.sending = true;
  b.error = null;
  renderCanvas();
  /* quiet: the card carries the sentence where the buttons are. But the
     highest-stakes action in the app also gets ONE durable Shell-log line
     with the details payload (Opus M4, round 2) — a card seals or is
     reconstructed away; the log is the record that stays. One failure, one
     card sentence, one log line. */
  const r = await post("/permission", { key: b.key, ...payload }, { quiet: true });
  b.sending = false;
  if (r && r.error) {
    b.error = "Not sent — " + esc(r.error) + ". Try again.";
    note("error", b.error, r.details);
  } else {
    b.sent = true;
  }
  renderCanvas();
}

/* ── THE DRAWER ───────────────────────────────────────────────────── */

function renderDrawer() {
  const d = $("drawerBody");
  d.textContent = "";
  if (drawerTab === "detail")  return renderDetailTab(d);
  if (drawerTab === "context") return renderContextTab(d);
  if (drawerTab === "agent")   return renderAgentTab(d);
  /* WP14 fix round (Grok F6): the Shell tab renders only in a dev build,
     however drawerTab got its value — the setTab guard alone left this
     fallthrough able to paint the dev surface (and its bridge link) in a
     public build. Anything else fails to Detail. */
  if (drawerTab === "shell" && DEV_BUILD) return renderShellTab(d);
  return renderDetailTab(d);
}

function renderDetailTab(d) {
  const rec = agent.sessions.find((s) => s.sessionId === activeId) || null;
  const row = roster.find((s) => s.sessionId === activeId) || null;
  if (!activeId) { d.appendChild(el("p", "t-caption dimr", "No session selected.")); return; }

  const pan = el("div", "panel");
  pan.appendChild(el("div", "t-med", "Session"));
  const tbl = el("table", "grid kv");
  const add = (k, val) => {
    const tr = el("tr");
    tr.appendChild(el("th", "", k));
    const td = el("td", "t-mono-sm");
    td.textContent = val == null || val === "" ? "—" : String(val);
    tr.appendChild(td);
    tbl.appendChild(tr);
  };
  add("id", activeId);
  add("cwd", (rec && rec.cwd) || (row && row.cwd));
  add("open here", rec ? "yes (" + rec.acquired + ")" : "no");
  add("activity", row ? (row.activity == null ? "not reported" : row.activity) : "not on the roster read");
  add("resident", row ? String(row.resident) : "—");
  add("worktree", row ? String(row.isWorktree) : "—");
  add("model", rec ? rec.modelId : row ? row.modelId : null);
  add("effort", rec ? rec.reasoningEffort : row ? row.reasoningEffort : null);
  add("confirmed mode", rec ? (rec.confirmedModeId === null ? "never confirmed" : rec.confirmedModeId) : null);
  add("turn running", rec ? String(rec.turnInFlight) : "—");
  add("events (live/replay)", rec ? rec.liveEvents + " / " + rec.replayedEvents : "—");
  pan.appendChild(tbl);
  d.appendChild(pan);

  /* Tool detail is NOT a stub any more, and it is not in this drawer either.
     Spec §1 offers "right drawer OR expand-in-place" for tool details, and WP5
     took expand-in-place: the exact arguments belong next to the call they
     belong to, not one click away in a panel that has lost the thread. This
     panel says where they went rather than sitting here empty. */
  const tp = el("div", "panel");
  tp.appendChild(el("div", "t-med", "Tool detail"));
  const v = view(activeId);
  const calls = v ? v.turns.reduce((n, t) => n + t.items.filter((i) => i.kind === "tool").length, 0) : 0;
  tp.appendChild(el("p", "t-caption dim", calls === 0
    ? "No tools called in this turn."
    : calls + (calls === 1 ? " tool call" : " tool calls") + " in this conversation. The exact arguments and the result are on each "
      + "card in the stream — spec §1 allows either this drawer or expand-in-place, and the "
      + "arguments are only useful beside the call they belong to."));
  d.appendChild(tp);

  d.appendChild(renderChangesPanel(activeId));
  /* The WP6 "Plan" stub is gone: the plan card lives in the stream (D54),
     with the D44 renderer, the feedback box and all three actions on it. */
}

/* ── WP11: CHANGES, AND UNDO ──────────────────────────────────────────────
   The changed-file list with real +N/−M, per-hunk before/after, and
   agent-versus-you attribution — all from the LIVE reading, never from
   history (F14: attribution dies after a crash+reload, so these words are
   only ever about what the tracker reports right now). Three actions and
   only three: Undo this change (per agent hunk), Looks good (per file), and
   Undo everything from this turn (in the turn foot). No git operation
   exists anywhere in here — a reject rewrites the file to its pre-edit
   baseline and nothing more (D25).

   Refresh discipline (F7/F8): the tracker pushes NOTHING, so the pane
   re-reads on a live turn.completed, on the drawer opening here, on
   selecting a session while the drawer sits open here (M3), and once
   ~3s after our own action (the rescan lag makes an immediate re-read
   able to see stale state). Never on an interval against an idle page. */

/* Two shapes arrive here: the route's full reading (summary.turns with
   pendingHunks arrays) and the bridge digest (turns with counts only). Both
   normalise to the same turn digest — the page never retains hunk text from
   a reading, which is also what keeps the SSE copies small (Opus I3). The
   Ok flags carry the server's "could not read" through to the pane (Codex 3):
   filesOk false must never render as "No unreviewed changes". */
function normalizeChanges(reading) {
  let turns = null;
  /* Hunk ids ride in the digest (Codex 2, confirm round): two readings with
     identical counts but different hunk ids are DIFFERENT readings — the
     signature below must see that, or a stale lazy-hunks response can
     survive a real change. */
  const idsOf = (t) =>
    (Array.isArray(t?.hunkIds) ? t.hunkIds
      : Array.isArray(t?.pendingHunks) ? t.pendingHunks.map((h) => h && h.id) : [])
      .filter((id) => typeof id === "string").sort();
  if (Array.isArray(reading.turns)) {
    turns = reading.turns.map((t) => ({
      promptIndex: t ? t.promptIndex : null,
      pending: typeof t?.pending === "number" ? t.pending : (Array.isArray(t?.pendingHunks) ? t.pendingHunks.length : 0),
      hunkIds: idsOf(t),
    }));
  } else if (reading.summary && Array.isArray(reading.summary.turns)) {
    turns = reading.summary.turns.map((t) => ({
      promptIndex: t ? t.promptIndex : null,
      pending: Array.isArray(t?.pendingHunks) ? t.pendingHunks.length : 0,
      hunkIds: idsOf(t),
    }));
  }
  return {
    files: Array.isArray(reading.files) ? reading.files : [],
    turns,
    /* External/unattributed hunk ids (Codex, final round): they live outside
       summary.turns, and without them two readings that differ only in an
       external hunk would collide in the signature and show stale text.
       null = the server flagged the read as failed, and a null signature
       component must never no-op (below). */
    externalIds: Array.isArray(reading.externalIds) ? [...reading.externalIds].sort() : null,
    /* WP12 F2: the tracker-suspect annotation and its git cross-check. */
    suspect: reading.suspect === true,
    gitDirty: typeof reading.gitDirty === "boolean" ? reading.gitDirty : null,
    filesOk: reading.filesOk !== false && Array.isArray(reading.files),
    summaryOk: reading.summaryOk !== false && turns !== null,
  };
}

function changesSignature(norm) {
  return JSON.stringify({
    f: norm.files.map((f) => [f && f.path, f && f.hunkCount, f && f.additions, f && f.deletions, f && f.isAgentFile]),
    t: norm.turns,
    x: norm.externalIds,
    ok: [norm.filesOk, norm.summaryOk],
    /* WP12 F2: the suspect annotation and cross-check verdict move the
       signature too — a gitDirty flip must repaint the pane's sentence. */
    f2: [norm.suspect, norm.gitDirty],
  });
}

/* Returns true when the reading actually changed something. The acting
   window hears its own poll again on SSE (M4): an identical reading is a
   no-op — crucially it does NOT wipe the hunks cache, so an expanded file
   is not bounced back to "Reading the changes…" by its own refresh. */
function applyChangesReading(sessionId, reading) {
  const v = view(sessionId);
  if (!v) return false;
  const norm = normalizeChanges(reading);
  const sig = changesSignature(norm);
  /* An unreadable external-hunk read (externalIds null) must never no-op:
     treat it as changed so the pane re-fetches rather than trusting a sig
     that is missing a component. */
  if (v.changes && v.changes.sig === sig && norm.externalIds !== null && v.changes.externalIds !== null) return false;
  v.changes = { at: Date.now(), ...norm, sig, error: null };
  /* A new reading can invalidate cached hunks (an undo just rewrote one), so
     expanded files re-read lazily on the next paint. Both armed confirms die
     with it — hunk-level here, turn-level below (M2): the confirm sentence
     must never outlive the state it describes. */
  v.changesUi.hunks = Object.create(null);
  v.changesUi.armedHunk = null;
  for (const t of v.turns) t.undoArmed = false;
  return true;
}

function refreshChanges(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return Promise.resolve();
  return post("/changes", { sessionId }, { quiet: true }).then((r) => {
    if (r && !r.error && Array.isArray(r.files)) {
      applyChangesReading(sessionId, r);
    } else {
      /* A failed read is NOT an empty list — the pane must say "could not be
         read", never "No unreviewed changes" (rule 1's silent-empty trap). */
      const v = view(sessionId);
      if (v) v.changes = { at: Date.now(), files: [], turns: null, filesOk: false, summaryOk: false, sig: null, error: (r && r.error) || "no answer from the server" };
    }
    if (activeId === sessionId && $("app").dataset.drawer === "open" && drawerTab === "detail") renderDrawer();
    scheduleCanvas();
  });
}

/* One delayed re-read after our own undo/accept. F8: the tracker's rescan
   lag means a read taken the millisecond after a disk write can be stale.
   The timer exists only because an action just ran — never an idle interval. */
const changesRefreshTimers = new Map();  /* sessionId -> timeout */
function scheduleChangesRefresh(sessionId) {
  const prev = changesRefreshTimers.get(sessionId);
  if (prev) clearTimeout(prev);
  changesRefreshTimers.set(sessionId, setTimeout(() => {
    changesRefreshTimers.delete(sessionId);
    refreshChanges(sessionId);
  }, 3000));
}

/* True while changes actions must not fire for this session: a turn is
   running — here, or on ANOTHER session open in the same folder (Opus N1:
   two sessions can share a cwd, and a turn there writes the same files) —
   and, failing closed, whenever the turn state is UNKNOWN (no held record
   read back). The folder comparison here is string equality, a UX hint
   only: the SERVER is the enforcer, and it compares canonical (realpath)
   folders, so a symlink alias is refused there even if this hint misses it. */
function changesLocked(sessionId) {
  const rec = agent.sessions.find((s) => s.sessionId === sessionId) || null;
  if (!rec || rec.turnInFlight !== false) return true;
  return agent.sessions.some((s) =>
    s.sessionId !== sessionId && s.cwd && s.cwd === rec.cwd && s.turnInFlight === true);
}

/* The shared ending for all three actions: the verdict note comes from the
   ROUTE'S reply (the SSE bridge.change_acted applies its reading quietly, so
   the acting window never sees the sentence twice — the commands_listed
   precedent). The sentence is single-minded about the disk (Opus N2): a 400
   is a pre-wire refusal, and a 500 carrying the server's notSent marker is
   provably pre-wire too — both earn "Nothing was changed". Only a 500
   WITHOUT the marker gets the conditional clause, because that is the one
   shape where the action may have fired and the re-read died (postSend makes
   that the structural distinction, not a wording accident). */
function finishChangeAction(sessionId, r, verb) {
  const v = view(sessionId);
  if (v) v.changesUi.busy = false;
  if (!r || r.error) {
    const refused = !!(r && (r.httpStatus === 400 || r.notSent === true));
    note("error", verb + " — " + ((r && r.error) || "no answer from the server") +
      (refused
        ? " Nothing was changed. Try again."
        : " If the action had already been sent, its result could not be verified — the pane is re-reading now; check before retrying."),
      r && r.details);
    refreshChanges(sessionId);
  } else {
    note(r.changed ? "info" : "error", typeof r.note === "string" && r.note ? r.note : "No verdict came back — the next reading is the evidence.");
    if (r.reading) {
      applyChangesReading(sessionId, r.reading);
      scheduleChangesRefresh(sessionId);
    }
  }
  if (activeId === sessionId && $("app").dataset.drawer === "open" && drawerTab === "detail") renderDrawer();
  scheduleCanvas();
}

async function undoHunk(sessionId, hunkId) {
  const v = view(sessionId);
  if (!v || v.changesUi.busy) return;
  v.changesUi.busy = true;
  v.changesUi.armedHunk = null;
  renderDrawer();
  const r = await post("/changes/hunk-action", { sessionId, hunkId }, { quiet: true });
  finishChangeAction(sessionId, r, "Not undone");
}

async function acceptFile(sessionId, path, hunkIds) {
  const v = view(sessionId);
  if (!v || v.changesUi.busy) return;
  v.changesUi.busy = true;
  renderDrawer();
  /* hunkIds bind the accept to the hunks the operator actually saw; the
     server re-reads them and refuses a mismatch (Codex 5). */
  const r = await post("/changes/file-action", { sessionId, path, hunkIds }, { quiet: true });
  finishChangeAction(sessionId, r, "Not marked");
}

async function undoTurn(sessionId, promptIndex, t) {
  const v = view(sessionId);
  /* One session-level lock for all three actions (Grok I6): the turn foot
     and the pane never run two of them concurrently. */
  if (!v || v.changesUi.busy) return;
  v.changesUi.busy = true;
  t.undoBusy = true;
  renderCanvas();
  const r = await post("/changes/turn-action", { sessionId, promptIndex }, { quiet: true });
  t.undoBusy = false;
  t.undoArmed = false;
  finishChangeAction(sessionId, r, "Not undone");
}

function renderChangesPanel(sessionId) {
  const pan = el("div", "panel");
  pan.appendChild(el("div", "t-med", "File changes"));
  const v = view(sessionId);
  const reading = v ? v.changes : null;
  if (!reading) {
    pan.appendChild(el("p", "t-caption dim",
      "Not read yet in this window. This panel re-reads when a turn ends and each time the drawer "
      + "opens here — the agent sends no change notifications on its own."));
    return pan;
  }
  if (reading.error) {
    pan.appendChild(el("p", "t-caption dim", "Could not be read — " + reading.error + ". This is not a reading of zero."));
    return pan;
  }
  if (reading.filesOk === false) {
    /* Codex 3: a reply with no files list is a read failure. The empty state
       below is earned only by a positively-read empty list. */
    pan.appendChild(el("p", "t-caption dim",
      "Could not be read — the agent's reply had no changed-file list in it. This is not a reading of zero."));
    return pan;
  }
  if (reading.files.length === 0) {
    /* WP12 F2: a tracker-suspect session (its turn was in flight when the
       agent died) can report empty over a dirty tree. The qualified sentence
       stands whenever the git cross-check has not positively said CLEAN —
       dirty, unreadable, or not yet taken all read the same way; only a
       positively-clean cross-check earns the plain sentence. */
    if (reading.suspect === true && reading.gitDirty !== false) {
      pan.appendChild(el("p", "t-caption dim",
        reading.gitDirty === true
          ? "Changes exist in this folder, but they may not be tracked for this recovered session. Start a fresh session here before relying on change review or undo."
          : "This session was mid-turn when the agent died, so its change tracking may be blind, and the folder check could not settle it either way. Start a fresh session here before relying on change review or undo."));
      return pan;
    }
    pan.appendChild(el("p", "t-caption dim", "No unreviewed changes."));
    return pan;
  }
  if (reading.summaryOk === false) {
    /* Opus F4: a half-readable reading is SAID. Without this line the file
       list renders normally while every turn foot silently lacks its undo —
       readable as "nothing pending for those turns", which is not what the
       reading said. */
    pan.appendChild(el("p", "t-caption dim",
      "The per-turn summary could not be read, so turn-level undo is unavailable for this reading. "
      + "The file list below was read successfully."));
  }
  for (const f of reading.files) {
    if (f && typeof f.path === "string") pan.appendChild(renderChangeFile(sessionId, v, f));
  }
  return pan;
}

function renderChangeFile(sessionId, v, f) {
  const ui = v.changesUi;
  const path = f.path;
  const expanded = ui.expanded[path] === true;
  const box = el("div", "chg-file");

  const head = el("button", "chg-file-head");
  head.setAttribute("aria-expanded", String(expanded));
  head.appendChild(el("span", "fold-caret", expanded ? "▾" : "▸"));
  /* The path is agent/tracker text: textContent, and NOWHERE else — not even
     a title attribute (Codex 7; D31's text-only boundary). */
  head.appendChild(el("span", "chg-path t-mono-sm", path));
  /* +N/−M, printed only when the reading reported them — never invented zeros. */
  const stat = el("span", "chg-stat t-mono-sm");
  if (typeof f.additions === "number") stat.appendChild(el("span", "chg-add", "+" + f.additions));
  if (typeof f.deletions === "number") stat.appendChild(el("span", "chg-del", "−" + f.deletions));
  head.appendChild(stat);
  /* Attribution wording (review round 1, all three reviewers): isAgentFile
     false does NOT mean "you wrote this" — the tracker re-admits agent-authored
     dirty files with isAgentFile:false (evidence wp11/11, the
     externalEditOnAgentFile rescan). Say the weaker true thing. */
  head.appendChild(el("span", "chg-who t-caption",
    f.isAgentFile === true ? "agent" : f.isAgentFile === false ? "not attributed to the agent" : ""));
  head.onclick = () => { ui.expanded[path] = !expanded; renderDrawer(); };
  box.appendChild(head);

  if (expanded) box.appendChild(renderChangeFileBody(sessionId, v, path, f.isAgentFile === true));
  return box;
}

function renderChangeFileBody(sessionId, v, path, isAgentFile) {
  const ui = v.changesUi;
  const body = el("div", "chg-file-body");
  const cached = ui.hunks[path];
  if (!cached) {
    /* Lazy read, triggered once per expand. The path is absolute by
       construction — it came out of the tracker's own get-files list. The
       reading's sig is captured so a response that lands AFTER a newer
       reading (the ~3s delayed re-read after an undo) is dropped instead of
       repopulating the cache with superseded hunks (Opus F6). */
    const sigAtRead = v.changes ? v.changes.sig : null;
    ui.hunks[path] = { loading: true, sig: sigAtRead, error: null, hunks: null };
    post("/changes/hunks", { sessionId, path }, { quiet: true }).then((r) => {
      if ((v.changes ? v.changes.sig : null) !== sigAtRead) {
        /* Stale before it landed: forget it — but only OUR placeholder. A
           newer read's in-flight placeholder carries its own sig and must
           not be deleted from under it (Opus N6). */
        const slot = ui.hunks[path];
        if (slot && slot.loading && slot.sig === sigAtRead) delete ui.hunks[path];
        if (activeId === sessionId && $("app").dataset.drawer === "open" && drawerTab === "detail") renderDrawer();
        return;
      }
      ui.hunks[path] = r && !r.error && Array.isArray(r.hunks) && r.hunksOk !== false
        ? { loading: false, sig: sigAtRead, error: null, hunks: r.hunks }
        : { loading: false, sig: sigAtRead, error: (r && r.error) || "the agent's reply had no change list in it", hunks: null };
      if (activeId === sessionId && $("app").dataset.drawer === "open" && drawerTab === "detail") renderDrawer();
    });
    body.appendChild(el("p", "t-caption dim", "Reading the changes…"));
    return body;
  }
  if (cached.loading) { body.appendChild(el("p", "t-caption dim", "Reading the changes…")); return body; }
  if (cached.error) {
    body.appendChild(el("p", "t-caption dim", "Could not read the changes — " + cached.error));
    return body;
  }
  if (cached.hunks.length === 0) {
    /* No hunks, no review action (Opus F2): a Looks good here would send an
       empty hunkIds digest, which an unreadable re-read could spuriously
       match. Nothing to review renders as exactly that. */
    body.appendChild(el("p", "t-caption dim", "No pending changes reported for this file."));
    return body;
  }
  for (const h of cached.hunks) body.appendChild(renderHunk(sessionId, v, h, isAgentFile));
  /* Looks good — the safe direction, so it acts immediately (D63). The content
     stays on disk exactly as it is; accept never stages (F11). The click sends
     the ids of the hunks on screen; the server refuses if they no longer match
     (Codex 5). Mid-turn it is locked with everything else (Codex 2). */
  const locked = changesLocked(sessionId);
  const ok = el("button", "btn btn-sm", "Looks good");
  ok.title = locked
    ? "Unavailable while a turn is running — the file may still be changing."
    : "Mark this file as reviewed. The content stays on disk exactly as it is — nothing is staged.";
  ok.disabled = ui.busy || locked;
  ok.onclick = () => acceptFile(sessionId, path, cached.hunks.map((h) => h && h.id).filter((id) => typeof id === "string"));
  body.appendChild(ok);
  return body;
}

function renderHunk(sessionId, v, h, fileIsAgentFile) {
  const box = el("div", "chg-hunk");
  const sourceType = h && h.source && typeof h.source.type === "string" ? h.source.type : null;
  /* Attribution per hunk, from the live source field — the only wording F14
     allows, softened after review round 1: "you" is said ONLY for
     source:"external" on a file the tracker does not class as the agent's.
     Everything else — externalEditOnAgentFile (evidence wp11/11), external on
     an agent file, an unknown type — is "not attributed to the agent". Every
     string here reaches the DOM as text only (D31); the before/after
     colouring is CSS classes on the two pre blocks, never injected markup. */
  const whose =
    sourceType === "agentEdit" ? "the agent wrote this"
    : sourceType === "external" && !fileIsAgentFile ? "you wrote this"
    : "not attributed to the agent";
  box.appendChild(el("div", "t-caption dim", whose));
  box.appendChild(pre("chg-pre chg-old", typeof h.oldText === "string" && h.oldText !== "" ? h.oldText : "(nothing here before)"));
  box.appendChild(pre("chg-pre chg-new", typeof h.newText === "string" && h.newText !== "" ? h.newText : "(nothing here after)"));
  if (sourceType !== "agentEdit") {
    /* The director's GO (WP11 brief header): human-edit rows are DISPLAY-ONLY in v1,
       and an unattributed hunk is not claimed as the agent's either. No undo
       is offered on either, even if the wire would allow it — an honest
       line, not a dead button. */
    box.appendChild(el("div", "t-caption dim", sourceType === "external" && !fileIsAgentFile
      ? "Your own edit — undo is only available for agent changes."
      : "Undo is only available for changes the tracker attributes to the agent."));
    return box;
  }
  const ui = v.changesUi;
  const id = typeof h.id === "string" ? h.id : "";
  const locked = changesLocked(sessionId);
  if (ui.armedHunk !== id) {
    /* Undo writes disk, so it confirms once (D62/D63's model): first click
       arms, second acts. */
    const b = el("button", "btn btn-sm", "Undo this change");
    b.title = locked
      ? "Unavailable while a turn is running — the file may still be changing."
      : "Rewrite this file so this change never happened.";
    b.disabled = ui.busy || locked;
    b.onclick = () => { ui.armedHunk = id; renderDrawer(); };
    box.appendChild(b);
  } else {
    box.appendChild(el("div", "t-caption dim",
      "This rewrites the file on disk. Your own edits to other files are not touched."));
    const row = el("div", "chg-confirm");
    const go = el("button", "btn btn-sm", "Undo it");
    go.dataset.variant = "danger";
    /* The armed confirm honours the mid-turn lock too (Grok R2-M2): arming
       while idle does not grandfather a click past a turn that has started. */
    go.disabled = ui.busy || locked;
    go.onclick = () => undoHunk(sessionId, id);
    const keep = el("button", "btn btn-sm", "Keep it");
    keep.dataset.variant = "ghost";
    keep.onclick = () => { ui.armedHunk = null; renderDrawer(); };
    row.appendChild(keep);
    row.appendChild(go);
    box.appendChild(row);
  }
  return box;
}

/* The turn foot's undo: the reading's entry for THIS turn, or null.
   The binding is the turn's WIRE promptIndex, stamped by the agent on its
   echo of the user's message (user_message_chunk _meta.promptIndex — B1);
   ordinal arithmetic is never used, because the page's turn counter drifts
   after a truncated reconstruction while the tracker's does not. A turn
   with no stamp (older history, anything before an agent restart —
   bridge.agent_gone clears them) gets no button: fail closed. The server
   independently refuses any index its tracker lifetime never reported.
   Mid-turn there is no button either — undoing into a turn that is still
   writing would race the agent (Codex 2). */
function changesEntryForTurn(v, t) {
  if (!v || !v.changes || t.n == null || t.aside) return null;
  if (t.outcome === "running") return null;
  if (typeof t.promptIndex !== "number") return null;
  const turns = v.changes.turns;
  if (!Array.isArray(turns)) return null;
  const e = turns.find((x) => x && x.promptIndex === t.promptIndex);
  return e && e.pending > 0 ? e : null;
}

function renderContextTab(d) {
  const v = view(activeId);
  const ctx = ctxOf(v);
  if (!activeId) { d.appendChild(el("p", "t-caption dimr", "No session selected.")); return; }
  if (!ctx) {
    const pan = el("div", "panel");
    pan.appendChild(el("div", "t-med", "Context window"));
    pan.appendChild(el("p", "t-caption dim",
      v.contextRefused
        ? v.contextRefused
        : "No reading yet. The server reads session/info after every turn; nothing has been read for this session in this window. This is not a reading of zero."));
    d.appendChild(pan);
    return;
  }

  const seg = segmentsOf(ctx);
  const pan = el("div", "panel");
  pan.appendChild(el("div", "t-med", "Context window"));
  if (seg && seg.partial) {
    pan.appendChild(el("p", "t-caption dim",
      "Breakdown not available yet — this reading carries only the totals, so the bar is one segment."));
  }
  const tbl = el("table", "grid");
  const head = el("tr");
  head.appendChild(el("th", "", ""));
  head.appendChild(el("th", "", "segment"));
  head.appendChild(el("th", "num", "tokens"));
  head.appendChild(el("th", "num", "%"));
  tbl.appendChild(head);
  for (const s of (seg ? seg.list : [])) {
    const tr = el("tr");
    const sw = el("td");
    const chip = el("span", "swatch");
    chip.style.background = "var(" + s.tone + ")";
    if (s.tone === "--ctx-free") chip.style.border = "1px solid var(--border-default)";
    sw.appendChild(chip);
    tr.appendChild(sw);
    tr.appendChild(el("td", "t-caption", s.label));
    tr.appendChild(el("td", "num", s.tokens.toLocaleString()));
    tr.appendChild(el("td", "num", Math.min(100, Math.round((s.tokens / seg.total) * 100)) + "%"));
    tbl.appendChild(tr);
  }
  pan.appendChild(tbl);

  const tot = el("p", "t-mono-sm");
  tot.style.marginTop = "8px";
  tot.textContent = (num(ctx.used) || 0).toLocaleString() + " / " + (num(ctx.total) || 0).toLocaleString();
  pan.appendChild(tot);
  const t = num(ctx.autoCompactThresholdPercent);
  pan.appendChild(el("p", "t-caption dim",
    t === null ? "The agent did not report an auto-compact threshold." : "Compacts automatically at " + t + "%"));
  d.appendChild(pan);

  /* Informational rows. Never segments — they overlap what is already in
     the bar. Tool definitions first, then one row per usageCategories
     entry in the order received, rendering the agent's own label, tokens
     and detail verbatim. There is no name matching anywhere in here: a
     category this build has never heard of appears with no code change. */
  const info = el("div", "panel");
  info.appendChild(el("div", "t-med", "Already counted above"));
  info.appendChild(el("p", "t-caption dim",
    "These overlap the bar's segments — the agent's own code says so. They are listed, never stacked; "
    + "adding them as a fifth slice would overstate how full the context is."));
  const it = el("table", "grid");
  const infoRow = (label, tokens, detail) => {
    const tr = el("tr");
    const sw = el("td");
    const chip = el("span", "swatch");
    chip.style.background = "var(--ctx-info-row)";
    sw.appendChild(chip);
    tr.appendChild(sw);
    const l = el("td", "t-caption");
    l.textContent = label;
    if (detail) { l.appendChild(document.createElement("br")); l.appendChild(el("span", "t-caption dimr", detail)); }
    tr.appendChild(l);
    tr.appendChild(el("td", "num", tokens == null ? "—" : Number(tokens).toLocaleString()));
    it.appendChild(tr);
  };
  const tdCount = num(ctx.toolDefinitionsCount);
  infoRow("Tool definitions", num(ctx.toolDefinitionsTokens), tdCount === null ? "" : tdCount + " tools");
  const cats = Array.isArray(ctx.usageCategories) ? ctx.usageCategories : [];
  for (const cat of cats) infoRow(esc(cat && cat.label), cat && cat.tokens, esc(cat && cat.detail));
  info.appendChild(it);
  if (!cats.length) {
    /* The field is omitted entirely when there are no rows. Normal, not an
       error state — a fresh session has none. */
    info.appendChild(el("p", "t-caption dimr", "No usage categories in this reading. That is normal, not an error."));
  }
  d.appendChild(info);

  const meta = el("div", "panel");
  meta.appendChild(el("div", "t-med", "Counts"));
  const mt = el("table", "grid kv");
  for (const [k, key] of [["turns", "turnCount"], ["tool calls", "toolCallCount"],
                          ["messages", "messageCount"], ["compactions", "compactionCount"]]) {
    const tr = el("tr");
    tr.appendChild(el("th", "", k));
    tr.appendChild(el("td", "num", num(ctx[key]) === null ? "—" : num(ctx[key]).toLocaleString()));
    mt.appendChild(tr);
  }
  meta.appendChild(mt);
  meta.appendChild(el("p", "t-caption dimr", "read " + ago(v.contextAt) + " ago"));
  d.appendChild(meta);
}

/* The agent-wide narration rail.
   ─────────────────────────────────────────────────────────────────────
   `bridge.log` belongs to NO session. It is unscoped deliberately —
   process lifecycle is not a session's business — so a channel scoped to
   one session still receives it, and its TEXT very often names a session.
   Inside a session pane that reads exactly like a cross-session leak, so
   it does not go in one. It lives here, on its own surface, and every line
   carries the [agent-wide] tag. WP3b §4. */
function renderAgentTab(d) {
  /* WP10: the instrument's credentials live here permanently (the same panel
     the first-run canvas shows before any session exists). */
  d.appendChild(renderAgentFacts());

  const pan = el("div", "panel");
  pan.appendChild(el("div", "t-med", "Agent-wide narration"));
  pan.appendChild(el("p", "t-caption dim",
    "One agent process serves every session. These lines belong to the process, not to any "
    + "session, which is why they are here and not in a session's pane — and why a line may "
    + "name a session other than the one you have selected. That is not a leak; no event "
    + "crosses channels."));
  const tbl = el("table", "grid kv");
  const tr = el("tr");
  tr.appendChild(el("th", "", "agent"));
  const td = el("td", "t-mono-sm");
  td.textContent = agent.state + (agent.pid ? " · pid " + agent.pid : "") +
    (agent.restarts ? " · " + agent.restarts + " restart(s)" : "") +
    (agent.failure ? " · " + agent.failure : "");
  tr.appendChild(td);
  tbl.appendChild(tr);
  pan.appendChild(tbl);
  d.appendChild(pan);

  /* Unscoped events with no handler. They belong to the process, so this is
     where they can be shown without claiming they belong to a session. The
     payload goes through pre(), which is textContent. D35. */
  const uh = el("div", "panel");
  /* LEGIBILITY (D45): the agent-wide unhandled panel is not "waiting on you" —
     a populated panel gets a neutral strong border, not gold. */
  uh.style.borderColor = unhandledWide.length ? "var(--border-strong)" : "var(--border-muted)";
  uh.appendChild(el("div", "t-med", "Unhandled, agent-wide"));
  uh.appendChild(el("p", "t-caption dim",
    "Event kinds this build has not handled before, arriving with no session on them. This panel "
    + "is expected to be empty and expected to stop being empty one day. Session-scoped ones "
    + "appear in that session's stream instead."));
  if (!unhandledWide.length) uh.appendChild(el("p", "t-caption dimr", "Nothing yet."));
  for (const item of unhandledWide) uh.appendChild(renderUnhandled(item));
  d.appendChild(uh);

  const log = el("div", "panel");
  log.appendChild(el("div", "t-med", "Recent lines"));
  if (!agentWide.length) log.appendChild(el("p", "t-caption dimr", "Nothing yet."));
  for (const l of agentWide) {
    const line = el("div", "aw-line");
    line.dataset.kind = l.kind;
    line.appendChild(el("span", "aw-tag", "[agent-wide] "));
    line.appendChild(document.createTextNode(l.text));
    log.appendChild(line);
  }
  d.appendChild(log);
}

/* ── THE SHELL TAB ────────────────────────────────────────────────────
   A development surface, not product UI, and it says so. It exists for
   two reasons the brief asks for directly: every status string in spec §2
   has to be rendered and screenshotted, and the "agent process gone"
   state has to be forced. It also carries the honest coverage table —
   which words are live, which are stubs, and which the reconciliation
   cut, with the reason.
   ─────────────────────────────────────────────────────────────────── */

/* Spec §2, in its own order, with a verdict on every line. */
const WORDS = [
  ["Status strings", null, null, null],
  ["Idle",                       "live", "strip", null],
  ["Connecting…",                "live", "strip", null],
  ["Session ready",              "live", "strip + canvas", null],
  ["Thinking…",                  "live", "strip", null],
  ["Streaming response",         "live", "strip", null],
  ["Calling tool · {tool_name}", "live", "strip", null],
  ["Awaiting permission",        "live", "strip", null],
  ["Awaiting plan approval",     "live", "strip", null],
  ["Awaiting your answer",       "live", "strip", "WP6/D54: an unanswered agent question. Added to spec §2 with the cards; the possessive is deliberate — this is the one state where the user is the subject."],
  ["Editing files",              "live", "strip", null],
  ["Turn complete",              "live", "strip + canvas", null],
  ["Turn cancelled",             "live", "strip", null],
  ["Turn failed · {reason}",     "live", "strip + canvas", null],
  ["Context filling",            "live", "strip + badge", null],
  ["Compacting context…",        "live", "strip + bar hatch", null],
  ["Agent process gone",         "live", "strip + banner", null],
  ["Restarting agent…",          "live", "strip + banner", "WP12: the bounded-respawn window is not the death — the strip and the banner title distinguish them, and neither banner carries a button."],

  ["Primary actions", null, null, null],
  ["New session",   "live", "rail + empty state + picker", "Opens an in-app, directories-only folder picker (WP5.5/D47). session/new with the picked cwd, verified against /state before this tab selects it; other tabs do not jump."],
  ["Send",          "live", "composer", "session/prompt. Ctrl+Enter also sends."],
  ["Stop",          "live", "composer", "session/cancel — a notification, so nothing acknowledges it. Enabled only while a turn is in flight."],
  ["Compact now",   "live", "meter popover + canvas near-full panel", "Wired in WP9. POST /session/compact → _x.ai/compact_conversation; honest outcomes on two rails: the agent's own auto_compact_completed numbers in the stream, and the server's before/after session/info sentence as a note — including its 'the context did NOT go down' variant when that is what happened (that sentence is composed in sessions.ts compact(), which predates WP9). 1.0.0 sends no 'started' notice on the manual path, so the hatch runs from the click."],
  ["Reconnect",     "live", "failure banners only", "WP10: real exactly where a retry means something — a failed startup or a stopped crash-loop respawn enables 'Try again' (POST /agent/restart, the same bring-up). WP12: REMOVED from the gone/respawning banner (the director's call) — there is no reconnect method there, and a button that can never be pressed is a lie of affordance. The narration stays. The one deliberate exception: the 'Could not connect' banner keeps its disabled Retry — the browser's own stream retry is the only mechanism there, and the label says so."],
  ["Retry",         "cut",  "reworded, live", "Reworded to 'Send this prompt again', on a failed turn. It puts the text back in the composer rather than re-sending silently: there is no retry method, and a turn that failed mid-way may already have changed files."],
  ["Approve / Reject", "cut", "—", "Dies as button text. The buttons are one per entry of the agent's own options array, labelled verbatim — and there are often three, not two. Reconciliation §C."],
  ["Approve plan / Request changes / Quit plan mode", "live", "stream · plan card", "Real methods, live on the in-stream plan card (WP6/D54). Quit's caption says it also turns plan mode off; Request changes reveals the feedback box."],
  ["Send answers", "live", "stream · question card", "Enabled once every question has an answer (our stricter rule — upstream permits partial answers, we never send one). Absent on a single single-select card, which answers on click."],
  ["Close without answering", "live", "stream · question card", "Sends the question reply 'cancelled' — worded so it admits something IS sent and promises nothing about what the agent does next (D54)."],
  ["Cancel",        "cut",  "—", "Deferred to WP7 with Stop (D56): the permission card refuses via the agent's own reject option, and a separate Cancel-turn control needs the surface to say which action it performs."],
  ["New project / Delete project / Move to project…", "cut", "—", "No project entity exists anywhere in the protocol. The rail groups by cwd. D7 / reconciliation §D."],
  ["Delete session", "live", "rail row menu + confirm modal", "In v1 after all (D59): the method deletes the local history AND the remote copy, there is no undo and no archive, and the confirmation says so before it runs. Archive/restore and export are the non-destructive alternatives beside it (D61)."],

  ["Empty states", null, null, null],
  ["No session open / Select a session from the left…", "live", "canvas", null],
  ["Session ready / Type what you want the agent to do.", "live", "canvas", null],
  ["No unreviewed changes.", "live", "drawer · File changes", "WP11's pane. Never rendered for a read failure — that says 'Could not be read' instead, because an unreadable reply is not a reading of zero."],
  ["Thinking · {n} chunks", "live", "stream", "Not in spec §2. Folded thinking needs a summary line and the count is the honest one. D34."],
  ["Read-only / Not read-only / Read-only not stated", "live", "stream · tool + permission cards", "Not in spec §2 either, and the reconciliation calls it the most decision-relevant bit on the surface. Three states mirroring the field (D57) — 'changes files' overclaimed read_only:false."],
  ["Cost: not reported", "live", "stream · turn foot", "Concise (D18/D48): 'Agent-reported: $0.0123 · not billed to your plan'. Never $0.000000 — the agent omits the figure rather than reporting zero."],
  ["UNHANDLED EVENT", "live", "stream + strip badge", "An event kind this build has not handled before renders visibly rather than being dropped. D35."],
  ["No tools called in this turn.", "live", "drawer · Tool detail", "The detail itself is expand-in-place on the card, which spec §1 allows."],
  ["No projects yet / Create a project to group sessions…", "cut", "—", "Wrong twice: the concept does not exist, and the roster is machine-wide so it would almost never be true. The genuinely empty rail has its own sentence."],
  ["No sessions in this project / Start a new session.", "cut", "—", "No projects."],

  ["Errors & recovery", null, null, null],
  ["Agent process gone / …Sessions are preserved.", "live", "banner", "WP12: no Reconnect button on the gone or Restarting banners (removed — a control that can never fire is a lie of affordance). The real Try again lives on the failure states; the 'Could not connect' banner keeps a disabled Retry because the browser's own stream retry is the only mechanism there."],
  ["Turn failed / The agent could not complete this turn. {reason}", "live", "canvas", null],
  ["Context nearly full / Compact now or start a new session.", "live", "canvas", null],
  ["Could not connect / Unable to reach the local agent. / Retry", "live", "banner", null],

  ["Input placeholders", null, null, null],
  ["What do you want to build?", "live", "composer, no session", null],
  ["Continue or give a new instruction…", "live", "composer, session open", null],
  ["Project name", "cut", "—", "No projects."],
  ["Session name (optional)", "cut", "—", "session/new takes cwd and mcpServers. There is no name. Titles are generated by the agent and arrive as an event; rename exists afterwards."],

  ["Left-rail labels", null, null, null],
  ["Sessions", "live", "rail header", null],
  ["Projects / New project / Move to project…", "cut", "—", "No projects."],

  ["Confirm dialogs", null, null, null],
  ["Delete session?", "live", "modal", "Built in WP13 (D59). The wording states plainly that both copies go and that there is no undo."],
  ["Delete project? / Clear conversation?", "cut", "—", "Both out. There are no projects, and no method clears a session in place: compact summarises, rewind steps back, new starts a different session, delete destroys the record. A Clear button would either do nothing or do something its label does not describe."],

  ["Mode labels", null, null, null],
  ["Plan mode", "live", "composer", "The only real toggle, wired in WP7. Its face is written by current_mode_update and nothing else — on for the exact id 'plan', off for every other announced id including a garbage plan-exit echo, and 'off · not confirmed' until the agent has announced anything at all (D72)."],
  ["Subagents / Skills / Workflows / Loops", "cut", "—", "Not modes. Subagents are spawned by the agent and observed, never switched; the other three are commands and belong in the slash launcher (WP7). There is no Modes panel. Reconciliation §B."],
];

function renderShellTab(d) {
  const warn = el("div", "panel");
  /* LEGIBILITY (D45): the dev Shell inspector is not a "waiting on you" surface —
     neutral strong border, not gold. */
  warn.style.borderColor = "var(--border-strong)";
  warn.appendChild(el("div", "t-med", "Shell inspector"));
  warn.appendChild(el("p", "t-caption dim",
    "A development surface for WP4's evidence, not a product panel. It forces a status string so "
    + "each one can be screenshotted, and it records which of spec §2's words are live, which are "
    + "stubs, and which the reconciliation cut."));
  d.appendChild(warn);

  const f = el("div", "panel");
  f.appendChild(el("div", "t-med", "Force a status string"));
  const wrap = el("div");
  wrap.style.display = "flex";
  wrap.style.flexWrap = "wrap";
  wrap.style.gap = "4px";
  wrap.style.marginTop = "8px";
  const mk = (key, label) => {
    const b = el("button", "btn btn-sm", label);
    b.dataset.variant = "ghost";
    if (forcedState === key) b.dataset.toggle = "on";
    b.title = key ? STATES[key].src : "Stop forcing; show the real state.";
    b.onclick = () => { forcedState = key; renderAll(); };
    wrap.appendChild(b);
  };
  mk(null, "live state");
  for (const k of PRIORITY.slice().reverse()) mk(k, STATES[k].text);
  f.appendChild(wrap);
  if (forcedState) {
    const n = el("p", "t-caption");
    /* LEGIBILITY (D45): a forced state means the strip is deliberately lying —
       that is a warning, so red, not the waiting-gold it used to borrow. */
    n.style.color = "var(--state-failed)";
    n.style.marginTop = "8px";
    n.textContent = "FORCED: “" + STATES[forcedState].text + "”. The strip is not showing real state.";
    f.appendChild(n);
  }
  const src = el("p", "t-caption dimr");
  src.style.marginTop = "8px";
  src.textContent = "driven by: " + STATES[resolveState().key].src;
  f.appendChild(src);
  d.appendChild(f);

  const cov = el("div", "panel");
  cov.appendChild(el("div", "t-med", "Spec §2 coverage"));
  const tbl = el("table", "grid");
  for (const [words, verdict, where, why] of WORDS) {
    const tr = el("tr");
    if (verdict === null) {
      const th = el("td", "t-caption dimr");
      th.colSpan = 2;
      th.style.paddingTop = "10px";
      th.textContent = words.toUpperCase();
      tr.appendChild(th);
      tbl.appendChild(tr);
      continue;
    }
    const a = el("td");
    const fl = el("span", "flag t-caption", verdict.toUpperCase());
    fl.dataset.v = verdict;
    a.appendChild(fl);
    tr.appendChild(a);
    const b = el("td", "t-caption");
    b.appendChild(el("div", "", words));
    if (where && where !== "—") b.appendChild(el("div", "t-caption dimr", where));
    if (why) b.appendChild(el("div", "t-caption dimr", why));
    tr.appendChild(b);
    tbl.appendChild(tr);
  }
  cov.appendChild(tbl);
  d.appendChild(cov);

  /* The raw event view. The shell drives turns and answers permission
     requests itself now (WP5/WP6); the bridge remains as the raw debugging
     surface, served only in STUDIO_DEV=1 builds (WP14, D46) — which is the
     only kind of build that has this tab. The link has to carry the run
     token, because a page without it is a 403 by design (D10). */
  const br = el("div", "panel");
  br.appendChild(el("div", "t-med", "Bridge view"));
  br.appendChild(el("p", "t-caption dim",
    "The raw event view WP0–WP3 were proven on. The shell now sends prompts (WP5) and answers "
    + "all three blocking interactions on cards in the conversation (WP6); this remains the raw "
    + "debugging surface."));
  const a = document.createElement("a");
  a.className = "btn btn-sm";
  a.style.textDecoration = "none";
  a.style.marginTop = "8px";
  a.href = "/bridge" + location.search;
  a.textContent = "Open the bridge view";
  br.appendChild(a);
  d.appendChild(br);

  const n = el("div", "panel");
  n.appendChild(el("div", "t-med", "Shell log"));
  if (!shellNotes.length) n.appendChild(el("p", "t-caption dimr", "Nothing yet."));
  for (const x of shellNotes) {
    const line = el("div", "aw-line");
    line.dataset.kind = x.kind === "error" ? "error" : "";
    line.textContent = x.text;
    if (x.kind === "error" && x.details) {
      line.appendChild(copyDetailsButton(x.details));
    }
    n.appendChild(line);
  }
  d.appendChild(n);
}

/* ── RENDER ALL ───────────────────────────────────────────────────── */

function renderAll() { renderRail(); renderStrip(); renderCanvas(); renderDrawer(); renderAutoApprove(); renderGate(); renderModal(); }

/* ── CHROME ───────────────────────────────────────────────────────── */

/* Filtering redraws only the rail — never the canvas, so a running turn's
   stream and any half-typed card note are untouched while you search. */
$("railFilter").oninput = () => renderRail();

$("railToggle").onclick = () => {
  const app = $("app");
  const now = app.dataset.rail === "collapsed" ? "expanded" : "collapsed";
  app.dataset.rail = now;
  $("railToggle").textContent = now === "collapsed" ? "›" : "‹";
  /* WP14: the tooltip tracks the state (foldAll's pattern) — a stale
     "Collapse the rail" on an already-collapsed rail promised the opposite
     of what the next click does. */
  $("railToggle").title = now === "collapsed" ? "Expand the rail" : "Collapse the rail to 48px";
};
function openDrawer(tab) {
  $("app").dataset.drawer = "open";
  syncDrawerChrome();
  if (tab) setTab(tab);
  /* WP11/F7: the hunk tracker pushes nothing, so the drawer opening on the
     Detail tab is one of the three moments the changes pane re-reads. */
  if ((tab || drawerTab) === "detail") refreshChanges(activeId);
}
/* WP14: the strip's Details button advertises the drawer's state. */
function syncDrawerChrome() {
  $("drawerToggle").setAttribute("aria-expanded",
    $("app").dataset.drawer === "open" ? "true" : "false");
}
/* WP6/D53 removed the drawer's interaction duty: it no longer auto-opens on a
   blocking request and no longer needs closing when one resolves — the card in
   the stream opens, seals, and closes with its own lifecycle. */
function setTab(tab) {
  /* WP14 (D46): the Shell tab is dev-gated; a non-dev build must never land
     on it, however the call arrived. */
  if (tab === "shell" && !DEV_BUILD) tab = "detail";
  drawerTab = tab;
  for (const b of document.querySelectorAll(".tab[role=tab]")) {
    b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false");
  }
  /* The tabpanel is labelled by whichever tab is showing (WP14). The ids are
     tabDetail / tabContext / tabAgent / tabShell. */
  $("drawerBody").setAttribute("aria-labelledby", "tab" + tab.charAt(0).toUpperCase() + tab.slice(1));
  renderDrawer();
}
for (const b of document.querySelectorAll(".tab[role=tab]")) b.onclick = () => {
  openDrawer(b.dataset.tab);
};
/* WP14 (D46): the Shell tab is a development surface — it says so itself,
   and its force-a-state buttons make the status strip lie on purpose.
   Development builds keep it; a public build never shows it. Hiding it is
   only safe because the notice strip already gives note()'s sentences a
   product home — without that, gating this tab would orphan every error
   sentence (the brief's item-3-before-item-4 ordering). */
if (!DEV_BUILD) {
  const shellTab = document.getElementById("tabShell");
  if (shellTab) shellTab.hidden = true;
}
$("drawerClose").onclick = () => { $("app").dataset.drawer = "closed"; syncDrawerChrome(); };
$("drawerToggle").onclick = () => {
  const app = $("app");
  app.dataset.drawer = app.dataset.drawer === "open" ? "closed" : "open";
  syncDrawerChrome();
  if (app.dataset.drawer === "open") {
    renderDrawer();
    /* WP11/F7: same re-read moment as openDrawer — no push exists. */
    if (drawerTab === "detail") refreshChanges(activeId);
  }
};

/* ── WP9: the meter opens its popover ──
   Click pins it open; hover opens it tentatively and leaving lets it go after
   a short grace (the pointer may cross the 6px anchor gap slowly — Opus WP9
   review M1); Escape (when pinned) and clicking anywhere else close it. The
   meter is one control, so the whole cluster (caption, bar, numbers) is the
   target. */
{
  const meter = $("meter");
  meter.setAttribute("role", "button");
  meter.setAttribute("tabindex", "0");
  meter.setAttribute("aria-haspopup", "dialog");
  meter.setAttribute("aria-expanded", "false");
  /* No native title here: the hover popover IS the explanation, and a tooltip
     landing on top of it a second later is worse than either alone. */
  meter.onclick = () => { if (ctxpopOpen && ctxpopPinned) closeCtxPop(); else openCtxPop(true); };
  meter.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (ctxpopOpen && ctxpopPinned) closeCtxPop();
      else openCtxPop(true, true); /* keyboard: focus moves to the Compact control */
    }
  };
  const cancelClose = () => {
    if (ctxpopCloseTimer) { clearTimeout(ctxpopCloseTimer); ctxpopCloseTimer = null; }
  };
  meter.onmouseenter = () => {
    cancelClose();
    if (ctxpopHoverTimer) clearTimeout(ctxpopHoverTimer);
    ctxpopHoverTimer = setTimeout(() => { if (!ctxpopOpen) openCtxPop(false); }, 250);
  };
  const hoverOut = () => {
    if (ctxpopHoverTimer) { clearTimeout(ctxpopHoverTimer); ctxpopHoverTimer = null;
    }
    if (ctxpopOpen && !ctxpopPinned && !ctxpopCloseTimer) {
      ctxpopCloseTimer = setTimeout(() => {
        ctxpopCloseTimer = null;
        if (ctxpopOpen && !ctxpopPinned) closeCtxPop();
      }, 200);
    }
  };
  meter.onmouseleave = (e) => {
    const host = $("ctxpopHost");
    if (host && e.relatedTarget && host.contains(e.relatedTarget)) return;
    hoverOut();
  };
  /* Moving from the meter into the popover must not close it; leaving the
     popover entirely does (unless pinned). */
  const ctxHost = $("ctxpopHost");
  ctxHost.onmouseenter = cancelClose;
  ctxHost.onmouseleave = (e) => {
    if (e.relatedTarget && meter.contains(e.relatedTarget)) return;
    hoverOut();
  };
  /* Clicking anywhere that is neither the meter nor the popover closes it. */
  document.addEventListener("pointerdown", (e) => {
    if (!ctxpopOpen) return;
    const host = $("ctxpopHost");
    if (meter.contains(e.target)) return;
    if (host && host.contains(e.target)) return;
    closeCtxPop();
  });
  /* A resize moves the meter out from under an anchored popover — close
     rather than detach (Opus WP9 review N5). */
  window.addEventListener("resize", () => { if (ctxpopOpen) closeCtxPop(); });
}

/* New Session opens the folder picker (WP5.5). The rail-foot button and the
   empty-state button both call it. */
$("btnNewSession").onclick = openPicker;
/* Escape closes whatever transient surface is open (WP13 adds the modal).
   The context popover only answers when PINNED (WP9, Opus review M2): a
   hover-opened popover is transient and must never eat an Escape meant for
   a rename, a row menu, or the picker. */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modal) { closeModal(); return; }
  if (renaming) { cancelRename(); return; }
  if (rowMenu) { rowMenu = null; renderRail(); return; }
  if (ctxpopOpen && ctxpopPinned) { closeCtxPop(); return; }
  if (picker) closePicker();
});

/* ── WP13 wiring: auto-approve switch, and importing a session ────────────── */
{
  const aa = $("autoApprove");
  if (aa) aa.onclick = toggleAutoApprove;
  const imp = $("btnImportSession");
  if (imp) imp.onclick = openImportModal;
  const impFile = $("importFile");
  if (impFile) impFile.onchange = () => {
    const file = impFile.files && impFile.files[0];
    impFile.value = ""; /* let the same file be chosen again next time */
    onImportFileChosen(file);
  };
}

/* ── THE COMPOSER'S TWO ACTIONS ───────────────────────────────────────────

   Send is `session/prompt`. Stop is `session/cancel`.

   NEITHER RESULT IS TRUSTED. `/prompt` answers 202 the moment the request goes
   out — the turn has not happened yet and the 202 says nothing about it — so
   the text is cleared on the acknowledgement but everything on screen comes
   from the events that follow. `/session/cancel` is a NOTIFICATION on the wire:
   there is no response, nothing acknowledges it, and the turn ending with a
   stopReason other than `end_turn` is the only confirmation there is.

   Standing rule 1: this API returns success for calls that did nothing.
   ─────────────────────────────────────────────────────────────────────── */

async function send() {
  const box = $("prompt");
  const text = box.value;
  if (!text.trim() || sending || !activeId) return;
  const rec = agent.sessions.find((s) => s.sessionId === activeId) || null;
  if (!rec || !rec.live) { note("error", "Not sent — this app is not holding that session open. Try again."); return; }
  if (rec.turnInFlight) { note("error", "Not sent — a turn is already running on this session. Try again."); return; }

  sending = true;
  renderComposerNow();
  const r = await post("/prompt", { sessionId: activeId, text });
  sending = false;
  if (r && !r.error) {
    /* Cleared only on the acknowledgement. A refused prompt leaves the text
       where the user can see it and try again. */
    box.value = "";
    box.style.height = "";
    /* A sent prompt is the end of whatever the launcher was helping to write. */
    closeLauncher();
  }
  /* The turn's own start event does the rest. Reading state back rather than
     assuming the 202 means a turn exists. */
  refreshState();
}

function stop() {
  if (!activeId) return;
  post("/session/cancel", { sessionId: activeId });
  /* No optimistic state change. `bridge.cancel_sent` is what puts the line in
     the stream, and the turn ending is what changes the strip. */
}

/** Repaint the composer alone, for the one state change with no event behind it. */
function renderComposerNow() {
  renderComposer(agent.sessions.find((s) => s.sessionId === activeId) || null, view(activeId));
}

$("btnSend").onclick = send;
$("btnStop").onclick = stop;

/* Ctrl+Enter or Cmd+Enter sends; Enter is a line break. The other way round is
   the more common choice and it is wrong for this product: the input is where a
   director writes a paragraph of instructions, and losing half of it to a
   reflex keystroke costs a whole turn.

   WP7 adds ONE exception, and only inside the launcher: while it is open,
   Enter, Tab and Ctrl/Cmd+Enter all ACCEPT the highlighted command as text and
   none of them sends. Sending then takes a second, deliberate Ctrl/Cmd+Enter on
   a closed composer — a slash command the operator has not re-read must never
   be one keystroke away from running. */
$("prompt").addEventListener("keydown", (e) => {
  if (launcher) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (launcher.rows.length) { e.preventDefault(); moveLauncher(e.key === "ArrowDown" ? 1 : -1); }
      return;
    }
    if (e.key === "Escape") {
      /* The typed text stays exactly where it is, `/` included. */
      e.preventDefault();
      closeLauncher();
      return;
    }
    if (e.key === "Tab") {
      /* Focus does not leave the composer while the list is open. */
      e.preventDefault();
      if (launcher.rows.length) acceptCommand(launcher.active);
      return;
    }
    if (e.key === "Enter") {
      if (e.ctrlKey || e.metaKey) {
        /* Never a send from an open launcher, even with nothing to accept. */
        e.preventDefault();
        if (launcher.rows.length) acceptCommand(launcher.active);
        return;
      }
      if (launcher.rows.length) { e.preventDefault(); acceptCommand(launcher.active); return; }
      /* Nothing to accept: plain Enter is a line break, as it always is. */
    }
    return;
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});

/* Grow with the text, up to a third of the window. The composer's 72px floor is
   a minimum, not a maximum — spec §1. */
function growPrompt() {
  const box = $("prompt");
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight, Math.round(window.innerHeight / 3)) + "px";
}
$("prompt").addEventListener("input", () => {
  growPrompt();
  /* Opens on a leading slash, refilters on every keystroke after it, and closes
     the moment the text stops starting with one. */
  syncLauncher();
});
/* Moving the caret with the keyboard or the mouse changes the query segment too. */
$("prompt").addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") syncLauncher();
});
$("prompt").addEventListener("click", () => { if (launcher) syncLauncher(); });

/* WP7 controls. The plan toggle and the effort selector. */
$("btnPlan").onclick = togglePlan;
$("effortSelect").onchange = () => setEffort($("effortSelect").value);

/* A click anywhere outside the launcher and the composer closes it without
   inserting anything. */
document.addEventListener("click", (e) => {
  if (!launcher) return;
  /* One containment test covers the box, Send and Stop, the meta row and the
     list itself — they all live inside the composer's 720px column. */
  const inner = $("composerInner");
  for (let node = e.target; node; node = node.parentNode) {
    if (node === inner) return;
  }
  closeLauncher();
});

/* ── EVENTS ───────────────────────────────────────────────────────────
   One unscoped EventSource. Per D14 a scoped channel is a strict subset of
   this one, and the shell needs the agent-wide frames as well as every
   session's, so it takes the superset and routes on `sessionId` itself.
   ─────────────────────────────────────────────────────────────────── */

async function refreshState() {
  const gateRevAtStart = gateRevision; /* the gate ordering guard (R1/M3) */
  const s = await post("/state");
  if (s && !s.error) {
    agent = s;
    for (const rec of s.sessions) { const v = view(rec.sessionId); if (rec.live) v.opened = true; }
    reconcileActiveSession();
    /* WP12: snapshot-carried sidecars — this generation's recovery markers
       (exactly once; Codex I3) and the held gate state (Opus I1). */
    if (typeof s.agentGeneration === "number") currentAgentGen = s.agentGeneration;
    applySnapshotSidecars(gateRevAtStart);
    renderAll();
  }
}

/* Read the roster out of the RESPONSE, not out of the broadcast it also
   fires. The broadcast is real and the shell handles it, but at boot there
   is a window in which the request has been sent and this page's
   EventSource has not finished connecting — and an event nobody is
   listening for is not redelivered. The first paint took that race and drew
   an empty rail with "No sessions on this machine yet" over a machine with
   66 of them: a confident, wrong, empty state, which is the exact failure
   mode this project keeps finding. */
async function refreshRoster() {
  /* At boot the agent may still be starting; the route then refuses with "the
     agent is not ready" — an expected race, not an error worth a toast, so
     that one call is quiet (WP10; the first version of this fix SKIPPED the
     fetch instead, which could leave the rail confidently empty — worse).
     bridge.agent_ready re-reads state first, then the roster. */
  const r = await post("/sessions/list", {}, { quiet: agent.state === "starting" });
  if (r && !r.error && Array.isArray(r.sessions)) {
    roster = r.sessions;
    rosterRead = true;
    reconcileActiveSession();
    renderAll();
  }
}

/* ── THE REDUCER ──────────────────────────────────────────────────────────

   One `AppEvent` in; some combination of view state, turns and blocks out.
   Nothing in here touches the DOM directly — it changes state and asks for a
   paint, which is why a replay of two hundred events costs one paint.

   THE SHAPE OF THE SWITCH IS THE SAFETY PROPERTY. Every case that consumes an
   event returns. Anything that falls through to `default:` becomes a visible
   unhandled card carrying its whole payload (D35), because an event kind this
   build has not handled before must look unhandled rather than invisible, and a
   silent drop is how a release breaks the pane. So the list of things NOT in
   the stream is written out as cases that return, not left implicit — an event
   nobody thought about ends up on screen, and an event somebody decided to
   swallow says where it went.
   ─────────────────────────────────────────────────────────────────────── */

function handle(ev) {
  const d = ev.data || {};
  const v = ev.sessionId ? view(ev.sessionId) : null;

  /* A normaliser that expected a field and did not find it. Louder than
     the event: either the wire changed or events.ts is wrong. It still renders
     in the stream — this only adds the shell-log line. Latched ONCE PER TYPE
     (Opus final M1): settings/update re-asserts on a timer upstream, so a
     renamed field would otherwise flood the 40-cap Shell log with the same
     line until every other error is evicted. */
  if (ev.missing && ev.missing.length && !missingNoted.has(ev.type)) {
    missingNoted.add(ev.type);
    note("error", "WIRE FORMAT CHANGED? " + ev.type + " — " + ev.note);
  }

  /* A replayed event is history. It never drives a state change, a card, or
     a scroll — untagged, a session/load would re-fire last week's
     permission prompts as if they were live. It DOES become stream content,
     tagged as history: that is what a replay is for. */
  const live = hasLiveEffects(ev);
  const historical = isHistoricalDelivery(ev);

  /* WP7. A full model catalogue supplies the effort selector's OPTIONS — never
     its value, which stays the roster's read-back. Scoped to a session when the
     agent says so, held connection-wide when it does not: an unscoped payload
     is never attributed to one session (D14).

     This sits BEFORE the switch on purpose. Only a payload that really carries
     the model array is consumed here; anything else keeps falling through to
     `default:` and lands on screen as an unhandled card, which is what D35
     requires and what a `case` returning unconditionally would have broken. */
  if (ev.type === "models.updated" && ev.modelled === true && Array.isArray(d.availableModels)) {
    modelsUpdateSeq++;
    const catalogue = { currentModelId: d.currentModelId, availableModels: d.availableModels };
    if (v) v.modelsUpdate = { seq: modelsUpdateSeq, payload: catalogue };
    else modelsUpdate = { seq: modelsUpdateSeq, payload: catalogue };
    if (live) refreshState();
    renderComposerNow();
    return;
  }

  switch (ev.type) {
    /* ── the agent-wide rail. Never routed into a session. ──
       `bridge.log` belongs to no session; it is unscoped on purpose and its
       text very often names a session other than the selected one. Inside a
       session pane that reads exactly like a cross-session leak, so it does
       not go in one. WP3b §4. */
    case "bridge.log":
      agentWide.unshift({ kind: d.logKind, text: (d.logKind === "wire-in" ? "<-- " : d.logKind === "wire-out" ? "--> " : "[" + d.logKind + "] ") + esc(d.text) });
      while (agentWide.length > 120) agentWide.pop();
      if (drawerTab === "agent") renderDrawer();
      return;

    case "bridge.channel_open":
      streamUp = true;
      if (d.agent) {
        agent = d.agent;
        for (const rec of agent.sessions || []) { const held = view(rec.sessionId); if (rec.live) held.opened = true; }
        reconcileActiveSession();
        /* WP11 round 3: the generation stamps bind against. Re-established
           from the server on every (re)connect — this is what makes the
           boundary survive a full page reload. */
        if (typeof d.agent.agentGeneration === "number") currentAgentGen = d.agent.agentGeneration;
        /* WP12: and the snapshot's sidecars with it — recovery markers
           (exactly once) and the held gate state. */
        applySnapshotSidecars();
      }
      if (d.recovery && d.recovery.mode === "reconstruction") {
        recoveryActive = true;
        recoveryPainted = false;
        recoveryText = ev.note || "Restoring this page from the server's retained history.";
        for (const loss of d.recovery.losses || []) {
          const lost = view(loss.sessionId);
          lost.historyMissing = (loss.events === 1
            ? "1 earlier event is not retained ("
            : loss.events + " earlier events are not retained (")
            + loss.bytes + " serialized bytes). Only the retained history is shown.";
          lost.partialNextTurn = loss.startsMidTurn === true;
        }
      } else if (recoveryActive) {
        recoveryText = "The reconstruction connection was interrupted. Catching up from its last delivery.";
      }
      renderAll();
      return;
    case "bridge.channel_filtered": return;
    case "bridge.replay_truncated": note("info", ev.note); return;
    case "bridge.reconstruction_truncated":
      if (v) {
        v.historyMissing = (d.missingEvents === 1
          ? "1 earlier event is not retained ("
          : d.missingEvents + " earlier events are not retained (")
          + d.missingSerializedBytes + " serialized bytes). Only the retained history is shown.";
        if (d.startsMidTurn === true && !v.turns.length) v.partialNextTurn = true;
      }
      note("error", ev.note);
      return;
    case "bridge.catchup_truncated":
      note("error", ev.note + " The existing page model was retained; reload for a bounded reconstruction if its visible history is incomplete.");
      return;
    case "bridge.reconstruction_finished":
      reconcileOpenInteractions(d.currentInteractionKeys);
      if (recoveryActive) {
        finalizeReconstructedCompletions();
        recoveryActive = false;
        recoveryPainted = false;
        recoveryText = "";
        renderAll();
      }
      /* Fresh F5 only. Historical context_reading events stay inert; a new live
         reading for the exact selected held session repopulates the meter. */
      if (activeId) requestFreshContextReading(activeId);
      return;
    case "bridge.catchup_finished":
      reconcileOpenInteractions(d.currentInteractionKeys);
      if (recoveryActive) {
        finalizeReconstructedCompletions();
        recoveryActive = false;
        recoveryPainted = false;
        recoveryText = "";
        renderAll();
      }
      return;
    case "bridge.catchup_failed": note("error", ev.note); renderAll(); return;

    case "bridge.agent_ready":   streamUp = true;
      /* State first, then the roster: the roster route 400s until the manager
         is ready, and the page's own copy of the agent's state comes from
         /state. Awaited so neither read fires against a stale snapshot. */
      void (async () => { await refreshState(); await refreshRoster(); })();
      return;
    case "bridge.agent_gone":
      agent.state = "gone"; agent.failure = null; agent.failureCause = null;
      resetAutoApproveIndicator();
      clearModelUpdates();
      /* WP11 (round 3): move the binding authority to the NEW generation the
         server just bumped to, and null every stamp minted before the death.
         From here, a stamp binds only if it was minted in the new lifetime. */
      if (typeof d.agentGeneration === "number") currentAgentGen = d.agentGeneration;
      for (const sessionView of sess.values()) {
        clearTransient(sessionView);
        sessionView.cancelSent = false;
        sessionView.subagents = 0;
        for (const turn of sessionView.turns) turn.promptIndex = null;
        sessionView.changes = null;
      }
      note("error", ev.note); renderAll(); return;
    case "bridge.respawning":
      agent.state = "respawning"; agent.failure = null; agent.failureCause = null;
      resetAutoApproveIndicator();
      clearModelUpdates();
      note("info", ev.note); renderAll(); return;
    case "bridge.respawned": {
      /* The new process starts with no permission mode set (the server clears
         it), so the indicator goes OFF here and stays off until a fresh
         sessions/list says otherwise — never carried over from before. */
      resetAutoApproveIndicator();
      /* WP12: durable recovery markers — one per session, exactly once per
         generation (ensureRecoveryMarker owns the dedupe and the
         load-failed suppression); the aggregate resolution line in the log.
         This event is unscoped, so it is never journal-retained; after an
         F5 the same markers are re-derived from the snapshot's per-session
         recovery field (Codex I3). */
      const reloaded = Array.isArray(d.reloaded) ? d.reloaded : [];
      const failed = Array.isArray(d.failed) ? d.failed : [];
      /* The generation these outcomes belong to rides the event (Opus NEW-4):
         a replacement child that died again mid-loop has already bumped the
         page's currentAgentGen, and stamping this event's outcomes as the new
         generation would write "Back —" into sessions whose agent is gone
         again. ensureRecoveryMarker's currentAgentGen guard then refuses
         them, which is correct — they did not survive. */
      const gen = typeof d.agentGeneration === "number" ? d.agentGeneration : currentAgentGen;
      for (const sessionId of reloaded) {
        if (typeof sessionId === "string") {
          ensureRecoveryMarker(sessionId, { generation: gen, ok: true, error: null });
        }
      }
      for (const f of failed) {
        if (f && typeof f.sessionId === "string") {
          ensureRecoveryMarker(f.sessionId, {
            generation: gen, ok: false,
            error: typeof f.error === "string" ? f.error : null,
          });
        }
      }
      const total = reloaded.length + failed.length;
      note(failed.length ? "error" : "info",
        total === 0
          ? "Back — the agent restarted. No sessions were open."
          : "Back — " + reloaded.length + " of " + total + " sessions reloaded." +
            (failed.length ? " " + failed.length + " could not be — each one says so in its own stream." : ""));
      renderAll(); refreshState(); refreshRoster(); return;
    }
    case "bridge.respawn_failed":
    case "bridge.respawn_abandoned":
      agent.state = "failed"; agent.failure = ev.note; agent.failureCause = d.cause || null;
      note("error", ev.note); renderAll(); return;
    case "bridge.fatal":         note("error", d.error); refreshState(); return;

    case "bridge.session_opened":
      /* A broadcast, NOT a navigation. Every tab receives this the moment any
         tab creates a session — a tab that jumps to it is the multi-tab bug this
         package fixes. So this only records that the session exists and refreshes
         the rail; the tab that actually created it selects it from its own
         read-back-verified POST /session/new (createSession), and every other
         tab keeps its own selection here and across F5. Existing /bridge creation
         still lands the session in the rail this way, and the tab that ran it
         still selects it — through its own /state read, not through this event. */
      view(d.session.sessionId).opened = true;
      if (live) refreshState();
      return;

    /* A load replays the whole conversation. Clear first, or the replay lands
       on top of whatever this page already had for the session and the user
       reads their history twice. */
    case "bridge.session_loading":
      if (v) {
        v.loadBackup = {
          turns: v.turns,
          turnsDropped: v.turnsDropped,
          turnSeq: v.turnSeq,
          historyMissing: v.historyMissing,
          partialNextTurn: v.partialNextTurn,
        };
        clearTransient(v);
        v.cancelSent = false;
        v.subagents = 0;
        v.turns = []; v.turnsDropped = 0; v.turnSeq = 0;
        if (live) { v.historyMissing = null; v.partialNextTurn = false; }
      }
      note("info", ev.note);
      if (live) refreshState();
      return;

    case "bridge.session_loaded":
      if (v) {
        v.opened = true;
        for (const abandoned of v.abandonments) {
          appendAbandonmentNotice(v, { t: abandoned.at, replay: true, delivery: ev.delivery }, abandoned);
        }
        v.loadBackup = null;
      }
      /* WP12 (Codex I3, delta fix): the load replay WIPED this session's
         turns (session_loading, above) — and any recovery marker the
         snapshot sidecar pass already wrote with them. Re-derive it NOW,
         after the wipe has settled, live or replayed alike: the replayed
         path skips refreshState (live is false), so without this the marker
         only ever returned on an unrelated later refresh. The generation
         dedupe in ensureRecoveryMarker makes a second write impossible —
         live event + snapshot + F5 still produce exactly one marker. */
      if (ev.sessionId) {
        const rec = (agent.sessions || []).find((s) => s.sessionId === ev.sessionId);
        if (rec && rec.recovery) ensureRecoveryMarker(ev.sessionId, rec.recovery);
      }
      /* WP5 trap 2, and the server already draws the distinction this needs.
         Five setup events per load arrive with no replay tag and that is
         CORRECT for them — MCP init, git HEAD, the command list, the model are
         live facts about a session coming up now. Only untagged CONVERSATION
         content is a problem, and that is the count checked here. Warning on
         the setup events would train the operator to ignore the warning. */
      if (d.untaggedHistoryDuringLoad > 0) note("error", ev.note);
      else if (d.untaggedSetupDuringLoad > 0) {
        note("info", d.untaggedSetupDuringLoad === 1
          ? "1 untagged setup event during the load — expected, and not history: "
            + "it is a live fact about the session coming up now."
          : d.untaggedSetupDuringLoad + " untagged setup events during the load — "
            + "expected, and not history: they are live facts about the session coming up now.");
      }
      /* Close this loaded session's dangling last turn to an honest terminal
         state — scoped to THIS session so a live turn in another one is not
         touched. Without this, a session whose on-disk history had no final
         turn.finished (e.g. one started in the terminal) shows the working
         indicator spinning forever after it loads. */
      if (ev.sessionId) finalizeReconstructedCompletions(ev.sessionId);
      if (live) refreshState();
      return;

    case "bridge.session_load_failed":
      if (v) {
        if (live && v.loadBackup) {
          v.turns = v.loadBackup.turns;
          v.turnsDropped = v.loadBackup.turnsDropped;
          v.turnSeq = v.loadBackup.turnSeq;
          v.historyMissing = v.loadBackup.historyMissing;
          v.partialNextTurn = v.loadBackup.partialNextTurn;
        }
        v.loadBackup = null;
        streamNotice(v, ev, "RECOVERY FAILED", ev.note || "Session history could not be loaded.");
      }
      note("error", ev.note);
      if (live) refreshState();
      renderAll();
      return;

    case "bridge.sessions_listed":
      roster = d.sessions || [];
      rosterRead = true;
      reconcileActiveSession();
      renderAll();
      return;

    case "bridge.context_reading":
      if (v && live) { v.context = (d.info && d.info.context) || null; v.contextAt = ev.t; v.contextRefused = null; }
      renderStrip();
      if (drawerTab === "context") renderDrawer();
      return;

    case "bridge.session_info_empty":
    case "bridge.session_info_mismatch":
      /* A success with no reading in it. Explicitly NOT zero. */
      if (v && live) v.contextRefused = ev.note;
      note("error", ev.note);
      renderStrip();
      if (drawerTab === "context") renderDrawer();
      return;

    case "bridge.cancel_sent":
      if (v) {
        if (live) v.cancelSent = true;
        /* Said in the stream, not only in a log the operator has not opened.
           Cancel is a notification: nothing acknowledges it, so the honest
           line is "sent", and the turn's own ending is the confirmation. */
        const t = currentTurn(v);
        if (t && t.outcome === "running") {
          t.cancelRequested = true;
          t.items.push({ kind: "notice", label: "STOP", at: ev.t, replay: historical, sealed: true,
            text: "Stop sent. It is a notification, so nothing acknowledges it — the turn's own "
                + "ending is the confirmation." });
        }
      }
      if (live) note("info", ev.note);
      scheduleCanvas();
      return;

    case "bridge.mode_set_attempted":
    case "bridge.model_set_attempted": if (live) { note("info", ev.note); refreshState(); } return;
    case "bridge.compacted":
      /* The server's honest before/after sentence (two session/info readings
         around the manual compact). It belongs in the STREAM, not only in the
         dev log: when the reading did not go down, this sentence is the only
         surface that says so — the agent sends no completion notice for a
         no-change compact (measured live, WP9). The after-reading's
         context_reading event updates the meter on its own rail; the
         completed flag may already be cleared by the agent's notice, and
         clearing twice is harmless. */
      if (v && live) {
        v.compacting = false;
        if (typeof ev.note === "string" && ev.note) streamNotice(v, ev, "CONTEXT", ev.note);
      }
      if (live && typeof ev.note === "string" && ev.note) note("info", ev.note);
      renderStrip(); scheduleCanvas();
      return;
    case "bridge.commands_listed": return;   /* the launcher reads the route's reply directly */
    case "bridge.commands_unreadable":
      /* The agent sent a command payload with no command array. Said out loud,
         because the alternative — an empty launcher — would be this app telling
         the operator something about their agent that it never read. */
      if (live) note("error", ev.note);
      if (launcher && launcher.sessionId === ev.sessionId) renderLauncher();
      return;
    case "bridge.unrouted_event": note("error", ev.note); return;

    /* ── WP13 session-administration bridge events ─────────────────────────
       Each is handled explicitly and returns, so none falls through to the
       unhandled-card default (D35). The roster read-back these operations ride
       fires bridge.sessions_listed, which retitles/re-yolos the rail in every
       tab for free — so most of these only need to repaint or note. */
    case "bridge.session_renamed":
    case "bridge.session_exported":
    case "bridge.session_state_empty":
      return; /* the sessions_listed broadcast (or the route error) does the work */
    case "bridge.session_imported":
      if (live) note("info", ev.note);
      return;
    case "bridge.permission_mode_set":
      /* Connection-wide (D62). The read-back's sessions/list broadcast carries
         the new yolo for every tab; just repaint the switch and banner. */
      renderAutoApprove();
      return;
    case "bridge.retention_set_attempted":
      /* WP15 / D87. The HTTP /agent/retention reply already names the three
         honest outcomes and updates agentConfig; this bridge event is the
         journaled trail for other tabs / the Shell log. Do not double-note. */
      return;
    case "bridge.session_delete_failed":
      if (live) note("error", ev.note);
      return;
    case "bridge.session_deleted":
      /* Scoped null — every tab hears it. Prune the id from the local snapshot
         and roster at once (so the row vanishes in every tab, not only the one
         that ran the delete), drop its view, and if it was this tab's active
         view fall to empty state rather than a stale card. The delete's own
         sessions/list read-back also removes it; this makes it immediate. */
      if (d.deleted && typeof d.sessionId === "string") {
        sess.delete(d.sessionId);
        if (agent.sessions) agent.sessions = agent.sessions.filter((x) => x.sessionId !== d.sessionId);
        roster = roster.filter((x) => x.sessionId !== d.sessionId);
        if (activeId === d.sessionId) { setActiveSession(null); reconcileActiveSession(); }
        renderAll();
      }
      return;
    case "bridge.archive_changed":
      /* Archive/restore is server-local (no ACP call), so it does not ride a
         sessions/list broadcast. This keeps every tab's rail in sync. */
      if (Array.isArray(d.archivedIds)) { agent.archivedIds = d.archivedIds; renderAll(); }
      return;

    /* ── WP11 changes & undo bridge events ─────────────────────────────────
       Both are digests (paths/counts/ids — never hunk text, Opus I3), and
       both are consumed quietly: the window that ran a poll or an action
       reads the ROUTE'S reply directly (the commands_listed precedent), and
       applyChangesReading no-ops an identical reading, so the acting window's
       own echo costs nothing (M4). Neither falls through to the
       unhandled-card default (D35). */
    case "bridge.changes_reading":
      if (v && live && applyChangesReading(ev.sessionId, d)) {
        if ($("app").dataset.drawer === "open" && drawerTab === "detail") renderDrawer();
        scheduleCanvas();
      }
      return;
    case "bridge.change_acted":
      if (v && live && d.reading && applyChangesReading(ev.sessionId, d.reading)) {
        if ($("app").dataset.drawer === "open" && drawerTab === "detail") renderDrawer();
        scheduleCanvas();
      }
      return;

    /* ── turn lifecycle ──────────────────────────────────────────────────
       `turn.started` / `turn.finished` / `turn.failed` are ours, around one
       `session/prompt` call. `turn.completed` is the AGENT's own end-of-turn
       update and the only thing carrying the cost. All four can be involved in
       one turn; the turn object is what reconciles them. */
    case "turn.started":
      /* Read the server's own view back. The Detail panel's "turn running" and
         event counts come from /state, and without this they sat at the values
         they had when the session opened while the stream showed a live turn —
         two surfaces contradicting each other on the same screen. */
      if (live) refreshState();
      if (v) {
        if (live) { v.phase = "thinking"; v.detail = ""; v.cancelSent = false; v.runningWrites = 0; }
        const t = openTurn(v, ev);
        /* D36: the prompt text rides on the start event, so any window shows
           the question and not just the tab that typed it. */
        if (typeof d.text === "string" && d.text !== "") {
          t.userFromServer = true;
          t.items.push({ kind: "user", text: d.text, at: ev.t, replay: historical, sealed: true });
        }
      }
      renderAll();
      return;

    case "turn.finished":
      if (v) {
        if (live) clearTransient(v);
        const t = turnToClose(v, ev);
        sealAll(t);
        t.stopReason = d.stopReason ?? null;
        /* WP5 trap 4: a stopReason other than end_turn is not a success even
           though the request succeeded. And the wire does not label a cancel —
           our own cancel is the only thing that can tell one from a failure. */
        closeFromStopEvidence(t, live ? v.cancelSent : t.cancelRequested, ev.t);
      }
      if (live) refreshState();
      else scheduleCanvas();
      return;

    case "turn.failed":
      if (v) {
        if (live) clearTransient(v);
        const t = turnToClose(v, ev);
        sealAll(t);
        t.error = d.error || "no reason given";
        t.cancelled = live ? v.cancelSent === true : t.cancelRequested === true;
        closeTurn(t, t.cancelled ? "cancelled" : "failed", ev.t);
      }
      if (live) refreshState();
      else scheduleCanvas();
      return;

    /* The cost, and the usage behind it. `events.ts` has already divided the
       ten-billionths and left `costUsd` null — never 0 — where the agent
       reported nothing. Replayed turn_completed events carry the cost of a
       historical turn, which is worth keeping, so this one is not gated on
       `live`: it writes onto whichever turn is open, which during a replay is
       the historical one being rebuilt. */
    case "turn.completed": {
      if (!v) return;
      const t = turnToClose(v, ev);
      const u = d.usage || {};
      t.cost = { usd: u.costUsd == null ? null : u.costUsd, incomplete: u.usageIsIncomplete === true };
      t.usage = u;
      t.completionSeen = true;
      /* Kept so a turn finalized at the reconstruction boundary (no finish
         event of its own) can still state its real duration. */
      if (typeof ev.t === "number") t.completedAt = ev.t;
      if (t.stopReason === null && typeof d.stopReason === "string") t.stopReason = d.stopReason;
      if (ev.replay) {
        sealAll(t);
        closeFromStopEvidence(t, t.cancelRequested, ev.t);
      }
      /* WP11/F7: the tracker pushes nothing, so a finished turn is one of the
         three moments the changes pane re-reads. Live only — a replayed
         completion says nothing about what is pending NOW. */
      if (live && typeof ev.sessionId === "string") refreshChanges(ev.sessionId);
      scheduleCanvas();
      return;
    }

    /* ── conversation content ────────────────────────────────────────── */

    case "message.user": {
      if (!v) return;
      const txt = d.text;
      /* A non-text content block normalises to null rather than a stringified
         blob. Nothing to draw, and inventing a placeholder would be a claim. */
      if (typeof txt !== "string") return;
      let t = currentTurn(v);
      if (t && t.outcome === "running" && t.userFromServer) {
        /* The server already gave us this turn's prompt (D36). The agent
           echoing it back is not a second message. Recorded, not drawn.
           WP11 (B1): the echo carries the turn's REAL promptIndex — bind it
           when its generation is the current one (promptStampBinds). */
        t.userEchoed = true;
        if (promptStampBinds(d)) t.promptIndex = d.promptIndex;
        return;
      }
      /* A user message with agent content already in the turn is the next turn
         starting — which is what a replay looks like, since a replay has no
         turn markers of its own. */
      if (!t || t.outcome !== "running" || hasAgentContent(t)) t = openTurn(v, ev);
      /* WP11 (B1): the stamp binds replayed turns too — the retained event
         carries the generation it was minted in, so a plain reload with the
         tracker intact re-establishes history (delta artifact 20), and a
         stamp from a dead lifetime never matches (artifact 21). */
      if (promptStampBinds(d)) t.promptIndex = d.promptIndex;
      const b = blockFor(t, "user", ev, { text: "" });
      b.text += txt;
      scheduleCanvas();
      return;
    }

    case "message.assistant": {
      if (v && live) v.phase = "streaming";
      renderStrip();
      if (!v) return;
      const txt = d.text;
      if (typeof txt !== "string") return;
      const t = turnFor(v, ev);
      /* A new assistant run after a tool call is a new block, because
         blockFor() only continues the LAST block. That is deliberate: the
         agent's text before and after a tool call are two different things and
         the card between them is the reason. */
      const b = blockFor(t, "agent", ev, { text: "" });
      b.text += txt;
      scheduleCanvas();
      return;
    }

    case "message.thinking": {
      if (v && live) v.phase = "thinking";
      renderStrip();
      if (!v) return;
      const txt = d.text;
      if (typeof txt !== "string") return;
      const t = turnFor(v, ev);
      const b = blockFor(t, "thinking", ev, { text: "", chunks: 0, expanded: false });
      b.text += txt;
      b.chunks++;
      scheduleCanvas();
      return;
    }

    /* ── tool calls ───────────────────────────────────────────────────────
       ONE CARD PER `toolCallId`, carried forward.

       The terminal `tool_call_update` carries no descriptor and no title —
       only the id, the status and the content. So a card is found by id and
       updated in place, and a field that did not arrive this time keeps the
       value it had. Overwriting a label with undefined is how a finished tool
       card loses its own name. */
    case "tool.started":
    case "tool.updated": {
      if (!v) return;
      const tool = d.tool || {};
      const running = d.status === null || d.status === undefined
        || d.status === "in_progress" || d.status === "pending";
      if (live) {
        if (running) {
          /* "Editing files" has no state on the wire. The agent's own
             read_only flag is the closest real thing and it is per call — so a
             running tool that says it is not read-only is the condition, not a
             list of tool names we wrote down. Reconciliation §E.3. */
          v.phase = tool.readOnly === false ? "editing" : "tool";
          v.detail = esc(tool.label || d.title || tool.name || "tool");
        } else if (v.phase === "tool" || v.phase === "editing") {
          v.phase = null; v.detail = "";
        }
      }
      renderStrip();

      const id = d.toolCallId;
      const t = turnFor(v, ev);
      let card = null;
      if (id != null) {
        /* Search this turn first, then back through the stream: a tool call
           can outlive the turn boundary if the terminal update lands after
           turn_completed, which has been seen. */
        card = findToolCard(v, id);
      }
      if (!card) {
        /* A tool call ends whatever the agent was saying. Sealing here is what
           makes "the text before the call" and "the text after it" two blocks,
           while a notice arriving mid-sentence leaves the sentence alone. */
        for (const it of t.items) if (it.kind === "agent" || it.kind === "thinking") it.sealed = true;
        card = { kind: "tool", id: id ?? null, at: ev.t, replay: historical, sealed: true,
                 label: null, name: null, kindStr: null, namespace: null, readOnly: null,
                 title: null, rawInput: null, rawOutput: null, locations: null,
                 status: null, expanded: false };
        t.items.push(card);
      }
      /* Only overwrite what actually arrived. */
      if (typeof tool.label === "string") card.label = tool.label;
      if (typeof tool.name === "string") card.name = tool.name;
      if (typeof tool.kind === "string") card.kindStr = tool.kind;
      if (typeof tool.namespace === "string") card.namespace = tool.namespace;
      if (tool.readOnly === true || tool.readOnly === false) card.readOnly = tool.readOnly;
      if (typeof d.title === "string") card.title = d.title;
      if (d.rawInput !== undefined && d.rawInput !== null) card.rawInput = d.rawInput;
      if (d.rawOutput !== undefined && d.rawOutput !== null) card.rawOutput = d.rawOutput;
      if (Array.isArray(d.locations) && d.locations.length) card.locations = d.locations;
      if (typeof d.status === "string") card.status = d.status;
      scheduleCanvas();
      return;
    }

    /* A raw JSON fragment of a tool's arguments as the model emits them. xAI's
       own warning says it is not valid JSON on its own, and the completed
       `tool_call` says the same thing properly — so there is nothing here a
       card cannot already show, and rendering half a JSON object as it grows
       would be noise pretending to be information. */
    case "tool.arguments_delta": return;

    /* ── compaction, modes, titles: notices in the stream ── */
    case "context.compact_started":
      if (v) { if (live) v.compacting = true; streamNotice(v, ev, "CONTEXT", "Compacting the conversation. The agent is summarising history to free context."); }
      renderStrip(); scheduleCanvas();
      return;
    case "context.compact_completed":
      /* Modelled in WP9 from two live 1.0.0 captures. The numbers are the
         agent's own report; the server's compact note (bridge.compacted) is
         an independent session/info before/after and can read a few tokens
         differently — both are shown as what they are. tokensBefore is
         optional upstream; its absence is said, never filled in. */
      if (v) {
        if (live) v.compacting = false;
        streamNotice(v, ev, "CONTEXT",
          typeof d.tokensAfter === "number"
            ? "Compaction finished — the agent reports "
              + (typeof d.tokensBefore === "number"
                  ? "context went from " + d.tokensBefore.toLocaleString() + " to " : "")
              + d.tokensAfter.toLocaleString() + " tokens."
            : "Compaction finished.");
      }
      renderStrip(); scheduleCanvas();
      return;
    case "context.compact_failed":
      if (v) { if (live) v.compacting = false; streamNotice(v, ev, "CONTEXT", "Compaction failed. The context is unchanged."); }
      renderStrip(); scheduleCanvas();
      return;
    case "context.compact_cancelled":
      /* Zero emit sites in the 1.0.0 tree — this case exists so a future
         release that revives the kind lands somewhere sensible. */
      if (v) { if (live) v.compacting = false; streamNotice(v, ev, "CONTEXT", "Compaction cancelled."); }
      renderStrip(); scheduleCanvas();
      return;

    /* ── the blocking requests: THE CARDS (WP6) ── */
    case "interaction.permission_requested":
    case "interaction.plan_approval_requested":
    case "interaction.question_asked":
    case "interaction.unhandled_request": {
      /* `refusedWith` means the server has already answered this with an
         error, so nobody is waiting. Rendering it as a waiting state would
         be a lie. It is still shown, because an agent whose question was
         refused did not get an answer and the operator should know. */
      if (d.refusedWith !== undefined) {
        note("error", "The agent asked something this build cannot answer: " + ev.note);
        if (v) streamNotice(v, ev, "REFUSED",
          "The agent asked something this build cannot answer, and the server refused it so "
          + "the agent is not left waiting. " + esc(ev.note));
        scheduleCanvas();
        return;
      }
      const key = typeof d.key === "string" ? d.key : null;
      if (v) {
        /* ONE card per key, however many times the event arrives — see the
           comment on findInteractionItem. A `current` re-send of a card that
           was drawn from retained history makes that same card live again;
           it never draws a second one. */
        const existing = key === null ? null : findInteractionItem(v, key);
        if (existing) {
          if (live && !existing.resolved) existing.replay = false;
        } else {
          const item = interactionItemFor(ev, d, key);
          turnFor(v, ev).items.push(item);
          /* WP14: a blocking card never announced itself and never took focus,
             so a screen-reader user heard nothing while the agent sat waiting.
             One polite line when the card opens — the header words are D54's
             own; the card's lifecycle is untouched. */
          if (live && item.ikind !== "unknown-request") {
            announce(
              item.ikind === "plan" ? "Plan approval required — the agent is waiting for you."
              : item.ikind === "question" ? "Questions from the agent — it is waiting for your answer."
              : "Permission required — the agent is waiting for you.");
          }
        }
        if (live && ev.type !== "interaction.unhandled_request") {
          v.awaiting =
            ev.type === "interaction.plan_approval_requested" ? "plan"
            : ev.type === "interaction.question_asked" ? "question"
            : "permission";
          v.currentInteractionKey = key;
        }
      }
      /* D54: the drawer no longer auto-opens. The card in the stream IS the
         surface; the strip and the rail dot already carry the gold. */
      renderAll();
      return;
    }

    case "interaction.answered":
      if (v) {
        const matches = typeof d.key !== "string" || v.currentInteractionKey === d.key;
        if (live && matches) {
          v.awaiting = null;
          v.currentInteractionKey = null;
        }
        /* Seal the card with what was actually sent — the user's own act,
           never the agent's receipt. Works for live and for replayed
           history: a retained answered event seals the retained card. */
        if (typeof d.key === "string") {
          sealInteraction(v, d.key, {
            how: d.cancelled === true ? "cancelled" : "answered",
            optionId: typeof d.optionId === "string" ? d.optionId : null,
            outcome: typeof d.outcome === "string" ? d.outcome : null,
            feedback: typeof d.feedback === "string" ? d.feedback : null,
            answers: d.answers && typeof d.answers === "object" ? d.answers : null,
          });
        }
        /* The quiet activity-fold record. The card carries the narration;
           this is the one-line audit trail. */
        const line =
          d.outcome === "accepted"
            ? "Answered " + Object.keys(d.answers || {}).length + " question(s)."
            : d.outcome === "cancelled"
              ? "Closed without answering."
              : typeof d.outcome === "string"
                ? "Sent '" + esc(d.outcome) + "'."
                : d.cancelled
                  ? "Cancelled without answering."
                  : typeof d.feedback === "string"
                    ? "Sent the plan back with a note."
                    : "Answered with the agent's own option '" + esc(d.optionId) + "'.";
        streamNotice(v, ev, "ANSWERED", line);
      }
      renderAll();
      return;

    case "interaction.abandoned":
      if (v) {
        const matches = typeof d.key !== "string" || v.currentInteractionKey === d.key;
        if (live && matches) {
          clearTransient(v);
          v.cancelSent = false;
          v.subagents = 0;
        }
        const reason = typeof d.reason === "string"
          ? d.reason
          : "The server reported an abandoned interaction without a reason.";
        if (typeof d.key === "string") {
          sealInteraction(v, d.key, { how: "abandoned", note: reason });
        }
        rememberAbandonment(v, ev, d.key, reason, d.recoveryAfterTurn);
      }
      renderAll();
      return;

    case "interaction.pending":
    case "interaction.resolved":
      /* Advisory, and measured: one turn produced five pending/resolved pairs
         and asked the human exactly once, three of them resolving in the same
         millisecond they opened. The only thing that means "the human must
         act" is the reverse request itself. `data.advisoryOnly` says so. */
      return;

    case "response.completed":
      /* 0.2.117 advisory usage snapshot (snake_case). Not a turn closer and not
         a cost source — turn.completed / turn.finished still own those. Kept
         quiet so it does not render as a WIRE PROBLEM between answer and foot. */
      return;

    case "session.info_updated":
      /* 0.2.117 title-only duplicate of session.titled. The existing title path
         owns the shell; do not retitle and do not emit a second TITLE notice. */
      return;

    case "turn.summary":
      /* 1.0.0 advisory (WP9): a one-line summary of the turn that just ended,
         arriving after turn_completed. The turn's own events already own the
         outcome, the cost and the content, so there is nothing here that
         needs a surface — kept quiet like the 0.2.117 advisories instead of
         landing as an UNHANDLED EVENT card on every turn. */
      return;

    /* Routine session setup. Both fire on every new session and both used to
       land as UNHANDLED EVENT cards with raw JSON at the top of a fresh
       conversation (acceptance walk, 2026-08-02). They are recognised and
       benign, so they say what they are, in words, and collapse into the
       Activity fold with the rest of the machinery. */
    case "mcp.initialized":
      if (v) streamNotice(v, ev, "SETUP", d.mcpToolCount === 0
        ? "Tool servers ready — none configured, which is the normal case."
        : "Tool servers ready — " + esc(d.mcpToolCount) + " tool(s) available.");
      scheduleCanvas();
      return;
    case "git.head_changed":
      if (v) streamNotice(v, ev, "SETUP", d.branch
        ? "Git branch: " + esc(d.branch) + (d.isWorktree ? " (a worktree)" : "")
        : "Git head changed; the agent did not name a branch.");
      scheduleCanvas();
      return;

    case "session.titled":
      if (v) { v.title = d.title; streamNotice(v, ev, "TITLE", "The agent named this session: " + esc(d.title)); }
      renderAll();
      return;

    case "mode.changed":
      if (v) streamNotice(v, ev, "MODE",
        "The agent reports the session mode is now '" + esc(d.modeId) + "'. It only says this on "
        + "entering or leaving plan mode, and on leaving it echoes back whatever id was asked for.");
      /* An announcement supersedes whatever the last request had to say about
         itself — a timeout that is answered late is no longer a timeout. */
      if (live && ev.sessionId) planNotice.delete(ev.sessionId);
      if (live) refreshState();
      return;

    case "model.changed":
      if (v) streamNotice(v, ev, "MODEL", "Model now " + esc(d.modelId)
        + (d.reasoningEffort ? " · effort " + esc(d.reasoningEffort) : ""));
      /* A live hint, never the face: the roster read-back /state carries is
         what the selector shows. */
      if (live) refreshState();
      return;

    /* `models.updated` is DELIBERATELY NOT A CASE HERE. A full catalogue is
       absorbed above this switch and returns; a payload without the model array
       is not modelled and must fall through to `default:` as a visible
       unhandled card, exactly as it did before WP7 (D35). Adding a case that
       returned either way would have made the malformed one invisible. */

    case "commands.updated":
      /* The launcher's live feed. `commands === null` is the UNREADABLE
         reading (WP7 §2): the last good catalogue is kept exactly as it was,
         and only a session that never had one becomes unavailable. */
      if (v) {
        if (readableCommands(d.commands)) {
          v.commandsRevision++;
          v.commands = d.commands;
          v.commandsFailed = false;
        }
        else if (!Array.isArray(v.commands)) v.commandsFailed = true;
      }
      if (launcher && launcher.sessionId === ev.sessionId) {
        /* Rebuilt in place: the query stays, the highlighted command stays if
           the agent still has it, and focus never moves. */
        rebuildLauncherRows(true);
        renderLauncher();
      }
      return;
    case "sessions.changed": return;         /* the server re-reads the roster itself */

    case "settings.updated":
      /* WP12 round 3: the page NEVER applies this payload directly. The
         server is the single resolver of the gate state machine (set /
         clear / leave-alone, malformed never touches), and its resolved
         state arrives as bridge.gate_state below or in the snapshot. Two
         homes diverged on partial updates (Codex round 3 / Opus NEW-7) —
         this case deliberately does nothing but keep the kind out of the
         unhandled default (D35). */
      return;
    case "bridge.gate_state":
      /* The server's RESOLVED gate state — the only truth the page applies.
         null means no gate and must clear a stale banner (Opus NEW-2). The
         revision bump is inside applyResolvedGate, so live and snapshot
         applications share the ordering (round 5). */
      if (live) { applyResolvedGate(d.gate ?? null); renderGate(); }
      return;

    case "subagent.spawned":
      if (v) { if (live) v.subagents++; streamNotice(v, ev, "SUBAGENT", "The agent spawned a subagent."); }
      renderStrip(); scheduleCanvas();
      return;
    case "subagent.finished":
      if (v) { if (live) v.subagents = Math.max(0, v.subagents - 1); streamNotice(v, ev, "SUBAGENT", "A subagent finished."); }
      renderStrip(); scheduleCanvas();
      return;

    /* ── everything else, and this is the point ────────────────────────────
       Nothing is dropped and nothing is silent. A session-scoped event lands
       in that session's stream as an unhandled card with its whole payload; an
       unscoped one cannot go into a session pane without misattributing it, so
       it is counted in the strip and listed in the Agent-wide panel. Either
       way it is on screen. D35. */
    default: {
      const loud = ev.type.indexOf("wire.") === 0;
      const item = {
        kind: "unhandled", type: ev.type, wireKind: ev.wireKind || null,
        modelled: ev.modelled === true, note: ev.note || null,
        missing: ev.missing || null, payload: ev.modelled ? ev.data : ev.raw,
        loud, at: ev.t, replay: historical, sealed: true,
      };
      if (v) {
        asideFor(v, ev).items.push(item);
        scheduleCanvas();
      } else {
        unhandledWide.unshift(item);
        while (unhandledWide.length > 60) unhandledWide.pop();
        renderStrip();
        if (drawerTab === "agent") renderDrawer();
      }
      if (loud) note("error", ev.type + " — " + (ev.note || ""));
      return;
    }
  }
}

/* WP12 (Codex I3): write a session's recovery marker EXACTLY ONCE per agent
   generation, from whichever source reports it — the live bridge.respawned
   event, or the snapshot's per-session recovery field after a page reload
   (the event itself is unscoped and never journal-retained). The generation
   key does the dedupe: a stale-generation outcome never re-stamps, and a
   second source for the same generation finds the marker already present.
   Never materialises a ghost view for a session this page does not hold
   (Grok F8/Opus M4). The failed marker is suppressed when the load-failed
   marker for the same session already landed (Opus I2 — one failure, one
   report; the aggregate line still carries the N-of-M fact). */
function ensureRecoveryMarker(sessionId, recovery) {
  if (!recovery || recovery.generation !== currentAgentGen) return;
  if (!sess.has(sessionId)) return;
  const sv = view(sessionId);
  const seen = sv.turns.some((t) => t.items.some((i) => i.recoveryGen === recovery.generation));
  if (seen) return;
  if (recovery.ok !== true) {
    const loadFailedSaid = sv.turns.some((t) => t.items.some((i) => i.label === "RECOVERY FAILED"));
    if (loadFailedSaid) return;
  }
  const t = asideFor(sv, null);
  t.items.push({
    kind: "notice", label: "RECOVERY",
    text: recovery.ok === true
      ? "Back — this session was reloaded from disk after the agent restarted."
      : "This session could NOT be reloaded after the agent restarted" +
        (typeof recovery.error === "string" ? ": " + recovery.error : "."),
    at: Date.now(), replay: false, sealed: true, recoveryGen: recovery.generation,
  });
}

/* After any state read-back: re-derive markers for this generation's recovery
   outcomes (the F5 path) and apply the held gate state (Opus I1). Paints the
   gate itself so every caller — refreshState, channel_open — gets it. */
function applySnapshotSidecars(gateRevAtStart) {
  for (const rec of agent.sessions || []) {
    if (rec && rec.recovery) ensureRecoveryMarker(rec.sessionId, rec.recovery);
  }
  /* The snapshot's gate is the server's resolved state: present sets, absent
     clears (Opus NEW-2) — but only when no LIVE gate change landed while the
     read was in flight (the revision guard above). */
  if (gateRevAtStart === undefined || gateRevAtStart === gateRevision) {
    applyResolvedGate(agent.gate ?? null);
  }
  renderGate();
}

/** A one-line notice inside the running turn, or in an aside when none is. */
function streamNotice(v, ev, label, text) {
  asideFor(v, ev).items.push({ kind: "notice", label, text, at: ev.t, replay: isHistoricalDelivery(ev), sealed: true });
}

/** Nothing more will be appended to this turn's growing blocks. */
function sealAll(t) { for (const i of t.items) i.sealed = true; }

/**
 * The card for a tool call id, searched newest-first across the whole session.
 *
 * Not just the current turn: the terminal `tool_call_update` has been seen
 * arriving after `turn_completed`, and a status that lands on a fresh card
 * instead of the original one produces two cards for one call — one that never
 * finishes and one with no name.
 */
function findToolCard(v, id) {
  for (let i = v.turns.length - 1; i >= 0; i--) {
    const items = v.turns[i].items;
    for (let j = items.length - 1; j >= 0; j--) {
      if (items[j].kind === "tool" && items[j].id === id) return items[j];
    }
  }
  return null;
}

function receive(ev) {
  const id = Number.isSafeInteger(ev && ev.deliveryId) ? ev.deliveryId : null;
  if (id !== null && id <= lastDeliveryId) return;
  handle(ev);
  if (id !== null) lastDeliveryId = id;
}

/* ── BOOT ─────────────────────────────────────────────────────────── */

if (!TOKEN_OK) {
  streamUp = false;
  streamLost = true;
  agent.failure = "This page was not served by the studio — no run token. Every request will be refused. Use the URL the server printed at startup.";
  note("error", agent.failure);
  renderAll();
} else {
  const es = new EventSource("/events?token=" + encodeURIComponent(TOKEN));
  es.onopen = () => { streamUp = true; streamLost = false; renderStrip(); };
  es.onerror = () => {
    /* Spec §2: "Could not connect / Unable to reach the local agent. / Retry" */
    streamUp = false;
    streamLost = true;
    renderStrip();
  };
  es.onmessage = (e) => { try { receive(JSON.parse(e.data)); } catch (err) { note("error", "An event from the server could not be read — " + err.message); } };

  refreshState();
  refreshRoster();
  renderAll();
}
