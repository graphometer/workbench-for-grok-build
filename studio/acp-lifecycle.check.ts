// Focused, zero-dependency checks for generation-aware process cleanup.
// This file is both the test runner and its disposable child-process fixture.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AcpClient,
  classifyProcStatReadError,
  parseProcStat,
  systemProcReader,
  type AcpEvent,
  type ProcReader,
  type ProcStatRead,
} from "./acp.ts";
import { SessionManager } from "./sessions.ts";
import { completeShutdown, shutdownDisposition } from "./shutdown.ts";

const SELF = fileURLToPath(import.meta.url);
const FIXTURE_MODE = process.argv[2];
const KILL_NOW_NEGATIVE_CONTROL = process.env.GRAPHOMETER_KILLNOW_NOOP === "1";

function writeFrame(frame: unknown) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function spawnLeaf(detached: boolean) {
  const child = spawn(process.execPath, [SELF, "leaf"], {
    detached,
    stdio: "ignore",
  });
  if (detached) child.unref();
  if (child.pid === undefined) throw new Error("fixture leaf did not acquire a pid");
  return child.pid;
}

async function runFixture(mode: string) {
  const inGroupPid = spawnLeaf(false);
  const escapedPid = mode === "escape" ? spawnLeaf(true) : null;
  // Let leaves install their SIGTERM handler before the parent advertises that
  // the fixture is ready; otherwise a fast test can signal during Node startup.
  await new Promise((resolve) => setTimeout(resolve, 100));
  writeFrame({
    jsonrpc: "2.0",
    method: "fixture/ready",
    params: { parentPid: process.pid, inGroupPid, escapedPid },
  });

  if (mode === "normal-exit") {
    setTimeout(() => process.exit(23), 80);
  } else if (mode === "manager-crash" || mode === "manager-wait") {
    let input = "";
    let exitScheduled = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      let nl: number;
      while ((nl = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, nl).trim();
        input = input.slice(nl + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        if (request.id !== undefined) {
          writeFrame({ jsonrpc: "2.0", id: request.id, result: { fixture: true } });
          if (mode === "manager-crash" && request.method === "initialize" && !exitScheduled) {
            exitScheduled = true;
            setTimeout(() => process.exit(17), 80);
          }
        }
      }
    });
    process.stdin.resume();
  }

  setInterval(() => {}, 10_000);
}

function runLeaf() {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 10_000);
}

interface Ready {
  parentPid: number;
  inGroupPid: number;
  escapedPid: number | null;
}

interface CheckResult {
  name: string;
  pgids: number[];
  detail: string;
}

type ProcFault = "none" | "enumeration" | "unreadable" | "malformed" | "gone";

interface ControlledProcReader {
  reader: ProcReader;
  setFault(fault: ProcFault, pid?: number): void;
}

function controlledProcReader(): ControlledProcReader {
  let fault: ProcFault = "none";
  let targetPid: number | undefined;
  return {
    reader: {
      listPids() {
        if (fault === "enumeration") throw new Error("injected /proc enumeration failure");
        const pids = systemProcReader.listPids();
        return fault === "gone" && targetPid !== undefined && !pids.includes(targetPid)
          ? [...pids, targetPid]
          : pids;
      },
      readStat(pid: number): ProcStatRead {
        if (pid === targetPid) {
          if (fault === "unreadable") {
            return { status: "unreadable", reason: "EACCES: injected unreadable stat" };
          }
          if (fault === "malformed") return parseProcStat("injected malformed stat data");
          if (fault === "gone") return { status: "gone" };
        }
        return systemProcReader.readStat(pid);
      },
      readCmdline(pid: number) {
        return systemProcReader.readCmdline(pid);
      },
    },
    setFault(next: ProcFault, pid?: number) {
      fault = next;
      targetPid = pid;
    },
  };
}

const allPgids = new Set<number>();
const allPids = new Set<number>();
const results: CheckResult[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function waitFor<T>(
  emitter: EventEmitter,
  event: string,
  select: (...args: any[]) => T | undefined,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (...args: any[]) => {
      const selected = select(...args);
      if (selected === undefined) return;
      clearTimeout(timer);
      emitter.off(event, listener);
      resolve(selected);
    };
    emitter.on(event, listener);
  });
}

async function waitUntil(check: () => boolean, message: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function groupIsEmpty(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function requireGroupEmpty(pgid: number, timeoutMs = 10_000) {
  await waitUntil(
    () => groupIsEmpty(pgid),
    `process group ${pgid} did not become empty`,
    timeoutMs,
  );
}

async function requirePidGone(pid: number) {
  await waitUntil(() => !existsSync(`/proc/${pid}`), `pid ${pid} did not exit`);
}

function exactKill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function exactGroupKill(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function readyPromise(client: AcpClient) {
  return waitFor<Ready>(client, "notification", (msg: any) =>
    msg?.method === "fixture/ready" ? msg.params as Ready : undefined,
  );
}

function gonePromise(client: AcpClient) {
  return waitFor<any>(client, "gone", (how) => how, 10_000);
}

async function startClient(
  mode: string,
  cleanupGraceMs = 100,
  procReader?: ProcReader,
) {
  const client = new AcpClient({
    cwd: process.cwd(),
    command: process.execPath,
    args: [SELF, mode],
    cleanupGraceMs,
    procReader,
  });
  const ready = readyPromise(client);
  client.start();
  const details = await ready;
  const pgid = client.pid;
  assert(pgid !== undefined, `${mode}: direct child has no pid`);
  assert(details.parentPid === pgid, `${mode}: fixture parent is not the captured PGID`);
  allPgids.add(pgid);
  allPids.add(details.parentPid);
  allPids.add(details.inGroupPid);
  if (details.escapedPid !== null) allPids.add(details.escapedPid);
  return { client, ready: details, pgid };
}

function logCount(client: AcpClient, fragment: string) {
  return client.log.filter((event) => event.text.includes(fragment)).length;
}

async function signalDeadCheck() {
  const { client, ready, pgid } = await startClient("wait");
  const gone = gonePromise(client);
  exactKill(ready.parentPid, "SIGKILL");
  await gone;
  await requireGroupEmpty(pgid);
  await requirePidGone(ready.inGroupPid);
  assert(logCount(client, `cleaning agent generation (pgid ${pgid})`) === 1, "signal death cleanup was silent or duplicated");
  assert(logCount(client, `process group ${pgid} is empty`) === 1, "signal death did not verify the group empty exactly once");
  assert(client.log.some((event) => event.text.includes("Escaped descendants cannot be ruled out")), "signal death claimed complete ancestry evidence");
  results.push({ name: "signal-dead parent", pgids: [pgid], detail: "in-group descendant killed; incomplete escape ancestry reported honestly" });
}

async function normalExitCheck() {
  const { client, ready, pgid } = await startClient("normal-exit");
  await gonePromise(client);
  await requireGroupEmpty(pgid);
  await requirePidGone(ready.inGroupPid);
  assert(logCount(client, `process group ${pgid} is empty`) === 1, "normal exit did not empty its group");
  results.push({ name: "normal code exit", pgids: [pgid], detail: "in-group descendant killed and group verified empty" });
}

async function crashLoopCheck() {
  const manager = new SessionManager(process.cwd(), {
    command: process.execPath,
    args: [SELF, "manager-crash"],
    cleanupGraceMs: 100,
    requestTimeoutMs: 2000,
  });
  const pgids: number[] = [];
  const descendants: number[] = [];
  manager.acp.on("event", (event: AcpEvent) => {
    if (event.kind === "info" && event.text.startsWith("agent process started")) {
      const pid = (event.json as any)?.pid;
      if (typeof pid === "number") {
        pgids.push(pid);
        allPgids.add(pid);
        allPids.add(pid);
      }
    }
  });
  manager.acp.on("notification", (msg: any) => {
    if (msg?.method === "fixture/ready" && typeof msg.params?.inGroupPid === "number") {
      descendants.push(msg.params.inGroupPid);
      allPids.add(msg.params.inGroupPid);
    }
  });

  await manager.start();
  await waitUntil(() => manager.state === "failed", "three-generation crash loop did not reach failed state", 15_000);
  assert(pgids.length === 3, `expected 3 crash-loop generations, got ${pgids.length}`);
  assert(manager.acp.restarts === 2, `expected 2 replacement spawns, got ${manager.acp.restarts}`);
  assert(manager.snapshot().pid === null, "failed-state /state snapshot exposed a dead pid");
  for (const pgid of pgids) await requireGroupEmpty(pgid);
  for (const pid of descendants) await requirePidGone(pid);

  for (let index = 0; index < pgids.length - 1; index++) {
    const emptySeq = manager.acp.log.find((event) => event.text === `process group ${pgids[index]} is empty`)?.seq;
    const nextStartSeq = manager.acp.log.find((event) =>
      event.text === `agent process started — pid ${pgids[index + 1]}`)?.seq;
    assert(emptySeq !== undefined && nextStartSeq !== undefined && emptySeq < nextStartSeq,
      `generation ${pgids[index]} was not finalized before ${pgids[index + 1]} started`);
  }
  await manager.stop();
  results.push({ name: "three-generation crash loop", pgids, detail: "each group emptied before the next spawn; failed snapshot pid is null" });
}

async function escapedDescendantCheck() {
  const { client, ready, pgid } = await startClient("escape");
  assert(ready.escapedPid !== null, "escape fixture did not return its setsid pid");
  const gone = gonePromise(client);
  await client.stop(100);
  await gone;
  await requireGroupEmpty(pgid);
  assert(existsSync(`/proc/${ready.escapedPid}`), `setsid escapee ${ready.escapedPid} was unexpectedly killed`);
  const report = client.log.find((event) => event.text.includes(`pid ${ready.escapedPid}`));
  assert(report !== undefined, `setsid escapee ${ready.escapedPid} was not reported by exact pid`);
  exactKill(ready.escapedPid, "SIGKILL");
  await requirePidGone(ready.escapedPid);
  results.push({ name: "setsid escapee", pgids: [pgid], detail: `escapee pid ${ready.escapedPid} reported and explicitly killed by harness` });
}

async function stopExitRaceCheck() {
  const { client, ready, pgid } = await startClient("wait");
  const gone = gonePromise(client);
  const stopping = client.stop(100);
  exactKill(ready.parentPid, "SIGKILL");
  await Promise.all([stopping, gone]);
  await requireGroupEmpty(pgid);
  assert(logCount(client, `cleaning agent generation (pgid ${pgid})`) === 1, "stop/exit race ran cleanup more than once");
  assert(logCount(client, "descendant check:") === 1, "stop/exit race reported survivors more than once");
  results.push({ name: "stop/exit race", pgids: [pgid], detail: "one cleanup and one descendant report; no hang" });
}

async function restartGuardCheck() {
  const { client, ready, pgid } = await startClient("wait");
  let liveError = "";
  try {
    client.restart();
  } catch (err) {
    liveError = (err as Error).message;
  }
  assert(liveError.includes("still running"), "restart accepted a live direct child");

  let terminalError = "";
  const terminalAttempt = waitFor<boolean>(client, "event", (event: AcpEvent) => {
    if (event.kind !== "exit") return undefined;
    try {
      client.restart();
    } catch (err) {
      terminalError = (err as Error).message;
    }
    return true;
  });
  const gone = gonePromise(client);
  exactKill(ready.parentPid, "SIGKILL");
  await gone;
  await terminalAttempt;
  assert(terminalError.includes("has not finished cleanup"), "restart accepted a terminal but unclean generation");
  await requireGroupEmpty(pgid);

  const replacementReady = readyPromise(client);
  client.restart();
  const replacement = await replacementReady;
  const replacementPgid = client.pid;
  assert(replacementPgid !== undefined, "cleaned generation did not permit restart");
  allPgids.add(replacementPgid);
  allPids.add(replacement.parentPid);
  allPids.add(replacement.inGroupPid);
  const replacementGone = gonePromise(client);
  await client.stop(100);
  await replacementGone;
  await requireGroupEmpty(replacementPgid);
  results.push({ name: "restart guards", pgids: [pgid, replacementPgid], detail: "live and terminal-unclean rejected; cleaned generation restarted" });
}

async function procEnumerationFailureCheck() {
  const control = controlledProcReader();
  const manager = new SessionManager(process.cwd(), {
    command: process.execPath,
    args: [SELF, "manager-wait"],
    cleanupGraceMs: 80,
    requestTimeoutMs: 2000,
    procReader: control.reader,
  });
  const ready = readyPromise(manager.acp);
  await manager.start();
  const details = await ready;
  const pgid = manager.acp.pid;
  assert(pgid !== undefined, "enumeration failure fixture has no PGID");
  allPgids.add(pgid);
  allPids.add(details.parentPid);
  allPids.add(details.inGroupPid);

  const gone = gonePromise(manager.acp);
  control.setFault("enumeration");
  const cleanup = await manager.stop();
  await gone;
  assert(!cleanup.clean && cleanup.status === "unknown", "enumeration failure was reported clean");
  assert(cleanup.pgid === pgid, "enumeration failure result lost the original PGID");
  assert(logCount(manager.acp, `process group ${pgid} is empty`) === 0,
    "enumeration failure falsely logged the group empty");
  assert(logCount(manager.acp, `original process group ${pgid} is gone`) === 0,
    "enumeration failure falsely classified the PGID as reused");

  let restartError = "";
  try {
    manager.acp.restart();
  } catch (err) {
    restartError = (err as Error).message;
  }
  assert(restartError.includes("has not finished cleanup"),
    "restart was not blocked after unverified cleanup");

  const disposition = shutdownDisposition(cleanup);
  assert(disposition.exitCode === 1, "server shutdown disposition accepted unverified cleanup");
  assert(disposition.error?.includes(`original process group ${pgid}`),
    "server shutdown failure did not name the unverified original PGID");
  assert(disposition.error?.includes("processes may remain"),
    "server shutdown failure did not state that processes may remain");
  assert(disposition.error?.includes("Exiting non-zero"),
    "server shutdown failure did not state its non-zero outcome");
  const serverErrors: string[] = [];
  let serverExitCode: number | null = null;
  completeShutdown(disposition, {
    error: (message) => serverErrors.push(message),
    exit: (code) => { serverExitCode = code; },
  });
  assert(serverExitCode === 1, "shared server shutdown wiring did not exit non-zero");
  assert(serverErrors.length === 1 && serverErrors[0] === disposition.error,
    "shared server shutdown wiring did not print the fatal cleanup sentence exactly once");

  control.setFault("none");
  exactGroupKill(pgid, "SIGKILL");
  await requireGroupEmpty(pgid);
  await requirePidGone(details.parentPid);
  await requirePidGone(details.inGroupPid);
  results.push({
    name: "/proc enumeration failure",
    pgids: [pgid],
    detail: "manager stop unverified; restart blocked; server disposition FATAL and non-zero",
  });
}

async function partialProcStatCheck(fault: "unreadable" | "malformed") {
  const control = controlledProcReader();
  const { client, ready, pgid } = await startClient("wait", 80, control.reader);
  if (fault === "malformed") {
    assert(parseProcStat("injected malformed stat data").status === "unreadable",
      "malformed stat parser did not classify bad data as unreadable");
  }
  const gone = gonePromise(client);
  control.setFault(fault, ready.inGroupPid);
  const cleanup = await client.stop(80);
  await gone;
  assert(!cleanup.clean && cleanup.status === "unknown", `${fault} stat was reported clean`);
  assert(cleanup.pgid === pgid, `${fault} stat result lost the original PGID`);
  assert(logCount(client, `process group ${pgid} is empty`) === 0,
    `${fault} stat falsely logged the group empty`);
  assert(logCount(client, `original process group ${pgid} is gone`) === 0,
    `${fault} stat falsely classified the PGID as reused`);
  assert(client.log.some((event) =>
    event.text.includes("descendant check") && event.text.includes("UNVERIFIED")),
  `${fault} stat permitted a zero-survivor descendant claim`);
  assert(existsSync(`/proc/${ready.inGroupPid}`),
    `${fault} stat fixture unexpectedly lost the member whose identity was unverified`);

  control.setFault("none");
  exactGroupKill(pgid, "SIGKILL");
  await requireGroupEmpty(pgid);
  await requirePidGone(ready.parentPid);
  await requirePidGone(ready.inGroupPid);
  results.push({
    name: `${fault} relevant stat`,
    pgids: [pgid],
    detail: "partial scan stayed unknown; no empty/reused/zero-survivor claim",
  });
}

async function goneStatCheck() {
  const enoent = Object.assign(new Error("injected ENOENT"), { code: "ENOENT" });
  assert(classifyProcStatReadError(enoent).status === "gone",
    "production stat error classifier did not distinguish ENOENT as gone");
  const eacces = Object.assign(new Error("injected EACCES"), { code: "EACCES" });
  assert(classifyProcStatReadError(eacces).status === "unreadable",
    "production stat error classifier did not preserve non-ENOENT failures as unreadable");
  const transient = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const stalePid = transient.pid;
  assert(stalePid !== undefined, "ENOENT fixture did not acquire a pid");
  allPids.add(stalePid);
  await new Promise<void>((resolve, reject) => {
    transient.once("exit", () => resolve());
    transient.once("error", reject);
  });
  await requirePidGone(stalePid);

  const control = controlledProcReader();
  const { client, ready, pgid } = await startClient("wait", 80, control.reader);
  assert(stalePid !== pgid, "ENOENT fixture PID was unexpectedly reused by the direct child");
  control.setFault("gone", stalePid);
  const gone = gonePromise(client);
  const cleanup = await client.stop(80);
  await gone;
  assert(cleanup.clean && cleanup.status === "empty",
    "confirmed ENOENT race prevented a clean empty result");
  await requireGroupEmpty(pgid);
  await requirePidGone(ready.parentPid);
  await requirePidGone(ready.inGroupPid);
  results.push({
    name: "ENOENT-classified exited PID",
    pgids: [pgid],
    detail: `production ENOENT classifier returned gone; injected exited pid ${stalePid} was skipped without making the scan incomplete`,
  });
}

async function killNowAfterDeathCheck() {
  const ordinaryGraceMs = 4000;
  const { client, ready, pgid } = await startClient("wait", ordinaryGraceMs);
  const exited = waitFor<void>(client, "event", (event: AcpEvent) => event.kind === "exit" ? null as any : undefined);
  const gone = gonePromise(client);
  exactKill(ready.parentPid, "SIGKILL");
  await exited;
  await requirePidGone(ready.parentPid);
  assert(!groupIsEmpty(pgid), "killNow fixture group vanished before the backstop was exercised");

  // Equivalent negative control: deliberately do nothing while ordinary
  // cleanup is still inside its four-second grace. The group must remain.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert(!groupIsEmpty(pgid),
    "killNow negative control was not discriminating: ordinary cleanup won during the no-op window");
  assert(logCount(client, "sending SIGKILL to the group") === 0,
    "ordinary asynchronous escalation fired before killNow was called");

  const killNowAt = Date.now();
  if (!KILL_NOW_NEGATIVE_CONTROL) client.killNow();
  await requireGroupEmpty(pgid, 750);
  const elapsedMs = Date.now() - killNowAt;
  assert(elapsedMs < ordinaryGraceMs,
    "killNow did not empty the group before ordinary escalation could occur");
  assert(logCount(client, "sending SIGKILL to the group") === 0,
    "ordinary asynchronous SIGKILL escalation fired before the backstop emptied the group");
  await gone;
  await requirePidGone(ready.inGroupPid);
  results.push({
    name: "killNow after direct death",
    pgids: [pgid],
    detail: `250ms no-op left group alive; real killNow emptied it in ${elapsedMs}ms before 4000ms escalation`,
  });
}

async function runChecks() {
  if (process.platform !== "linux") throw new Error("lifecycle checks require Linux /proc");
  const positiveChecks = [
    signalDeadCheck,
    normalExitCheck,
    crashLoopCheck,
    escapedDescendantCheck,
    stopExitRaceCheck,
    restartGuardCheck,
    procEnumerationFailureCheck,
    () => partialProcStatCheck("unreadable"),
    () => partialProcStatCheck("malformed"),
    goneStatCheck,
    killNowAfterDeathCheck,
  ];
  const checks = KILL_NOW_NEGATIVE_CONTROL ? [killNowAfterDeathCheck] : positiveChecks;

  try {
    for (const check of checks) {
      await check();
      const result = results.at(-1)!;
      console.log(`PASS ${result.name}: ${result.detail}; PGID ${result.pgids.join(", ")}`);
    }

    for (const pgid of allPgids) assert(groupIsEmpty(pgid), `final audit: PGID ${pgid} is not empty`);
    for (const pid of allPids) assert(!existsSync(`/proc/${pid}`), `final audit: test pid ${pid} still exists`);
    console.log(`PASS final process audit: ${allPgids.size} original group(s) empty; no test pid remains`);
  } catch (err) {
    // Exact retained groups only. Never broad process matching.
    for (const pgid of allPgids) {
      try { process.kill(-pgid, "SIGKILL"); } catch {}
    }
    for (const pid of allPids) exactKill(pid, "SIGKILL");
    throw err;
  }
}

if (FIXTURE_MODE === "leaf") {
  runLeaf();
} else if (["wait", "normal-exit", "escape", "manager-crash", "manager-wait"].includes(FIXTURE_MODE)) {
  await runFixture(FIXTURE_MODE);
} else {
  await runChecks();
}
