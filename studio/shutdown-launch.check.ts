// Focused checks for the shutdown fixes (the WSL release-test wedge,
// windows-wsl-release-test-note.md). Two parts:
//
//   units        deterministic EPIPE coverage for SafeOutput (never throws,
//                never reports a stream's failure on the failed stream,
//                reports each death exactly once, reroutes to the survivor);
//                a REAL-KERNEL EPIPE fixture (bare console writes into a pipe
//                whose reader is already gone: the guard catches the EPIPE
//                events — counted by a probe — and reroutes to fd 2 with
//                uncaught=0; the unguarded control faces the same dead pipe
//                with no protection); and a
//                source assertion that start.sh's reader opens with
//                `trap '' INT TERM` (source-level because SafeOutput can mask
//                a removed trap in the launch variants).
//   clean        ./start.sh on a disposable port, SIGINT to its process
//                group: full exit inside the deadline, the config-integrity
//                line PRINTS (the WSL run never reached it), port released,
//                zero surviving server/agent PIDs, config.toml sha256
//                unchanged.
//   broken-pipe  the exact field-report wedge: the log-reader is killed
//                FIRST, then SIGINT to the group. Same teardown assertions
//                (the integrity line cannot print — its sink is gone — so the
//                check verifies the hash itself). RED against the pre-fix
//                code; evidence in docs/evidence/shutdown-fix/.
//
// Usage: node studio/shutdown-launch.check.ts [units|clean|broken-pipe]
// No argument runs units, then both scenarios.
//
// Safety: disposable 43xx ports only (CHECK_PORT_CLEAN / CHECK_PORT_BROKEN
// override 4371/4372; 4311 is refused outright). Each launch is detached (its
// own process group) and is torn down by exact PGID/PID only — never by name
// or pattern. BROWSER is pointed at /usr/bin/true so the launcher's
// open-the-tab behaviour cannot pop a window on the operator's desktop
// during a check run. config.toml is sha256-hashed before and after; the
// file's content is never printed.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutputFd } from "./shutdown.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SELF = fileURLToPath(import.meta.url);
const CONFIG_PATH = join(homedir(), ".grok", "config.toml");
const MODE = process.argv[2] ?? "all";

/** The graceful deadline in server.ts is 10s; 20s leaves room for cleanup. */
const EXIT_DEADLINE_MS = 20_000;

let passed = 0;
function ok(name: string) {
  console.log(`ok ${++passed} - ${name}`);
}
function assert(cond: boolean, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(100);
  }
  throw new Error(`timed out (${timeoutMs}ms) waiting for ${what}`);
}

// ── process table ────────────────────────────────────────────────────────

interface PsRow {
  pid: number;
  ppid: number;
  pgid: number;
  cmd: string;
}

function psTable(): PsRow[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,cmd="], { encoding: "utf8" });
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), cmd: m[4] });
  }
  return rows;
}

function descendantsOf(rows: PsRow[], pid: number): number[] {
  const out: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const row of rows) {
      if (row.ppid === parent && row.pid !== pid) {
        out.push(row.pid);
        queue.push(row.pid);
      }
    }
  }
  return out;
}

const pidAlive = (pid: number) => existsSync(`/proc/${pid}`);

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

function configSha256(): string {
  return createHash("sha256").update(readFileSync(CONFIG_PATH)).digest("hex");
}

// ── global teardown registry (exact PGIDs/PIDs only) ─────────────────────

const watchedPgids = new Set<number>();
const watchedPids = new Set<number>();

async function globalTeardown() {
  for (const pgid of watchedPgids) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const pid of watchedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await waitFor(
    () => [...watchedPids].every((pid) => !pidAlive(pid)),
    10_000,
    "teardown of watched pids",
  ).catch(() => {});
}

// ── part 1: deterministic SafeOutput units ───────────────────────────────

interface RawCall {
  fd: OutputFd;
  text: string;
}

async function runUnits() {
  const { SafeOutput, installStreamErrorGuards } = await import("./shutdown.ts");

  const makeHarness = (failWith: Partial<Record<OutputFd, string>> = {}) => {
    const calls: RawCall[] = [];
    const out = new SafeOutput((fd, text) => {
      calls.push({ fd, text });
      const code = failWith[fd];
      if (code) throw Object.assign(new Error(`${code}: injected failure`), { code });
    });
    return { calls, out };
  };
  const reports = (calls: RawCall[]) => calls.filter((c) => c.text.includes("failed ("));

  {
    const { calls, out } = makeHarness();
    out.log("hello");
    out.error("oops");
    assert(calls.length === 2, "plain log/error produced the wrong number of raw writes");
    assert(calls[0].fd === 1 && calls[0].text === "hello\n", "log did not write fd 1 with a newline");
    assert(calls[1].fd === 2 && calls[1].text === "oops\n", "error did not write fd 2 with a newline");
    ok("plain log/error write their own fds");
  }

  {
    const { calls, out } = makeHarness({ 1: "EPIPE" });
    out.log("hello"); // must not throw
    assert(out.isDead(1), "EPIPE on fd 1 did not mark the fd dead");
    assert(reports(calls).length === 1, "fd 1 death was not reported exactly once");
    assert(reports(calls)[0].fd === 2, "fd 1 death was reported on fd 1 itself");
    assert(
      reports(calls)[0].text.includes("fd 1") && reports(calls)[0].text.includes("EPIPE"),
      "the death report did not name the failed fd and the error code",
    );
    assert(
      calls.some((c) => c.fd === 2 && c.text === "hello\n"),
      "the original line was not rerouted to the surviving stream",
    );
    ok("EPIPE on fd 1: report + original line land on fd 2, never throws");
  }

  {
    const { calls, out } = makeHarness({ 1: "EPIPE" });
    out.log("one");
    out.log("two");
    assert(reports(calls).length === 1, "a dead fd was reported more than once");
    assert(
      calls.filter((c) => c.fd === 1).length === 1,
      "a known-dead fd was written to again instead of rerouted",
    );
    assert(
      calls.filter((c) => c.fd === 2 && (c.text === "one\n" || c.text === "two\n")).length === 2,
      "later lines were not rerouted to the surviving stream",
    );
    ok("a dead fd is reported once and never written again");
  }

  {
    const { calls, out } = makeHarness({ 2: "EPIPE" });
    out.error("oops"); // must not throw
    assert(out.isDead(2), "EPIPE on fd 2 did not mark the fd dead");
    assert(reports(calls).length === 1 && reports(calls)[0].fd === 1, "fd 2 death was not reported on fd 1");
    assert(calls.some((c) => c.fd === 1 && c.text === "oops\n"), "the error line was not rerouted to fd 1");
    ok("EPIPE on fd 2: report + original line land on fd 1");
  }

  {
    const { calls, out } = makeHarness({ 1: "EPIPE", 2: "EPIPE" });
    out.log("a"); // fails fd 1, the death report fails fd 2, the fallback is then known-dead
    out.error("b"); // both dead: dropped silently
    assert(out.isDead(1) && out.isDead(2), "both fds were not marked dead");
    assert(calls.length === 2, "writes kept being attempted after both fds were known dead");
    ok("both streams dead: output is dropped silently, never throws");
  }

  {
    const { calls, out } = makeHarness();
    out.markDead(1, "EPIPE");
    assert(out.isDead(1), "markDead did not mark the fd");
    assert(reports(calls).length === 1 && reports(calls)[0].fd === 2, "markDead did not report on the survivor");
    out.markDead(1, "EPIPE");
    assert(reports(calls).length === 1, "markDead reported the same fd twice");
    out.log("x");
    assert(calls.at(-1)!.fd === 2, "log did not reroute around a markDead fd");
    ok("markDead (the stream-guard path): one report, later writes reroute");
  }

  {
    const { calls, out } = makeHarness();
    out.markDead(1, "EPIPE");
    out.markDead(2, "EPIPE"); // nowhere left to say it
    assert(reports(calls).length === 1, "a death with no surviving stream was still reported somewhere");
    out.log("dropped");
    assert(calls.filter((c) => c.text === "dropped\n").length === 0, "a line was written with both fds dead");
    ok("second death with no survivor: nothing written, never throws");
  }

  {
    const { calls, out } = makeHarness({ 1: "EBADF" });
    out.log("hello"); // not an EPIPE — still tolerated, still reported off-stream
    assert(out.isDead(1), "a non-EPIPE write failure did not mark the fd dead");
    assert(
      reports(calls).length === 1 && reports(calls)[0].fd === 2 && reports(calls)[0].text.includes("EBADF"),
      "a non-EPIPE failure was not reported with its own code on the survivor",
    );
    ok("non-EPIPE failures are tolerated and reported with their code");
  }

  {
    // The guards attach real 'error' listeners to this process's own streams,
    // fed by a SafeOutput whose raw write is injected — so a synthetic EPIPE
    // event marks the fd dead and reports through the harness, and a real
    // stream error later in this check process cannot throw either.
    const { calls, out } = makeHarness();
    const stdoutListenersBefore = process.stdout.listenerCount("error");
    const stderrListenersBefore = process.stderr.listenerCount("error");
    installStreamErrorGuards(out);
    assert(
      process.stdout.listenerCount("error") === stdoutListenersBefore + 1 &&
        process.stderr.listenerCount("error") === stderrListenersBefore + 1,
      "the guards did not attach exactly one listener per stream",
    );
    process.stdout.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    assert(out.isDead(1), "a stdout stream error did not mark fd 1 dead");
    assert(
      reports(calls).length === 1 && reports(calls)[0].fd === 2,
      "the stdout death was not reported exactly once, on fd 2",
    );
    process.stderr.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    assert(out.isDead(2), "a stderr stream error did not mark fd 2 dead");
    assert(reports(calls).length === 1, "a guard reported a death with no surviving stream to say it on");
    ok("stream error guards swallow EPIPE into markDead — no exception escapes");
  }

  {
    /* Source-level ON PURPOSE: with SafeOutput in place, a removed trap no
       longer wedges the server, so the broken-pipe launch variant below would
       stay GREEN with the trap deleted — SafeOutput masks it. The trap is
       defense-in-depth for keeping the operator's terminal narrative (and the
       config-integrity line) alive through a Ctrl+C, and only a source check
       can guard it. "Opens with" = the trap stands between the pipeline's
       opening brace and the reader's first statement. */
    const startSh = readFileSync(join(ROOT, "start.sh"), "utf8");
    const readerOpen = startSh.indexOf("2>&1 | {");
    const trapIdx = startSh.indexOf("trap '' INT TERM", readerOpen);
    const firstStatement = startSh.indexOf('opened=""', readerOpen);
    assert(readerOpen !== -1, "start.sh no longer pipes the server through the log-reader");
    assert(
      trapIdx !== -1 && firstStatement !== -1 && trapIdx < firstStatement,
      "start.sh's log-reader subshell no longer opens with trap '' INT TERM",
    );
    ok("source: start.sh's log-reader subshell opens with trap '' INT TERM");
  }
}

// ── the real-kernel EPIPE fixture (this file is also its disposable child) ─

/**
 * Disposable child for the real-kernel EPIPE check. The parent destroys the
 * read end of this process's stdout right after spawn; this child then hammers
 * BARE console.log / process.stdout.write — the exact writes the field-report
 * wedge concerned. Guarded mode installs the production stream guards;
 * unguarded is the control. Both attach a counting probe listener so the
 * dead-pipe condition is OBSERVABLE (an EPIPE the guard caught is only proven
 * if the event really fired). Both report on stderr (fd 2 stays alive).
 *
 * Measured on this stack (Node 22.23.1), and it contradicts one step of the
 * field report's hypothesized mechanism: a bare-write EPIPE on stdio does NOT
 * become an uncaughtException — with zero 'error' listeners the event is
 * swallowed and the process runs on (probe: unguarded child, no listeners,
 * exit 0). So the guard's proven value here is NOT exception prevention; it
 * is that the EPIPE events — which DO fire, counted below — are converted
 * into markDead bookkeeping and a reroute to the surviving stream, and that
 * the shutdown path's own output is synchronous (an async buffered write can
 * be silently truncated by process.exit). The old code's actual CPU-spin
 * mechanism under a dead pipe is reproduced as a BEHAVIOR (the red launch
 * variants) but is not pinned to a specific in-Node loop; on this stack it is
 * not the bare-write exception loop. The probe listener itself would suppress
 * an "'error' with no listener throws" semantics on a future Node, so this
 * fixture cannot detect that semantics returning — recorded here, not hidden.
 */
async function runEpipeFixture(guarded: boolean) {
  let uncaught = 0;
  let syncThrows = 0;
  let epipeEvents = 0;
  /* Deliberately NO logging in these handlers — reporting a failure to the
     dead stream is the wedge the field report described. Count and continue. */
  process.on("uncaughtException", () => uncaught++);
  process.on("unhandledRejection", () => uncaught++);
  if (guarded) {
    const { SafeOutput, installStreamErrorGuards } = await import("./shutdown.ts");
    installStreamErrorGuards(new SafeOutput());
  }
  process.stdout.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "EPIPE") epipeEvents++;
  });
  // Let the parent destroy the read end before the first write.
  await sleep(400);
  for (let i = 0; i < 400; i++) {
    try {
      console.log(`bare console.log line ${i}`);
      process.stdout.write(`bare stdout.write line ${i}\n`);
    } catch {
      syncThrows++;
    }
  }
  // Let the asynchronous stream errors surface, then report on fd 2.
  await sleep(1500);
  process.stderr.write(
    `EPIPE_FIXTURE_RESULT ${JSON.stringify({ guarded, uncaught, syncThrows, epipeEvents })}\n`,
  );
}

function runEpipeFixtureChild(
  mode: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [SELF, mode], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  child.stdout!.destroy(); // the read end dies NOW — the field-report wedge
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${mode} fixture did not exit within 15s`));
    }, 15_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Real-kernel EPIPE: bare writes into a pipe whose reader is already gone. */
async function runEpipeKernelCheck() {
  const resultOf = (stderr: string, mode: string) => {
    const line = stderr.split("\n").find((l) => l.startsWith("EPIPE_FIXTURE_RESULT "));
    assert(
      line !== undefined,
      `${mode} printed no result line; its stderr begins: ${stderr.slice(0, 300)}`,
    );
    return JSON.parse(line.slice("EPIPE_FIXTURE_RESULT ".length)) as {
      guarded: boolean;
      uncaught: number;
      syncThrows: number;
      epipeEvents: number;
    };
  };

  const guarded = await runEpipeFixtureChild("epipe-fixture-guarded");
  const g = resultOf(guarded.stderr, "guarded fixture");
  assert(
    g.epipeEvents > 0,
    "the dead-pipe condition was never exercised — no EPIPE event fired, so the guard caught nothing",
  );
  assert(g.uncaught === 0, `guarded fixture saw ${g.uncaught} uncaught exception(s)`);
  assert(g.syncThrows === 0, `guarded fixture saw ${g.syncThrows} synchronous write throw(s)`);
  assert(
    guarded.stderr.includes("output stream fd 1 failed (EPIPE); further output goes to fd 2"),
    "the guard's reroute line did not appear on the surviving stream",
  );
  assert(guarded.code === 0, `guarded fixture exited ${guarded.code}, not 0`);

  /* The control: the SAME bare writes without the guards must face the same
     dead pipe (EPIPE events counted) and show NONE of the guard's protective
     bookkeeping — otherwise the guarded run above proves nothing. */
  const unguarded = await runEpipeFixtureChild("epipe-fixture-unguarded");
  const u = resultOf(unguarded.stderr, "unguarded control");
  assert(
    u.epipeEvents > 0,
    "the unguarded control never faced a dead pipe — the guarded check is not discriminating",
  );
  assert(
    !unguarded.stderr.includes("further output goes to fd"),
    "the unguarded control showed guard bookkeeping it does not have",
  );

  ok(
    `real-kernel EPIPE into a dead reader: guard caught ${g.epipeEvents} EPIPE event(s), rerouted ` +
      `to fd 2, uncaught=0; unguarded control took ${u.epipeEvents} EPIPE(s) with no protection`,
  );
}

// ── part 2: ./start.sh launch scenarios ──────────────────────────────────

interface Launch {
  proc: ChildProcess;
  pgid: number;
  out: () => string;
}

function launch(port: number): Launch {
  const proc = spawn("bash", ["./start.sh"], {
    cwd: ROOT,
    detached: true, // its own process group — Ctrl+C's target in the field
    env: { ...process.env, STUDIO_PORT: String(port), BROWSER: "/usr/bin/true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.pid === undefined) throw new Error("start.sh did not acquire a pid");
  let buf = "";
  proc.stdout!.on("data", (d) => (buf += d));
  proc.stderr!.on("data", (d) => (buf += d));
  return { proc, pgid: proc.pid, out: () => buf };
}

function waitExit(
  proc: ChildProcess,
  ms: number,
): Promise<{ exited: boolean; code: number | null; elapsedMs: number }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ exited: false, code: null, elapsedMs: Date.now() - start }),
      ms,
    );
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exited: true, code, elapsedMs: Date.now() - start });
    });
  });
}

async function runScenario(kind: "clean" | "broken-pipe", port: number) {
  assert(platform() === "linux", "launch scenarios require Linux (/proc, ps, process groups)");
  assert(port !== 4311 && port >= 4300 && port <= 4399, `refusing non-disposable port ${port}`);
  assert(!(await portOpen(port)), `port ${port} is already listening — refusing to touch it`);

  const hashBefore = configSha256();
  const run = launch(port);
  watchedPgids.add(run.pgid);
  const watched: number[] = [];
  let exitResult: { exited: boolean; code: number | null; elapsedMs: number } | null = null;

  try {
    await waitFor(
      () => run.out().includes(`127.0.0.1:${port}/?token=`),
      30_000,
      `the startup token line on port ${port}`,
    );
    assert(
      !run.out().includes("agent bring-up FAILED"),
      "the agent failed to start — the scenario cannot prove agent teardown",
    );

    // Identify the exact processes: the log-reader subshell and node are both
    // direct children of the start.sh bash; the agent is spawned detached
    // (its own process group) and is found as a descendant of node.
    let nodePid = 0;
    let readerPid = 0;
    await waitFor(
      () => {
        const rows = psTable();
        const node = rows.find((r) => r.ppid === run.pgid && r.cmd.includes("studio/server.ts"));
        const reader = rows.find((r) => r.ppid === run.pgid && r.cmd.includes("start.sh"));
        if (node) nodePid = node.pid;
        if (reader) readerPid = reader.pid;
        return nodePid !== 0 && readerPid !== 0;
      },
      10_000,
      "the pipeline's node and log-reader processes",
    );
    let agentPids: number[] = [];
    await waitFor(
      () => {
        agentPids = descendantsOf(psTable(), nodePid);
        return agentPids.length > 0;
      },
      30_000,
      "the agent child process",
    );

    watched.push(run.pgid, nodePid, readerPid, ...agentPids);
    for (const pid of watched) watchedPids.add(pid);
    assert(
      agentPids.every((pid) => psTable().find((r) => r.pid === pid)?.pgid !== run.pgid),
      "the agent shares the launcher's process group — a group signal would reach it directly",
    );

    if (kind === "broken-pipe") {
      // The wedge, exactly: the reader dies first, so node's merged
      // stdout/stderr pipe has no reader when shutdown logging begins.
      process.kill(readerPid, "SIGKILL");
      await waitFor(() => !pidAlive(readerPid), 5_000, "the log-reader's death");
      ok("broken-pipe: log-reader killed before any signal");
      await sleep(300);
      assert(pidAlive(nodePid), "node died with its reader, before any signal was sent");
      ok("broken-pipe: node survived the reader's death (pre-signal)");
    }

    const signalledAt = Date.now();
    process.kill(-run.pgid, "SIGINT"); // Ctrl+C's target: the foreground group
    exitResult = await waitExit(run.proc, EXIT_DEADLINE_MS);
    assert(
      exitResult.exited,
      `start.sh did not exit within ${EXIT_DEADLINE_MS}ms of SIGINT to the group — ` +
        `this is the WSL wedge (server survived under a dead pipe)`,
    );
    ok(
      `${kind}: full exit ${exitResult.elapsedMs}ms after SIGINT to the group ` +
        `(deadline ${EXIT_DEADLINE_MS}ms, exit code ${exitResult.code})`,
    );

    // Every watched process — server AND agent — must be gone, not just the
    // launcher. (Zombies get reaped once the parents exit; poll briefly.)
    await waitFor(
      () => watched.every((pid) => !pidAlive(pid)),
      10_000,
      "all server/agent pids to be gone",
    ).catch((err) => {
      const stuck = watched.filter((pid) => pidAlive(pid));
      throw new Error(`${(err as Error).message}: still alive: ${stuck.join(", ")}`);
    });
    assert(
      psTable().every((row) => row.pgid !== run.pgid),
      "the launcher's process group still has members after exit",
    );
    ok(`${kind}: zero surviving server/agent pids; launcher process group empty`);

    await waitFor(async () => !(await portOpen(port)), 10_000, `port ${port} to be released`);
    ok(`${kind}: port ${port} released`);

    const hashAfter = configSha256();
    assert(hashAfter === hashBefore, "config.toml sha256 CHANGED during the run");
    ok(`${kind}: config.toml sha256 unchanged (${hashBefore.slice(0, 12)}…)`);

    if (kind === "clean") {
      // With the reader alive, the shutdown narrative must actually PRINT —
      // the WSL run never reached the integrity line, so its printing here is
      // part of the proof. And a clean verified cleanup exits zero.
      assert(run.out().includes("[studio] shutting down (SIGINT)"), "the shutdown line did not print");
      assert(
        /~\/\.grok\/config\.toml md5 at exit : .* \[UNCHANGED\]/.test(run.out()),
        "the config-integrity line did not print UNCHANGED",
      );
      assert(exitResult.code === 0, `clean shutdown exited ${exitResult.code}, not 0`);
      ok("clean: shutdown narrative + config-integrity [UNCHANGED] printed; exit code 0");
    }
  } finally {
    await globalTeardown();
    watchedPgids.delete(run.pgid);
    for (const pid of watched) watchedPids.delete(pid);
  }
}

// ── run ──────────────────────────────────────────────────────────────────

const cleanPort = Number(process.env.CHECK_PORT_CLEAN ?? 4371);
const brokenPort = Number(process.env.CHECK_PORT_BROKEN ?? 4372);

try {
  if (MODE === "epipe-fixture-guarded") {
    await runEpipeFixture(true);
  } else if (MODE === "epipe-fixture-unguarded") {
    await runEpipeFixture(false);
  } else {
    if (MODE === "all" || MODE === "units") {
      await runUnits();
      await runEpipeKernelCheck();
    }
    if (MODE === "all" || MODE === "clean") await runScenario("clean", cleanPort);
    if (MODE === "all" || MODE === "broken-pipe") await runScenario("broken-pipe", brokenPort);
    if (!["all", "units", "clean", "broken-pipe"].includes(MODE)) {
      throw new Error(`unknown mode '${MODE}' — expected units|clean|broken-pipe`);
    }
    console.log(`\n${passed} shutdown-launch checks passed`);
  }
} catch (err) {
  console.error(`\nFAIL ${(err as Error).stack ?? err}`);
  await globalTeardown();
  process.exit(1);
}
