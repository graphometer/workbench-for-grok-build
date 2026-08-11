import type { AppEvent } from "./events.ts";

export const RECONSTRUCTION_SESSION_MAX_EVENTS = 500;
export const RECONSTRUCTION_SESSION_MAX_BYTES = 512 * 1024;
export const RECONSTRUCTION_GLOBAL_MAX_EVENTS = 5_000;
export const RECONSTRUCTION_GLOBAL_MAX_BYTES = 8 * 1024 * 1024;
export const RECONSTRUCTION_CLIENT_MAX_EVENTS = 1_000;
export const RECONSTRUCTION_CLIENT_MAX_BYTES = 4 * 1024 * 1024;
export const RECONSTRUCTION_PENDING_MAX_EVENTS = 500;
export const RECONSTRUCTION_PENDING_MAX_BYTES = 512 * 1024;

export type DeliveryMode = "live" | "reconstruction" | "catchup" | "current";

export interface DeliveredAppEvent extends AppEvent {
  /** Stable for this Graphometer server run and also used as the SSE `id`. */
  deliveryId: number | null;
  /** Transport provenance. `AppEvent.replay` keeps its upstream-only meaning. */
  delivery: DeliveryMode;
  /** Catch-up request already closed later in the same ordered batch. */
  deliveryResolved?: boolean;
}

export interface DeliveryRecord {
  id: number;
  sessionId: string;
  generation: number;
  type: string;
  bytes: number;
  json: string;
}

export interface SessionLoss {
  sessionId: string;
  generation: number;
  events: number;
  bytes: number;
  oversizedEvents: number;
  oversizedBytes: number;
  firstLostDeliveryId: number | null;
  lastLostDeliveryId: number | null;
  exactForCursor: boolean;
  firstRetainedId: number | null;
  firstConversationType: string | null;
  startsMidTurn: boolean;
}

export interface ReconstructionPlan {
  mode: "reconstruction" | "catchup";
  afterId: number | null;
  highWater: number;
  records: DeliveryRecord[];
  losses: SessionLoss[];
}

export interface RecoveryCursor {
  afterId: number | null;
  continuation: "reconstruction" | "catchup";
  valid: boolean;
  raw: string | null;
}

export function parseRecoveryCursor(
  value: string | string[] | undefined,
  highWater: number,
): RecoveryCursor {
  if (value === undefined) {
    return { afterId: null, continuation: "reconstruction", valid: true, raw: null };
  }
  const raw = Array.isArray(value) ? null : value;
  const match = typeof raw === "string" ? /^([rl]):(0|[1-9][0-9]*)$/.exec(raw) : null;
  const id = match === null ? NaN : Number(match[2]);
  const valid = match !== null && Number.isSafeInteger(id) && id <= highWater;
  return {
    afterId: valid ? id : highWater,
    continuation: valid && match![1] === "r" ? "reconstruction" : "catchup",
    valid,
    raw,
  };
}

export function sseDeliveryFrame(
  payload: DeliveredAppEvent,
  cursorMode: "r" | "l" = "l",
): string {
  const id = payload.deliveryId === null ? "" : `id: ${cursorMode}:${payload.deliveryId}\n`;
  return `${id}data: ${JSON.stringify(payload)}\n\n`;
}

export class HandoffBuffer {
  private frames: { id: number; frame: string; bytes: number }[] = [];
  private bytes = 0;
  active = true;
  readonly cutoff: number;

  constructor(cutoff: number) {
    this.cutoff = cutoff;
  }

  accept(id: number, frame: string): "direct" | "queued" | "overflow" {
    if (!this.active || id <= this.cutoff) return "direct";
    const bytes = Buffer.byteLength(frame, "utf8");
    if (
      this.frames.length + 1 > RECONSTRUCTION_CLIENT_MAX_EVENTS ||
      this.bytes + bytes > RECONSTRUCTION_CLIENT_MAX_BYTES
    ) return "overflow";
    this.frames.push({ id, frame, bytes });
    this.bytes += bytes;
    return "queued";
  }

  finish(): string[] {
    this.active = false;
    const frames = this.frames.sort((a, b) => a.id - b.id).map((item) => item.frame);
    this.frames = [];
    this.bytes = 0;
    return frames;
  }

  snapshot() {
    return { events: this.frames.length, bytes: this.bytes };
  }
}

interface LossCounters {
  events: number;
  bytes: number;
  oversizedEvents: number;
  oversizedBytes: number;
  firstDeliveryId: number | null;
  lastDeliveryId: number | null;
  recent: { id: number; bytes: number; oversized: boolean }[];
}

interface LoadBoundary {
  previousGeneration: number;
  previousLoss: LossCounters;
  candidateGeneration: number;
}

interface SessionJournal {
  generation: number;
  loss: LossCounters;
  load: LoadBoundary | null;
  supersededEvents: number;
  supersededBytes: number;
}

function emptyLoss(): LossCounters {
  return {
    events: 0,
    bytes: 0,
    oversizedEvents: 0,
    oversizedBytes: 0,
    firstDeliveryId: null,
    lastDeliveryId: null,
    recent: [],
  };
}

function copyLoss(loss: LossCounters): LossCounters {
  return { ...loss, recent: loss.recent.map((item) => ({ ...item })) };
}

function addLoss(loss: LossCounters, id: number, bytes: number, oversized: boolean) {
  loss.events++;
  loss.bytes += bytes;
  if (oversized) {
    loss.oversizedEvents++;
    loss.oversizedBytes += bytes;
  }
  if (loss.firstDeliveryId === null) loss.firstDeliveryId = id;
  else loss.firstDeliveryId = Math.min(loss.firstDeliveryId, id);
  loss.lastDeliveryId = loss.lastDeliveryId === null ? id : Math.max(loss.lastDeliveryId, id);
  loss.recent.push({ id, bytes, oversized });
  loss.recent.sort((a, b) => a.id - b.id);
  while (loss.recent.length > RECONSTRUCTION_SESSION_MAX_EVENTS) loss.recent.shift();
}

function mergeLoss(target: LossCounters, source: LossCounters) {
  target.events += source.events;
  target.bytes += source.bytes;
  target.oversizedEvents += source.oversizedEvents;
  target.oversizedBytes += source.oversizedBytes;
  if (source.firstDeliveryId !== null) {
    target.firstDeliveryId = target.firstDeliveryId === null
      ? source.firstDeliveryId
      : Math.min(target.firstDeliveryId, source.firstDeliveryId);
  }
  if (source.lastDeliveryId !== null) {
    target.lastDeliveryId = target.lastDeliveryId === null
      ? source.lastDeliveryId
      : Math.max(target.lastDeliveryId, source.lastDeliveryId);
  }
  target.recent = [...target.recent, ...source.recent]
    .sort((a, b) => a.id - b.id)
    .slice(-RECONSTRUCTION_SESSION_MAX_EVENTS);
}

function isConversationType(type: string): boolean {
  return type === "turn.started" || type === "turn.finished" || type === "turn.failed" ||
    type === "turn.completed" || type.startsWith("message.") || type.startsWith("tool.") ||
    type.startsWith("interaction.");
}

function startsTurn(type: string): boolean {
  return type === "turn.started" || type === "message.user";
}

function delivered(ev: AppEvent, deliveryId: number | null, delivery: DeliveryMode): DeliveredAppEvent {
  return { ...ev, deliveryId, delivery };
}

/**
 * Bounded, in-memory session event journal.
 *
 * Only serialized event strings are retained. The journal never keeps the raw
 * AppEvent object graph, so the byte budget includes hostile `raw` payloads
 * rather than estimating only the fields the page happens to read.
 */
export class DeliveryJournal {
  private nextId = 1;
  private records: DeliveryRecord[] = [];
  private totalBytes = 0;
  private readonly sessions = new Map<string, SessionJournal>();
  private pendingCreations = 0;
  private pendingRecords: DeliveryRecord[] = [];
  private pendingBytes = 0;
  private readonly pendingLosses = new Map<string, LossCounters>();

  get highWater(): number {
    return this.nextId - 1;
  }

  get retainedEvents(): number {
    return this.records.length;
  }

  get retainedBytes(): number {
    return this.totalBytes;
  }

  /** Retain unknown scoped events only while at least one session/new is unresolved. */
  beginSessionCreation() {
    this.pendingCreations++;
  }

  /**
   * Promote only events carrying the exact id returned by session/new. Events
   * for concurrent unknown ids remain pending and cannot be guessed into it.
   */
  promoteSession(sessionId: string) {
    const state = this.state(sessionId);
    const loss = this.pendingLosses.get(sessionId);
    if (loss) {
      mergeLoss(state.loss, loss);
      this.pendingLosses.delete(sessionId);
    }

    const promoted: DeliveryRecord[] = [];
    const remaining: DeliveryRecord[] = [];
    for (const record of this.pendingRecords) {
      if (record.sessionId === sessionId) promoted.push({ ...record, generation: state.generation });
      else remaining.push(record);
    }
    if (promoted.length === 0) return;

    this.pendingRecords = remaining;
    const bytes = promoted.reduce((sum, record) => sum + record.bytes, 0);
    this.pendingBytes -= bytes;
    this.records.push(...promoted);
    this.records.sort((a, b) => a.id - b.id);
    this.totalBytes += bytes;
    this.enforceSessionBounds(sessionId, state);
    this.enforceGlobalBounds();
  }

  /** Discard orphan candidates once no session/new can still claim them. */
  endSessionCreation() {
    if (this.pendingCreations === 0) return;
    this.pendingCreations--;
    if (this.pendingCreations !== 0) return;
    this.pendingRecords = [];
    this.pendingBytes = 0;
    this.pendingLosses.clear();
  }

  prune(heldSessionIds: ReadonlySet<string>) {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (!heldSessionIds.has(this.records[i].sessionId)) this.removeAt(i, false);
    }
    for (const sessionId of this.sessions.keys()) {
      if (!heldSessionIds.has(sessionId)) this.sessions.delete(sessionId);
    }
  }

  private state(sessionId: string): SessionJournal {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        generation: 0,
        loss: emptyLoss(),
        load: null,
        supersededEvents: 0,
        supersededBytes: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Assign a stable delivery ID without retaining the event. */
  sequence(ev: AppEvent, delivery: DeliveryMode): DeliveredAppEvent {
    return delivered(ev, this.nextId++, delivery);
  }

  /** A connection-control event must precede older retained IDs. */
  control(ev: AppEvent, delivery: DeliveryMode): DeliveredAppEvent {
    return delivered(ev, null, delivery);
  }

  /**
   * Assign and optionally retain one live AppEvent. `held` is determined by the
   * SessionManager, keeping the journal scoped to sessions this server owns.
   */
  publish(ev: AppEvent, held: boolean): DeliveredAppEvent {
    const sessionId = ev.sessionId;
    const state = sessionId === null || (!held && !this.sessions.has(sessionId))
      ? null
      : this.state(sessionId);

    if (state && ev.type === "bridge.session_loading") {
      const candidateGeneration = state.generation + 1;
      state.load = {
        previousGeneration: state.generation,
        previousLoss: copyLoss(state.loss),
        candidateGeneration,
      };
      state.generation = candidateGeneration;
      state.loss = emptyLoss();
    }

    if (state && ev.type === "bridge.session_loaded" && state.load) {
      this.commitLoad(sessionId!, state);
    } else if (state && ev.type === "bridge.session_load_failed" && state.load) {
      this.abortLoad(sessionId!, state);
    }

    const result = this.sequence(ev, "live");
    if (held && sessionId !== null) this.retain(result, state!.generation, state!);
    else if (sessionId !== null && this.pendingCreations > 0) this.retainPending(result);
    return result;
  }

  private pendingLoss(sessionId: string): LossCounters {
    let loss = this.pendingLosses.get(sessionId);
    if (!loss) {
      loss = emptyLoss();
      this.pendingLosses.set(sessionId, loss);
    }
    return loss;
  }

  private retainPending(ev: DeliveredAppEvent) {
    const json = JSON.stringify(ev);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > RECONSTRUCTION_PENDING_MAX_BYTES) {
      addLoss(this.pendingLoss(ev.sessionId!), ev.deliveryId!, bytes, true);
      return;
    }
    this.pendingRecords.push({
      id: ev.deliveryId!,
      sessionId: ev.sessionId!,
      generation: 0,
      type: ev.type,
      bytes,
      json,
    });
    this.pendingBytes += bytes;
    while (
      this.pendingRecords.length > RECONSTRUCTION_PENDING_MAX_EVENTS ||
      this.pendingBytes > RECONSTRUCTION_PENDING_MAX_BYTES
    ) {
      const removed = this.pendingRecords.shift()!;
      this.pendingBytes -= removed.bytes;
      addLoss(this.pendingLoss(removed.sessionId), removed.id, removed.bytes, false);
    }
  }

  private retain(ev: DeliveredAppEvent, generation: number, state: SessionJournal) {
    const json = JSON.stringify(ev);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > RECONSTRUCTION_SESSION_MAX_BYTES || bytes > RECONSTRUCTION_GLOBAL_MAX_BYTES) {
      addLoss(state.loss, ev.deliveryId!, bytes, true);
      return;
    }

    this.records.push({
      id: ev.deliveryId!,
      sessionId: ev.sessionId!,
      generation,
      type: ev.type,
      bytes,
      json,
    });
    this.totalBytes += bytes;
    this.enforceSessionBounds(ev.sessionId!, state);
    this.enforceGlobalBounds();
  }

  private removeAt(index: number, missing: boolean) {
    const [record] = this.records.splice(index, 1);
    this.totalBytes -= record.bytes;
    if (missing) {
      const state = this.state(record.sessionId);
      if (record.generation === state.generation) {
        addLoss(state.loss, record.id, record.bytes, false);
      } else if (state.load && record.generation === state.load.previousGeneration) {
        addLoss(state.load.previousLoss, record.id, record.bytes, false);
      }
    }
    return record;
  }

  private enforceSessionBounds(sessionId: string, state: SessionJournal) {
    let count = 0;
    let bytes = 0;
    for (const record of this.records) {
      if (record.sessionId === sessionId) {
        count++;
        bytes += record.bytes;
      }
    }
    while (count > RECONSTRUCTION_SESSION_MAX_EVENTS || bytes > RECONSTRUCTION_SESSION_MAX_BYTES) {
      let index = this.records.findIndex(
        (record) => record.sessionId === sessionId &&
          record.type !== "interaction.abandoned" && record.type !== "turn.failed" &&
          record.type !== "bridge.session_loading",
      );
      if (index === -1) index = this.records.findIndex((record) => record.sessionId === sessionId);
      if (index === -1) break;
      const removed = this.removeAt(index, true);
      count--;
      bytes -= removed.bytes;
    }
    state.loss.events = Math.max(0, state.loss.events);
  }

  private enforceGlobalBounds() {
    while (
      this.records.length > RECONSTRUCTION_GLOBAL_MAX_EVENTS ||
      this.totalBytes > RECONSTRUCTION_GLOBAL_MAX_BYTES
    ) {
      let index = this.records.findIndex(
        (record) => record.type !== "interaction.abandoned" && record.type !== "turn.failed" &&
          record.type !== "bridge.session_loading",
      );
      if (index === -1) index = 0;
      this.removeAt(index, true);
    }
  }

  private commitLoad(sessionId: string, state: SessionJournal) {
    const load = state.load!;
    const old = this.records.filter(
      (record) => record.sessionId === sessionId && record.generation === load.previousGeneration,
    );
    const lastTurnStart = old.reduce(
      (id, record) => record.type === "turn.started" ? record.id : id,
      -1,
    );
    const recovery = old.filter(
      (record) =>
        record.type === "interaction.abandoned" ||
        (record.type === "turn.failed" && record.id >= lastTurnStart),
    );

    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record.sessionId !== sessionId || record.generation !== load.previousGeneration) continue;
      const removed = this.removeAt(i, false);
      state.supersededEvents++;
      state.supersededBytes += removed.bytes;
    }

    // Recovery events happened after the transcript Grok is replaying. Give
    // their retained historical copies new IDs so an unscoped reconstruction
    // can preserve that chronology without broadcasting them twice live.
    for (const record of recovery.sort((a, b) => a.id - b.id)) {
      const source = JSON.parse(record.json) as DeliveredAppEvent;
      if (source.type === "interaction.abandoned") {
        const existingAnchor = source.data?.recoveryAfterTurn;
        let turns = 0;
        let turnOpen = false;
        for (const item of old) {
          if (item.id >= record.id) break;
          if (item.type === "turn.started") {
            turns++;
            turnOpen = true;
          } else if (item.type === "message.user" && !turnOpen) {
            turns++;
            turnOpen = true;
          } else if (
            item.type === "turn.completed" || item.type === "turn.finished" ||
            item.type === "turn.failed"
          ) turnOpen = false;
        }
        const anchor = typeof existingAnchor === "number" ? existingAnchor : turns;
        source.data = { ...source.data, recoveryAfterTurn: anchor };
      }
      const copy = delivered(source, this.nextId++, "live");
      this.retain(copy, load.candidateGeneration, state);
    }
    state.load = null;
  }

  private abortLoad(sessionId: string, state: SessionJournal) {
    const load = state.load!;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (record.sessionId !== sessionId || record.generation !== load.candidateGeneration) continue;
      const removed = this.removeAt(i, false);
      state.supersededEvents++;
      state.supersededBytes += removed.bytes;
    }
    state.generation = load.previousGeneration;
    state.loss = load.previousLoss;
    state.load = null;
  }

  plan(
    session: string | null,
    heldSessionIds: ReadonlySet<string>,
    afterId: number | null,
    continuation?: "reconstruction" | "catchup",
  ): ReconstructionPlan {
    const mode = continuation ?? (afterId === null ? "reconstruction" : "catchup");
    const highWater = this.highWater;
    const records = this.records.filter((record) => {
      if (record.id > highWater || !heldSessionIds.has(record.sessionId)) return false;
      if (session !== null && record.sessionId !== session) return false;
      if (afterId !== null && record.id <= afterId) return false;
      return true;
    });

    const relevantSessions = session === null
      ? [...heldSessionIds]
      : heldSessionIds.has(session) ? [session] : [];
    const losses: SessionLoss[] = [];
    for (const sessionId of relevantSessions) {
      const state = this.sessions.get(sessionId);
      if (!state) continue;
      const loss = state.load
        ? {
            events: state.loss.events + state.load.previousLoss.events,
            bytes: state.loss.bytes + state.load.previousLoss.bytes,
            oversizedEvents: state.loss.oversizedEvents + state.load.previousLoss.oversizedEvents,
            oversizedBytes: state.loss.oversizedBytes + state.load.previousLoss.oversizedBytes,
            firstDeliveryId: state.load.previousLoss.firstDeliveryId ?? state.loss.firstDeliveryId,
            lastDeliveryId: Math.max(
              state.loss.lastDeliveryId ?? -1,
              state.load.previousLoss.lastDeliveryId ?? -1,
            ),
            recent: [...state.load.previousLoss.recent, ...state.loss.recent]
              .sort((a, b) => a.id - b.id)
              .slice(-RECONSTRUCTION_SESSION_MAX_EVENTS),
          }
        : state.loss;
      if (loss.events === 0) continue;
      let reportedLoss = loss;
      let exactForCursor = true;
      if (mode === "catchup" && afterId !== null) {
        if (loss.lastDeliveryId !== null && afterId >= loss.lastDeliveryId) continue;
        const allLossesAreRecent = loss.recent.length === loss.events;
        const cursorBeforeAllLoss = loss.firstDeliveryId !== null && afterId < loss.firstDeliveryId;
        exactForCursor = allLossesAreRecent || cursorBeforeAllLoss;
        if (allLossesAreRecent) {
          const missed = loss.recent.filter((item) => item.id > afterId);
          if (missed.length === 0) continue;
          reportedLoss = {
            events: missed.length,
            bytes: missed.reduce((sum, item) => sum + item.bytes, 0),
            oversizedEvents: missed.filter((item) => item.oversized).length,
            oversizedBytes: missed.filter((item) => item.oversized).reduce((sum, item) => sum + item.bytes, 0),
            firstDeliveryId: missed[0].id,
            lastDeliveryId: missed[missed.length - 1].id,
            recent: missed,
          };
        }
      }
      const retained = records.filter((record) => record.sessionId === sessionId);
      const conversation = retained.find((record) => isConversationType(record.type));
      losses.push({
        sessionId,
        generation: state.generation,
        events: reportedLoss.events,
        bytes: reportedLoss.bytes,
        oversizedEvents: reportedLoss.oversizedEvents,
        oversizedBytes: reportedLoss.oversizedBytes,
        firstLostDeliveryId: reportedLoss.firstDeliveryId,
        lastLostDeliveryId: reportedLoss.lastDeliveryId,
        exactForCursor,
        firstRetainedId: retained[0]?.id ?? null,
        firstConversationType: conversation?.type ?? null,
        startsMidTurn: conversation ? !startsTurn(conversation.type) : false,
      });
    }
    return { mode, afterId, highWater, records, losses };
  }

  eventFor(record: DeliveryRecord, delivery: "reconstruction" | "catchup"): DeliveredAppEvent {
    const ev = JSON.parse(record.json) as DeliveredAppEvent;
    ev.delivery = delivery;
    return ev;
  }

  eventsFor(
    records: DeliveryRecord[],
    delivery: "reconstruction" | "catchup",
  ): DeliveredAppEvent[] {
    const events = records.map((record) => this.eventFor(record, delivery));
    if (delivery !== "catchup") return events;
    const resolved = new Set(
      events
        .filter((ev) => ev.type === "interaction.answered" || ev.type === "interaction.abandoned")
        .map((ev) => ev.data?.key)
        .filter((key): key is string => typeof key === "string"),
    );
    for (const ev of events) {
      if (
        resolved.has(ev.data?.key as string) &&
        (ev.type === "interaction.permission_requested" ||
          ev.type === "interaction.plan_approval_requested" ||
          ev.type === "interaction.question_asked" ||
          ev.type === "interaction.unhandled_request")
      ) ev.deliveryResolved = true;
    }
    return events;
  }

  snapshot() {
    const pendingLoss = [...this.pendingLosses.values()];
    return {
      nextDeliveryId: this.nextId,
      retainedEvents: this.records.length,
      retainedBytes: this.totalBytes,
      pending: {
        creations: this.pendingCreations,
        events: this.pendingRecords.length,
        bytes: this.pendingBytes,
        lossEvents: pendingLoss.reduce((sum, loss) => sum + loss.events, 0),
        lossBytes: pendingLoss.reduce((sum, loss) => sum + loss.bytes, 0),
      },
      sessions: [...this.sessions.entries()].map(([sessionId, state]) => ({
        sessionId,
        generation: state.generation,
        loss: { ...state.loss },
        loadingGeneration: state.load?.candidateGeneration ?? null,
        supersededEvents: state.supersededEvents,
        supersededBytes: state.supersededBytes,
      })),
    };
  }
}
