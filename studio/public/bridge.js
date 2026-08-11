const $ = (id) => document.getElementById(id);
const logEl = $("log"), wireEl = $("wire"), permsEl = $("perms");
$("toshell").href = "/" + location.search;

// The token comes out of this page's own URL, which is the only way the page can
// have been served at all — a GET without it is a 403 (D10). It is not
// substituted into this file: under the Content-Security-Policy the script is a
// separate file, and a static asset the server never rewrites cannot leak a
// secret it never contained. Nobody types it and nothing stores it. Open this
// file straight off disk and there is no token, every request is refused, and
// the banner says so — which is the behaviour we want, not a bug.
const TOKEN = new URLSearchParams(location.search).get("token") || "";
// Shape test rather than a presence test: a truncated token would otherwise look
// present and then fail on every request with nothing on screen saying why.
const TOKEN_OK = /^[0-9a-f]{64}$/.test(TOKEN);

// Every POST carries the token in a custom header. That header is the defence: a
// cross-origin page cannot set one without a CORS preflight this server does not
// answer, and `no-cors` strips it rather than sending it.
function post(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-studio-token": TOKEN },
    body: JSON.stringify(body || {})
  }).then(async (r) => {
    const j = await r.json().catch(() => ({ error: "response was not JSON" }));
    if (j && j.error) add(logEl, "[" + path + " error] " + j.error
      + (j.offered ? "  offered: " + JSON.stringify(j.offered) : ""), "err");
    return j;
  }).catch((e) => { add(logEl, "[" + path + " failed] " + e.message, "err"); return { error: e.message }; });
}

function add(el, text, cls) {
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const d = document.createElement("div");
  d.className = "row " + (cls || "");
  d.textContent = text;
  el.appendChild(d);
  if (atBottom) el.scrollTop = el.scrollHeight;
  while (el.childElementCount > 1200) el.removeChild(el.firstChild);
}

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  return JSON.stringify(content);
}

// ── local state, mirrored from the server ──────────────────────────────
// The server is the authority on every one of these. The page never decides
// that a mode changed or an effort took; it renders what it was told.
let state = { sessions: [], state: "?", openInteractions: [] };
let active = null;
let roster = [];

function renderState(s) {
  state = s;
  const t = $("sessions");
  t.replaceChildren();
  if (!s.sessions.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "dim";
    td.textContent = "none yet — create one, or load one from the roster below";
    tr.appendChild(td);
    t.appendChild(tr);
  } else {
    const head = document.createElement("tr");
    for (const h of ["", "sessionId", "cwd", "how", "live", "turn", "mode (confirmed)",
                     "model", "effort", "cmds", "live ev", "replayed ev"]) {
      const th = document.createElement("th");
      th.textContent = h;
      head.appendChild(th);
    }
    t.appendChild(head);
    for (const x of s.sessions) {
      const tr = document.createElement("tr");
      const pick = document.createElement("input");
      pick.type = "radio"; pick.name = "active"; pick.checked = x.sessionId === active;
      pick.onchange = () => setActive(x.sessionId);
      const td = document.createElement("td"); td.appendChild(pick); tr.appendChild(td);
      const cells = [x.sessionId, x.cwd, x.acquired, x.live ? "yes" : "NO",
        x.turnInFlight ? "running" : "-", x.confirmedModeId === null ? "—" : x.confirmedModeId,
        x.modelId || "?", x.reasoningEffort || "?", x.commandCount === null ? "—" : x.commandCount,
        x.liveEvents, x.replayedEvents];
      for (const c of cells) {
        const d = document.createElement("td"); d.textContent = String(c); tr.appendChild(d);
      }
      t.appendChild(tr);
    }
    if (!s.sessions.some((x) => x.sessionId === active)) setActive(s.sessions[0].sessionId);
  }
  fillChannelPickers();
  renderActive();
  $("status").textContent = "agent " + s.state
    + (s.pid ? " (pid " + s.pid + ")" : "")
    + (s.restarts ? "  respawns: " + s.restarts : "")
    + (s.failure ? "  — " + s.failure : "");
  $("status").className = s.state === "ready" ? "ok" : "err";
}

function setActive(id) { active = id; renderActive(); }

function renderActive() {
  const rec = state.sessions.find((x) => x.sessionId === active) || null;
  $("active").textContent = rec ? rec.sessionId + "   (" + rec.cwd + ")" : "(none)";
  $("confirmedmode").textContent = rec ? (rec.confirmedModeId === null ? "never confirmed" : rec.confirmedModeId) : "—";
  $("readback").textContent = rec ? ((rec.modelId || "?") + " / " + (rec.reasoningEffort || "?")) : "—";

  // The model list and the effort list come off the agent's own session/new
  // response. Nothing here is a hardcoded table of models or effort levels.
  const models = (rec && rec.models && rec.models.availableModels) || [];
  const mSel = $("modelid");
  mSel.replaceChildren();
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m.modelId; o.textContent = m.name || m.modelId;
    mSel.appendChild(o);
  }
  if (rec && rec.models && rec.models.currentModelId) mSel.value = rec.models.currentModelId;

  const efforts = (models.find((m) => m.modelId === mSel.value) || {})._meta;
  const eSel = $("effort");
  eSel.replaceChildren();
  const none = document.createElement("option");
  none.value = ""; none.textContent = "(leave alone)";
  eSel.appendChild(none);
  for (const e of (efforts && efforts.reasoningEfforts) || []) {
    const o = document.createElement("option");
    o.value = e.value || e.id;
    o.textContent = (e.label || e.id) + (e.default ? " [default]" : "");
    eSel.appendChild(o);
  }
}
$("modelid").onchange = renderActive;

function fillChannelPickers() {
  for (const which of ["A", "B"]) {
    const sel = $("chan" + which);
    const had = sel.value;
    sel.replaceChildren();
    const all = document.createElement("option");
    all.value = ""; all.textContent = "(everything)";
    sel.appendChild(all);
    for (const x of state.sessions) {
      const o = document.createElement("option");
      o.value = x.sessionId; o.textContent = x.sessionId.slice(0, 13) + "… " + x.cwd;
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === had)) sel.value = had;
  }
}

async function refreshState() { renderState(await post("/state")); }

// ── rendering an AppEvent ──────────────────────────────────────────────
//
// NOT ONE WIRE-FORMAT KIND NAME APPEARS BELOW. This page reads AppEvent.type,
// which is ours, and studio/events.ts is the only thing that knows what the
// agent actually called it. That is BUILD-PLAN WP3 trap 7 in practice: the
// moment one of the agent's own discriminator strings appears in this file, the
// wire format has leaked into the app and the next CLI release breaks it here,
// silently. The grep that checks this is in docs/APP-EVENTS.md.
//
// Anything unrecognised still prints, with its raw payload.

// WP3 trap 5. A replayed event is history: it is prefixed, greyed, and it never
// drives a state change, a card, or a scroll. Untagged, a session/load would
// re-fire last week's permission prompts as if they were live.
function historical(ev) {
  return ev.replay || ev.delivery === "reconstruction" || ev.deliveryResolved === true;
}
function tag(ev) {
  if (ev.replay) return "[upstream history] ";
  if (ev.delivery === "reconstruction") return "[page reconstruction] ";
  if (ev.delivery === "catchup") return "[reconnect catch-up] ";
  if (ev.delivery === "current") return "[current state] ";
  return "";
}
function cls(ev, base) { return historical(ev) ? "replay" : (base || ""); }

function renderAppEvent(ev, el) {
  const d = ev.data || {};
  el = el || logEl;

  // A normaliser that could not find a field it expected. Louder than the event.
  if (ev.missing && ev.missing.length) {
    add(el, "[WIRE FORMAT CHANGED?] " + ev.type + " — " + ev.note, "err");
  }

  switch (ev.type) {
    case "message.thinking": add(el, tag(ev) + "[thinking] " + (d.text || ""), cls(ev, "thought")); return;
    case "message.assistant": add(el, tag(ev) + "[agent] " + (d.text || ""), cls(ev)); return;
    case "message.user": add(el, tag(ev) + "[user] " + (d.text || ""), cls(ev)); return;

    case "tool.started":
    case "tool.updated": {
      const t = d.tool || {};
      // read_only is the decision-relevant bit. null means "the agent did not
      // say", which is not the same claim as "safe".
      const ro = t.readOnly === true ? "read-only" : t.readOnly === false ? "WRITES" : "read-only unknown";
      add(el, tag(ev)
        + "[" + (ev.type === "tool.started" ? "tool" : "tool update") + "] "
        + (t.label || d.title || t.name || "(untitled)")
        + "  " + ro
        + "  status=" + (d.status === null ? "(not started)" : d.status)
        + "  id=" + (d.toolCallId || "?")
        + (d.content ? "\n" + textOf(d.content) : (d.rawInput ? "\n" + JSON.stringify(d.rawInput) : "")),
        cls(ev, "tool"));
      return;
    }
    case "tool.arguments_delta": return; // streaming noise; the tool card covers it

    case "mode.changed":
      // The ONLY thing that means a mode changed. And on a plan exit it echoes
      // back whatever id was sent, so this says "plan mode was entered or left",
      // not "that id is a real mode".
      add(el, tag(ev) + "[mode] the agent says the mode is now '" + d.modeId + "'", cls(ev, "warn"));
      if (!historical(ev)) refreshState();
      return;
    case "commands.updated":
      /* count === null is the UNREADABLE reading, never zero (WP7 §2). */
      add(el, tag(ev) + "[commands] " + (d.count === null
        ? "UNREADABLE — the update carried no command array"
        : d.count + " available")
        + (d.toolNames ? "  tools: " + d.toolNames.length : ""), cls(ev, d.count === null ? "warn" : ""));
      if (!historical(ev)) refreshState();
      return;
    case "session.titled": add(el, tag(ev) + "[session title] " + d.title, cls(ev)); return;
    case "model.changed":
      add(el, tag(ev) + "[model] " + d.modelId + (d.reasoningEffort ? "  effort=" + d.reasoningEffort : ""), cls(ev));
      return;

    // Advisory only. It does NOT mean the human is about to be asked — see the
    // long comment in studio/events.ts. Logged, never used to drive a "waiting
    // on you" state; the reverse request does that.
    case "interaction.pending":
    case "interaction.resolved":
      add(el, tag(ev) + "[interaction " + (ev.type === "interaction.pending" ? "opened" : "resolved")
        + " — advisory] " + (d.interactionKind || "") + " " + (d.toolCallId || ""), cls(ev, "thought"));
      return;

    case "turn.completed": {
      const u = d.usage || {};
      const cost = u.costUsd === null || u.costUsd === undefined
        ? "cost not reported"
        : "$" + u.costUsd.toFixed(6) + " (" + u.costUsdTicks + " ticks)";
      add(el, tag(ev) + "[turn completed] stopReason=" + d.stopReason
        + "  " + cost
        + "  in=" + u.inputTokens + " out=" + u.outputTokens
        + " cached=" + u.cachedReadTokens + " reasoning=" + u.reasoningTokens
        + "  calls=" + u.modelCalls + "  " + u.apiDurationMs + "ms"
        + (u.usageIsIncomplete ? "  [AGENT SAYS THIS BILL MAY UNDER-COUNT]" : ""),
        cls(ev, "warn"));
      return;
    }

    case "git.head_changed": add(el, tag(ev) + "[git] HEAD moved — " + JSON.stringify(ev.raw), cls(ev)); return;

    // A hint, not a payload. The server re-reads sessions/list when this fires.
    case "sessions.changed": add(el, tag(ev) + "[roster changed] re-reading sessions/list", cls(ev, "dim")); return;

    default:
      // Known-but-unmodelled, unknown kinds, and everything else. Never dropped.
      add(el, tag(ev) + "[" + ev.type + (ev.wireKind ? " / " + ev.wireKind : "") + "] "
        + (ev.note ? ev.note + " " : "")
        + JSON.stringify(ev.modelled ? d : ev.raw),
        ev.type.indexOf("wire.") === 0 ? "err" : cls(ev));
  }
}

function renderInteraction(ev) {
  const d = ev.data || {};
  const existing = document.getElementById("perm-" + d.key);
  if (existing) return;
  const box = document.createElement("div");
  box.className = "perm";
  box.id = "perm-" + d.key;

  // Built as elements and text nodes rather than as an HTML string. `ev.type` is
  // ours and `ev.sessionId` is the agent's, and the difference does not matter:
  // this page holds the run token and answers permission requests, so nothing
  // that arrived over the wire is concatenated into markup here. AGENTS.md rule
  // 10 / D31.
  const head = document.createElement("div");
  const strong = document.createElement("span");
  strong.className = "k";
  strong.textContent = "AGENT IS WAITING ON YOU";
  head.appendChild(strong);
  head.appendChild(document.createTextNode(" — " + ev.type + " "));
  const who = document.createElement("span");
  who.className = "dim";
  who.textContent = "session " + (ev.sessionId || "?");
  head.appendChild(who);
  box.appendChild(head);

  if (ev.note) {
    const n = document.createElement("div");
    n.textContent = ev.note;
    box.appendChild(n);
  }

  // The most decision-relevant line on the card, and the one the design spec
  // does not have: is this about to change files?
  const t = d.tool || null;
  if (t) {
    const w = document.createElement("div");
    w.className = t.readOnly === false ? "warn" : "";
    w.textContent = t.readOnly === false
      ? "⚠ THIS WILL CHANGE YOUR FILES — " + (t.label || t.name)
      : t.readOnly === true
        ? "Read-only — " + (t.label || t.name)
        : "The agent did not say whether this writes — " + (t.label || t.name);
    box.appendChild(w);
  }

  const detail = document.createElement("div");
  detail.textContent = d.planContent
    ? d.planContent
    : (d.title || "(no title)") + "\n" + JSON.stringify(d.rawInput || d.questions || {}, null, 2);
  box.appendChild(detail);

  const btns = document.createElement("div");
  // The agent's own option labels. Nothing invented here.
  (d.options || []).forEach((opt) => {
    const b = document.createElement("button");
    b.textContent = opt.name;       // the agent's label, verbatim
    b.onclick = () => {
      btns.querySelectorAll("button").forEach(x => x.disabled = true);
      post("/permission", { key: d.key, optionId: opt.optionId });
    };
    btns.appendChild(b);
    btns.appendChild(document.createTextNode(" "));
  });
  if (!(d.options || []).length) {
    const n = document.createElement("div");
    n.className = "err";
    n.textContent = "No options to offer — this build cannot answer this request and has refused it. "
      + "The agent is unblocked; what it wanted is in the raw JSON below.";
    btns.appendChild(n);
  }
  box.appendChild(btns);

  const raw = document.createElement("details");
  const sum = document.createElement("summary");
  sum.textContent = "raw request JSON";
  raw.appendChild(sum);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(ev.raw, null, 2);
  raw.appendChild(pre);
  box.appendChild(raw);

  permsEl.appendChild(box);
  add(logEl, "[waiting on you] " + ev.type + " — " + (d.options || []).length + " option(s): "
    + (d.options || []).map(o => o.name).join(" | "));
}

// ── the unfiltered stream ──────────────────────────────────────────────

if (!TOKEN_OK) {
  $("status").textContent =
    "NO TOKEN — this page was not served by the studio (opened from disk?). "
    + "Every request will be refused. Use the URL the server printed at startup.";
  $("status").className = "err";
}

// Every frame on this stream is an AppEvent — see docs/APP-EVENTS.md. There is
// no other frame shape and no raw ACP object anywhere on it.
function handle(ev, el) {
  const d = ev.data || {};
  el = el || logEl;

  switch (ev.type) {
    case "bridge.log": {
      const k = d.logKind;
      const w = el === logEl ? wireEl : el;
      // bridge.log is the AGENT-WIDE narration rail. It is unscoped on purpose —
      // process lifecycle and parse failures belong to no single session — so
      // every channel gets it, including a scoped one. But its TEXT frequently
      // names a session, and on a scoped pane an unlabelled line about some
      // other session reads exactly like a leak. Say which rail it came from.
      // Nothing is hidden; the distinction is just made visible.
      const p = el === logEl ? "" : "[agent-wide] ";
      if (k === "wire-in") add(w, p + "<-- " + d.text);
      else if (k === "wire-out") add(w, p + "--> " + d.text);
      else if (k === "stderr") { add(w, p + "[stderr] " + d.text, "err"); add(el, p + "[grok stderr] " + d.text, "err"); }
      else if (k === "error") { add(w, p + "[error] " + d.text, "err"); add(el, p + "[ERROR] " + d.text, "err"); }
      else add(el, p + "[" + k + "] " + d.text);
      return;
    }

    // The server replays a bounded tail, not the whole log. Say so on screen — a
    // log that silently begins in the middle is a log that lies about what
    // happened before it.
    case "bridge.replay_truncated":
      add(el, "[replay truncated] " + ev.note, "warn");
      return;

    case "bridge.reconstruction_truncated":
    case "bridge.catchup_truncated":
      add(el, "[retained history truncated] " + ev.note, "warn");
      return;

    case "bridge.reconstruction_finished":
    case "bridge.catchup_finished":
      if (el === logEl) {
        const current = new Set(d.currentInteractionKeys || []);
        document.querySelectorAll(".perm").forEach((box) => {
          const key = box.id.startsWith("perm-") ? box.id.slice(5) : "";
          if (!current.has(key)) box.remove();
        });
      }
      add(el, "[recovery handoff complete] " + ev.note, "ok");
      return;

    case "bridge.catchup_failed":
    case "bridge.session_load_failed":
      add(el, "[recovery failed] " + ev.note, "err");
      return;

    case "bridge.channel_open":
      add(el, "[channel " + d.channel + "] " + ev.note, "ok");
      if (el === logEl && d.agent) renderState(d.agent);
      return;

    case "bridge.channel_filtered":
      add(el, "[filtered] " + ev.note, "dim");
      return;

    case "bridge.agent_ready":
      add(el, "[agent ready] " + ev.note, "ok");
      refreshState();
      return;

    case "bridge.initialized": add(el, "[initialize returned]"); return;

    case "bridge.session_opened":
      add(el, "[session created] " + d.session.sessionId + "  cwd " + d.session.cwd, "ok");
      if (el === logEl) { active = d.session.sessionId; refreshState(); }
      return;

    case "bridge.session_loading": add(el, "[loading] " + ev.note, "warn"); return;

    case "bridge.session_loaded":
      // Untagged SETUP events are normal. Untagged HISTORY is trap 5 happening.
      add(el, "[loaded] " + ev.note, d.untaggedHistoryDuringLoad > 0 ? "err" : "ok");
      refreshState();
      return;

    case "bridge.unrouted_event": add(el, "[UNROUTED] " + ev.note, "err"); return;
    case "bridge.cancel_sent": add(el, "[cancel] " + ev.note, "warn"); return;

    case "bridge.mode_set_attempted":
      add(el, (d.verified ? "[mode set — confirmed] " : "[mode set — NOT CONFIRMED] ") + ev.note,
        d.verified ? "warn" : "err");
      refreshState();
      return;

    case "bridge.model_set_attempted":
      add(el, (d.matched ? "[model/effort set — verified] " : "[model/effort — MISMATCH] ") + ev.note,
        d.matched ? "ok" : "err");
      refreshState();
      return;

    case "bridge.sessions_listed":
      roster = d.sessions || [];
      $("rostercount").textContent = d.count;
      $("rosterours").textContent = d.ours;
      renderRoster();
      return;

    case "bridge.commands_listed":
      add(el, "[commands/list] " + d.count + " command(s) for "
        + (d.sessionId || "(no session — global list)")
        + "\n" + (d.commands || []).map(c => "  /" + c.name + "  " + (c.description || "")).join("\n"));
      return;

    case "bridge.context_reading":
      if (el === logEl) $("ctx").textContent = "context (" + ev.sessionId + "): " + d.summary;
      add(el, "[context] " + ev.sessionId + " — " + d.summary);
      return;

    case "bridge.session_info_empty":
    case "bridge.session_info_mismatch":
      add(el, "[session/info] " + ev.note, "err");
      return;

    case "bridge.compacted": add(el, "[compact] " + ev.note, d.usedAfter < d.usedBefore ? "ok" : "err"); return;

    case "bridge.agent_gone":
      add(el, "[AGENT GONE] " + ev.note, "err");
      if (el === logEl) {
        $("status").textContent = "AGENT PROCESS GONE — " + ev.note;
        $("status").className = "err";
        document.querySelectorAll(".perm").forEach(x => x.remove());
      }
      return;

    case "bridge.respawning": add(el, "[respawning] " + ev.note, "warn"); return;
    case "bridge.respawned":
      add(el, "[respawned] " + ev.note, (d.failed || []).length ? "err" : "ok");
      refreshState();
      return;
    case "bridge.respawn_failed":
    case "bridge.respawn_abandoned":
      add(el, "[RESPAWN FAILED] " + ev.note, "err");
      refreshState();
      return;

    case "bridge.fatal":
      add(el, "[FATAL] " + d.error, "err");
      if (el === logEl) { $("status").textContent = "FATAL: " + d.error; $("status").className = "err"; }
      return;

    case "turn.started": add(el, "[turn started] " + ev.sessionId, "warn"); refreshState(); return;
    case "turn.finished":
      add(el, "[turn finished] " + ev.sessionId + " stopReason=" + d.stopReason, ev.note ? "err" : "");
      if (ev.note) add(el, ev.note, "err");
      refreshState();
      return;
    case "turn.failed": add(el, "[turn failed] " + ev.sessionId + " " + d.error, "err"); refreshState(); return;

    case "interaction.permission_requested":
    case "interaction.plan_approval_requested":
    case "interaction.question_asked":
    case "interaction.unhandled_request":
      // `refusedWith` means the server has ALREADY answered this with an error,
      // so the agent is not waiting on anybody. Rendering it as a waiting card
      // would be a lie with a button on it.
      if (d.refusedWith !== undefined) {
        add(el, "[REFUSED — the agent asked us something this build cannot answer] "
          + ev.wireKind + "\n" + ev.note + "\n" + JSON.stringify(ev.raw, null, 2), "err");
      } else if (el === logEl && !historical(ev)) {
        renderInteraction(ev);
      } else {
        add(el, "[waiting on you] " + ev.type, "warn");
      }
      return;

    case "interaction.answered": {
      if (el === logEl && !historical(ev)) {
        const box = document.getElementById("perm-" + d.key);
        if (box) box.remove();
      }
      add(el, "[answered] " + (d.cancelled ? "cancelled" : d.optionId));
      return;
    }

    case "interaction.abandoned": {
      if (el === logEl && !historical(ev)) {
        const box = document.getElementById("perm-" + d.key);
        if (box) box.remove();
      }
      add(el, "[abandoned] " + d.reason, "err");
      return;
    }

    default:
      renderAppEvent(ev, el);
  }
}

const es = new EventSource("/events?token=" + encodeURIComponent(TOKEN));
es.onerror = () => {
  $("status").textContent = TOKEN_OK
    ? "event stream DISCONNECTED"
    : "event stream REFUSED — no token; use the URL the server printed";
  $("status").className = "err";
};
es.onmessage = (e) => handle(JSON.parse(e.data), logEl);

// ── the two per-session channels ───────────────────────────────────────
// Separate EventSources with a `session` parameter. This is where "each session
// streams to its own channel" is visible: a channel scoped to session A shows
// nothing belonging to session B. It also counts anything it filtered, so an
// idle channel and a broken one are distinguishable.

const chans = {};
function openChannel(which) {
  const sel = $("chan" + which), pane = $("pane" + which), stat = $("stat" + which);
  if (chans[which]) { chans[which].close(); }
  pane.replaceChildren();
  const sid = sel.value;
  const url = "/events?token=" + encodeURIComponent(TOKEN) + (sid ? "&session=" + encodeURIComponent(sid) : "");
  const src = new EventSource(url);
  chans[which] = src;
  stat.textContent = sid ? "open — " + sid.slice(0, 13) + "…" : "open — everything";
  stat.className = "ok";
  src.onerror = () => { stat.textContent = "DISCONNECTED"; stat.className = "err"; };
  src.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    // Prove the routing on screen: a scoped channel must never show an event
    // stamped with a different session id.
    if (sid && ev.sessionId && ev.sessionId !== sid) {
      add(pane, "[LEAK] an event for " + ev.sessionId + " arrived on the channel for " + sid, "err");
    }
    handle(ev, pane);
  };
}
$("openA").onclick = () => openChannel("A");
$("openB").onclick = () => openChannel("B");

// ── the roster ─────────────────────────────────────────────────────────

function renderRoster() {
  const el = $("rosterpane");
  el.replaceChildren();
  const hide = $("onlyloadable").checked;
  const held = new Set(state.sessions.filter(s => s.live).map(s => s.sessionId));
  let shown = 0;
  for (const s of roster) {
    if (hide && held.has(s.sessionId)) continue;
    shown++;
    const d = document.createElement("div");
    d.className = "row";
    const b = document.createElement("button");
    b.textContent = "load";
    b.onclick = () => { b.disabled = true; post("/session/load", { sessionId: s.sessionId, cwd: s.cwd }); };
    d.appendChild(b);
    d.appendChild(document.createTextNode(
      " " + (held.has(s.sessionId) ? "[HELD HERE] " : "")
      + s.activity + (s.resident ? "/resident" : "") + "  "
      + (s.title || "(untitled)") + "  " + s.cwd
      + "  [" + s.modelId + "/" + (s.reasoningEffort || "?") + "]  " + s.sessionId));
    el.appendChild(d);
  }
  if (!shown) el.textContent = "(nothing to show)";
}
$("onlyloadable").onchange = renderRoster;

// ── the controls ───────────────────────────────────────────────────────

function needActive() {
  if (!active) { add(logEl, "[no active session] create or load one first", "err"); return false; }
  return true;
}

$("new").onclick = () => post("/session/new", { cwd: $("newcwd").value.trim() || undefined });
$("refreshstate").onclick = refreshState;
$("roster").onclick = () => post("/sessions/list");
$("cancel").onclick = () => needActive() && post("/session/cancel", { sessionId: active });
$("info").onclick = () => needActive() && post("/session/info", { sessionId: active });
$("compact").onclick = () => needActive() && post("/session/compact", { sessionId: active });
$("cmds").onclick = () => post("/commands/list", { sessionId: active || undefined });
$("setmode").onclick = () => needActive() && post("/session/mode", { sessionId: active, modeId: $("modeid").value });
$("setmodel").onclick = () => needActive() && post("/session/model", {
  sessionId: active, modelId: $("modelid").value, reasoningEffort: $("effort").value || undefined,
});
$("send").onclick = () => {
  if (!needActive()) return;
  const text = $("prompt").value;
  add(logEl, "[you -> " + active + "] " + text);
  post("/prompt", { sessionId: active, text });
};

refreshState();
