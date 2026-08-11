// config-read.ts — read-only answers about the operator's own Grok Build setup.
//
// WP10 + WP15. Two readers, both pure text-in / answer-out, both wrapped by a
// file helper that is the ONLY place a path is touched:
//
//   1. `~/.grok/config.toml` → the [ui] permission mode. The app hashes this
//      file before and after every run; nothing here ever writes it.
//   2. `~/.grok/auth.json` → EXACTLY THREE named fields under the D81/D82/D88
//      exception to AGENTS.md rule 3:
//        - `coding_data_retention_opt_out` (boolean → retentionOptOut)
//        - `team_blocked_reasons` (array → derived isZdr, D88; never returned raw)
//        - (legacy) `is_zdr` is NOT in the entry struct and is never read
//      The honest boundary, stated exactly: the file's bytes pass through this
//      process's memory, but only the two booleans in the return shape ever
//      leave it — the token and every other field are dropped at the parse,
//      never returned, never logged, never stored, never displayed. The app
//      itself never writes the file (D87: the agent may rewrite it in response
//      to the retention switch).
//
// Absence is a first-class answer everywhere: a missing key is `null` —
// "not stated" — never a default dressed up as a reading.
import { readFileSync } from "node:fs";

export interface PermissionModeReading {
  /** The exact string the file carries ("ask", "always-approve", …), or null. */
  mode: string | null;
  /** Which key supplied it — current or one of the two legacy spellings. */
  source: "permission_mode" | "approval_mode" | "yolo" | null;
  /** Set when the file was unreadable or the section/key could not be found. */
  problem: string | null;
}

/**
 * The [ui] permission mode from config.toml TEXT. This is NOT a TOML parser —
 * three review rounds (Codex WP10) proved a clever line scanner keeps losing
 * to TOML corners (multiline strings, quoted/escaped keys, escapes in values,
 * typed/untyped bracket tricks). So this is a WHITELIST reader: the [ui]
 * section's lines must each be exactly one of a few simple shapes, and any
 * line that is not — a quoted key, an escape anywhere, an inline table, a
 * bare-word value, an unterminated anything — refuses the whole section with
 * a problem sentence. It can say "not read" over a valid-but-fancy config;
 * it can never report the wrong mode. That is the only property that matters:
 * the dangerous direction is showing "Ask before running" over always-approve.
 *
 * Upstream accepts "always-approve" | "auto" | "ask" | "default" plus legacy
 * `approval_mode` and `yolo = true` (xai-grok-shell util/config/permissions.rs).
 */
export function readPermissionMode(configText: string): PermissionModeReading {
  const none: PermissionModeReading = { mode: null, source: null, problem: null };
  if (typeof configText !== "string" || configText.trim() === "") {
    return { ...none, problem: "config.toml is empty or unreadable" };
  }

  /* Whole-file pre-pass. Multi-line strings are REFUSED, not parsed: a
     triple-quote with escapes inside can defeat any hand-rolled blanking
     (Codex proved a wrong read is possible through one), so any `"""` or
     `'''` anywhere refuses the file. A config with multi-line strings is
     exotic; "not read" is honest and a wrong mode is impossible. Comments
     are stripped quote-aware so a `#` inside a single-line string survives. */
  if (configText.includes('"""') || configText.includes("'''")) {
    return { ...none, problem: "config.toml uses multi-line strings — not read rather than guessed" };
  }
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  while (i < configText.length) {
    const ch = configText[i];
    if (inStr !== null && ch === "\n") {
      /* A single-line string never spans lines; two malformed ones could
         otherwise balance each other into a confident read (Codex WP10). */
      return { ...none, problem: "config.toml has a string running across a line break — not read" };
    }
    if (inStr === null && ch === "#") {
      while (i < configText.length && configText[i] !== "\n") i++;
      continue;
    }
    if (inStr === null && (ch === '"' || ch === "'")) { inStr = ch; out += ch; i++; continue; }
    if (inStr !== null && ch === inStr) {
      if (inStr === '"' && configText[i - 1] === "\\") { out += ch; i++; continue; }
      inStr = null; out += ch; i++; continue;
    }
    out += ch; i++;
  }
  if (inStr !== null) return { ...none, problem: "config.toml has an unterminated string — not read" };

  /* The whitelist. A line inside [ui] is one of: blank; a comment; a section
     header; or `bare_key = "value" | 'value' | true|false` — the double-quoted
     form forbidding a backslash, so no escape can ever hide a value. */
  const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"\\\n]*)"|'([^'\n]*)'|(true|false))\s*(#.*)?$/;
  const HEADER = /^\[([A-Za-z0-9_.-]+)\]\s*(#.*)?$/;
  const unreadable = { ...none, problem: "the [ui] section has a construct this build does not read — not read rather than guessed" };

  let section: "ui" | "other" | "none" = "none";
  let uiSeen = false;
  const found: { key: string; value: string; kind: "string" | "bool" }[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const header = HEADER.exec(trimmed);
    if (header) {
      if (header[1] === "ui") {
        if (uiSeen) return { ...none, problem: "config.toml has two [ui] sections — ambiguous, not read" };
        uiSeen = true;
        section = "ui";
      } else {
        section = "other";
      }
      continue;
    }
    if (section !== "ui") continue;
    const kv = KEY_VALUE.exec(trimmed);
    if (!kv) return unreadable;
    /* The type matters (Codex WP10, executed): a quoted "true" is a string,
       never the boolean; a bare true is never a mode string. */
    found.push({
      key: kv[1],
      value: kv[2] ?? kv[3] ?? kv[4],
      kind: kv[4] !== undefined ? "bool" : "string",
    });
  }
  if (!uiSeen) return { ...none, problem: "config.toml has no [ui] section" };

  /* ANY duplicate key in the section — related to the mode or not — makes the
     file ambiguous about intent (Codex WP10: a contradictory dup must not be
     out-precedented into a confident answer). */
  const seen = new Set<string>();
  for (const f of found) {
    if (seen.has(f.key)) {
      return { ...none, problem: `the [ui] section sets '${f.key}' twice — ambiguous, not read` };
    }
    seen.add(f.key);
  }

  /* Validate EVERY present recognized key before any precedence (Codex WP10):
     a wrong type or an empty value anywhere among them refuses the file — a
     broken lower-priority key must not be out-precedented into confidence. */
  const recognized: { key: string; kind: "string" | "bool" }[] = [
    { key: "permission_mode", kind: "string" },
    { key: "approval_mode", kind: "string" },
    { key: "yolo", kind: "bool" },
  ];
  for (const { key, kind } of recognized) {
    const hit = found.find((f) => f.key === key);
    if (!hit) continue;
    if (hit.kind !== kind) {
      return { ...none, problem: `the [ui] section's ${key} is not a ${kind === "string" ? "string" : "boolean"} — not read` };
    }
    if (hit.value === "") {
      return { ...none, problem: `the [ui] section sets ${key} to an empty string — not read` };
    }
  }
  const get = (key: string) => found.find((f) => f.key === key)?.value ?? null;
  const mode = get("permission_mode");
  if (mode !== null) return { mode, source: "permission_mode", problem: null };
  const approval = get("approval_mode");
  if (approval !== null) return { mode: approval, source: "approval_mode", problem: null };
  const yolo = get("yolo");
  if (yolo !== null) return { mode: yolo === "true" ? "always-approve" : "ask", source: "yolo", problem: null };
  return { ...none, problem: "no readable permission mode in the [ui] section" };
}

export interface RetentionReading {
  /** coding_data_retention_opt_out — null when the field is absent. Absent is NOT false. */
  retentionOptOut: boolean | null;
  /**
   * Zero-data-retention, DERIVED from `team_blocked_reasons` the way upstream
   * does (D88 / model.rs is_zdr_team): true when the list contains
   * BLOCKED_REASON_NO_LOGS or BLOCKED_REASON_NO_LOGS_MODERATED. Absent or empty
   * reasons → false (upstream's default empty vec). Malformed reasons → problem.
   * The raw list never leaves this function.
   */
  isZdr: boolean | null;
  problem: string | null;
}

/** Upstream's ZDR triggers — the only strings that make is_zdr_team() true. */
const ZDR_REASONS = new Set([
  "BLOCKED_REASON_NO_LOGS",
  "BLOCKED_REASON_NO_LOGS_MODERATED",
]);

/**
 * Derive ZDR from team_blocked_reasons (D88). Returns:
 *   - { ok: true, isZdr } when the field is absent, null, or a string array
 *   - { ok: false, problem } when the field is present but not a string array
 * The raw reasons never leave.
 */
function deriveIsZdr(entry: Record<string, unknown>):
  | { ok: true; isZdr: boolean }
  | { ok: false; problem: string } {
  const raw = entry.team_blocked_reasons;
  /* Upstream defaults missing/empty to [] → is_zdr_team() false. */
  if (raw === undefined || raw === null) return { ok: true, isZdr: false };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      problem: "auth.json team_blocked_reasons is not a list — not read rather than guessed",
    };
  }
  for (const r of raw) {
    if (typeof r !== "string") {
      return {
        ok: false,
        problem: "auth.json team_blocked_reasons holds a non-string — not read rather than guessed",
      };
    }
  }
  const isZdr = raw.some((r) => ZDR_REASONS.has(r as string));
  return { ok: true, isZdr };
}

/**
 * Retention facts from auth.json TEXT. Exactly three named fields may be
 * inspected (D81/D82/D88): `coding_data_retention_opt_out`,
 * `team_blocked_reasons` (for the isZdr derivation only), and nothing else.
 * The return shape carries only two booleans + problem — the raw reasons list
 * and the token never leave. The file's shape on 1.0.0: top-level keys are
 * account entries (`"https://auth.x.ai::<id>"`). More than one entry and the
 * reader FAILS CLOSED — "not read rather than guessed" (D82).
 */
export function readRetention(authText: string): RetentionReading {
  const none: RetentionReading = { retentionOptOut: null, isZdr: null, problem: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(authText);
  } catch {
    return { ...none, problem: "auth.json did not parse" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...none, problem: "auth.json has no account entries" };
  }
  const entries = Object.values(parsed as Record<string, unknown>)
    .filter((e) => e && typeof e === "object" && !Array.isArray(e));
  if (entries.length === 0) return { ...none, problem: "auth.json has no account entries" };
  /* More than one account entry and "which is active" is a guess — and a
     privacy truth may never be a guess (Codex WP10 review). Fail closed. */
  if (entries.length > 1) {
    return { ...none, problem: "auth.json holds more than one account — not read rather than guessed" };
  }
  const entry = entries[0] as Record<string, unknown>;
  const zdr = deriveIsZdr(entry);
  if (!zdr.ok) {
    return { ...none, problem: zdr.problem };
  }
  return {
    retentionOptOut: typeof entry.coding_data_retention_opt_out === "boolean"
      ? entry.coding_data_retention_opt_out : null,
    isZdr: zdr.isZdr,
    problem: null,
  };
}

/** File wrappers — the only path-touching code in the module. */
export function readPermissionModeFromFile(path: string): PermissionModeReading {
  try {
    return readPermissionMode(readFileSync(path, "utf8"));
  } catch (err) {
    return { mode: null, source: null, problem: `config.toml unreadable: ${(err as Error).message}` };
  }
}
export function readRetentionFromFile(path: string): RetentionReading {
  try {
    return readRetention(readFileSync(path, "utf8"));
  } catch (err) {
    return { retentionOptOut: null, isZdr: null, problem: `auth.json unreadable: ${(err as Error).message}` };
  }
}
