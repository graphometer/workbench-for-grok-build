// WP6: the answer path for the three blocking interactions, checked
// deterministically. No network, no agent, no dependencies:
//
//     node studio/interactions.check.ts
//
// What this pins, and why it exists at all: the reply envelopes are the one
// place a mistake can be WRONG BUT SILENT (the historical flat-envelope bug
// errored nowhere — PROJECT-STATE §5), so every one of them is asserted as an
// exact deep-equal against what answerInteraction actually writes to the
// agent. The question fixtures are REAL captures from the 2026-08-01 grok
// 0.2.118 probe (agent-staging/grok/2026-08-01/), pasted verbatim.

import { SessionManager } from "./sessions.ts";
import type { AppEvent } from "./events.ts";
import { readFileSync } from "node:fs";
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
const deepEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A manager that spawns nothing and records everything it would have sent. */
function rig() {
  const manager = new SessionManager(process.cwd());
  const responds: { id: any; result: any }[] = [];
  const errors: { id: any; code: number; message: string }[] = [];
  const emitted: AppEvent[] = [];
  (manager.acp as any).respond = (id: any, result: any) => responds.push({ id, result });
  (manager.acp as any).respondError = (id: any, code: number, message: string) =>
    errors.push({ id, code, message });
  (manager.acp as any).note = () => {};
  (manager.acp as any).loud = () => {};
  manager.on("app", (ev: AppEvent) => emitted.push(ev));
  // A live session for the gate to accept. The gate itself is under test too.
  (manager as any).sessions.set("s-live", { live: true, loading: null });
  const reverse = (id: number, method: string, params: any) =>
    (manager as any).onReverseRequest({ id, method, params });
  return { manager, responds, errors, emitted, reverse };
}

function refusal(fn: () => void): any {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// ── fixtures: real 0.2.118 captures (probe, 2026-08-01) ──────────────────

const PERMISSION_PARAMS = {
  sessionId: "s-live",
  toolCall: {
    toolCallId: "call-01cef08a-3c5e-4e5b-bf94-6300f5c3ea91-0",
    kind: "edit",
    title: "Write `probe-approve.txt`",
    rawInput: { variant: "Write", file_path: "probe-approve.txt", content: "approved-ok\n" },
    _meta: {
      "x.ai/tool": {
        version: 1, name: "write", kind: "write", namespace: "opencode",
        label: "Write", read_only: false, input: { path: "probe-approve.txt" },
      },
    },
  },
  options: [
    { optionId: "allow-edits-session", name: "Yes, allow all edits during this session", kind: "allow_always" },
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "reject-once", name: "No, and tell Grok what to do differently", kind: "reject_once" },
  ],
};

const PLAN_PARAMS = {
  sessionId: "s-live",
  toolCallId: "call-1ff9f519-ed9e-477c-8868-8c284382ff87-3",
  planContent: "# Plan: Create probe-plan.txt\n\n## Steps\n1. Write `probe-plan.txt`.\n",
};

const Q_MULTISELECT = {
  sessionId: "s-live",
  toolCallId: "call-585c609f-78b5-4b01-bbfb-9ca0f48fb51a-6",
  questions: [{
    question: "Which topics should the probe cover?",
    options: [
      { label: "Permissions (session/request_permission)", description: "session/request_permission" },
      { label: "Plans (exit_plan_mode)", description: "exit_plan_mode" },
      { label: "Questions (ask_user_question)", description: "ask_user_question" },
      { label: "Modes (set_mode)", description: "set_mode" },
    ],
    multiSelect: true,
  }],
  mode: "default",
};

const Q_TWO = {
  sessionId: "s-live",
  toolCallId: "call-6106702a-1bdd-4cb0-b1ea-571ed95a2bf8-7",
  questions: [
    {
      question: "Preferred log format?",
      options: [
        { label: "JSON", description: "JSON format" },
        { label: "Text", description: "Plain text format" },
        { label: "Both", description: "Both JSON and text" },
      ],
      multiSelect: false,
    },
    {
      question: "Include timings?",
      options: [
        { label: "Yes", description: "Include timings" },
        { label: "No", description: "Do not include timings" },
      ],
      multiSelect: false,
    },
  ],
  mode: "default",
};

const Q_PLAN_MODE = {
  sessionId: "s-live",
  toolCallId: "call-4de9e7e6-ccee-4b95-9579-6cfbc4b66e05-8",
  questions: [{
    question: "How detailed should the plan be?",
    options: [
      { label: "Brief (Recommended)", description: "Short plan with minimal steps" },
      { label: "Standard", description: "Normal level of detail" },
      { label: "Exhaustive", description: "Full detail with every step spelled out" },
    ],
    multiSelect: false,
  }],
  mode: "plan",
};

// ── the permission envelope: NESTED, exactly ─────────────────────────────
{
  const r = rig();
  r.reverse(1, "session/request_permission", PERMISSION_PARAMS);
  const key = r.emitted[0]?.data?.key;
  check("a permission request registers and emits its event",
    typeof key === "string" && r.emitted[0].type === "interaction.permission_requested");
  r.manager.answerInteraction(key, "allow-once", false);
  check("the permission reply is the NESTED envelope, exactly",
    deepEq(r.responds[0].result, { outcome: { outcome: "selected", optionId: "allow-once" } }));
  check("answering removes the interaction",
    r.manager.openInteractionEvents().length === 0);
}
{
  const r = rig();
  r.reverse(1, "session/request_permission", PERMISSION_PARAMS);
  const key = r.emitted[0].data.key;
  r.manager.answerInteraction(key, null, true);
  check("a cancelled permission is the NESTED cancelled envelope, exactly",
    deepEq(r.responds[0].result, { outcome: { outcome: "cancelled" } }));
}
{
  const r = rig();
  r.reverse(1, "session/request_permission", PERMISSION_PARAMS);
  const key = r.emitted[0].data.key;
  const err = refusal(() => r.manager.answerInteraction(key, "invented-option", false));
  check("an option the agent never offered is refused, with the offered list attached",
    err !== null && Array.isArray(err.offered) && err.offered.includes("allow-once"));
  const err2 = refusal(() =>
    r.manager.answerInteraction(key, "allow-once", false, { feedback: "note" }));
  check("feedback on a permission is refused as a caller error",
    err2 !== null && err2.badRequest === true);
  const err3 = refusal(() =>
    r.manager.answerInteraction(key, "allow-once", false, { outcome: "accepted" }));
  check("'outcome' on a permission is refused as a caller error",
    err3 !== null && err3.badRequest === true);
}

// ── the plan envelope: FLAT, exactly — and feedback only on cancelled ────
{
  const r = rig();
  r.reverse(2, "_x.ai/exit_plan_mode", PLAN_PARAMS);
  check("a plan exit registers with the protocol's three outcome values",
    deepEq(r.emitted[0].data.options.map((o: any) => o.optionId),
      ["approved", "cancelled", "abandoned"]));
  r.manager.answerInteraction(r.emitted[0].data.key, "approved", false);
  check("the plan reply is FLAT, exactly — {outcome:'approved'}, never {result:{…}}",
    deepEq(r.responds[0].result, { outcome: "approved" }));
}
{
  const r = rig();
  r.reverse(2, "_x.ai/exit_plan_mode", PLAN_PARAMS);
  const key = r.emitted[0].data.key;
  r.manager.answerInteraction(key, "cancelled", false, { feedback: "Split step 1 into two." });
  check("request-changes is FLAT cancelled + the typed feedback, exactly",
    deepEq(r.responds[0].result, { outcome: "cancelled", feedback: "Split step 1 into two." }));
  const answered = r.emitted.find((ev) => ev.type === "interaction.answered");
  check("the answered event carries the feedback so the sealed card can narrate it",
    answered !== undefined && answered.data.feedback === "Split step 1 into two.");
}
{
  const r = rig();
  r.reverse(2, "_x.ai/exit_plan_mode", PLAN_PARAMS);
  const key = r.emitted[0].data.key;
  const err = refusal(() =>
    r.manager.answerInteraction(key, "approved", false, { feedback: "note" }));
  check("feedback with 'approved' is refused — feedback is only valid on cancelled",
    err !== null && err.badRequest === true);
  const err2 = refusal(() =>
    r.manager.answerInteraction(key, "cancelled", false, { feedback: 42 }));
  check("non-string feedback is refused", err2 !== null && err2.badRequest === true);
  r.manager.answerInteraction(key, "cancelled", false, { feedback: "   " });
  check("whitespace feedback sends plain cancelled — the field is omitted entirely",
    deepEq(r.responds[0].result, { outcome: "cancelled" }));
}
{
  const r = rig();
  r.reverse(2, "_x.ai/exit_plan_mode", PLAN_PARAMS);
  r.manager.answerInteraction(r.emitted[0].data.key, null, true);
  check("a cancelled plan exit stays FLAT on the cancel path too",
    deepEq(r.responds[0].result, { outcome: "cancelled" }));
}

// ── the question branch: registration, gating, validation, envelope ──────
{
  const r = rig();
  r.reverse(3, "_x.ai/ask_user_question", Q_MULTISELECT);
  check("a question registers an OpenInteraction (no more -32601)",
    r.errors.length === 0 && r.manager.openInteractionEvents().length === 1 &&
      r.emitted[0].type === "interaction.question_asked" &&
      r.emitted[0].data.refusedWith === undefined);
  const key = r.emitted[0].data.key;
  r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: {
      "Which topics should the probe cover?": [
        "Permissions (session/request_permission)",
        "Plans (exit_plan_mode)",
      ],
    },
  });
  check("a multi-select accepted reply is FLAT with array-of-labels answers, exactly",
    deepEq(r.responds[0].result, {
      outcome: "accepted",
      answers: {
        "Which topics should the probe cover?": [
          "Permissions (session/request_permission)",
          "Plans (exit_plan_mode)",
        ],
      },
    }));
  const answered = r.emitted.find((ev) => ev.type === "interaction.answered");
  check("the answered event carries the answers for the sealed card",
    answered !== undefined && answered.data.outcome === "accepted" &&
      deepEq(Object.keys(answered.data.answers), ["Which topics should the probe cover?"]));
}
{
  const r = rig();
  r.reverse(3, "_x.ai/ask_user_question", Q_TWO);
  const key = r.emitted[0].data.key;
  const partial = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: { "Preferred log format?": ["JSON"] },
  }));
  check("a partial accepted is refused — our completeness rule, stated as ours",
    partial !== null && partial.badRequest === true);
  const wrongLabel = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: { "Preferred log format?": ["YAML"], "Include timings?": ["Yes"] },
  }));
  check("a label the agent never offered is refused, offered list attached",
    wrongLabel !== null && wrongLabel.badRequest === true &&
      Array.isArray(wrongLabel.offered) && wrongLabel.offered.includes("JSON"));
  const twoOnSingle = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: { "Preferred log format?": ["JSON", "Text"], "Include timings?": ["Yes"] },
  }));
  check("two labels on a single-select question are refused",
    twoOnSingle !== null && twoOnSingle.badRequest === true);
  const bareString = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: { "Preferred log format?": "JSON", "Include timings?": ["Yes"] },
  }));
  check("a bare-string answer is refused — we send the canonical arrays only",
    bareString !== null && bareString.badRequest === true);
  const unknownQ = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: {
      "Preferred log format?": ["JSON"], "Include timings?": ["Yes"],
      "A question nobody asked?": ["JSON"],
    },
  }));
  check("an answer to a question the agent never asked is refused",
    unknownQ !== null && unknownQ.badRequest === true);
  r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: { "Preferred log format?": ["JSON"], "Include timings?": ["No"] },
  });
  check("a complete two-question accepted goes out flat, both answers as one-element arrays",
    deepEq(r.responds[0].result, {
      outcome: "accepted",
      answers: { "Preferred log format?": ["JSON"], "Include timings?": ["No"] },
    }));
}
{
  const r = rig();
  r.reverse(3, "_x.ai/ask_user_question", Q_MULTISELECT);
  const key = r.emitted[0].data.key;
  const bogus = refusal(() =>
    r.manager.answerInteraction(key, null, false, { outcome: "maybe" }));
  check("an outcome outside the whitelist is refused, whitelist attached",
    bogus !== null && bogus.badRequest === true && Array.isArray(bogus.offered));
  const gated = refusal(() =>
    r.manager.answerInteraction(key, null, false, { outcome: "chat_about_this" }));
  check("chat_about_this outside plan mode is refused — the mode gate holds",
    gated !== null && gated.badRequest === true);
  const gated2 = refusal(() =>
    r.manager.answerInteraction(key, null, false, { outcome: "skip_interview" }));
  check("skip_interview outside plan mode is refused too",
    gated2 !== null && gated2.badRequest === true);
  const answersOnCancel = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "cancelled",
    answers: { "Which topics should the probe cover?": ["Modes (set_mode)"] },
  }));
  check("answers with a non-accepted outcome are refused",
    answersOnCancel !== null && answersOnCancel.badRequest === true);
  r.manager.answerInteraction(key, null, false, { outcome: "cancelled" });
  check("a cancelled question reply is FLAT — never the permission's nested shape",
    deepEq(r.responds[0].result, { outcome: "cancelled" }));
}
{
  const r = rig();
  r.reverse(3, "_x.ai/ask_user_question", Q_PLAN_MODE);
  const key = r.emitted[0].data.key;
  r.manager.answerInteraction(key, null, false, { outcome: "chat_about_this" });
  check("chat_about_this IS accepted when the request's mode is plan, flat",
    deepEq(r.responds[0].result, { outcome: "chat_about_this" }));
}
{
  const r = rig();
  r.reverse(3, "_x.ai/ask_user_question", Q_PLAN_MODE);
  const key = r.emitted[0].data.key;
  r.manager.answerInteraction(key, null, true);
  check("cancel:true on a question maps to the FLAT cancelled question reply",
    deepEq(r.responds[0].result, { outcome: "cancelled" }));
}

// ── registration refusals: loud, and VISIBLE on the stream ───────────────
{
  const r = rig();
  r.reverse(4, "_x.ai/ask_user_question", { sessionId: "s-live", questions: [], mode: "default" });
  check("empty questions are refused -32602 and the refusal emits its event",
    r.errors[0]?.code === -32602 &&
      r.emitted[0]?.type === "interaction.question_asked" &&
      r.emitted[0].data.refusedWith === -32602 &&
      r.manager.openInteractionEvents().length === 0);
}
{
  const r = rig();
  r.reverse(4, "_x.ai/ask_user_question", {
    sessionId: "s-live",
    questions: [{ question: "Pick one", options: [], multiSelect: false }],
    mode: "default",
  });
  check("a question with no options is refused — never invent an answer",
    r.errors[0]?.code === -32602 && r.emitted[0].data.refusedWith === -32602);
}
{
  const r = rig();
  r.reverse(4, "_x.ai/ask_user_question", {
    sessionId: "s-live",
    questions: [
      { question: "Same text", options: [{ label: "A" }], multiSelect: false },
      { question: "Same text", options: [{ label: "B" }], multiSelect: false },
    ],
    mode: "default",
  });
  check("duplicate question texts are refused — keyed replies would be ambiguous",
    r.errors[0]?.code === -32602 && r.manager.openInteractionEvents().length === 0);
}
{
  const r = rig();
  r.reverse(4, "_x.ai/ask_user_question", { ...Q_MULTISELECT, sessionId: "nobody-holds-this" });
  check("the session gate covers the question method — unknown session refused -32602",
    r.errors[0]?.code === -32602 && r.emitted[0].data.refusedWith === -32602 &&
      r.manager.openInteractionEvents().length === 0);
}
{
  const r = rig();
  r.reverse(5, "session/request_permission", { ...PERMISSION_PARAMS, options: [] });
  check("the empty-options permission refusal now emits its event too",
    r.errors[0]?.code === -32602 &&
      r.emitted[0]?.type === "interaction.permission_requested" &&
      r.emitted[0].data.refusedWith === -32602);
}
{
  const r = rig();
  const err = refusal(() => r.manager.answerInteraction("interaction-999", "x", false));
  check("answering a key that is not open still throws the caller error",
    err !== null && /no open interaction/.test(String(err.message)));
}

// ── hostile question text: prototype-shaped keys must SURVIVE, not vanish ──
// The verification panel's find. Question text is agent-controlled (rule 10)
// and answers go back keyed by it; on a plain object literal
// `validated["__proto__"] = […]` writes through Object.prototype's setter and
// stores nothing, so the agent would be told "accepted" with an empty answers
// map — wrong, silent, and reached from a prompt-injected repository.
for (const hostile of ["__proto__", "constructor", "prototype", "toString"]) {
  const r = rig();
  const params = {
    sessionId: "s-live",
    questions: [{
      question: hostile,
      options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
      multiSelect: false,
    }],
    mode: "default",
  };
  r.reverse(9, "_x.ai/ask_user_question", params);
  const key = r.emitted[0].data.key;
  // Exactly the body the click-to-answer card posts, through a JSON round trip.
  const body = JSON.parse(JSON.stringify({ outcome: "accepted", answers: { [hostile]: ["Yes"] } }));
  r.manager.answerInteraction(key, null, false, body);
  const sent = JSON.parse(JSON.stringify(r.responds[0].result));
  check(`a question named '${hostile}' answers with the human's real choice, not an empty map`,
    sent.outcome === "accepted" && deepEq(sent.answers, { [hostile]: ["Yes"] }));
  const answered = r.emitted.find((ev) => ev.type === "interaction.answered");
  check(`the answered event for '${hostile}' carries the answer too, so the seal cannot lie`,
    answered !== undefined &&
      deepEq(JSON.parse(JSON.stringify(answered.data.answers)), { [hostile]: ["Yes"] }));
}
{
  // The same key shape must still be refused when it was never offered.
  const r = rig();
  r.reverse(9, "_x.ai/ask_user_question", Q_MULTISELECT);
  const key = r.emitted[0].data.key;
  const err = refusal(() => r.manager.answerInteraction(key, null, false, {
    outcome: "accepted",
    answers: JSON.parse('{"__proto__":["x"],"Which topics should the probe cover?":["Modes (set_mode)"]}'),
  }));
  check("a prototype-shaped key the agent never asked is still refused",
    err !== null && err.badRequest === true);
}

// ── D83: the permission card's prominence is keyed off the wire kind ──────
// The rendered behaviour is pinned in app-recovery.check.ts (the fake-DOM
// case asserting primary/ghost/neither per kind, verbatim labels, agent's
// order). Here the mapping itself is source-pinned, so a silent edit to
// either side of the contract fails a suite.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  const body = appSrc.slice(
    appSrc.indexOf("function renderPermissionBody"),
    appSrc.indexOf("function renderPlanBody"),
  );
  check("D83: allow_once maps to the primary variant, keyed off the wire kind",
    body.includes(`opt.kind === "allow_once") btn.dataset.variant = "primary"`));
  check("D83: allow_always maps to the ghost variant",
    body.includes(`opt.kind === "allow_always") btn.dataset.variant = "ghost"`));
  check("D83: labels stay verbatim and the agent's order is untouched (no sort/reverse in the card body)",
    body.includes(`el("button", "btn", esc(opt && opt.name))`) &&
      !body.includes(".sort(") && !body.includes(".reverse("));
  const css = readFileSync(join(HERE, "public", "app.css"), "utf8");
  check("D83: the primary variant is defined (accent border + ink) and sized on the card",
    css.includes(".btn[data-variant=\"primary\"] { border-color: var(--accent); color: var(--accent); }") &&
      css.includes(".icard-action .btn[data-variant=\"primary\"]"));
  check("D83: the primary rule sits BEFORE :disabled, so the D45 disabled treatment wins",
    css.indexOf(".btn[data-variant=\"primary\"] {") < css.indexOf(".btn:disabled"));
}

// ── D84: the two background kinds quiet to one calm line ─────────────────
// The rendered behaviour is pinned in app-recovery.check.ts (compression,
// counts, loud exclusion, badge, payload reachability). Here the contract's
// load-bearing lines are source-pinned so a silent edit fails a suite.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  check("D84: the quiet set is exactly the two known background kinds",
    appSrc.includes('const QUIET_BACKGROUND = new Set(["queue.changed", "turn.prompt_complete"])'));
  check("D84: a loud row is never quieted (the predicate excludes b.loud)",
    appSrc.includes("!b.loud && QUIET_BACKGROUND.has(b.type)"));
  check("D84: the strip badge counts only non-quiet unhandled events",
    appSrc.includes("unhandledWide.filter((i) => !isQuietUnhandled(i))"));
  check("D84: genuinely unknown kinds keep the UNHANDLED EVENT / WIRE PROBLEM flags unchanged",
    appSrc.includes('b.loud ? "WIRE PROBLEM" : "UNHANDLED EVENT"'));
}

// ── WP12: hardening source invariants ─────────────────────────────────────
// Behaviour is pinned in app-recovery.check.ts (fake DOM) and events.check.ts
// (the wire model). These pin the contract lines so a silent edit fails here.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  const evSrc = readFileSync(join(HERE, "events.ts"), "utf8");
  check("WP12: the strip has a respawning state distinct from gone",
    appSrc.includes('respawning: { text: "Restarting agent…"') &&
      appSrc.includes('if (agent.state === "respawning") return { key: "respawning"'));
  check("WP12: the decorative Reconnect button is removed in the gone/respawning banner",
    appSrc.includes('rb.hidden = agent.state !== "failed" || forcedState === "gone"'));
  check("WP12: bridge.respawned writes durable per-session markers and the resolution line",
    appSrc.includes('"Back — this session was reloaded from disk after the agent restarted."') &&
      appSrc.includes('"Back — " + reloaded.length + " of " + total + " sessions reloaded."'));
  check("WP12: settings.updated is modelled in events.ts (never an unhandled card)",
    evSrc.includes('spec.type === "settings.updated"') && appSrc.includes('case "settings.updated"'));
  check("WP12: bare-false leaves the gate alone and true clears it",
    appSrc.includes("if (d.allowAccess === true) { gateNotice = null; return; }"));
  check("WP12: post() supplies copy-details automatically on failure",
    appSrc.includes('j.details = path + " — HTTP " + r.status'));
  check("WP12: the Copy details click is clipboard-guarded and text-only",
    appSrc.includes('typeof navigator.clipboard.writeText !== "function"') &&
      /* WP14: the button is the shared copyDetailsButton() helper now, so the
         payload arrives as its `details` parameter, not `x.details`. */
      appSrc.includes("navigator.clipboard.writeText(details)"));
  check("WP12: the zero-item-turn sentence renders only for a CLOSED turn",
    appSrc.includes('t.items.length === 0 && t.outcome !== "running"'));
  check("WP12: the WORDS table tells the truth about the shipped changes-pane copy",
    appSrc.includes('"No unreviewed changes."') && !appSrc.includes('"No file changes in this turn."'));
  const cssSrc = readFileSync(join(HERE, "public", "app.css"), "utf8");
  check("WP12-F1: the global [hidden] guard beats component display rules (the Reconnect-button bug)",
    /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(cssSrc));
}

// ── WP12 review round 1: the fix-round mechanisms ─────────────────────────
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  const sessSrc = readFileSync(join(HERE, "sessions.ts"), "utf8");
  check("F2: death mid-turn marks the record trackerSuspect; only a non-empty reading clears it",
    sessSrc.includes("rec.trackerSuspect = true") &&
      sessSrc.includes("rec.trackerSuspect && reading.filesOk && reading.files.length > 0"));
  check("F2: the git/status cross-check fires only for suspect + positively-empty readings",
    sessSrc.includes("rec.trackerSuspect && reading.filesOk && reading.files.length === 0"));
  check("F2: git/status has an EXT_ENVELOPE row and a camelCase params comment",
    sessSrc.includes('"_x.ai/git/status": true'));
  check("F2: the page never prints the bare clean sentence for suspect + not-clean",
    appSrc.includes("may not be tracked for this recovered session"));
  check("Codex I3: recovery outcomes ride the record, generation-keyed, and dedupe page-side",
    sessSrc.includes("rec.recovery = { generation,") &&
      appSrc.includes("i.recoveryGen === recovery.generation"));
  check("Opus I2: the failed marker yields to an already-landed RECOVERY FAILED notice",
    appSrc.includes('i.label === "RECOVERY FAILED"'));
  check("Opus M4: markers never materialise a ghost view",
    appSrc.includes("if (!sess.has(sessionId)) return;"));
  check("Opus I1: the gate state is held server-side and rides the snapshot",
    sessSrc.includes("gate: this.gateState") && appSrc.includes("applySnapshotSidecars"));
  check("Codex 5: the clipboard call is try/catch + Promise.resolve normalised",
    /* WP14: same call, inside the shared copyDetailsButton() helper. */
    appSrc.includes("Promise.resolve(navigator.clipboard.writeText(details))"));
  check("Codex 6 / Opus M1: the scheme check is case-insensitive and a refused link is said",
    appSrc.includes('/^https?:\\/\\//i.test(rawUrl)') && appSrc.includes("linkRefused"));
  check("Codex I4: the quiet callers forward details (spot-pinned on three families)",
    appSrc.includes('"Not restarted — " + ((r && r.error) || "no answer from the server") + ". Try again.", r && r.details') &&
      appSrc.includes('"Not archived — " + res.error + ". Try again.", res.details') &&
      appSrc.includes("r && r.details);"));
}

// ── WP12 review round 2 ───────────────────────────────────────────────────
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  const sessSrc = readFileSync(join(HERE, "sessions.ts"), "utf8");
  check("round-2 B1: a successful load invalidates the recovery outcome (server-side)",
    sessSrc.includes("rec.recovery = null;"));
  check("round-2 B2: the cross-check is scoped to the session's cwd, root compared",
    sessSrc.includes("relative(root,") && sessSrc.includes(".startsWith(prefix)"));
  check("round-2 B3: the changes() comment no longer promises later-turn wedge detection",
    sessSrc.includes("never re-arms"));
  check("round-2 Codex: gate semantics are applied server-side before snapshotting",
    sessSrc.includes("this.gateState = null;") && sessSrc.includes("this.gateState = ev.data;"));
  check("round-2 Opus M1: an identical gate re-application keeps the armed confirm",
    appSrc.includes("armed: same ? gateNotice.armed : false"));
  check("round-2 Opus M2: truncation is said, and cuts are code-point safe",
    appSrc.includes("truncated — the full text was longer") && appSrc.includes("Array.from(d.gateMessage)"));
  check("round-2 Opus M4: a failed permission answer leaves a Shell-log line with details",
    appSrc.includes('note("error", b.error, r.details);'));
}

// ── WP12 confirm round (round 3) ──────────────────────────────────────────
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const appSrc = readFileSync(join(HERE, "public", "app.js"), "utf8");
  const sessSrc = readFileSync(join(HERE, "sessions.ts"), "utf8");
  check("round-3: the server broadcasts the RESOLVED gate state on change only",
    sessSrc.includes('this.bridge("bridge.gate_state", { gate: null })') &&
      sessSrc.includes('this.bridge("bridge.gate_state", { gate: this.gateState })'));
  check("round-3: the page never applies a raw settings.updated payload",
    !/case "settings\.updated":[\s\S]{0,400}applyGateNotice/.test(appSrc));
  check("round-3: a snapshot with no gate CLEARS the banner (NEW-2)",
    appSrc.includes("applyResolvedGate(agent.gate ?? null)"));
  check("round-3: bridge.respawned carries its generation (NEW-4)",
    sessSrc.includes("agentGeneration: generation }") &&
      appSrc.includes("typeof d.agentGeneration === \"number\" ? d.agentGeneration : currentAgentGen"));
  check("round-3: the cross-check compares the CANONICAL cwd (C2/NEW-3)",
    sessSrc.includes("relative(root, this.canonCwd(rec))"));
  check("round-3: a collapsed untracked directory counts as an ancestor (NEW-1)",
    sessSrc.includes('rel.startsWith(d + "/")'));
  check("round-3: the cross-check louds once per cause (NEW-8)",
    sessSrc.includes("crossCheckLouded"));
  check("round-3: tier truncation sets the said flag (C3)",
    appSrc.includes("truncatedMsg || truncatedLabel || truncatedTier"));
  check("round-4 I1: the confirm shows the FULL url — no display truncation anywhere",
    !appSrc.includes("urlChars"));
  check("round-4 R1/M3: the gate revision guard — live applications bump it, stale sweeps skip",
    appSrc.includes("gateRevision++") && appSrc.includes("gateRevAtStart === gateRevision"));
  check("round-4 M1: the missing-field note is latched once per event type",
    appSrc.includes("missingNoted.has(ev.type)"));
  check("round-4 M5: the Shell inspector can force the respawning banner",
    appSrc.includes('forcedState === "respawning"'));
  check("round-4 Codex I1: the respawn generation is captured before the awaits",
    sessSrc.includes("const generation = this.agentGeneration") &&
      sessSrc.includes("agentGeneration: generation }"));
  check("round-4 Codex M1: the gate SET branch is change-guarded",
    sessSrc.includes("JSON.stringify(this.gateState) === JSON.stringify(ev.data)"));
  check("round-4 Codex M2: the loud latch is a per-cause Set",
    sessSrc.includes("rec.crossCheckLouded.has(cause)"));
  check("round-4 Codex M3: malformed git path shapes count in-scope",
    sessSrc.includes('norm === "" || norm === "."'));
}

console.log(`\n${passed} interaction checks passed`);
