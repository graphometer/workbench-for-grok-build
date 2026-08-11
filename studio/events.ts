// The translation boundary.
//
// THIS IS THE ONLY FILE IN THE APPLICATION THAT KNOWS THE ACP WIRE FORMAT.
//
// Everything downstream — the SSE stream, the browser, every pane WP4 onwards
// will add — sees `AppEvent` and nothing else. If a wire-format kind name such
// as `agent_message_chunk` ever appears in another file, the wire format has
// leaked into the app and the next CLI release will break it there.
// `BUILD-PLAN.md` WP3 trap 7 states this as an acceptance condition; the grep
// that proves it is in `docs/APP-EVENTS.md`.
//
// Three rules this file exists to enforce:
//
//  1. NOTHING IS DROPPED. An update whose kind we have never seen still
//     becomes an AppEvent, carrying its whole raw payload, flagged so it is
//     impossible to miss. Silence is the failure mode this project guards
//     against everywhere else; a translation layer is the easiest place in a
//     codebase to introduce it, because a `switch` with no `default` looks
//     tidy.
//
//  2. NOTHING IS INVENTED. A kind is `modelled: true` only when a real payload
//     was captured on the wire and the normaliser was written against it.
//     Kinds we know exist — xAI's own enum has 54 of them — but have never
//     seen are recognised by name and passed through unnormalised, honestly
//     labelled. Naming a shape we have not observed would be a guess wearing a
//     type.
//
//  3. AN ABSENT FIELD IS SAID OUT LOUD. The wire mixes conventions: the
//     `sessionUpdate` discriminator is camelCase while several xAI variants
//     use snake_case field names on the same object (`tool_call_id`,
//     `prompt_id`, `stop_reason`, `model_id`). A reader that assumes one
//     convention reads `undefined` and renders an empty box. Every normaliser
//     records the fields it expected and did not find, in `missing`.
//
// Provenance: the original modelled payload shapes below were captured from
// `grok 0.2.114` on 2026-07-29 across six probe runs. Two additive kinds —
// `response_completed` and `session_info_update` — were captured live on
// `grok 0.2.117` (2026-07-30, multi-run / multi-prompt) and modelled only after
// their shapes held. On `grok 1.0.0` (2026-08-08, WP9): `last_turn_summary`
// and the `auto_compact_completed` payload were captured live and modelled.
// (`_meta.totalTokens` was re-measured the same day and found NOT to be a
// live context-used counter — see the note inside `notificationToAppEvent`.)
// See `docs/APP-EVENTS.md` and `docs/evidence/wp9/` for the captures.

// ── the envelope ────────────────────────────────────────────────────────

/** Which notification rail carried this update. */
export type Rail =
  | "acp" // core ACP `session/update`
  | "xai" // xAI extension `_x.ai/session_notification` (and the replay rail)
  | "bridge"; // this server talking about itself — never came off the wire

export interface AppEvent {
  /** Our name for what happened. Stable across CLI releases; that is the point. */
  type: string;
  /**
   * The discriminator exactly as it arrived, kept as DATA so a human reading a
   * log can correlate with the wire. It is deliberately not used as a literal
   * anywhere outside this file.
   */
  wireKind: string;
  rail: Rail;
  sessionId: string | null;
  /**
   * True when this came from a `session/load` replay rather than live. The
   * agent marks it at `params._meta.isReplay`. A replayed permission request
   * must not re-open a resolved interaction — BUILD-PLAN WP3 trap 5.
   */
  replay: boolean;
  /** Did we normalise this, or is `data` empty and `raw` all there is? */
  modelled: boolean;
  /** The normalised payload. `{}` when `modelled` is false. */
  data: Record<string, unknown>;
  /** Fields a normaliser expected and did not find. Empty is the normal case. */
  missing?: string[];
  /** A human sentence, present only when something needs saying. */
  note?: string;
  /**
   * The original object, untouched, for debugging. Consumers must not read
   * this to get at data — that would re-couple them to the wire format, which
   * is the whole thing this boundary prevents.
   */
  raw: unknown;
  /** Milliseconds since epoch, stamped here. */
  t: number;
}

export interface TranslationContext {
  sessionId?: string | null;
  replay?: boolean;
  rail?: Rail;
}

// ── the kind table ──────────────────────────────────────────────────────
//
// Left column: the wire discriminator. Right: our name, and whether a real
// payload was captured. `verified: false` means "xAI's source says this kind
// exists, we have never seen one, so we recognise the name and pass the
// payload through rather than guessing at its shape".
//
// The original 54 names are the union of the core ACP `SessionUpdate` enum (8)
// and xAI's `extensions/notification.rs::SessionUpdate` (46, including its own
// `unknown` catch-all). Two further kinds observed live on 0.2.117 are listed
// below the verified block; they were not in the 0.2.114 enum extract.

interface KindSpec {
  type: string;
  rail: Rail;
  verified: boolean;
  normalise?: (u: any, m: string[]) => Record<string, unknown>;
}

/** Read a field that may be spelled either way, and say so when it is missing. */
function field(u: any, missing: string[], ...names: string[]): unknown {
  for (const n of names) {
    if (u != null && typeof u === "object" && n in u && u[n] !== undefined) return u[n];
  }
  missing.push(names[0]);
  return undefined;
}

/** Same, but absence is legitimate — an optional field records nothing. */
function optional(u: any, ...names: string[]): unknown {
  for (const n of names) {
    if (u != null && typeof u === "object" && n in u && u[n] !== undefined) return u[n];
  }
  return undefined;
}

/**
 * The tool descriptor xAI attaches to every tool call at `_meta["x.ai/tool"]`.
 *
 * `read_only` is the reason this function exists. On an approval card it is the
 * single most decision-relevant bit — "this will change your files" versus
 * "this will look at them" — and it appears nowhere in the design spec. It is
 * read here so no pane ever has to reach into `_meta` for it.
 *
 * Everything in here is the agent's own vocabulary: `label` is the heading,
 * `kind` picks the icon, `name` is the tool's real name. WP5 trap 1: if the
 * word `bash` is ever written in a source file, that is wrong and it breaks on
 * the next CLI release.
 */
function toolDescriptor(container: any): Record<string, unknown> | null {
  const meta = container?._meta?.["x.ai/tool"];
  if (!meta || typeof meta !== "object") return null;
  return {
    name: meta.name ?? null,
    kind: meta.kind ?? null,
    label: meta.label ?? null,
    namespace: meta.namespace ?? null,
    /**
     * null, not false. Absent is not the same claim as "this tool writes".
     * A card that renders a missing flag as "will modify files" cries wolf;
     * one that renders it as read-only lies in the dangerous direction. Both
     * are wrong, so the third state is kept.
     */
    readOnly: typeof meta.read_only === "boolean" ? meta.read_only : null,
    input: meta.input ?? null,
    version: meta.version ?? null,
  };
}

/** ContentBlock → plain text, for the chunk kinds. */
function chunkText(u: any, missing: string[]): string | null {
  const content = field(u, missing, "content");
  if (content == null) return null;
  if (typeof content === "string") return content;
  if (typeof content === "object" && typeof (content as any).text === "string") {
    return (content as any).text;
  }
  // A non-text block (image, resource). Not an error; say what it was.
  return null;
}

/** 1e10 ticks per US dollar — xAI's `USD_TICKS_PER_USD`, read from their source. */
const USD_TICKS_PER_USD = 1e10;

/**
 * Snake_case usage on `response_completed` (0.2.117). A different object from
 * `turn_completed.usage` (camelCase, carries `costUsdTicks`). Do not feed one
 * into the other. No cost field exists here — cost stays on `turn.completed`.
 * Opaque `signature` on the parent update is deliberately not read into data.
 */
function normaliseResponseUsage(usage: any): Record<string, unknown> | null {
  if (!usage || typeof usage !== "object") return null;
  const num = (k: string): number | null =>
    typeof usage[k] === "number" ? usage[k] : null;
  return {
    inputTokens: num("input_tokens"),
    outputTokens: num("output_tokens"),
    cacheReadInputTokens: num("cache_read_input_tokens"),
    cacheCreationInputTokens: num("cache_creation_input_tokens"),
    reasoningTokens: num("reasoning_tokens"),
  };
}

/**
 * Turn usage, normalised.
 *
 * `costUsdTicks` is an integer count of ten-billionths of a dollar. It is
 * absent — not zero — when the server did not report a cost: xAI's own
 * `reported_cost_ticks` filters `<= 0` to `None` precisely so that "unreported"
 * can never be mistaken for "free". We keep that distinction: `costUsd` is
 * null, never 0, when there is no figure.
 */
function normaliseUsage(usage: any): Record<string, unknown> | null {
  if (!usage || typeof usage !== "object") return null;
  const ticks = typeof usage.costUsdTicks === "number" ? usage.costUsdTicks : null;
  const models: Record<string, unknown> = {};
  if (usage.modelUsage && typeof usage.modelUsage === "object") {
    for (const [id, m] of Object.entries<any>(usage.modelUsage)) {
      const mt = typeof m?.costUsdTicks === "number" ? m.costUsdTicks : null;
      models[id] = {
        inputTokens: m?.inputTokens ?? 0,
        outputTokens: m?.outputTokens ?? 0,
        totalTokens: m?.totalTokens ?? 0,
        cachedReadTokens: m?.cachedReadTokens ?? 0,
        reasoningTokens: m?.reasoningTokens ?? 0,
        modelCalls: m?.modelCalls ?? 0,
        apiDurationMs: m?.apiDurationMs ?? 0,
        costUsdTicks: mt,
        costUsd: mt === null ? null : mt / USD_TICKS_PER_USD,
      };
    }
  }
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    cachedReadTokens: usage.cachedReadTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    modelCalls: usage.modelCalls ?? 0,
    apiDurationMs: usage.apiDurationMs ?? 0,
    numTurns: usage.numTurns ?? null,
    costUsdTicks: ticks,
    costUsd: ticks === null ? null : ticks / USD_TICKS_PER_USD,
    /** The agent's own warning that the bill may under-count. Never hide it. */
    usageIsIncomplete: usage.usageIsIncomplete === true,
    modelUsage: models,
  };
}

const KINDS: Record<string, KindSpec> = {
  // ── core ACP, all eight ────────────────────────────────────────────────
  agent_message_chunk: {
    type: "message.assistant",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({ text: chunkText(u, m) }),
  },
  agent_thought_chunk: {
    type: "message.thinking",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({ text: chunkText(u, m) }),
  },
  user_message_chunk: {
    type: "message.user",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({
      text: chunkText(u, m),
      /* WP11 (review round 1, B1): the agent stamps its echo of the user's
         message with the tracker's promptIndex at `_meta.promptIndex` —
         CONFIRMED on 1.0.0 in the wp11-probe notification census (every
         prompt, including no-change ones). This is the only wire-carried
         join between a UI turn and get-summary's turns[]; the page binds it
         to the open turn and never computes an ordinal. null when absent. */
      promptIndex: typeof (u as any)?._meta?.promptIndex === "number" ? (u as any)._meta.promptIndex : null,
    }),
  },
  tool_call: {
    type: "tool.started",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({
      toolCallId: field(u, m, "toolCallId", "tool_call_id"),
      title: optional(u, "title") ?? null,
      // `kind` is absent on the first update and present on the later ones.
      kind: optional(u, "kind") ?? null,
      /**
       * ABSENT, not "unknown". The first `tool_call` carries no `status` at
       * all; the terminal `tool_call_update` carries `"completed"` or
       * `"failed"`. A status-driven UI must treat null as "not started yet"
       * rather than as a value. Confirmed on 0.2.114.
       */
      status: optional(u, "status") ?? null,
      rawInput: optional(u, "rawInput") ?? null,
      locations: optional(u, "locations") ?? null,
      tool: toolDescriptor(u),
    }),
  },
  tool_call_update: {
    type: "tool.updated",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({
      toolCallId: field(u, m, "toolCallId", "tool_call_id"),
      title: optional(u, "title") ?? null,
      kind: optional(u, "kind") ?? null,
      status: optional(u, "status") ?? null,
      rawInput: optional(u, "rawInput") ?? null,
      rawOutput: optional(u, "rawOutput") ?? null,
      content: optional(u, "content") ?? null,
      locations: optional(u, "locations") ?? null,
      tool: toolDescriptor(u),
    }),
  },
  plan: {
    // The agent's own task list. Real in ACP; never seen on our wire, so the
    // shape below is not asserted — this passes through.
    type: "plan.updated",
    rail: "acp",
    verified: false,
  },
  available_commands_update: {
    type: "commands.updated",
    rail: "acp",
    verified: true,
    /**
     * `commands: null` and `count: null` are the UNREADABLE reading, and they
     * are deliberately not `[]`/`0` (WP7 §2). An update whose array is missing
     * says nothing about how many commands the agent has; defaulting it to zero
     * put a confident "no commands" into the one place a launcher would read.
     * A valid empty array still arrives as `[]` with `count: 0`, because that
     * is a real answer.
     */
    normalise: (u, m) => {
      const commands = field(u, m, "availableCommands");
      const readable = Array.isArray(commands) && commands.every((command: any) =>
        command && typeof command === "object" &&
        typeof command.name === "string" && command.name.trim() !== "");
      return {
        commands: readable ? commands : null,
        count: readable ? (commands as unknown[]).length : null,
        /** The live tool-name list the agent ships alongside the commands. */
        toolNames: u?._meta?.tools ?? null,
      };
    },
  },
  current_mode_update: {
    type: "mode.changed",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({ modeId: field(u, m, "currentModeId", "current_mode_id") }),
  },

  // ── xAI extensions, verified against captured payloads ─────────────────
  tool_call_delta_chunk: {
    type: "tool.arguments_delta",
    rail: "xai",
    verified: true,
    normalise: (u, m) => ({
      // snake_case on this variant. Both spellings tried so a future rename is
      // a visible change rather than a silent undefined.
      toolCallId: optional(u, "tool_call_id", "toolCallId") ?? null,
      toolIndex: field(u, m, "tool_index", "toolIndex"),
      name: optional(u, "name") ?? null,
      /** A raw JSON fragment. NOT valid JSON on its own — xAI's own warning. */
      argumentsDelta: optional(u, "arguments_delta", "argumentsDelta") ?? null,
    }),
  },
  pending_interaction: {
    type: "interaction.pending",
    rail: "xai",
    verified: true,
    normalise: (u, m) => ({
      toolCallId: field(u, m, "tool_call_id", "toolCallId"),
      /** `permission` | `question` | `plan_approval`. */
      interactionKind: field(u, m, "kind"),
      /**
       * READ THIS BEFORE DRIVING ANY UI FROM THIS EVENT.
       *
       * This is an ADVISORY that a blocking check has opened on the agent —
       * it is not itself a request, it expects no response, and it does NOT
       * mean the human is about to be asked anything. Measured on 0.2.114: in
       * one turn it fired five times and the human was asked exactly once.
       * Three of the five opened and resolved inside the same millisecond,
       * because the tool was auto-allowed; a fourth resolved without a prompt
       * because a previous answer was remembered for the session.
       *
       * The only thing that means "the human must act" is the reverse request
       * itself. What this event is genuinely good for is CORRELATION: it names
       * the `toolCallId` the interaction belongs to, which is how an approval
       * card gets attached to the right tool call.
       */
      advisoryOnly: true,
    }),
  },
  interaction_resolved: {
    type: "interaction.resolved",
    rail: "xai",
    verified: true,
    normalise: (u, m) => ({
      toolCallId: field(u, m, "tool_call_id", "toolCallId"),
      /** No `kind` on resolution — it is only on the pending half. */
      advisoryOnly: true,
    }),
  },
  turn_completed: {
    type: "turn.completed",
    rail: "xai",
    verified: true,
    normalise: (u, m) => ({
      promptId: field(u, m, "prompt_id", "promptId"),
      stopReason: field(u, m, "stop_reason", "stopReason"),
      agentResult: optional(u, "agent_result", "agentResult") ?? null,
      usage: normaliseUsage(optional(u, "usage")),
    }),
  },
  session_summary_generated: {
    type: "session.titled",
    rail: "xai",
    verified: true,
    normalise: (u, m) => ({ title: field(u, m, "session_summary", "sessionSummary") }),
  },
  model_changed: {
    type: "model.changed",
    rail: "xai",
    verified: true,
    normalise: (u, m) => ({
      modelId: field(u, m, "model_id", "modelId"),
      reasoningEffort: optional(u, "reasoning_effort", "reasoningEffort") ?? null,
      automatic: false,
    }),
  },

  // ── Additive on grok 0.2.117 — captured multi-run 2026-07-30 ────────────
  // Not present in the 0.2.114 enum extract. Modelled only after shapes held
  // across short / tool / write+permission / cancel / second-session prompts.
  /**
   * Advisory usage snapshot. Fires after assistant text (and often mid-turn on
   * tool turns), before `turn_completed`. Not a turn closer — `turn.completed`
   * + `turn.finished` still own outcome and cost. Cancelled turns observed with
   * zero of these. `signature` is opaque accounting material; kept on `raw`
   * only, never in normalised display data.
   */
  response_completed: {
    type: "response.completed",
    rail: "xai",
    verified: true,
    normalise: (u) => ({
      usage: normaliseResponseUsage(optional(u, "usage")),
      advisoryOnly: true,
    }),
  },
  /**
   * Title-only push on the ACP rail. On every capture the `title` string equalled
   * the earlier `session_summary_generated` → `session.titled` value. The existing
   * title path owns the shell; this event is advisory so it is not a second
   * retitle and not a second TITLE notice.
   */
  session_info_update: {
    type: "session.info_updated",
    rail: "acp",
    verified: true,
    normalise: (u, m) => ({
      title: field(u, m, "title"),
      advisoryOnly: true,
    }),
  },
  /**
   * 1.0.0 additive kind, captured live 2026-08-08 (WP9 probe, grok 1.0.0):
   * `{sessionUpdate:"last_turn_summary", summary:"fig", prompt_id:"…"}` — a
   * one-line summary of the turn that just ended, arriving after
   * `turn_completed`. Advisory: the turn's own events already own outcome,
   * cost and content, so there is nothing here the shell needs to show.
   * snake_case `prompt_id`, as on the sibling kinds.
   */
  last_turn_summary: {
    type: "turn.summary",
    rail: "xai",
    verified: true,
    normalise: (u) => ({
      summary: optional(u, "summary") ?? null,
      promptId: optional(u, "prompt_id", "promptId") ?? null,
      advisoryOnly: true,
    }),
  },

  /**
   * 1.0.0, captured live twice on the manual compact path (WP9, docs/evidence/wp9):
   * `{sessionUpdate:"auto_compact_completed", tokens_before:14298,
   * tokens_after:14171, summary_preview:null}`. All four fields are `Option`
   * upstream (`notification.rs:411-422`; `tokens_before` absent from older
   * shells; `elapsed_ms` has never been on our wire — the name is the source
   * citation, not a capture), so every one normalises to null rather than
   * recording a miss — absence is legitimate here, never a wire-format alarm.
   * The capture is the MANUAL path's; the automatic threshold path emits the
   * same kind with the same optional fields (`compaction.rs:632-638`, source
   * read — the auto path was never filled far enough to capture live).
   */
  auto_compact_completed: {
    type: "context.compact_completed",
    rail: "xai",
    verified: true,
    normalise: (u) => ({
      tokensBefore: optional(u, "tokens_before", "tokensBefore") ?? null,
      tokensAfter: optional(u, "tokens_after", "tokensAfter") ?? null,
      elapsedMs: optional(u, "elapsed_ms", "elapsedMs") ?? null,
      summaryPreview: optional(u, "summary_preview", "summaryPreview") ?? null,
    }),
  },

  // ── xAI extensions we have not captured ────────────────────────────────
  // Recognised by name, passed through whole. Every one of these is real —
  // they are xAI's own enum — but writing a normaliser against a shape nobody
  // has seen would be a guess with a type annotation on it.
  diff_review: { type: "review.diff", rail: "xai", verified: false },
  retry_state: { type: "turn.retrying", rail: "xai", verified: false },
  /**
   * The three remaining compact lifecycle kinds are NOT symmetric with
   * `completed` on 1.0.0 (source read + live capture, WP9, 2026-08-08):
   *  - `started` fires only on the AUTOMATIC threshold path. A manual
   *    `_x.ai/compact_conversation` sends no `started` — the client hatches
   *    from its own click.
   *  - `failed` exists only on auto paths in source; never captured.
   *  - `cancelled` has ZERO emit sites anywhere in the 1.0.0 tree. It is kept
   *    mapped so a future release that revives it is recognised, but no flow
   *    may ever wait for it.
   */
  auto_compact_started: { type: "context.compact_started", rail: "xai", verified: false },
  auto_compact_failed: { type: "context.compact_failed", rail: "xai", verified: false },
  auto_compact_cancelled: { type: "context.compact_cancelled", rail: "xai", verified: false },
  auto_continue_completed: { type: "context.auto_continue_completed", rail: "xai", verified: false },
  memory_flush_started: { type: "memory.flush_started", rail: "xai", verified: false },
  memory_flush_completed: { type: "memory.flush_completed", rail: "xai", verified: false },
  memory_dream_completed: { type: "memory.dream_completed", rail: "xai", verified: false },
  memory_session_saved: { type: "memory.session_saved", rail: "xai", verified: false },
  memory_files: { type: "memory.files", rail: "xai", verified: false },
  feedback_request: { type: "feedback.requested", rail: "xai", verified: false },
  relay_sync_status: { type: "relay.sync_status", rail: "xai", verified: false },
  auto_recovery_started: { type: "turn.recovery_started", rail: "xai", verified: false },
  auto_recovery_exhausted: { type: "turn.recovery_exhausted", rail: "xai", verified: false },
  hook_annotation: { type: "hook.annotation", rail: "xai", verified: false },
  hook_execution: { type: "hook.execution", rail: "xai", verified: false },
  hooks_changed: { type: "hook.registry_changed", rail: "xai", verified: false },
  plugins_changed: { type: "plugin.registry_changed", rail: "xai", verified: false },
  plugin_updates_installed: { type: "plugin.updates_installed", rail: "xai", verified: false },
  session_recap: { type: "session.recap", rail: "xai", verified: false },
  session_recap_unavailable: { type: "session.recap_unavailable", rail: "xai", verified: false },
  compaction_checkpoint: { type: "context.compaction_checkpoint", rail: "xai", verified: false },
  rewind_marker: { type: "session.rewind_marker", rail: "xai", verified: false },
  task_completed: { type: "task.completed", rail: "xai", verified: false },
  task_backgrounded: { type: "task.backgrounded", rail: "xai", verified: false },
  subagent_spawned: { type: "subagent.spawned", rail: "xai", verified: false },
  subagent_progress: { type: "subagent.progress", rail: "xai", verified: false },
  subagent_finished: { type: "subagent.finished", rail: "xai", verified: false },
  scheduled_task_created: { type: "schedule.created", rail: "xai", verified: false },
  scheduled_task_fired: { type: "schedule.fired", rail: "xai", verified: false },
  scheduled_task_deleted: { type: "schedule.deleted", rail: "xai", verified: false },
  monitor_event: { type: "monitor.event", rail: "xai", verified: false },
  model_auto_switched: { type: "model.changed", rail: "xai", verified: false },
  image_compressed: { type: "image.compressed", rail: "xai", verified: false },
  image_dropped: { type: "image.dropped", rail: "xai", verified: false },
  workflow_updated: { type: "workflow.updated", rail: "xai", verified: false },
  goal_updated: { type: "goal.updated", rail: "xai", verified: false },
  /**
   * xAI's own catch-all. If this arrives, THEIR deserializer already discarded
   * every field of the real variant before it reached us — so the raw payload
   * is `{"sessionUpdate":"unknown"}` and the information is gone upstream, not
   * here. Worth distinguishing from our own unknown, because there is nothing
   * to recover.
   */
  unknown: { type: "wire.discarded_upstream", rail: "xai", verified: false },
};

// ── the boundary ────────────────────────────────────────────────────────

/**
 * Translate one ACP session update into an AppEvent.
 *
 * Total: every input produces an event. A malformed update, an unrecognised
 * kind and a kind we recognise but have never seen all come out the other
 * side, distinguishable and carrying their payload.
 */
export function toAppEvent(update: unknown, ctx: TranslationContext = {}): AppEvent {
  const base = {
    sessionId: ctx.sessionId ?? null,
    replay: ctx.replay === true,
    raw: update,
    t: Date.now(),
  };

  if (update === null || typeof update !== "object" || Array.isArray(update)) {
    const what = update === null ? "null" : Array.isArray(update) ? "an array" : typeof update;
    return {
      ...base,
      type: "wire.malformed",
      wireKind: "",
      rail: ctx.rail ?? "acp",
      modelled: false,
      data: {},
      note: `a session update arrived that is ${what}, not an object — it cannot carry a kind`,
    };
  }

  const kind = (update as any).sessionUpdate;
  if (typeof kind !== "string" || kind === "") {
    return {
      ...base,
      type: "wire.unlabelled",
      wireKind: "",
      rail: ctx.rail ?? "acp",
      modelled: false,
      data: {},
      note: "a session update arrived with no `sessionUpdate` discriminator — nothing can be said about what it is, so the whole payload is attached",
    };
  }

  const spec = KINDS[kind];

  if (!spec) {
    // The loud path. A kind neither ACP nor xAI's enum contains, or one added
    // after this table was written. It is NOT dropped and NOT normalised into
    // a shape that would flatter it.
    return {
      ...base,
      type: "wire.unknown_kind",
      wireKind: kind,
      rail: ctx.rail ?? "xai",
      modelled: false,
      data: {},
      note: `unrecognised session update kind '${kind}' — the agent is sending something this build has never seen. Nothing was dropped; the whole payload is attached. If it matters, model it here.`,
    };
  }

  if (!spec.normalise) {
    return {
      ...base,
      type: spec.type,
      wireKind: kind,
      rail: ctx.rail ?? spec.rail,
      modelled: false,
      data: {},
      note: `'${kind}' is a known kind whose payload this build has never captured, so it is passed through unnormalised rather than guessed at`,
    };
  }

  const missing: string[] = [];
  let data: Record<string, unknown>;
  try {
    data = spec.normalise(update, missing);
  } catch (err) {
    // A normaliser throwing is a bug in this file, not a reason to lose the
    // event. It goes downstream as raw, saying which normaliser failed.
    return {
      ...base,
      type: "wire.translation_failed",
      wireKind: kind,
      rail: ctx.rail ?? spec.rail,
      modelled: false,
      data: {},
      note: `translating '${kind}' threw: ${(err as Error).message}. The raw payload is attached and nothing was lost, but this is a bug in events.ts.`,
    };
  }

  const ev: AppEvent = {
    ...base,
    type: spec.type,
    wireKind: kind,
    rail: ctx.rail ?? spec.rail,
    modelled: true,
    data,
  };
  if (missing.length > 0) {
    ev.missing = missing;
    ev.note =
      `expected field(s) ${missing.map((f) => `'${f}'`).join(", ")} were absent from '${kind}'. ` +
      `Either the agent changed the wire format or this normaliser is wrong. Reading them as ` +
      `undefined and rendering an empty box is the failure this message exists to prevent.`;
  }
  return ev;
}

// ── the rest of the wire ────────────────────────────────────────────────
//
// Session updates are most of the traffic but not all of it. Nine other
// notification methods and three reverse requests were observed on 0.2.114.
// They go through the same door, so the promise "the SSE stream carries only
// AppEvents" is literally true rather than nearly true.

/** Notifications that are not session updates, mapped by method name. */
const NOTIFICATION_KINDS: Record<string, { type: string; verified: boolean }> = {
  "x.ai/git_head_changed": { type: "git.head_changed", verified: true },
  "x.ai/sessions/changed": { type: "sessions.changed", verified: true },
  "x.ai/settings/update": { type: "settings.updated", verified: true },
  "x.ai/models/update": { type: "models.updated", verified: true },
  "x.ai/queue/changed": { type: "queue.changed", verified: true },
  "x.ai/announcements/update": { type: "announcements.updated", verified: true },
  "x.ai/mcp_initialized": { type: "mcp.initialized", verified: true },
  "x.ai/mcp/servers_updated": { type: "mcp.servers_updated", verified: true },
  /**
   * Fire-and-forget twin of the `turn_completed` session update. The update is
   * the durable one — it survives a reconnect — so this is the redundant copy,
   * kept visible rather than silently deduplicated.
   */
  "x.ai/session/prompt_complete": { type: "turn.prompt_complete", verified: true },
};

/** Ext methods travel underscore-prefixed on the wire; match on the bare name. */
function bare(method: string): string {
  return method.startsWith("_") ? method.slice(1) : method;
}

/** Method names that carry a session update inside `params.update`. */
const UPDATE_RAILS: Record<string, Rail> = {
  "session/update": "acp",
  "x.ai/session_notification": "xai",
  /** The replay rail, used by `session/load`. */
  "x.ai/session/update": "xai",
};

/**
 * Translate any notification the agent pushed. Delegates to `toAppEvent` when
 * the notification is carrying a session update, which is the common case.
 */
export function notificationToAppEvent(method: string, params: any): AppEvent {
  const rail = UPDATE_RAILS[bare(method)] ?? UPDATE_RAILS[method];

  if (rail !== undefined) {
    /* NOTE (WP9, measured on 1.0.0 2026-08-08): `params._meta.totalTokens`
       rides most update frames, but it is NOT a live context-used counter —
       it is the chat state's accounting value (the last model response's
       recorded total plus a tool-result estimate), constant across a turn's
       chunks and jumping only when a response completes. Measured: 3,064 →
       a constant 3,132 across a probe turn's 29 chunks, then 13,502 at
       completion; and a session whose post-turn session/info reading was
       14,171 read 3,769 right after session/load and showed 3.8k through the
       next turn's stream. A meter driven off any of these drops at every
       turn start. It is deliberately not lifted onto AppEvents. */
    return toAppEvent(params?.update, {
      sessionId: typeof params?.sessionId === "string" ? params.sessionId : null,
      // The agent stamps replayed updates here. Free, and exactly what WP3
      // trap 5 needs: a replayed permission request must not re-open a
      // resolved interaction.
      replay: params?._meta?.isReplay === true,
      rail,
    });
  }

  const spec = NOTIFICATION_KINDS[bare(method)];
  const common = {
    wireKind: method,
    rail: "xai" as Rail,
    sessionId: typeof params?.sessionId === "string" ? params.sessionId : null,
    replay: false,
    raw: params,
    t: Date.now(),
  };

  if (!spec) {
    return {
      ...common,
      type: "wire.unknown_notification",
      modelled: false,
      data: {},
      note: `the agent pushed a notification this build does not model: '${method}'. Nothing was dropped; the whole payload is attached.`,
    };
  }

  // Two of them now have captured payloads and fire on EVERY new session, so
  // they are normalised rather than passed through nameless. Before this they
  // reached the stream as `modelled: false` and the shell drew them as two
  // UNHANDLED EVENT cards with raw JSON on top of every fresh session — the
  // first thing the operator saw was a pair of warnings about routine setup
  // (found in the director's acceptance walk, 2026-08-02). They are recognised, they
  // are benign, and they now say so in words and collapse into the Activity
  // fold. Anything still unrecognised keeps the loud treatment: D35 protects
  // against silently dropping the UNKNOWN, not against naming the known.
  if (spec.type === "mcp.initialized") {
    const count = typeof params?.mcpToolCount === "number" ? params.mcpToolCount : null;
    return {
      ...common,
      type: spec.type,
      modelled: true,
      data: { mcpToolCount: count, elapsedMs: typeof params?.elapsedMs === "number" ? params.elapsedMs : null },
    };
  }
  if (spec.type === "git.head_changed") {
    return {
      ...common,
      type: spec.type,
      modelled: true,
      data: {
        branch: typeof params?.branch === "string" ? params.branch : null,
        isWorktree: params?.isWorktree === true,
        mainRepo: typeof params?.mainRepo === "string" ? params.mainRepo : null,
      },
    };
  }

  // The model catalogue. CONFIRMED on grok 1.0.0 (Grok WP7 probe §3 row 15):
  // `{currentModelId, availableModels:[{modelId, name, description, _meta:{…,
  // reasoningEfforts:[…]}}]}`, seen at session open. WP7's effort selector
  // rebuilds its options from this when it arrives, so it is normalised rather
  // than passed through nameless — but ONLY when the array is really there. A
  // payload without it keeps the pass-through treatment and stays visible as an
  // unhandled kind (D35): an empty option list would read as "this model has no
  // effort levels", which is not something we read.
  if (spec.type === "models.updated" && Array.isArray(params?.availableModels)) {
    return {
      ...common,
      type: spec.type,
      modelled: true,
      data: {
        currentModelId:
          typeof params?.currentModelId === "string" ? params.currentModelId : null,
        availableModels: params.availableModels,
      },
    };
  }

  // The gate state (WP12). Captured shape on 1.0.0 (wp11-probe run2/90):
  // `{allow_access:true, gate_message:null, gate_url:null, gate_label:null,
  //   subscription_tier_display:"SuperGrok Heavy", …}` — a flip to false has
  //  never been captured live. Two upstream semantics are mirrored exactly:
  //  allow_access:false WITHOUT a gate_message leaves the gate alone, and
  //  allow_access:true clears it. Explicit nulls are PRESENT values (read as
  //  "no gate"); a field that is ABSENT lands in `missing` with the loud
  //  note, because then this model is guessing about the wire.
  if (spec.type === "settings.updated") {
    const missing: string[] = [];
    const want = (name: string) => {
      if (params === null || typeof params !== "object" || !(name in params)) missing.push(name);
      return params?.[name];
    };
    const allowAccess = want("allow_access");
    const gateMessage = want("gate_message");
    const gateUrl = want("gate_url");
    const gateLabel = want("gate_label");
    const tier = want("subscription_tier_display");
    const ev: AppEvent = {
      ...common,
      type: spec.type,
      modelled: true,
      data: {
        /* null = the wire did not say — never invent a value either way. */
        allowAccess: typeof allowAccess === "boolean" ? allowAccess : null,
        gateMessage: typeof gateMessage === "string" && gateMessage !== "" ? gateMessage : null,
        gateUrl: typeof gateUrl === "string" && gateUrl !== "" ? gateUrl : null,
        gateLabel: typeof gateLabel === "string" && gateLabel !== "" ? gateLabel : null,
        subscriptionTierDisplay: typeof tier === "string" && tier !== "" ? tier : null,
      },
    };
    if (missing.length > 0) {
      ev.missing = missing;
      ev.note =
        `expected field(s) ${missing.map((f) => `'${f}'`).join(", ")} were absent from 'settings/update'. ` +
        `Either the agent changed the wire format or this normaliser is wrong. The gate state is ` +
        `left untouched rather than guessed.`;
    }
    return ev;
  }

  // The rest carry small, flat payloads that differ per method and several were
  // seen exactly once. Pass them through with a name rather than assert shapes
  // off a single observation.
  return { ...common, type: spec.type, modelled: false, data: {} };
}

/**
 * Translate a reverse request — the direction where the agent asks and waits.
 *
 * `key` is the handle the browser sends back to answer it. The raw request is
 * attached like everywhere else; the normalised half is what a card is built
 * from, and for a permission that means `tool.readOnly` is available without
 * anyone reaching into `_meta`.
 */
export function reverseRequestToAppEvent(
  key: string,
  method: string,
  params: any,
  extra: Record<string, unknown> = {},
): AppEvent {
  const b = bare(method);
  const common = {
    wireKind: method,
    rail: "xai" as Rail,
    sessionId: typeof params?.sessionId === "string" ? params.sessionId : null,
    replay: false,
    raw: params,
    t: Date.now(),
    modelled: true,
  };

  if (b === "session/request_permission") {
    const tc = params?.toolCall;
    return {
      ...common,
      rail: "acp",
      type: "interaction.permission_requested",
      data: {
        key,
        toolCallId: tc?.toolCallId ?? null,
        title: tc?.title ?? null,
        kind: tc?.kind ?? null,
        rawInput: tc?.rawInput ?? null,
        tool: toolDescriptor(tc),
        /** The agent's own options, verbatim. Never invent one, never reorder. */
        options: Array.isArray(params?.options) ? params.options : [],
        ...extra,
      },
    };
  }

  if (b === "x.ai/exit_plan_mode") {
    return {
      ...common,
      type: "interaction.plan_approval_requested",
      data: {
        key,
        toolCallId: params?.toolCallId ?? null,
        planContent: params?.planContent ?? null,
        /** Present on `ask_user_question`; absent here on 0.2.114. */
        mode: params?.mode ?? null,
        ...extra,
      },
    };
  }

  if (b === "x.ai/ask_user_question") {
    return {
      ...common,
      type: "interaction.question_asked",
      data: {
        key,
        toolCallId: params?.toolCallId ?? null,
        questions: Array.isArray(params?.questions) ? params.questions : [],
        mode: params?.mode ?? null,
        ...extra,
      },
    };
  }

  return {
    ...common,
    type: "interaction.unhandled_request",
    modelled: false,
    data: { key, method, ...extra },
    note: `the agent sent a reverse request this build does not implement: '${method}'`,
  };
}

/**
 * The bridge narrating itself: process lifecycle, parse failures, our own
 * refusals. Never came off the wire, hence `rail: "bridge"`.
 *
 * `sessionId` is the fourth argument and it is load-bearing from WP3b onwards.
 * `AppEvent.sessionId` is the routing key for per-session fan-out, and it has
 * exactly two meanings:
 *
 *   a string — this belongs to that session and only that session.
 *   null     — this is not attributable to one session, so every channel gets it.
 *
 * Those are the only two, and the distinction decides delivery. A bridge event
 * about one session that forgets to pass its id is broadcast to every open
 * channel; the failure looks like a leak and is indistinguishable from one from
 * the outside. Pass the id whenever there is one.
 */
export function bridgeEvent(
  type: string,
  data: Record<string, unknown>,
  note?: string,
  sessionId: string | null = null,
): AppEvent {
  return {
    type,
    wireKind: "",
    rail: "bridge",
    sessionId,
    replay: false,
    modelled: true,
    data,
    note,
    raw: null,
    t: Date.now(),
  };
}

/** Every AppEvent type this build can produce. Used by the schema doc and tests. */
export function knownAppEventTypes(): string[] {
  const types = new Set<string>([
    ...Object.values(KINDS).map((k) => k.type),
    ...Object.values(NOTIFICATION_KINDS).map((k) => k.type),
    "interaction.permission_requested",
    "interaction.plan_approval_requested",
    "interaction.question_asked",
    "interaction.unhandled_request",
    "wire.malformed",
    "wire.unlabelled",
    "wire.unknown_kind",
    "wire.unknown_notification",
    "wire.translation_failed",
  ]);
  return [...types].sort();
}

/** The wire kinds this build recognises, and whether a payload was captured. */
export function kindCoverage(): { wireKind: string; type: string; verified: boolean }[] {
  return Object.entries(KINDS)
    .map(([wireKind, s]) => ({ wireKind, type: s.type, verified: s.verified }))
    .sort((a, b) => a.wireKind.localeCompare(b.wireKind));
}
