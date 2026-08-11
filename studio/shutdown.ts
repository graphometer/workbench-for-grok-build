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
