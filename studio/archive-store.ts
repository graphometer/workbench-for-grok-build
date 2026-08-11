// The archive list — a Graphometer-local "hidden from the rail" set (WP13 §2, D61).
//
// Grok Build has NO protocol method to hide a Build session: `Summary.hidden`
// exists and filters a session from every listing, but nothing SETS it on an
// existing session (SESSION_STORAGE_RESEARCH.md Q4). So "archive" here is
// entirely ours: a small list of session ids this app simply does not render.
// It deletes nothing, it touches nothing in Grok's storage, and it never speaks
// to the agent — archiving and restoring put ZERO calls on the ACP wire.
//
// This is the project's FIRST server-owned MUTABLE persisted state. `graphometer.env`
// is read-only config the server never writes; per-tab `sessionStorage` is the
// client's. So this file is new infrastructure, and it is built like it:
//
//   - It lives beside `graphometer.env` at the repository root, NOT under
//     `~/.grok/` — the config.toml / grok-storage invariants stay untouched, and
//     it is never the same path as CONFIG_PATH.
//   - Writes are ATOMIC: a temp file written in full, then renamed over the
//     target (rename is atomic within a filesystem), so an interrupted write
//     never leaves a half-written list that reads as corrupt-and-empty.
//   - Ids are HOSTILE by policy (rule 10). Membership is a Set of validated
//     strings, never keys on a plain object — `obj["__proto__"] = true` would hit
//     Object.prototype's setter and silently store nothing, the exact
//     wrong-but-silent class this project has already been bitten by. A Set has
//     no such accessor, and the on-disk form is a plain JSON array.

import { readFileSync, writeFileSync, renameSync } from "node:fs";

/**
 * A session id we will accept into the list. Session ids are UUIDv7 in practice,
 * but the id arrives in a POST body, so a hostile local caller could send
 * anything — bounded and control-char-free, mirroring the client's own
 * `safeStoredSessionId`. `__proto__` and friends are perfectly valid strings
 * here; the Set stores them as ordinary values.
 */
export function isValidArchiveId(x: unknown): x is string {
  return (
    typeof x === "string" &&
    x.length > 0 &&
    x.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(x)
  );
}

export class ArchiveStore {
  private ids = new Set<string>();
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  /** Read the list off disk. A missing or unreadable/invalid file is an empty
   *  list, never an error — the shipped default is "nothing archived". */
  private load(): void {
    let parsed: any;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.ids = new Set();
      return;
    }
    const arr = Array.isArray(parsed?.archived) ? parsed.archived : [];
    this.ids = new Set(arr.filter(isValidArchiveId));
  }

  /** Write the list atomically: full temp file, then rename over the target. */
  private persist(): void {
    const body = JSON.stringify({ archived: [...this.ids].sort() }, null, 2) + "\n";
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, this.path);
  }

  isArchived(id: string): boolean {
    return this.ids.has(id);
  }

  /** The archived ids, sorted. Raw — the CLIENT decides which of these still
   *  exist in the roster, so a session archived-then-deleted-elsewhere neither
   *  inflates the visible count nor shows a dead row (WP13 §2 honest-count). */
  list(): string[] {
    return [...this.ids].sort();
  }

  /** Add an id. Returns false if it was already archived (a no-op, not an error). */
  archive(id: string): boolean {
    if (!isValidArchiveId(id)) {
      const err: any = new Error("archive: not a valid session id");
      err.badRequest = true;
      throw err;
    }
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.persist();
    return true;
  }

  /** Remove an id. Returns false if it was not archived (a no-op, not an error). */
  restore(id: string): boolean {
    if (!isValidArchiveId(id)) {
      const err: any = new Error("restore: not a valid session id");
      err.badRequest = true;
      throw err;
    }
    if (!this.ids.has(id)) return false;
    this.ids.delete(id);
    this.persist();
    return true;
  }
}
