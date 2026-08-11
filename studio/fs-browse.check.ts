// Deterministic checks for the folder picker's server side: directories only,
// no crawl, explicit unreadable/missing handling, and the configurable
// excluded-directory refusal (D50) through the one shared gate. Builds a real
// temp tree, asserts, and cleans it up. No network, no agent, no dependencies.

import { listDirectories, parseExcludedDirs, pathRefusal } from "./fs-browse.ts";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

let passed = 0;
function check(name: string, condition: unknown) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

const root = mkdtempSync(join(tmpdir(), "graphometer-fsbrowse-"));
const cleanup: string[] = [root];

try {
  // A tree: three subdirs with mixed case, a file, a nested dir, a symlink to a
  // dir, and a stand-in excluded directory to test the guard. No real machine
  // path is ever named here — the exclusion is configuration, not product code.
  mkdirSync(join(root, "b"));
  mkdirSync(join(root, "a"));
  mkdirSync(join(root, "C"));
  mkdirSync(join(root, "a", "deep")); // one level down — must NOT appear in root's listing
  writeFileSync(join(root, "file.txt"), "not a directory");
  writeFileSync(join(root, "a", "inside.txt"), "also not listed");
  let symlinkMade = true;
  try { symlinkSync(join(root, "a"), join(root, "link-to-a")); } catch { symlinkMade = false; }
  mkdirSync(join(root, "beings"));
  mkdirSync(join(root, "beings", "secret"));

  // ── directories only, sorted, no crawl ──
  const r = listDirectories(root);
  check("listing succeeds with no error", r.error === null && r.code === null);
  const names = r.entries.map((e) => e.name);
  check("directories are listed", names.includes("a") && names.includes("b") && names.includes("C"));
  check("a file is never listed as a directory", !names.includes("file.txt"));
  check("no descendant is listed — one level only (no crawl)", !names.includes("deep"));
  check("names are sorted case-insensitively", JSON.stringify(names.filter((n) => ["a", "b", "C"].includes(n))) === JSON.stringify(["a", "b", "C"]));
  check("every entry carries an absolute path under the listed folder",
    r.entries.every((e) => e.path === join(root, e.name)));
  check("the parent is the listed folder's dirname", r.parent === dirname(root));
  if (symlinkMade) {
    check("a symlink to a directory is not followed or offered", !names.includes("link-to-a"));
  }

  // ── the excluded-directory guard, on a stand-in root ──
  const excludedRoot = join(root, "beings");
  const EX = [excludedRoot];
  const g1 = listDirectories(excludedRoot, EX);
  check("listing an excluded root itself is refused", g1.code === "FORBIDDEN" && g1.entries.length === 0);
  check("the refusal still names a parent so the operator can step back up", g1.parent === root);
  const g2 = listDirectories(join(excludedRoot, "secret"), EX);
  check("listing a folder UNDER an excluded root is refused", g2.code === "FORBIDDEN" && g2.entries.length === 0);
  // The parent listing may still name the excluded folder (paths only).
  check("an excluded folder may still appear as a name in its parent's listing (paths only)",
    listDirectories(root, EX).entries.some((e) => e.name === "beings"));
  check("a sibling with an excluded-prefix name is NOT refused (boundary is path segments)",
    (() => { mkdirSync(join(root, "beingsX")); return listDirectories(join(root, "beingsX"), EX).error === null; })());

  // ── the shipped default excludes nothing ──
  check("with no configuration, nothing is excluded — the same folder lists fine",
    listDirectories(excludedRoot).error === null);

  // ── a symlink alias cannot smuggle the walk inside an excluded root ──
  let aliasMade = true;
  try { symlinkSync(excludedRoot, join(root, "alias-beings")); } catch { aliasMade = false; }
  if (aliasMade) {
    const gAlias = listDirectories(join(root, "alias-beings"), EX);
    check("a symlink alias to an excluded root is refused via realpath", gAlias.code === "FORBIDDEN");
  } else {
    console.log(`ok ${++passed} - symlink-alias case skipped (platform cannot symlink)`);
  }

  // ── a symlink alias plus a NON-EXISTENT tail is still refused ──
  // (the re-verification bypass: realpathSync throws on a missing final
  //  component, so the naive gate fell back to the literal string and let a
  //  session land, by the kernel, inside the excluded root. The fix
  //  canonicalises the longest existing prefix and re-appends the missing tail.)
  if (aliasMade) {
    const alias = join(root, "alias-beings");
    check("alias + a non-existent child is refused (longest-existing-prefix realpath)",
      pathRefusal(join(alias, "does-not-exist-yet"), EX)?.code === "FORBIDDEN");
    check("alias + a DEEP non-existent path is refused",
      pathRefusal(join(alias, "a", "b", "c"), EX)?.code === "FORBIDDEN");
    check("listing alias + a non-existent child is refused, not reported ENOENT",
      listDirectories(join(alias, "does-not-exist-yet"), EX).code === "FORBIDDEN");
    // A double hop (alias -> alias -> excluded) with a missing tail, too.
    let hopMade = true;
    try { symlinkSync(alias, join(root, "hop-beings")); } catch { hopMade = false; }
    if (hopMade) {
      check("a double-hop alias + non-existent child is refused",
        pathRefusal(join(root, "hop-beings", "nope"), EX)?.code === "FORBIDDEN");
    } else {
      console.log(`ok ${++passed} - double-hop case skipped (platform cannot symlink)`);
    }
    // And a symlinked ANCESTOR of the excluded root, tail missing.
    mkdirSync(join(root, "vialink"));
    let ancMade = true;
    try { symlinkSync(root, join(root, "vialink", "up")); } catch { ancMade = false; }
    if (ancMade) {
      check("a symlinked ancestor + non-existent excluded child is refused",
        pathRefusal(join(root, "vialink", "up", "beings", "nope"), EX)?.code === "FORBIDDEN");
    } else {
      console.log(`ok ${++passed} - symlinked-ancestor case skipped (platform cannot symlink)`);
    }
  } else {
    for (let i = 0; i < 5; i++) console.log(`ok ${++passed} - non-existent-tail alias cases skipped (platform cannot symlink)`);
  }

  // ── the fix must NOT over-block: a legitimate non-existent folder under a
  //    non-excluded parent is still allowed (you can start a session in a
  //    folder you are about to create). ──
  check("a non-existent child of an ORDINARY folder is still allowed",
    pathRefusal(join(root, "a", "brand-new-project"), EX) === null);
  check("a wholly non-existent, non-excluded path is allowed",
    pathRefusal(join(root, "no", "such", "place"), EX) === null);

  // ── the shared gate every path-accepting route uses (list and session/new
  //    cannot drift: this is the same function the server calls before creating
  //    or loading a session) ──
  check("pathRefusal refuses an excluded root", pathRefusal(excludedRoot, EX)?.code === "FORBIDDEN");
  check("pathRefusal refuses a child of an excluded root", pathRefusal(join(excludedRoot, "secret"), EX)?.code === "FORBIDDEN");
  if (aliasMade) {
    check("pathRefusal refuses a symlink alias to an excluded root",
      pathRefusal(join(root, "alias-beings"), EX)?.code === "FORBIDDEN");
  }
  check("pathRefusal allows an ordinary folder", pathRefusal(join(root, "a"), EX) === null);
  check("pathRefusal allows anything when nothing is excluded", pathRefusal(excludedRoot, []) === null);

  // ── NUL bytes are rejected before resolve, on every path-accepting surface ──
  check("a path carrying a NUL byte is rejected by the gate", pathRefusal("/x/\0/y", [])?.code === "EINVAL");
  const gNul = listDirectories("/x/\0/y", []);
  check("a NUL path never reaches readdir — the listing reports EINVAL", gNul.code === "EINVAL" && gNul.entries.length === 0);

  // ── the exclusion configuration parser ──
  check("parseExcludedDirs: absent configuration yields no exclusions",
    parseExcludedDirs(undefined).length === 0 && parseExcludedDirs(null).length === 0 && parseExcludedDirs("").length === 0);
  check("parseExcludedDirs: a single path parses and is guarded",
    parseExcludedDirs(excludedRoot).includes(excludedRoot));
  const multi = parseExcludedDirs(`${excludedRoot}: :${join(root, "a")}:`);
  check("parseExcludedDirs: colon-separated paths parse, blanks are dropped",
    multi.includes(excludedRoot) && multi.includes(join(root, "a")));
  check("parseExcludedDirs: a relative entry is dropped, never resolved against the process cwd",
    parseExcludedDirs("relative/path").length === 0);
  check("parseExcludedDirs: a non-canonical spelling still guards (resolve step is real)",
    pathRefusal(excludedRoot, parseExcludedDirs(join(excludedRoot, "..", "beings")))?.code === "FORBIDDEN");

  // ── the configured root itself may live behind a symlinked ancestor ──
  // (macOS /tmp → /private/tmp; a workspace moved behind a compatibility
  // link). The gate must recognise the CANONICAL spelling too, or the same
  // directory lists fine under its real path — the inverse of the alias case
  // above, and the panel-confirmed bypass this block pins shut.
  if (aliasMade) {
    const viaAlias = parseExcludedDirs(join(root, "alias-beings"));
    check("an exclusion configured through a symlink also guards the REAL path",
      pathRefusal(excludedRoot, viaAlias)?.code === "FORBIDDEN");
    check("…and a child under the real path is refused",
      pathRefusal(join(excludedRoot, "secret"), viaAlias)?.code === "FORBIDDEN");
    check("…and the configured symlink spelling itself stays refused",
      pathRefusal(join(root, "alias-beings"), viaAlias)?.code === "FORBIDDEN");
    check("…and listing the real path under a symlink-configured exclusion is refused",
      listDirectories(excludedRoot, viaAlias).code === "FORBIDDEN");
  } else {
    for (let i = 0; i < 4; i++) console.log(`ok ${++passed} - symlink-configured-exclusion case skipped (platform cannot symlink)`);
  }

  // ── explicit handling of missing and not-a-directory ──
  const missing = listDirectories(join(root, "does-not-exist-" + process.pid));
  check("a vanished folder is reported explicitly, not crashed on", missing.code === "ENOENT" && missing.error !== null && missing.entries.length === 0);
  const notDir = listDirectories(join(root, "file.txt"));
  check("a file path is reported as not-a-folder", notDir.code === "ENOTDIR" && notDir.entries.length === 0);

  // ── unreadable (permission denied), when the platform allows the setup ──
  const noread = join(root, "noread");
  mkdirSync(noread);
  mkdirSync(join(noread, "hidden"));
  let denied = false;
  try {
    chmodSync(noread, 0o000);
    const r2 = listDirectories(noread);
    // root can read anything; only assert when the chmod actually bit.
    if (r2.code === "EACCES") { denied = true; check("an unreadable folder is reported, not shown empty-but-fine", r2.error !== null && r2.entries.length === 0); }
  } catch { /* platform without POSIX perms — skip */ }
  finally { try { chmodSync(noread, 0o755); } catch {} }
  if (!denied) console.log(`ok ${++passed} - unreadable-folder case skipped (running as root or no POSIX perms)`);

  // ── empty path defaults to a readable home, never throws ──
  const home = listDirectories("");
  check("an empty path defaults to home and does not throw", typeof home.path === "string" && home.path.length > 0);
} finally {
  for (const p of cleanup) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
}

console.log(`\n${passed} fs-browse checks passed`);
