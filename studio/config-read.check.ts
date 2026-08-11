// config-read.check.ts — fixtures for the WP10 first-run config readers.
// Same pattern as fs-browse.check.ts: temp files under mkdtemp, finally cleanup,
// no real machine paths in fixtures. The auth.json fixture carries a decoy
// "token" field on purpose: the reader's output must never contain it (D81).
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPermissionMode,
  readRetention,
  readPermissionModeFromFile,
  readRetentionFromFile,
} from "./config-read.ts";

let passed = 0;
function check(name: string, condition: unknown) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), "gm-config-read-"));
try {
  // ── permission_mode ──
  const ask = readPermissionMode("[ui]\npermission_mode = \"ask\"\n");
  check("a plain [ui] permission_mode reads", ask.mode === "ask" && ask.source === "permission_mode");

  const yolo = readPermissionMode("[ui]\nyolo = false\ncompact_mode = false\npermission_mode = \"ask\"\n");
  check("this machine's own shape reads (yolo legacy key present, current key wins)",
    yolo.mode === "ask" && yolo.source === "permission_mode");

  const aa = readPermissionMode("[ui]\npermission_mode = \"always-approve\"\n");
  check("always-approve reads verbatim", aa.mode === "always-approve");

  const legacy = readPermissionMode("[ui]\nyolo = true\n");
  check("legacy yolo=true maps to always-approve with its source named",
    legacy.mode === "always-approve" && legacy.source === "yolo");

  const legacyOff = readPermissionMode("[ui]\nyolo = false\n");
  check("legacy yolo=false maps to ask", legacyOff.mode === "ask" && legacyOff.source === "yolo");

  const otherSection = readPermissionMode("[model]\npermission_mode = \"always-approve\"\n");
  check("a permission_mode outside [ui] is NOT read (section scoping)",
    otherSection.mode === null && otherSection.problem !== null);

  const noUi = readPermissionMode("[model]\ndefault = \"grok-4.5\"\n");
  check("no [ui] section is said, not guessed",
    noUi.mode === null && /no \[ui\] section/.test(noUi.problem || ""));

  const empty = readPermissionMode("");
  check("an empty file is a problem, never a mode", empty.mode === null && empty.problem !== null);

  const unknown = readPermissionMode("[ui]\npermission_mode = \"yolo-max\"\n");
  check("an unknown mode string reads VERBATIM (the agent decides what it means)",
    unknown.mode === "yolo-max");

  // ── Codex's attack cases: the reader must fail closed, never lie ──
  const multiStr = `[ui]\nnote = """\npermission_mode = "ask"\n"""\npermission_mode = "always-approve"\n`;
  check("a multi-line string in [ui] is outside the whitelist — refused, never a misread",
    readPermissionMode(multiStr).mode === null && readPermissionMode(multiStr).problem !== null);

  const headerSmuggle = "[other]\nnote = \"\"\"\n[ui]\npermission_mode = \"always-approve\"\n\"\"\"\n[ui]\npermission_mode = \"ask\"\n";
  const smuggleResult = readPermissionMode(headerSmuggle);
  check("ANY multi-line string refuses the file outright (escapes inside one defeated blanking)",
    smuggleResult.mode === null && smuggleResult.problem !== null);

  const singleQuotedStr = readPermissionMode("[ui]\nnote = 'has # hash'\npermission_mode = \"ask\"\n");
  check("a # inside a single-line string is not a comment", singleQuotedStr.mode === "ask");

  const stringYolo = readPermissionMode("[ui]\nyolo = \"true\"\n");
  check("a quoted 'true' is a string, never the boolean — refused",
    stringYolo.mode === null && /not a boolean/.test(stringYolo.problem || ""));

  const boolMode = readPermissionMode("[ui]\npermission_mode = true\n");
  check("a bare boolean is never a mode string — refused",
    boolMode.mode === null && /not a string/.test(boolMode.problem || ""));

  const crossLine = readPermissionMode("[other]\nnote = \"abc\n[ui]\npermission_mode = \"ask\"\nxyz\"");
  check("a string running across a line break refuses (malformed strings can't balance)",
    crossLine.mode === null && crossLine.problem !== null);

  const emptyApproval = readPermissionMode("[ui]\napproval_mode = \"\"\nyolo = true\n");
  check("an empty approval_mode refuses rather than falling through to yolo",
    emptyApproval.mode === null && emptyApproval.problem !== null);

  const brokenLowerKey = readPermissionMode("[ui]\npermission_mode = \"ask\"\nyolo = \"true\"\n");
  check("a wrong-typed lower-priority key refuses even when a good key outranks it",
    brokenLowerKey.mode === null && /not a boolean/.test(brokenLowerKey.problem || ""));

  const commentHeader = readPermissionMode("[ui] # the ui section\npermission_mode = \"ask\"\n");
  check("a section header with a trailing comment reads", commentHeader.mode === "ask");

  const singleQuoted = readPermissionMode("[ui]\npermission_mode = 'always-approve'\n");
  check("a single-quoted value reads", singleQuoted.mode === "always-approve");

  const dup = readPermissionMode("[ui]\npermission_mode = \"ask\"\npermission_mode = \"always-approve\"\n");
  check("duplicate keys are ambiguous — a problem, never a choice",
    dup.mode === null && /twice/.test(dup.problem || ""));

  const smuggled = "[ui]\nother = {\n permission_mode = \"ask\"\n}\npermission_mode = \"always-approve\"\n";
  check("an inline table is outside the whitelist — the whole section is refused, never smuggled",
    readPermissionMode(smuggled).mode === null && readPermissionMode(smuggled).problem !== null);

  const quotedKey = readPermissionMode("[ui]\n\"permission_mode\" = \"always-approve\"\nyolo = false\n");
  check("a quoted key is outside the whitelist — refused, never falls through to the legacy key",
    quotedKey.mode === null && quotedKey.problem !== null);

  const escapedValue = readPermissionMode("[ui]\npermission_mode = \"always\\u002dapprove\"\n");
  check("an escape in a value is outside the whitelist — refused, never a defeated warning",
    escapedValue.mode === null && escapedValue.problem !== null);

  const unterminated = readPermissionMode("[ui]\nnote = \"\"\"\npermission_mode = \"ask\"\n");
  check("an unterminated multi-line string is a problem, never a reading",
    unterminated.mode === null && unterminated.problem !== null);

  const commentedOut = readPermissionMode("[ui]\n# permission_mode = \"always-approve\"\npermission_mode = \"ask\"\n");
  check("a commented-out key stays out", commentedOut.mode === "ask");

  const unbalanced = readPermissionMode("[ui]\npermission_mode = \"ask\"\nfoo = {\n");
  check("unbalanced braces at EOF are a problem, never a reading",
    unbalanced.mode === null && unbalanced.problem !== null);

  const dupSection = readPermissionMode("[ui]\nyolo = true\n[ui]\npermission_mode = \"ask\"\n");
  check("a duplicate [ui] section is ambiguous — a problem, never a merge",
    dupSection.mode === null && /two \[ui\] sections/.test(dupSection.problem || ""));

  const quotedKeyCheck = readPermissionMode("[ui]\n\"permission_mode\" = \"always-approve\"\nyolo = false\n");
  check("a quoted key is outside the whitelist — refused, never falls through to the legacy key",
    quotedKeyCheck.mode === null && quotedKeyCheck.problem !== null);

  const strayClose = readPermissionMode("[ui]\npermission_mode = \"ask\"\njunk = }\n");
  check("an unmatched closing bracket is a problem, never a confident read",
    strayClose.mode === null && strayClose.problem !== null);

  const strayCloseBracket = readPermissionMode("[ui]\npermission_mode = \"ask\"\njunk = ]\n");
  check("an unmatched closing square bracket likewise",
    strayCloseBracket.mode === null && strayCloseBracket.problem !== null);

  // ── retention (D81/D82/D88: three named fields inspected; two booleans leave) ──
  // Decoy token is intentional: the output must never contain it.
  const AUTH_FIXTURE = JSON.stringify({
    "https://auth.x.ai::decoy-account": {
      token: "DECOY_TOKEN_MUST_NEVER_LEAK",
      refresh: "DECOY_REFRESH_MUST_NEVER_LEAK",
      coding_data_retention_opt_out: true,
      team_blocked_reasons: [],
      expires_at: 9999999999,
    },
  });
  const r1 = readRetention(AUTH_FIXTURE);
  check("retentionOptOut reads from the account entry",
    r1.retentionOptOut === true);
  check("empty team_blocked_reasons derives isZdr=false (upstream default)",
    r1.isZdr === false);
  check("the output carries ONLY the two booleans and the problem slot",
    Object.keys(r1).sort().join(",") === "isZdr,problem,retentionOptOut");
  check("nothing token-shaped appears anywhere in the output",
    !JSON.stringify(r1).includes("DECOY"));
  check("the raw team_blocked_reasons list never leaves the reader",
    !JSON.stringify(r1).includes("team_blocked") && !JSON.stringify(r1).includes("BLOCKED_REASON"));

  const r2 = readRetention(JSON.stringify({ "https://auth.x.ai::a": { coding_data_retention_opt_out: true } }));
  check("absent team_blocked_reasons derives isZdr=false (not null — D88, upstream empty vec)",
    r2.retentionOptOut === true && r2.isZdr === false);

  const r3 = readRetention(JSON.stringify({ "https://auth.x.ai::a": {} }));
  check("both source fields absent: retentionOptOut null, isZdr false, no problem",
    r3.retentionOptOut === null && r3.isZdr === false && r3.problem === null);

  const r4 = readRetention("not json");
  check("unparseable auth.json is a problem, never a reading",
    r4.retentionOptOut === null && r4.isZdr === null && r4.problem !== null);

  const r5 = readRetention(JSON.stringify({ a: 42, b: "x" }));
  check("no object entries → problem, not a crash",
    r5.problem !== null);

  const r6 = readRetention(JSON.stringify({
    "https://auth.x.ai::one": { coding_data_retention_opt_out: false, team_blocked_reasons: ["BLOCKED_REASON_NO_LOGS"] },
    "https://auth.x.ai::two": { coding_data_retention_opt_out: true },
  }));
  check("two accounts is a problem — never one account's truth worn as the answer",
    r6.retentionOptOut === null && r6.isZdr === null && /more than one account/.test(r6.problem || ""));

  const r7 = readRetention(JSON.stringify({
    "https://auth.x.ai::a": { coding_data_retention_opt_out: false, team_blocked_reasons: [] },
  }));
  check("literal false retention + empty reasons: optOut false, isZdr false",
    r7.retentionOptOut === false && r7.isZdr === false);

  // ── D88: team_blocked_reasons derivation ──
  const rZdr = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      token: "DECOY_ZDR_TOKEN_MUST_NEVER_LEAK",
      coding_data_retention_opt_out: false,
      team_blocked_reasons: ["BLOCKED_REASON_NO_LOGS"],
    },
  }));
  check("BLOCKED_REASON_NO_LOGS derives isZdr=true",
    rZdr.isZdr === true && rZdr.retentionOptOut === false);
  check("ZDR fixture still drops the decoy token",
    !JSON.stringify(rZdr).includes("DECOY"));

  const rZdrMod = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      coding_data_retention_opt_out: true,
      team_blocked_reasons: ["BLOCKED_REASON_NO_LOGS_MODERATED"],
    },
  }));
  check("BLOCKED_REASON_NO_LOGS_MODERATED derives isZdr=true",
    rZdrMod.isZdr === true);

  const rBilling = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      coding_data_retention_opt_out: true,
      team_blocked_reasons: ["BLOCKED_REASON_BILLING"],
    },
  }));
  check("a non-ZDR blocked reason does NOT set isZdr",
    rBilling.isZdr === false);

  const rMixed = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      coding_data_retention_opt_out: true,
      team_blocked_reasons: ["BLOCKED_REASON_BILLING", "BLOCKED_REASON_NO_LOGS"],
    },
  }));
  check("ZDR reason among others still derives isZdr=true",
    rMixed.isZdr === true);

  // Legacy is_zdr field is structurally dead and must NOT be read (D88).
  const rLegacy = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      coding_data_retention_opt_out: true,
      is_zdr: true,
      team_blocked_reasons: [],
    },
  }));
  check("a legacy is_zdr field is ignored — derivation wins (empty reasons → false)",
    rLegacy.isZdr === false);

  const rBadReasons = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      coding_data_retention_opt_out: true,
      team_blocked_reasons: "BLOCKED_REASON_NO_LOGS",
    },
  }));
  check("a non-array team_blocked_reasons fails closed",
    rBadReasons.retentionOptOut === null && rBadReasons.isZdr === null && rBadReasons.problem !== null);

  const rBadElem = readRetention(JSON.stringify({
    "https://auth.x.ai::a": {
      coding_data_retention_opt_out: true,
      team_blocked_reasons: [42],
    },
  }));
  check("a non-string element in team_blocked_reasons fails closed",
    rBadElem.problem !== null && rBadElem.isZdr === null);

  // Multi-account with a decoy token on both: still fail closed, still no leak.
  const rMultiDecoy = readRetention(JSON.stringify({
    "https://auth.x.ai::one": {
      token: "DECOY_MULTI_ONE",
      coding_data_retention_opt_out: false,
      team_blocked_reasons: ["BLOCKED_REASON_NO_LOGS"],
    },
    "https://auth.x.ai::two": {
      token: "DECOY_MULTI_TWO",
      coding_data_retention_opt_out: true,
    },
  }));
  check("multi-account fail-closed yields null/null + problem",
    rMultiDecoy.retentionOptOut === null && rMultiDecoy.isZdr === null && rMultiDecoy.problem !== null);
  check("multi-account fail-closed never leaks a decoy token",
    !JSON.stringify(rMultiDecoy).includes("DECOY"));

  // ── file wrappers (temp fixtures only) ──
  const cfgPath = join(dir, "config.toml");
  writeFileSync(cfgPath, "[ui]\npermission_mode = \"always-approve\"\n");
  check("the config file wrapper reads",
    readPermissionModeFromFile(cfgPath).mode === "always-approve");

  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, AUTH_FIXTURE);
  check("the auth file wrapper reads retentionOptOut and derived isZdr, nothing else",
    readRetentionFromFile(authPath).retentionOptOut === true &&
    readRetentionFromFile(authPath).isZdr === false);

  check("a missing file is a problem sentence, not a throw",
    readPermissionModeFromFile(join(dir, "nope.toml")).problem !== null &&
    readRetentionFromFile(join(dir, "nope.json")).problem !== null);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} config-read checks passed`);
