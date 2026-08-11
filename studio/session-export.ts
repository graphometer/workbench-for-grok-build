// The one-way Markdown transcript export (WP13 §5, D61).
//
// The round-trippable artifact is the JSON bundle (session/state + the raw
// update envelopes) — this file is the OTHER export: a human-readable Markdown
// transcript that opens anywhere and CANNOT be imported back. It is derived, not
// authoritative: it maps each raw update envelope through the same translation
// boundary the live stream uses (`notificationToAppEvent`), then writes the
// user/agent/tool turns as Markdown text.
//
// Every string in here is agent- or operator-controlled and therefore hostile
// (rule 10). The output is a .md FILE — plain text — so nothing is executed by
// writing it; and if Graphometer ever previews it, it goes through the D44
// constructive renderer (`renderPlanMarkdown`), which builds only allowlisted
// elements from text nodes. The deterministic check renders this exact output
// through that renderer and asserts zero IMG/SCRIPT/SVG/IFRAME nodes.

import { notificationToAppEvent } from "./events.ts";

/** Collapse a value to a single trimmed line, for headers/metadata. */
function oneLine(s: unknown): string {
  return String(s ?? "").replace(/[\r\n]+/g, " ").trim();
}

/**
 * A session bundle → a Markdown transcript. `bundle` is what `exportSession`
 * returns: `{ sessionId, cwd, state:{summary,...}, updates:[…raw envelopes] }`.
 */
export function bundleToMarkdown(bundle: any): string {
  const summary = (bundle?.state?.summary ?? {}) as Record<string, unknown>;
  const title =
    oneLine(summary.generated_title) ||
    oneLine(summary.session_summary) ||
    "(untitled session)";

  const out: string[] = [];
  out.push(`# ${title}`);
  out.push("");
  // A truncated transcript is said at the top of the document, not only in the
  // filename: this file outlives the download note that warned about it.
  if (bundle?.hasMore === true) {
    out.push("> **INCOMPLETE — this transcript was truncated.** The agent returned only part of");
    out.push("> the history (hasMore), so turns are missing from this file. It is a partial");
    out.push("> reading copy, not the whole session.");
    out.push("");
  }
  out.push(`- Session: ${oneLine(bundle?.sessionId) || "?"}`);
  out.push(`- Folder: ${oneLine(bundle?.cwd) || "?"}`);
  out.push("");
  out.push("> One-way Markdown transcript exported from Graphometer. Readable anywhere, but it");
  out.push("> CANNOT be imported back — keep the session bundle (.json) for that.");
  out.push("");
  out.push("---");
  out.push("");

  const updates = Array.isArray(bundle?.updates) ? bundle.updates : [];
  for (const env of updates) {
    if (!env || typeof env !== "object") continue;
    let ev: any;
    try {
      ev = notificationToAppEvent(env.method, env.params);
    } catch {
      continue; // a malformed envelope is skipped, never allowed to break the file
    }
    const text = typeof ev?.data?.text === "string" ? ev.data.text : null;
    if (ev.type === "message.user" && text) {
      out.push("## You", "", text, "");
    } else if (ev.type === "message.assistant" && text) {
      out.push("## Agent", "", text, "");
    } else if (ev.type === "tool.started") {
      const label = oneLine(ev.data?.tool?.label ?? ev.data?.kind ?? "tool") || "tool";
      const ttl = oneLine(ev.data?.title);
      out.push(`> **Tool:** ${label}${ttl ? ` — ${ttl}` : ""}`, "");
    }
    // Thinking, advisory snapshots, turn boundaries and unmodelled kinds are
    // deliberately omitted — this is a readable transcript, not a full replay.
  }
  return out.join("\n") + "\n";
}
