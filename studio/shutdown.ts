import { writeSync } from "node:fs";
import type { GenerationCleanupResult } from "./acp.ts";

export interface ShutdownDisposition {
  exitCode: 0 | 1;
  error: string | null;
}

export interface ShutdownActions {
  error(message: string): void;
  exit(code: 0 | 1): void;
}

/** Turn verified cleanup evidence into the server's final exit policy. */
export function shutdownDisposition(result: GenerationCleanupResult): ShutdownDisposition {
  if (result.clean) return { exitCode: 0, error: null };
  return {
    exitCode: 1,
    error:
      `[studio] FATAL: shutdown could not verify that original process group ${result.pgid} ` +
      `is empty; processes may remain. ${result.reason}. Exiting non-zero.`,
  };
}

/** The shared final error/exit wiring, injectable so the focused harness cannot exit itself. */
export function completeShutdown(
  disposition: ShutdownDisposition,
  actions: ShutdownActions,
): void {
  if (disposition.error) actions.error(disposition.error);
  actions.exit(disposition.exitCode);
}

// ── EPIPE-safe output (the WSL release-test wedge, field-report fix 1) ──
//
// start.sh merges this process's stdout and stderr into ONE pipe whose reader
// is the launcher's log-reader. If that reader dies first, every write raises
// EPIPE; unguarded, the error becomes an uncaughtException whose handler then
// logs to the same dead stream — the exception/logging loop the field report
// captured, which starved the event loop so the ACP cleanup timers never
// fired. The two rules below break that loop:
//
//   1. A write failure is reported on the OTHER stream, once — never on the
//      stream that failed, and never by throwing.
//   2. Writes are synchronous (writeSync), so a shutdown message either lands
//      before process.exit or is known to have failed. console.log on a pipe
//      is buffered async output that process.exit can silently truncate —
//      which is part of why the WSL run never printed the config-integrity
//      line.

/** The two output file descriptors the launcher wires to the operator's terminal. */
export type OutputFd = 1 | 2;

function otherFd(fd: OutputFd): OutputFd {
  return fd === 1 ? 2 : 1;
}

function defaultWriteRaw(fd: OutputFd, text: string): void {
  writeSync(fd, text);
}

/**
 * Writes to the process's own output streams that tolerate a dead pipe. The
 * low-level write is injectable so the focused harness can fail an fd
 * deterministically instead of breaking a real pipe.
 */
export class SafeOutput {
  private readonly deadFds = new Set<OutputFd>();
  private readonly reportedFds = new Set<OutputFd>();
  private readonly writeRaw: (fd: OutputFd, text: string) => void;

  constructor(writeRaw: (fd: OutputFd, text: string) => void = defaultWriteRaw) {
    this.writeRaw = writeRaw;
  }

  isDead(fd: OutputFd): boolean {
    return this.deadFds.has(fd);
  }

  /**
   * Record that an fd failed out of band (a stream 'error' event, via the
   * guards below), so later safe writes route around it. The death is still
   * reported once, on the surviving stream.
   */
  markDead(fd: OutputFd, code: string): void {
    if (this.deadFds.has(fd)) return;
    this.deadFds.add(fd);
    this.reportDeath(fd, code);
  }

  /** Say a stream died, once per fd, on the other stream — never on the dead one. */
  private reportDeath(fd: OutputFd, code: string): void {
    if (this.reportedFds.has(fd)) return;
    this.reportedFds.add(fd);
    const other = otherFd(fd);
    if (this.deadFds.has(other)) return; // nowhere left to say it
    try {
      this.writeRaw(
        other,
        `[studio] output stream fd ${fd} failed (${code}); further output goes to fd ${other}\n`,
      );
    } catch {
      this.deadFds.add(other);
    }
  }

  /** One line on fd 1, rerouted to fd 2 if fd 1 is dead. Never throws. */
  log(line: string): void {
    this.write(1, `${line}\n`);
  }

  /** One line on fd 2, rerouted to fd 1 if fd 2 is dead. Never throws. */
  error(line: string): void {
    this.write(2, `${line}\n`);
  }

  write(fd: OutputFd, text: string): void {
    let target = fd;
    if (this.deadFds.has(target)) {
      target = otherFd(target);
      if (this.deadFds.has(target)) return; // both dead: drop silently
    }
    try {
      this.writeRaw(target, text);
      return;
    } catch (err) {
      this.deadFds.add(target);
      this.reportDeath(target, (err as NodeJS.ErrnoException)?.code ?? String(err));
    }
    if (target !== fd) return; // that was already the fallback; nowhere else to go
    const fallback = otherFd(fd);
    if (this.deadFds.has(fallback)) return;
    try {
      this.writeRaw(fallback, text);
    } catch (err) {
      this.deadFds.add(fallback);
      this.reportDeath(fallback, (err as NodeJS.ErrnoException)?.code ?? String(err));
    }
  }
}

/**
 * Fix 1's other half: an output-stream error must never become an
 * uncaughtException. A write to a pipe whose reader is gone raises EPIPE as an
 * 'error' event on the stream, and an 'error' event with no listener throws.
 * The guard swallows the event and marks the fd dead in the shared SafeOutput,
 * so the shutdown path's later writes route to the surviving stream instead of
 * looping through the exception handler. This also covers the ordinary
 * console.* writes outside the shutdown path (the [acp] event relay, the HTTP
 * error log), which are the writes most likely to be in flight when the
 * reader dies.
 */
export function installStreamErrorGuards(output: SafeOutput): void {
  const guard = (stream: NodeJS.WriteStream, fd: OutputFd) => {
    stream.on("error", (err) => {
      output.markDead(fd, (err as NodeJS.ErrnoException)?.code ?? String(err));
    });
  };
  guard(process.stdout, 1);
  guard(process.stderr, 2);
}
