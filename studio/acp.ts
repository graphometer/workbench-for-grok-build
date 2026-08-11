// ACP client for Grok Build — newline-delimited JSON-RPC 2.0 over a child
// process's stdin/stdout.
//
// Design rule for this file: nothing fails quietly. Every parse failure, every
// stderr byte, every unanswered request and every unexpected message shape
// becomes a visible event. A silent hang is the failure mode we are guarding
// against, so where we cannot handle something we say so loudly rather than
// dropping it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";

export type EventKind =
  | "info" // lifecycle narration from this client
  | "wire-out" // a full JSON line we wrote to the agent's stdin
  | "wire-in" // a full JSON line we read from the agent's stdout
  | "stderr" // the agent wrote to stderr
  | "error" // something went wrong, and it is not being swallowed
  | "exit"; // the child process ended

export interface AcpEvent {
  seq: number;
  t: number;
  kind: EventKind;
  text: string;
  /**
   * Structured payload, for events whose text does not already contain it.
   *
   * `wire-in` and `wire-out` deliberately do NOT carry one: their `text` is
   * the complete JSON line, so attaching the parsed object stored every
   * message twice — once as a string and once as an object graph — and the
   * object copy is the more expensive of the two. Anything that wants the
   * structure can `JSON.parse(text)`. Nothing in this project did.
   */
  json?: unknown;
}

/** A JSON-RPC error returned by the agent, preserved with its code and data. */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;
  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`${method} failed: [${code}] ${message}`);
    this.name = "AcpRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
  startedAt: number;
}

// ── reading the process tree ────────────────────────────────────────────
//
// Used only to tell the truth at shutdown about what we did and did not
// manage to kill. Linux-specific by way of /proc; on anything else the check
// reports that it could not run rather than reporting a clean tree it never
// looked at.

interface ProcStat {
  ppid: number;
  pgrp: number;
  starttime: string;
}

export type ProcStatRead =
  | { status: "ok"; stat: ProcStat }
  | { status: "gone" }
  | { status: "unreadable"; reason: string };

/** The only filesystem boundary used for Linux process inspection. */
export interface ProcReader {
  listPids(): number[];
  readStat(pid: number): ProcStatRead;
  readCmdline(pid: number): string;
}

export function parseProcStat(raw: string): ProcStatRead {
  const close = raw.lastIndexOf(")");
  if (close === -1) {
    return { status: "unreadable", reason: "malformed stat: missing closing ')'" };
  }
  // After "<pid> (<comm>) " the next field is state, which is stat field 3.
  // So stat field N sits at index N-3 here: ppid=4 -> 1, pgrp=5 -> 2,
  // starttime=22 -> 19.
  const rest = raw.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const pgrp = Number(rest[2]);
  const starttime = rest[19];
  if (
    rest.length < 20 ||
    !Number.isInteger(ppid) ||
    ppid < 0 ||
    !Number.isInteger(pgrp) ||
    pgrp < 0 ||
    !/^\d+$/.test(starttime ?? "")
  ) {
    return { status: "unreadable", reason: "malformed stat fields" };
  }
  return { status: "ok", stat: { ppid, pgrp, starttime } };
}

export function classifyProcStatReadError(err: unknown): ProcStatRead {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return { status: "gone" };
  return {
    status: "unreadable",
    reason: `${code ?? "read failure"}: ${(err as Error).message}`,
  };
}

/** A process we saw in the agent's tree, pinned by start time so a recycled pid cannot impersonate it. */
export interface TrackedProc {
  pid: number;
  /** Field 22 of /proc/<pid>/stat — jiffies since boot. Unique per pid incarnation. */
  starttime: string;
  cmd: string;
}

/**
 * ppid, process group and start time for one pid.
 *
 * The comm field is parenthesised and may itself contain spaces and
 * parentheses — `(my (odd) name)` is legal — so everything is read relative to
 * the LAST ')' rather than by splitting the whole line.
 */
export const systemProcReader: ProcReader = {
  listPids() {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number);
  },

  readStat(pid: number): ProcStatRead {
    let raw: string;
    try {
      raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch (err) {
      return classifyProcStatReadError(err);
    }

    return parseProcStat(raw);
  },

  readCmdline(pid: number): string {
    try {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const joined = raw.split("\0").filter(Boolean).join(" ").trim();
      return joined || "(no cmdline — kernel thread or already exiting)";
    } catch {
      return "(cmdline unreadable)";
    }
  },
};

/** A request the agent sent to us. We must answer it or the agent waits forever. */
export interface ReverseRequest {
  id: number | string;
  method: string;
  params: any;
}

export interface AcpClientOptions {
  /** Working directory for the agent process and its session. */
  cwd: string;
  /** Executable to spawn. */
  command?: string;
  /** Arguments. Defaults to the direct, no-leader stdio agent. */
  args?: string[];
  /** Default per-request timeout in ms. `session/prompt` is exempt. */
  requestTimeoutMs?: number;
  /** Grace before generation cleanup escalates from SIGTERM to SIGKILL. */
  cleanupGraceMs?: number;
  /** Process inspection boundary. Production uses the real Linux /proc reader. */
  procReader?: ProcReader;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Methods that legitimately take as long as a human conversation. Not timed out. */
const UNTIMED_METHODS = new Set(["session/prompt"]);

/** Node reports signal deaths through `signalCode`, while `exitCode` stays null. */
function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

interface ChildGeneration {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pgid: number | null;
  rootStarttime: string | null;
  readonly tracked: Map<string, TrackedProc>;
  cleanup: Promise<GenerationCleanupResult> | null;
  cleanupComplete: boolean;
  groupEmpty: boolean;
  /** True only when ancestry was captured while the direct parent was alive. */
  ancestryCaptured: boolean;
}

export type GenerationGroupStatus = "empty" | "reused" | "original" | "unknown";

export type GenerationCleanupResult =
  | {
      clean: true;
      pgid: number | null;
      status: "empty" | "reused" | "no-group";
    }
  | {
      clean: false;
      pgid: number;
      status: "original" | "unknown";
      reason: string;
    };

// ── bounds ──────────────────────────────────────────────────────────────
//
// Everything below is an answer to "how much do we RETAIN", never to "how
// much will we accept". Nothing is dropped without an event that says so,
// counts what went, and stays in the log to be read later. A silent
// truncation would be the same class of failure as a silent hang.
//
// Sizes are in UTF-16 characters, not bytes, because both pipes are read with
// setEncoding("utf8") and we measure the strings we actually hold.

/**
 * Longest single newline-terminated frame we will parse. The largest real
 * frame seen on the wire is the slash-command catalogue at roughly 10 KB, so
 * this is ~800x headroom — big enough for a `session/load` replay or a large
 * diff, small enough that a hostile or broken peer cannot exhaust memory with
 * one line. Also caps the unframed buffer: a partial line already past this
 * length can never become an acceptable frame.
 */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

/**
 * How much stderr we will hold while waiting for a newline. stderr carries
 * human-readable diagnostics with no framing contract, so a partial line can
 * be flushed early without losing meaning — a quarter-megabyte with no
 * newline is already pathological.
 */
const MAX_STDERR_CHARS = 256 * 1024;

/** How much of an over-long stderr run we keep when flushing it early. */
const STDERR_KEEP_CHARS = 8 * 1024;

/**
 * Retained event log. 2000 events comfortably covers a long working session's
 * narrative — the whole acceptance run is about 40 — while the character cap
 * is the one that actually binds: a handful of very large frames would blow
 * past a count-only limit long before 2000 events accumulated.
 */
const LOG_MAX_EVENTS = 2000;
const LOG_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Largest structured payload retained on a single event. Applies only to
 * `note()`/`loud()` extras, since wire events carry no payload at all; keeps
 * the character accounting for LOG_MAX_CHARS honest rather than approximate.
 */
const MAX_EVENT_JSON_CHARS = 64 * 1024;

export class AcpClient extends EventEmitter {
  private generation: ChildGeneration | null = null;
  /** Includes the current live generation and any older generation not yet proven clean. */
  private readonly retainedGenerations = new Set<ChildGeneration>();
  private stdoutBuf = "";
  private stderrBuf = "";
  /** Set while an over-long stdout line is being thrown away up to its newline. */
  private discardingLine = false;
  private discardedChars = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private shuttingDown = false;
  /** How many replacement children have been spawned on this client. See restart(). */
  restarts = 0;
  private deathSeqCounter = 0;
  /**
   * The synchronous terminal marker (Codex WP12 CONFIRM3): bumped at the very
   * top of the exit handler, BEFORE failAllPending releases pending awaits —
   * the `gone` emission (and the manager's generation bump) is deferred
   * behind cleanup, so this is the only boundary a resumed recovery loop can
   * see in that window. Read-only to the outside (Codex CONFIRM4): the
   * counter is private and only the exit handler moves it — never
   * decremented, never reset across restarts (a new lifetime is a new death
   * away, and the comparison is equality, not currency).
   */
  get deathSeq(): number {
    return this.deathSeqCounter;
  }
  /** When we last heard anything at all from the agent. Used to spot a wedge. */
  lastInboundAt = Date.now();

  readonly cwd: string;
  readonly command: string;
  readonly args: string[];
  private readonly requestTimeoutMs: number;
  private readonly cleanupGraceMs: number;
  private readonly procReader: ProcReader;

  /**
   * The recent past, so a browser connecting late sees the story in progress.
   * Bounded — see LOG_MAX_EVENTS / LOG_MAX_CHARS. What falls off the front is
   * counted in `droppedEvents`, never discarded quietly: a late reader is told
   * how much it cannot see, and the gap is visible in the `seq` numbers too.
   */
  readonly log: AcpEvent[] = [];
  /** Retained characters across `log`, kept incrementally so trimming is cheap. */
  private logChars = 0;
  /** Per-event retained cost, in lockstep with `log`, so eviction subtracts exactly what it added. */
  private readonly logCosts: number[] = [];
  /** How many events have aged out of `log`, and how much text went with them. */
  droppedEvents = 0;
  droppedEventChars = 0;

  constructor(opts: AcpClientOptions) {
    super();
    this.cwd = opts.cwd;
    this.command = opts.command ?? "grok";
    this.args = opts.args ?? ["agent", "--no-leader", "stdio"];
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cleanupGraceMs = opts.cleanupGraceMs ?? 3000;
    this.procReader = opts.procReader ?? systemProcReader;
  }

  get pid(): number | undefined {
    const generation = this.generation;
    return generation && !childHasExited(generation.child) ? generation.child.pid : undefined;
  }

  get alive(): boolean {
    return this.generation !== null && !childHasExited(this.generation.child);
  }

  get retainedGenerationPgids(): number[] {
    return [...this.retainedGenerations]
      .map((generation) => generation.pgid)
      .filter((pgid): pgid is number => pgid !== null);
  }

  // ── event plumbing ────────────────────────────────────────────────────

  private emitEvent(kind: EventKind, text: string, json?: unknown): AcpEvent {
    let payload = json;
    let payloadChars = 0;

    if (json !== undefined) {
      let serialized: string;
      try {
        serialized = JSON.stringify(json) ?? "undefined";
      } catch (err) {
        // A cycle, or a BigInt. Say so on the event rather than throwing from
        // inside the logging path, which would be an absurd way to die.
        serialized = "";
        payload = { truncated: true, reason: `not serializable: ${(err as Error).message}` };
      }
      payloadChars = serialized.length;
      if (payloadChars > MAX_EVENT_JSON_CHARS) {
        payload = {
          truncated: true,
          originalChars: payloadChars,
          retainedChars: MAX_EVENT_JSON_CHARS,
          head: serialized.slice(0, MAX_EVENT_JSON_CHARS),
        };
        payloadChars = MAX_EVENT_JSON_CHARS;
        text = `${text}  [structured payload truncated: ${serialized.length} chars, kept ${MAX_EVENT_JSON_CHARS}]`;
      }
    }

    const ev: AcpEvent = { seq: ++this.seq, t: Date.now(), kind, text, json: payload };
    const cost = text.length + payloadChars;
    this.log.push(ev);
    this.logCosts.push(cost);
    this.logChars += cost;
    this.trimLog();
    this.emit("event", ev);
    return ev;
  }

  /** Age the oldest events out until the log is inside both bounds. */
  private trimLog() {
    while (
      this.log.length > 0 &&
      (this.log.length > LOG_MAX_EVENTS || this.logChars > LOG_MAX_CHARS)
    ) {
      this.log.shift();
      const cost = this.logCosts.shift() ?? 0;
      this.logChars -= cost;
      this.droppedEvents++;
      this.droppedEventChars += cost;
    }
  }

  /** Public so the server can narrate its own steps into the same stream. */
  note(text: string, json?: unknown) {
    return this.emitEvent("info", text, json);
  }

  loud(text: string, json?: unknown) {
    return this.emitEvent("error", text, json);
  }

  // ── process lifecycle ─────────────────────────────────────────────────

  start(): void {
    if (this.generation) throw new Error("already started");
    this.spawnChild();
  }

  /**
   * Spawn a replacement child on this same client, after the previous one died.
   *
   * Deliberately NOT "construct a new AcpClient": `log`, `seq`, `droppedEvents`
   * and `nextId` all survive. The log is the BRIDGE's narrative, not the
   * child's — a browser watching the stream should see "agent died, agent
   * respawned" as one continuous story, and the SSE replay contract promises
   * that a gap is visible in the `seq` numbers. A fresh client would restart
   * `seq` at 1 and quietly break that promise.
   *
   * `nextId` also carries over on purpose. A response from the OLD child that
   * arrives after the new one is up cannot then collide with a live request id;
   * it lands on an id we have already settled and is reported as "response for
   * unknown request id" rather than resolving somebody else's promise.
   */
  restart(): void {
    if (this.alive) {
      throw new Error("the current child is still running");
    }
    if (
      this.generation !== null &&
      (!this.generation.cleanupComplete || !this.generation.groupEmpty)
    ) {
      throw new Error("the terminal child generation has not finished cleanup");
    }
    if (this.shuttingDown) throw new Error("this client is shutting down");

    // The old child's buffers are dead data. Anything unterminated in them was
    // already reported by the exit handler; carrying it forward would splice
    // one child's half-line onto the next child's first line.
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.discardingLine = false;
    this.discardedChars = 0;
    this.generation = null;
    this.restarts++;

    this.emitEvent("info", `respawning the agent process (restart #${this.restarts})`);
    this.spawnChild();
  }

  private spawnChild(): void {
    this.emitEvent(
      "info",
      `spawning: ${this.command} ${this.args.join(" ")}  (cwd: ${this.cwd})`,
    );

    // No shell. Inherit the environment so the agent finds its own auth the way
    // it normally does — we never read or forward the token ourselves.
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // Give the agent a process group of its own, with a group id equal to
      // its pid. A run was observed to spawn a second, short-lived grok
      // process; signalling only the direct child leaves any such grandchild
      // orphaned and still holding the session. With a group of its own we can
      // signal every process still in that original group — see signalGroup().
      //
      // The cost of detaching: the child no longer shares our process group,
      // so a signal sent to the terminal's foreground group (Ctrl-C, or the
      // SIGHUP from closing the window) no longer reaches it for free. The
      // server handles SIGINT, SIGTERM and SIGHUP and kills the group itself,
      // and 'exit' calls killNow() as a backstop.
      detached: true,
    });
    const typedChild = child as ChildProcessWithoutNullStreams;
    const initialRootStat = child.pid === undefined
      ? { status: "gone" } as const
      : this.procReader.readStat(child.pid);
    const generation: ChildGeneration = {
      child: typedChild,
      pgid: child.pid ?? null,
      rootStarttime: initialRootStat.status === "ok" ? initialRootStat.stat.starttime : null,
      tracked: new Map(),
      cleanup: null,
      cleanupComplete: false,
      groupEmpty: false,
      ancestryCaptured: false,
    };
    this.generation = generation;
    this.retainedGenerations.add(generation);
    this.captureGeneration(generation);

    child.on("error", (err) => {
      this.loud(`failed to spawn '${this.command}': ${err.message}`);
      /* A spawn that failed BEFORE a process existed (no pgid was ever
         assigned) is trivially clean — nothing to kill, nothing to verify.
         Mark it, or the corpse that never lived locks the respawn door
         forever: restart() refuses while the terminal generation's cleanup
         is incomplete, and the 'exit' that drives cleanup never fires for a
         spawn error (found by WP10's Try again, live). A kill-failure error
         on a live child has a pgid and is untouched — restart() still
         refuses while anything lives. */
      if (generation.pgid === null) {
        generation.cleanupComplete = true;
        generation.groupEmpty = true;
        this.retainedGenerations.delete(generation);
      }
      this.failAllPending(new Error(`agent process error: ${err.message}`));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.generation !== generation || childHasExited(generation.child)) {
        this.loud(
          `ignoring ${chunk.length} character(s) of stdout from terminal or retired ` +
            `generation pgid ${generation.pgid}; old protocol bytes cannot enter a replacement`,
        );
        return;
      }
      this.onStdout(chunk);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (this.generation !== generation || childHasExited(generation.child)) {
        this.emitEvent(
          "stderr",
          `[terminal or retired generation pgid ${generation.pgid}] ${chunk.trim()}`,
        );
        return;
      }
      this.onStderr(chunk);
    });

    // If the agent dies mid-write, the pipe raises EPIPE. Without this handler
    // that surfaces as an unhandled stream error and takes the server down
    // with a stack trace instead of a sentence.
    child.stdin.on("error", (err) => {
      this.loud(`write to agent stdin failed: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      /* The SYNCHRONOUS terminal marker, set before anything else (Codex WP12
         CONFIRM3). failAllPending below releases recovery awaits
         SYNCHRONOUSLY, while the `gone` emission — and with it the manager's
         agentGeneration bump — is deferred behind generation cleanup. A
         recovery loop resumed in that window must be able to see that its
         lifetime ended: this marker moves before any pending rejection is
         delivered. (The spawn-error path does not bump it: that child never
         lived, so no lifetime ended.) */
      this.deathSeqCounter++;
      // Capture synchronously. After an externally killed parent is reaped,
      // in-group members remain identifiable by PGID, but escaped descendants
      // may already have lost the only ancestry that connected them to us.
      this.captureGeneration(generation);
      const how = signal ? `signal ${signal}` : `code ${code}`;
      this.emitEvent("exit", `agent process (pid ${child.pid}) exited: ${how}`);

      // A half-received line at exit is data we were given and lost. Say so
      // rather than letting it disappear.
      if (this.stdoutBuf.trim() !== "") {
        this.loud(
          `agent exited with ${this.stdoutBuf.length} bytes of unterminated stdout — discarded`,
          { partial: this.stdoutBuf.slice(0, 2000) },
        );
        this.stdoutBuf = "";
      }
      if (this.discardingLine) {
        this.loud(
          `agent exited midway through an over-long line — ${this.discardedChars} characters ` +
            `had already been discarded and the line never completed`,
        );
        this.discardingLine = false;
        this.discardedChars = 0;
      }
      if (this.stderrBuf.trim() !== "") {
        this.emitEvent("stderr", this.stderrBuf.trim());
        this.stderrBuf = "";
      }

      // Anything still in flight will never be answered. Say so.
      this.failAllPending(
        new Error(`agent process exited (${how}) with the request still in flight`),
      );
      void this.cleanupGeneration(generation).then(
        () => this.emit("gone", { code, signal, pgid: generation.pgid }),
        (err) => {
          this.loud(
            `generation cleanup itself failed for pgid ${generation.pgid}: ` +
              `${(err as Error).stack ?? err}`,
          );
          this.emit("gone", { code, signal, pgid: generation.pgid });
        },
      );
    });

    this.emitEvent(
      "info",
      `agent process started — pid ${child.pid}`,
      { pid: child.pid },
    );
  }

  private onStdout(chunk: string) {
    // Mid-discard: an over-long line is being thrown away and we are looking
    // for the newline that ends it. Everything before that newline is gone,
    // and the count of what went is reported when we resynchronise.
    if (this.discardingLine) {
      const nl = chunk.indexOf("\n");
      if (nl === -1) {
        this.discardedChars += chunk.length;
        return;
      }
      this.discardedChars += nl + 1;
      this.loud(
        `resynchronised on the next newline after an over-long line — ` +
          `${this.discardedChars} characters were discarded and never parsed`,
      );
      this.discardingLine = false;
      this.discardedChars = 0;
      chunk = chunk.slice(nl + 1);
    }

    // Messages split across reads. Keep the tail until a newline completes it.
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      // A complete frame can still be far too big to parse and retain. The
      // old guard only watched the UNFRAMED tail, so one enormous
      // newline-terminated message walked straight past it.
      if (line.length > MAX_LINE_CHARS) {
        this.loud(
          `refusing a ${line.length}-character frame from agent stdout ` +
            `(limit ${MAX_LINE_CHARS}) — not parsed, not retained. If it was a ` +
            `response, the request it answers will now time out.`,
          { head: line.slice(0, 500) },
        );
        continue;
      }
      const trimmed = line.trim();
      if (trimmed === "") continue;
      this.onLine(trimmed);
    }

    // No newline yet and the partial line is already over the limit, so it can
    // never become an acceptable frame. Stop holding it, and skip to the next
    // newline rather than letting the remainder arrive as a cascade of parse
    // errors. This is also the old never-sends-a-newline guard, at one shared
    // limit instead of two unrelated ones.
    if (this.stdoutBuf.length > MAX_LINE_CHARS) {
      this.loud(
        `a single line from agent stdout passed ${MAX_LINE_CHARS} characters with no ` +
          `newline — discarding it and resynchronising at the next newline`,
        { head: this.stdoutBuf.slice(0, 500) },
      );
      this.discardingLine = true;
      this.discardedChars = this.stdoutBuf.length;
      this.stdoutBuf = "";
    }
  }

  private onStderr(chunk: string) {
    this.stderrBuf += chunk;
    let nl: number;
    while ((nl = this.stderrBuf.indexOf("\n")) !== -1) {
      const line = this.stderrBuf.slice(0, nl).trim();
      this.stderrBuf = this.stderrBuf.slice(nl + 1);
      if (line) this.emitEvent("stderr", line);
    }
    // A child that writes to stderr and never emits a newline used to grow
    // this buffer with no limit at all. stderr has no framing contract, so a
    // partial line can be flushed early without losing meaning — flush what we
    // will keep, say how much we threw away, and start again.
    if (this.stderrBuf.length > MAX_STDERR_CHARS) {
      const total = this.stderrBuf.length;
      this.emitEvent(
        "stderr",
        `${this.stderrBuf.slice(0, STDERR_KEEP_CHARS)}\n` +
          `[truncated — ${total} characters of stderr arrived with no newline; ` +
          `kept ${STDERR_KEEP_CHARS}, discarded ${total - STDERR_KEEP_CHARS}]`,
      );
      this.stderrBuf = "";
    }
  }

  private onLine(line: string) {
    this.lastInboundAt = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      // Do not swallow. A line we cannot parse is a protocol problem.
      this.loud(
        `unparseable line from agent stdout: ${(err as Error).message}`,
        { raw: line.slice(0, 4000) },
      );
      return;
    }

    // A line that parses is not the same as a line that is a message.
    // JSON.parse("null") succeeds and yields null; so do "42", "\"s\"",
    // "true" and "[1,2]". None of them is a JSON-RPC frame, and every one of
    // them used to reach the router below, where the first property access on
    // null threw a TypeError. That throw escaped the stdout data callback,
    // reached process 'uncaughtException', and shut down the server AND the
    // agent. One malformed line killed the bridge:
    //
    //   TypeError: Cannot read properties of null (reading 'id')
    //       at AcpClient.onLine  ->  onStdout  ->  Socket.emit
    //
    // A frame that is not a plain object is now treated exactly like a line
    // that would not parse: loud, and survivable.
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      const what = msg === null ? "null" : Array.isArray(msg) ? "an array" : typeof msg;
      this.loud(
        `ignoring a line from agent stdout that parsed to ${what} rather than a JSON-RPC object`,
        { raw: line.slice(0, 4000) },
      );
      return;
    }

    this.emitEvent("wire-in", line);

    try {
      this.route(msg);
    } catch (err) {
      // The same failure mode one level up. Routing emits events whose
      // listeners run synchronously, so a throw anywhere downstream — a bug in
      // a permission handler, an unexpected shape we did not anticipate —
      // would otherwise escape this callback and end the process by the same
      // path. Loud, not fatal; the stack is kept so it is still debuggable.
      this.loud(
        `failed to route a message from the agent: ${(err as Error).stack ?? err}`,
        { raw: line.slice(0, 4000) },
      );
    }
  }

  private route(msg: any) {
    const hasId = msg.id !== undefined && msg.id !== null;

    if (hasId && typeof msg.method === "string") {
      // Direction 3: the agent is asking us something. This is where clients hang.
      this.emit("reverseRequest", {
        id: msg.id,
        method: msg.method,
        params: msg.params,
      } as ReverseRequest);
      return;
    }

    if (hasId) {
      // A response to something we sent.
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) {
        this.loud(`response for unknown request id ${msg.id} — ignoring`, msg);
        return;
      }
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);

      if (msg.error) {
        p.reject(
          new AcpRpcError(
            p.method,
            msg.error.code ?? -1,
            msg.error.message ?? "(no message)",
            msg.error.data,
          ),
        );
      } else {
        p.resolve(msg.result);
      }
      return;
    }

    if (typeof msg.method === "string") {
      // Direction 2: a notification the agent pushed.
      this.emit("notification", msg);
      return;
    }

    this.loud("message with neither id nor method — cannot route", msg);
  }

  // ── sending ───────────────────────────────────────────────────────────

  private write(obj: unknown) {
    const generation = this.generation;
    if (!generation || !this.alive) {
      throw new Error("agent process is not running");
    }
    const line = JSON.stringify(obj);
    this.emitEvent("wire-out", line); // the line IS the payload; see AcpEvent.json
    generation.child.stdin.write(line + "\n");
  }

  /** Send a request and wait for its response. */
  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const limit = timeoutMs ?? (UNTIMED_METHODS.has(method) ? 0 : this.requestTimeoutMs);

      const pending: Pending = {
        method,
        resolve,
        reject,
        timer: null,
        startedAt: Date.now(),
      };

      if (limit > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          const err = new Error(
            `${method} timed out after ${limit} ms with no response (request id ${id})`,
          );
          this.loud(err.message);
          reject(err);
        }, limit);
      }

      this.pending.set(id, pending);

      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        this.loud(`could not send ${method}: ${(err as Error).message}`);
        reject(err as Error);
      }
    });
  }

  /** Send a notification — no response expected. */
  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** Answer a reverse request the agent sent us. */
  respond(id: number | string, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  /** Answer a reverse request with an error, so the agent is unblocked and knows why. */
  respondError(id: number | string, code: number, message: string, data?: unknown) {
    this.loud(`refusing reverse request ${id}: ${message}`);
    this.write({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  private failAllPending(err: Error) {
    if (this.pending.size === 0) return;
    const methods = [...this.pending.values()].map((p) => p.method).join(", ");
    this.loud(`${this.pending.size} in-flight request(s) abandoned: ${methods}`);
    for (const [id, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  // ── killing the process group, which is not the same as the whole tree ──
  //
  // Because we spawned detached, the child leads a process group whose id is
  // its own pid, and a negative pid signals every member of that group. That
  // is how we reach a grandchild the agent spawned, and it is the strongest
  // guarantee available without cgroups.
  //
  // It is NOT a guarantee that the whole tree dies, and this project claimed
  // that it was. Process group membership is a property a process can change:
  // a descendant that calls setsid(), or setpgid() into a group of its own, or
  // that double-forks and daemonizes, is no longer in our group and a signal
  // to -pgid will never reach it. Nothing here can prevent that. What we can
  // do is stop being silent about it — snapshotTree() records the tree before
  // we start killing, and survivorsOf() checks afterwards which of those
  // processes are still running, so a survivor is reported by pid instead of
  // being quietly left behind.
  //
  // The snapshot has to be taken BEFORE the kill, because that is the only
  // moment the evidence exists: once the agent is dead its descendants are
  // reparented to init and the ppid chain that identifies them as ours is gone.
  //
  // A numeric PGID can eventually be reused after the original group empties.
  // Before signalling, PID/start-time checks reduce the chance that a reused
  // numeric PGID is mistaken for this generation. Inspection and signalling
  // are separate syscalls, however, so they cannot make that check kernel-
  // atomic. The same identity pin reduces ordinary PID-reuse errors in survivor
  // reporting; it does not eliminate the race between a check and later use.

  /**
   * Every process that is either in the agent's process group or descended
   * from it, right now. Empty on a platform without /proc, which the caller
   * distinguishes from "nothing to report".
   */
  private snapshotTree(rootPid: number): TrackedProc[] | null {
    if (process.platform !== "linux") return null;
    let pids: number[];
    try {
      pids = this.procReader.listPids();
    } catch {
      return null;
    }

    const stats = new Map<number, ProcStat>();
    for (const pid of pids) {
      const read = this.procReader.readStat(pid);
      if (read.status === "ok") stats.set(pid, read.stat);
      else if (read.status === "unreadable") return null;
    }

    // Both tests, because they disagree exactly where this matters: setsid()
    // leaves the group while the parent link survives, and a process we
    // adopted into the group might not be a descendant at all.
    const isDescendant = (pid: number): boolean => {
      let cur = pid;
      for (let hops = 0; cur > 1 && hops < 64; hops++) {
        if (cur === rootPid) return true;
        const s = stats.get(cur);
        if (!s) return false;
        cur = s.ppid;
      }
      return false;
    };

    const out: TrackedProc[] = [];
    for (const [pid, s] of stats) {
      if (pid === rootPid || s.pgrp === rootPid || isDescendant(pid)) {
        out.push({ pid, starttime: s.starttime, cmd: this.procReader.readCmdline(pid) });
      }
    }
    return out;
  }

  /** Which of a snapshot's processes are still running, and still the same process. */
  private survivorsOf(snapshot: TrackedProc[]): {
    alive: TrackedProc[];
    unreadable: TrackedProc[];
  } {
    const alive: TrackedProc[] = [];
    const unreadable: TrackedProc[] = [];
    for (const p of snapshot) {
      const read = this.procReader.readStat(p.pid);
      // Same pid AND same start time. Without the start-time check, a pid the
      // kernel had already recycled would be reported as a surviving agent
      // process — a scarier lie than the silence this check exists to end.
      if (read.status === "ok" && read.stat.starttime === p.starttime) alive.push(p);
      else if (read.status === "unreadable") unreadable.push(p);
    }
    return { alive, unreadable };
  }

  /** Signal the agent's whole process group. Returns false if there was nothing to signal. */
  private signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
    try {
      process.kill(-pgid, sig);
      return true;
    } catch (err) {
      // ESRCH means the group is already gone, which is the outcome we wanted.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
        this.loud(`could not send ${sig} to process group ${pgid}: ${(err as Error).message}`);
      }
      return false;
    }
  }

  /** Merge visible evidence and say whether the original root was still identifiable. */
  private captureGeneration(generation: ChildGeneration): boolean {
    if (generation.pgid === null || process.platform !== "linux") return false;
    const snapshot = this.snapshotTree(generation.pgid);
    if (snapshot === null) return false;
    const root = snapshot.find((proc) => proc.pid === generation.pgid);
    if (
      generation.rootStarttime === null &&
      root &&
      !childHasExited(generation.child)
    ) {
      generation.rootStarttime = root.starttime;
    }
    for (const proc of snapshot) {
      generation.tracked.set(`${proc.pid}:${proc.starttime}`, proc);
    }
    return generation.rootStarttime !== null && root?.starttime === generation.rootStarttime;
  }

  /** Current members that are pinned to identities observed in this generation. */
  private liveGroupMembers(generation: ChildGeneration): TrackedProc[] {
    if (generation.pgid === null) return [];
    return [...generation.tracked.values()].filter((proc) => {
      const read = this.procReader.readStat(proc.pid);
      return read.status === "ok" &&
        read.stat.starttime === proc.starttime &&
        read.stat.pgrp === generation.pgid;
    });
  }

  /**
   * Inspect the numeric PGID without confusing a later reuse for our group.
   * A newly created process group must have a live leader whose pid equals the
   * PGID; a different start time on that leader proves the number was reused.
   */
  private inspectGenerationGroup(
    generation: ChildGeneration,
  ): GenerationGroupStatus {
    if (generation.pgid === null) return "empty";
    if (process.platform !== "linux") return "unknown";

    let pids: number[];
    try {
      pids = this.procReader.listPids();
    } catch {
      return "unknown";
    }

    const members: TrackedProc[] = [];
    for (const pid of pids) {
      const read = this.procReader.readStat(pid);
      if (read.status === "unreadable") return "unknown";
      if (read.status === "ok" && read.stat.pgrp === generation.pgid) {
        members.push({
          pid,
          starttime: read.stat.starttime,
          cmd: this.procReader.readCmdline(pid),
        });
      }
    }
    if (members.length === 0) return "empty";

    const leader = members.find((proc) => proc.pid === generation.pgid);
    const knownMember = members.some((proc) =>
      generation.tracked.has(`${proc.pid}:${proc.starttime}`),
    );
    if (leader) {
      if (generation.rootStarttime === null) {
        if (!knownMember) return "unknown";
      } else if (leader.starttime !== generation.rootStarttime) {
        return "reused";
      }
    } else if (!knownMember) {
      // A group can outlive its leader. Without a pinned member there is no
      // safe way to distinguish an original late member from a leaderless
      // group that reused the same number, so do not signal or call it empty.
      return "unknown";
    }

    for (const proc of members) {
      generation.tracked.set(`${proc.pid}:${proc.starttime}`, proc);
    }
    return "original";
  }

  private signalGeneration(generation: ChildGeneration, sig: NodeJS.Signals): boolean {
    if (generation.pgid === null) return false;
    const status = this.inspectGenerationGroup(generation);
    if (status === "original") return this.signalGroup(generation.pgid, sig);
    if (status === "unknown") {
      // The ChildProcess object is an identity anchor for its own original
      // group while that direct child is alive, even if /proc enumeration is
      // unavailable. After it is terminal, require a pinned readable member.
      const directChildAnchorsGroup =
        !childHasExited(generation.child) && generation.child.pid === generation.pgid;
      if (directChildAnchorsGroup || this.liveGroupMembers(generation).length > 0) {
        return this.signalGroup(generation.pgid, sig);
      }
    }
    return false;
  }

  private async waitForGroupEmpty(
    generation: ChildGeneration,
    timeoutMs: number,
  ): Promise<GenerationGroupStatus> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const status = this.inspectGenerationGroup(generation);
      if (status === "empty" || status === "reused") return status;
      if (Date.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** One immutable generation, one cleanup operation and one survivor report. */
  private cleanupGeneration(generation: ChildGeneration, graceMs = this.cleanupGraceMs) {
    if (generation.cleanup) return generation.cleanup;
    // This synchronous snapshot is the important one. If cleanup begins while
    // the parent is alive, parent links can still reveal escapees. If an
    // external signal already killed it, group members remain visible but an
    // escapee may have been reparented and become impossible to attribute.
    const parentAlive = !childHasExited(generation.child);
    const rootCaptured = this.captureGeneration(generation);
    if (parentAlive && rootCaptured) generation.ancestryCaptured = true;
    // Install the promise before any signal can produce an exit callback.
    generation.cleanup = Promise.resolve().then(async () => {
      const pgid = generation.pgid;
      let status: GenerationGroupStatus | "no-group" = pgid === null ? "no-group" : "unknown";

      if (pgid === null) {
        this.emitEvent(
          "info",
          "generation cleanup: the child never acquired a PID, so no process group existed",
        );
      } else {
        this.emitEvent("info", `cleaning agent generation (pgid ${pgid}) — SIGTERM`);
        this.signalGeneration(generation, "SIGTERM");
        status = await this.waitForGroupEmpty(generation, graceMs);
        if (status !== "empty" && status !== "reused") {
          if (status === "original") {
            this.loud(
              `process group ${pgid} still had members after SIGTERM — sending SIGKILL to the group`,
            );
          } else {
            this.loud(
              `could not verify process group ${pgid} after SIGTERM because /proc inspection ` +
                `was incomplete — attempting SIGKILL only if the original group still has a ` +
                `live identity anchor`,
            );
          }
          const signalled = this.signalGeneration(generation, "SIGKILL");
          if (!signalled && status === "unknown") {
            this.loud(
              `did not signal unverified process group ${pgid}: neither the live original child ` +
                `nor a pinned live member established that the numeric PGID still belongs to ` +
                `this generation`,
            );
          }
          status = await this.waitForGroupEmpty(generation, 1000);
        }

        if (status === "empty") {
          this.emitEvent("info", `process group ${pgid} is empty`);
        } else if (status === "reused") {
          this.emitEvent(
            "info",
            `original process group ${pgid} is gone; that numeric PGID now belongs to a ` +
              `different leader and was not signalled`,
          );
        } else if (status === "original") {
          this.loud(
            `process group ${pgid} STILL HAS MEMBERS after SIGKILL. It is not safe to restart ` +
              `this client because the generation is not clean.`,
          );
        } else {
          this.loud(
            `UNVERIFIED CLEANUP for original process group ${pgid}: /proc inspection could not ` +
              `prove the group empty. It is not safe to restart this client, and processes may ` +
              `remain.`,
          );
        }
      }

      this.reportSurvivors(
        [...generation.tracked.values()],
        generation.ancestryCaptured,
        status === "empty" || status === "reused" || status === "no-group",
      );
      const clean = status === "empty" || status === "reused" || status === "no-group";
      generation.groupEmpty = clean;
      generation.cleanupComplete = true;
      if (clean) this.retainedGenerations.delete(generation);
      if (status === "no-group") {
        return { clean: true, pgid: null, status } satisfies GenerationCleanupResult;
      }
      if (status === "empty" || status === "reused") {
        return { clean: true, pgid, status } satisfies GenerationCleanupResult;
      }
      return {
        clean: false,
        pgid,
        status,
        reason: status === "unknown"
          ? `/proc inspection could not verify original process group ${pgid} empty`
          : `original process group ${pgid} still has members after SIGKILL`,
      } satisfies GenerationCleanupResult;
    });
    return generation.cleanup;
  }

  /** SIGTERM the group, then return whether cleanup was actually verified. */
  async stop(graceMs = this.cleanupGraceMs): Promise<GenerationCleanupResult> {
    const generation = this.generation;
    if (!generation) return { clean: true, pgid: null, status: "no-group" };
    this.shuttingDown = true;
    return this.cleanupGeneration(generation, graceMs);
  }

  /**
   * WP10: the same verified cleanup as stop(), but WITHOUT the shutdown
   * latch — the failure screen's "Try again" needs the old generation
   * verified-gone before restart() will open its door, and stop() would
   * latch this client shut. Handles the live child (signals the group) and
   * the already-dead one (verifies and marks) alike.
   */
  async stopForRetry(graceMs = this.cleanupGraceMs): Promise<GenerationCleanupResult> {
    const generation = this.generation;
    if (!generation) return { clean: true, pgid: null, status: "no-group" };
    return this.cleanupGeneration(generation, graceMs);
  }

  /**
   * Say what is left. An empty group is not the same claim as an empty tree,
   * and for a long time this code only ever checked the first and reported it
   * as if it were the second.
   */
  private reportSurvivors(
    tree: TrackedProc[],
    ancestryCaptured: boolean,
    groupVerified: boolean,
  ) {
    if (tree.length === 0) {
      this.emitEvent(
        "info",
        process.platform === "linux"
          ? ancestryCaptured
            ? "descendant check: no processes were tracked in the agent's tree"
            : "descendant check: no process identities remained trackable after the direct " +
              "child exited. Escaped descendants cannot be ruled out because their ancestry " +
              "may already have been reparented."
          : `descendant check skipped — needs /proc, and this is ${process.platform}. ` +
              `Surviving descendants would go unreported on this platform.`,
      );
      return;
    }

    const { alive: survivors, unreadable } = this.survivorsOf(tree);
    if (unreadable.length > 0) {
      this.loud(
        `descendant check is UNVERIFIED: ${unreadable.length} of ${tree.length} tracked ` +
          `process identity record(s) could not be read from /proc. Processes may remain; ` +
          `no zero-survivor claim can be made.`,
        { unreadable },
      );
      return;
    }
    if (survivors.length === 0) {
      if (!groupVerified) {
        this.emitEvent(
          "error",
          `descendant check remains UNVERIFIED: ${tree.length} tracked process identity ` +
            `record(s) are gone, but incomplete /proc inspection could have concealed an ` +
            `untracked member of the original group. Processes may remain.`,
        );
        return;
      }
      this.emitEvent(
        "info",
        ancestryCaptured
          ? `descendant check: ${tree.length} process(es) were in the agent's tree, 0 survive`
          : `descendant check: ${tree.length} tracked process(es) no longer survive. ` +
            `Escaped descendants cannot be ruled out because the direct child had already ` +
            `exited before complete ancestry could be captured.`,
      );
      return;
    }

    this.loud(
      `${survivors.length} of ${tree.length} process(es) from the agent's tree are STILL RUNNING ` +
        `after shutdown. Killing the process group cannot reach a descendant that left it — ` +
        `setsid(), setpgid(), or a double-fork daemonize all escape it. They are listed by pid ` +
        `so they can be dealt with:\n` +
        survivors.map((p) => `    pid ${p.pid}  ${p.cmd}`).join("\n"),
      { survivors },
    );
  }

  /** Last-resort synchronous kill for process 'exit', where async is not possible. */
  killNow() {
    for (const generation of this.retainedGenerations) {
      if (generation.pgid !== null && !generation.groupEmpty) {
        // Captured PGID, never the mutable current child. This includes a
        // generation whose direct child is already terminal. A live direct
        // child or pinned live member reduces PGID-reuse risk, but inspection
        // and signalling cannot be made kernel-atomic here.
        const status = this.inspectGenerationGroup(generation);
        if (status === "empty" || status === "reused") {
          generation.groupEmpty = true;
          this.retainedGenerations.delete(generation);
        } else {
          this.signalGeneration(generation, "SIGKILL");
        }
      }
    }
  }
}
