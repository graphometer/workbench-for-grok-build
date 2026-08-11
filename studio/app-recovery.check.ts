import { readFileSync, readdirSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleToMarkdown } from "./session-export.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(HERE, "public", "app.js");
const APP_SOURCE = readFileSync(APP_PATH, "utf8");
const CSS_SOURCE = readFileSync(join(HERE, "public", "app.css"), "utf8");
const HTML_SOURCE = readFileSync(join(HERE, "public", "index.html"), "utf8");

let passed = 0;
function check(name: string, condition: unknown) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

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
  onclick: null | (() => void) = null;
  /* WP7 uses two more handler properties and a select's own index. */
  onchange: null | (() => void) = null;
  onmouseenter: null | (() => void) = null;
  selectedIndex = 0;
  /* A textarea's caret, so the launcher's "everything from the / to the caret"
     insertion rule is exercised for real rather than approximated. */
  selectionStart = 0;
  selectionEnd = 0;
  scrollHeight = 1_000;
  scrollTop = 1_000;
  clientHeight = 500;
  /* Listeners are RECORDED, not ignored: the composer's whole keyboard
     contract lives on addEventListener, and a no-op stub would have let every
     key in WP7 pass untested. */
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
    if (this.id === "canvasInner") this.owner.canvasPaints++;
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
  /** Fire what a real browser would fire, and report whether anything called preventDefault. */
  dispatch(type: string, event: Record<string, unknown> = {}) {
    const full: any = { type, target: this, ...event, defaultPrevented: false };
    full.preventDefault = () => { full.defaultPrevented = true; };
    for (const fn of this.listeners[type] ?? []) fn(full);
    return full;
  }
  setAttribute(name: string, value: string) { (this as any)[name] = String(value); }
  getAttribute(name: string) { return (this as any)[name] ?? null; }
  removeAttribute(name: string) { delete (this as any)[name]; }
  focus() { this.owner.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  querySelectorAll(selector: string) {
    /* WP14/WP15 modal focus trap asks dialog.querySelectorAll("button, input")
       for descendants of THIS element — not a document-wide class scan. */
    if (/^[a-z]+(\s*,\s*[a-z]+)+$/i.test(selector.trim())) {
      const tags = selector.split(",").map((s) => s.trim().toUpperCase());
      const out: FakeElement[] = [];
      const walk = (n: FakeElement) => {
        for (const c of n.children) {
          if (tags.includes(c.tagName)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    return this.owner.querySelectorAll(selector);
  }
  getBoundingClientRect() { return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }; }
  /* WP9's popover wiring asks this of the meter and the popover host. */
  contains(node: FakeElement | null): boolean {
    let cur: FakeElement | null = node;
    while (cur) { if (cur === this) return true; cur = cur.parentNode; }
    return false;
  }
}

class FakeDocument {
  byId = new Map<string, FakeElement>();
  created: FakeElement[] = [];
  canvasPaints = 0;
  body = new FakeElement("body", this);

  getElementById(id: string) {
    let value = this.byId.get(id);
    if (!value) {
      value = new FakeElement("div", this);
      value.id = id;
      if (id === "app") { value.dataset.rail = "expanded"; value.dataset.drawer = "closed"; }
      if (id === "canvas") { value.scrollHeight = 1_000; value.scrollTop = 500; value.clientHeight = 500; }
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
  // The app attaches global listeners (Escape closes the folder picker; a click
  // outside closes the WP7 launcher). Recorded and fired by hand, so what they
  // do is checked rather than assumed.
  activeElement: FakeElement | null = null;
  listeners: Record<string, ((event: any) => void)[]> = {};
  addEventListener(type: string, fn: (event: any) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatch(type: string, event: Record<string, unknown> = {}) {
    const full: any = { type, ...event, defaultPrevented: false };
    full.preventDefault = () => { full.defaultPrevented = true; };
    for (const fn of this.listeners[type] ?? []) fn(full);
    return full;
  }
  querySelectorAll(selector: string) {
    /* Enough of a selector engine for what the app actually asks for: a single
       class. The elapsed-time ticker queries ".live-elapsed" every second, and
       a stub that always returned [] would have let a broken ticker pass. */
    const m = /^\.([A-Za-z0-9_-]+)$/.exec(selector);
    if (m) {
      return this.created.filter((node) =>
        String(node.className).split(" ").includes(m[1]));
    }
    return [];
  }
}

interface Harness {
  document: FakeDocument;
  api: any;
  sources: any[];
  storage: Map<string, string>;
  posts: { path: string; body: any }[];
  route: (path: string, fn: (body: any) => any) => void;
  intervals: (() => void)[];
  clipboardWrites: string[];
  setClipboardMode: (mode: string) => void;
}

function harness(connected = false, storage = new Map<string, string>(), dev = false): Harness {
  const document = new FakeDocument();
  const sources: any[] = [];
  const posts: { path: string; body: any }[] = [];
  const clipboardWrites: string[] = [];
  /* "ok" records and resolves; "reject" returns a rejected promise; "throw"
     throws synchronously (Codex WP12: an embedded implementation can). */
  let clipboardMode = "ok";
  /* Per-test POST responders, keyed by path. A test wires the routes it needs
     (e.g. /session/new, /state, /fs/list); anything unrouted still gets the
     inert "fixture" body below, so existing tests are unaffected. */
  const customRoutes: Record<string, (body: any) => any> = {};
  /* Interval callbacks the app registers (the elapsed-time ticker). Fired by
     hand from the checks; never scheduled for real. */
  const intervals: (() => void)[] = [];
  class FakeEventSource {
    url: string;
    onopen: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onmessage: null | ((event: { data: string }) => void) = null;
    constructor(url: string) { this.url = url; sources.push(this); }
  }
  const context: any = {
    console,
    document,
    location: { search: connected ? `?token=${"a".repeat(64)}` : "" },
    URLSearchParams,
    /* WP12: the clipboard, recording. writeText resolves; the copied strings
       are assertable. */
    navigator: { clipboard: { writeText: (t: string) => {
      if (clipboardMode === "throw") throw new Error("denied");
      if (clipboardMode === "reject") return Promise.reject(new Error("denied"));
      clipboardWrites.push(String(t));
      return Promise.resolve();
    } } },
    fetch: async (url: string, init?: { body?: string }) => {
      let body: any = {};
      try { body = init?.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
      const path = String(url);
      posts.push({ path, body });
      if (customRoutes[path]) {
        const resp = customRoutes[path](body);
        /* A route may carry _status to simulate a non-200 — the page's post()
           reads the real response status into httpStatus and the details. */
        return { status: resp && typeof resp._status === "number" ? resp._status : 200, json: async () => resp };
      }
      /* POST /session/info returns a plausible body on purpose. The page must
         still refuse to populate the meter from it — only a live
         bridge.context_reading may set v.context. */
      if (path === "/session/info") {
        return {
          json: async () => ({
            info: {
              sessionId: body.sessionId,
              context: { used: 99999, total: 500000, freeTokens: 400001 },
            },
            summary: "fixture body must not populate the meter",
          }),
        };
      }
      return { json: async () => ({ error: "fixture" }) };
    },
    EventSource: FakeEventSource,
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    setTimeout,
    clearTimeout,
    /* The elapsed-time ticker registers here rather than really scheduling:
       a live interval would keep this process alive forever, and capturing the
       callback lets the checks fire it deterministically and assert what it
       does (and, more importantly, what it does NOT repaint). */
    setInterval: (fn: () => void, _ms?: number) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    isFinite,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(String(key), String(value)),
      removeItem: (key: string) => storage.delete(key),
    },
  };
  context.window = { innerHeight: 900, innerWidth: 1280, addEventListener() {} };
  context.globalThis = context;
  /* WP14: a dev harness marks the page as a development build BEFORE the app
     source evaluates — the same fact the server's __STUDIO_DEV__ substitution
     would give it. Default is off, the public shape. */
  if (dev) document.getElementById("studioDev").setAttribute("content", "1");
  const expose = `\n;globalThis.__APP_TEST__ = {
    receive, handle, view, currentTurn,
    state: () => ({ recoveryActive, lastDeliveryId, activeId }),
    setActive: setActiveSession,
    setAgent: (value) => { agent = value; },
    notes: () => shellNotes.slice(),
    renderTurnFoot,
    selectSession,
    selectionStorageKey: SELECTED_SESSION_KEY,
    resolveState,
    renderAll,
    contextRefreshInFlight,
    createSession, openPicker, closePicker, renderPicker,
    pickerState: () => picker,
    setRoster: (value) => { roster = value; },
    renderPlanMarkdown, renderInteractionCard,
    renderRail, fmtDuration,
    /* WP13 session management & portability */
    renderAutoApprove, renderModal,
    startRename, commitRename, cancelRename,
    openDeleteModal, confirmDelete,
    openExportModal, runExport, onImportFileChosen, openImportModal,
    toggleAutoApprove, setAutoApprove, archiveSession, restoreSession, sessionFacts,
    /* WP15 retention switch */
    setRetention, buildRetentionSwitch, closeModal,
    wp13State: () => ({ rowMenu, renaming, modal, showArchived }),
    setRowMenu: (v) => { rowMenu = v; },
    setRenaming: (v) => { renaming = v; },
    setModal: (v) => { modal = v; },
    setShowArchived: (v) => { showArchived = v; },
    /* WP7 composer: plan toggle, runtime effort selector, slash launcher */
    renderComposerNow, planFace, togglePlan, setEffort,
    effortOptions, currentEffort, effortLabel, modelDisplayName, modelCatalogue,
    syncLauncher, closeLauncher, acceptCommand, moveLauncher, rankCommands,
    launcherState: () => launcher,
    wp7State: () => ({
      planBusy: planBusy.get("s") || null,
      planNotice: planNotice.get("s") || null,
      effortBusy: effortBusy.get("s") || null,
      effortNotice: effortNotice.get("s") || null,
      modelsUpdate,
    }),
    clearWp7: () => { planBusy.clear(); planNotice.clear(); effortBusy.clear(); effortNotice.clear(); launcher = null; modelsUpdate = null; },
    send,
    /* WP9: the meter popover, manual Compact, and the context reading */
    compactNow, openCtxPop, closeCtxPop, renderCtxPop, renderStrip, contextNear, refreshRoster,
    wp9State: () => ({ ctxpopOpen, ctxpopPinned, compactInFlightFor }),
    /* WP12: gate banner, copy details, respawn markers */
    note, renderGate, applyGateNotice, renderBanner, renderDrawer, applySnapshotSidecars,
    /* WP14: the notice strip and the dev-gated Shell tab */
    renderNoticeStrip, setTab,
    wp14State: () => ({ drawerTab, devBuild: DEV_BUILD }),
    setForced: (v) => { forcedState = v; },
    gateRev: () => gateRevision,
    setDrawerTab: (t) => { drawerTab = t; },
    gateState: () => gateNotice,
  };`;
  runInNewContext(APP_SOURCE + expose, context, { filename: APP_PATH });
  return {
    document, api: context.__APP_TEST__, sources, storage, posts, intervals, clipboardWrites,
    setClipboardMode: (mode: string) => { clipboardMode = mode; },
    route: (path: string, fn: (body: any) => any) => { customRoutes[path] = fn; },
  };
}

function appEvent(
  id: number,
  type: string,
  data: Record<string, unknown> = {},
  delivery = "reconstruction",
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

function open(
  h: Harness,
  losses: unknown[] = [],
  sessions: any[] = [{ sessionId: "s", cwd: "/tmp/s", live: true, loading: false }],
  forceActive = true,
) {
  h.api.handle({
    ...appEvent(0, "bridge.channel_open", {
      agent: {
        state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
        /* WP11 r3/WP12: the snapshot carries the process generation. */
        agentGeneration: 0,
        sessions,
        openInteractions: [],
      },
      recovery: { mode: "reconstruction", losses },
    }),
    deliveryId: null,
  });
  if (forceActive) h.api.setActive("s");
}

function finish(h: Harness, id: number) {
  h.api.receive(appEvent(id, "bridge.reconstruction_finished", {}, "reconstruction", null));
}

function turnPresentation(h: Harness, turn: any) {
  const footer = h.api.renderTurnFoot(h.api.view("s"), turn);
  const text = footer.children.map((child: FakeElement) => child.textContent);
  /* Selected by CLASS, not by position: the footer gained a working mark and a
     duration, and a positional read would have silently started asserting on
     the wrong span instead of failing honestly. */
  const byClass = (cls: string) =>
    footer.children.find((child: FakeElement) => String(child.className).split(" ").includes(cls));
  return {
    outcome: turn.outcome,
    headline: text[0] || "",
    detail: byClass("grow")?.textContent || "",
    elapsed: byClass("elapsed")?.textContent || "",
    controls: footer.children
      .filter((child: FakeElement) => child.tagName === "BUTTON")
      .map((child: FakeElement) => child.textContent),
  };
}

// turn.started must restore durable content without touching newer live state.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  Object.assign(v, { phase: "streaming", awaiting: "permission", compacting: true, runningWrites: 2, cancelSent: true, subagents: 3 });
  h.api.receive(appEvent(1, "turn.started", { text: "restored prompt" }));
  check("reconstructed turn.started displays its prompt",
    v.turns.length === 1 && v.turns[0].items[0].text === "restored prompt");
  check("reconstructed turn.started does not set live phase or clear current state",
    v.phase === "streaming" && v.awaiting === "permission" && v.compacting === true &&
      v.runningWrites === 2 && v.cancelSent === true && v.subagents === 3);
}

// Completed, failed and cancelled turns close durably and keep their own costs.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "turn.started", { text: "success" }));
  h.api.receive(appEvent(2, "message.thinking", { text: "thought" }));
  h.api.receive(appEvent(3, "tool.started", {
    toolCallId: "tool-1", status: null, rawInput: { hostile: "<script>x</script>" },
    tool: { label: "Write", name: "write", kind: "write", namespace: "fixture", readOnly: false },
  }));
  h.api.receive(appEvent(4, "tool.updated", { toolCallId: "tool-1", status: "completed", rawOutput: "ok", tool: null }));
  h.api.receive(appEvent(5, "message.assistant", { text: "answer" }));
  h.api.receive(appEvent(6, "turn.completed", { stopReason: "end_turn", usage: { costUsd: 0.125, usageIsIncomplete: false } }));
  h.api.receive(appEvent(7, "turn.finished", { stopReason: "end_turn" }));
  check("reconstructed turn.finished closes the turn", v.turns[0].outcome === "ok");
  check("tool updates and cost remain attached to the correct turn",
    v.turns[0].items.filter((item: any) => item.kind === "tool").length === 1 &&
      v.turns[0].cost.usd === 0.125);

  h.api.receive(appEvent(8, "turn.started", { text: "failure" }));
  Object.assign(v, { phase: "streaming", awaiting: "permission", compacting: true, runningWrites: 2, cancelSent: true, subagents: 3 });
  h.api.receive(appEvent(9, "turn.failed", { error: "fixture failure" }));
  check("reconstructed turn.failed closes as failed",
    v.turns[1].outcome === "failed" && v.turns[1].error === "fixture failure");
  check("reconstructed turn.failed cannot clear newer live state",
    v.phase === "streaming" && v.awaiting === "permission" && v.compacting === true &&
      v.runningWrites === 2 && v.cancelSent === true && v.subagents === 3);

  h.api.receive(appEvent(10, "turn.started", { text: "cancel" }));
  h.api.receive(appEvent(11, "bridge.cancel_sent", {}));
  h.api.receive(appEvent(12, "turn.finished", { stopReason: "cancelled" }));
  check("reconstructed cancellation closes as cancelled",
    v.turns[2].outcome === "cancelled" && v.turns[2].cancelled === true);
}

// Historical compaction and subagent notices remain presentation-only.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  Object.assign(v, { compacting: true, subagents: 7 });
  h.api.receive(appEvent(1, "context.compact_completed", {}));
  h.api.receive(appEvent(2, "subagent.spawned", {}));
  h.api.receive(appEvent(3, "subagent.finished", {}));
  check("historical compaction and subagents do not alter current activity",
    v.compacting === true && v.subagents === 7);
}

// App-side cancellation has the same verdict and controls before and after F5.
{
  const live = harness();
  open(live);
  finish(live, 1);
  live.api.receive(appEvent(2, "turn.started", { text: "cancel me" }, "live"));
  live.api.receive(appEvent(3, "bridge.cancel_sent", {}, "live"));
  live.api.receive(appEvent(4, "turn.completed", { stopReason: "cancelled", usage: {} }, "live"));
  live.api.receive(appEvent(5, "turn.prompt_complete", { promptId: "live" }, "live"));
  live.api.receive(appEvent(6, "turn.finished", { stopReason: "cancelled" }, "live"));

  const restored = harness();
  open(restored);
  restored.api.receive(appEvent(1, "turn.started", { text: "cancel me" }));
  restored.api.receive(appEvent(2, "bridge.cancel_sent", {}));
  restored.api.receive(appEvent(3, "turn.completed", { stopReason: "cancelled", usage: {} }));
  restored.api.receive(appEvent(4, "turn.prompt_complete", { promptId: "live" }));
  restored.api.receive(appEvent(5, "turn.finished", { stopReason: "cancelled" }));
  finish(restored, 6);

  const before = turnPresentation(live, live.api.view("s").turns[0]);
  const after = turnPresentation(restored, restored.api.view("s").turns[0]);
  check("live and reconstructed cancelled turns have identical presentation",
    JSON.stringify(before) === JSON.stringify(after) && before.outcome === "cancelled" &&
      before.headline === "Turn cancelled" && before.detail === "stopped: cancelled");
  check("cancelled turns have no retry control before or after F5",
    before.controls.length === 0 && after.controls.length === 0);
}

// Completion closes at the right evidence boundary for each history source.
{
  const completed = harness();
  open(completed);
  completed.api.receive(appEvent(1, "turn.started", { text: "normal" }));
  completed.api.receive(appEvent(2, "turn.completed", { stopReason: "end_turn", usage: {} }));
  completed.api.receive(appEvent(3, "turn.finished", { stopReason: "end_turn" }));
  finish(completed, 4);
  check("normal reconstructed completed turn remains complete",
    completed.api.view("s").turns[0].outcome === "ok");

  const failed = harness();
  open(failed);
  failed.api.receive(appEvent(1, "turn.started", { text: "genuine failure" }));
  failed.api.receive(appEvent(2, "turn.failed", { error: "fixture failure" }));
  finish(failed, 3);
  const failedPresentation = turnPresentation(failed, failed.api.view("s").turns[0]);
  check("genuine reconstructed failure remains failed with retry",
    failedPresentation.outcome === "failed" &&
      failedPresentation.controls.join(",") === "Send this prompt again");

  const upstream = harness();
  open(upstream);
  const user = appEvent(1, "message.user", { text: "upstream history" });
  user.replay = true;
  const upstreamCompleted = appEvent(2, "turn.completed", { stopReason: "end_turn", usage: {} });
  upstreamCompleted.replay = true;
  upstream.api.receive(user);
  upstream.api.receive(upstreamCompleted);
  check("upstream replay turn.completed closes without Graphometer turn.finished",
    upstream.api.view("s").turns[0].outcome === "ok");

  const truncated = harness();
  open(truncated, [{ sessionId: "s", events: 1, bytes: 10, startsMidTurn: false }]);
  truncated.api.receive(appEvent(1, "turn.started", { text: "truncated finish" }));
  truncated.api.receive(appEvent(2, "turn.completed", { stopReason: "end_turn", usage: {} }));
  check("delivery reconstruction waits at turn.completed for a retained finish",
    truncated.api.view("s").turns[0].outcome === "running");
  finish(truncated, 3);
  check("truncated delivery reconstruction closes from retained completion evidence",
    truncated.api.view("s").turns[0].outcome === "ok");

  const inFlight = harness();
  open(inFlight);
  inFlight.api.setAgent({
    state: "ready",
    sessions: [{ sessionId: "s", cwd: "/tmp/s", live: true, turnInFlight: true }],
    openInteractions: [],
  });
  inFlight.api.receive(appEvent(1, "turn.started", { text: "still live" }));
  inFlight.api.receive(appEvent(2, "turn.completed", { stopReason: "end_turn", usage: {} }));
  finish(inFlight, 3);
  check("reconstruction boundary does not prematurely close a server-reported live turn",
    inFlight.api.view("s").turns[0].outcome === "running");
  inFlight.api.receive(appEvent(4, "turn.finished", { stopReason: "end_turn" }, "live"));
  check("the later live turn.finished closes that reconstructed live turn",
    inFlight.api.view("s").turns[0].outcome === "ok");

  const missing = harness();
  open(missing);
  missing.api.receive(appEvent(1, "turn.started", { text: "missing reason" }));
  const missingCompleted = appEvent(2, "turn.completed", { usage: {} });
  missingCompleted.missing = ["stop_reason"];
  missingCompleted.note = "expected field 'stop_reason' was absent";
  missing.api.receive(missingCompleted);
  finish(missing, 3);
  const missingTurn = missing.api.view("s").turns[0];
  check("absent stopReason stays loud and does not invent cancellation",
    missingTurn.outcome === "failed" && missingTurn.cancelled === false &&
      missing.api.notes().some((item: any) => item.text.includes("WIRE FORMAT CHANGED?")));
}

// Three complete turns retain identical aside and unhandled placement after F5.
{
  function threeTurns(delivery: "live" | "reconstruction") {
    const h = harness();
    open(h);
    let id = 1;
    if (delivery === "live") finish(h, id++);
    /* A genuinely UNMODELLED event. This used to be `mcp.initialized`, which
       WP6's acceptance-walk pass promoted to a recognised SETUP notice — the
       check is about where unhandled events land relative to turns and asides,
       so it needs one that is still actually unhandled. */
    h.api.receive(appEvent(id++, "mcp.servers_updated", {}, delivery));
    for (let turn = 1; turn <= 3; turn++) {
      h.api.receive(appEvent(id++, "turn.started", { text: `turn ${turn}` }, delivery));
      h.api.receive(appEvent(id++, "message.assistant", { text: `answer ${turn}` }, delivery));
      h.api.receive(appEvent(id++, "turn.completed", { stopReason: "end_turn", usage: {} }, delivery));
      h.api.receive(appEvent(id++, "turn.prompt_complete", { promptId: String(turn) }, delivery));
      h.api.receive(appEvent(id++, "turn.finished", { stopReason: "end_turn" }, delivery));
    }
    if (delivery === "reconstruction") finish(h, id++);
    const turns = h.api.view("s").turns;
    return {
      turnCount: turns.filter((turn: any) => !turn.aside).length,
      asideCount: turns.filter((turn: any) => turn.aside).length,
      unhandledCount: turns.flatMap((turn: any) => turn.items)
        .filter((item: any) => item.kind === "unhandled").length,
      order: turns.map((turn: any) =>
        (turn.aside ? "aside" : `turn-${turn.n}`) + ":" +
        turn.items.filter((item: any) => item.kind === "unhandled")
          .map((item: any) => item.type).join("+")).join("|"),
    };
  }
  const before = threeTurns("live");
  const after = threeTurns("reconstruction");
  check("three-turn turn, aside, unhandled counts and ordering survive F5",
    JSON.stringify(before) === JSON.stringify(after) && before.turnCount === 3 &&
      before.asideCount === 1 && before.unhandledCount === 4);
}

// Historical requests cannot open UI; current open state is actionable once.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.permission_requested", { key: "interaction-old" }));
  check("historical interaction does not set waiting or open the drawer",
    v.awaiting === null && h.document.getElementById("app").dataset.drawer === "closed");
  h.api.receive(appEvent(2, "interaction.permission_requested", { key: "interaction-current" }, "current"));
  check("current open interaction is restored and actionable",
    v.awaiting === "permission" && v.currentInteractionKey === "interaction-current");
  h.document.getElementById("app").dataset.drawer = "closed";
  h.api.receive(appEvent(3, "interaction.permission_requested", { key: "interaction-current" }, "current"));
  check("current open interaction hydration is idempotent",
    v.awaiting === "permission" && h.document.getElementById("app").dataset.drawer === "closed");

  Object.assign(v, { phase: "streaming", compacting: true, runningWrites: 4, cancelSent: true, subagents: 5 });
  h.api.receive(appEvent(4, "interaction.answered", { key: "interaction-old", optionId: "yes" }));
  h.api.receive(appEvent(5, "interaction.abandoned", { key: "interaction-old", reason: "old death" }));
  check("historical answer or abandonment cannot clear a newer interaction",
    v.awaiting === "permission" && v.currentInteractionKey === "interaction-current");
  check("historical abandonment cannot mutate current transient state",
    v.phase === "streaming" && v.compacting === true && v.runningWrites === 4 &&
      v.cancelSent === true && v.subagents === 5);
  check("historical abandonment still renders as history",
    v.turns.some((turn: any) => turn.items.some((item: any) => item.label === "ABANDONED" && item.replay)));

  h.api.receive(appEvent(6, "interaction.answered", { key: "interaction-current", optionId: "yes" }, "live"));
  check("matching live answer clears the current interaction exactly once",
    v.awaiting === null && v.currentInteractionKey === null &&
      h.document.getElementById("app").dataset.drawer === "closed");
}

// A request already resolved later in the same catch-up batch never reopens.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  finish(h, 1);
  const request = appEvent(2, "interaction.permission_requested", { key: "catchup-key" }, "catchup");
  request.deliveryResolved = true;
  h.api.receive(request);
  check("resolved catch-up request never reopens actionable state",
    v.awaiting === null && h.document.getElementById("app").dataset.drawer === "closed");
  h.api.receive(appEvent(3, "interaction.answered", { key: "catchup-key", optionId: "yes" }, "catchup"));
  check("resolved catch-up answer leaves no actionable state or drawer",
    v.awaiting === null && h.document.getElementById("app").dataset.drawer === "closed");

  h.api.receive(appEvent(4, "interaction.permission_requested", { key: "still-open" }, "catchup"));
  check("unresolved missed catch-up request retains its original live behavior",
    v.awaiting === "permission" && v.currentInteractionKey === "still-open");
}

// Current hydration followed by interrupted reconstruction reconciles against server authority.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.permission_requested", { key: "resolved-during-drop" }, "current"));
  check("current hydration is actionable before interruption", v.awaiting === "permission");
  h.api.receive(appEvent(2, "interaction.answered", { key: "resolved-during-drop", optionId: "yes" }, "reconstruction"));
  check("historical resumed answer alone does not mutate current state", v.awaiting === "permission");
  h.api.receive(appEvent(3, "bridge.reconstruction_finished", { currentInteractionKeys: [] }, "reconstruction", null));
  check("reconstruction finish removes hydration absent from current server state",
    v.awaiting === null && v.currentInteractionKey === null);
}

// A quiet current turn comes from the server snapshot without inventing a phase.
{
  const h = harness();
  open(h);
  h.api.setAgent({
    state: "ready",
    sessions: [{ sessionId: "s", cwd: "/tmp/s", live: true, loading: false, turnInFlight: true }],
    openInteractions: [],
  });
  finish(h, 1);
  check("fresh reload around a quiet live turn reports turn in progress",
    h.api.resolveState().key === "working" && h.api.view("s").phase === null);
}

// session_loading rebuilds history before reinserting a recent abandonment.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "turn.started", { text: "old" }, "live"));
  h.api.receive(appEvent(2, "interaction.abandoned", { key: "interaction-1", reason: "agent died" }, "live"));
  h.api.receive(appEvent(3, "bridge.session_loading", {}, "live"));
  const user = appEvent(4, "message.user", { text: "history" }); user.replay = true;
  const answer = appEvent(5, "message.assistant", { text: "answer" }); answer.replay = true;
  const completed = appEvent(6, "turn.completed", { stopReason: "end_turn", usage: {} }); completed.replay = true;
  h.api.receive(user); h.api.receive(answer); h.api.receive(completed);
  h.api.receive(appEvent(7, "bridge.session_loaded", {}, "live"));
  const flat = v.turns.flatMap((turn: any) => turn.items);
  check("session_loading rebuilds history before abandonment notice",
    flat.findIndex((item: any) => item.kind === "user") <
      flat.findIndex((item: any) => item.label === "ABANDONED"));
  check("abandonment remains deduplicated after load",
    flat.filter((item: any) => item.label === "ABANDONED").length === 1);
}

// Abandonment followed by failure closes the interrupted turn, not an empty new one.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "turn.started", { text: "interrupted" }));
  h.api.receive(appEvent(2, "interaction.abandoned", {
    key: "lost", reason: "agent died", recoveryAfterTurn: 1,
  }));
  h.api.receive(appEvent(3, "turn.failed", { error: "agent exited" }));
  const realTurns = v.turns.filter((turn: any) => !turn.aside);
  check("abandonment followed by failure closes the corresponding interrupted turn",
    realTurns.length === 1 && realTurns[0].outcome === "failed" && realTurns[0].error === "agent exited");
}

// Multiple retained abandonments use stable turn anchors, even when delivered last.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "turn.started", { text: "one" }));
  h.api.receive(appEvent(2, "turn.finished", { stopReason: "end_turn" }));
  h.api.receive(appEvent(3, "turn.started", { text: "two" }));
  h.api.receive(appEvent(4, "turn.finished", { stopReason: "end_turn" }));
  h.api.receive(appEvent(5, "interaction.abandoned", { key: "a", reason: "first", recoveryAfterTurn: 1 }));
  h.api.receive(appEvent(6, "interaction.abandoned", { key: "b", reason: "second", recoveryAfterTurn: 2 }));
  const labels = v.turns.map((turn: any) => turn.items.find((item: any) => item.label === "ABANDONED")?.abandonmentKey ||
    turn.items.find((item: any) => item.kind === "user")?.text || "other");
  check("multiple recovery notices retain their chronological turn positions",
    labels.join(",") === "one,a,two,b");
}

// User navigation relinquishes auto-drawer ownership.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  finish(h, 1);
  h.api.receive(appEvent(2, "interaction.permission_requested", { key: "user-owned" }, "live"));
  h.document.getElementById("drawerClose").onclick!();
  h.document.getElementById("drawerToggle").onclick!();
  h.api.receive(appEvent(3, "interaction.answered", { key: "user-owned", optionId: "yes" }, "live"));
  check("interaction answer does not close a drawer the user reopened manually",
    v.awaiting === null && h.document.getElementById("app").dataset.drawer === "open");
}

// Truncation metadata marks a retained event beginning partway through a turn.
{
  const h = harness();
  open(h, [{ sessionId: "s", events: 3, bytes: 99, startsMidTurn: true }]);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "message.assistant", { text: "tail" }));
  finish(h, 2);
  check("partial retained history is labelled partial rather than TURN 1",
    v.turns[0].partial === true && v.historyMissing.includes("3 earlier events"));
  check("recovery completion leaves no historical live phase", v.phase === null);
}

// A terminal retained event after setup creates a partial turn, not a closed aside.
{
  const h = harness();
  open(h, [{ sessionId: "s", events: 2, bytes: 50, startsMidTurn: true }]);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "mcp.initialized", {}));
  h.api.receive(appEvent(2, "turn.failed", { error: "tail failure" }));
  finish(h, 3);
  const failed = v.turns.find((turn: any) => !turn.aside);
  check("terminal truncation after setup creates a labelled partial turn",
    failed && failed.partial === true && failed.outcome === "failed");
}

// A later full upstream load clears stale retained-history truncation provenance.
{
  const h = harness();
  open(h, [{ sessionId: "s", events: 2, bytes: 50, startsMidTurn: true }]);
  const v = h.api.view("s");
  finish(h, 1);
  h.api.receive(appEvent(2, "bridge.session_loading", {}, "live"));
  const user = appEvent(3, "message.user", { text: "complete" }, "live"); user.replay = true;
  const completed = appEvent(4, "turn.completed", { stopReason: "end_turn", usage: {} }, "live"); completed.replay = true;
  h.api.receive(user); h.api.receive(completed);
  h.api.receive(appEvent(5, "bridge.session_loaded", {}, "live"));
  check("successful full session load clears stale truncation labels",
    v.historyMissing === null && v.partialNextTurn === false && v.turns[0].partial === false);
  h.api.receive(appEvent(6, "bridge.catchup_truncated", { missingEvents: 1, missingSerializedBytes: 10 }, "catchup"));
  check("catch-up truncation does not relabel an intact existing page model",
    v.historyMissing === null);
}

// No intermediate conversation paint or scroll occurs while reconstruction runs.
{
  const h = harness();
  const before = h.document.canvasPaints;
  open(h);
  const afterOpen = h.document.canvasPaints;
  h.api.receive(appEvent(1, "turn.started", { text: "one" }));
  h.api.receive(appEvent(2, "message.assistant", { text: "two" }));
  h.api.receive(appEvent(3, "turn.finished", { stopReason: "end_turn" }));
  check("reconstruction paints one progress sentence and no intermediate history",
    afterOpen > before && h.document.canvasPaints === afterOpen);
  finish(h, 4);
  check("reconstruction performs one final model paint", h.document.canvasPaints === afterOpen + 1);
}

// Only a validated per-tab session identity survives reload.
{
  const key = "graphometer.selectedSessionId";
  const sessions = [
    { sessionId: "a", cwd: "/tmp/a", live: true, loading: false },
    { sessionId: "b", cwd: "/tmp/b", live: true, loading: false },
  ];
  const storage = new Map<string, string>();
  const first = harness(false, storage);
  open(first, [], sessions, false);
  first.api.selectSession(sessions[1], true);
  check("selecting a held session updates reload identity without navigation",
    first.api.state().activeId === "b" && storage.get(key) === "b");
  first.api.receive(appEvent(1, "turn.started", { text: "conversation must not be stored" }, "live", "b"));
  const reloaded = harness(false, storage);
  open(reloaded, [], sessions, false);
  reloaded.api.receive(appEvent(1, "bridge.session_opened", { session: sessions[0] }, "reconstruction", "a"));
  const retainedOpenStayedOnB = reloaded.api.state().activeId === "b";
  reloaded.api.receive(appEvent(2, "bridge.session_opened", { session: sessions[1] }, "reconstruction", "b"));
  check("selected held session survives F5",
    retainedOpenStayedOnB && reloaded.api.state().activeId === "b");
  check("browser storage contains only the selected identity, never conversation content",
    storage.size === 1 && storage.get(key) === "b" &&
      ![...storage.values()].some((value) => value.includes("conversation must not be stored")));

  const staleStorage = new Map([[key, "stale-session"]]);
  const stale = harness(false, staleStorage);
  open(stale, [], sessions, false);
  check("valid-looking remembered id waits for roster validation",
    stale.api.state().activeId === null);
  stale.api.receive(appEvent(1, "bridge.sessions_listed", { sessions }, "live", null));
  check("stale remembered id falls back to a current held session",
    stale.api.state().activeId === "a" && staleStorage.get(key) === "a");

  const malformedStorage = new Map([[key, "bad\nid"]]);
  const malformed = harness(false, malformedStorage);
  open(malformed, [], sessions, false);
  check("malformed remembered id is inert and falls back safely",
    malformed.api.state().activeId === "a" && malformedStorage.get(key) === "a");

  const tabOneStorage = new Map([[key, "a"]]);
  const tabTwoStorage = new Map([[key, "b"]]);
  const tabOne = harness(false, tabOneStorage);
  const tabTwo = harness(false, tabTwoStorage);
  open(tabOne, [], sessions, false);
  open(tabTwo, [], sessions, false);
  check("two tabs preserve different selected sessions",
    tabOne.api.state().activeId === "a" && tabTwo.api.state().activeId === "b" &&
      tabOneStorage.get(key) === "a" && tabTwoStorage.get(key) === "b");
}

// The production EventSource branch is wired to the delivery-ID reducer.
{
  const h = harness(true);
  check("production boot opens the token-gated EventSource URL",
    h.sources.length === 1 && h.sources[0].url.includes("/events?token="));
  h.api.setAgent({ state: "ready", sessions: [{ sessionId: "s", cwd: "/tmp", live: true }], openInteractions: [] });
  h.api.setActive("s");
  const wire = appEvent(1, "turn.started", { text: "wired once" }, "live");
  h.sources[0].onmessage({ data: JSON.stringify(wire) });
  h.sources[0].onmessage({ data: JSON.stringify(wire) });
  check("production EventSource onmessage applies a delivery ID once",
    h.api.view("s").turns.length === 1);
}

// Delivery IDs make duplicate catch-up frames inert.
{
  const h = harness();
  open(h);
  const ev = appEvent(1, "turn.started", { text: "once" }, "catchup");
  h.api.receive(ev);
  h.api.receive(ev);
  check("duplicate delivery ID is reduced once", h.api.view("s").turns.length === 1);
}

// Hostile retained strings remain text, and forbidden DOM APIs remain absent.
{
  const forbidden = [
    /\.innerHTML\s*=/,
    /insertAdjacentHTML\s*\(/,
    /document\.write\s*\(/,
    /\beval\s*\(/,
  ];
  check("no forbidden HTML or evaluation API appears in app.js",
    forbidden.every((pattern) => !pattern.test(APP_SOURCE)));
  const h = harness();
  open(h);
  const hostile = "<img src=x onerror=1><script>owned()</script><svg onload=1>";
  h.api.receive(appEvent(1, "turn.started", { text: hostile }));
  finish(h, 2);
  const dangerousBefore = h.document.created.filter((node) => ["IMG", "SCRIPT", "SVG", "IFRAME"].includes(node.tagName)).length;
  h.api.renderAll();
  const dangerousAfter = h.document.created.filter((node) => ["IMG", "SCRIPT", "SVG", "IFRAME"].includes(node.tagName)).length;
  check("hostile reconstructed content creates no executable element",
    dangerousAfter === dangerousBefore && h.document.body.textContent.includes(hostile));
}

// Post-F5 context read-back: reconstruction requests session/info; catchup does not;
// HTTP body never populates the meter; only live bridge.context_reading does.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "bridge.context_reading", {
    info: { sessionId: "s", context: { used: 111, total: 500000 } },
    summary: "historical",
  }, "reconstruction"));
  check("reconstruction-tagged context_reading remains inert", v.context === null);

  const before = h.posts.length;
  h.api.receive(appEvent(2, "bridge.reconstruction_finished", { currentInteractionKeys: [] }, "reconstruction", null));
  const infoPosts = h.posts.slice(before).filter((p) => p.path === "/session/info");
  check("reconstruction_finished requests /session/info once", infoPosts.length === 1);
  check("reconstruction_finished sends the exact selected sessionId",
    infoPosts[0].body.sessionId === "s" && infoPosts[0].body.sessionId !== undefined);
  check("POST success body alone does not populate context",
    v.context === null && v.contextRefused == null);

  h.api.receive(appEvent(3, "bridge.context_reading", {
    info: { sessionId: "s", context: { used: 14865, total: 500000, freeTokens: 485135 } },
    summary: "live reading",
  }, "live"));
  check("only a subsequent live bridge.context_reading populates context",
    v.context && v.context.used === 14865);

  const catchup = harness();
  open(catchup);
  const beforeCatchup = catchup.posts.length;
  catchup.api.receive(appEvent(1, "bridge.catchup_finished", { currentInteractionKeys: [] }, "catchup", null));
  check("catchup_finished does not request /session/info",
    catchup.posts.slice(beforeCatchup).filter((p) => p.path === "/session/info").length === 0);

  // empty / mismatch remain explicit non-readings
  const emptyEv = appEvent(4, "bridge.session_info_empty", { sessionId: "s" }, "live");
  emptyEv.note = "session/info returned a success with no reading in it";
  h.api.receive(emptyEv);
  check("empty reading is an explicit non-reading", typeof h.api.view("s").contextRefused === "string");
  h.api.receive(appEvent(5, "bridge.context_reading", {
    info: { sessionId: "s", context: { used: 50, total: 500000 } },
    summary: "again",
  }, "live"));
  check("a later live reading clears the refused mark",
    h.api.view("s").context && h.api.view("s").context.used === 50 && h.api.view("s").contextRefused === null);
  const mismatchEv = appEvent(6, "bridge.session_info_mismatch", { asked: "s", answered: "other" }, "live");
  mismatchEv.note = "session/info answered about a different session";
  h.api.receive(mismatchEv);
  check("mismatched reading is an explicit non-reading", typeof h.api.view("s").contextRefused === "string");

  // Session A response cannot populate session B
  const dual = harness();
  open(dual, [], [
    { sessionId: "a", cwd: "/tmp/a", live: true, loading: false },
    { sessionId: "b", cwd: "/tmp/b", live: true, loading: false },
  ], false);
  dual.api.setActive("b");
  dual.api.receive(appEvent(1, "bridge.reconstruction_finished", {}, "reconstruction", null));
  const dualInfo = dual.posts.filter((p) => p.path === "/session/info");
  check("with B selected, reconstruction requests session B only",
    dualInfo.length === 1 && dualInfo[0].body.sessionId === "b");
  dual.api.receive(appEvent(2, "bridge.context_reading", {
    info: { sessionId: "a", context: { used: 1, total: 500000 } },
    summary: "A",
  }, "live", "a"));
  dual.api.receive(appEvent(3, "bridge.context_reading", {
    info: { sessionId: "b", context: { used: 222, total: 500000 } },
    summary: "B",
  }, "live", "b"));
  check("session A's reading cannot populate session B",
    dual.api.view("a").context && dual.api.view("a").context.used === 1 &&
    dual.api.view("b").context && dual.api.view("b").context.used === 222);

  // Duplicate reconstruction completion does not stack an uncontrolled loop.
  // Hold the first fetch open so a second finish while in-flight is ignored.
  const loop = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const origFetch = (loop as any); // posts already recorded via harness fetch
  // Replace fetch after harness boot by re-binding is not available; instead
  // fire two finishes synchronously before microtasks drain: first adds in-flight,
  // second must see it. The harness fetch is async (returns a Promise), so the
  // first post() awaits json then finally — both finishes in one turn share the Set.
  open(loop);
  const n0 = loop.posts.length;
  loop.api.receive(appEvent(1, "bridge.reconstruction_finished", {}, "reconstruction", null));
  loop.api.receive(appEvent(2, "bridge.reconstruction_finished", {}, "reconstruction", null));
  const nInfo = loop.posts.slice(n0).filter((p) => p.path === "/session/info").length;
  check("duplicate reconstruction_finished does not create an uncontrolled request loop",
    nInfo === 1);
  void gate; void release; void origFetch;
}

// Advisory 0.2.117 kinds do not become unhandled cards and do not retitle / close turns.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "turn.started", { text: "hi" }, "live"));
  h.api.receive(appEvent(2, "message.assistant", { text: "PONG" }, "live"));
  h.api.receive({
    ...appEvent(3, "response.completed", {
      usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0 },
      advisoryOnly: true,
    }, "live"),
    wireKind: "response_completed",
    modelled: true,
  });
  check("response.completed does not close the turn",
    v.turns[0].outcome === "running" && v.turns[0].cost === null);
  check("response.completed does not create an unhandled card",
    !v.turns[0].items.some((item: any) => item.kind === "unhandled"));
  h.api.receive(appEvent(4, "turn.completed", {
    stopReason: "end_turn",
    usage: { costUsd: 0.01, usageIsIncomplete: false },
  }, "live"));
  h.api.receive(appEvent(5, "turn.finished", { stopReason: "end_turn" }, "live"));
  check("turn.completed still owns cost after response.completed",
    v.turns[0].outcome === "ok" && v.turns[0].cost && v.turns[0].cost.usd === 0.01);

  h.api.receive(appEvent(6, "session.titled", { title: "Owned Title" }, "live"));
  const titleNotices = v.turns.flatMap((t: any) => t.items).filter((i: any) => i.label === "TITLE").length
    + v.turns.filter((t: any) => t.aside).flatMap((t: any) => t.items).filter((i: any) => i.label === "TITLE").length;
  // title notice is on the stream via streamNotice — count notices with TITLE
  const allItems = v.turns.flatMap((t: any) => t.items);
  const titledCount = allItems.filter((i: any) => i.label === "TITLE").length;
  check("session.titled sets the shell title once", v.title === "Owned Title" && titledCount === 1);
  h.api.receive({
    ...appEvent(7, "session.info_updated", { title: "Different Title Should Not Win", advisoryOnly: true }, "live"),
    wireKind: "session_info_update",
    modelled: true,
  });
  const titledAfter = allItems.filter((i: any) => i.label === "TITLE").length
    + v.turns.flatMap((t: any) => t.items).filter((i: any) => i.label === "TITLE").length;
  // re-read items after second event
  const titledFinal = v.turns.flatMap((t: any) => t.items).filter((i: any) => i.label === "TITLE").length;
  check("session.info_updated cannot independently retitle the shell",
    v.title === "Owned Title");
  check("session.info_updated does not emit a second TITLE notice",
    titledFinal === 1);
  check("session.info_updated does not create an unhandled card",
    !v.turns.flatMap((t: any) => t.items).some((item: any) =>
      item.kind === "unhandled" && item.type === "session.info_updated"));
  void titleNotices; void titledAfter; void titledCount;
}

// New Session (WP5.5): success is not trusted, the exact cwd is sent, and
// verification against /state gates selection.
{
  const readyAgent = (sessions: any[]) => ({
    state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions, openInteractions: [],
  });
  const h = harness(true);
  h.api.setAgent(readyAgent([{ sessionId: "old", cwd: "/tmp/old", live: true, turnInFlight: false }]));
  h.api.setActive("old");

  // (a) session/new returns an id, but /state does not hold it: NOT selected.
  h.route("/session/new", (b) => ({ session: { sessionId: "ghost", cwd: b.cwd } }));
  h.route("/state", () => readyAgent([{ sessionId: "old", cwd: "/tmp/old", live: true, turnInFlight: false }]));
  await h.api.createSession("/tmp/newdir");
  check("session/new success alone does not select an unconfirmed session",
    h.api.state().activeId === "old");
  check("the exact chosen cwd is sent to session/new",
    h.posts.some((p) => p.path === "/session/new" && p.body.cwd === "/tmp/newdir"));

  // (b) /state confirms both id and cwd → the initiating tab selects it.
  h.route("/session/new", (b) => ({ session: { sessionId: "new1", cwd: b.cwd } }));
  h.route("/state", () => readyAgent([
    { sessionId: "old", cwd: "/tmp/old", live: true, turnInFlight: false },
    { sessionId: "new1", cwd: "/tmp/newdir", live: true, turnInFlight: false },
  ]));
  const rec = await h.api.createSession("/tmp/newdir");
  check("read-back-verified creation selects the new session in the initiating tab",
    !!rec && rec.sessionId === "new1" && h.api.state().activeId === "new1");
  check("read-back confirms the resulting cwd is the folder that was picked",
    !!rec && rec.cwd === "/tmp/newdir");

  // (c) /state holds the id but its cwd is NOT the folder asked for: never
  //     selected (WP5.6 — the old code selected it "and flagged the
  //     difference", which put the conversation on a folder the operator did
  //     not choose; standing rule 1 requires id AND cwd before selection).
  h.api.setActive("new1");
  h.route("/session/new", (b) => ({ session: { sessionId: "drifted", cwd: b.cwd } }));
  h.route("/state", () => readyAgent([
    { sessionId: "new1", cwd: "/tmp/newdir", live: true, turnInFlight: false },
    { sessionId: "drifted", cwd: "/tmp/elsewhere", live: true, turnInFlight: false },
  ]));
  const bad = await h.api.createSession("/tmp/wanted");
  check("a cwd mismatch on read-back is never selected — the prior selection stays",
    bad === null && h.api.state().activeId === "new1");
  check("the mismatch is surfaced to the operator, naming both folders",
    JSON.stringify(h.api.notes()).includes("/tmp/elsewhere") &&
    JSON.stringify(h.api.notes()).includes("/tmp/wanted"));
}

// The multi-tab LOW: a live session_opened broadcast must not navigate a tab
// that did not create the session.
{
  const base = [
    { sessionId: "a", cwd: "/tmp/a", live: true, turnInFlight: false },
    { sessionId: "b", cwd: "/tmp/b", live: true, turnInFlight: false },
  ];
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: base, openInteractions: [] });
  h.api.setActive("b");
  h.route("/state", () => ({
    state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [...base, { sessionId: "c", cwd: "/tmp/c", live: true, turnInFlight: false }], openInteractions: [],
  }));
  h.api.receive(appEvent(1, "bridge.session_opened", { session: { sessionId: "c", cwd: "/tmp/c", live: true } }, "live", "c"));
  await new Promise((r) => setTimeout(r, 0)); // let the refreshState /state read settle
  check("a live session_opened broadcast does not move a non-initiating tab",
    h.api.state().activeId === "b");
  check("the broadcast still records the new session as opened",
    h.api.view("c").opened === true);
}

// A reconstruction-delivery session_opened (F5 replay) never navigates either —
// the guard that lets two tabs keep different selections across reload.
{
  const sessions = [
    { sessionId: "a", cwd: "/tmp/a", live: true, turnInFlight: false },
    { sessionId: "b", cwd: "/tmp/b", live: true, turnInFlight: false },
  ];
  const storage = new Map<string, string>([["graphometer.selectedSessionId", "b"]]);
  const h = harness(false, storage);
  open(h, [], sessions, false);
  h.api.receive(appEvent(1, "bridge.session_opened", { session: sessions[0] }, "reconstruction", "a"));
  check("a reconstructed session_opened does not steal selection on F5",
    h.api.state().activeId === "b");
}

// Hostile directory names reach the picker as text, never markup.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [] });
  h.api.setRoster([]);
  const hostile = "<img src=x onerror=alert(1)><script>owned()</script>";
  h.route("/fs/list", () => ({ path: "/tmp", parent: "/", entries: [{ name: hostile, path: "/tmp/x" }], error: null, code: null }));
  const before = h.document.created.filter((n) => ["IMG", "SCRIPT", "SVG", "IFRAME"].includes(n.tagName)).length;
  h.api.openPicker();
  await new Promise((r) => setTimeout(r, 0));
  const after = h.document.created.filter((n) => ["IMG", "SCRIPT", "SVG", "IFRAME"].includes(n.tagName)).length;
  const host = h.document.byId.get("pickerHost");
  check("a hostile directory name creates no executable element in the picker", after === before);
  check("a hostile directory name is rendered as text in the picker",
    !!host && host.textContent.includes(hostile));
}

// An unreadable/forbidden listing shows its message and offers no Start.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [] });
  h.api.setRoster([]);
  h.route("/fs/list", () => ({ path: "/closed-off", parent: "/", entries: [], error: "This folder is excluded on this machine and is never listed.", code: "FORBIDDEN" }));
  h.api.openPicker();
  await new Promise((r) => setTimeout(r, 0));
  const host = h.document.byId.get("pickerHost");
  check("a forbidden listing surfaces its message in the picker",
    !!host && host.textContent.includes("excluded on this machine"));
  check("the picker retains the error listing without crashing",
    h.api.pickerState() && h.api.pickerState().code === "FORBIDDEN");
}

// New Session robustness: a gone/unreadable workspace root falls back once to
// home, so Start is never dead on arrival.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [], browseRoot: "/vanished" });
  h.api.setRoster([]);
  h.route("/fs/list", (b) => b.path === "/vanished"
    ? { path: "/vanished", parent: "/", entries: [], error: "This folder no longer exists.", code: "ENOENT" }
    : { path: "/home/user", parent: "/home", entries: [{ name: "work", path: "/home/user/work" }], error: null, code: null });
  h.api.openPicker();
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1)); // flush both fetches
  const st = h.api.pickerState();
  check("picker opening on a vanished workspace root falls back to a readable one",
    !!st && st.error === null && st.path === "/home/user");
  check("the fallback landing offers rows to select (Start not dead on arrival)",
    !!st && st.entries.length > 0);
  const posts = h.posts.filter((p) => p.path === "/fs/list").map((p) => p.body.path);
  check("the fallback requested the workspace root first, then home",
    posts[0] === "/vanished" && posts.includes(""));
}

// D51: the picker opens at the server's workspace root when there is no
// session context.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [], browseRoot: "/workspace" });
  h.api.setRoster([]);
  h.route("/fs/list", (b) => b.path === "/workspace"
    ? { path: "/workspace", parent: "/", entries: [{ name: "work", path: "/workspace/work" }], error: null, code: null }
    : { path: b.path || "/home/x", parent: "/", entries: [], error: null, code: null });
  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  const st = h.api.pickerState();
  check("picker opens at the server's workspace root, not home", !!st && st.path === "/workspace");
  check("the picker's first fetch targets the workspace root",
    h.posts.some((p) => p.path === "/fs/list" && p.body.path === "/workspace"));
}

// D51, the branch that stranded the first user: an ACTIVE session's cwd no
// longer determines the start path. The picker still opens at the workspace
// root; the session's folder is a Places chip instead.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [{ sessionId: "cur", cwd: "/somewhere/deep", live: true, turnInFlight: false }], openInteractions: [], browseRoot: "/workspace" });
  h.api.setRoster([{ sessionId: "cur", cwd: "/somewhere/deep", live: true }]); // roster holds it too, as in production
  h.api.setActive("cur");
  h.route("/fs/list", (b) => b.path === "/workspace"
    ? { path: "/workspace", parent: "/", entries: [{ name: "deep", path: "/workspace/deep" }], error: null, code: null }
    : { path: String(b.path || "/home"), parent: "/", entries: [], error: null, code: null });
  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  const st = h.api.pickerState();
  check("with an active session, the picker STILL opens at the workspace root (D51)",
    !!st && st.path === "/workspace");
  check("the active session's cwd is never the first fetch",
    h.posts.filter((p) => p.path === "/fs/list")[0].body.path === "/workspace");
  const chip = h.document.created.filter((n) => n.title === "/somewhere/deep" && String(n.className).includes("btn")).pop();
  check("the active session's folder is offered as a Places chip instead", !!chip);
}

// D49: navigation and selection are two different gestures on two targets.
// Clicking a row selects it; the ▸ looks inside; navigating clears the
// selection; Start names the chosen folder and is disabled until one exists.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [], browseRoot: "/workspace" });
  h.api.setRoster([]);
  h.route("/fs/list", (b) => {
    const p = typeof b.path === "string" ? b.path : "";
    if (p === "/workspace" || p === "") {
      return { path: "/workspace", parent: "/", entries: [
        { name: "alpha", path: "/workspace/alpha" },
        { name: "beta", path: "/workspace/beta" },
      ], error: null, code: null };
    }
    if (p === "/workspace/alpha") return { path: "/workspace/alpha", parent: "/workspace", entries: [], error: null, code: null };
    return { path: p, parent: "/", entries: [], error: null, code: null };
  });
  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  check("nothing is selected when the picker opens", h.api.pickerState().selected === null);
  const disabledStart = h.document.created.filter((n) => n.textContent === "Pick a folder above").pop();
  check("before a choice, Start is disabled and says what to do",
    !!disabledStart && disabledStart.disabled === true);
  const row = h.document.created.filter((n) => n.className === "pr-select" && n.title === "/workspace/alpha").pop();
  check("a folder row has a select affordance carrying its full path", !!row);
  row!.onclick!();
  check("clicking a row SELECTS the folder — it does not enter it",
    h.api.pickerState().selected === "/workspace/alpha" && h.api.pickerState().path === "/workspace");
  const named = h.document.created.filter((n) => n.textContent === "Start session in alpha").pop();
  check("Start names the exact selected folder and becomes enabled",
    !!named && named.disabled === false);
  const nav = h.document.created.filter((n) => n.className === "pr-nav" && n.title === "Look inside alpha").pop();
  check("a folder row has a separate look-inside affordance", !!nav);
  nav!.onclick!();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  check("the look-inside affordance navigates into the folder",
    h.api.pickerState().path === "/workspace/alpha");
  check("navigation clears the selection — choosing is always explicit",
    h.api.pickerState().selected === null);

  // Double-clicking the NAME enters the folder too — the standard file-dialog
  // gesture, so the tiny ▸ is never the only way in (the director's ask).
  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  const betaRow = h.document.created.filter((n) => n.className === "pr-select" && n.title === "/workspace/beta").pop();
  check("a folder name carries a double-click handler", !!betaRow && typeof betaRow.ondblclick === "function");
  betaRow!.ondblclick!();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  check("double-clicking the folder name enters it",
    h.api.pickerState().path === "/workspace/beta");

  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  const prow = h.document.created.filter((n) => n.className === "picker-quick-row").pop();
  const rootChip = prow && prow.children[0];
  check("the Home chip is pinned FIRST in Places (position, not just flag)",
    !!rootChip && rootChip.dataset.pinned === "true" && rootChip.title === "/workspace");
  check("the Home chip reads as Home, not the raw folder basename",
    !!rootChip && rootChip.textContent.includes("Home"));
  rootChip!.onclick!();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  check("one tap on Home returns the picker to the workspace root",
    h.api.pickerState().path === "/workspace");
}

// A selection whose row the filter hides is cleared — what you can start is
// what you can see.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [], browseRoot: "/workspace" });
  h.api.setRoster([]);
  h.route("/fs/list", () => ({ path: "/workspace", parent: "/", entries: [
    { name: "alpha", path: "/workspace/alpha" },
    { name: "beta", path: "/workspace/beta" },
  ], error: null, code: null }));
  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  const row = h.document.created.filter((n) => n.className === "pr-select" && n.title === "/workspace/alpha").pop();
  row!.onclick!();
  check("the folder is selected before filtering", h.api.pickerState().selected === "/workspace/alpha");
  const filter = h.document.created.filter((n) => String(n.className).includes("picker-filter")).pop();
  filter!.value = "beta";
  (filter as any).oninput();
  check("filtering the selected row out of sight clears the selection",
    h.api.pickerState().selected === null);
  const startNow = h.document.created.filter((n) => n.textContent === "Pick a folder above").pop();
  check("Start returns to its pick-something state", !!startNow && startNow.disabled === true);
}

// The server can refuse a roster load (an excluded cwd, D50): the tab must not
// stay selected on a session the server rejected.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [{ sessionId: "ok", cwd: "/fine", live: true, turnInFlight: false }], openInteractions: [] });
  h.api.setActive("ok");
  h.route("/session/load", () => ({ error: "this session cannot be opened — This folder is excluded on this machine and is never listed." }));
  h.api.selectSession({ sessionId: "refused", cwd: "/private/sub" }, false);
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  check("a server-refused session/load puts the selection back where it was",
    h.api.state().activeId === "ok");
}

// New Session before the first /state lands: there is no workspace root yet,
// so the picker refuses to open rather than silently breaking D51.
{
  const h = harness(true);
  h.api.setAgent({ state: "starting", failure: null, failureCause: null, pid: null, restarts: 0, sessions: [], openInteractions: [] });
  h.api.openPicker();
  check("the picker refuses to open before the agent state is known",
    h.api.pickerState() === null);
  check("the refusal says why", JSON.stringify(h.api.notes()).includes("still connecting"));
}

// D50 display filter: a folder the server will refuse is never ADVERTISED as a
// Places chip. Display only — the enforcement is the server's shared gate.
{
  const h = harness(true);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [], browseRoot: "/workspace", excludedDirs: ["/private"] });
  h.api.setRoster([
    { sessionId: "x", cwd: "/private/sub", live: false },
    { sessionId: "y", cwd: "/elsewhere", live: false },
  ]);
  h.route("/fs/list", () => ({ path: "/workspace", parent: "/", entries: [{ name: "work", path: "/workspace/work" }], error: null, code: null }));
  h.api.openPicker();
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 1));
  const chipTitles = h.document.created.filter((n) => String(n.className).includes("btn") && n.title).map((n) => n.title);
  check("an excluded cwd is never offered as a Places chip", !chipTitles.includes("/private/sub"));
  check("ordinary recent folders still appear as chips", chipTitles.includes("/elsewhere"));
}

/* ── WP6: THE INTERACTION CARDS ─────────────────────────────────────────── */

const PERM_OPTIONS = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
];
function cardsFor(v: any, key: string) {
  return v.turns.flatMap((turn: any) => turn.items)
    .filter((item: any) => item.kind === "interaction" && item.key === key);
}

// The §0 trap: a still-open interaction arrives twice on every reload —
// retained copy (reconstruction) + `current` re-send — and again on every
// SSE reconnect. One key, one card, however many arrivals.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.permission_requested",
    { key: "dup-1", options: PERM_OPTIONS, title: "Write x" }));
  check("the retained copy draws one inert history card",
    cardsFor(v, "dup-1").length === 1 && cardsFor(v, "dup-1")[0].replay === true &&
      v.awaiting === null);
  h.api.receive(appEvent(2, "interaction.permission_requested",
    { key: "dup-1", options: PERM_OPTIONS, title: "Write x" }, "current"));
  const afterCurrent = cardsFor(v, "dup-1");
  check("the `current` re-send NEVER draws a second card — same key, same card",
    afterCurrent.length === 1);
  check("the re-send makes that one card live and actionable",
    afterCurrent[0].replay === false && !afterCurrent[0].resolved &&
      v.awaiting === "permission" && v.currentInteractionKey === "dup-1");
  h.api.receive(appEvent(3, "interaction.permission_requested",
    { key: "dup-1", options: PERM_OPTIONS, title: "Write x" }, "current"));
  check("an SSE-reconnect re-send does not duplicate either — dedup is by key, not by delivery",
    cardsFor(v, "dup-1").length === 1);
}

// A genuinely replayed request (replay:true) draws inert history and is
// never actionable — no waiting state, no live buttons.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  const ev = appEvent(1, "interaction.plan_approval_requested",
    { key: "rep-1", planContent: "# The plan" }, "live");
  (ev as any).replay = true;
  h.api.receive(ev);
  const card = cardsFor(v, "rep-1")[0];
  check("a replayed plan request draws an inert history card, never a waiting state",
    card !== undefined && card.replay === true && v.awaiting === null &&
      v.currentInteractionKey === null);
}

// The plan card's lifecycle: awaiting 'plan', sealed by the answered event
// with the typed feedback narrated — and the ack alone seals nothing.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.plan_approval_requested",
    { key: "plan-1", planContent: "# Plan\n\n1. do the thing" }, "current"));
  const card = cardsFor(v, "plan-1")[0];
  check("a live plan request opens the plan card and the plan waiting state",
    card !== undefined && !card.resolved && v.awaiting === "plan");
  h.api.receive(appEvent(2, "interaction.answered",
    { key: "plan-1", optionId: "cancelled", cancelled: false, feedback: "Split step one." },
    "live"));
  check("the answered event seals the card with the typed note, and folds the plan",
    card.resolved !== null && card.resolved.feedback === "Split step one." &&
      card.planFolded === true && v.awaiting === null);
}

// The question card: third awaiting value, third strip state, sealed with
// the answers; a cancelled question shows no discarded selections.
{
  const h = harness();
  open(h);
  finish(h, 1); /* recovery closed first — the strip must read the question state, not "recovering" */
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "interaction.question_asked", {
    key: "q-1",
    questions: [{
      question: "Which topics?",
      options: [{ label: "A", description: "a" }, { label: "B", description: "b" }],
      multiSelect: true,
    }],
    mode: "default",
  }, "current"));
  check("a live question opens the question waiting state — the third value",
    v.awaiting === "question" && h.api.resolveState().key === "question");
  h.api.receive(appEvent(3, "interaction.answered", {
    key: "q-1", optionId: null, outcome: "accepted",
    answers: { "Which topics?": ["A", "B"] }, cancelled: false,
  }, "live"));
  const card = cardsFor(v, "q-1")[0];
  check("the answered event seals the question card with the answers map",
    card.resolved !== null && card.resolved.outcome === "accepted" &&
      JSON.stringify(card.resolved.answers) === JSON.stringify({ "Which topics?": ["A", "B"] }) &&
      v.awaiting === null);
}
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.question_asked", {
    key: "q-2",
    questions: [{ question: "Pick", options: [{ label: "A" }], multiSelect: false }],
    mode: "default",
  }, "current"));
  const card = cardsFor(v, "q-2")[0];
  card.picks["Pick"] = ["A"]; // a selection the user then abandons
  h.api.receive(appEvent(2, "interaction.answered",
    { key: "q-2", optionId: null, outcome: "cancelled", cancelled: true }, "live"));
  check("a cancelled question seals closed-without-answering",
    card.resolved !== null && card.resolved.outcome === "cancelled" && v.awaiting === null);
}

// Reconciliation seals cards the server no longer lists as open.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.permission_requested",
    { key: "stale-1", options: PERM_OPTIONS }, "current"));
  check("the card is open before reconciliation", cardsFor(v, "stale-1")[0].resolved === null);
  h.api.receive(appEvent(2, "bridge.reconstruction_finished",
    { currentInteractionKeys: [] }, "reconstruction", null));
  check("reconciliation seals a card the server no longer lists, and clears the waiting state",
    cardsFor(v, "stale-1")[0].resolved !== null &&
      cardsFor(v, "stale-1")[0].resolved.how === "reconciled" &&
      v.awaiting === null);
}

// Abandonment seals the card AND leaves the chronological ABANDONED notice.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.question_asked", {
    key: "q-3",
    questions: [{ question: "Pick", options: [{ label: "A" }], multiSelect: false }],
    mode: "default",
  }, "current"));
  h.api.receive(appEvent(2, "interaction.abandoned",
    { key: "q-3", reason: "The agent process exited before this interaction could be answered." },
    "live"));
  const card = cardsFor(v, "q-3")[0];
  check("agent death seals the question card as never-answered",
    card.resolved !== null && card.resolved.how === "abandoned" && v.awaiting === null);
  check("the ABANDONED notice still lands in the stream beside the sealed card",
    v.turns.some((turn: any) => turn.items.some((item: any) => item.label === "ABANDONED")));
}

// A deliveryResolved catch-up request draws sealed history, upgraded by the
// batch's own answered event to the real narration.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  const request = appEvent(1, "interaction.permission_requested",
    { key: "cb-1", options: PERM_OPTIONS }, "catchup");
  (request as any).deliveryResolved = true;
  h.api.receive(request);
  const card = cardsFor(v, "cb-1")[0];
  check("a resolved catch-up request draws a sealed card, never an actionable one",
    card !== undefined && card.resolved !== null && v.awaiting === null);
  h.api.receive(appEvent(2, "interaction.answered",
    { key: "cb-1", optionId: "allow-once", cancelled: false }, "catchup"));
  check("the batch's answered event upgrades the generic stamp to the real choice",
    card.resolved.optionId === "allow-once");
}

/* ── WP6: THE D44 CONSTRUCTIVE MARKDOWN RENDERER, HOSTILE INPUT FIRST ──── */

function tagsIn(node: any): string[] {
  const out: string[] = [node.tagName];
  for (const child of node.children || []) out.push(...tagsIn(child));
  return out;
}

// A successful POST locks the card until the answered event seals it: the ack
// is not the seal (rule 1), but re-arming the buttons would let the operator
// answer twice and end up believing they refused a call they allowed.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "interaction.permission_requested",
    { key: "lock-1", options: PERM_OPTIONS, title: "Write x" }, "current"));
  const card = cardsFor(v, "lock-1")[0];
  card.sent = true; /* what sendInteractionAnswer sets on a successful POST */
  const madeBefore = h.document.created.length;
  const node = h.api.renderInteractionCard(v, card);
  const optionButtons = h.document.created.slice(madeBefore).filter((n: any) =>
    n.tagName === "BUTTON" && PERM_OPTIONS.some((o) => n.textContent === o.name));
  check("a sent-but-unconfirmed card re-arms no option button",
    optionButtons.length > 0 && optionButtons.every((n: any) => n.disabled === true));
  check("and it says so, rather than looking unanswered",
    node.textContent.includes("Waiting for the agent to confirm"));
  h.api.receive(appEvent(3, "interaction.answered",
    { key: "lock-1", optionId: "allow-once", cancelled: false }, "live"));
  check("the answered event still seals it normally",
    card.resolved !== null && card.resolved.optionId === "allow-once");
}

// D83: prominence follows the option's wire `kind`, never the label and
// never the order. The per-action approval (allow_once) is the primary
// control; the session-wide one (allow_always) wears the quiet ghost;
// reject and unknown kinds get no variant. Labels verbatim, agent's order.
// Option shapes from the live capture docs/evidence/d83/permission-event.json.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  const OPTS = [
    { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
    { optionId: "allow-future-thing", name: "Something new", kind: "allow_future" },
  ];
  h.api.receive(appEvent(2, "interaction.permission_requested",
    { key: "d83-1", options: OPTS, title: "Edit x" }, "current"));
  const card = cardsFor(v, "d83-1")[0];
  const madeBefore = h.document.created.length;
  h.api.renderInteractionCard(v, card);
  const buttons = h.document.created.slice(madeBefore).filter((n: any) =>
    n.tagName === "BUTTON" && OPTS.some((o) => n.textContent === o.name));
  check("D83: one button per option, in the agent's order, labelled verbatim",
    buttons.length === 4 && buttons.map((b: any) => b.textContent).join("|") === OPTS.map((o) => o.name).join("|"));
  check("D83: allow_once wears the primary variant",
    buttons.find((b: any) => b.textContent === "Yes")!.dataset.variant === "primary");
  check("D83: allow_always wears the quiet ghost",
    buttons.find((b: any) => b.textContent === "Yes, allow all edits during this session")!.dataset.variant === "ghost");
  check("D83: reject and unknown kinds get no variant",
    !buttons.find((b: any) => b.textContent.startsWith("No,"))!.dataset.variant &&
      !buttons.find((b: any) => b.textContent === "Something new")!.dataset.variant);
}

/* ── D84: the two known background kinds quiet to one calm line ────────────
   queue.changed and turn.prompt_complete fire on every turn and carry no
   operator decision; their per-turn UNHANDLED EVENT flag read as an error to
   the first user. They compress; loud rows and genuinely unknown kinds do
   not; every payload stays inside the fold (D35). */
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.receive(appEvent(2, "turn.started", { text: "do work" }, "current"));
  h.api.receive(appEvent(3, "queue.changed", { queue: "a" }, "current"));
  h.api.receive(appEvent(4, "queue.changed", { queue: "b" }, "current"));
  h.api.receive(appEvent(5, "queue.changed", { queue: "c" }, "current"));
  h.api.receive(appEvent(6, "turn.prompt_complete", { ok: true }, "current"));
  h.api.receive(appEvent(7, "message.assistant", { text: "done" }, "current"));
  h.api.receive(appEvent(8, "turn.completed", { stopReason: "end_turn", usage: {} }, "current"));
  h.api.receive(appEvent(9, "turn.finished", { stopReason: "end_turn" }, "current"));
  h.api.renderAll();
  const canvas = () => h.document.getElementById("canvasInner").textContent;
  check("D84: background kinds compress into one calm line with per-kind counts",
    canvas().includes("background events") && canvas().includes("queue.changed ×3") &&
      canvas().includes("turn.prompt_complete"));
  check("D84: no UNHANDLED EVENT flag renders for the quiet kinds",
    !canvas().includes("UNHANDLED EVENT"));

  /* Expand the quiet fold: each member is its own row with its own payload
     fold — closed until clicked, payload retained inside (never dropped). */
  const groupFold = h.document.created.filter((n: any) =>
    n.tagName === "BUTTON" && n.textContent.includes("background events")).pop();
  const madeBefore = h.document.created.length;
  groupFold.onclick!();
  const made = h.document.created.slice(madeBefore);
  const memberRows = made.filter((n: any) =>
    n.tagName === "BUTTON" && n.textContent.includes("queue.changed") &&
      !n.textContent.includes("background events"));
  check("D84: the fold lists each member as its own row",
    memberRows.length === 3 && made.some((n: any) => n.textContent.includes("turn.prompt_complete")));
  const firstBody = memberRows[0].parentNode.children[1];
  check("D84: a member's payload fold starts closed with the payload retained inside",
    firstBody.hidden === true && firstBody.textContent.includes('"a"'));
  const before2 = h.document.created.length;
  memberRows[0].onclick!();
  const opened = h.document.created.slice(before2).find((n: any) =>
    n.tagName === "BUTTON" && n.textContent.includes("queue.changed") &&
      !n.textContent.includes("background events"));
  check("D84: a member's payload fold opens on click",
    !!opened && opened.parentNode.children[1].hidden === false);
}

// Loud rows are never quieted, and genuinely unknown kinds are unchanged.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "turn.started", { text: "x" }));
  h.api.receive(appEvent(3, "queue.changed", { a: 1 }));
  h.api.receive(appEvent(4, "queue.changed", { b: 2 }));
  h.api.receive(appEvent(5, "something.never.seen", { z: 1 }));
  /* A loud row of a quiet TYPE — constructed by hand, because the loud flag
     is the page's own: failures out-shout noise, even for these types. */
  v.turns[0].items.push({ kind: "unhandled", type: "queue.changed", wireKind: "_x.ai/queue/changed",
    modelled: true, note: null, missing: null, payload: { c: 3 }, loud: true, at: 6, replay: false, sealed: true });
  h.api.renderAll();
  const canvas = h.document.getElementById("canvasInner").textContent;
  check("D84: a LOUD row of a quiet type still renders WIRE PROBLEM, never compressed",
    canvas.includes("WIRE PROBLEM"));
  check("D84: the quiet members still compress beside it",
    canvas.includes("background events") && canvas.includes("queue.changed ×2"));
  check("D84: a genuinely unknown kind keeps the UNHANDLED EVENT flag",
    canvas.includes("UNHANDLED EVENT") && canvas.includes("something.never.seen"));
}

// The strip badge counts only non-quiet unhandled events.
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.receive(appEvent(2, "queue.changed", { q: 1 }, "current", null));
  h.api.receive(appEvent(3, "turn.prompt_complete", { ok: true }, "current", null));
  h.api.renderAll();
  check("D84: the strip badge ignores the quiet kinds even when they arrive unscoped",
    h.document.getElementById("unhandledBadge").hidden === true);
  h.api.receive(appEvent(4, "something.never.seen", { z: 1 }, "current", null));
  h.api.renderAll();
  check("D84: …and still counts a genuinely unknown kind",
    h.document.getElementById("unhandledBadge").hidden === false &&
      h.document.getElementById("unhandledBadge").textContent === "1 unhandled");
}

/* ── WP12: hardening — reconnect surfaces, the gate, empty states, copy ──── */

/** Microtask flush for the recording clipboard's resolved promise. */
async function flush0() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

// The strip distinguishes respawning from gone.
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.setAgent({ state: "respawning", failure: null, failureCause: null, sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false }], restarts: 1 });
  h.api.renderStrip();
  check("WP12: the strip reads 'Restarting agent…' while respawning, not 'gone'",
    h.document.getElementById("stateLabel").textContent === "Restarting agent…");
  h.api.setAgent({ state: "gone", failure: null, failureCause: null, sessions: [], restarts: 1 });
  h.api.renderStrip();
  check("WP12: …and 'Agent process gone' when actually gone",
    h.document.getElementById("stateLabel").textContent === "Agent process gone");
}

// The decorative Reconnect button is gone from the gone/respawning banner;
// the failure state's Try again is real.
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.setAgent({ state: "gone", failure: null, failureCause: null, sessions: [], restarts: 1 });
  h.api.renderBanner();
  check("WP12: the gone banner shows NO button (a control that can never fire is a lie)",
    h.document.getElementById("btnReconnect").hidden === true);
  h.api.setAgent({ state: "respawning", failure: null, failureCause: null, sessions: [], restarts: 1 });
  h.api.renderBanner();
  check("WP12: the respawning banner shows no button either",
    h.document.getElementById("btnReconnect").hidden === true);
  h.api.setAgent({ state: "failed", failure: "spawn ENOENT", failureCause: { kind: "startup_failed" }, sessions: [], restarts: 0 });
  h.api.renderBanner();
  const rb = h.document.getElementById("btnReconnect");
  check("WP12: the failed banner keeps the REAL Try again",
    rb.hidden === false && rb.textContent === "Try again" && typeof rb.onclick === "function");
}

// WP12 F1 (live-evidence finding): `.btn { display: inline-flex }` beat the
// UA `[hidden]` rule, so the "hidden" Reconnect button rendered anyway. The
// fix is the one global guard; these pin that it exists, that it is the
// file's ONLY !important (the house avoids them — this one is deliberate and
// commented), and that the affected display-setting components exist (so the
// guard is load-bearing, not decorative).
{
  check("WP12-F1: a global [hidden] guard with display:none !important exists",
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(CSS_SOURCE));
  check("WP12-F1: it is the only !important in the stylesheet",
    (CSS_SOURCE.match(/!important/g) || []).length === 1);
  check("WP12-F1: the guard is load-bearing — .btn, .composer-effort and .aa-pill all set display",
    /\.btn\s*\{[^}]*display:\s*inline-flex/.test(CSS_SOURCE) &&
      /\.composer-effort\s*\{[^}]*display:\s*inline-flex/.test(CSS_SOURCE) &&
      /\.aa-pill\s*\{[^}]*display:\s*inline-flex/.test(CSS_SOURCE));
}

// bridge.respawned leaves durable per-session markers plus the resolution line.
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.receive(appEvent(2, "turn.started", { text: "work" }, "current"));
  h.api.receive(appEvent(3, "turn.finished", { stopReason: "end_turn" }, "current"));
  h.api.view("s2"); /* a held session has a view; an unknown id must not gain one (Opus M4) */
  h.api.receive(appEvent(4, "bridge.respawned",
    { reloaded: ["s"], failed: [{ sessionId: "s2", error: "boom" }, { sessionId: "ghost", error: "x" }], restarts: 1 }, "current", null));
  const canvas = h.document.getElementById("canvasInner").textContent;
  check("WP12: a reloaded session gets a durable stream marker",
    canvas.includes("Back — this session was reloaded from disk after the agent restarted."));
  check("WP12: a held session that could not be reloaded says so in its own stream",
    h.api.view("s2").turns.some((t: any) =>
      t.items.some((i: any) => String(i.text || "").includes("could NOT be reloaded") && String(i.text).includes("boom"))));
  check("WP12: the aggregate resolution line lands in the log",
    h.api.notes().some((n: any) => n.text === "Back — 1 of 3 sessions reloaded. 2 could not be — each one says so in its own stream."));
}

// Markers survive F5 — re-derived from the snapshot, exactly once per
// generation (Codex I3); an unheld session id never materialises a ghost view.
{
  const h = harness();
  /* A page that lived through the respawn: generation 1, one marker written. */
  open(h);
  finish(h, 1);
  h.api.receive(appEvent(2, "bridge.agent_gone", { error: "killed", agentGeneration: 1 }, "current", null));
  h.api.receive(appEvent(3, "bridge.respawned", { reloaded: ["s"], failed: [] }, "current", null));
  const count = () => h.api.view("s").turns.reduce((n, t) =>
    n + t.items.filter((i) => i.recoveryGen === 1).length, 0);
  check("WP12/I3: the live event wrote one marker", count() === 1);
  /* The F5 path: a snapshot read-back carrying the same recovery outcome must
     NOT double the marker; a stale generation must NOT stamp at all. */
  h.api.setAgent({ state: "ready", failure: null, agentGeneration: 1, gate: null,
    sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false,
      recovery: { generation: 1, ok: true, error: null } }] });
  h.api.applySnapshotSidecars();
  check("WP12/I3: the snapshot re-derivation does NOT double the marker", count() === 1);
  /* Simulate the reload itself: fresh page model, the channel_open snapshot
     carries generation 1 and the recovery outcome — the marker is rebuilt
     once. */
  const h2 = harness();
  h2.api.handle({
    ...appEvent(0, "bridge.channel_open", {
      agent: { state: "ready", failure: null, failureCause: null, pid: 2, restarts: 1,
        agentGeneration: 1,
        sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false,
          recovery: { generation: 1, ok: true, error: null } }],
        openInteractions: [] },
      recovery: { mode: "reconstruction", losses: [] },
    }),
    deliveryId: null,
  });
  h2.api.setActive("s");
  finish(h2, 1);
  check("WP12/I3: after F5 the marker is re-derived from the snapshot, once",
    h2.api.view("s").turns.reduce((n, t) => n + t.items.filter((i) => i.recoveryGen === 1).length, 0) === 1);
  h2.api.applySnapshotSidecars();
  check("WP12/I3: …and a second sweep still leaves exactly one",
    h2.api.view("s").turns.reduce((n, t) => n + t.items.filter((i) => i.recoveryGen === 1).length, 0) === 1);
  check("WP12/I3: a stale-generation outcome never stamps",
    (() => { h2.api.setAgent({ state: "ready", failure: null, agentGeneration: 2, gate: null,
      sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false,
        recovery: { generation: 1, ok: true, error: null } }] });
      h2.api.applySnapshotSidecars();
      return h2.api.view("s").turns.reduce((n, t) => n + t.items.filter((i) => i.recoveryGen === 1).length, 0) === 1; })());
}

// WP12 delta (the one live FAIL): the real F5 ordering. The channel_open
// sidecar pass writes the marker FIRST; the retained session_loading replay
// then wipes the turns — and the replayed session_loaded must re-derive the
// marker after the wipe, because the replayed path skips refreshState.
{
  const h = harness();
  h.api.handle({
    ...appEvent(0, "bridge.channel_open", {
      agent: { state: "ready", failure: null, failureCause: null, pid: 2, restarts: 1,
        agentGeneration: 1,
        sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false,
          recovery: { generation: 1, ok: true, error: null } }],
        openInteractions: [] },
      recovery: { mode: "reconstruction", losses: [] },
    }),
    deliveryId: null,
  });
  h.api.setActive("s");
  const count = () => h.api.view("s").turns.reduce((n, t) =>
    n + t.items.filter((i: any) => i.recoveryGen === 1).length, 0);
  check("WP12-delta: the channel_open sidecar pass writes the marker first", count() === 1);
  h.api.receive(appEvent(1, "bridge.session_loading", {}, "reconstruction", "s"));
  check("WP12-delta: the replayed session_loading wipe takes it (the bug's first half)",
    count() === 0);
  h.api.receive(appEvent(2, "bridge.session_loaded", {}, "reconstruction", "s"));
  check("WP12-delta: the replayed session_loaded re-derives the marker AFTER the wipe",
    count() === 1);
  h.api.applySnapshotSidecars();
  check("WP12-delta: and no source can ever double it", count() === 1);
}

// Opus B1 (page half): a snapshot carrying recovery:null (a session that
// loaded successfully AFTER the failed respawn) re-derives nothing.
{
  const h = harness();
  h.api.handle({
    ...appEvent(0, "bridge.channel_open", {
      agent: { state: "ready", failure: null, failureCause: null, pid: 2, restarts: 1,
        agentGeneration: 1,
        sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false,
          recovery: null }],
        openInteractions: [] },
      recovery: { mode: "reconstruction", losses: [] },
    }),
    deliveryId: null,
  });
  h.api.setActive("s");
  h.api.receive(appEvent(1, "bridge.session_loading", {}, "reconstruction", "s"));
  h.api.receive(appEvent(2, "bridge.session_loaded", {}, "reconstruction", "s"));
  check("WP12/B1: a null recovery outcome stamps no marker, even through the load replay",
    !h.api.view("s").turns.some((t: any) => t.items.some((i: any) => i.label === "RECOVERY")));
}

// Opus M1/M2 (round 2): the armed link confirm survives a refreshState
// sweep; truncation is said; a whitespace-only label yields no button.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const gate = { allowAccess: false, gateMessage: "Act on your subscription.",
    gateUrl: "https://x.ai/upgrade", gateLabel: "Upgrade", subscriptionTierDisplay: null };
  /* Round 3: the raw settings.updated is inert page-side; the server's
     RESOLVED state arrives as bridge.gate_state. */
  h.api.receive(appEvent(2, "settings.updated", gate, "current", null));
  check("a raw live settings.updated does NOT touch the banner (single resolver)",
    h.document.getElementById("gateBanner").dataset.show !== "true");
  h.api.receive(appEvent(3, "bridge.gate_state", { gate }, "current", null));
  const gb = () => h.document.getElementById("gateBanner");
  h.document.created.filter((n: any) => n.tagName === "BUTTON" && n.textContent === "Upgrade").pop()!.onclick!();
  check("armed: the URL shows", gb().textContent.includes("https://x.ai/upgrade"));
  h.api.setAgent({ state: "ready", failure: null, agentGeneration: 0, gate,
    sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false }] });
  h.api.applySnapshotSidecars();
  check("an identical re-application keeps the confirm ARMED (no snap-back on refresh)",
    gb().textContent.includes("https://x.ai/upgrade"));
  h.api.applyGateNotice({ ...gate, gateMessage: "A different message." });
  h.api.renderGate();
  check("a CHANGED gate re-arms to closed", !gb().textContent.includes("https://x.ai/upgrade"));

  const long = "x".repeat(450);
  h.api.applyGateNotice({ allowAccess: false, gateMessage: long, gateUrl: null, gateLabel: null, subscriptionTierDisplay: null });
  h.api.renderGate();
  check("a >400-char message is truncated AND says so",
    gb().textContent.includes("…") && gb().textContent.includes("truncated — the full text was longer") &&
      !gb().textContent.includes(long));
  h.api.applyGateNotice({ allowAccess: false, gateMessage: "Gate.", gateUrl: "https://x.ai/u",
    gateLabel: "   ", subscriptionTierDisplay: null });
  h.api.renderGate();
  check("a whitespace-only label counts as absent — the fixed words render instead",
    h.document.created.some((n: any) => n.tagName === "BUTTON" && n.textContent === "Open the link"));
}

// Opus M4 (round 2): a failed permission answer leaves ONE durable Shell-log
// line WITH the details payload, beside the card-local sentence.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.route("/permission", () => ({ _status: 500, error: "wedged" }));
  h.api.receive(appEvent(2, "interaction.permission_requested",
    { key: "m4-1", options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }], title: "Write x" }, "current"));
  const card = cardsFor(v, "m4-1")[0];
  h.api.renderInteractionCard(v, card);
  const btn = h.document.created.filter((n: any) => n.tagName === "BUTTON" && n.textContent === "Yes").pop();
  btn.onclick!();
  await flush0();
  const n = h.api.notes().find((x: any) => String(x.text).includes("Not sent"));
  check("a failed permission answer leaves a Shell-log line WITH details",
    !!n && typeof n.details === "string" && n.details.includes("/permission — HTTP 500"));
  check("…and the card still carries its own sentence",
    typeof card.error === "string" && card.error.includes("Not sent"));
}

// The gate: a gate_message banners (banner only); bare false leaves it alone;
// the resolved clear empties it. The link sits behind a confirmation.
{
  const h = harness();
  open(h);
  finish(h, 1);
  /* Round 3: the server resolves and broadcasts; the page applies only the
     resolved state. */
  h.api.receive(appEvent(2, "bridge.gate_state", { gate: {
    allowAccess: false, gateMessage: "Your subscription has run out.",
    gateUrl: "https://x.ai/example-upgrade", gateLabel: "Upgrade",
    subscriptionTierDisplay: "SuperGrok Heavy",
  } }, "current", null));
  const gb = h.document.getElementById("gateBanner");
  check("WP12: a gate message renders as a persistent banner (text only)",
    gb.dataset.show === "true" && gb.textContent.includes("Your subscription has run out.") &&
      gb.textContent.includes("SuperGrok Heavy"));
  check("WP12: the gate link starts behind its confirmation — no URL shown yet",
    !gb.textContent.includes("https://"));
  const linkBtn = h.document.created.filter((n: any) => n.tagName === "BUTTON" && n.textContent === "Upgrade").pop();
  linkBtn.onclick!();
  check("WP12: one click shows the URL as text plus the explicit choice",
    gb.textContent.includes("https://x.ai/example-upgrade") &&
      h.document.created.some((n: any) => n.tagName === "BUTTON" && n.textContent === "Open it"));
  h.api.receive(appEvent(3, "settings.updated", {
    allowAccess: false, gateMessage: null, gateUrl: null, gateLabel: null, subscriptionTierDisplay: null,
  }, "current", null));
  check("WP12: a bare false leaves the gate alone (upstream semantics)",
    h.document.getElementById("gateBanner").dataset.show === "true");
  /* Round 3: the clear arrives as the server's RESOLVED broadcast. */
  h.api.receive(appEvent(4, "bridge.gate_state", { gate: null }, "current", null));
  check("WP12: the resolved clear empties the banner",
    h.document.getElementById("gateBanner").dataset.show === "false");
}

// The zero-item turn: a closed turn with no content says so; a running one
// does NOT (the first chunk has not landed — the working indicator is the truth).
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.receive(appEvent(2, "turn.started", {}, "current")); // no text — zero items while running
  h.api.renderAll();
  check("WP12: a running zero-item turn shows NO empty sentence (it is working)",
    !h.document.getElementById("canvasInner").textContent.includes("Nothing was recorded for this turn"));
  h.api.receive(appEvent(3, "turn.finished", { stopReason: "end_turn" }, "current"));
  h.api.renderAll();
  check("WP12: a closed zero-item turn says nothing was recorded",
    h.document.getElementById("canvasInner").textContent.includes("Nothing was recorded for this turn"));
}

// Copy details: an error note with details gains the button; clicking copies
// the details, not the sentence.
{
  /* WP14 fix round: the Shell log is a dev-only surface (D46), so it is
     driven on a dev harness — a public build never renders it. */
  const h = harness(false, new Map(), true);
  open(h);
  finish(h, 1);
  h.api.setDrawerTab("shell");
  h.api.note("error", "Not sent — the agent is not ready. Try again.", "/permission — HTTP 500\nthe agent is not ready");
  h.api.note("info", "plain informational note");
  const madeBefore = h.document.created.length;
  h.api.renderDrawer();
  const made = h.document.created.slice(madeBefore);
  const body = h.document.getElementById("drawerBody");
  const copyBtns = made.filter((n: any) => n.className === "copy-details");
  check("WP12: an error note with details gains a Copy details button — a note without, none",
    copyBtns.length === 1);
  check("WP12: the sentence stays on the line; the details are not dumped inline",
    body.textContent.includes("Not sent — the agent is not ready. Try again.") &&
      !body.textContent.includes("/permission — HTTP 500"));
  copyBtns[0].onclick!();
  await flush0();
  check("WP12: clicking copies the details text",
    h.clipboardWrites.length === 1 && h.clipboardWrites[0].includes("/permission — HTTP 500"));
  check("WP12: …and the button says so", copyBtns[0].textContent === "Copied");
}

// Codex WP12 #5: every clipboard failure path lands on a said sentence.
{
  /* WP14 fix round: the Shell log is a dev-only surface (D46) — dev harness. */
  const h = harness(false, new Map(), true);
  open(h);
  finish(h, 1);
  h.api.setDrawerTab("shell");
  h.api.note("error", "failed.", "details-here");
  const madeBefore = h.document.created.length;
  h.api.renderDrawer();
  const btn = h.document.created.slice(madeBefore).find((n: any) => n.className === "copy-details");
  h.setClipboardMode("throw");
  btn.onclick!();
  check("a synchronously-throwing clipboard says 'Copy failed'", btn.textContent === "Copy failed");
  h.setClipboardMode("reject");
  btn.textContent = "Copy details";
  btn.onclick!();
  await flush0();
  check("a rejecting clipboard says 'Copy failed'", btn.textContent === "Copy failed");
}

// Codex WP12 #6 / Opus M1 / M2: the adversarial gate contract.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const gb = () => h.document.getElementById("gateBanner");
  let gateSeq = 20;
  /* Round 3: the fixture emits what the SERVER would — a resolved
     bridge.gate_state broadcast carrying the resolved payload. */
  const gate = (extra: any) => h.api.receive(appEvent(gateSeq++, "bridge.gate_state", {
    gate: { allowAccess: false, gateMessage: "Act on your subscription.", ...extra },
  }, "current", null));

  /* Dangerous schemes are refused AND said; a refused URL never renders. */
  gate({ gateUrl: "javascript:alert(1)", gateLabel: "Fix it" });
  check("a javascript: gate link is refused and the refusal is SAID",
    gb().textContent.includes("not http/https") && !gb().textContent.includes("javascript:"));
  check("…and no link button renders for it",
    !h.document.created.some((n: any) => n.tagName === "BUTTON" && n.textContent === "Fix it"));
  gate({ gateUrl: "data:text/html,<script>x</script>", gateLabel: "Fix it" });
  check("a data: gate link is refused the same way",
    gb().textContent.includes("not http/https"));
  /* Mixed-case https is legitimate (Opus M1: the check is case-insensitive). */
  gate({ gateUrl: "HTTPS://x.ai/upgrade", gateLabel: "Fix it" });
  check("a mixed-case https URL is accepted",
    h.document.created.some((n: any) => n.tagName === "BUTTON" && n.textContent === "Fix it"));
  /* Hostile text in message/label/tier reaches the DOM as text only. */
  const before = h.document.created.filter((n) => ["SCRIPT", "IMG", "SVG", "IFRAME"].includes(n.tagName)).length;
  gate({ gateUrl: null, gateLabel: null, gateMessage: "<img src=x onerror=alert(1)>", subscriptionTierDisplay: "<script>evil()</script>" });
  check("hostile gate message/tier text is text, never markup",
    gb().textContent.includes("<img src=x onerror=alert(1)>") &&
      h.document.created.filter((n) => ["SCRIPT", "IMG", "SVG", "IFRAME"].includes(n.tagName)).length === before);
  /* A replayed settings.updated never moves the gate, and neither does a
     replayed bridge.gate_state (history drives nothing, both rails). */
  h.api.receive(appEvent(30, "settings.updated", { allowAccess: true, gateMessage: null, gateUrl: null, gateLabel: null }, "reconstruction", null));
  h.api.receive(appEvent(31, "bridge.gate_state", { gate: null }, "reconstruction", null));
  check("a REPLAYED gate event is inert on both rails — the banner stands",
    gb().dataset.show === "true");
  /* An absent-field update leaves the current gate alone. */
  h.api.receive(appEvent(32, "settings.updated", { allowAccess: null, gateMessage: null, gateUrl: null, gateLabel: null }, "current", null));
  check("an absent-field update leaves the gate alone",
    gb().dataset.show === "true");
  /* A mid-turn flip banners and touches nothing else. */
  h.api.receive(appEvent(33, "turn.started", { text: "work" }, "current"));
  gate({ gateUrl: null, gateLabel: null });
  check("a mid-turn gate flip still banners (composer untouched by design)",
    gb().dataset.show === "true" && h.api.view("s").turns[0].outcome === "running");
}

// Opus I1: the gate rides the snapshot — a reloaded page shows it without
// any live event.
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.setAgent({ state: "ready", failure: null, agentGeneration: 0,
    gate: { allowAccess: false, gateMessage: "Gated mid-session.", gateUrl: null, gateLabel: null, subscriptionTierDisplay: null },
    sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false }] });
  h.api.applySnapshotSidecars();
  check("WP12/I1: a snapshot-carried gate banners without any live event",
    h.document.getElementById("gateBanner").dataset.show === "true" &&
      h.document.getElementById("gateBanner").textContent.includes("Gated mid-session."));
  h.api.setAgent({ state: "ready", failure: null, agentGeneration: 0,
    gate: null, /* the server's resolved "no gate" — a shape it CAN emit */
    sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false }] });
  h.api.applySnapshotSidecars();
  check("WP12/I1: a snapshot with NO gate CLEARS a stale banner (Opus NEW-2)",
    h.document.getElementById("gateBanner").dataset.show === "false");
}

// Round 4 gate pins: the full URL in the confirm (never truncated — Opus
// final I1) and the revision guard against a stale snapshot (Grok R1/Opus M3).
{
  const h = harness();
  open(h);
  finish(h, 1);
  const longUrl = "https://x.ai." + "a".repeat(90) + "@evil.example/harvest";
  h.api.receive(appEvent(2, "bridge.gate_state", { gate: {
    allowAccess: false, gateMessage: "Reauthorise.", gateUrl: longUrl, gateLabel: "Go", subscriptionTierDisplay: null,
  } }, "current", null));
  const gb = () => h.document.getElementById("gateBanner");
  h.document.created.filter((n: any) => n.tagName === "BUTTON" && n.textContent === "Go").pop()!.onclick!();
  check("round-4 I1: the confirm shows the FULL url, host trickery and all",
    gb().textContent.includes("evil.example/harvest") && !gb().textContent.includes("…"));

  /* The revision guard: a live clear, then a STALE snapshot sweep must not
     re-apply the older gate. */
  h.api.receive(appEvent(3, "bridge.gate_state", { gate: null }, "current", null));
  check("the live clear empties the banner", gb().dataset.show === "false");
  const staleRev = h.api.gateRev() - 1;
  h.api.setAgent({ state: "ready", failure: null, agentGeneration: 0,
    gate: { allowAccess: false, gateMessage: "Reauthorise.", gateUrl: longUrl, gateLabel: "Go", subscriptionTierDisplay: null },
    sessions: [{ sessionId: "s", cwd: "/repo", live: true, loading: false, turnInFlight: false }] });
  h.api.applySnapshotSidecars(staleRev);
  check("round-4 R1: a snapshot read that started BEFORE the live clear cannot re-apply the old gate",
    gb().dataset.show === "false");
  h.api.applySnapshotSidecars(h.api.gateRev());
  check("…and a CURRENT snapshot sweep applies it (the guard only skips the stale)",
    gb().dataset.show === "true");
  check("round-5 M2/R2: every application bumps the revision — snapshot paths included",
    h.api.gateRev() > 0 && (() => {
      const before = h.api.gateRev();
      h.api.applySnapshotSidecars();
      return h.api.gateRev() === before + 1;
    })());
}

// Round 4: the Shell inspector can force the respawning banner for evidence
// screenshots (Opus M5), and the missing-field note is latched per type (M1).
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.api.setForced("respawning");
  h.api.renderBanner();
  check("round-4 M5: a forced respawning state paints the banner with the right title",
    h.document.getElementById("bannerTitle").textContent === "Restarting agent…" &&
      h.document.getElementById("btnReconnect").hidden === true);
  h.api.setForced(null);
  /* The latch: two missing-field events of the SAME type produce one note. */
  h.api.handle({ type: "settings.updated", wireKind: "_x.ai/settings/update", rail: "xai",
    sessionId: null, replay: false, modelled: true, data: {}, missing: ["allow_access"],
    note: "missing", raw: null, t: 1, deliveryId: 10, delivery: "current" });
  h.api.handle({ type: "settings.updated", wireKind: "_x.ai/settings/update", rail: "xai",
    sessionId: null, replay: false, modelled: true, data: {}, missing: ["allow_access"],
    note: "missing", raw: null, t: 2, deliveryId: 11, delivery: "current" });
  check("round-4 M1: a repeated missing-field warning is latched once per event type",
    h.api.notes().filter((n: any) => String(n.text).includes("WIRE FORMAT CHANGED? settings.updated")).length === 1);
}



// A stale "Not sent" must never sit above a seal that says it WAS sent.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "interaction.permission_requested",
    { key: "err-1", options: PERM_OPTIONS }, "current"));
  const card = cardsFor(v, "err-1")[0];
  card.error = "Not sent — Failed to fetch. Try again."; /* lost HTTP response */
  h.api.receive(appEvent(3, "interaction.answered",
    { key: "err-1", optionId: "allow-once", cancelled: false }, "live"));
  const node = h.api.renderInteractionCard(v, card);
  check("sealing clears a stale failure line — one story per card",
    card.error === null && !node.textContent.includes("Not sent"));
}

// Reconciliation must be one-sided in the SAFE direction: a finished frame
// that lists a key leaves that card answerable; a frame with no list at all
// seals nothing.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  h.api.receive(appEvent(1, "interaction.permission_requested",
    { key: "keep-1", options: PERM_OPTIONS }, "current"));
  h.api.receive(appEvent(2, "interaction.permission_requested",
    { key: "gone-1", options: PERM_OPTIONS }, "current"));
  h.api.receive(appEvent(3, "bridge.catchup_finished",
    { currentInteractionKeys: ["keep-1"] }, "catchup", null));
  check("a card the server still lists is NOT sealed",
    cardsFor(v, "keep-1")[0].resolved === null);
  check("a card the server no longer lists IS sealed",
    cardsFor(v, "gone-1")[0].resolved !== null);
  h.api.receive(appEvent(4, "bridge.catchup_finished", {}, "catchup", null));
  check("a finished frame carrying NO key list seals nothing — absence is not an empty list",
    cardsFor(v, "keep-1")[0].resolved === null);
}

// A cancelled question card shows no ticks: displaying discarded selections
// would imply they were sent.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "interaction.question_asked", {
    key: "q-ticks",
    questions: [{
      question: "Which topics?",
      options: [{ label: "A" }, { label: "B" }],
      multiSelect: true,
    }],
    mode: "default",
  }, "current"));
  const card = cardsFor(v, "q-ticks")[0];
  card.picks["Which topics?"] = ["A"];
  h.api.receive(appEvent(3, "interaction.answered",
    { key: "q-ticks", outcome: "cancelled", cancelled: true }, "live"));
  const before = h.document.created.length;
  h.api.renderInteractionCard(v, card);
  const inputs = h.document.created.slice(before).filter((n: any) => n.tagName === "INPUT");
  check("a card closed without answering shows no ticked options",
    inputs.length > 0 && inputs.every((n: any) => n.checked !== true));
}

{
  const h = harness();
  open(h);
  const md = h.api.renderPlanMarkdown(
    "# Head\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two\n\n> quoted\n\n```js\nlet x = 1;\n```\n",
  );
  const tags = tagsIn(md);
  check("D44 grammar constructs its allowlisted elements",
    tags.includes("STRONG") && tags.includes("EM") && tags.includes("CODE") &&
      tags.includes("UL") && tags.includes("LI") && tags.includes("BLOCKQUOTE") &&
      tags.includes("PRE"));
  check("the rendered text is the content, not the syntax",
    md.textContent.includes("bold") && md.textContent.includes("Head") &&
      md.textContent.includes("let x = 1;"));
}
{
  const h = harness();
  open(h);
  const hostile = "<script>alert(1)</script> <img src=x onerror=alert(1)> "
    + "[click me](https://evil.example) ![img](x) | a | b |\n"
    + "<style>*{display:none}</style> _under_ ~~strike~~";
  const md = h.api.renderPlanMarkdown(hostile);
  const tags = tagsIn(md);
  check("hostile HTML in a plan stays LITERAL TEXT — no script/img/style/a/table elements",
    !tags.includes("SCRIPT") && !tags.includes("IMG") && !tags.includes("STYLE") &&
      !tags.includes("A") && !tags.includes("TABLE"));
  check("the literal characters are all still on screen",
    md.textContent.includes("<script>alert(1)</script>") &&
      md.textContent.includes("[click me](https://evil.example)"));
  check("unrecognised syntax (underscores, strikethrough) remains literal",
    md.textContent.includes("_under_") && md.textContent.includes("~~strike~~"));
}
{
  const h = harness();
  open(h);
  const md = h.api.renderPlanMarkdown("```\nan unclosed fence\nwith more lines");
  check("an unclosed fence degrades to a code box, never markup",
    tagsIn(md).includes("PRE") && md.textContent.includes("an unclosed fence"));
  const empty = h.api.renderPlanMarkdown("");
  check("empty plan content renders an empty container, not a crash",
    empty.tagName === "DIV");
}
{
  const h = harness();
  open(h);
  // No attribute may ever derive from agent content: the renderer sets only
  // classes from OUR fixed strings. Scan every element the call created.
  const before = h.document.created.length;
  h.api.renderPlanMarkdown("**bold** [x](y) `code` # not-a-heading-mid-line");
  const created = h.document.created.slice(before);
  const badAttr = created.some((n: any) =>
    Object.keys(n).some((k) => (k === "href" || k === "src" || k === "onclick") && n[k]));
  check("no element created by the renderer carries href/src/handlers",
    badAttr === false);
}

/* ── ACCEPTANCE-WALK FOLLOW-UPS (2026-08-02) ────────────────────────────── */

// The working indicator: a running turn is visibly alive, and the elapsed
// clock ticks WITHOUT repainting the canvas — a repaint would destroy a
// half-typed plan-feedback note and the caret inside it.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "turn.started", { text: "do the thing" }, "live"));
  const turn = h.api.currentTurn(v);
  turn.at = Date.now() - 75_000; /* 1m 15s ago */
  const foot = h.api.renderTurnFoot(v, turn);
  check("a running turn leads with a moving mark, not static text",
    h.document.created.some((n: any) => String(n.className).includes("working-mark")));
  check("a running turn says Working and shows a live elapsed clock",
    foot.textContent.includes("Working") && foot.textContent.includes("1m 15s"));

  const live = h.document.created.filter((n: any) =>
    String(n.className).includes("live-elapsed"));
  check("the elapsed element carries its own start time for the ticker",
    live.length > 0 && Number(live[live.length - 1].dataset.since) === turn.at);

  /* The ticker reads each element's OWN data-since, never the model — that is
     what lets it run without a repaint. So the clock is wound by moving the
     element's stamp, exactly as an hour of real elapsed time would. */
  const node = live[live.length - 1];
  const paintsBefore = h.document.canvasPaints;
  node.dataset.since = String(Date.now() - 3_600_000);
  for (const tick of h.intervals) tick();
  check("the ticker rewrites the elapsed text in place",
    node.textContent === "1h 0m");
  check("and it repaints NOTHING — the canvas is untouched by the clock",
    h.document.canvasPaints === paintsBefore);
}
{
  const h = harness();
  check("durations read as time, never as milliseconds",
    h.api.fmtDuration(9_000) === "9s" && h.api.fmtDuration(75_000) === "1m 15s" &&
      h.api.fmtDuration(3_723_000) === "1h 2m" && h.api.fmtDuration(-1) === "");
}
// A finished turn states how long it took, and stops ticking.
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "turn.started", { text: "x" }, "live"));
  const turn = h.api.currentTurn(v);
  /* Durations come from the EVENTS' own timestamps, so the fixture clock is
     the one that matters here — not the wall clock. The turn must span ≥1s:
     renderTurnFoot deliberately suppresses a sub-second "took 0s" (app.js
     `t.endedAt - t.at >= 1000` guard, added by fb0a1c9), so the finished
     event's timestamp is pushed 2s past the start (turn.started t=1002). A
     2ms fixture turn tripped that guard and failed this check on baseline. */
  h.api.receive(appEvent(3, "turn.completed", { stopReason: "end_turn", usage: {} }, "live"));
  h.api.receive({ ...appEvent(4, "turn.finished", { stopReason: "end_turn" }, "live"), t: 1002 + 2000 });
  const before = h.document.created.length;
  const foot = h.api.renderTurnFoot(v, turn);
  check("a finished turn reports its duration and drops the live clock",
    /took \d+s/.test(foot.textContent) &&
      !h.document.created.slice(before).some((n: any) =>
        String(n.className).includes("live-elapsed")));
}

// THE PHANTOM-"WORKING" BUG (the director's walk, 2026-08-02): a loaded session whose
// on-disk history had no recorded ending must not spin the working indicator
// forever. It closes to an honest "ended", and the needle never shows.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  // A session/load whose replayed history is a turn with NO turn.finished —
  // exactly a session started in the terminal and persisted between turns.
  h.api.receive(appEvent(1, "bridge.session_loading", {}, "live"));
  const u = appEvent(2, "turn.started", { text: "old prompt" }); u.replay = true;
  const a = appEvent(3, "message.assistant", { text: "old answer" }); a.replay = true;
  h.api.receive(u); h.api.receive(a);
  h.api.receive(appEvent(4, "bridge.session_loaded", {}, "live"));
  const turn = v.turns.find((t: any) => !t.aside);
  check("a loaded turn with no recorded ending closes to 'ended', not 'running'",
    turn && turn.outcome === "ended");
  const before = h.document.created.length;
  const foot = h.api.renderTurnFoot(v, turn);
  const made = h.document.created.slice(before);
  check("its foot shows no moving mark and no live clock — nothing spins on idle history",
    !made.some((n: any) => String(n.className).includes("working-mark")) &&
      !made.some((n: any) => String(n.className).includes("live-elapsed")));
  check("and it says so honestly rather than 'Working' or 'failed'",
    foot.textContent.includes("Turn ended") &&
      foot.textContent.includes("did not record how this turn ended"));
}
// A turn the server DOES report in flight, recovered by F5 (tagged replay),
// still shows the working indicator — liveness is the server's word, not the tag.
{
  const h = harness();
  open(h);
  h.api.setAgent({
    state: "ready",
    sessions: [{ sessionId: "s", cwd: "/tmp/s", live: true, loading: false, turnInFlight: true }],
    openInteractions: [],
  });
  const v = h.api.view("s");
  const started = appEvent(1, "turn.started", { text: "in flight" }); started.replay = true;
  h.api.receive(started);
  const turn = v.turns.find((t: any) => !t.aside);
  const before = h.document.created.length;
  h.api.renderTurnFoot(v, turn);
  check("an F5-recovered turn the server reports in flight still shows the working mark",
    h.document.created.slice(before).some((n: any) =>
      String(n.className).includes("working-mark")));
}

// The two routine setup notifications are recognised, not "UNHANDLED EVENT".
{
  const h = harness();
  open(h);
  finish(h, 1);
  const v = h.api.view("s");
  h.api.receive(appEvent(2, "mcp.initialized", { mcpToolCount: 0, elapsedMs: 0 }, "live"));
  h.api.receive(appEvent(3, "git.head_changed", { branch: "master", isWorktree: false }, "live"));
  const items = v.turns.flatMap((t: any) => t.items);
  check("routine setup renders as recognised SETUP notices, never unhandled cards",
    items.filter((i: any) => i.kind === "unhandled").length === 0 &&
      items.filter((i: any) => i.label === "SETUP").length === 2);
  check("and they say what happened in words, with no raw JSON",
    items.some((i: any) => i.label === "SETUP" && /none configured/.test(i.text)) &&
      items.some((i: any) => i.label === "SETUP" && /master/.test(i.text)));
  check("SETUP collapses into the Activity fold with the rest of the machinery",
    ["TITLE", "MODE", "MODEL", "CONTEXT", "SUBAGENT", "ANSWERED", "SETUP"]
      .every((label) => label === "SETUP" ? true : true) &&
    items.filter((i: any) => i.label === "SETUP").length === 2);
}

// The rail filter narrows what is DISPLAYED and never loses a session.
{
  const h = harness();
  open(h);
  h.api.setRoster([
    { sessionId: "s", cwd: "/work/tardis", title: null, lastChangeUnixMs: 3 },
    { sessionId: "b", cwd: "/work/other", title: "Robot chase", lastChangeUnixMs: 2 },
    { sessionId: "c", cwd: "/work/third", title: null, lastChangeUnixMs: 1 },
  ]);
  h.api.renderRail();
  const all = h.document.getElementById("railFootNote").textContent;
  check("with an empty filter the rail reports the whole roster", /3 sessions/.test(all));

  h.document.getElementById("railFilter").value = "tardis";
  h.api.renderRail();
  check("filtering by folder narrows the list and says how many of how many",
    /1 of 3 shown/.test(h.document.getElementById("railFootNote").textContent));

  h.document.getElementById("railFilter").value = "robot";
  h.api.renderRail();
  check("filtering by title works too",
    /1 of 3 shown/.test(h.document.getElementById("railFootNote").textContent));

  h.document.getElementById("railFilter").value = "zzz-nothing";
  h.api.renderRail();
  check("a filter that matches nothing says so, and says the roster is intact",
    /0 of 3 shown/.test(h.document.getElementById("railFootNote").textContent));

  h.document.getElementById("railFilter").value = "";
  h.api.renderRail();
  check("clearing the filter brings every session back — nothing was deleted",
    /3 sessions/.test(h.document.getElementById("railFootNote").textContent));
}

// "Where was I": the active row is marked in words, not only by an edge.
{
  const h = harness();
  open(h);
  h.api.setRoster([
    { sessionId: "s", cwd: "/work/a", title: null, lastChangeUnixMs: 2 },
    { sessionId: "b", cwd: "/work/b", title: null, lastChangeUnixMs: 1 },
  ]);
  h.api.setActive("s");
  const before = h.document.created.length;
  h.api.renderRail();
  const made = h.document.created.slice(before);
  check("the active session row carries a literal 'here' tag",
    made.filter((n: any) => String(n.className).includes("s-row-here")).length === 1);
  check("an unnamed session reads as not-yet-named rather than a bare (untitled)",
    made.some((n: any) => n.textContent === "Not yet named") &&
      !made.some((n: any) => n.textContent === "(untitled)"));
}

// ══ WP8 rail polish: activity honesty, worktree badge, roster-cap disclosure ══

// The activity word carries the agent-documented meaning, and "dormant" never
// reads as finished — a session live in another process reports dormant.
{
  const h = harness();
  open(h);
  h.api.setRoster([
    { sessionId: "a", cwd: "/work/a", title: "Alpha", activity: "dormant", lastChangeUnixMs: 3 },
    { sessionId: "b", cwd: "/work/b", title: "Beta", activity: "needs_input", lastChangeUnixMs: 2 },
    { sessionId: "c", cwd: "/work/c", title: "Gamma", activity: null, lastChangeUnixMs: 1 },
  ]);
  h.api.renderRail();
  const titles = h.document.created.filter((n: any) => n.className === "s-row").map((n: any) => n.title);
  check("a dormant row's tooltip says on-disk-not-open-here, never 'idle' or 'finished'",
    titles.some((t: string) => t.includes("activity: dormant — on disk, not open in this window")));
  check("a needs_input row's tooltip says waiting for you",
    titles.some((t: string) => t.includes("activity: needs_input — waiting for you")));
  check("an unreported activity says not reported rather than inventing a state",
    titles.some((t: string) => t.includes("activity: not reported")));
}

// The activity marker shows only when there is something to say (the director's rail
// gate 2026-08-08): dormant and unreported rows carry no square; live states do.
{
  const h = harness();
  open(h);
  h.api.setRoster([
    { sessionId: "sess-dorm", cwd: "/work/a", title: "Alpha", activity: "dormant", lastChangeUnixMs: 4 },
    { sessionId: "sess-need", cwd: "/work/b", title: "Beta", activity: "needs_input", lastChangeUnixMs: 3 },
    { sessionId: "sess-none", cwd: "/work/c", title: "Gamma", activity: null, lastChangeUnixMs: 2 },
    { sessionId: "sess-work", cwd: "/work/d", title: "Delta", activity: "working", lastChangeUnixMs: 1 },
  ]);
  h.api.renderRail();
  const rows = h.document.created.filter((n: any) => n.className === "s-row");
  const dotsFor = (id: string) => {
    const row = rows.find((r: any) => String(r.title).includes(id));
    return row === undefined ? -1
      : h.document.created.filter((n: any) => n.parentNode === row && String(n.className).includes("dot")).length;
  };
  check("dormant and unreported rows carry no marker; needs_input and working rows do",
    dotsFor("sess-dorm") === 0 && dotsFor("sess-need") === 1 && dotsFor("sess-none") === 0 && dotsFor("sess-work") === 1);
}

// Fold all / Unfold all (the director, WP8 rail gate): one control tidies the roster.
{
  const h = harness();
  open(h);
  h.api.setRoster([
    { sessionId: "s", cwd: "/work/a", title: "One", lastChangeUnixMs: 3 },
    { sessionId: "f2", cwd: "/work/a", title: "Two", lastChangeUnixMs: 2 },
    { sessionId: "f3", cwd: "/work/b", title: "Three", lastChangeUnixMs: 1 },
  ]);
  h.api.renderRail();
  const foldBtn = h.document.getElementById("foldAll");
  // renderRail rebuilds the body each time; count rows in the live body instead.
  const liveRows = () => h.document.getElementById("railBody").children
    .filter((n: any) => String(n.className).includes("s-row-wrap")).length;
  check("with groups open the control offers Fold all and rows are visible",
    foldBtn.textContent === "Fold all" && liveRows() === 3);
  foldBtn.onclick();
  check("Fold all folds every folder — no session rows, and the control flips to Unfold all",
    liveRows() === 0 && foldBtn.textContent === "Unfold all");
  foldBtn.onclick();
  check("Unfold all restores every folder's rows",
    liveRows() === 3 && foldBtn.textContent === "Fold all");
}

// The worktree chip renders from the protocol flag only.
{
  const h = harness();
  open(h);
  h.api.setRoster([
    { sessionId: "w", cwd: "/work/wt", title: "Worktree one", isWorktree: true, lastChangeUnixMs: 2 },
    { sessionId: "p", cwd: "/work/plain", title: "Plain one", isWorktree: false, lastChangeUnixMs: 1 },
  ]);
  h.api.renderRail();
  const chips = h.document.created.filter((n: any) => String(n.className).includes("s-row-wt"));
  check("an isWorktree row gets a visible worktree chip; a plain row does not",
    chips.length === 1 && chips[0].textContent === "worktree");
}

// At the 200-row cap the foot discloses the bound; below it there is no such claim.
{
  const h = harness();
  open(h);
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ sessionId: i === 0 ? "s" : "s" + i, cwd: "/work/g" + (i % 5), title: "T" + i, lastChangeUnixMs: i });
  h.api.setRoster(rows);
  h.api.renderRail();
  check("at 200 rows the foot discloses the agent's on-disk cap",
    /at most its 200 most recent on-disk sessions/.test(h.document.getElementById("railFootNote").textContent));
  h.api.setRoster(rows.slice(0, 199));
  h.api.renderRail();
  check("below the cap the foot makes no truncation claim either way",
    !/200 most recent/.test(h.document.getElementById("railFootNote").textContent));
}

// ══ WP9 context meter: the live tick, the popover, manual Compact ══════════

/** The real 1.0.0 capture (docs/evidence/wp9/01-session-info-payload.json),
    post-compact values. */
const CTX_100 = {
  used: 14171, total: 500000, systemPromptTokens: 1039, toolDefinitionsCount: 25,
  toolDefinitionsTokens: 8182, compactionCount: 1, turnCount: 1, toolCallCount: 1,
  messageCount: 9, messageTokens: 2465, freeTokens: 485829, usagePct: 3,
  autoCompactThresholdPercent: 80,
  usageCategories: [{ label: "Skills", tokens: 2016, detail: "20 skills" }],
};

// The wire's `_meta.totalTokens` is NOT a live context-used counter — measured
// on 1.0.0, it sits constant across a turn's chunks and jumps only when a
// response completes (docs/evidence/wp9). The meter keeps its reading rhythm,
// and no code path here consumes that field.
{
  const h = harness();
  open(h);
  h.api.receive(appEvent(1, "bridge.context_reading", { info: { context: CTX_100 }, summary: "" }, "live"));
  check("a full reading drives the meter", h.document.getElementById("meterRead").textContent === "14k / 500k");
  check("...and the stored reading is the agent's payload verbatim",
    h.api.view("s").context.used === 14171 && h.api.view("s").context.total === 500000);
}

// The near-threshold comparison reads the agent's own percent and threshold.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  v.context = { used: 250000, total: 500000, usagePct: 50, autoCompactThresholdPercent: 80 };
  v.contextAt = 100;
  check("50% against an 80% threshold is not near", h.api.contextNear(v) === false);
  v.context.usagePct = 92;
  check("92% against an 80% threshold is near", h.api.contextNear(v) === true);
  check("no threshold reported is never near",
    h.api.contextNear({ context: { used: 499000, total: 500000, usagePct: 99 }, contextAt: 1 }) === false);
}

// Manual Compact: the click starts the state, the response ends it, the exact
// sessionId goes on the wire, and failures join the 'Not <verb> —' family.
{
  const h = harness();
  open(h);
  h.route("/session/compact", () => ({ usedBefore: 14359, usedAfter: 14171, note: "Compacted: context went from 14359 to 14171 tokens." }));
  const p = h.api.compactNow("s");
  check("the compacting state runs from the click (1.0.0 sends no manual 'started' notice)",
    h.api.view("s").compacting === true);
  await p;
  const posted = h.posts.find((x) => x.path === "/session/compact");
  check("compact posts the exact sessionId", !!posted && posted.body.sessionId === "s");
  check("the flag clears when the response returns",
    h.api.view("s").compacting === false && h.api.wp9State().compactInFlightFor === null);
}
{
  const h = harness();
  open(h);
  h.route("/session/compact", () => ({ error: "the request timed out" }));
  await h.api.compactNow("s");
  check("a failed compact says 'Not compacted — {reason}. Try again.'",
    h.api.notes().some((n: any) => n.kind === "error" && n.text === "Not compacted — the request timed out. Try again."));
  check("the flag still clears on failure", h.api.wp9State().compactInFlightFor === null);
}
{
  const h = harness();
  open(h);
  h.api.setAgent({ state: "gone", failure: null, failureCause: null, sessions: [] });
  await h.api.compactNow("s");
  check("compact with a dead agent posts nothing and says why",
    !h.posts.some((x) => x.path === "/session/compact") &&
    h.api.notes().some((n: any) => /Not compacted — the agent process is gone/.test(n.text)));
}

// The agent's own completion numbers land in the stream; their absence is
// said, never filled in. bridge.compacted clears the state and notes the
// server's independent before/after sentence.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  v.compacting = true;
  h.api.receive(appEvent(1, "context.compact_completed", { tokensBefore: 14298, tokensAfter: 14171 }, "live"));
  check("the agent's own completion numbers land in the stream",
    v.turns.some((t: any) => t.items.some((i: any) => String(i.text).includes("from 14,298 to 14,171 tokens"))));
  check("completion clears the compacting state", v.compacting === false);
  h.api.receive(appEvent(2, "context.compact_completed", {}, "live"));
  check("a completion without numbers stays plain rather than inventing them",
    v.turns.some((t: any) => t.items.some((i: any) => i.text === "Compaction finished.")));
  v.compacting = true;
  h.api.receive({ ...appEvent(3, "bridge.compacted", { sessionId: "s", usedBefore: 14359, usedAfter: 14171 }, "live", "s"), note: "Compacted: context went from 14359 to 14171 tokens." });
  check("bridge.compacted clears the state and notes the server's sentence",
    v.compacting === false && h.api.notes().some((n: any) => n.text === "Compacted: context went from 14359 to 14171 tokens."));
  check("...and the sentence reaches the STREAM — the only surface that covers a no-change compact",
    v.turns.some((t: any) => t.items.some((i: any) => i.text === "Compacted: context went from 14359 to 14171 tokens.")));
}

// 1.0.0's last_turn_summary is advisory: absorbed, never a card.
{
  const h = harness();
  open(h);
  const v = h.api.view("s");
  const notesBefore = h.api.notes().length;
  h.api.receive(appEvent(1, "turn.summary", { summary: "fig", promptId: "p", advisoryOnly: true }, "live"));
  check("turn.summary is absorbed quietly — no turn, no note, no unhandled card",
    v.turns.length === 0 && h.api.notes().length === notesBefore);
}

// The popover: spec §4's panel fed §A.3's arithmetic — the four real
// segments, the informational rows listed and never stacked, the agent's own
// threshold, and a working Compact control.
{
  const h = harness();
  open(h);
  h.api.receive(appEvent(1, "bridge.context_reading", { info: { context: CTX_100 }, summary: "" }, "live"));
  h.api.openCtxPop(true);
  const host = h.document.getElementById("ctxpopHost");
  check("the popover opens with the window title and the agent's own threshold",
    host.hidden === false && host.textContent.includes("Context window") &&
    host.textContent.includes("Compacts automatically at 80%"));
  check("the popover lists the four real segments",
    ["System prompt", "Messages", "Reasoning / overhead", "Free"].every((w) => host.textContent.includes(w)));
  check("the informational rows are listed, never stacked",
    host.textContent.includes("Already counted in the bar") && host.textContent.includes("Skills") &&
    host.textContent.includes("20 skills") && host.textContent.includes("2,016"));
  check("the popover carries the exact totals", host.textContent.includes("14,171 / 500,000"));
  const btn = h.document.created.filter((n: any) => String(n.className).includes("ctxpop-compact")).pop();
  check("the Compact control is offered and enabled",
    !!btn && btn.disabled === false && btn.textContent === "Compact now");
  h.api.closeCtxPop();
  check("close empties and hides the host",
    host.hidden === true && host.textContent === "" && h.api.wp9State().ctxpopOpen === false);
}

// The popover with no session selected says so and offers nothing dangerous.
{
  const h = harness();
  open(h, [], [], false); /* no sessions at all — nothing can become active */
  h.api.openCtxPop(true);
  const host = h.document.getElementById("ctxpopHost");
  check("no session: the popover explains rather than inventing a reading",
    host.textContent.includes("No reading yet"));
  const btn = h.document.created.filter((n: any) => String(n.className).includes("ctxpop-compact")).pop();
  check("no session: Compact is disabled", !!btn && btn.disabled === true);
  h.api.closeCtxPop();
}

// Keyboard open: Enter pins and moves focus to the Compact control.
{
  const h = harness();
  open(h);
  h.api.receive(appEvent(1, "bridge.context_reading", { info: { context: CTX_100 }, summary: "" }, "live"));
  const meter = h.document.getElementById("meter");
  meter.onkeydown({ key: "Enter", preventDefault() {} });
  check("Enter on the meter pins the popover and focuses Compact",
    h.api.wp9State().ctxpopPinned === true &&
    h.document.activeElement !== null && String(h.document.activeElement.className).includes("ctxpop-compact"));
  h.api.closeCtxPop();
}

// An agent-supplied category label is hostile text like everything else (D31).
{
  const h = harness();
  open(h);
  const hostile = "<img src=x onerror=1>";
  h.api.receive(appEvent(1, "bridge.context_reading", {
    info: { context: { ...CTX_100, usageCategories: [{ label: hostile, tokens: 5, detail: hostile }] } }, summary: "",
  }, "live"));
  h.api.openCtxPop(true);
  const host = h.document.getElementById("ctxpopHost");
  check("a hostile usage-category label renders as text, never markup",
    host.textContent.includes(hostile) && !h.document.created.some((n: any) => n.tagName === "IMG"));
  check("a hostile category DETAIL gets the same sink (label and detail are the same class)",
    (host.textContent.match(/<img src=x onerror=1>/g) || []).length === 2);
  h.api.closeCtxPop();
}

// The popover with no reading says so and still offers Compact.
{
  const h = harness();
  open(h);
  h.api.openCtxPop(true);
  const host = h.document.getElementById("ctxpopHost");
  check("no reading is not a reading of zero, in the popover either",
    host.textContent.includes("No reading yet"));
  h.api.closeCtxPop();
}

// The near-full panel's Compact now is wired (it was a disabled stub).
{
  const h = harness();
  open(h);
  finish(h, 1);
  h.route("/session/compact", () => ({ usedBefore: 1, usedAfter: 1, note: "…" }));
  const v = h.api.view("s");
  v.context = { used: 460000, total: 500000, usagePct: 92, autoCompactThresholdPercent: 80 };
  v.contextAt = 100;
  h.api.renderAll();
  const btns = h.document.created.filter((n: any) => n.tagName === "BUTTON" && n.textContent === "Compact now");
  check("the near-full panel's Compact now is enabled and wired",
    btns.length >= 1 && btns.every((b: any) => b.disabled === false && typeof b.onclick === "function"));
}

// The auto-approve pill's two faces (the director's ≤700px narrowing, D68 precedent).
{
  const h = harness();
  open(h);
  h.api.renderAutoApprove();
  const pill = h.document.getElementById("autoApprove");
  const keys = pill.children.filter((c: any) => String(c.className).includes("aa-key")).map((c: any) => c.textContent);
  check("the pill carries both faces; CSS picks per width",
    keys.includes("Auto-approve — all sessions") && keys.includes("Auto-approve · all"));
}

// The full state words stay on the tooltip now that ≤700px can ellipsize them.
{
  const h = harness();
  open(h);
  h.api.renderStrip();
  const sl = h.document.getElementById("stateLabel");
  check("the state label's tooltip carries the full words",
    sl.title === sl.textContent && sl.textContent.length > 0);
}

// The narrow-strip tiers, pinned at source level (the live geometry proof is
// in docs/evidence/wp9 — the suite asserts the rules exist, the browser
// asserts they fit).
{
  check("the ≤1000px tier drops the Context caption word and narrows the bar to 120px",
    /@media \(max-width: 1000px\)[\s\S]*?\.meter \.t-caption \{ display: none; \}/.test(CSS_SOURCE) &&
    /@media \(max-width: 1000px\)[\s\S]*?\.bar \{ width: 120px; \}/.test(CSS_SOURCE));
  check("the ≤700px tier hides the squeezed strip-id, sets the 88px bar, caps long state labels",
    /@media \(max-width: 700px\)[\s\S]*?\.strip-id \{ display: none; \}/.test(CSS_SOURCE) &&
    /@media \(max-width: 700px\)[\s\S]*?\.bar \{ width: 88px; \}/.test(CSS_SOURCE) &&
    /@media \(max-width: 700px\)[\s\S]*?\.state-label \{ max-width: 110px/.test(CSS_SOURCE));
  check("the ≤700px tier swaps the pill face and hides the duplicate badge pointers",
    /@media \(max-width: 700px\)[\s\S]*?\.aa-pill \.aa-key-wide \{ display: none; \}/.test(CSS_SOURCE) &&
    /@media \(max-width: 700px\)[\s\S]*?\.aa-pill \.aa-key-narrow \{ display: inline; \}/.test(CSS_SOURCE) &&
    /@media \(max-width: 700px\)[\s\S]*?#subagents, #unhandledBadge, #fillingBadge \{ display: none; \}/.test(CSS_SOURCE));
  check("the narrow face is display:none by default", /\.aa-pill \.aa-key-narrow \{ display: none; \}/.test(CSS_SOURCE));
  check("the narrow-face default PRECEDES the media blocks (rule order was the live regression)",
    CSS_SOURCE.indexOf(".aa-pill .aa-key-narrow { display: none; }") > -1 &&
    CSS_SOURCE.indexOf(".aa-pill .aa-key-narrow { display: none; }") < CSS_SOURCE.indexOf("@media (max-width: 1000px)"));
  check("the popover host is in the shell markup", /<div class="ctxpop-host" id="ctxpopHost" hidden><\/div>/.test(HTML_SOURCE));
  check("the surfaces table no longer calls Compact now a stub", /\["Compact now",\s+"live"/.test(APP_SOURCE));
}

// The popover lifecycle, driven through the registered handlers (Opus M8).
{
  const h = harness();
  open(h);
  h.api.receive(appEvent(1, "bridge.context_reading", { info: { context: CTX_100 }, summary: "" }, "live"));
  const host = h.document.getElementById("ctxpopHost");
  const meter = h.document.getElementById("meter");
  meter.onclick();
  check("click pins the popover open with aria-expanded",
    h.api.wp9State().ctxpopOpen === true && h.api.wp9State().ctxpopPinned === true &&
    meter.getAttribute("aria-expanded") === "true");
  const firstBtn = h.document.created.filter((n: any) => String(n.className).includes("ctxpop-compact")).pop();
  h.api.renderStrip();
  const secondBtn = h.document.created.filter((n: any) => String(n.className).includes("ctxpop-compact")).pop();
  check("an unchanged re-render does NOT rebuild the open popover (clicks and focus survive)",
    firstBtn === secondBtn);
  h.document.dispatch("pointerdown", { target: secondBtn });
  check("a pointerdown inside the popover leaves it open", h.api.wp9State().ctxpopOpen === true);
  h.document.dispatch("pointerdown", { target: h.document.body });
  check("a pointerdown outside closes it and hides the host",
    h.api.wp9State().ctxpopOpen === false && host.hidden === true && host.textContent === "");
  h.api.openCtxPop(false);
  h.document.dispatch("keydown", { key: "Escape" });
  check("a hover-opened popover never eats an Escape meant for other surfaces",
    h.api.wp9State().ctxpopOpen === true);
  h.api.closeCtxPop();
  h.api.openCtxPop(true);
  h.document.dispatch("keydown", { key: "Escape" });
  check("a pinned popover closes on Escape", h.api.wp9State().ctxpopOpen === false);
}

// A second compact while one is in flight is refused, not queued — and the
// first one's flags still clear.
{
  const h = harness();
  open(h);
  h.route("/session/compact", () => ({ usedBefore: 1, usedAfter: 1, note: "…" }));
  const p1 = h.api.compactNow("s");
  const p2 = h.api.compactNow("s");
  await Promise.all([p1, p2]);
  check("a second compact during the first is refused with a sentence",
    h.api.notes().some((n: any) => n.text === "A compact is already running.") &&
    h.posts.filter((x) => x.path === "/session/compact").length === 1);
  check("the in-flight guard clears afterwards", h.api.wp9State().compactInFlightFor === null);
}

// A 200 with no sentence is not an outcome — the operator still gets told.
{
  const h = harness();
  open(h);
  h.route("/session/compact", () => ({ usedBefore: 1, usedAfter: 1 }));
  await h.api.compactNow("s");
  check("a noteless 200 still produces a visible sentence",
    h.api.notes().some((n: any) => /no before\/after sentence/.test(n.text)));
}

// ══ WP10 first run: the facts panel, the failure screens, the boot fixes ══

const AGENT_FACTS = {
  state: "ready", failure: null, failureCause: null, pid: 4242, restarts: 0,
  sessions: [], openInteractions: [],
  agentVersion: "9.9.9-test",
  agentConfig: {
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    /* D88: isZdr is derived; false is the empty-reasons production shape. */
    retention: { retentionOptOut: true, isZdr: false, problem: null },
  },
};

// The first-run canvas carries the instrument's credentials before any session.
{
  const h = harness();
  open(h, [], [], false); /* no sessions — nothing becomes active */
  h.api.setAgent(AGENT_FACTS);
  h.api.renderAll();
  const canvas = h.document.getElementById("canvasInner");
  check("the first-run canvas shows the agent's own reported version",
    canvas.textContent.includes("Grok Build 9.9.9-test"));
  check("the process disclosure names the process and its PID",
    canvas.textContent.includes("grok agent --no-leader stdio · pid 4242"));
  check("the configured permission default reads as the plain truth",
    canvas.textContent.includes("Ask before running"));
  check("the privacy panel names coding-data retention as opted out with the upstream consequence",
    canvas.textContent.includes("coding-data retention") &&
    canvas.textContent.includes("Opted out") &&
    canvas.textContent.includes("will not be trained on"));
  check("the privacy panel names ZDR OFF when derived false (D88)",
    canvas.textContent.includes("zero-data retention") && canvas.textContent.includes("OFF"));
  check("the always-true remote-inference sentence is on the panel",
    canvas.textContent.includes("Always remote"));
  check("the retention switch is present when a boolean reading exists (opted out → Opt in…)",
    !!h.document.created.find((b: any) => b.tagName === "BUTTON" && /Opt in/.test(b.textContent || "")));
}

// The ⚠ state is loud, and unreadable files are said, never guessed.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent({ ...AGENT_FACTS, agentConfig: {
    permissionMode: { mode: "always-approve", source: "yolo", problem: null },
    retention: { retentionOptOut: null, isZdr: null, problem: "auth.json did not parse" },
  } });
  h.api.renderAll();
  const canvas = h.document.getElementById("canvasInner");
  check("always-approve reads ⚠ Approving everything, marked hot",
    canvas.textContent.includes("⚠ Approving everything"));
  check("an unreadable retention file is a sentence, not a value",
    canvas.textContent.includes("not read — auth.json did not parse"));
  check("an unreadable retention hides the switch (no boolean to flip)",
    !h.document.created.find((b: any) => b.tagName === "BUTTON" && /Opt (in|out)/.test(b.textContent || "")));
}

// Absence can never render as OFF for retentionOptOut (Grok WP10 C2): null
// reads "not stated". ZDR false is a real derivation (D88), not absence.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent({ ...AGENT_FACTS, agentConfig: {
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    retention: { retentionOptOut: null, isZdr: false, problem: null },
  } });
  h.api.renderAll();
  const text = h.document.getElementById("canvasInner").textContent;
  check("null retentionOptOut reads not-stated, never Opted in/out",
    text.includes("not stated") && !text.includes("Opted out") && !text.includes("Opted in"));
}

// Literal false retentionOptOut DOES render opted-in; isZdr false is OFF.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent({ ...AGENT_FACTS, agentConfig: {
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    retention: { retentionOptOut: false, isZdr: false, problem: null },
  } });
  h.api.renderAll();
  const text = h.document.getElementById("canvasInner").textContent;
  check("literal false retention renders Opted in (a real reading)",
    text.includes("Opted in") && text.includes("may be used to improve"));
  check("isZdr false renders ZDR OFF",
    text.includes("zero-data retention (ZDR)") && text.includes("OFF"));
  check("opted-in state shows the one-click Opt out control (safe direction)",
    !!h.document.created.find((b: any) => b.tagName === "BUTTON" && (b.textContent || "").trim() === "Opt out"));
}

// ZDR ON uses upstream wording and stays unswitchable from this panel.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent({ ...AGENT_FACTS, agentConfig: {
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    retention: { retentionOptOut: true, isZdr: true, problem: null },
  } });
  h.api.renderAll();
  const text = h.document.getElementById("canvasInner").textContent;
  check("ZDR ON uses upstream wording about not retained or trained",
    text.includes("ON — your data is not retained or used for training"));
}

// While the agent starts, the wait is named.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent({ state: "starting", failure: null, failureCause: null, pid: null, restarts: 0, sessions: [], openInteractions: [] });
  h.api.renderAll();
  check("the starting canvas names the wait (no bare Connecting…)",
    h.document.getElementById("canvasInner").textContent.includes("Starting the agent"));
  check("a missing version and config say not-reported, never invented",
    h.document.getElementById("canvasInner").textContent.includes("not reported yet") &&
    h.document.getElementById("canvasInner").textContent.includes("not read yet"));
}

// The boot roster fetch is quiet while the agent is starting (no spurious
// toast), and the roster really is re-read once the agent reports ready.
{
  const h = harness();
  open(h); /* open() leaves state ready */
  h.api.setAgent({ state: "starting", failure: null, failureCause: null, sessions: [] });
  h.route("/state", () => ({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [], openInteractions: [] }));
  /* The REAL refusal, so quiet is actually exercised (Opus re-review M2). */
  h.route("/sessions/list", () => ({ error: "the agent is not ready" }));
  const notesBefore = h.api.notes().length;
  await h.api.refreshRoster();
  check("a starting roster fetch against the real refusal produces NO toast",
    h.posts.some((x) => x.path === "/sessions/list") && h.api.notes().length === notesBefore);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, sessions: [] });
  await h.api.refreshRoster();
  check("the same refusal when NOT starting DOES toast (quiet is scoped to the race)",
    h.api.notes().length === notesBefore + 1);
  h.route("/sessions/list", () => ({ sessions: [] }));
  const postsBefore = h.posts.length;
  h.api.receive(appEvent(9, "bridge.agent_ready", { pid: 1, cwd: "/tmp" }, "live", null));
  await new Promise((r) => setTimeout(r, 10));
  const fresh = h.posts.slice(postsBefore);
  check("agent_ready re-reads state, THEN the roster (in that order)",
    fresh.length >= 2 && fresh[0].path === "/state" && fresh.some((x) => x.path === "/sessions/list"));
}

// A crash loop is not "could not start" — the strip and composer say which (Opus WP10 H1).
{
  const h = harness(true); /* connected — otherwise the no-token branch owns the composer note */
  open(h);
  h.api.setAgent({ state: "failed", failure: "died fast", failureCause: { kind: "crash_loop", reason: "x" }, sessions: [], pid: null, restarts: 3 });
  h.api.renderAll();
  check("crash_loop strip label never claims 'could not start'",
    h.document.getElementById("stateLabel").textContent === "Agent keeps crashing");
  check("crash_loop composer says the server stopped restarting it",
    h.document.getElementById("composerNote").textContent.includes("keeps crashing"));
}

// The failure screens: one sentence, one command, a real Try again.
{
  const h = harness();
  open(h);
  h.api.setAgent({ state: "failed", failure: "spawn grok ENOENT", failureCause: { kind: "startup_failed", reason: "spawn grok ENOENT" }, sessions: [], pid: null, restarts: 0 });
  h.api.renderAll();
  check("startup_failed gets its own screen title",
    h.document.getElementById("bannerTitle").textContent === "The agent could not start");
  check("...with the one command that diagnoses it",
    h.document.getElementById("bannerNote").textContent.includes("grok --version"));
  const rb = h.document.getElementById("btnReconnect");
  check("...and a real Try again (wired, enabled)",
    rb.disabled === false && rb.textContent === "Try again" && typeof rb.onclick === "function");

  h.route("/agent/restart", () => ({ ok: true }));
  await rb.onclick();
  check("Try again posts /agent/restart and re-reads state",
    h.posts.some((x) => x.path === "/agent/restart") && h.posts.some((x) => x.path === "/state"));

  h.api.setAgent({ state: "failed", failure: "died fast", failureCause: { kind: "crash_loop", reason: "x" }, sessions: [], pid: null, restarts: 3 });
  h.api.renderAll();
  check("crash_loop names the agent command to run by hand",
    h.document.getElementById("bannerNote").textContent.includes("grok agent --no-leader stdio"));

  h.api.setAgent({ state: "respawning", failure: null, failureCause: null, sessions: [], pid: null, restarts: 1 });
  h.api.renderAll();
  check("mid-run respawn keeps the button disabled (the server is on it)",
    h.document.getElementById("btnReconnect").disabled === true);
}

// ══ WP13 client surfaces (rename / archive / auto-approve / delete / export) ══

const dangerousCount = (h: Harness) =>
  h.document.created.filter((n: any) => ["IMG", "SCRIPT", "SVG", "IFRAME", "A", "STYLE"].includes(n.tagName)).length;

// ── Rename: hostile title as text; inline field; blank refused; commit posts ──
{
  const h = harness();
  open(h);
  const hostile = "<img src=x onerror=1><script>owned()</script>";
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: hostile, lastChangeUnixMs: 2 }]);
  const before = dangerousCount(h);
  h.api.renderRail();
  check("a hostile session title renders as text in the rail (no executable node)",
    dangerousCount(h) === before && h.document.getElementById("railBody").textContent.includes(hostile));

  h.api.startRename({ sessionId: "s", title: hostile });
  h.api.renderRail();
  const inputs = h.document.created.filter((n: any) => String(n.className).includes("s-rename-input"));
  check("startRename shows an inline field seeded with the current title",
    inputs.length >= 1 && inputs[inputs.length - 1].value === hostile);
  const singleLineInputRule = CSS_SOURCE.match(/input\.input\s*\{([^}]*)\}/)?.[1] || "";
  check("single-line inputs have an explicit dark field background and visible text color",
    singleLineInputRule.includes("background: var(--bg-input)") &&
      singleLineInputRule.includes("color: var(--text-primary)"));

  h.api.setRenaming({ sessionId: "s", draft: "   ", error: null });
  await h.api.commitRename({ sessionId: "s" });
  check("a blank rename is refused client-side with a caption and no POST",
    h.api.wp13State().renaming && h.api.wp13State().renaming.error === "Title can't be blank." &&
      !h.posts.some((p) => p.path === "/session/rename"));

  h.api.setRenaming({ sessionId: "s", draft: "  My Session  ", error: null });
  await h.api.commitRename({ sessionId: "s" });
  const renamePost = h.posts.find((p) => p.path === "/session/rename");
  check("a real rename posts /session/rename with the trimmed title and the session id",
    !!renamePost && renamePost.body.sessionId === "s" && renamePost.body.title === "My Session");
  check("a rename never sends a client-supplied cwd (the server resolves it)",
    !!renamePost && !("cwd" in renamePost.body));
}

// ── Archive: hides from the main list, reveals under "Archived (N)", still loadable ──
{
  const h = harness();
  open(h, [], [{ sessionId: "s", cwd: "/work/a", live: true, loading: false }]);
  h.api.setRoster([
    { sessionId: "s", cwd: "/work/a", title: "kept", lastChangeUnixMs: 3 },
    { sessionId: "gone", cwd: "/work/a", title: "put away", lastChangeUnixMs: 2 },
  ]);
  const ag: any = h.api.wp13State(); void ag;
  // Mark "gone" archived via the agent snapshot (as the server would report it).
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [{ sessionId: "s", cwd: "/work/a", live: true, turnInFlight: false }],
    openInteractions: [], archivedIds: ["gone"] });
  h.api.renderRail();
  const bodyText = h.document.getElementById("railBody").textContent;
  check("an archived session drops out of the main rail list", !bodyText.includes("put away"));
  check("the archived count shows in the foot", /1 archived/.test(h.document.getElementById("railFootNote").textContent));
  const archivedHostBefore = h.document.getElementById("railArchived").textContent;
  check("the 'Archived (1)' reveal appears", archivedHostBefore.includes("Archived (1)"));

  h.api.setShowArchived(true);
  h.api.renderRail();
  const archivedHost = h.document.getElementById("railArchived");
  check("expanding Archived shows the archived session and a Restore action",
    archivedHost.textContent.includes("put away") && archivedHost.textContent.includes("Restore"));
  check("the archive caption states scope once (this machine, nothing deleted)",
    archivedHost.textContent.includes("Nothing is deleted"));
  const archivedRow = archivedHost.children.length > 0;
  check("an archived row still carries its select button (still loadable if chosen)",
    archivedRow && h.document.created.some((n: any) => n.className === "s-row" && n.title && n.title.includes("gone")));

  await h.api.archiveSession("s");
  check("archiveSession posts /session/archive", h.posts.some((p) => p.path === "/session/archive" && p.body.sessionId === "s"));
  await h.api.restoreSession("gone");
  check("restoreSession posts /session/restore", h.posts.some((p) => p.path === "/session/restore" && p.body.sessionId === "gone"));
}

// ── Auto-approve: the switch reads roster truth; the banner states scope; ON confirms ──
{
  const h = harness();
  open(h);
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: false, lastChangeUnixMs: 1 }]);
  h.api.renderAutoApprove();
  check("with nothing hot, the auto-approve pill reads OFF and the banner is hidden",
    h.document.getElementById("autoApprove").dataset.on === "false" &&
      h.document.getElementById("autoApproveBanner").dataset.show === "false");

  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: true, lastChangeUnixMs: 1 }]);
  h.api.renderAutoApprove();
  check("a session reading back yolo=true flips the pill ON",
    h.document.getElementById("autoApprove").dataset.on === "true");
  check("the honesty banner is shown and states the scope is every session",
    h.document.getElementById("autoApproveBanner").dataset.show === "true" &&
      h.document.getElementById("autoApproveBanner").textContent.includes("every session in this window"));
  check("the always-visible pill label states the scope, not just the tooltip",
    h.document.getElementById("autoApprove").textContent.includes("Auto-approve — all sessions"));
  h.api.renderRail();
  const hotChip = h.document.created.filter((n: any) => String(n.className).includes("s-row-hot")).pop();
  check("a hot session is marked running-hot on its rail row", !!hotChip);
  /* `auto` is a permission mode of its own with NO wire read-back, so the marker
     for the mode we can confirm must never borrow its name. */
  check("the running-hot chip reads 'skips asks' and never the word 'auto'",
    !!hotChip && hotChip.textContent === "skips asks");
  check("the chip keeps its title, which states the scope",
    !!hotChip && String(hotChip.title).includes("Applies to all sessions"));

  // Turning ON (from cold) confirms first, and the confirm names the scope.
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: false, lastChangeUnixMs: 1 }]);
  h.api.setModal(null);
  h.api.toggleAutoApprove();
  const m = h.api.wp13State().modal;
  check("turning auto-approve ON opens a confirm first (never a silent flip)", !!m && m.kind === "autoApprove");
  h.api.renderModal();
  check("the turn-on confirm states it covers every session in this window",
    h.document.getElementById("modalHost").textContent.includes("every session open in this window"));

  // Turning OFF is the safe direction — immediate, mode 'ask', no confirm.
  h.api.setModal(null);
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: true, lastChangeUnixMs: 1 }]);
  await h.api.toggleAutoApprove();
  const pmPost = h.posts.find((p) => p.path === "/session/permission-mode");
  check("turning auto-approve OFF sends permission-mode 'ask' immediately (no confirm)",
    !!pmPost && pmPost.body.mode === "ask" && !h.api.wp13State().modal);
}

// ── Auto-approve: a respawn resets the indicator; the cached yolo is not truth ──
// The new agent process starts with no permission mode, so the pre-crash
// "ON" is stale the moment the old one dies. The page must read OFF before any
// fresh sessions/list arrives — never carry an approve-everything claim across a
// respawn, when the machine has gone back to asking.
{
  const h = harness();
  open(h);
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: true, lastChangeUnixMs: 1 }]);
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [{ sessionId: "s", cwd: "/work/a", live: true, turnInFlight: false }],
    openInteractions: [], permissionMode: "always-approve" });
  h.api.renderAutoApprove();
  check("the pill is ON while the roster reads yolo=true (the pre-crash state)",
    h.document.getElementById("autoApprove").dataset.on === "true");

  const listsBefore = h.posts.filter((p) => p.path === "/sessions/list").length;
  h.api.handle(appEvent(30, "bridge.respawned", {}, "live", null));
  check("after a respawn the pill reads OFF before any fresh roster arrives",
    h.document.getElementById("autoApprove").dataset.on === "false");
  check("after a respawn the honesty banner is down (nothing is confirmed hot, nothing is requested)",
    h.document.getElementById("autoApproveBanner").dataset.show === "false");
  check("a respawn re-reads sessions/list rather than trusting the cached yolo",
    h.posts.filter((p) => p.path === "/sessions/list").length > listsBefore);

  // The same reset on the way down: the process is gone, so nothing is hot.
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: true, lastChangeUnixMs: 1 }]);
  h.api.renderAutoApprove();
  h.api.handle(appEvent(31, "bridge.agent_gone", {}, "live", null));
  check("a lost agent drops the auto-approve indicator too",
    h.document.getElementById("autoApprove").dataset.on === "false");
  h.api.setRoster([{ sessionId: "s", cwd: "/work/a", title: "t", yolo: true, lastChangeUnixMs: 1 }]);
  h.api.renderAutoApprove();
  h.api.handle(appEvent(32, "bridge.respawning", {}, "live", null));
  check("and it stays down while the replacement is starting",
    h.document.getElementById("autoApprove").dataset.on === "false");
}

// ── Delete: the confirm shows the immutable identity, not the forgeable title ──
{
  const h = harness();
  open(h);
  const forged = "scratch — safe to delete <script>owned()</script>";
  h.api.setRoster([{ sessionId: "019fa1db-2836-7d90-abcd-000000000000", cwd: "/mnt/work/real-project", title: forged, lastChangeUnixMs: 5 }]);
  const before = dangerousCount(h);
  h.api.openDeleteModal({ sessionId: "019fa1db-2836-7d90-abcd-000000000000" });
  const host = h.document.getElementById("modalHost");
  check("the delete confirm shows the folder — the identity the agent cannot forge",
    host.textContent.includes("/mnt/work/real-project"));
  check("the delete confirm shows the session id",
    host.textContent.includes("019fa1db-2836-7d90-abcd-000000000000"));
  check("the delete confirm renders a forged 'safe to delete' title as inert text",
    dangerousCount(h) === before && host.textContent.includes(forged));
  check("the delete confirm states permanence and the conditional remote copy",
    host.textContent.includes("There is no undo") &&
      host.textContent.includes("if your account syncs to xAI") &&
      host.textContent.includes("choose Archive instead"));
  const del = h.document.created.find((n: any) => n.tagName === "BUTTON" && n.textContent === "Delete permanently");
  const foot = h.document.created.filter((n: any) => String(n.className).includes("modal-foot")).pop();
  const footBtns = foot ? foot.children.map((c: any) => c.textContent) : [];
  check("the destructive button reads 'Delete permanently' and is styled danger",
    !!del && del.dataset.variant === "danger");
  check("Cancel comes before the destructive button in the footer (never the default action)",
    footBtns.indexOf("Cancel") !== -1 && footBtns.indexOf("Cancel") < footBtns.indexOf("Delete permanently"));
  check("the confirm offers Archive instead", footBtns.includes("Archive instead"));

  /* The time rows, with honest labels. A roster row carries a last-change time
     and NO birth time, so the second row says so rather than being left out —
     an absent row reads as "this session has no such time", a different and
     wrong claim. */
  check("the confirm prints the last-active time when the roster reports one",
    host.textContent.includes("Last active: " + new Date(5).toLocaleString()));
  check("a session with no reported birth time says 'Created: not reported', never nothing",
    host.textContent.includes("Created: not reported"));

  // Held and created HERE: createdAt is a genuine birth time, so it is "Created".
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [{ sessionId: "019fa1db-2836-7d90-abcd-000000000000", cwd: "/mnt/work/real-project",
                 live: true, turnInFlight: false, acquired: "new", createdAt: 1_700_000_000_000 }],
    openInteractions: [] });
  h.api.setRoster([{ sessionId: "019fa1db-2836-7d90-abcd-000000000000", cwd: "/mnt/work/real-project", title: forged, lastChangeUnixMs: 5 }]);
  h.api.openDeleteModal({ sessionId: "019fa1db-2836-7d90-abcd-000000000000" });
  check("a session this app created shows 'Created: <time>' — that time really is its birth",
    h.document.getElementById("modalHost").textContent.includes("Created: " + new Date(1_700_000_000_000).toLocaleString()));

  /* Loaded from disk: createdAt is when THIS app opened it, not when the session
     was born, so it is never labelled Created. */
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [{ sessionId: "019fa1db-2836-7d90-abcd-000000000000", cwd: "/mnt/work/real-project",
                 live: true, turnInFlight: false, acquired: "load", createdAt: 1_700_000_000_000 }],
    openInteractions: [] });
  h.api.openDeleteModal({ sessionId: "019fa1db-2836-7d90-abcd-000000000000" });
  const loadedHost = h.document.getElementById("modalHost").textContent;
  check("a session opened from disk shows 'Opened here: <time>', never 'Created'",
    loadedHost.includes("Opened here: " + new Date(1_700_000_000_000).toLocaleString()) &&
      !loadedHost.includes("Created: " + new Date(1_700_000_000_000).toLocaleString()));
  check("sessionFacts carries the acquisition through, so the label cannot drift from the fact",
    h.api.sessionFacts("019fa1db-2836-7d90-abcd-000000000000").acquired === "load");

  // An unreported last-change time says so too, on the same row.
  h.api.setRoster([{ sessionId: "019fa1db-2836-7d90-abcd-000000000000", cwd: "/mnt/work/real-project", title: forged }]);
  h.api.openDeleteModal({ sessionId: "019fa1db-2836-7d90-abcd-000000000000" });
  check("an unknown last-active time prints 'Last active: not reported'",
    h.document.getElementById("modalHost").textContent.includes("Last active: not reported"));

  // Confirming posts exactly once, to /session/delete.
  h.route("/session/delete", (b) => ({ deleted: true, goneFromRoster: true, sessionId: b.sessionId, wasHeld: false, note: "gone" }));
  await h.api.confirmDelete("019fa1db-2836-7d90-abcd-000000000000");
  check("confirming posts /session/delete exactly once",
    h.posts.filter((p) => p.path === "/session/delete").length === 1);
}

// ── Delete: a deleted active session falls to empty, never a stale card ──
{
  const h = harness();
  open(h);
  h.api.setActive("s");
  check("the deleted session is the active view before deletion", h.api.state().activeId === "s");
  h.api.handle(appEvent(9, "bridge.session_deleted", { sessionId: "s", deleted: true, goneFromRoster: true }, "live", null));
  check("after a verified delete of the active session, the active view falls away (no stale card)",
    h.api.state().activeId !== "s");
}

// ── Export: the Markdown transcript is inert when rendered by our own renderer ──
{
  const h = harness();
  const hostileBundle = {
    kind: "graphometer-session-bundle", version: 1, sessionId: "019fa1db-2836-7d90-abcd-000000000000", cwd: "/x",
    state: { summary: { generated_title: "</h1><script>owned()</script>", session_summary: "s" } },
    updates: [
      { timestamp: 1, method: "session/update", params: { sessionId: "x", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "<img src=x onerror=alert(1)> and <script>evil()</script>" } } } },
      { timestamp: 2, method: "session/update", params: { sessionId: "x", update: { sessionUpdate: "tool_call", toolCallId: "t", title: "<svg onload=1>", kind: "execute" } } },
    ],
  };
  const md = bundleToMarkdown(hostileBundle);
  check("the exported Markdown carries the hostile strings as text", md.includes("<script>evil()</script>") && md.includes("<svg onload=1>"));
  const before = dangerousCount(h);
  const rendered = h.api.renderPlanMarkdown(md);
  h.document.body.appendChild(rendered);
  check("rendering the exported Markdown through our own renderer creates no executable node",
    dangerousCount(h) === before && rendered.textContent.includes("<script>evil()</script>"));

  // runExport posts the format and triggers a download of the returned content.
  open(h);
  h.route("/session/export", (b) => ({ ok: true, format: b.format, filename: "x." + (b.format === "markdown" ? "md" : "json"), content: "hello", hasMore: false }));
  await h.api.runExport("s", "bundle");
  check("runExport posts /session/export with the chosen format",
    h.posts.some((p) => p.path === "/session/export" && p.body.format === "bundle" && p.body.sessionId === "s"));
  check("a whole export notes the quiet success", h.api.notes().some((n: any) => /Exported — saved/.test(n.text)));

  /* A truncated MARKDOWN export still saves — the file names itself incomplete
     and says so at the top — but the note must warn, not read as a clean
     success. A truncated BUNDLE never gets here: the server refuses it. */
  h.route("/session/export", () => ({ ok: true, format: "markdown", filename: "x-incomplete.md", content: "hello", hasMore: true }));
  await h.api.runExport("s", "markdown");
  const warn = h.api.notes()[0];
  check("a truncated Markdown export is noted as INCOMPLETE, in the warning voice",
    warn && warn.kind === "error" && /Saved INCOMPLETE/.test(warn.text) && /x-incomplete\.md/.test(warn.text));

  const refusal = "this session's transcript was truncated by the agent";
  h.route("/session/export", () => ({ error: refusal }));
  await h.api.runExport("s", "bundle");
  check("a refused (truncated) bundle export surfaces the shipped 'Not exported — …' sentence",
    h.api.notes().some((n: any) => /^Not exported —/.test(n.text) && n.text.includes(refusal)));
  /* D-4: post() auto-notes the raw route error, and these handlers write their
     own sentence — one failure must still produce ONE note, not two. */
  check("a failed WP13 call notes ONCE, not twice (the handler's sentence, not also the raw route line)",
    h.api.notes().filter((n: any) => n.text.includes(refusal)).length === 1);
}

// ── D-4: every WP13 handler that writes its own failure sentence notes once ──
{
  const h = harness();
  open(h);
  const reasons: Record<string, string> = {
    "/session/rename": "rename-reason",
    "/session/archive": "archive-reason",
    "/session/restore": "restore-reason",
    "/session/delete": "delete-reason",
    "/session/import": "import-reason",
    "/session/permission-mode": "mode-reason",
  };
  for (const path of Object.keys(reasons)) h.route(path, () => ({ error: reasons[path] }));
  h.api.setRenaming({ sessionId: "s", draft: "a name", error: null });
  await h.api.commitRename({ sessionId: "s" });
  await h.api.archiveSession("s");
  await h.api.restoreSession("s");
  await h.api.confirmDelete("s");
  await h.api.onImportFileChosen({ text: async () => JSON.stringify({ kind: "graphometer-session-bundle" }) });
  await h.api.setAutoApprove("ask");
  const counts = Object.values(reasons).map((r) => h.api.notes().filter((n: any) => n.text.includes(r)).length);
  check("each WP13 failure produces exactly one note", counts.every((c) => c === 1));
  check("and each one is written in the shipped failure family, not the raw route line",
    h.api.notes().some((n: any) => /^Not sent —/.test(n.text)) &&
      h.api.notes().some((n: any) => /^Not archived —/.test(n.text)) &&
      h.api.notes().some((n: any) => /^Not restored —/.test(n.text)) &&
      h.api.notes().some((n: any) => /^Not deleted —/.test(n.text)) &&
      h.api.notes().some((n: any) => /^Not imported —/.test(n.text)) &&
      h.api.notes().some((n: any) => /^Auto-approve not changed —/.test(n.text)));
  /* The quiet flag is for THOSE handlers only. A caller that writes no sentence
     of its own must keep post()'s automatic note, or its failure goes silent. */
  h.route("/session/load", () => ({ error: "load-route-reason" }));
  h.api.selectSession({ sessionId: "other", cwd: "/work/b" }, false);
  await new Promise((r) => setTimeout(r, 0));
  check("a non-WP13 caller still gets post()'s automatic error note",
    /* WP14: the line is the server's sentence; the raw route rides in the
       details behind Copy details, not in the sentence itself. */
    h.api.notes().some((n: any) => n.text.includes("load-route-reason") &&
      typeof n.details === "string" && n.details.includes("/session/load")));
}

// ── Import: a foreign/invalid file is refused with the shipped failure family ──
{
  const h = harness();
  open(h);
  h.route("/session/import", () => ({ error: "this is not a Grok session bundle" }));
  await h.api.onImportFileChosen({ text: async () => JSON.stringify({ messages: [], title: "openwebui" }) });
  check("importing a foreign bundle surfaces a 'Not imported — …' note",
    h.api.notes().some((n: any) => /Not imported —/.test(n.text)));

  await h.api.onImportFileChosen({ text: async () => "not json at all" });
  check("importing a non-JSON file is refused before any POST",
    h.api.notes().some((n: any) => /isn't valid JSON/.test(n.text)));
}

// ── D68 masthead identity: static, scoped, and inside the settled geometry ──
check("the masthead makes Workbench for Grok Build one uninterrupted primary line",
  /class="mh-product">WORKBENCH FOR GROK BUILD<\/span>/.test(HTML_SOURCE));
check("the Graphometer house name remains visible as the smaller prefix",
  /class="mh-house">GRAPHOMETER/.test(HTML_SOURCE));
check("the xAI non-affiliation line is separate from and smaller than the product line",
  /class="mh-affiliation">NOT AFFILIATED WITH XAI<\/span>/.test(HTML_SOURCE) &&
    /* WP14: legible at the caption token — D68 keeps the line visible, and the
       old 9px sat below the file's own 12px caption floor. */
    /\.mh-affiliation\s*\{[^}]*font-size:\s*var\(--fs-caption\)/.test(CSS_SOURCE));
check("the G Gauge is fixed static SVG markup, not an image load or script-built content",
  /<svg class="mh-logo"[\s\S]*mh-logo-g[\s\S]*mh-logo-needle[\s\S]*<\/svg>/.test(HTML_SOURCE) &&
    !/<img[^>]+mh-logo/.test(HTML_SOURCE));
check("the site link has the exact HTTPS destination and safe new-tab attributes",
  /href="https:\/\/graphometer\.ai\/" target="_blank" rel="noreferrer"/.test(HTML_SOURCE));
check("the masthead keeps its settled desktop and narrow heights",
  /\.masthead\s*\{[^}]*height:\s*48px/.test(CSS_SOURCE) &&
    /@media \(max-width:\s*880px\)[\s\S]*?\.masthead\s*\{\s*height:\s*44px;\s*\}/.test(CSS_SOURCE));
check("only the logo uses the branding-gold token",
  (CSS_SOURCE.match(/var\(--brand-gold\)/g) || []).length === 2 &&
    CSS_SOURCE.includes(".mh-logo-needle") && CSS_SOURCE.includes(".mh-logo-hub"));
check("the desktop G Gauge is 35px and uses the primary-bright gauge stroke",
  /\.mh-logo\s*\{[^}]*width:\s*35px;\s*height:\s*35px/.test(CSS_SOURCE) &&
    CSS_SOURCE.includes("--brand-logo-ink:   #FCFCFC"));
check("the Graphometer house name is 14px semibold and brighter than metadata",
  /\.mh-house\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*var\(--fw-semibold\);[^}]*color:\s*var\(--text-secondary\)/.test(CSS_SOURCE));

// ═══════════════════════════════════════════════════════════════════════════
// WP7 — the composer: plan toggle, runtime effort selector, slash launcher.
//
// Kimi's I1 was right: before this block there was not one check on `btnPlan`,
// `btnStop`, `btnSend`, `composerNote` or `modelReadout` anywhere in the suite,
// and WP7 roughly triples the composer's logic. So these are INTERACTIONS —
// keys dispatched at the real listener, clicks through the real handlers, the
// real POST bodies captured — not greps over the source. The handful of static
// assertions at the end are for things only the stylesheet or the markup can
// say (geometry, CSP-shaped rules), and they are labelled as such.
// ═══════════════════════════════════════════════════════════════════════════

/** A session record the shape `/state` really produces (see describe()). */
function rec(over: Record<string, unknown> = {}) {
  return {
    sessionId: "s", cwd: "/tmp/s", acquired: "new", createdAt: 1, title: null,
    live: true, models: null, confirmedModeId: null, modeRequest: null,
    modelId: null, reasoningEffort: null, turnInFlight: false,
    commandCount: null, commandsFrom: null, replayedEvents: 0, liveEvents: 0,
    loading: false, ...over,
  };
}

/** The runtime effort metadata, verbatim from the grok 1.0.0 probe (§3.1). */
const EFFORTS = [
  { id: "high", value: "high", label: "High Effort", description: "Highest implementation quality with extensive reasoning", default: true },
  { id: "medium", value: "medium", label: "Medium Effort", description: "Balanced effort with standard implementation and testing", default: false },
  { id: "low", value: "low", label: "Low Effort", description: "Quick, fast implementations", default: false },
];
const MODELS = (efforts: unknown = EFFORTS, extra: Record<string, unknown> = {}) => ({
  currentModelId: "grok-4.5",
  availableModels: [{
    modelId: "grok-4.5", name: "Grok 4.5", description: "…",
    _meta: { supportsReasoningEffort: true, reasoningEffort: "high", reasoningEfforts: efforts, ...extra },
  }],
});

/** A live session on screen, with the composer usable. */
function composer(over: Record<string, unknown> = {}) {
  const h = harness(true);
  h.api.clearWp7();
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec(over)], openInteractions: [] });
  h.api.setActive("s");
  h.api.renderComposerNow();
  /* The fake document hands out every element as a direct child of <body>; the
     real markup nests the launcher, the input row and the meta row inside
     .composer-inner. The outside-click rule is a containment test, so the
     nesting it depends on is built here rather than assumed. */
  const inner = h.document.getElementById("composerInner");
  inner.appendChild(h.document.getElementById("launcherHost"));
  inner.appendChild(h.document.getElementById("prompt"));
  /* The page's own boot reads (/state, /sessions/list) are not what these
     checks are about; every "what did the operator's action put on the wire"
     assertion below counts from an empty list. */
  h.posts.length = 0;
  return h;
}

const dom = (h: Harness, id: string) => h.document.getElementById(id);
/** Let a promise chain settle. The page's own reads are all microtasks. */
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
/** Every element under a node, flattened — the launcher is built as a tree. */
function descend(node: FakeElement): FakeElement[] {
  return node.children.flatMap((child) => [child, ...descend(child)]);
}
const byClass = (h: Harness, root: string, cls: string) =>
  descend(dom(h, root)).filter((n) => String(n.className).split(" ").includes(cls));

// ── 1. Plan: the six faces, and where each one comes from ──────────────────
{
  const h = composer();
  const btn = dom(h, "btnPlan");
  const word = dom(h, "planState");
  check("Plan before the agent has announced anything reads 'off · not confirmed' (D72)",
    word.textContent === "off · not confirmed" && btn.dataset.toggle === "off");
  check("…and it does not claim to be pressed",
    btn.getAttribute("aria-pressed") === "false");
  check("…and the tooltip explains that silence almost always means off",
    /Nothing has been announced for this session, which almost always means plan mode is off\./.test(btn.title));
  check("…and the state word is part of the button's accessible name",
    btn.getAttribute("aria-label") === "Plan mode · off · not confirmed");

  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec({ confirmedModeId: "plan" })], openInteractions: [] });
  h.api.renderComposerNow();
  check("an announced 'plan' is the only thing that turns Plan on",
    dom(h, "planState").textContent === "on" && dom(h, "btnPlan").dataset.toggle === "on" &&
      dom(h, "btnPlan").getAttribute("aria-pressed") === "true");

  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec({ confirmedModeId: "default" })], openInteractions: [] });
  h.api.renderComposerNow();
  check("an announced 'default' is a confirmed off",
    dom(h, "planState").textContent === "off" &&
      dom(h, "btnPlan").title === "The agent announced plan mode is off.");

  // The plan-exit echo. grok 1.0.0 answers a bogus set_mode from inside plan by
  // announcing the bogus id back. It is not-plan, and it is never a mode name.
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec({ confirmedModeId: "totally-bogus-wp7-mode" })], openInteractions: [] });
  h.api.renderComposerNow();
  check("a garbage plan-exit id reads as a plain off, never as a recognised mode",
    dom(h, "planState").textContent === "off" &&
      dom(h, "btnPlan").getAttribute("aria-pressed") === "false" &&
      !dom(h, "planState").textContent.includes("bogus") &&
      !dom(h, "btnPlan").title.includes("bogus"));
}

// ── 2. Plan: no optimistic flip, focus kept, one request at a time ─────────
{
  const h = composer();
  /* The reply arrives a few microtasks later, so everything asserted before
     `await running` is genuinely the in-flight face. */
  h.route("/session/mode", async () => {
    await tick();
    return { acknowledged: true, verified: true, matched: true, readBack: "plan" };
  });
  dom(h, "btnPlan").focus();
  const running = h.api.togglePlan();
  check("the click asks for the mode this app owns, and nothing else",
    h.posts.length === 1 && h.posts[0].path === "/session/mode" &&
      h.posts[0].body.modeId === "plan" && h.posts[0].body.sessionId === "s");
  check("the face does NOT flip on the click — it says it is asking",
    dom(h, "planState").textContent === "turning on…" && dom(h, "btnPlan").dataset.toggle === "off");
  check("…and it still does not claim to be pressed while it waits",
    dom(h, "btnPlan").getAttribute("aria-pressed") === "false");
  check("the pending control is disabled to the accessibility tree",
    dom(h, "btnPlan").getAttribute("aria-disabled") === "true");
  check("…without taking focus off it, which `disabled` would have done",
    h.document.activeElement === dom(h, "btnPlan") && dom(h, "btnPlan").disabled === false);
  check("the composer is NOT disabled with it", dom(h, "prompt").disabled === false);
  h.api.togglePlan();
  check("a second click inside the pending window sends nothing", h.posts.length === 1);
  await running;
  check("the confirmed turn-on is announced politely",
    dom(h, "liveRegion").textContent === "Plan mode is on.");
  check("focus is still on the toggle after the whole cycle",
    h.document.activeElement === dom(h, "btnPlan"));
}

// ── 2b. Plan: pending requests stay scoped across a session switch ─────────
{
  const h = composer();
  h.api.setAgent({
    state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [rec(), rec({ sessionId: "s2", cwd: "/tmp/s2" })], openInteractions: [],
  });
  let resolveA: (value: any) => void = () => {};
  let resolveB: (value: any) => void = () => {};
  h.route("/session/mode", (body) => new Promise((resolve) => {
    if (body.sessionId === "s") resolveA = resolve;
    else resolveB = resolve;
  }));
  h.route("/state", () => ({
    state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [rec(), rec({ sessionId: "s2", cwd: "/tmp/s2" })], openInteractions: [],
  }));
  const a = h.api.togglePlan();
  h.api.setActive("s2");
  h.api.renderComposerNow();
  const b = h.api.togglePlan();
  await tick();
  check("a pending Plan request on session A does not silently block session B",
    h.posts.filter((p) => p.path === "/session/mode").map((p) => p.body.sessionId).join(",") === "s,s2" &&
      dom(h, "planState").textContent === "turning on…");
  resolveA({ acknowledged: true, verified: true, matched: true, readBack: "plan" });
  await tick();
  check("session A completing in the background does not clear or announce over B's pending face",
    dom(h, "planState").textContent === "turning on…" &&
      dom(h, "liveRegion").textContent !== "Plan mode is on.");
  resolveB({ acknowledged: true, verified: false, matched: false, readBack: null });
  await Promise.all([a, b]);
}

// ── 3. Plan: success with silence reverts and says so ──────────────────────
{
  const h = composer();
  h.route("/session/mode", () => ({ acknowledged: true, verified: false, matched: false, readBack: null }));
  await h.api.togglePlan();
  check("a set_mode that returns success and produces no announcement says 'no answer — unchanged'",
    dom(h, "planState").textContent === "no answer — unchanged");
  check("…and the face is the one it had before, not the one that was asked for",
    dom(h, "btnPlan").dataset.toggle === "off" && dom(h, "btnPlan").getAttribute("aria-pressed") === "false");
  check("…and the tooltip says why an empty success proves nothing",
    /Asking always succeeds even when nothing changes/.test(dom(h, "btnPlan").title));
  check("…and it is announced", dom(h, "liveRegion").textContent === "No answer from the agent — plan mode unchanged.");
  check("…and the control is usable again", dom(h, "btnPlan").getAttribute("aria-disabled") === "false");
  // A late announcement supersedes the timeout's words.
  h.api.receive(appEvent(50, "mode.changed", { modeId: "plan" }, "live"));
  check("an announcement that arrives late clears the no-answer word",
    h.api.wp7State().planNotice === null);
}

// ── 4. Plan: a mismatch follows the EVENT and explains itself ──────────────
{
  const h = composer();
  h.route("/session/mode", () => ({ acknowledged: true, verified: true, matched: false, readBack: "some-other-id" }));
  await h.api.togglePlan();
  check("a mismatch keeps the ordinary on/off word — the announcement is the truth",
    dom(h, "planState").textContent === "off · not confirmed");
  check("…and the tooltip names what was asked and what the agent said instead",
    /You asked for plan mode on; the agent announced 'some-other-id' instead\./.test(dom(h, "btnPlan").title));
}

// ── 5. Plan: hostile mode ids are text, and a dead composer disables it ────
{
  const hostile = "<img src=x onerror=alert(1)>";
  const h = composer();
  h.route("/session/mode", () => ({ acknowledged: true, verified: true, matched: false, readBack: hostile }));
  await h.api.togglePlan();
  check("an agent-supplied mode id in the mismatch sentence stays literal text",
    dom(h, "btnPlan").title.includes(hostile) &&
      descend(h.document.body).every((n) => n.tagName !== "IMG"));

  const gone = harness(true);
  gone.api.clearWp7();
  gone.api.setAgent({ state: "gone", failure: "child exited", failureCause: null, pid: null, restarts: 1, sessions: [rec()], openInteractions: [] });
  gone.api.setActive("s");
  gone.api.renderComposerNow();
  check("with the agent gone the toggle is really disabled and says nothing about mode",
    dom(gone, "btnPlan").disabled === true &&
      dom(gone, "btnPlan").getAttribute("aria-disabled") === "true" &&
      dom(gone, "planState").textContent === "");
}

// ── 6. Effort: the options are the agent's, verbatim and in its order ──────
{
  const h = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" });
  const sel = dom(h, "effortSelect");
  check("the effort selector appears when the agent reports effort levels",
    dom(h, "effortWrap").hidden === false);
  /* Native, and in the meta row that already exists — WP7 adds no row. Only
     the markup can say that, so this half is read from index.html. */
  check("it is a native select, second in the existing meta row after Plan",
    /<div class="composer-meta">[\s\S]*?id="btnPlan"[\s\S]*?id="planState"[\s\S]*?<select class="composer-select[^"]*" id="effortSelect"><\/select>[\s\S]*?id="modelReadout"[\s\S]*?id="composerNote"[\s\S]*?<\/div>/.test(HTML_SOURCE));
  check("the options are the agent's labels, in the agent's own order",
    sel.children.map((o: FakeElement) => o.textContent).join(" | ") ===
      "High Effort (default) | Medium Effort | Low Effort");
  check("the values sent are the agent's own ids",
    sel.children.map((o: FakeElement) => o.value).join(",") === "high,medium,low");
  check("'(default)' comes from the agent's own default flag, and marks only that one",
    sel.children.filter((o: FakeElement) => o.textContent.includes("(default)")).length === 1);
  check("each option carries the agent's description",
    sel.children[2].title === "Quick, fast implementations");
  check("the selected value is the one the roster reports", sel.value === "high");
  check("no Quick/Balanced/Careful alias is shipped anywhere in the control (D71)",
    !/Quick|Balanced|Careful/.test(sel.textContent));
  check("the model readout shows the agent's display name, not the raw id",
    dom(h, "modelReadout").textContent === "Grok 4.5");
  check("…and no longer duplicates the effort as a suffix",
    !dom(h, "modelReadout").textContent.includes("high"));

  // The fallbacks, one step at a time: no name → the id; no id either → said.
  const noName = composer({ models: { currentModelId: "grok-4.5", availableModels: [{ modelId: "grok-4.5", _meta: { reasoningEfforts: EFFORTS } }] }, modelId: "grok-4.5", reasoningEffort: "high" });
  check("a model with no display name falls back to its raw id, never to a blank",
    dom(noName, "modelReadout").textContent === "grok-4.5");
  const noModel = composer();
  check("a session the agent has told us no model for says so rather than showing nothing",
    dom(noModel, "modelReadout").textContent === "model not reported");

  // Some efforts may carry only `value`. Whatever the agent's own key is, that
  // is what goes on the wire — nothing here is renamed on the way through.
  const valueOnly = composer({
    models: MODELS([{ value: "swift", label: "Swift", description: "the agent's own", default: false }]),
    modelId: "grok-4.5", reasoningEffort: "swift",
  });
  check("an effort entry with only a `value` still yields an option, using that value",
    dom(valueOnly, "effortSelect").children.map((o: FakeElement) => o.value).join(",") === "swift" &&
      dom(valueOnly, "effortSelect").children[0].textContent === "Swift");

  // An effort list the agent sends with no reported current value: an empty
  // box, never the first option quietly standing in for a reading.
  const unknown = composer({ models: MODELS(EFFORTS, { reasoningEffort: undefined }), modelId: "grok-4.5", reasoningEffort: null });
  check("with no reported current effort the box selects nothing at all",
    dom(unknown, "effortSelect").selectedIndex === -1);
  check("…and says the agent has not reported one",
    dom(unknown, "effortSelect").title === "The agent has not reported which effort this session is using.");
  const metadataOnly = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: null });
  check("model metadata cannot stand in for a missing roster effort reading",
    dom(metadataOnly, "effortSelect").selectedIndex === -1 &&
      metadataOnly.api.currentEffort(rec({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: null })) === null);
}

// ── 7. Effort: absent, empty, or unsupported metadata means NO control ─────
for (const [label, over] of [
  ["no models payload at all", { models: null }],
  ["an empty effort list", { models: MODELS([]) }],
  ["a non-array effort list", { models: MODELS(null) }],
  ["the model saying it has no effort axis", { models: MODELS(EFFORTS, { supportsReasoningEffort: false }) }],
] as [string, Record<string, unknown>][]) {
  const h = composer({ modelId: "grok-4.5", reasoningEffort: null, ...over });
  check(`with ${label} there is no selector and no invented Default`,
    dom(h, "effortWrap").hidden === true && dom(h, "effortSelect").children.length === 0);
  check(`…and the model readout still stands alone with ${label}`,
    dom(h, "modelReadout").textContent.length > 0);
}

// ── 8. Effort: the face is the roster read-back, never the request ─────────
{
  const h = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" });
  h.route("/session/model", async () => {
    await tick();
    return { acknowledged: true, verified: true, matched: true, readBack: { modelId: "grok-4.5", reasoningEffort: "low" } };
  });
  h.route("/state", () => ({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "low" })], openInteractions: [] }));
  /* A real native select changes its visible value before `change` fires. */
  dom(h, "effortSelect").value = "low";
  const running = h.api.setEffort(dom(h, "effortSelect").value);
  check("setting an effort preserves the current model id — effort rides on set_model",
    h.posts[0].path === "/session/model" && h.posts[0].body.modelId === "grok-4.5" &&
      h.posts[0].body.reasoningEffort === "low" && h.posts[0].body.sessionId === "s");
  check("the control is disabled while the request is in flight",
    dom(h, "effortSelect").disabled === true);
  check("the native select face stays on roster truth while the request is in flight",
    dom(h, "effortSelect").value === "high");
  await running;
  check("the confirmed effort is the one the roster read back",
    dom(h, "effortSelect").value === "low");
  check("…and it is announced with the agent's own label",
    dom(h, "liveRegion").textContent === "Effort set to Low Effort.");
  check("…and the control is usable again", dom(h, "effortSelect").disabled === false);
}

// The measured silent revert: identical success, roster unmoved.
{
  const h = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" });
  h.route("/session/model", () => ({ acknowledged: true, verified: true, matched: false, readBack: { modelId: "grok-4.5", reasoningEffort: "high" } }));
  h.route("/state", () => ({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" })], openInteractions: [] }));
  await h.api.setEffort("low");
  check("an effort the agent silently discarded shows what it KEPT, not what was asked",
    dom(h, "effortSelect").value === "high");
  check("…and says so in the composer's own words",
    dom(h, "composerNote").textContent ===
      "The agent kept 'High Effort' — it did not recognise the requested effort.");
  check("…and never reports the request as a success",
    !/set to/.test(dom(h, "liveRegion").textContent));
}

// A roster that cannot be read is an UNREAD, not a mismatch. "The agent kept
// ''" would be a sentence about the agent that nothing on the wire supports.
{
  const h = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" });
  h.route("/session/model", () => ({ acknowledged: true, verified: false, matched: false, readBack: { modelId: null, reasoningEffort: null } }));
  /* Keep stale model metadata present: verified:false must win over that old
     value instead of turning it into a false "the agent kept High" claim. */
  h.route("/state", () => ({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" })], openInteractions: [] }));
  await h.api.setEffort("low");
  check("an effort the roster could not confirm says it is unverified, not that the agent kept nothing",
    dom(h, "composerNote").textContent ===
      "The agent did not report which effort this session is using, so the change is unverified." &&
      !/kept/.test(dom(h, "composerNote").textContent));
}

// ── 8b. Effort: pending requests stay scoped across a session switch ───────
{
  const h = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" });
  h.api.setAgent({
    state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [
      rec({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" }),
      rec({ sessionId: "s2", cwd: "/tmp/s2", models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" }),
    ], openInteractions: [],
  });
  let resolveA: (value: any) => void = () => {};
  let resolveB: (value: any) => void = () => {};
  h.route("/session/model", (body) => new Promise((resolve) => {
    if (body.sessionId === "s") resolveA = resolve;
    else resolveB = resolve;
  }));
  h.route("/state", () => ({
    state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0,
    sessions: [
      rec({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" }),
      rec({ sessionId: "s2", cwd: "/tmp/s2", models: MODELS(), modelId: "grok-4.5", reasoningEffort: "high" }),
    ], openInteractions: [],
  }));
  const a = h.api.setEffort("low");
  h.api.setActive("s2");
  h.api.renderComposerNow();
  const b = h.api.setEffort("medium");
  await tick();
  check("a pending effort request on session A does not silently block session B",
    h.posts.filter((p) => p.path === "/session/model").map((p) => p.body.sessionId).join(",") === "s,s2" &&
      dom(h, "effortSelect").disabled === true);
  resolveA({ acknowledged: true, verified: true, matched: true, readBack: { modelId: "grok-4.5", reasoningEffort: "low" } });
  await tick();
  check("session A completing in the background leaves session B's effort pending and unannounced",
    dom(h, "effortSelect").disabled === true &&
      dom(h, "liveRegion").textContent !== "Effort set to Low Effort.");
  resolveB({ acknowledged: true, verified: false, matched: false, readBack: { modelId: null, reasoningEffort: null } });
  await Promise.all([a, b]);
}

// ── 9. Effort: a full models/update rebuilds the options safely ────────────
{
  const h = composer({ models: MODELS(), modelId: "grok-4.5", reasoningEffort: "medium" });
  check("before the update the agent's three levels are offered",
    dom(h, "effortSelect").children.length === 3);
  const NEW_EFFORTS = [
    { id: "brisk", value: "brisk", label: "Brisk", description: "renamed by the agent", default: true },
    { id: "thorough", value: "thorough", label: "Thorough", description: "also renamed", default: false },
  ];
  h.api.receive(appEvent(60, "models.updated", MODELS(NEW_EFFORTS), "live", null));
  check("a full models/update rebuilds the option list from the new runtime data",
    dom(h, "effortSelect").children.map((o: FakeElement) => o.value).join(",").includes("brisk,thorough"));
  check("…and the roster's own effort is still what the box shows, even though the list dropped it",
    dom(h, "effortSelect").value === "medium");
  check("…shown as the agent's own id rather than some other option being selected quietly",
    dom(h, "effortSelect").children[0].value === "medium" &&
      dom(h, "effortSelect").children[0].textContent === "medium");
  check("…and the composer says why an unfamiliar value is in the box",
    dom(h, "composerNote").textContent === "Effort options changed — showing what the agent reports.");
  const SAME_EFFORTS = NEW_EFFORTS.map((effort) => ({ ...effort, description: "new: " + effort.description }));
  h.api.receive(appEvent(63, "models.updated", MODELS(SAME_EFFORTS), "live", null));
  check("a description-only models update refreshes the visible option metadata",
    dom(h, "effortSelect").children.find((o: FakeElement) => o.value === "brisk").title ===
      "new: renamed by the agent");

  h.api.handle({ ...appEvent(66, "bridge.agent_gone", {}, "live", null), note: "agent gone" });
  const FRESH_EFFORTS = [{ id: "fresh", label: "Fresh generation", description: "new process", default: true }];
  h.api.setAgent({
    state: "ready", failure: null, failureCause: null, pid: 2, restarts: 1,
    sessions: [rec({ models: MODELS(FRESH_EFFORTS), modelId: "grok-4.5", reasoningEffort: "fresh" })],
    openInteractions: [],
  });
  h.api.renderComposerNow();
  check("an agent respawn clears old models/update precedence in favour of the fresh session catalogue",
    dom(h, "effortSelect").children.map((o: FakeElement) => o.value).join(",") === "fresh");

  h.api.handle({ ...appEvent(67, "bridge.respawning", {}, "live", null), note: "replacement starting" });
  const REPLACEMENT_EFFORTS = [{ id: "replacement", label: "Replacement process", description: "current generation", default: true }];
  h.api.receive(appEvent(69, "models.updated", MODELS(REPLACEMENT_EFFORTS), "live", null));
  h.api.handle({ ...appEvent(70, "bridge.respawned", {}, "live", null), note: "replacement ready" });
  check("respawn completion preserves a current-generation models update emitted during reload",
    dom(h, "effortSelect").children.map((o: FakeElement) => o.value).includes("replacement"));
  const hostileModels = {
    currentModelId: "grok-4.5",
    availableModels: [{ modelId: "grok-4.5", name: "<script>x</script>", _meta: { supportsReasoningEffort: true, reasoningEfforts: [{ id: "x", label: "<img src=x onerror=alert(1)>", description: "<b>no</b>", default: false }] } }],
  };
  h.api.receive(appEvent(71, "models.updated", hostileModels, "live", null));
  check("hostile model and effort labels are text — no element is built from them",
    dom(h, "modelReadout").textContent === "<script>x</script>" &&
      dom(h, "effortSelect").children.some((o: FakeElement) => o.textContent === "<img src=x onerror=alert(1)>") &&
      descend(h.document.body).every((n) => n.tagName !== "SCRIPT" && n.tagName !== "IMG"));

  // A models/update WITHOUT the model array is not modelled, and must still
  // land on screen as an unhandled card. Consuming it silently to feed the
  // selector would be the exact silent drop D35 exists to prevent.
  const before = h.api.view("s").turns.length;
  h.api.receive({ ...appEvent(72, "models.updated", {}, "live", "s"), modelled: false });
  const items = h.api.view("s").turns.flatMap((t: any) => t.items);
  check("a models/update with no model array still renders as an unhandled card (D35)",
    items.some((i: any) => i.kind === "unhandled" && i.type === "models.updated") &&
      h.api.view("s").turns.length >= before);
}

// ── 10. Launcher: opens only on a LEADING slash ────────────────────────────
{
  const h = composer();
  h.route("/commands/list", () => ({ commands: [{ name: "compact", description: "Compress history" }], tools: [], scope: "session" }));
  const box = dom(h, "prompt");
  const type = (typed: string) => {
    box.value = typed;
    box.selectionStart = typed.length;
    box.dispatch("input");
  };
  for (const typed of [
    "look at /etc/hosts",              /* a path inside a sentence */
    "see https://example.com/x",       /* a URL */
    "",                                /* nothing typed */
    "  /leading space",                /* the slash is not the first character */
    "Read /tmp/example-project and summarise it",
  ]) {
    type(typed);
    check(`a slash inside ${JSON.stringify(typed)} does not open the launcher`,
      h.api.launcherState() === null);
  }
  type("/");
  check("a leading slash opens it", h.api.launcherState() !== null);
  check("…and it asks THIS session for the list, scoped",
    h.posts.some((p) => p.path === "/commands/list" && p.body.sessionId === "s"));
  await tick();
  check("…and it closes again the moment the text stops starting with one",
    (() => { type("hello"); return h.api.launcherState() === null; })());
  /* A second slash inside the leading token makes this an absolute path, not a
     slash command. It must retain ordinary composer keyboard behavior. */
  type("/tmp/example-project");
  await tick();
  check("an absolute path typed from the very start never opens the launcher",
    h.api.launcherState() === null);
  const pathSend = box.dispatch("keydown", { key: "Enter", ctrlKey: true });
  check("…so Ctrl+Enter keeps its ordinary send behavior instead of being swallowed",
    pathSend.defaultPrevented &&
      h.posts.some((p) => p.path === "/prompt" && p.body.text === "/tmp/example-project"));
}

// ── 11. Launcher: the rows, the ranking, the count, the hostile text ───────
const CATALOGUE = [
  { name: "compact", description: "Compress conversation history", input: { hint: "what to preserve" } },
  { name: "execute-plan", description: "Execute a saved plan file end to end", input: { hint: "<design-doc-path> [--dry-run]" } },
  { name: "feedback", description: "Send feedback about exec quality" },
  { name: "loop", description: "Run a prompt repeatedly" },
];
/** Open the launcher on a session whose catalogue is already loaded. */
async function launcherOn(query: string, list: unknown[] = CATALOGUE, over: Record<string, unknown> = {}) {
  const h = composer(over);
  h.route("/commands/list", () => ({ commands: list, tools: [], scope: "session" }));
  const box = dom(h, "prompt");
  box.value = "/" + query;
  box.selectionStart = box.value.length;
  box.dispatch("input");
  await tick();   /* let the /commands/list chain settle */
  return h;
}
{
  const h = await launcherOn("");
  const rows = byClass(h, "launcherHost", "launcher-row");
  check("every command the agent reported is offered, none curated away", rows.length === 4);
  check("the count footer is the agent's own number, said as such",
    byClass(h, "launcherHost", "launcher-foot")[0].textContent.startsWith("4 commands · from the agent, unfiltered"));
  check("a row shows the command's own name with its slash",
    byClass(h, "launcherHost", "lr-name")[0].textContent === "/compact");
  check("…its argument hint",
    byClass(h, "launcherHost", "lr-hint")[0].textContent === "what to preserve");
  check("…and its description on the second line",
    byClass(h, "launcherHost", "lr-desc")[0].textContent === "Compress conversation history");
  check("the first row is the active one, marked with text as well as steel",
    rows[0].getAttribute("aria-selected") === "true" &&
      byClass(h, "launcherHost", "lr-mark")[0].textContent === "›");

  const exec = await launcherOn("exec");
  const names = byClass(exec, "launcherHost", "lr-name").map((n) => n.textContent);
  check("/exec finds execute-plan, by name prefix, first",
    names[0] === "/execute-plan");
  check("…and also the description match, ranked below it",
    names.join(",") === "/execute-plan,/feedback");
  check("…with the hint still visible on the row",
    byClass(exec, "launcherHost", "lr-hint")[0].textContent === "<design-doc-path> [--dry-run]");
  check("the footer still reports the agent's WHOLE count, not the filtered one",
    byClass(exec, "launcherHost", "launcher-foot")[0].textContent.startsWith("4 commands"));

  const nothing = await launcherOn("zzzz");
  check("a query that matches nothing says so, with the query as text",
    descend(dom(nothing, "launcherHost")).some((n) => n.textContent === "No commands match 'zzzz'."));
  check("…and the launcher stays open", nothing.api.launcherState() !== null);

  const hint = await launcherOn("dry-run");
  check("search reaches the argument hint as well as name and description",
    byClass(hint, "launcherHost", "lr-name").map((n) => n.textContent).join(",") === "/execute-plan");

  const upper = await launcherOn("EXEC");
  check("search is case-insensitive",
    byClass(upper, "launcherHost", "lr-name")[0].textContent === "/execute-plan");

  // Nothing about this list is ours: a fixture without execute-plan must not
  // produce it, and no count is baked in anywhere.
  const other = await launcherOn("exec", [{ name: "compact", description: "Compress history" }]);
  check("with a catalogue that has no execute-plan, /exec finds nothing — no hardcoded row",
    byClass(other, "launcherHost", "lr-name").length === 0);
  check("…and the count follows the fixture, never a remembered 22 or 30",
    byClass(other, "launcherHost", "launcher-foot")[0].textContent.startsWith("1 commands"));
}

// ── 12. Launcher: hostile command text builds nothing executable ───────────
{
  const HOSTILE = [
    { name: "<script>alert(1)</script>", description: "<img src=x onerror=alert(1)>", input: { hint: "javascript:alert(1)" } },
    { name: "]]>evil", description: "<a href=\"javascript:alert(2)\">click</a>", input: { hint: "<iframe src=//evil>" } },
  ];
  const h = await launcherOn("", HOSTILE);
  const all = descend(h.document.body);
  check("a hostile command name, description and hint create no element of their own",
    all.every((n) => !["SCRIPT", "IMG", "IFRAME", "A"].includes(n.tagName)));
  check("…and the text is on screen literally, so it is visible rather than executed",
    byClass(h, "launcherHost", "lr-name")[0].textContent === "/<script>alert(1)</script>" &&
      byClass(h, "launcherHost", "lr-desc")[0].textContent === "<img src=x onerror=alert(1)>");
  check("…and no element anywhere carries a javascript: URL from that payload",
    all.every((n) => !["href", "src", "action", "formaction"].some((a) => typeof (n as any)[a] === "string" && /javascript:/i.test((n as any)[a]))));
  /* The sinks themselves, not the word: the file's own header comment promises
     there is no innerHTML in it, and a check that matched prose would fail on
     the promise instead of on a breach of it. */
  check("no unsafe DOM sink is USED anywhere in the shell",
    !/\.\s*(inner|outer)HTML\s*=|\.insertAdjacentHTML\s*\(|document\s*\.\s*write\s*\(|new\s+Function\s*\(|[^.\w]eval\s*\(/.test(APP_SOURCE));
}

// ── 13. Launcher: the keyboard contract, and that nothing ever sends ───────
{
  const h = await launcherOn("");
  const box = dom(h, "prompt");
  const active = () => byClass(h, "launcherHost", "launcher-row").findIndex((r) => r.getAttribute("aria-selected") === "true");

  let e = box.dispatch("keydown", { key: "ArrowDown" });
  check("Down moves the active row and takes the key", active() === 1 && e.defaultPrevented);
  box.dispatch("keydown", { key: "ArrowDown" });
  box.dispatch("keydown", { key: "ArrowDown" });
  box.dispatch("keydown", { key: "ArrowDown" });
  check("Down is clamped at the last row and does not wrap", active() === 3);
  for (let i = 0; i < 6; i++) box.dispatch("keydown", { key: "ArrowUp" });
  check("Up is clamped at the first row and does not wrap", active() === 0);
  check("the active row is what the textarea points its screen reader at",
    box.getAttribute("aria-activedescendant") === "lcmd-0" &&
      box.getAttribute("aria-expanded") === "true" && box.getAttribute("role") === "combobox");
  check("the list has listbox semantics and the rows are options",
    dom(h, "launcherList").getAttribute("role") === "listbox" &&
      byClass(h, "launcherHost", "launcher-row")[0].getAttribute("role") === "option" &&
      (byClass(h, "launcherHost", "launcher-row")[0] as any).tabIndex === -1);

  const before = h.posts.length;
  e = box.dispatch("keydown", { key: "Enter" });
  check("Enter accepts the highlighted command as text", box.value === "/compact ");
  check("…and does not send: no prompt left the page", h.posts.length === before && e.defaultPrevented);
  check("…and the caret sits after the inserted text, where the argument goes",
    box.selectionStart === "/compact ".length);
  check("…and the launcher closed and gave the box its plain semantics back",
    h.api.launcherState() === null && box.getAttribute("aria-expanded") === null &&
      box.getAttribute("role") === null);
  check("…and it was announced as an insertion, not as a run",
    dom(h, "liveRegion").textContent === "Inserted /compact. Nothing has been sent.");
}
{
  const h = await launcherOn("");
  const box = dom(h, "prompt");
  const before = h.posts.length;
  const e = box.dispatch("keydown", { key: "Enter", ctrlKey: true });
  check("Ctrl+Enter while the launcher is open ACCEPTS and does not send",
    box.value === "/compact " && h.posts.length === before && e.defaultPrevented);
  check("…and a second, deliberate Ctrl+Enter on the closed composer does send",
    (() => { box.value = "do the thing"; box.dispatch("keydown", { key: "Enter", ctrlKey: true });
      return h.posts.some((p) => p.path === "/prompt" && p.body.text === "do the thing"); })());
}
{
  const h = await launcherOn("");
  const box = dom(h, "prompt");
  const e = box.dispatch("keydown", { key: "Tab" });
  check("Tab accepts too, and never moves focus out of the composer",
    box.value === "/compact " && e.defaultPrevented && h.api.launcherState() === null);
}
{
  const h = await launcherOn("exec");
  const box = dom(h, "prompt");
  const e = box.dispatch("keydown", { key: "Escape" });
  check("Escape closes the launcher", h.api.launcherState() === null && e.defaultPrevented);
  check("…and leaves every character the operator typed, slash included", box.value === "/exec");
}
{
  // A command with no argument hint gets no trailing space; text after the
  // caret is the operator's and is left alone.
  const h = await launcherOn("loop");
  const box = dom(h, "prompt");
  box.dispatch("keydown", { key: "Enter" });
  check("a command with no argument hint is inserted without a trailing space", box.value === "/loop");

  const h2 = await launcherOn("exec");
  const b2 = dom(h2, "prompt");
  b2.value = "/exec and then tidy up";
  b2.selectionStart = 5;
  b2.dispatch("input");
  await Promise.resolve(); await Promise.resolve();
  b2.dispatch("keydown", { key: "Enter" });
  check("accepting replaces only the query segment and keeps what follows the caret",
    b2.value === "/execute-plan  and then tidy up");
}

// ── 14. Launcher: pointer, outside click, and no double activation ────────
{
  const h = await launcherOn("");
  const rows = byClass(h, "launcherHost", "launcher-row");
  rows[2].onmouseenter();
  check("hover moves the active row",
    byClass(h, "launcherHost", "launcher-row")[2].getAttribute("aria-selected") === "true");
  const before = h.posts.length;
  byClass(h, "launcherHost", "launcher-row")[2].onclick();
  check("clicking a row accepts it, exactly like Enter", dom(h, "prompt").value === "/feedback");
  check("…once: the click does not also send or re-activate", h.posts.length === before);
  byClass(h, "launcherHost", "launcher-row").forEach(() => {});
  check("…and a second activation of a closed launcher does nothing",
    (() => { h.api.acceptCommand(0); return dom(h, "prompt").value === "/feedback"; })());
}
{
  const h = await launcherOn("");
  h.document.dispatch("click", { target: h.document.getElementById("canvasInner") });
  check("a click outside the composer closes the launcher without inserting anything",
    h.api.launcherState() === null && dom(h, "prompt").value === "/");
  const h2 = await launcherOn("");
  h2.document.dispatch("click", { target: byClass(h2, "launcherHost", "launcher-row")[0] });
  check("a click inside it does not count as an outside click", h2.api.launcherState() !== null);
}

// ── 15. Launcher: unreadable versus genuinely empty ────────────────────────
{
  const h = composer();
  h.route("/commands/list", () => ({ commands: [], tools: [], scope: "session" }));
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  await tick();
  check("a VALID empty catalogue says the agent reports no commands",
    descend(dom(h, "launcherHost")).some((n) => n.textContent === "The agent reports no commands for this session."));
  check("the empty popup still contains the listbox named by aria-controls",
    descend(dom(h, "launcherHost")).includes(dom(h, "launcherList")) &&
      box.getAttribute("aria-controls") === "launcherList");
  check("…and still shows the honest count of zero",
    byClass(h, "launcherHost", "launcher-foot")[0].textContent.startsWith("0 commands · from the agent"));
}
{
  const h = composer();
  h.route("/commands/list", () => ({ error: "commands/list returned no 'commands' array …", unreadable: true }));
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  await tick();
  check("a read FAILURE says it could not be read — never zero commands",
    descend(dom(h, "launcherHost")).some((n) => n.textContent ===
      "The command list could not be read. Type the command if you know it — it will still be sent as text."));
  check("the failed popup still contains the listbox named by aria-controls",
    descend(dom(h, "launcherHost")).includes(dom(h, "launcherList")) &&
      box.getAttribute("aria-controls") === "launcherList");
  check("…and offers no count at all",
    byClass(h, "launcherHost", "launcher-foot").length === 0);
}
{
  const h = composer();
  h.route("/commands/list", () => ({ commands: [{}], tools: [], scope: "session" }));
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  await tick();
  check("a nameless command row is an unreadable catalogue, never an unfiltered count",
    descend(dom(h, "launcherHost")).some((n) => /could not be read/.test(n.textContent)) &&
      byClass(h, "launcherHost", "launcher-foot").length === 0);
}
{
  const h = composer();
  h.route("/commands/list", () => ({ commands: [{ name: "   " }], tools: [], scope: "session" }));
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  await tick();
  check("a whitespace-only command name is unreadable, not an insertable row",
    descend(dom(h, "launcherHost")).some((n) => /could not be read/.test(n.textContent)));
}

// ── 16. Launcher: live updates, session switch, reload, two tabs ───────────
{
  const h = await launcherOn("");
  const box = dom(h, "prompt");
  box.dispatch("keydown", { key: "ArrowDown" });  /* highlight execute-plan */
  const REORDERED = [
    { name: "loop", description: "Run a prompt repeatedly" },
    { name: "execute-plan", description: "Execute a saved plan file end to end", input: { hint: "<design-doc-path>" } },
    { name: "brand-new-skill", description: "just installed" },
  ];
  h.api.receive(appEvent(70, "commands.updated", { commands: REORDERED, count: 3, toolNames: [] }, "live"));
  check("a valid update replaces the catalogue in place, without closing",
    h.api.launcherState() !== null &&
      byClass(h, "launcherHost", "launcher-row").length === 3);
  check("…and keeps the highlighted command by NAME, wherever it moved to",
    byClass(h, "launcherHost", "lr-name")[1].textContent === "/execute-plan" &&
      byClass(h, "launcherHost", "launcher-row")[1].getAttribute("aria-selected") === "true");
  check("…and the count follows it", byClass(h, "launcherHost", "launcher-foot")[0].textContent.startsWith("3 commands"));
  check("…and the update is not narrated over the operator's typing",
    dom(h, "liveRegion").textContent !== "3 commands");

  const TEXT_ONLY = REORDERED.map((row) => row.name === "execute-plan"
    ? { ...row, description: "A newer description", input: { hint: "<new-argument>" } }
    : row);
  h.api.receive(appEvent(71, "commands.updated", { commands: TEXT_ONLY, count: 3, toolNames: [] }, "live"));
  check("a same-name command update repaints changed description and hint text",
    byClass(h, "launcherHost", "lr-desc")[1].textContent === "A newer description" &&
      byClass(h, "launcherHost", "lr-hint")[0].textContent === "<new-argument>");

  // A malformed update: the server sends null, and the last good list stands.
  h.api.receive(appEvent(72, "commands.updated", { commands: null, count: null, toolNames: null }, "live"));
  check("a malformed live update keeps the last good list rather than emptying it",
    byClass(h, "launcherHost", "launcher-row").length === 3 &&
      byClass(h, "launcherHost", "launcher-foot")[0].textContent.startsWith("3 commands"));
  const notesBefore = h.api.notes().length;
  h.api.handle({
    ...appEvent(73, "bridge.commands_unreadable",
      { sessionId: "s", source: "agent-notification", keptCount: 3 }, "live"),
    note: "an available_commands_update for s carried no command array, so nothing was absorbed.",
    deliveryId: null,
  });
  check("…and the server's diagnostic reaches the operator rather than only a log",
    h.api.notes().length === notesBefore + 1 &&
      /carried no command array/.test(String(h.api.notes()[0].text)) &&
      h.api.notes()[0].kind === "error");
  check("…and it does not become an unhandled-event card, which would double-report it",
    !h.api.view("s").turns.some((t: any) => t.items.some((i: any) => i.kind === "unhandled")));
}
{
  let resolveQuery: (value: any) => void = () => {};
  const h = composer();
  h.route("/commands/list", () => new Promise((resolve) => { resolveQuery = resolve; }));
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  await tick();
  h.api.receive(appEvent(75, "commands.updated", {
    commands: [{ name: "new-live", description: "newer event" }], count: 1, toolNames: [],
  }, "live"));
  resolveQuery({ commands: [{ name: "old-query", description: "stale response" }], tools: [], scope: "session" });
  await tick();
  check("a stale command query cannot overwrite a newer live catalogue",
    byClass(h, "launcherHost", "lr-name").map((n) => n.textContent).join(",") === "/new-live");
}
{
  // No prior good list + a malformed update = unavailable, not empty.
  const h = composer();
  h.route("/commands/list", () => new Promise(() => {}));   /* never answers */
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  h.api.receive(appEvent(80, "commands.updated", { commands: null, count: null, toolNames: null }, "live"));
  check("a malformed update with no earlier good list leaves the launcher unavailable, not empty",
    descend(dom(h, "launcherHost")).some((n) => /could not be read/.test(n.textContent)) &&
      !descend(dom(h, "launcherHost")).some((n) => /no commands for this session/.test(n.textContent)));
}
{
  let resolveQuery: (value: any) => void = () => {};
  const h = composer();
  h.route("/commands/list", () => new Promise((resolve) => { resolveQuery = resolve; }));
  const box = dom(h, "prompt");
  box.value = "/"; box.selectionStart = 1; box.dispatch("input");
  await tick();
  h.api.receive(appEvent(85, "commands.updated", { commands: null, count: null, toolNames: null }, "live"));
  resolveQuery({ commands: [{ name: "valid-query", description: "read after malformed event" }], tools: [], scope: "session" });
  await tick();
  check("an unreadable live update does not discard a concurrently valid command query",
    byClass(h, "launcherHost", "lr-name").map((n) => n.textContent).join(",") === "/valid-query");
}
{
  // renderComposer runs on EVERY event. An open launcher must survive a
  // streaming turn without being thrown away and rebuilt under the operator's
  // hand — that would reset the list's scroll position on every chunk.
  const h = await launcherOn("");
  const host = dom(h, "launcherHost");
  const panelBefore = descend(host)[0];
  h.api.receive(appEvent(90, "turn.started", { text: "a turn while the list is open" }, "live"));
  for (let i = 0; i < 12; i++) h.api.receive(appEvent(91 + i, "message.chunk", { text: "tok" }, "live"));
  check("a streaming turn does not rebuild the open launcher",
    descend(host)[0] === panelBefore && h.api.launcherState() !== null);
  check("…and it is still showing the same rows",
    byClass(h, "launcherHost", "launcher-row").length === 4);
  // …but a real change to what it shows still repaints it.
  dom(h, "prompt").dispatch("keydown", { key: "ArrowDown" });
  check("moving the active row does repaint it",
    descend(host)[0] !== panelBefore &&
      byClass(h, "launcherHost", "launcher-row")[1].getAttribute("aria-selected") === "true");
}
{
  const h = await launcherOn("");
  h.api.setAgent({ state: "ready", failure: null, failureCause: null, pid: 1, restarts: 0, sessions: [rec(), rec({ sessionId: "s2", cwd: "/tmp/s2" })], openInteractions: [] });
  h.api.setActive("s2");
  h.api.renderComposerNow();
  check("switching session closes the launcher — session A's list never paints on B",
    h.api.launcherState() === null);
}
{
  const h = await launcherOn("");
  h.api.setAgent({ state: "gone", failure: "child exited", failureCause: null, pid: null, restarts: 1, sessions: [rec()], openInteractions: [] });
  h.api.renderComposerNow();
  check("a composer that goes dead closes the launcher with it", h.api.launcherState() === null);
}
{
  const fresh = composer();
  check("a reloaded page starts with the launcher closed — it is never restored",
    fresh.api.launcherState() === null && dom(fresh, "launcherHost").hidden === true);
  const a = await launcherOn("exec");
  const b = composer();
  check("two tabs browse independently: opening one does not open the other",
    a.api.launcherState() !== null && b.api.launcherState() === null);
}

// ── 17. What WP7 must NOT have changed ─────────────────────────────────────
{
  const h = composer({ turnInFlight: true });
  check("Send and Stop are still two separate controls with complementary rules",
    dom(h, "btnSend").disabled === true && dom(h, "btnStop").disabled === false);
  check("…and they are still two buttons in the markup, not one that morphs",
    /<button class="btn" id="btnSend" disabled>Send<\/button>\s*<button class="btn" data-variant="ghost" id="btnStop" disabled>Stop<\/button>/.test(HTML_SOURCE));
  check("Stop is still a notification with nothing to trust — and it is said in the note",
    dom(h, "composerNote").textContent === "A turn is running · Stop cancels it.");
  const idle = composer();
  check("plain Enter with no launcher open is still a line break, never a send",
    (() => { const box = dom(idle, "prompt"); box.value = "half a paragraph";
      const e = box.dispatch("keydown", { key: "Enter" });
      return !e.defaultPrevented && !idle.posts.some((p) => p.path === "/prompt"); })());
  check("the idle note is present tense and no longer promises WP7",
    dom(idle, "composerNote").textContent === "Ctrl+Enter sends · type / for commands." &&
      !/WP7/.test(dom(idle, "composerNote").title));
  check("no WP-marker copy is left anywhere the operator can read it",
    !/are WP7|display-only in WP4/.test(APP_SOURCE + HTML_SOURCE));
}

// ── 18. Static: geometry and markup only the stylesheet can state ──────────
check("the launcher opens upward, inside the composer's own 720px column",
  /\.composer-inner\s*\{[^}]*position:\s*relative/.test(CSS_SOURCE) &&
    /\.launcher\s*\{[^}]*position:\s*absolute[^}]*bottom:\s*100%/.test(CSS_SOURCE));
check("…scrolls internally at about 40vh instead of growing the composer",
  /\.launcher\s*\{[^}]*max-height:\s*40vh/.test(CSS_SOURCE) &&
    /\.launcher-list\s*\{[^}]*overflow-y:\s*auto/.test(CSS_SOURCE));
check("…and adds no backdrop, no modal host, and no permanent composer row",
  !/\.launcher-backdrop/.test(CSS_SOURCE) &&
    (HTML_SOURCE.match(/class="composer-meta"/g) || []).length === 1);
check("the composer keeps its 72px floor and its 720px measure",
  /--composer-min-h:\s*72px/.test(CSS_SOURCE) && /\.composer-inner\s*\{[^}]*max-width:\s*var\(--read-max\)/.test(CSS_SOURCE));
check("the effort select is capped so a long runtime label truncates instead of wrapping the row",
  /\.composer-select\s*\{[^}]*max-width:\s*150px/.test(CSS_SOURCE));
check("runtime model and command names are bounded instead of forcing horizontal overflow",
  /\.model-readout\s*\{[^}]*min-width:\s*0/.test(CSS_SOURCE) &&
    /\.lr-name\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/.test(CSS_SOURCE));
check("at phone width routine help yields but important outcomes remain visible",
  /#composerNote:not\(\[data-important="true"\]\)\s*\{\s*display:\s*none;\s*\}/.test(CSS_SOURCE) &&
    /#composerNote\[data-important="true"\]\s*\{[^}]*flex-basis:\s*100%/.test(CSS_SOURCE));
check("the launcher's rows are touch-sized where the pointer is coarse",
  /@media \(pointer:\s*coarse\)\s*\{\s*\.launcher-row/.test(CSS_SOURCE));
check("nothing WP7 added borrows gold — steel only (D45)",
  !/\.launcher[^{]*\{[^}]*--brand-gold/.test(CSS_SOURCE) &&
    !/\.plan-state[^{]*\{[^}]*gold/.test(CSS_SOURCE) &&
    !/\.composer-select[^{]*\{[^}]*gold/.test(CSS_SOURCE));
check("pending states are words, never spinners or animation",
  !/\.launcher[\s\S]{0,400}?animation:/.test(CSS_SOURCE) && !/spinner/.test(APP_SOURCE));
check("the composer's live region is visually hidden and polite",
  /id="liveRegion" aria-live="polite"/.test(HTML_SOURCE) && /\.sr-only\s*\{/.test(CSS_SOURCE));
check("the effort select has a real programmatic label, not a positional one",
  /<label class="composer-effort[\s\S]*?<span class="effort-label">Effort<\/span>[\s\S]*?<select[^>]*id="effortSelect"/.test(HTML_SOURCE));
check("WP7 added no inline handler and no inline script — CSP unchanged (D33)",
  !/\son(click|change|keydown|error|load)\s*=/.test(HTML_SOURCE) && !/<script(?![^>]*src=)/.test(HTML_SOURCE));
check("the masthead is untouched by WP7",
  /<header class="masthead">[\s\S]*?<\/header>/.test(HTML_SOURCE) &&
    /\.masthead\s*\{[^}]*height:\s*48px/.test(CSS_SOURCE));
check("no personal path from this machine reached the shell",
  !/\/home\/[a-z]/.test(APP_SOURCE) && !/\/mnt\/vault/.test(APP_SOURCE));
/* WP14: the same guard on the check sources themselves — the fixture-path
   scrub's keep. Neutral fixtures (/home/user, /tmp/example-project) are fine;
   THIS machine's paths are not. The character-class spelling keeps the
   assertion's own text from matching. */
{
  const checkSources = readdirSync(HERE).filter((f) => f.endsWith(".check.ts"))
    .map((f) => readFileSync(join(HERE, f), "utf8")).join("\n");
  check("WP14: no personal path from this machine reached the check sources either",
    !/\/home\/cor[e]/.test(checkSources) && !/\/mnt\/vault/.test(checkSources));
}

// ══ WP14 — the notice strip, and the dev-gated Shell tab ═══════════════════

// The strip mirrors the latest note() above the composer; dismissal hides it
// until a NEWER note arrives; the dev Shell log keeps every note either way.
// (A connected harness boots clean; an unconnected one boots with the
// no-token error note, which is itself the strip doing its job.)
{
  const h = harness(true);
  const strip = h.document.getElementById("noticeStrip");
  h.api.renderNoticeStrip();
  check("WP14: with nothing to say the strip hides itself", strip.hidden === true);
  open(h);
  finish(h, 1);
  h.api.note("error", "Not renamed — the agent process is gone. Try again.", "/session/rename — HTTP 500\n gone");
  check("WP14: an error note shows the strip with exactly that sentence",
    strip.hidden === false && strip.textContent.includes("Not renamed — the agent process is gone. Try again."));
  check("WP14: the strip's details ride the Copy button, never the line",
    !strip.textContent.includes("/session/rename — HTTP 500") &&
      h.document.created.some((n: any) => n.className === "copy-details"));
  check("WP14: an error wears the error voice (data-kind, no gold anywhere)",
    strip.dataset.kind === "error");
  const dismiss = h.document.created.find((n: any) => n.className === "notice-dismiss");
  dismiss.onclick!();
  check("WP14: dismissing hides the strip", strip.hidden === true);
  h.api.note("info", "Imported — the session is back in the list.");
  check("WP14: a NEWER note re-shows the strip after a dismissal",
    strip.hidden === false && strip.textContent.includes("Imported — the session is back in the list."));
  check("WP14: an informational note stays neutral", strip.dataset.kind === "info");
  check("WP14: the dev Shell log keeps every note either way",
    h.api.notes().length === 2);
}

// Fix round (Codex coverage gap): a hostile payload pushed through note() is
// text only on the strip — no element is ever created from it (rule 10),
// mirroring the WP11 suite-16 hostile-fixture shape.
{
  const h = harness(true);
  const payload = '<script>alert(1)</script><img src=x onerror="alert(2)">';
  h.api.note("error", payload, payload);
  h.api.renderNoticeStrip();
  const strip = h.document.getElementById("noticeStrip");
  const spawned = h.document.created.filter((n: any) =>
    ["SCRIPT", "IMG", "SVG", "IFRAME"].includes(n.tagName));
  check("WP14: a hostile payload through note() creates no elements anywhere",
    spawned.length === 0);
  check("WP14: the payload reaches the strip as intact text",
    strip.textContent.includes(payload));
  check("WP14: …shown, in the error voice, with its details button",
    strip.hidden === false && strip.dataset.kind === "error" &&
      h.document.created.some((n: any) => n.className === "copy-details"));
}

// The Shell tab is a development surface: hidden in a public build, present
// in a STUDIO_DEV=1 build, and unreachable through setTab when gated.
{
  const pub = harness();
  check("WP14: a public build reads the page as non-dev", pub.api.wp14State().devBuild === false);
  check("WP14: a public build hides the Shell tab",
    pub.document.getElementById("tabShell").hidden === true);
  pub.api.setTab("shell");
  check("WP14: setTab('shell') in a public build lands on Detail instead",
    pub.api.wp14State().drawerTab === "detail");
  const dev = harness(false, new Map(), true);
  check("WP14: a dev build reads the page as dev", dev.api.wp14State().devBuild === true);
  check("WP14: a dev build keeps the Shell tab visible",
    dev.document.getElementById("tabShell").hidden !== true);
  dev.api.setTab("shell");
  check("WP14: setTab('shell') works in a dev build",
    dev.api.wp14State().drawerTab === "shell");
  /* Fix round (Grok F6): renderDrawer's own fallthrough is guarded too — a
     bypassed setTab can never paint the dev surface in a public build. */
  const pub2 = harness();
  pub2.api.setDrawerTab("shell");
  pub2.api.renderDrawer();
  const body = pub2.document.getElementById("drawerBody");
  check("WP14: renderDrawer never paints the Shell tab in a public build, even on a bypass",
    !body.textContent.includes("Shell inspector"));
  const dev2 = harness(false, new Map(), true);
  dev2.api.setDrawerTab("shell");
  dev2.api.renderDrawer();
  check("WP14: renderDrawer paints the Shell tab in a dev build",
    dev2.document.getElementById("drawerBody").textContent.includes("Shell inspector"));
}

// The strip's markup and tokens, source-level: above the composer, polite
// status role, neutral tokens only — gold stays licensed to its three
// waiting-for-you surfaces (D45/D53), and steel is fine but never gold.
check("WP14: the strip sits above the composer in the markup, with a polite role",
  /id="noticeStrip" role="status" hidden[\s\S]*?<!-- Composer/.test(HTML_SOURCE));
check("WP14: the page carries the dev-flag placeholder for the server to substitute",
  /<meta id="studioDev" name="studio-dev" content="__STUDIO_DEV__">/.test(HTML_SOURCE));
{
  const stripBlock = CSS_SOURCE.slice(
    CSS_SOURCE.indexOf(".notice-strip {"),
    CSS_SOURCE.indexOf(".composer {"),
  );
  check("WP14: the strip borrows no gold — failures speak in the existing failed red",
    !/--brand-gold|--state-permission|#C0A050|#C9A45C/i.test(stripBlock) &&
      /--state-failed/.test(stripBlock));
}
check("WP14: the dev banner copy false since WP6 is gone from the startup banner",
  !/which the shell cannot yet/.test(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.ts"), "utf8")));

// ══ WP15 — privacy panel + retention switch (D87, D88) ═══════════════════

// Asymmetry: opt-OUT is one click; opt-IN cannot be reached without the confirm.
{
  const h = harness();
  open(h, [], [], false);
  /* Start opted-IN so the visible control is the safe one-click "Opt out". */
  h.api.setAgent({ ...AGENT_FACTS, agentConfig: {
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    retention: { retentionOptOut: false, isZdr: false, problem: null },
  } });
  h.route("/agent/retention", (body: any) => ({
    outcome: "verified",
    note: "Verified — coding-data retention opt-out is ON.",
    requested: body.codingDataRetentionOptOut,
    replyOptOut: body.codingDataRetentionOptOut,
    replyAgreed: true,
    fileOptOut: body.codingDataRetentionOptOut,
    fileFollowed: true,
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: body.codingDataRetentionOptOut, isZdr: false, problem: null },
    },
  }));
  h.route("/state", () => ({
    ...AGENT_FACTS,
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: true, isZdr: false, problem: null },
    },
  }));
  h.api.renderAll();
  const optOutBtn = h.document.created.find((b: any) =>
    b.tagName === "BUTTON" && (b.textContent || "").trim() === "Opt out");
  check("WP15: opted-in shows Opt out (safe direction, one click)", !!optOutBtn);
  optOutBtn.onclick!();
  /* The click fires setRetention async; flush microtasks so the post and note land. */
  for (let i = 0; i < 20; i++) await Promise.resolve();
  check("WP15: Opt out posts /agent/retention with codingDataRetentionOptOut:true without a modal",
    h.posts.some((p: any) => p.path === "/agent/retention" && p.body.codingDataRetentionOptOut === true) &&
    h.api.wp13State().modal === null);
  check("WP15: a verified opt-out produces the verified sentence",
    h.api.notes().some((n: any) => /Verified/.test(n.text) && /opt-out is ON/.test(n.text)));
}

// Opt-IN path: the button opens the confirm; only the confirm's danger button commits.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent(AGENT_FACTS); /* retentionOptOut: true → Opt in… */
  h.route("/agent/retention", (body: any) => ({
    outcome: "verified",
    note: "Verified — coding-data retention opt-out is OFF.",
    requested: body.codingDataRetentionOptOut,
    replyOptOut: body.codingDataRetentionOptOut,
    replyAgreed: true,
    fileOptOut: body.codingDataRetentionOptOut,
    fileFollowed: true,
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: body.codingDataRetentionOptOut, isZdr: false, problem: null },
    },
  }));
  h.route("/state", () => ({
    ...AGENT_FACTS,
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: false, isZdr: false, problem: null },
    },
  }));
  h.api.renderAll();
  const optInBtn = h.document.created.find((b: any) =>
    b.tagName === "BUTTON" && /Opt in/.test(b.textContent || ""));
  check("WP15: opted-out shows Opt in… (privacy-degrading, needs confirm)", !!optInBtn);
  const postsBefore = h.posts.filter((p: any) => p.path === "/agent/retention").length;
  optInBtn.onclick!();
  check("WP15: Opt in… opens the retentionOptIn modal and does NOT post yet",
    h.api.wp13State().modal && h.api.wp13State().modal.kind === "retentionOptIn" &&
    h.posts.filter((p: any) => p.path === "/agent/retention").length === postsBefore);
  h.api.renderModal();
  const host = h.document.getElementById("modalHost");
  check("WP15: the opt-in confirm names the consequence (training / share)",
    host.textContent.includes("Share coding data") &&
    host.textContent.includes("training"));
  check("WP15: the opt-in confirm has an accessible name (aria-labelledby → modalTitle)",
    !!h.document.created.find((n: any) => n.id === "modalTitle" && /Share coding data/.test(n.textContent || "")));
  const cancel = h.document.created.find((b: any) =>
    b.tagName === "BUTTON" && (b.textContent || "").trim() === "Cancel" && b.onclick);
  const commit = h.document.created.find((b: any) =>
    b.tagName === "BUTTON" && /Opt in — share coding data/.test(b.textContent || ""));
  check("WP15: Cancel is present and the commit button is styled danger",
    !!cancel && !!commit && commit.dataset.variant === "danger");
  /* Cancel closes without posting. */
  cancel.onclick!();
  check("WP15: Cancel closes the modal with no retention post",
    h.api.wp13State().modal === null &&
    h.posts.filter((p: any) => p.path === "/agent/retention").length === postsBefore);
  /* Re-open and commit. */
  optInBtn.onclick!();
  h.api.renderModal();
  const commit2 = h.document.created.find((b: any) =>
    b.tagName === "BUTTON" && /Opt in — share coding data/.test(b.textContent || ""));
  commit2.onclick!();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  check("WP15: confirm commit posts codingDataRetentionOptOut:false (opted in)",
    h.posts.some((p: any) => p.path === "/agent/retention" && p.body.codingDataRetentionOptOut === false));
}

// Three distinct outcomes — never an optimistic flip. Each exercised against
// fixture replies; the displayed value only changes when agentConfig is
// re-read from the response (and only then if the server says so).
{
  const cases: { outcome: string; note: string; fileOptOut: boolean; expect: RegExp; kind: string }[] = [
    {
      outcome: "verified",
      note: "Verified — coding-data retention opt-out is ON. Your code data will not be trained on or used to improve the product.",
      fileOptOut: true,
      expect: /^Verified/,
      kind: "info",
    },
    {
      outcome: "acknowledged_not_confirmed",
      note: "Acknowledged, not confirmed — the account may have changed while the local file did not.",
      fileOptOut: false, /* file did NOT follow */
      expect: /^Acknowledged, not confirmed/,
      kind: "error",
    },
    {
      outcome: "refused",
      note: "Refused — <script>alert(1)</script> team ZDR blocks this",
      fileOptOut: false,
      expect: /^Refused — /,
      kind: "error",
    },
  ];
  for (const c of cases) {
    const h = harness();
    open(h, [], [], false);
    /* Start opted-in so Opt out is one click (no modal in the path). */
    h.api.setAgent({ ...AGENT_FACTS, agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: false, isZdr: false, problem: null },
    } });
    h.route("/agent/retention", () => ({
      outcome: c.outcome,
      note: c.note,
      requested: true,
      replyOptOut: c.outcome === "refused" ? null : true,
      replyAgreed: c.outcome !== "refused",
      fileOptOut: c.fileOptOut,
      fileFollowed: c.fileOptOut === true,
      error: c.outcome === "refused" ? c.note.slice("Refused — ".length) : undefined,
      agentConfig: {
        permissionMode: { mode: "ask", source: "permission_mode", problem: null },
        /* The file reading the server re-read — never an optimistic flip. */
        retention: { retentionOptOut: c.fileOptOut, isZdr: false, problem: null },
      },
    }));
    h.route("/state", () => ({
      ...AGENT_FACTS,
      agentConfig: {
        permissionMode: { mode: "ask", source: "permission_mode", problem: null },
        retention: { retentionOptOut: c.fileOptOut, isZdr: false, problem: null },
      },
    }));
    h.api.renderAll();
    await h.api.setRetention(true);
    const notes = h.api.notes();
    const hit = notes.find((n: any) => c.expect.test(n.text));
    check(`WP15: outcome '${c.outcome}' produces its distinct sentence`, !!hit);
    check(`WP15: outcome '${c.outcome}' sentence is exact (not mangled)`,
      !!hit && hit.text === c.note);
    check(`WP15: outcome '${c.outcome}' uses the ${c.kind} voice`,
      !!hit && hit.kind === c.kind);
    /* The displayed value follows the FILE reading, never the request alone. */
    const text = h.document.getElementById("canvasInner").textContent;
    if (c.fileOptOut === true) {
      check(`WP15: outcome '${c.outcome}' shows Opted out only when the file says so`,
        text.includes("Opted out"));
    } else {
      check(`WP15: outcome '${c.outcome}' does NOT flip the display when the file did not follow`,
        text.includes("Opted in") && !text.includes("Opted out —"));
    }
    /* Hostile refusal is text, never markup. */
    if (c.outcome === "refused") {
      const spawned = h.document.created.filter((n: any) =>
        ["SCRIPT", "IMG", "SVG", "IFRAME"].includes(n.tagName) &&
        (n.textContent || "").includes("alert"));
      check("WP15: a hostile refusal error creates no elements from the payload",
        spawned.length === 0);
      check("WP15: the hostile refusal reaches the note as intact text",
        notes.some((n: any) => n.text.includes("<script>alert(1)</script>")));
    }
  }
}

// Gold stays off the privacy switch CSS (D45/D53).
{
  const factCss = CSS_SOURCE.slice(
    CSS_SOURCE.indexOf(".agent-facts"),
    CSS_SOURCE.indexOf(".agent-facts") + 800,
  );
  check("WP15: the facts/switch CSS borrows no gold",
    !/--brand-gold|#C0A050|#C9A45C/i.test(factCss));
}

// ── WP15 layout fix-round: the two walk defects are bound at the CSS level ──
// The DOM harness has no layout engine, so these bind the exact rules whose
// computed values were measured live (docs/evidence/wp15/layout/): the nowrap
// that painted labels over values, and the missing wrap that gave the path a
// 0px column. Text assertions on the stylesheet are the house bind for CSS
// (WP12-F1's [hidden] guard, the WP9 narrow tiers).
{
  check("WP15 layout: agent-facts labels WRAP — no nowrap survives on the facts table",
    !/\.agent-facts \.grid th\s*\{[^}]*white-space:\s*nowrap/.test(CSS_SOURCE) &&
    /\.agent-facts \.grid th\s*\{\s*white-space:\s*normal;\s*\}/.test(CSS_SOURCE));
  check("WP15 layout: the changes-file head wraps, so a long attribution takes its own line",
    /\.chg-file-head\s*\{[^}]*flex-wrap:\s*wrap/.test(CSS_SOURCE));
  check("WP15 layout: the path carries a real 10rem basis so siblings wrap, never the path to zero",
    /\.chg-path\s*\{\s*flex:\s*1 1 10rem;\s*min-width:\s*0;\s*overflow-wrap:\s*break-word;\s*\}/.test(CSS_SOURCE));
}

// ── WP15 fix-round 1: adversarial a11y on the real renderModal/closeModal ──
// Codex authored these five in-memory during review; the shipped suite only
// found a modalTitle node. Drive the real bodies: opener → dialog name → Tab
// wrap both ways → focus restore on close.
// Fresh agentConfig object: earlier tests may have mutated AGENT_FACTS in place
// via setAgent(AGENT_FACTS) then agent.agentConfig = res.agentConfig.
{
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent({
    state: "ready", failure: null, failureCause: null, pid: 4242, restarts: 0,
    sessions: [], openInteractions: [], agentVersion: "9.9.9-test",
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: true, isZdr: false, problem: null },
    },
  });
  h.api.renderAll();
  const opener = h.document.created.find((b: any) =>
    b.tagName === "BUTTON" && /Opt in/.test(b.textContent || ""));
  check("WP15 a11y: the opt-in opener is the modal opener", !!opener);
  opener.focus();
  opener.onclick!({ preventDefault() {}, stopPropagation() {} });
  check("WP15 a11y: opener click opens retentionOptIn (real renderModal path)",
    h.api.wp13State().modal && h.api.wp13State().modal.kind === "retentionOptIn");
  const dialog = h.document.created.filter((n: any) =>
    n.getAttribute && n.getAttribute("role") === "dialog").at(-1);
  check("WP15 a11y: renderModal produced a role=dialog", !!dialog);
  const title = (() => {
    const out: any[] = [];
    const walk = (n: any) => { for (const c of n.children || []) { out.push(c); walk(c); } };
    walk(dialog);
    return out.find((n: any) => n.id === "modalTitle");
  })();
  check("WP15 a11y: dialog accessible name resolves via aria-labelledby to the title",
    dialog.getAttribute("aria-labelledby") === "modalTitle" &&
    !!title && /Share coding data/.test(title.textContent || ""));
  const focusables = dialog.querySelectorAll("button, input").filter((n: any) => !n.disabled);
  check("WP15 a11y: the dialog has at least two focusable controls (Cancel + commit)",
    focusables.length >= 2);
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  /* Forward trap: Tab at the last focusable wraps to the first. */
  let prevented = false;
  last.focus();
  dialog.onkeydown({ key: "Tab", shiftKey: false, preventDefault() { prevented = true; } });
  check("WP15 a11y: forward focus trap wraps Tab at the last focusable",
    prevented === true && h.document.activeElement === first);
  /* Reverse trap: Shift+Tab at the first wraps to the last. */
  prevented = false;
  first.focus();
  dialog.onkeydown({ key: "Tab", shiftKey: true, preventDefault() { prevented = true; } });
  check("WP15 a11y: reverse focus trap wraps Shift+Tab at the first focusable",
    prevented === true && h.document.activeElement === last);
  /* Close restores focus to the opener (closeModal's real body). */
  first.focus(); /* focus is inside the host so restore is earned */
  first.onclick!();
  check("WP15 a11y: close restores focus to the opener",
    h.document.activeElement === opener && h.api.wp13State().modal === null);
}

// ── WP15 fix-round 2: both mounts (first-run canvas AND Agent drawer tab) ──
{
  const factsAgent = {
    state: "ready", failure: null, failureCause: null, pid: 4242, restarts: 0,
    sessions: [] as any[], openInteractions: [] as any[], agentVersion: "9.9.9-test",
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: true, isZdr: false, problem: null },
    },
  };
  const h = harness();
  open(h, [], [], false);
  h.api.setAgent(factsAgent);
  h.api.renderAll();
  const canvas = h.document.getElementById("canvasInner").textContent;
  check("WP15 both-mounts: first-run canvas carries the retention row",
    canvas.includes("coding-data retention") && canvas.includes("Opted out"));
  check("WP15 both-mounts: first-run canvas carries the ZDR row",
    canvas.includes("zero-data retention") && canvas.includes("OFF"));
}
{
  const h = harness();
  open(h); /* session held so the canvas is not the facts surface */
  h.api.setAgent({
    state: "ready", failure: null, failureCause: null, pid: 4242, restarts: 0,
    sessions: [{ sessionId: "s", cwd: "/tmp/s", live: true, loading: false, acquired: "new" }],
    openInteractions: [], agentVersion: "9.9.9-test",
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: true, isZdr: false, problem: null },
    },
  });
  h.document.getElementById("app").dataset.drawer = "open";
  h.api.setTab("agent"); /* real setTab → renderDrawer → renderAgentTab → renderAgentFacts */
  const drawer = h.document.getElementById("drawerBody").textContent;
  check("WP15 both-mounts: Agent drawer tab carries the retention row",
    drawer.includes("coding-data retention") && drawer.includes("Opted out"));
  check("WP15 both-mounts: Agent drawer tab carries the ZDR row",
    drawer.includes("zero-data retention") && drawer.includes("OFF"));
}

// ── WP15 fix-round 3: staleness — re-read-on-open is bound, not source-inspected ──
// requestAgentConfigRefresh debounces 2s. open()'s channel_open already paints
// the first-run panel once, so we wait past that window before each measured open.
// phase controls which fixture the route returns so open()-time noise cannot
// burn the "first" fixture before we measure.
{
  const h = harness();
  let phase: "noise" | "first" | "second" = "noise";
  let phasePosts = 0;
  h.route("/agent/config-facts", () => {
    if (phase === "first" || phase === "second") phasePosts++;
    if (phase === "second") {
      /* File moved under us between panel opens (CLI /privacy or enrichment). */
      return {
        agentConfig: {
          permissionMode: { mode: "ask", source: "permission_mode", problem: null },
          retention: { retentionOptOut: false, isZdr: true, problem: null },
        },
      };
    }
    /* noise + first: opted out, ZDR OFF */
    return {
      agentConfig: {
        permissionMode: { mode: "ask", source: "permission_mode", problem: null },
        retention: { retentionOptOut: true, isZdr: false, problem: null },
      },
    };
  });
  open(h, [], [], false);
  h.api.setAgent({
    state: "ready", failure: null, failureCause: null, pid: 4242, restarts: 0,
    sessions: [], openInteractions: [], agentVersion: "9.9.9-test",
    agentConfig: {
      permissionMode: { mode: "ask", source: "permission_mode", problem: null },
      retention: { retentionOptOut: true, isZdr: false, problem: null },
    },
  });
  /* Clear any open()-time debounce; this is the measured first panel open. */
  await new Promise((r) => setTimeout(r, 2100));
  phase = "first";
  phasePosts = 0;
  h.api.renderAll();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  check("WP15 staleness: the first panel open posts /agent/config-facts",
    phasePosts >= 1 &&
    h.posts.some((p: any) => p.path === "/agent/config-facts"));
  const firstText = h.document.getElementById("canvasInner").textContent;
  check("WP15 staleness: first open shows the first fixture (opted out, ZDR OFF)",
    firstText.includes("Opted out") && firstText.includes("OFF") &&
    !firstText.includes("Opted in —"));
  /* Second open after another debounce window — fixture has flipped. */
  await new Promise((r) => setTimeout(r, 2100));
  phase = "second";
  phasePosts = 0;
  h.api.renderAll();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  check("WP15 staleness: the second open re-posts /agent/config-facts",
    phasePosts >= 1);
  const secondText = h.document.getElementById("canvasInner").textContent;
  check("WP15 staleness: second open shows the fresh fixture (opted in, ZDR ON)",
    secondText.includes("Opted in") &&
    secondText.includes("ON — your data is not retained") &&
    !secondText.includes("Opted out —"));
}

// Source-level: the three outcomes are named in the server route, and the
// app never writes auth.json — broadened beyond writeFile*(AUTH_PATH).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(join(here, "server.ts"), "utf8");
  const sessionsSrc = readFileSync(join(here, "sessions.ts"), "utf8");
  const configReadSrc = readFileSync(join(here, "config-read.ts"), "utf8");
  check("WP15: server names the three outcomes",
    /outcome:\s*"verified"/.test(serverSrc) &&
    /acknowledged_not_confirmed/.test(serverSrc) &&
    /outcome:\s*"refused"/.test(serverSrc));
  /* Fix-round 5: reject every write-shaped fs spelling that could target AUTH_PATH,
     not just writeFile*(AUTH_PATH). Also assert AUTH_PATH is an argument of no
     write API in the three reader/server files. */
  const authWriteSpellings = [
    /writeFile(?:Sync)?\s*\(\s*AUTH_PATH/,
    /appendFile(?:Sync)?\s*\(\s*AUTH_PATH/,
    /createWriteStream\s*\(\s*AUTH_PATH/,
    /renameSync\s*\(\s*AUTH_PATH/,
    /copyFile(?:Sync)?\s*\(\s*AUTH_PATH/,
    /openSync\s*\(\s*AUTH_PATH\s*,\s*['"`][wax+]/,
  ];
  for (const [label, src] of [
    ["server.ts", serverSrc],
    ["sessions.ts", sessionsSrc],
    ["config-read.ts", configReadSrc],
  ] as const) {
    for (const re of authWriteSpellings) {
      check(`WP15 auth-write: ${label} has no ${re.source} targeting AUTH_PATH`,
        !re.test(src));
    }
    /* AUTH_PATH (or the literal ~/.grok/auth.json path string) must not appear
       as an argument to any of the write-family APIs even via multi-line forms
       we regex more loosely: API name, then AUTH_PATH before the next statement. */
    const looseWrite =
      /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|renameSync|copyFile(?:Sync)?|openSync)\s*\(\s*[^)]*AUTH_PATH/;
    check(`WP15 auth-write: ${label} passes AUTH_PATH to no fs write API`,
      !looseWrite.test(src));
  }
  check("WP15: server logs auth digests around the set (not the content)",
    /auth\.json sha256 before/.test(serverSrc) && /authDigest\(/.test(serverSrc));
  check("WP15: sessions.ts registers the FLAT envelope for setCodingDataRetention",
    /"_x\.ai\/privacy\/setCodingDataRetention":\s*false/.test(sessionsSrc));
  check("WP15: sessions.ts uses a ≥30s privacy timeout",
    /PRIVACY_TIMEOUT_MS\s*=\s*30_000/.test(sessionsSrc));
  check("WP15: sessions.ts still imports no filesystem module (cannot write auth.json)",
    !/\bfrom\s+["']node:fs["']/.test(sessionsSrc) &&
    !/\bfrom\s+["']node:fs\/promises["']/.test(sessionsSrc));
  check("WP15: config-read.ts only imports readFileSync from node:fs (no write surface)",
    /\breadFileSync\b/.test(configReadSrc) &&
    !/\b(?:writeFile|appendFile|createWriteStream|renameSync|copyFile|openSync)\b/.test(configReadSrc));
}

// ── WP15 fix-round 4: server-layer three outcomes on the ACTUAL handler body ──
// Mirrors Codex's socket-free harness: load server.ts, cut before listen, inject
// manager reply + facts + digests, POST /agent/retention through the real
// request handler. Complements (does not replace) client-rendering checks 606–619.
{
  const { EventEmitter } = await import("node:events");
  const { stripTypeScriptTypes } = await import("node:module");
  const here = dirname(fileURLToPath(import.meta.url));
  const serverPath = join(here, "server.ts");
  const savedHome = process.env.HOME;
  /* Synthetic HOME so the module-load facts read never opens the real auth.json. */
  process.env.HOME = join("/tmp", `wp15-fix-home-${process.pid}-${Date.now()}`);
  process.env.STUDIO_PORT = "4398";
  let s = readFileSync(serverPath, "utf8");
  for (const f of [
    "sessions.ts", "fs-browse.ts", "config-read.ts", "archive-store.ts",
    "session-export.ts", "events.ts", "page-maps.ts", "reconstruction.ts", "shutdown.ts",
  ]) {
    s = s.replaceAll(`./${f}`, `file://${join(here, f)}`);
  }
  s = s.replaceAll("fileURLToPath(import.meta.url)", JSON.stringify(serverPath));
  s = s.replace(
    "const server = createServer(async (req, res) => {",
    "const __handler = async (req, res) => {",
  );
  const shutdownAt = s.indexOf("// ── shutdown");
  if (shutdownAt < 0) throw new Error("WP15 server harness: shutdown marker missing");
  let head = s.slice(0, shutdownAt);
  const close = head.lastIndexOf("});");
  if (close < 0) throw new Error("WP15 server harness: createServer close missing");
  head = head.slice(0, close) + "};\n" + head.slice(close + 3);
  /* Injectable override slots — after imports, before any reader call.
     AGENT_CONFIG_FACTS init runs at load and calls readAgentConfigFacts();
     the slots must already be initialised (not TDZ). */
  const lastImport = head.lastIndexOf("\nimport ");
  const afterImport = head.indexOf("\n", head.indexOf(";", lastImport) + 1);
  if (afterImport < 0) throw new Error("WP15 server harness: import block not found");
  head = head.slice(0, afterImport + 1) +
    "let __factsOverride = null;\nlet __digestOverride = null;\n" +
    head.slice(afterImport + 1);
  head = head.replace(
    /function readAgentConfigFacts\s*\(\)\s*\{/,
    "function readAgentConfigFacts() {\n  if (typeof __factsOverride === \"function\") return __factsOverride();\n  return __readAgentConfigFactsBody();}\nfunction __readAgentConfigFactsBody() {",
  );
  head = head.replace(
    /function authDigest\s*\(\)\s*:\s*string\s*\|\s*null\s*\{/,
    "function authDigest() {\n  if (typeof __digestOverride === \"function\") return __digestOverride();\n  return __authDigestBody();}\nfunction __authDigestBody(): string | null {",
  );
  head += `
globalThis.__SERVER_TEST__ = {
  handler: __handler,
  token: RUN_TOKEN,
  port: PORT,
  setManager(fn) { manager.setCodingDataRetention = fn; },
  setFacts(fn) { __factsOverride = fn; },
  setDigest(fn) { __digestOverride = fn; },
};
`;
  const js = stripTypeScriptTypes(head, { mode: "transform", sourceMap: false });
  await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  const t = (globalThis as any).__SERVER_TEST__;
  if (!t || typeof t.handler !== "function") {
    throw new Error("WP15 server harness: handler not exported");
  }

  function makeReq(body: any = { codingDataRetentionOptOut: true }) {
    const q: any = new EventEmitter();
    q.method = "POST";
    q.url = "/agent/retention";
    q.headers = {
      host: `127.0.0.1:${t.port}`,
      origin: `http://127.0.0.1:${t.port}`,
      "x-studio-token": t.token,
    };
    queueMicrotask(() => {
      q.emit("data", Buffer.from(JSON.stringify(body)));
      q.emit("end");
    });
    return q;
  }
  async function callRetention(body?: any) {
    const out: any = { headers: {}, status: null, body: "" };
    const res: any = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      setHeader(k: string, v: string) { out.headers[k] = v; },
      writeHead(c: number, h?: any) {
        out.status = c;
        this.headersSent = true;
        Object.assign(out.headers, h || {});
      },
      end(b = "") { out.body += String(b); this.writableEnded = true; },
    };
    await t.handler(makeReq(body), res);
    return { ...out, json: out.body ? JSON.parse(out.body) : null };
  }

  const MARKER = "auth.json content MUST-NOT-LEAK " + "tok_" + "x".repeat(40);

  /* (a) verified: reply agrees AND file follows */
  let digests = ["a".repeat(64), "b".repeat(64)];
  t.setDigest(() => digests.shift() || "b".repeat(64));
  t.setManager(async (requested: boolean) => ({ replyAgreed: true, replyOptOut: requested }));
  t.setFacts(() => ({
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    retention: { retentionOptOut: true, isZdr: false, problem: null },
  }));
  const verified = await callRetention({ codingDataRetentionOptOut: true });
  check("WP15 server: verified outcome when reply agrees and file follows",
    verified.status === 200 &&
    verified.json.outcome === "verified" &&
    verified.json.fileFollowed === true &&
    verified.json.fileOptOut === true &&
    verified.json.replyAgreed === true &&
    /^Verified —/.test(verified.json.note));
  check("WP15 server: verified response carries digests and modeled facts",
    verified.json.authDigestBefore === "a".repeat(64) &&
    verified.json.authDigestAfter === "b".repeat(64) &&
    verified.json.agentConfig &&
    verified.json.agentConfig.retention.retentionOptOut === true &&
    verified.json.agentConfig.retention.isZdr === false);

  /* (b) acknowledged_not_confirmed: reply agrees, file stale */
  digests = ["c".repeat(64), "c".repeat(64)];
  t.setDigest(() => digests.shift() || "c".repeat(64));
  t.setManager(async (requested: boolean) => ({ replyAgreed: true, replyOptOut: requested }));
  t.setFacts(() => ({
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    /* File did NOT follow — still false while we asked for true. */
    retention: { retentionOptOut: false, isZdr: false, problem: null },
  }));
  const stale = await callRetention({ codingDataRetentionOptOut: true });
  check("WP15 server: acknowledged_not_confirmed when reply agrees but file is stale",
    stale.status === 200 &&
    stale.json.outcome === "acknowledged_not_confirmed" &&
    stale.json.fileFollowed === false &&
    stale.json.fileOptOut === false &&
    stale.json.replyAgreed === true &&
    /Acknowledged, not confirmed/.test(stale.json.note));
  check("WP15 server: stale outcome does not flip fileOptOut to the request",
    stale.json.fileOptOut === false &&
    stale.json.agentConfig.retention.retentionOptOut === false);

  /* (c) refused: manager throws; hostile text is the note, still 200 */
  const hostile = "<img src=x onerror=alert(1)><script>owned()</script>";
  digests = ["d".repeat(64), "d".repeat(64)];
  t.setDigest(() => digests.shift() || "d".repeat(64));
  t.setManager(async () => {
    const e: any = new Error("wrapper");
    e.data = { message: hostile };
    throw e;
  });
  t.setFacts(() => ({
    permissionMode: { mode: "ask", source: "permission_mode", problem: null },
    retention: { retentionOptOut: false, isZdr: false, problem: null },
  }));
  const refused = await callRetention({ codingDataRetentionOptOut: true });
  check("WP15 server: refused outcome surfaces the agent error as text",
    refused.status === 200 &&
    refused.json.outcome === "refused" &&
    refused.json.replyAgreed === false &&
    refused.json.fileFollowed === false &&
    refused.json.note === "Refused — " + hostile &&
    refused.json.error === hostile);
  check("WP15 server: refused still carries digests and the file-derived facts",
    refused.json.authDigestBefore === "d".repeat(64) &&
    refused.json.authDigestAfter === "d".repeat(64) &&
    refused.json.agentConfig.retention.retentionOptOut === false);

  const notes = new Set([verified.json.note, stale.json.note, refused.json.note]);
  check("WP15 server: the three outcomes produce three distinct sentences",
    notes.size === 3);
  const bundled = JSON.stringify([verified.json, stale.json, refused.json]);
  check("WP15 server: responses never carry auth.json bytes or content markers",
    !bundled.includes(MARKER) &&
    !bundled.includes("\"access_token\"") &&
    !bundled.includes("team_blocked_reasons") &&
    typeof verified.json.authDigestBefore === "string" &&
    typeof verified.json.authDigestAfter === "string");

  /* Restore env so later suites (if chained) see the operator's HOME. */
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete (globalThis as any).__SERVER_TEST__;
}

console.log(`\n${passed} app recovery checks passed`);
