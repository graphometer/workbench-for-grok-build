// A self-contained check on the translation boundary. No dependencies, no
// framework, no build step:
//
//     node studio/events.check.ts
//
// Every fixture below is a REAL payload captured from `grok 0.2.114` on
// 2026-07-29, pasted verbatim. Nothing here was typed from the documentation —
// that is the point. The full capture set (1,839 notifications across six probe
// runs) was replayed through the same code with the same result; these are the
// distinct shapes from it, small enough to live in the repository.
//
// Exits non-zero on any failure, so it is usable as a gate.

import {
  toAppEvent,
  notificationToAppEvent,
  bridgeEvent,
  kindCoverage,
  knownAppEventTypes,
  reverseRequestToAppEvent,
} from "./events.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

// ── real captures ───────────────────────────────────────────────────────

const THOUGHT = { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "The" } };

const TOOL_CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "call-37670a6b-e0fe-42e6-8087-feba7ea37235-0",
  title: "read_file",
  rawInput: { target_file: "greet.py" },
  _meta: {
    "x.ai/tool": {
      version: 1,
      name: "read_file",
      kind: "read",
      namespace: "grok_build",
      label: "Read",
      read_only: true,
    },
  },
};

const TOOL_CALL_WRITE = {
  sessionUpdate: "tool_call",
  toolCallId: "call-73639ac9-25f2-4549-b07c-ee91fe0ce6d6-3",
  title: "Write `greet.py`",
  rawInput: { variant: "Write", file_path: "/tmp/ws/greet.py", content: "…" },
  _meta: {
    "x.ai/tool": {
      version: 1,
      name: "write",
      kind: "write",
      namespace: "opencode",
      label: "Write",
      read_only: false,
      input: { path: "/tmp/ws/greet.py" },
    },
  },
};

/** The terminal update: no descriptor, no title, only the id, status and content. */
const TOOL_CALL_UPDATE_TERMINAL = {
  sessionUpdate: "tool_call_update",
  toolCallId: "call-37670a6b-e0fe-42e6-8087-feba7ea37235-0",
  status: "completed",
  content: [{ type: "content", content: { type: "text", text: "1→#!/usr/bin/env python3\n" } }],
};

const DELTA = {
  sessionUpdate: "tool_call_delta_chunk",
  tool_call_id: "call-37670a6b-e0fe-42e6-8087-feba7ea37235-0",
  tool_index: 0,
  name: "read_file",
};

const PENDING = {
  sessionUpdate: "pending_interaction",
  tool_call_id: "call-d012203b-b76c-4fd7-a8ed-401647a34233-0",
  kind: "permission",
};

const RESOLVED = {
  sessionUpdate: "interaction_resolved",
  tool_call_id: "call-d012203b-b76c-4fd7-a8ed-401647a34233-0",
};

const TURN_COMPLETED = {
  sessionUpdate: "turn_completed",
  prompt_id: "36b9f537-e119-4b80-8b75-0aa0ded056da",
  stop_reason: "end_turn",
  usage: {
    inputTokens: 42050,
    outputTokens: 1055,
    totalTokens: 43105,
    cachedReadTokens: 38528,
    reasoningTokens: 172,
    modelCalls: 3,
    apiDurationMs: 12842,
    costUsdTicks: 249324000,
    modelUsage: {
      "grok-4.5-build": {
        inputTokens: 42050,
        outputTokens: 1055,
        totalTokens: 43105,
        cachedReadTokens: 38528,
        reasoningTokens: 172,
        modelCalls: 3,
        apiDurationMs: 12842,
        costUsdTicks: 249324000,
      },
    },
    numTurns: 3,
  },
};

const MODE = { sessionUpdate: "current_mode_update", currentModeId: "plan" };
const TITLED = { sessionUpdate: "session_summary_generated", session_summary: "Add --upper flag" };
const MODEL = { sessionUpdate: "model_changed", model_id: "grok-4.5", reasoning_effort: "high" };

/** Real shape from grok 0.2.117 multi-run capture 2026-07-30. Signature value redacted. */
const RESPONSE_COMPLETED = {
  sessionUpdate: "response_completed",
  usage: {
    input_tokens: 2877,
    output_tokens: 32,
    cache_read_input_tokens: 11264,
    cache_creation_input_tokens: 0,
    reasoning_tokens: 26,
  },
  signature: "REDACTED_OPAQUE_SIGNATURE_VALUE_NOT_FOR_DISPLAY",
};

/** Real shape from grok 0.2.117 multi-run capture 2026-07-30. */
const SESSION_INFO_UPDATE = {
  sessionUpdate: "session_info_update",
  title: "User Requests Exact One Word PONG Reply",
};
const COMMANDS = {
  sessionUpdate: "available_commands_update",
  availableCommands: [
    { name: "compact", description: "Compress conversation history to save context window", input: { hint: "optional context about what to preserve" } },
  ],
  _meta: { tools: ["read_file", "write", "bash"] },
};

console.log("\ntranslating real captures");

const thought = toAppEvent(THOUGHT);
check("thinking chunk -> message.thinking", thought.type === "message.thinking");
check("thinking chunk text extracted", thought.data.text === "The");
check("raw preserved", thought.raw === THOUGHT);
check("no missing fields", !thought.missing);

const read = toAppEvent(TOOL_CALL);
check("read tool -> tool.started", read.type === "tool.started");
check("read tool readOnly === true", (read.data.tool as any).readOnly === true);
check("read tool label is the agent's own", (read.data.tool as any).label === "Read");
check(
  "status ABSENT on the first tool_call normalises to null, not a value",
  read.data.status === null,
);

const write = toAppEvent(TOOL_CALL_WRITE);
check("write tool readOnly === false", (write.data.tool as any).readOnly === false);

const terminal = toAppEvent(TOOL_CALL_UPDATE_TERMINAL);
check("terminal update -> tool.updated", terminal.type === "tool.updated");
check("terminal update carries status", terminal.data.status === "completed");
check(
  "terminal update has NO descriptor, so readOnly is unknowable — tool must be null, never a default",
  terminal.data.tool === null,
);

const delta = toAppEvent(DELTA);
check("snake_case tool_call_id read", delta.data.toolCallId === DELTA.tool_call_id);
check("snake_case tool_index read", delta.data.toolIndex === 0);
check("no missing fields on a snake_case variant", !delta.missing);

const pending = toAppEvent(PENDING);
check("pending_interaction -> interaction.pending", pending.type === "interaction.pending");
check("pending carries its kind", pending.data.interactionKind === "permission");
check("pending is flagged advisory", pending.data.advisoryOnly === true);
check("interaction_resolved -> interaction.resolved", toAppEvent(RESOLVED).type === "interaction.resolved");

const turn = toAppEvent(TURN_COMPLETED);
check("turn_completed -> turn.completed", turn.type === "turn.completed");
check("stop_reason read", turn.data.stopReason === "end_turn");
check("prompt_id read", turn.data.promptId === TURN_COMPLETED.prompt_id);
const usage = turn.data.usage as any;
check("costUsdTicks preserved exactly", usage.costUsdTicks === 249324000);
check("costUsd = ticks / 1e10", Math.abs(usage.costUsd - 0.0249324) < 1e-12, String(usage.costUsd));
check("per-model cost divided too", Math.abs(usage.modelUsage["grok-4.5-build"].costUsd - 0.0249324) < 1e-12);
check("usageIsIncomplete defaults to false, not undefined", usage.usageIsIncomplete === false);

// "unreported" must never render as "free".
const noCost = toAppEvent({ ...TURN_COMPLETED, usage: { ...TURN_COMPLETED.usage, costUsdTicks: undefined } });
check(
  "absent cost -> null, NOT 0",
  (noCost.data.usage as any).costUsd === null && (noCost.data.usage as any).costUsdTicks === null,
);

check("current_mode_update -> mode.changed", toAppEvent(MODE).data.modeId === "plan");
check("session_summary_generated -> title", toAppEvent(TITLED).data.title === "Add --upper flag");
check("model_changed snake_case read", toAppEvent(MODEL).data.modelId === "grok-4.5");

console.log("\n0.2.117 additive kinds (multi-run live shapes)");
const rc = toAppEvent(RESPONSE_COMPLETED);
check("response_completed -> response.completed", rc.type === "response.completed");
check("response_completed modelled", rc.modelled === true);
check("response_completed wireKind preserved", rc.wireKind === "response_completed");
check("response_completed default rail xai", rc.rail === "xai");
check("response_completed advisoryOnly", rc.data.advisoryOnly === true);
const rcUsage = rc.data.usage as any;
check("response_completed snake usage inputTokens", rcUsage.inputTokens === 2877);
check("response_completed snake usage outputTokens", rcUsage.outputTokens === 32);
check("response_completed snake usage cacheReadInputTokens", rcUsage.cacheReadInputTokens === 11264);
check("response_completed snake usage cacheCreationInputTokens", rcUsage.cacheCreationInputTokens === 0);
check("response_completed snake usage reasoningTokens", rcUsage.reasoningTokens === 26);
check("response_completed has no costUsd field", !("costUsd" in rcUsage) && !("costUsdTicks" in rcUsage));
check("response_completed signature NOT in normalised data", !("signature" in rc.data));
check("response_completed raw envelope still holds signature", (rc.raw as any).signature === RESPONSE_COMPLETED.signature);
check(
  "response_completed cannot close a turn (type is not turn.completed/finished/failed)",
  rc.type !== "turn.completed" && rc.type !== "turn.finished" && rc.type !== "turn.failed",
);
const rcExt = notificationToAppEvent("_x.ai/session_notification", {
  sessionId: "s1",
  update: RESPONSE_COMPLETED,
});
check("response_completed on xai notification rail", rcExt.rail === "xai" && rcExt.type === "response.completed");

const siu = toAppEvent(SESSION_INFO_UPDATE);
check("session_info_update -> session.info_updated", siu.type === "session.info_updated");
check("session_info_update modelled", siu.modelled === true);
check("session_info_update wireKind preserved", siu.wireKind === "session_info_update");
check("session_info_update default rail acp", siu.rail === "acp");
check("session_info_update title normalised", siu.data.title === SESSION_INFO_UPDATE.title);
check("session_info_update advisoryOnly", siu.data.advisoryOnly === true);
check(
  "session_info_update is not session.titled (no independent retitle path)",
  siu.type !== "session.titled",
);
const siuAcp = notificationToAppEvent("session/update", {
  sessionId: "s1",
  update: SESSION_INFO_UPDATE,
});
check("session_info_update on acp rail", siuAcp.rail === "acp" && siuAcp.type === "session.info_updated");
check("session_info_update raw envelope untouched", (siu.raw as any).title === SESSION_INFO_UPDATE.title);

// ── WP9: the 1.0.0 captures (docs/evidence/wp9) ──────────────────────────
/** Real shape, captured live twice on grok 1.0.0, 2026-08-08 (manual compact). */
const AUTO_COMPACT_COMPLETED = {
  sessionUpdate: "auto_compact_completed",
  tokens_before: 14298,
  tokens_after: 14171,
  summary_preview: null,
};
const acc = toAppEvent(AUTO_COMPACT_COMPLETED);
check("auto_compact_completed -> context.compact_completed", acc.type === "context.compact_completed");
check("auto_compact_completed modelled (captured payload)", acc.modelled === true);
check("snake_case tokens_before read", acc.data.tokensBefore === 14298);
check("snake_case tokens_after read", acc.data.tokensAfter === 14171);
check("summary_preview null stays null (not a miss)", acc.data.summaryPreview === null && !acc.missing);
const accSparse = toAppEvent({ sessionUpdate: "auto_compact_completed", tokens_after: 13952 });
check(
  "tokens_before is optional upstream — absent normalises to null with no wire-format alarm",
  accSparse.data.tokensBefore === null && accSparse.data.tokensAfter === 13952 && !accSparse.missing,
);

/** Real shape, captured live on grok 1.0.0, 2026-08-08. */
const LAST_TURN_SUMMARY = {
  sessionUpdate: "last_turn_summary",
  summary: "fig",
  prompt_id: "8eb6341c-ef05-48a2-b546-408e8847c277",
};
const lts = toAppEvent(LAST_TURN_SUMMARY);
check("last_turn_summary -> turn.summary", lts.type === "turn.summary");
check("last_turn_summary modelled", lts.modelled === true);
check("last_turn_summary summary + snake_case prompt_id read",
  lts.data.summary === "fig" && lts.data.promptId === LAST_TURN_SUMMARY.prompt_id);
check("last_turn_summary flagged advisory", lts.data.advisoryOnly === true);

/* `_meta.totalTokens` was measured on the raw 1.0.0 wire for WP9 and found
   NOT to be a live context-used counter (constant across a turn's chunks,
   jumping only when a response completes; a post-load session/info reading
   likewise understates until the first turn completes). It is deliberately
   NOT lifted onto AppEvents — see the note in events.ts. */
const withoutUsed = notificationToAppEvent("session/update", {
  sessionId: "s1", update: THOUGHT, _meta: { totalTokens: 3129 },
});
check("_meta.totalTokens stays off the event (measured: not a context-used counter)",
  !("contextUsedTokens" in withoutUsed));

const cmds = toAppEvent(COMMANDS);
check("available commands counted", cmds.data.count === 1);
check("tool names lifted from _meta", Array.isArray(cmds.data.toolNames));

// WP7 §2. The three malformed shapes Grok's audit named, plus the valid empty
// one they must stay distinguishable from. `[]`/`0` is a real reading; `null`
// is "we could not read it" — collapsing the second into the first is what put
// a confident "this agent has no commands" one step from the launcher.
const emptyCmds = toAppEvent({ sessionUpdate: "available_commands_update", availableCommands: [] });
check("a VALID empty command array stays empty, with a real count of 0",
  Array.isArray(emptyCmds.data.commands) && (emptyCmds.data.commands as unknown[]).length === 0 &&
    emptyCmds.data.count === 0);
for (const [label, bad] of [
  ["missing", { sessionUpdate: "available_commands_update" }],
  ["null", { sessionUpdate: "available_commands_update", availableCommands: null }],
  ["an object", { sessionUpdate: "available_commands_update", availableCommands: {} }],
  ["a string", { sessionUpdate: "available_commands_update", availableCommands: "compact" }],
  ["a nameless row", { sessionUpdate: "available_commands_update", availableCommands: [{}] }],
  ["a whitespace-only name", { sessionUpdate: "available_commands_update", availableCommands: [{ name: "   " }] }],
] as [string, any][]) {
  const ev = toAppEvent(bad);
  check(`available_commands_update with ${label} commands is UNREADABLE, not zero`,
    ev.data.commands === null && ev.data.count === null);
  check(`available_commands_update with ${label} commands is still delivered`,
    ev.type === "commands.updated");
}

console.log("\nfields that go missing are said out loud");
const renamed = { sessionUpdate: "turn_completed", stopReason: "end_turn" }; // prompt_id gone
const flagged = toAppEvent(renamed);
check("a vanished field lands in `missing`", Array.isArray(flagged.missing) && flagged.missing.includes("prompt_id"));
check("and produces a note", typeof flagged.note === "string" && flagged.note.length > 0);
check("but the event is still delivered", flagged.type === "turn.completed");

console.log("\nnothing is dropped, however bad the input");
for (const bad of [null, 42, "s", true, [1, 2]]) {
  const ev = toAppEvent(bad);
  check(
    `${JSON.stringify(bad)} -> wire.malformed with raw kept`,
    ev.type === "wire.malformed" && JSON.stringify(ev.raw) === JSON.stringify(bad),
  );
}
const unlabelled = toAppEvent({ someField: 1 });
check("no discriminator -> wire.unlabelled", unlabelled.type === "wire.unlabelled");
check("...raw kept", (unlabelled.raw as any).someField === 1);

const future = toAppEvent({ sessionUpdate: "a_kind_from_a_future_release", payload: { a: 1 } });
check("an unseen kind -> wire.unknown_kind", future.type === "wire.unknown_kind");
check("...with its wireKind named", future.wireKind === "a_kind_from_a_future_release");
check("...and its whole payload attached", (future.raw as any).payload.a === 1);
check("...and a note a human can act on", typeof future.note === "string");

const knownUnseen = toAppEvent({ sessionUpdate: "subagent_spawned", subagent_id: "x" });
check("a known-but-uncaptured kind gets its name", knownUnseen.type === "subagent.spawned");
check("...is marked unmodelled rather than guessed at", knownUnseen.modelled === false);
check("...and keeps the payload", (knownUnseen.raw as any).subagent_id === "x");

console.log("\nenvelope and rails");
const live = notificationToAppEvent("session/update", { sessionId: "s1", update: THOUGHT });
check("session/update unwrapped", live.type === "message.thinking" && live.rail === "acp");
check("sessionId lifted from the envelope", live.sessionId === "s1");
check("live is not replay", live.replay === false);

const replayed = notificationToAppEvent("session/update", {
  sessionId: "s1",
  update: THOUGHT,
  _meta: { isReplay: true },
});
check("params._meta.isReplay -> AppEvent.replay", replayed.replay === true);

const ext = notificationToAppEvent("_x.ai/session_notification", { sessionId: "s1", update: PENDING });
check("ext rail recognised", ext.rail === "xai" && ext.type === "interaction.pending");
check(
  "replay rail recognised",
  notificationToAppEvent("_x.ai/session/update", { sessionId: "s1", update: THOUGHT }).type ===
    "message.thinking",
);
check(
  "a non-update notification is named",
  notificationToAppEvent("_x.ai/git_head_changed", { sessionId: "s1", branch: "master" }).type ===
    "git.head_changed",
);
check(
  "an unmodelled notification is loud, not dropped",
  notificationToAppEvent("_x.ai/something/new", { a: 1 }).type === "wire.unknown_notification",
);

// WP7 §4: the effort selector rebuilds its options when a full model catalogue
// arrives, so this one is normalised — from the shape Grok's 1.0.0 probe
// captured (§3 row 15), and only when the array is really there.
const MODELS_UPDATE = {
  currentModelId: "grok-4.5",
  availableModels: [
    {
      modelId: "grok-4.5",
      name: "Grok 4.5",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { id: "high", value: "high", label: "High Effort", description: "…", default: true },
        ],
      },
    },
  ],
};
const modelsUp = notificationToAppEvent("_x.ai/models/update", MODELS_UPDATE);
check("a full models/update is modelled", modelsUp.type === "models.updated" && modelsUp.modelled === true);
check("models/update keeps the agent's own model array verbatim",
  (modelsUp.data.availableModels as any[])[0]._meta.reasoningEfforts[0].label === "High Effort");
check("models/update carries the current model id",
  modelsUp.data.currentModelId === "grok-4.5");
const modelsBad = notificationToAppEvent("_x.ai/models/update", { currentModelId: "grok-4.5" });
check("a models/update with no model array stays unmodelled rather than claiming an empty catalogue",
  modelsBad.type === "models.updated" && modelsBad.modelled === false &&
    Object.keys(modelsBad.data).length === 0);
check("and its whole payload is still attached", (modelsBad.raw as any).currentModelId === "grok-4.5");

// ── WP12: settings.update — the gate state ───────────────────────────────
// The TRUE capture is from the wp11-probe run2 wire (1.0.0): allow_access
// true, the gate fields explicit null, a real tier string. A false flip has
// never been captured live, so the flip fixtures below are synthetic and
// shaped exactly on the capture.
const SETTINGS_TRUE = {
  show_resolved_model: false,
  allow_access: true,
  gate_message: null,
  gate_url: null,
  gate_label: null,
  subscription_tier_display: "SuperGrok Heavy",
};
const settingsTrue = notificationToAppEvent("_x.ai/settings/update", SETTINGS_TRUE);
check("settings/update is modelled, not an unhandled card",
  settingsTrue.type === "settings.updated" && settingsTrue.modelled === true);
check("the true capture reads allowAccess true with a null gate and the tier verbatim",
  settingsTrue.data.allowAccess === true && settingsTrue.data.gateMessage === null &&
    settingsTrue.data.gateUrl === null && settingsTrue.data.gateLabel === null &&
    settingsTrue.data.subscriptionTierDisplay === "SuperGrok Heavy");
check("the true capture has NO missing-field complaint (explicit nulls are present values)",
  settingsTrue.missing === undefined);

const SETTINGS_GATE = {
  allow_access: false,
  gate_message: "Your subscription has run out.",
  gate_url: "https://x.ai/example-upgrade",
  gate_label: "Upgrade",
  subscription_tier_display: "SuperGrok Heavy",
};
const settingsGate = notificationToAppEvent("_x.ai/settings/update", SETTINGS_GATE);
check("a false flip WITH a gate message carries all of it through",
  settingsGate.data.allowAccess === false &&
    settingsGate.data.gateMessage === "Your subscription has run out." &&
    settingsGate.data.gateUrl === "https://x.ai/example-upgrade" &&
    settingsGate.data.gateLabel === "Upgrade");

const SETTINGS_BARE_FALSE = { allow_access: false, gate_message: null, gate_url: null, gate_label: null, subscription_tier_display: null };
const settingsBare = notificationToAppEvent("_x.ai/settings/update", SETTINGS_BARE_FALSE);
check("a bare false (no gate_message) surfaces a null gateMessage — the page leaves the gate alone",
  settingsBare.data.allowAccess === false && settingsBare.data.gateMessage === null);

const SETTINGS_THIN = { show_resolved_model: false };
const settingsThin = notificationToAppEvent("_x.ai/settings/update", SETTINGS_THIN);
check("a settings/update with absent fields lands in missing, loudly, with nulls never invented",
  Array.isArray(settingsThin.missing) && settingsThin.missing.includes("allow_access") &&
    settingsThin.data.allowAccess === null && typeof settingsThin.note === "string");

// ── the routing key ─────────────────────────────────────────────────────
//
// WP3b routes per-session fan-out on `AppEvent.sessionId` and nothing else, so
// the two meanings of that field are now load-bearing: a string means "this
// belongs to that session", null means "not attributable to one session, every
// channel gets it". A bridge event about one session that forgets to pass its id
// is broadcast everywhere, which from outside is indistinguishable from a leak.

console.log("\nthe routing key");
check(
  "a bridge event defaults to unscoped",
  bridgeEvent("bridge.test", {}).sessionId === null,
);
check(
  "a bridge event carries the session id it is given",
  bridgeEvent("bridge.test", {}, undefined, "sess-a").sessionId === "sess-a",
);
check(
  "a bridge event is never marked as replayed",
  bridgeEvent("bridge.test", {}, undefined, "sess-a").replay === false,
);
const abandoned = bridgeEvent(
  "interaction.abandoned",
  {
    key: "request-7",
    sessionId: "sess-a",
    method: "session/request_permission",
    interactionType: "interaction.permission_requested",
    reason: "The agent process exited before this interaction could be answered.",
  },
  undefined,
  "sess-a",
);
check("an abandoned interaction is session-scoped", abandoned.sessionId === "sess-a");
check(
  "an abandoned interaction keeps its truthful cause",
  abandoned.type === "interaction.abandoned" &&
    abandoned.data.key === "request-7" &&
    abandoned.data.method === "session/request_permission" &&
    typeof abandoned.data.reason === "string",
);
check(
  "a session update inherits the session id from its envelope",
  notificationToAppEvent("session/update", { sessionId: "sess-b", update: THOUGHT })
    .sessionId === "sess-b",
);
check(
  "an update with no session id on the envelope reads null, not undefined",
  notificationToAppEvent("session/update", { update: THOUGHT }).sessionId === null,
);
check(
  "a replayed update is tagged, so a week-old event cannot render as live",
  notificationToAppEvent("session/update", {
    sessionId: "sess-b",
    update: THOUGHT,
    _meta: { isReplay: true },
  }).replay === true,
);
check(
  "a live update is not tagged",
  notificationToAppEvent("session/update", { sessionId: "sess-b", update: THOUGHT }).replay ===
    false,
);
check(
  "every event shape has a sessionId key at all, so a filter can never read undefined",
  [
    bridgeEvent("bridge.test", {}),
    notificationToAppEvent("session/update", { sessionId: "s", update: THOUGHT }),
    notificationToAppEvent("_x.ai/sessions/changed", {}),
    notificationToAppEvent("_x.ai/something/new", {}),
    toAppEvent(null),
    toAppEvent({}),
    toAppEvent({ sessionUpdate: "a_kind_nobody_has_seen" }),
  ].every((ev) => "sessionId" in ev && (typeof ev.sessionId === "string" || ev.sessionId === null)),
);

// ── the three reverse requests, from REAL 0.2.118 captures (WP6) ─────────
// Probe of 2026-08-01, agent-staging/grok/2026-08-01/ — the first captures of
// these methods to become machine-checked fixtures rather than prose.

console.log("\nreverse requests (0.2.118 probe captures)");

const PERM_118 = {
  sessionId: "019fbff9-4a86-72f0-a829-adcf9a599069",
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
{
  const ev = reverseRequestToAppEvent("interaction-1", "session/request_permission", PERM_118);
  check("0.2.118 permission → interaction.permission_requested",
    ev.type === "interaction.permission_requested" && ev.rail === "acp");
  check("permission options pass through verbatim — same ids, names, order",
    JSON.stringify(ev.data.options) === JSON.stringify(PERM_118.options));
  check("the tool descriptor mirrors read_only:false, not a guess",
    ev.data.tool.readOnly === false && ev.data.tool.label === "Write");
  check("rawInput and title survive for the card's fold",
    ev.data.title === PERM_118.toolCall.title && ev.data.rawInput.variant === "Write");
}
{
  const noMeta = { ...PERM_118, toolCall: { ...PERM_118.toolCall, _meta: undefined } };
  const ev = reverseRequestToAppEvent("interaction-1", "session/request_permission", noMeta);
  check("a permission without _meta normalises readOnly to null — the third state",
    ev.data.tool === null || ev.data.tool.readOnly === null);
}

const PLAN_118 = {
  sessionId: "019fbff9-4a86-72f0-a829-adcf9a599069",
  toolCallId: "call-1ff9f519-ed9e-477c-8868-8c284382ff87-3",
  planContent: "# Plan: Create probe-plan.txt\n\n## Steps\n1. Write `probe-plan.txt`.\n",
};
{
  const ev = reverseRequestToAppEvent("interaction-2", "_x.ai/exit_plan_mode", PLAN_118);
  check("0.2.118 plan exit → interaction.plan_approval_requested, planContent intact",
    ev.type === "interaction.plan_approval_requested" &&
      ev.data.planContent === PLAN_118.planContent);
  check("0.2.118 plan request still carries NO mode field — normalised to null",
    ev.data.mode === null);
}

const Q_MULTI_118 = {
  sessionId: "019fbff9-4a86-72f0-a829-adcf9a599069",
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
const Q_PLANMODE_118 = {
  sessionId: "019fbff9-4a86-72f0-a829-adcf9a599069",
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
{
  const ev = reverseRequestToAppEvent("interaction-3", "_x.ai/ask_user_question", Q_MULTI_118);
  check("0.2.118 question → interaction.question_asked, questions verbatim",
    ev.type === "interaction.question_asked" &&
      JSON.stringify(ev.data.questions) === JSON.stringify(Q_MULTI_118.questions));
  check("multiSelect arrives camelCase and true on the multi-select capture",
    ev.data.questions[0].multiSelect === true);
  check("mode is present and 'default' on the question request (unlike plan requests)",
    ev.data.mode === "default");
}
{
  const ev = reverseRequestToAppEvent("interaction-4", "_x.ai/ask_user_question", Q_PLANMODE_118);
  check("a plan-mode question carries mode:'plan' — the gate for the two extra outcomes",
    ev.data.mode === "plan");
}
{
  const ev = reverseRequestToAppEvent("interaction-5", "_x.ai/something_new", { sessionId: "s" });
  check("an unknown reverse request still maps to the visible unhandled type",
    ev.type === "interaction.unhandled_request" && ev.modelled === false);
}

console.log("\ncoverage");
const cov = kindCoverage();
console.log(
  `  ${cov.length} wire kinds mapped, ${cov.filter((c) => c.verified).length} with a captured payload, ` +
    `${knownAppEventTypes().length} AppEvent types`,
);
check(
  "all 57 wire kinds are mapped (54 from 0.2.114 enum + 2 additive 0.2.117 + 1 additive 1.0.0)",
  cov.length === 57,
  `got ${cov.length}`,
);
check(
  "the additive kinds are verified (0.2.117 pair + 1.0.0's last_turn_summary and auto_compact_completed)",
  cov.some((c) => c.wireKind === "response_completed" && c.verified) &&
    cov.some((c) => c.wireKind === "session_info_update" && c.verified) &&
    cov.some((c) => c.wireKind === "last_turn_summary" && c.verified) &&
    cov.some((c) => c.wireKind === "auto_compact_completed" && c.verified),
);
check("every AppEvent type is namespaced", knownAppEventTypes().every((t) => t.includes(".")));

console.log(
  failures === 0
    ? "\nAll checks passed.\n"
    : `\n${failures} CHECK(S) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
