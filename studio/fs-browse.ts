// The folder picker's one job on the server: list the SUBDIRECTORIES of one
// path, and nothing else. No file contents, ever. No recursion, ever. This is
// the whole of the "directories-only browser" the charter asks for (WP5.5 / D47).
//
// It is a separate module for one reason: it is the security-sensitive part, so
// it is the part that gets tested directly. `studio/fs-browse.check.ts` drives
// these functions; `server.ts` only wires them to gated routes.
//
// The rules this file enforces, each one a line in the brief:
//   - directories only — a file is never listed, and a file's contents are never
//     read. `withFileTypes` + `isDirectory()`; symlinks are not followed.
//   - no crawl — exactly one `readdir` of the requested path. Never a descendant.
//   - excluded directories are off-limits — their *contents* are never listed,
//     and no session may be created or loaded inside one. The excluded set is
//     PER-MACHINE CONFIGURATION (`STUDIO_EXCLUDED_DIRS`), not product policy:
//     the product ships with no exclusions (D50). An excluded folder's name may
//     still appear as a row in a parent listing (paths only); attempting to open
//     it is refused before any read happens. The check is on the RESOLVED and,
//     where possible, the REALPATH of the target, so a symlink cannot smuggle
//     the walk inside. `pathRefusal` is the one shared gate for every
//     path-accepting route, so listing and session creation cannot drift apart.
//   - a path carrying a NUL byte is rejected before it is resolved.
//   - unreadable or vanished directories are reported explicitly, never crashed
//     on and never rendered as an empty-but-fine folder.

import { readdirSync, realpathSync } from "node:fs";
import { resolve as resolvePath, basename, dirname, isAbsolute, join, sep } from "node:path";
import { homedir } from "node:os";

export interface DirEntry {
  name: string;
  path: string;
}

export interface DirListing {
  /** The resolved absolute path that was listed (or attempted). */
  path: string;
  /** The parent directory, or null at the filesystem root. */
  parent: string | null;
  /** Subdirectories only, sorted case-insensitively. Empty on error. */
  entries: DirEntry[];
  /** A human sentence when the listing could not be produced, else null. */
  error: string | null;
  /** A short machine code (`ENOENT`, `EACCES`, `FORBIDDEN`, …) or null. */
  code: string | null;
}

function isUnder(target: string, base: string): boolean {
  return target === base || target.startsWith(base + sep);
}

/**
 * The canonical location a resolved path POINTS AT, even when its tail does not
 * exist yet. `realpathSync` throws the moment any component is missing, so
 * naively realpathing the whole string leaves a hole: `…/alias-to-beings/does-
 * not-exist-yet` (where `alias-to-beings` is a symlink into an excluded root)
 * fails to resolve, and only the literal, non-matching string is left to check.
 * A session started there lands, by the kernel, inside the excluded root.
 *
 * So we realpath the LONGEST EXISTING PREFIX and re-append the missing tail.
 * Once a component is absent, nothing below it exists either, so the tail is
 * purely literal path segments — no symlink can hide in it. This reads no
 * directory contents; it resolves path strings only.
 */
export function canonicalPath(target: string): string {
  let prefix = target;
  const tail: string[] = [];
  // Bounded by depth: dirname() strictly shortens until it hits the root, where
  // dirname(x) === x ends the loop.
  for (;;) {
    try {
      const real = realpathSync(prefix);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) return target; // reached the root unresolved — nothing to canonicalise
      tail.push(basename(prefix));
      prefix = parent;
    }
  }
}

/**
 * Parse the machine's excluded-directory configuration: colon-separated
 * ABSOLUTE paths. Absent, empty, relative, or malformed entries are dropped —
 * the shipped default is "nothing is excluded", and a relative entry would
 * silently resolve against whatever cwd the server was launched from, guarding
 * the wrong tree.
 *
 * Each root is kept in BOTH its resolved and its canonical (realpath) spelling.
 * Without the canonical form, an exclusion configured through a symlinked
 * ancestor (macOS `/tmp` → `/private/tmp`; a workspace moved behind a
 * compatibility link) would only be recognised under the spelling the operator
 * typed, and the same directory would list fine under its real path.
 */
export function parseExcludedDirs(value: string | undefined | null): string[] {
  if (typeof value !== "string") return [];
  const roots: string[] = [];
  for (const entry of value.split(":")) {
    const s = entry.trim();
    if (s === "" || s.includes("\0") || !isAbsolute(s)) continue;
    const resolved = resolvePath(s);
    if (!roots.includes(resolved)) roots.push(resolved);
    try {
      const real = realpathSync(resolved);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      /* the configured root does not exist right now — the resolved form still
         guards the spelling it was configured under */
    }
  }
  return roots;
}

/**
 * The one shared gate: why `requestedPath` may not be used at all, or null when
 * it may. Used by the listing route AND every session-creating/-loading route,
 * so the two can never drift. The NUL check runs before `resolve`; the excluded
 * check runs on BOTH the resolved string and the canonical location it points
 * at (`canonicalPath`, which resolves symlinks even through a not-yet-existing
 * tail), so no symlink alias — existing or not, shallow or deep — can smuggle a
 * walk or a session inside an excluded root. It reads no directory contents.
 */
export function pathRefusal(
  requestedPath: string,
  excluded: string[],
): { error: string; code: string } | null {
  if (requestedPath.includes("\0")) {
    return { error: "That path contains a forbidden character.", code: "EINVAL" };
  }
  if (excluded.length === 0) return null;
  const target = resolvePath(requestedPath);
  const real = canonicalPath(target);
  for (const root of excluded) {
    if (isUnder(target, root) || isUnder(real, root)) {
      return {
        error: "This folder is excluded on this machine and is never listed.",
        code: "FORBIDDEN",
      };
    }
  }
  return null;
}

/** A friendly sentence for the picker, from a Node fs error. */
function describe(err: NodeJS.ErrnoException): string {
  switch (err.code) {
    case "ENOENT":
      return "This folder no longer exists.";
    case "ENOTDIR":
      return "That path is not a folder.";
    case "EACCES":
    case "EPERM":
      return "This folder can't be read — permission denied.";
    case "ELOOP":
      return "This path loops through too many symbolic links.";
    default:
      return `This folder could not be read (${err.code ?? "unknown error"}).`;
  }
}

/**
 * List the subdirectories of `requestedPath`. When the path is empty or absent,
 * start at the user's home directory — a sensible, always-readable default.
 *
 * Always returns a `DirListing`; it never throws. `error` non-null means the
 * listing failed and `entries` is empty — the caller shows the sentence and lets
 * the operator step back up.
 */
export function listDirectories(
  requestedPath: string | undefined | null,
  excluded: string[] = [],
): DirListing {
  const raw =
    typeof requestedPath === "string" && requestedPath.trim() !== ""
      ? requestedPath
      : homedir();

  // The shared gate, before any resolve or read.
  const refusal = pathRefusal(raw, excluded);
  if (refusal) {
    const target = raw.includes("\0") ? raw : resolvePath(raw);
    const parent =
      refusal.code === "EINVAL" || dirname(target) === target ? null : dirname(target);
    return { path: target, parent, entries: [], error: refusal.error, code: refusal.code };
  }

  const target = resolvePath(raw);
  const parent = dirname(target) === target ? null : dirname(target);

  let dirents;
  try {
    // ONE readdir, of ONE path. No recursion. withFileTypes so a file never
    // needs a second syscall and is filtered here without reading anything.
    dirents = readdirSync(target, { withFileTypes: true });
  } catch (err) {
    return {
      path: target,
      parent,
      entries: [],
      error: describe(err as NodeJS.ErrnoException),
      code: (err as NodeJS.ErrnoException).code ?? "EUNKNOWN",
    };
  }

  const entries: DirEntry[] = [];
  for (const d of dirents) {
    // Directories only. A symlink reports isDirectory() === false, so symlinked
    // directories are intentionally not offered — the picker never follows one.
    // (D52: an evidence-backed v1 ruling, not an accident.)
    if (!d.isDirectory()) continue;
    entries.push({ name: d.name, path: join(target, d.name) });
  }
  entries.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  return { path: target, parent, entries, error: null, code: null };
}
