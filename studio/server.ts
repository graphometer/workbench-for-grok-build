// Graphometer — the bridge, and nothing else.
//
// Loopback-only HTTP server. It owns no protocol knowledge and no session
// state: `studio/sessions.ts` owns the agent and its sessions, `studio/acp.ts`
// owns the child process, `studio/events.ts` owns the wire format. This file is
// gates, routes and SSE fan-out.
//
// Deliberately ugly. Every visual decision here is disposable.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { SessionManager } from "./sessions.ts";
import { listDirectories, parseExcludedDirs, pathRefusal } from "./fs-browse.ts";
import { readPermissionModeFromFile, readRetentionFromFile } from "./config-read.ts";
import { ArchiveStore } from "./archive-store.ts";
import { bundleToMarkdown } from "./session-export.ts";
import { bridgeEvent, type AppEvent } from "./events.ts";
import { buildAssetMap, buildPageMap } from "./page-maps.ts";
import {
  DeliveryJournal,
  HandoffBuffer,
  parseRecoveryCursor,
  sseDeliveryFrame,
} from "./reconstruction.ts";
import {
  completeShutdown,
  shutdownDisposition,
  type ShutdownDisposition,
} from "./shutdown.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── per-machine configuration (D50) ─────────────────────────────────────
//
// The product ships with no operator-specific paths in its code. An operator's
// own values — workspace root, excluded directories — live in an UNTRACKED
// `graphometer.env` beside the repository's root (KEY=VALUE lines, `STUDIO_*`
// keys only). The server reads it itself, before any `STUDIO_*` value is used,
// so a bare `node studio/server.ts` honors the machine's policy exactly like
// `./start.sh` does. Real environment variables always win over the file.
(() => {
  let text = "";
  try {
    text = readFileSync(join(HERE, "..", "graphometer.env"), "utf8");
  } catch {
    return; // no file: the shipped defaults apply
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key.startsWith("STUDIO_")) continue;
    if (process.env[key] === undefined) process.env[key] = t.slice(eq + 1).trim();
  }
})();

const HOST = "127.0.0.1"; // loopback only, never 0.0.0.0
const PORT = Number(process.env.STUDIO_PORT ?? 4311);
/** Development gate (WP14, D46). When unset, the /bridge page and its two
    assets are not in the route tables at all — they 404 like any unknown
    path. Development surfaces (the Shell drawer tab) key off the same flag,
    which the page learns from the __STUDIO_DEV__ placeholder below. */
const DEV = process.env.STUDIO_DEV === "1";
/** Where a session goes when the caller does not say. Not where the agent lives. */
const DEFAULT_CWD = resolvePath(process.env.STUDIO_CWD ?? join(HERE, "scratch"));
const CONFIG_PATH = join(homedir(), ".grok", "config.toml");
/** Read ONLY by config-read, ONLY for the D81/D82/D88 retention fields
    (coding_data_retention_opt_out + team_blocked_reasons for the isZdr
    derivation). Never written by this app (D87: the agent may rewrite it),
    never logged as content, never served raw. */
const AUTH_PATH = join(homedir(), ".grok", "auth.json");

/* WP10/WP15 first-run facts. Re-read on every /state (WP15 staleness fix:
   upstream background GET /user enrichment can move the value with no user
   action), on /agent/restart, on /agent/config-facts, and after the D87
   retention set. Both readings carry their own `problem` sentence when they
   could not be taken; a problem is displayed, never converted into a guess. */
let AGENT_CONFIG_FACTS = readAgentConfigFacts();
function readAgentConfigFacts() {
  return {
    permissionMode: readPermissionModeFromFile(CONFIG_PATH),
    retention: readRetentionFromFile(AUTH_PATH),
  };
}

/** sha256 of auth.json bytes — digest only, never the content (D87). */
function authDigest(): string | null {
  try {
    return createHash("sha256").update(readFileSync(AUTH_PATH)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Where the folder picker OPENS — the workspace this machine's operator works
 * in, named by `STUDIO_BROWSE_ROOT` (usually via `graphometer.env`), with the
 * process's home directory as the shipped default. This is only the opening
 * folder — the picker can walk anywhere from there, and it is not a confinement
 * (the directory API is not restricted to this subtree). D51: the picker always
 * opens here; an active session's folder is offered as a shortcut, never as the
 * opening location.
 */
const BROWSE_ROOT = (() => {
  const env = process.env.STUDIO_BROWSE_ROOT;
  if (typeof env === "string" && env.trim() !== "") return resolvePath(env);
  return homedir();
})();

/**
 * Directories no route may list and no session may be started, loaded or
 * imported inside, from per-machine configuration (D50). Shipped default: none.
 * Enforced through the one shared `pathRefusal` gate on `/fs/list`,
 * `/session/new`, `/session/load` and `/session/import` — the picker's disabled
 * button is convenience, never the enforcement.
 *
 * Those four are the routes that take a path FROM THE CALLER. `/session/delete`
 * and `/session/export` take none: they act on a roster row whose cwd the server
 * resolves itself, and they act on it whatever that cwd is. Delete is plainly
 * wanted that way. Export is not ruled on — it reads a session's transcript out
 * from wherever that session ran — so the omission here is recorded, not decided.
 */
const EXCLUDED_DIRS = parseExcludedDirs(process.env.STUDIO_EXCLUDED_DIRS);

// ── the run token, and how you get it ───────────────────────────────────
//
// Binding to 127.0.0.1 keeps other machines out. It does nothing about the
// browser the operator already has open, and nothing about other processes on
// this machine.
//
// Four gates, each closing a different door:
//
//   RUN_TOKEN    A custom request header on every POST. This is the load-bearing
//                one for the cross-site case: a custom header forces a CORS
//                preflight, and a cross-origin page cannot satisfy a preflight
//                this server never answers. It also defeats the no-cors escape
//                hatch, because no-cors strips custom headers rather than
//                sending them.
//   Host check   Defeats DNS rebinding, where an attacker's own hostname is made
//                to resolve to 127.0.0.1 so the browser treats their page as
//                same-origin. The Origin then matches; the Host does not.
//   Origin check The cheap belt for the ordinary cross-site case.
//   Token on `/` THE FIX FOR D10 — see below.
//
// ── D10, closed ─────────────────────────────────────────────────────────
//
// Until this package, `GET /` served the page to anything that sent a correct
// `Host` header, with the token substituted into it. So the token was not a
// secret at all: any process running as this user could `curl
// http://127.0.0.1:4311/`, scrape 64 hex characters out of the HTML, and then
// drive a real agent with write access to disk. The CSRF gates stopped a hostile
// web *page*; they never stopped a hostile local *process*. It was recorded as
// an accepted risk (PROJECT-STATE §6) and deferred twice, to the package that
// rewrites page-serving. This is that package.
//
// The fix is one line of policy: `GET /` requires the token too. The token is
// printed once, at startup, as part of a clickable URL. A caller who does not
// already hold it gets a 403 and no page, so there is nothing to scrape. The
// token in the page stops being a bootstrap credential and becomes a session
// credential — it is only ever handed to somebody who proved they had it
// already.
//
// What this does and does not buy, stated honestly:
//   - Closed: a local process discovering the token by asking for it.
//   - NOT closed: a local process that can read this terminal's scrollback, the
//     operator's shell history, /proc/<pid>/environ, or the browser's memory.
//     A local attacker running as this user has other routes and always did.
//     This removes the trivial one, which was a one-line curl.
//   - NOT closed: the URL carries the token, so it lands in the browser's
//     history and, if the operator pastes it somewhere, wherever they pasted it.
//     That is a real cost and it is the reason the token is per-run and dies
//     with the process. `Referrer-Policy: no-referrer` keeps it out of outbound
//     Referer headers, and `cache-control: no-store` keeps the page out of
//     shared caches.
//
// The token is never broadcast on the SSE stream, never written to a file, and
// `redact()` keeps it out of any error text that escapes by an unexpected path.

const RUN_TOKEN = randomBytes(32).toString("hex");
const TOKEN_HEADER = "x-studio-token";
const TOKEN_PLACEHOLDER = "__STUDIO_TOKEN__";
/* Substituted into served pages the same way as the token, so the page knows
   whether this is a development build (the Shell drawer tab, WP14). "1" or "0"
   only — never the raw env value. Absent from a page, the split/join is a
   no-op, so only index.html carries it. */
const DEV_PLACEHOLDER = "__STUDIO_DEV__";

/**
 * Every HTML document this server will serve, and the only ones — and the
 * pages' stylesheets and scripts, the only other files read out of `public/`.
 *
 * Both tables are closed maps, built in page-maps.ts for the current
 * development-gate state: `/bridge` and its two assets exist only under
 * STUDIO_DEV=1 (WP14, D46) and 404 like any unknown path otherwise. The
 * closed-map and CSP reasoning lives with the builders there.
 *
 * WHY THESE ARE FILES AT ALL. WP5's Content-Security-Policy forbids inline
 * script (`script-src 'self'`, no `unsafe-inline`, no nonce), so an injected
 * `<script>` cannot run even if one ever reached the DOM. That policy is
 * incompatible with a page that carries its own script in a `<style>`/`<script>`
 * block, so both pages' CSS and JS moved out here.
 *
 * The assets carry NO secret and are NOT rewritten on the way out — the token
 * is in the page's own URL and the script reads it from `location.search`.
 * They are still behind the token gate, because an asset served to an
 * unauthenticated caller is a surface, and this project does not add surfaces
 * for tidiness.
 */
const PAGES = buildPageMap(DEV);
const ASSETS = buildAssetMap(DEV);

/**
 * The Content-Security-Policy, on every response this server makes.
 *
 * THE THREAT IT ANSWERS, stated plainly because a policy nobody can explain is
 * a policy that gets loosened by the next person who hits it: every string the
 * agent sends is attacker-controlled the moment the agent reads a
 * prompt-injected file in somebody's repository — message text, tool names,
 * arguments, filenames, session titles, plan markdown. The page those strings
 * land on holds a token that drives an agent with write access to this disk. One
 * `innerHTML` and a hostile repository executes script as this user.
 *
 * The page's first defence is that agent content reaches the DOM as text and
 * never as markup (AGENTS.md rule 10, D31). This is the second: even if the
 * first one is broken by a future edit, there is no way to execute the result.
 *
 *   default-src 'none'   nothing loads unless a directive below allows it
 *   script-src  'self'   external files only. No inline script, no eval, no
 *                        nonce and no hash — an injected <script> has nowhere
 *                        to go, whatever it says
 *   style-src   'self'   external stylesheets only. NOT 'unsafe-inline': both
 *                        pages' style attributes were removed to earn this.
 *                        (Assigning `el.style.width` from script is CSSOM and is
 *                        not governed by this directive; injected markup with a
 *                        style attribute is.)
 *   connect-src 'self'   fetch and EventSource reach this origin, nothing else
 *   img/font/object/base/form-action  all off. This app has no images, loads no
 *                        fonts, embeds nothing, and posts no forms
 *   frame-ancestors      'none' — the clickjacking gate, see gate 0 below
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'none'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

/** Constant-time compare that never throws on an absent or wrong-length value. */
function tokenOk(supplied: string | string[] | undefined | null): boolean {
  if (typeof supplied !== "string") return false; // absent, or sent twice
  const a = Buffer.from(supplied);
  const b = Buffer.from(RUN_TOKEN);
  if (a.length !== b.length) return false; // timingSafeEqual throws otherwise
  return timingSafeEqual(a, b);
}

/** Belt for the "never log the token" rule, whatever code path we leave by. */
function redact(text: string): string {
  return text.split(RUN_TOKEN).join("<token>");
}

/**
 * `localhost:4311` is legitimate — a browser sent to localhost may reach us
 * that way. An attacker's hostname pointed at loopback is not.
 */
function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return typeof host === "string" && ALLOWED_HOSTS.has(host.toLowerCase());
}

/**
 * Absent Origin means a non-browser client (curl, a test) — the token still
 * gates those. Present means a browser told us where the page came from, and
 * then it has to be us. `null` counts as present and fails, which is what we
 * want: that is what a sandboxed iframe or a file:// page sends.
 */
function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return typeof origin === "string" && ALLOWED_ORIGINS.has(origin.toLowerCase());
}

// ── config fingerprint ──────────────────────────────────────────────────
// We never modify this file. We hash it at start and at exit to prove it.

function configMd5(): string {
  try {
    return createHash("md5").update(readFileSync(CONFIG_PATH)).digest("hex");
  } catch (err) {
    return `unreadable: ${(err as Error).message}`;
  }
}

const CONFIG_MD5_AT_START = configMd5();

// ── SSE fan-out, now per session ────────────────────────────────────────
//
// A client may subscribe to one session or to everything. Routing is on
// `AppEvent.sessionId` and nothing else — WP3a made that field the routing key
// on every event, so per-session fan-out is a filter rather than a redesign.
//
// The filter rule, in full, because "an event did not arrive" is exactly the
// silence this project refuses everywhere else:
//
//   sessionId === null   -> every channel gets it. Not attributable to one
//                           session: process lifecycle, parse failures, the
//                           roster, our own refusals.
//   sessionId === "abc"  -> only channels subscribed to "abc", plus every
//                           unfiltered channel.
//
// So a filtered channel is a strict subset of the unfiltered one, and the
// unfiltered channel is the audit view: anything a filtered client did not see
// is visible there. Each filtered client counts what it filtered out and says
// so on its own stream, so "quiet" and "filtered" are distinguishable from
// inside the channel too.
//
// Two bounds here, both about a client that is not keeping up.
//
// SSE_MAX_BUFFERED — res.write() returning false only means "buffered", which
// is ordinary and self-correcting. What is not self-correcting is a backlog
// that keeps growing: a healthy EventSource on loopback drains immediately, so
// a client sitting on megabytes is wedged, suspended or gone, and every frame
// we add to it is memory we will never get back. Dropping it is recoverable —
// the page reconnects and is told what it missed. Buffering it is not.

const SSE_MAX_BUFFERED = 4 * 1024 * 1024;
/** How often a filtered channel reports its own filtered count, if it changed. */
const FILTER_REPORT_MS = 30_000;

interface SseClient {
  /** Only so a dropped client can be named in the log. */
  id: number;
  res: ServerResponse;
  /** null = every event. A string = only this session's events, plus unscoped ones. */
  session: string | null;
  filtered: number;
  filteredReported: number;
  handoff: HandoffBuffer;
}

let nextSseClientId = 1;
const sseClients = new Set<SseClient>();
const journal = new DeliveryJournal();

function dropClient(c: SseClient, why: string) {
  if (!sseClients.delete(c)) return; // already gone
  try {
    // destroy(), not end(). end() queues the FIN *behind* whatever is already
    // buffered, so for the case this function exists for — a client that is
    // not draining — a graceful close never actually goes out and the socket
    // sits on its backlog until the OS gives up on it. Measured with end():
    // the client was still connected 40s later.
    c.res.destroy();
  } catch {
    /* going away anyway */
  }
  // Deferred: this produces an event, which broadcasts. Doing that inline would
  // re-enter the fan-out we are in the middle of and deliver frames to the
  // other clients out of order.
  queueMicrotask(() => manager.acp.loud(`SSE client #${c.id} dropped — ${why}`));
}

/** Write one frame to one client, dropping it if it cannot or will not take it. */
function writeTo(c: SseClient, frame: string): boolean {
  const res = c.res;
  if (res.writableEnded || res.destroyed) {
    dropClient(c, "the connection was already closed");
    return false;
  }
  try {
    res.write(frame);
  } catch (err) {
    dropClient(c, `write failed: ${(err as Error).message}`);
    return false;
  }
  const queued = res.writableLength + (res.socket?.writableLength ?? 0);
  if (queued > SSE_MAX_BUFFERED) {
    dropClient(
      c,
      `${queued} bytes queued and not draining (limit ${SSE_MAX_BUFFERED}); ` +
        `reconnect for a bounded replay`,
    );
    return false;
  }
  return true;
}

/** Does this client's subscription cover this event? See the block comment above. */
function wants(c: SseClient, ev: AppEvent): boolean {
  if (c.session === null) return true;
  if (ev.sessionId === null) return true;
  return ev.sessionId === c.session;
}

/**
 * THE ONLY THING THAT GOES OUT ON THE STREAM IS AN AppEvent.
 *
 * Before WP3a this took `unknown` and every caller invented its own frame
 * shape, several of which were raw ACP objects. That is the coupling the
 * translation boundary exists to break: a pane built against the wire's own
 * discriminator breaks on the next CLI release, in the pane, silently.
 */
function broadcast(ev: AppEvent) {
  const retained = ev.sessionId !== null && manager.sessions.has(ev.sessionId);
  const delivered = journal.publish(ev, retained);
  if (ev.type === "bridge.session_load_failed") journal.prune(new Set(manager.sessions.keys()));
  const frame = sseDeliveryFrame(delivered);
  // Snapshot: writeTo can remove clients from the set as it goes.
  for (const c of [...sseClients]) {
    if (wants(c, ev)) {
      const disposition = delivered.deliveryId === null
        ? "direct"
        : c.handoff.accept(delivered.deliveryId, frame);
      if (disposition === "direct") writeTo(c, frame);
      else if (disposition === "overflow") {
        const queued = c.handoff.snapshot();
        dropClient(c, `the reconstruction handoff queue exceeded its bound after ` +
          `${queued.events} event(s) / ${queued.bytes} bytes`);
      }
    }
    else c.filtered++;
  }
}

// ── the agent ───────────────────────────────────────────────────────────

// The agent process gets the default session cwd as its own working directory.
// It is not where sessions live — every session names its own `cwd` — but the
// child has to start somewhere, and starting it in the repository root would put
// a real agent's process cwd on top of our own source tree for no reason.
const manager = new SessionManager(DEFAULT_CWD);
manager.on("app", broadcast);
/** WP10: one /agent/restart bring-up at a time. */
let restartInFlight = false;

// The archive list (WP13 §2, D61): a Graphometer-local "hidden from the rail"
// set, server-owned mutable state living beside `graphometer.env` at the repo
// root — NEVER under `~/.grok/`, never CONFIG_PATH. It deletes nothing and never
// touches the ACP wire; archiving/restoring is pure local list-keeping.
const ARCHIVE_PATH = join(HERE, "..", "graphometer-archive.json");
const archive = new ArchiveStore(ARCHIVE_PATH);

function serverSnapshot() {
  journal.prune(new Set(manager.sessions.keys()));
  // excludedDirs is DISPLAY information (the picker should not advertise
  // folders it will refuse) — the enforcement is pathRefusal on the routes,
  // never the client. archivedIds is likewise DISPLAY information: the client
  // filters these out of the rail; nothing server-side hides a session, and an
  // archived id still loads if selected.
  return {
    ...manager.snapshot(),
    browseRoot: BROWSE_ROOT,
    excludedDirs: EXCLUDED_DIRS,
    archivedIds: archive.list(),
    reconstruction: journal.snapshot(),
    /* WP10/WP15: the operator's own config — permission default and the
       D81/D88 retention booleans, each with its problem sentence when it
       could not be taken. Re-read on every snapshot so the privacy panel
       cannot show a stale value after an external change (upstream
       enrichment, CLI /privacy, or our own D87 switch). */
    agentConfig: (AGENT_CONFIG_FACTS = readAgentConfigFacts()),
  };
}

/**
 * Tell each filtered channel how much it did not see. Without this, a channel
 * watching an idle session and a channel that is broken look identical from the
 * inside — and the whole point of a per-session filter is that dropping is
 * intentional, which is only true if it is also visible.
 */
setInterval(() => {
  for (const c of [...sseClients]) {
    if (c.session === null || c.filtered === c.filteredReported) continue;
    const since = c.filtered - c.filteredReported;
    c.filteredReported = c.filtered;
    const report = journal.sequence(
      bridgeEvent(
          "bridge.channel_filtered",
          { session: c.session, sinceLastReport: since, total: c.filtered },
          `${since} event(s) belonging to other sessions were not sent on this channel ` +
            `(${c.filtered} in total). This is the per-session filter doing its job, not a ` +
            `loss — open /events with no session parameter to see everything.`,
          c.session,
      ),
      "live",
    );
    writeTo(c, sseDeliveryFrame(report));
  }
}, FILTER_REPORT_MS).unref();

// ── HTTP ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let refused = false;
    req.on("data", (c: Buffer) => {
      /* The cap is in BYTES, not string length (a multibyte body could else
         double the intended limit), and an oversize body is a caller error:
         reject with badRequest (→ 400) and keep draining instead of
         destroying the socket, so the 400 actually reaches the caller
         (Codex 8). */
      bytes += c.length;
      if (bytes > 1_000_000) {
        if (!refused) {
          refused = true;
          const err: any = new Error("request body too large (over 1,000,000 bytes)");
          err.badRequest = true;
          reject(err);
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (refused) return; /* the rejection already stands */
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * One shape for every refusal. The caller gets a flat "forbidden" — telling a
 * hostile page which of the gates it tripped only helps it. The reason goes to
 * the terminal, where the operator can see it and debug their own setup.
 */
function deny(res: ServerResponse, why: string) {
  console.error(`[studio] 403 refused — ${redact(why)}`);
  json(res, 403, { error: "forbidden" });
}

/** Read a required string field out of a parsed POST body. */
function str(body: any, field: string): string {
  const v = body?.[field];
  if (typeof v !== "string" || v.trim() === "") {
    const err: any = new Error(`'${field}' is required and must be a non-empty string`);
    err.badRequest = true;
    throw err;
  }
  return v;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

  // ── gate 0: refuse to be framed ──
  //
  // The page carries the run token and has buttons that grant a real agent
  // permission to write to disk. Framed invisibly inside a hostile page and
  // overlaid with decoy UI, a click the operator believes is landing on the
  // attacker's own interface lands on Approve instead — and every gate below
  // passes, because the request genuinely does come from our page, with our
  // Origin, our Host and our token. None of those can tell the difference
  // between a click the operator meant and one they were tricked into.
  // Refusing to be framed at all is what can.
  res.setHeader("X-Frame-Options", "DENY");
  // The full policy, not just the framing clause. See CSP above for what each
  // directive is for and which attack it answers.
  res.setHeader("Content-Security-Policy", CSP);

  try {
    // ── gate 1: Host, on everything ──
    // Including the page itself: a rebinding attack begins by loading it.
    if (!hostOk(req)) {
      deny(res, `Host '${req.headers.host ?? "(absent)"}' is not this server`);
      return;
    }

    // ── gate 2 and 3: Origin, then token, on every POST ──
    // Ahead of the routes so a new endpoint is covered by default rather than
    // by somebody remembering.
    if (req.method === "POST") {
      if (!originOk(req)) {
        deny(res, `POST ${url.pathname} from cross-site origin '${req.headers.origin}'`);
        return;
      }
      if (!tokenOk(req.headers[TOKEN_HEADER])) {
        deny(res, `POST ${url.pathname} with no valid '${TOKEN_HEADER}' header`);
        return;
      }
    }

    // ── the pages ──
    //
    // Two of them in a development build, one in a public one. `/` is the
    // application shell; `/bridge` is the raw event view that WP0–WP3 were
    // proven on. The shell drives turns and answers permission requests itself
    // since WP5/WP6, so the bridge is a development surface only — PAGES holds
    // it just when STUDIO_DEV=1 (WP14, D46), and this block is never reached
    // for it otherwise.
    //
    // Every page goes through the same gate and the same placeholder check. A
    // new page added to PAGES inherits both; a new page added with its own copy
    // of this block is how one of them ends up without a gate.
    if (req.method === "GET" && PAGES.has(url.pathname)) {
      // D10. A page is a secret-bearing document, so it is not served to anyone
      // who cannot already prove they hold the secret. A browser gets here from
      // the URL printed at startup, and every request the page then makes
      // carries the token in a header instead.
      //
      // The token STAYS in the address bar on purpose. Stripping it with
      // history.replaceState() looks tidier and buys nothing: the navigation is
      // already in the browser's history either way, so the only thing removing
      // it actually changes is that reloading the page then 403s. A reload that
      // breaks is how this fix gets reverted by whoever hits it next. So: the
      // URL is the credential, it is per-run, and it dies with this process.
      if (!tokenOk(url.searchParams.get("token"))) {
        deny(
          res,
          `GET ${url.pathname} without the run token. The page carries the token, so it is ` +
            `only served to a caller that already has it. Use the URL printed at startup.`,
        );
        return;
      }

      const file = PAGES.get(url.pathname)!;
      const raw = await readFile(join(HERE, "public", file), "utf8");

      // Silent-success trap. Serving the page with the placeholder still in it
      // would produce a page that loads perfectly and then has every request
      // refused, with nothing on screen saying why.
      if (!raw.includes(TOKEN_PLACEHOLDER)) {
        manager.acp.loud(
          `public/${file} has no ${TOKEN_PLACEHOLDER} placeholder — refusing to serve a page ` +
            `that would be rejected on every request`,
        );
        json(res, 500, { error: `${file} is missing its token placeholder` });
        return;
      }
      const html = raw
        .split(TOKEN_PLACEHOLDER).join(RUN_TOKEN)
        .split(DEV_PLACEHOLDER).join(DEV ? "1" : "0");

      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        // This page carries a secret. Keep it out of any shared cache, and out
        // of a Referer header if a link ever appears on it.
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(html);
      return;
    }

    // ── the pages' stylesheet and script ──
    //
    // Same gate, same closed map, no substitution. The token arrives in the
    // query string because a `<link>` and a `<script src>` cannot set a header
    // either; the page's own URL already carries it, so the markup passes it on.
    if (req.method === "GET" && ASSETS.has(url.pathname)) {
      if (!tokenOk(url.searchParams.get("token"))) {
        deny(res, `GET ${url.pathname} without the run token`);
        return;
      }
      const asset = ASSETS.get(url.pathname)!;
      const body = await readFile(join(HERE, "public", asset.file));

      // These files must NOT contain the placeholder. One that does is a file
      // expecting a substitution this route deliberately does not do, and it
      // would ship the literal string to the browser — which fails the token
      // shape test and produces a page where nothing works and nothing says why.
      if (body.includes(TOKEN_PLACEHOLDER)) {
        manager.acp.loud(
          `public/${asset.file} contains ${TOKEN_PLACEHOLDER}, but assets are served ` +
            `verbatim — the script reads the token from location.search. Refusing to serve it.`,
        );
        json(res, 500, { error: `${asset.file} expects a token substitution that does not happen` });
        return;
      }

      res.writeHead(200, {
        "content-type": asset.type,
        // No secret in here, but it changes with every edit during development
        // and a stale cached script against a new server is a confusing bug.
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(body);
      return;
    }

    // ── event stream ──
    if (req.method === "GET" && url.pathname === "/events") {
      // EventSource cannot set a header, so this endpoint takes the token in the
      // query string. Nothing logs request URLs, and the server is loopback-only.
      if (!tokenOk(url.searchParams.get("token"))) {
        deny(res, "GET /events with no valid token query parameter");
        return;
      }
      const session = url.searchParams.get("session");
      const rawLastEventId = req.headers["last-event-id"];
      const cursor = parseRecoveryCursor(rawLastEventId, journal.highWater);
      const cursorText = cursor.raw;
      const cursorValid = cursor.valid;
      const afterId = cursor.afterId;
      const continuation = cursor.continuation;
      const heldSessionIds = new Set(manager.sessions.keys());
      journal.prune(heldSessionIds);
      const scopedSession = session && session.trim() !== "" ? session : null;
      const plan = journal.plan(scopedSession, heldSessionIds, afterId, continuation);
      const plannedEvents = journal.eventsFor(plan.records, plan.mode);

      const lossEvents = plan.losses.map((loss) => journal.sequence(
        bridgeEvent(
          plan.mode === "reconstruction"
            ? "bridge.reconstruction_truncated"
            : "bridge.catchup_truncated",
          {
            missingEvents: loss.events,
            missingSerializedBytes: loss.bytes,
            oversizedEvents: loss.oversizedEvents,
            oversizedSerializedBytes: loss.oversizedBytes,
            generation: loss.generation,
            firstRetainedId: loss.firstRetainedId,
            firstConversationType: loss.firstConversationType,
            startsMidTurn: loss.startsMidTurn,
            firstLostDeliveryId: loss.firstLostDeliveryId,
            lastLostDeliveryId: loss.lastLostDeliveryId,
            exactForCursor: loss.exactForCursor,
          },
          `${loss.events} earlier event(s) for session ${loss.sessionId} are not retained ` +
            `(${loss.bytes} serialized bytes).` +
            (!loss.exactForCursor
              ? " The bounded loss ledger cannot split that total exactly at this older reconnect cursor."
              : "") +
            (loss.startsMidTurn
              ? " The retained conversation starts partway through a turn, so it is labelled partial."
              : " The page will show only the retained portion and will not invent the missing history."),
          loss.sessionId,
        ),
        plan.mode,
      ));

      const openEvents = manager.openInteractionEvents()
        .filter((ev) => scopedSession === null || ev.sessionId === scopedSession)
        .map((ev) => journal.sequence(ev, "current"));
      const finished = journal.sequence(
        bridgeEvent(
          plan.mode === "reconstruction"
            ? "bridge.reconstruction_finished"
            : "bridge.catchup_finished",
          {
            throughDeliveryId: plan.highWater,
            retainedEvents: plan.records.length,
            truncatedSessions: plan.losses.length,
            currentInteractions: openEvents.length,
            currentInteractionKeys: openEvents
              .map((ev) => ev.data?.key)
              .filter((key): key is string => typeof key === "string"),
          },
          plan.mode === "reconstruction"
            ? `Restored ${plan.records.length} retained event(s) and reconciled ` +
              `${openEvents.length} current interaction(s).`
            : `Caught up ${plan.records.length} event(s) after delivery ${afterId}.`,
          scopedSession,
        ),
        plan.mode,
      );

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const client: SseClient = {
        id: nextSseClientId++,
        res,
        session: scopedSession,
        filtered: 0,
        filteredReported: 0,
        handoff: new HandoffBuffer(finished.deliveryId!),
      };
      sseClients.add(client);

      const opened = journal.control(
        bridgeEvent(
            "bridge.channel_open",
            {
              channel: client.id,
              session: client.session,
              agent: serverSnapshot(),
              recovery: {
                mode: plan.mode,
                afterDeliveryId: afterId,
                throughDeliveryId: plan.highWater,
                retainedEvents: plan.records.length,
                losses: plan.losses,
                cursorValid,
              },
            },
            plan.mode === "reconstruction"
              ? "Restoring this page from the server's retained history."
              : cursorValid
                ? `Catching up events after delivery ${afterId}. The existing page model is retained.`
                : "The reconnect cursor was invalid. No full journal is being replayed onto the existing page.",
            client.session,
          ),
          plan.mode,
        );
      writeTo(client, sseDeliveryFrame(opened));

      for (const ev of plannedEvents) {
        if (!writeTo(client, sseDeliveryFrame(ev, plan.mode === "reconstruction" ? "r" : "l"))) break;
      }
      for (const ev of lossEvents) {
        if (!writeTo(client, sseDeliveryFrame(ev, plan.mode === "reconstruction" ? "r" : "l"))) break;
      }
      for (const ev of openEvents) {
        if (!writeTo(client, sseDeliveryFrame(ev, plan.mode === "reconstruction" ? "r" : "l"))) break;
      }
      writeTo(client, sseDeliveryFrame(finished, "l"));

      for (const frame of client.handoff.finish()) {
        if (!writeTo(client, frame)) break;
      }

      if (!cursorValid) {
        const invalid = journal.sequence(
          bridgeEvent(
            "bridge.catchup_failed",
            { receivedLastEventId: cursorText ?? null },
            "The browser supplied an invalid Last-Event-ID. Existing conversation state was not replaced; reload the page for a bounded reconstruction.",
            scopedSession,
          ),
          "catchup",
        );
        writeTo(client, sseDeliveryFrame(invalid));
      }

      const keepAlive = setInterval(() => {
        writeTo(client, ": keep-alive\n\n");
      }, 15_000);

      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(client);
      });
      return;
    }

    // ── everything below is POST, already gated ──
    if (req.method !== "POST") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }

    const raw = await readBody(req);
    /* A body that is not JSON is a caller error (400), not a 500 — the same
       class as a missing field, and never a broken connection (Codex 8). */
    let body: any;
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      const err: any = new Error("the request body was not valid JSON");
      err.badRequest = true;
      throw err;
    }

    // ── what the server currently holds ──
    if (url.pathname === "/state") {
      json(res, 200, serverSnapshot());
      return;
    }

    // ── list subdirectories for the folder picker (WP5.5 / D47) ──
    //
    // Directories only, one level deep, never a file's contents. This block is
    // reached only after the Host, Origin and token gates above, so the listing
    // is never served to an unauthenticated caller. The path is the operator's
    // own — not a secret — but every name is still rendered as a text node on the
    // page. `listDirectories` refuses this machine's excluded directories (D50),
    // never recurses, and reports an unreadable or vanished folder in its
    // `error` field rather than throwing. A `success` here is a real listing,
    // not an acknowledgement — so there is no read-back trap on this route; the
    // trap is on `session/new`, where the client verifies the resulting id and
    // cwd against `/state`.
    if (url.pathname === "/fs/list") {
      const path = typeof body.path === "string" ? body.path : undefined;
      json(res, 200, listDirectories(path, EXCLUDED_DIRS));
      return;
    }

    // ── create a session ──
    if (url.pathname === "/session/new") {
      const rawCwd = typeof body.cwd === "string" && body.cwd.trim() !== ""
        ? body.cwd
        : DEFAULT_CWD;
      // The same gate the listing route uses (shared helper, so the two cannot
      // drift): no session may be CREATED inside an excluded directory either,
      // including through a symlink alias. The picker's disabled Start button is
      // UI convenience; this refusal is the enforcement.
      const refusal = pathRefusal(rawCwd, EXCLUDED_DIRS);
      if (refusal) {
        json(res, 403, { error: `a session cannot be started there — ${refusal.error}` });
        return;
      }
      const cwd = resolvePath(rawCwd);
      journal.beginSessionCreation();
      try {
        const rec = await manager.newSession(cwd);
        journal.promoteSession(rec.sessionId);
        json(res, 200, { session: manager.describe(rec) });
      } finally {
        journal.endSessionCreation();
      }
      return;
    }

    // ── load a session from disk ──
    if (url.pathname === "/session/load") {
      const sessionId = str(body, "sessionId");
      // The cwd is not optional to the agent and it is not ours to invent. It
      // comes off the roster row for this session, which is where it is
      // recorded, unless the caller states one explicitly.
      let cwd: string | null =
        typeof body.cwd === "string" && body.cwd.trim() !== "" ? resolvePath(body.cwd) : null;
      if (cwd === null) {
        const { sessions } = await manager.listSessions();
        const row = sessions.find((s: any) => s?.sessionId === sessionId);
        if (!row || typeof row.cwd !== "string") {
          json(res, 404, {
            error:
              `session '${sessionId}' is not on this machine's roster, so there is no cwd to ` +
              `load it with. Pass one explicitly if you know it.`,
          });
          return;
        }
        cwd = row.cwd;
      }
      // Same shared gate as /fs/list and /session/new: a session is never
      // LOADED into an excluded directory either — the roster can hold records
      // whose cwd is excluded (created before the guard, or by another tool),
      // and activating one would put a write-capable agent inside it.
      const refusal = pathRefusal(cwd, EXCLUDED_DIRS);
      if (refusal) {
        json(res, 403, { error: `this session cannot be opened — ${refusal.error}` });
        return;
      }
      const rec = await manager.loadSession(sessionId, cwd);
      json(res, 200, { session: manager.describe(rec) });
      return;
    }

    // ── retry a failed agent start (WP10) ──
    // The one honest action behind the failure screen's "Try again": only
    // meaningful when the agent is FAILED (startup_failed or crash_loop) —
    // mid-run deaths respawn on their own. Re-runs the same bring-up; a
    // still-broken install fails again into the same screen, with the reason.
    if (url.pathname === "/agent/restart") {
      if (manager.state !== "failed") {
        json(res, 400, { error: "the agent is not in a failed state — nothing to retry" });
        return;
      }
      /* One bring-up at a time: a double-click must not race two spawns. */
      if (restartInFlight) {
        json(res, 409, { error: "a restart is already in flight" });
        return;
      }
      restartInFlight = true;
      try {
        /* The operator may have just fixed the install or the config — the
           facts the first-run surface shows are re-read here, still read-only
           and D81-scoped. retryStart takes the respawn door (a failed start
           leaves the old generation attached; a plain start() would refuse
           with "already started" — caught in live verification). */
        AGENT_CONFIG_FACTS = readAgentConfigFacts();
        await manager.retryStart();
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      } finally {
        restartInFlight = false;
      }
      return;
    }

    // ── send a prompt ──
    if (url.pathname === "/prompt") {
      const sessionId = str(body, "sessionId");
      const text = str(body, "text");
      manager.startTurn(sessionId, text); // throws if a turn is already running
      json(res, 202, { accepted: true, sessionId });
      return;
    }

    // ── stop a turn ──
    if (url.pathname === "/session/cancel") {
      json(res, 200, manager.cancel(str(body, "sessionId")));
      return;
    }

    // ── mode ──
    if (url.pathname === "/session/mode") {
      json(res, 200, await manager.setMode(str(body, "sessionId"), str(body, "modeId")));
      return;
    }

    // ── model and reasoning effort ──
    if (url.pathname === "/session/model") {
      const effort = body.reasoningEffort;
      json(
        res,
        200,
        await manager.setModel(
          str(body, "sessionId"),
          str(body, "modelId"),
          typeof effort === "string" && effort !== "" ? effort : undefined,
        ),
      );
      return;
    }

    // ── the roster: every session on this machine, ours and not ──
    if (url.pathname === "/sessions/list") {
      json(res, 200, await manager.listSessions());
      return;
    }

    // ── slash commands ──
    // A payload with no command array is a READ FAILURE, not an empty list
    // (WP7 §2). 502, so the launcher can say "could not be read" instead of
    // telling the operator this agent has no commands.
    if (url.pathname === "/commands/list") {
      const sessionId = typeof body.sessionId === "string" && body.sessionId !== ""
        ? body.sessionId
        : undefined;
      try {
        json(res, 200, await manager.listCommands(sessionId));
      } catch (err) {
        if ((err as any)?.unreadableCatalogue !== true) throw err;
        json(res, 502, { error: redact(String((err as Error).message)), unreadable: true });
      }
      return;
    }

    // ── context reading ──
    if (url.pathname === "/session/info") {
      const sessionId = str(body, "sessionId");
      const info = await manager.sessionInfo(sessionId);
      if (!info) {
        json(res, 502, {
          error:
            `session/info returned a success with no reading in it. That is what it does for a ` +
            `session id it does not know — it is not a reading of zero. See the log.`,
        });
        return;
      }
      json(res, 200, info);
      return;
    }

    // ── compact ──
    if (url.pathname === "/session/compact") {
      const userContext = typeof body.userContext === "string" ? body.userContext : undefined;
      json(res, 200, await manager.compact(str(body, "sessionId"), userContext));
      return;
    }

    // ══ WP11: changes, and undo (the hunk tracker) ═════════════════════════
    // Like every route below the gates, these inherit Host/Origin/token/method
    // by position. Each manager method require()s the sessionId locally before
    // the wire (F3's inconsistent -32602/-32603 never reach the page) and takes
    // its verdict from a get-files/get-summary READ-BACK, never from the
    // action's ack (rule 1, F13). No git operation exists anywhere in here —
    // a reject rewrites the file to its pre-edit baseline and nothing more.

    // ── one reading of the pending changes (files + per-turn summary) ──
    if (url.pathname === "/changes") {
      json(res, 200, await manager.changes(str(body, "sessionId")));
      return;
    }

    // ── one file's hunks (non-absolute path refused in the manager, 400) ──
    if (url.pathname === "/changes/hunks") {
      json(res, 200, await manager.hunks(str(body, "sessionId"), str(body, "path")));
      return;
    }

    // ── undo one of the agent's hunks ──
    if (url.pathname === "/changes/hunk-action") {
      json(res, 200, await manager.hunkAction(str(body, "sessionId"), str(body, "hunkId"), "reject"));
      return;
    }

    // ── mark one file reviewed (never stages; the safe direction) ──
    // body.hunkIds binds the accept to the hunks the operator actually saw;
    // the manager re-reads them and refuses a mismatch (Codex 5).
    if (url.pathname === "/changes/file-action") {
      json(res, 200, await manager.fileAction(str(body, "sessionId"), str(body, "path"), "accept", body.hunkIds));
      return;
    }

    // ── undo everything from one turn (promptIndex from get-summary only) ──
    if (url.pathname === "/changes/turn-action") {
      json(res, 200, await manager.turnAction(str(body, "sessionId"), body.promptIndex, "reject"));
      return;
    }

    // ══ WP13: session management & portability (D58–D61) ══════════════════
    // All below sit under the same Host/Origin/token gates as every POST. Each
    // manager method reads state back before it reports success (rule 1).

    // ── rename a session ──
    // cwd is resolved server-side (held record or roster), never from the body:
    // a browser-supplied cwd is deliberately IGNORED so a rename cannot be aimed
    // at a directory the caller names (contrast /session/load's escape hatch).
    // A blank title is refused inside the manager (400, badRequest).
    if (url.pathname === "/session/rename") {
      const sessionId = str(body, "sessionId");
      const title = typeof body.title === "string" ? body.title : "";
      json(res, 200, await manager.renameSession(sessionId, title));
      return;
    }

    // ── archive / restore (local hidden-list; touches nothing in Grok) ──
    // Pure local list-keeping — no ACP call, nothing deleted. `changed:false`
    // reports a no-op honestly (already archived / not archived), never a
    // manufactured success. An archived session still loads if selected.
    if (url.pathname === "/session/archive") {
      const sessionId = str(body, "sessionId");
      const changed = archive.archive(sessionId);
      if (changed) broadcast(bridgeEvent("bridge.archive_changed", { archivedIds: archive.list() }));
      json(res, 200, { ok: true, sessionId, archived: true, changed });
      return;
    }
    if (url.pathname === "/session/restore") {
      const sessionId = str(body, "sessionId");
      const changed = archive.restore(sessionId);
      if (changed) broadcast(bridgeEvent("bridge.archive_changed", { archivedIds: archive.list() }));
      json(res, 200, { ok: true, sessionId, archived: false, changed });
      return;
    }

    // ── auto-approve: the connection-wide permission mode (D58/D62) ──
    // No sessionId — it is global by protocol (the yolo notification carries
    // none). The manager fires the one-way notification and reads yolo back from
    // sessions/list; it never writes config.toml. A mode outside the whitelist
    // is a 400 (badRequest in the manager).
    if (url.pathname === "/session/permission-mode") {
      const mode = str(body, "mode");
      json(res, 200, await manager.setPermissionMode(mode));
      return;
    }

    // ── WP15: re-read config/auth facts on demand (panel open) ──
    // Same shape as agentConfig on /state. Forces a fresh disk read so the
    // privacy panel never opens on a startup-stale value.
    if (url.pathname === "/agent/config-facts") {
      AGENT_CONFIG_FACTS = readAgentConfigFacts();
      json(res, 200, { agentConfig: AGENT_CONFIG_FACTS });
      return;
    }

    // ── WP15 / D87: coding-data retention switch ──
    // Drives the agent's own `_x.ai/privacy/setCodingDataRetention`. This app
    // NEVER writes auth.json — the agent does. Three honest outcomes only
    // (never an optimistic flip): verified / acknowledged_not_confirmed /
    // refused. auth.json sha256 logged before/after (digest only).
    if (url.pathname === "/agent/retention") {
      if (typeof body.codingDataRetentionOptOut !== "boolean") {
        const err: any = new Error("codingDataRetentionOptOut must be a boolean");
        err.badRequest = true;
        throw err;
      }
      const requested = body.codingDataRetentionOptOut as boolean;
      const digestBefore = authDigest();
      console.log(`[privacy] setCodingDataRetention requested=${requested} auth.json sha256 before=${digestBefore ?? "unreadable"}`);
      try {
        const reply = await manager.setCodingDataRetention(requested);
        AGENT_CONFIG_FACTS = readAgentConfigFacts();
        const digestAfter = authDigest();
        console.log(`[privacy] replyAgreed=${reply.replyAgreed} auth.json sha256 after=${digestAfter ?? "unreadable"} changed=${digestBefore !== digestAfter}`);
        const fileOptOut = AGENT_CONFIG_FACTS.retention.retentionOptOut;
        const fileFollowed = fileOptOut === requested;
        let outcome: "verified" | "acknowledged_not_confirmed";
        let note: string;
        if (reply.replyAgreed && fileFollowed) {
          outcome = "verified";
          note = requested
            ? "Verified — coding-data retention opt-out is ON. Your code data will not be trained on or used to improve the product."
            : "Verified — coding-data retention opt-out is OFF. Usage and code data may be used to improve the product.";
        } else {
          /* The trap from upstream privacy.rs: the agent DISCARDS its local
             save result (`let _ =`), so "reply agreed, file stale" is real. */
          outcome = "acknowledged_not_confirmed";
          note = reply.replyAgreed
            ? "Acknowledged, not confirmed — the account may have changed while the local file did not."
            : "Acknowledged, not confirmed — the agent replied but the reading does not match the request.";
        }
        json(res, 200, {
          outcome,
          note,
          requested,
          replyOptOut: reply.replyOptOut,
          replyAgreed: reply.replyAgreed,
          fileOptOut,
          fileFollowed,
          authDigestBefore: digestBefore,
          authDigestAfter: digestAfter,
          agentConfig: AGENT_CONFIG_FACTS,
        });
      } catch (err) {
        /* Refused: the agent's error, verbatim, as text (hostile input). A
           ZDR/team-locked account refuses; surface the refusal, never
           pre-hide the control. Still a 200 so the client can render the
           third distinct sentence without treating it as a transport failure. */
        const e = err as any;
        if (e?.badRequest === true) throw err;
        AGENT_CONFIG_FACTS = readAgentConfigFacts();
        const digestAfter = authDigest();
        console.log(`[privacy] REFUSED: ${redact(String(e?.message ?? err))} auth.json sha256 after=${digestAfter ?? "unreadable"}`);
        /* Prefer the agent's own data/message field when present (AcpRpcError). */
        let agentText = String(e?.message ?? err);
        if (e?.data != null) {
          const d = e.data;
          if (typeof d === "string" && d.trim()) agentText = d;
          else if (d && typeof d === "object" && typeof (d as any).message === "string") agentText = (d as any).message;
        }
        json(res, 200, {
          outcome: "refused",
          note: "Refused — " + agentText,
          requested,
          replyOptOut: null,
          replyAgreed: false,
          fileOptOut: AGENT_CONFIG_FACTS.retention.retentionOptOut,
          fileFollowed: false,
          authDigestBefore: digestBefore,
          authDigestAfter: digestAfter,
          agentConfig: AGENT_CONFIG_FACTS,
          error: agentText,
        });
      }
      return;
    }

    // ── delete a session (PERMANENT — D59) ──
    // The manager reads GONE back from sessions/list before it reports success,
    // refuses while a turn or a load is in flight (400), and treats a thrown
    // request as "the session is INTACT" — never as a delete. The reply is always a
    // structured verdict ({deleted, goneFromRoster, intact?}) so the client can
    // show the honest outcome; it never assumes success from a 200. cwd is
    // resolved server-side, never taken from the body.
    if (url.pathname === "/session/delete") {
      const sessionId = str(body, "sessionId");
      const verdict = await manager.deleteSession(sessionId);
      // Membership pruning after a VERIFIED delete, not a data delete: the
      // archive is a local hidden-list of ids, and an id whose session is gone
      // would sit in it forever, inflating "Archived (N)". Only on the verdict
      // that read GONE back — a no-op or an INTACT delete leaves it alone.
      // The prune runs AFTER the delete is verified, so it must never be able to
      // change the answer: a throw here (an unwritable archive file) would land
      // in the generic catch and tell the operator "Not deleted — the session is
      // intact. Try again." about a session that is permanently gone. Local
      // bookkeeping fails loudly on its own and the earned verdict still ships.
      if (verdict.deleted && verdict.goneFromRoster) {
        try {
          const changed = archive.restore(sessionId);
          if (changed) broadcast(bridgeEvent("bridge.archive_changed", { archivedIds: archive.list() }));
        } catch (err) {
          console.error(
            `[http] session ${sessionId} was deleted and verified gone, but pruning it out of the ` +
              `archive list failed: ${redact(String((err as any)?.message ?? err))}. The delete ` +
              `stands; the archive list may still name a session that no longer exists.`,
          );
        }
      }
      json(res, 200, verdict);
      return;
    }

    // ── export a session to a portable file (D61) ──
    // Two formats: the round-trippable Grok-native bundle (JSON), and a one-way
    // Markdown transcript. The server returns {filename, content}; the client
    // saves it. The bundle's `updates` are RAW envelopes (import consumes them
    // verbatim); the Markdown is derived through the events boundary. cwd is
    // resolved server-side. A truncated transcript refuses the bundle and marks
    // the Markdown incomplete — see the hasMore split below.
    if (url.pathname === "/session/export") {
      const sessionId = str(body, "sessionId");
      const format = body.format === "markdown" ? "markdown" : "bundle";
      const bundle = await manager.exportSession(sessionId);
      // The id is a UUID by the time it resolves, but sanitize the filename
      // defensively — it becomes a download name in the browser.
      const safeId = sessionId.replace(/[^0-9A-Za-z._-]/g, "_");
      // A truncated transcript (hasMore) means the two formats part company.
      // The BUNDLE is round-trippable or it is nothing: an incomplete one would
      // import as a whole session and quietly lose the history it never carried,
      // so it is refused outright (400, the caller-error family). The MARKDOWN
      // is a one-way reading copy, so a partial transcript is still worth
      // having — but it says so in its own filename and in its first line, and
      // the client notes it as a warning rather than a quiet success.
      if (format === "bundle" && bundle.hasMore) {
        json(res, 400, {
          error:
            `this session's transcript was truncated by the agent (hasMore), so the bundle would ` +
            `be incomplete and could not round-trip faithfully. Nothing was exported. Export as ` +
            `Markdown if you want the part that is readable.`,
        });
        return;
      }
      if (format === "markdown") {
        json(res, 200, {
          ok: true,
          format,
          filename: `graphometer-session-${safeId}${bundle.hasMore ? "-incomplete" : ""}.md`,
          content: bundleToMarkdown(bundle),
          hasMore: bundle.hasMore,
        });
      } else {
        json(res, 200, {
          ok: true,
          format,
          filename: `graphometer-session-${safeId}.json`,
          content: JSON.stringify(bundle, null, 2),
          hasMore: bundle.hasMore,
        });
      }
      return;
    }

    // ── import a session from a bundle (D61) ──
    // The client reads the file, JSON-parses it, and posts {bundle}. The manager
    // refuses foreign/invalid shapes locally, then reads the id back from
    // sessions/list — {imported:false} is a silent refuse-overwrite, never a
    // fresh success.
    if (url.pathname === "/session/import") {
      // A bundle names its OWN destination cwd, so an import is session CREATION
      // at a caller-chosen path — the same shared gate as /session/new and
      // /session/load, or a crafted bundle would reconstruct a session inside an
      // excluded directory that neither route would ever have started there. A
      // missing or malformed cwd is not this gate's business: it falls through
      // to importSession's own validation (400).
      let bundle = body.bundle;
      const rawCwd = bundle?.cwd;
      if (typeof rawCwd === "string" && rawCwd.trim() !== "") {
        // The string the gate judges must be the string that ships. A relative
        // or space-padded cwd resolves against THIS process's directory here
        // and against the agent child's when it lands, so gate and consumer
        // would name different folders. Every honest export writes an absolute
        // path (exportSession takes it from the agent's own record), so a
        // non-absolute one only ever arrives in a crafted bundle.
        if (!isAbsolute(rawCwd)) {
          json(res, 400, {
            error:
              `this bundle's destination folder is not an absolute path, so it would mean one ` +
              `folder to this app and another to the agent. Nothing was imported`,
          });
          return;
        }
        const cwd = resolvePath(rawCwd);
        const refusal = pathRefusal(cwd, EXCLUDED_DIRS);
        if (refusal) {
          json(res, 403, { error: `a session cannot be imported there — ${refusal.error}` });
          return;
        }
        // A bundle carries its destination TWICE: `cwd`, and the session's own
        // recorded identity at `state.summary.info.cwd` — which importSession
        // forwards to the wire verbatim, inside `state`. Gating one and
        // shipping both would leave the second unjudged, so require them to
        // agree: an honest export writes the same folder in both, and a
        // disagreement is a crafted bundle naming a destination the gate never
        // saw. One string to judge, no second channel.
        const infoCwd = bundle?.state?.summary?.info?.cwd;
        if (
          typeof infoCwd === "string" &&
          infoCwd.trim() !== "" &&
          (!isAbsolute(infoCwd) || resolvePath(infoCwd) !== cwd)
        ) {
          json(res, 400, {
            error:
              `this bundle names two different destination folders — its own cwd and the ` +
              `session's recorded folder disagree, so it is not a faithful export. Nothing was ` +
              `imported`,
          });
          return;
        }
        bundle = { ...bundle, cwd };
      }
      json(res, 200, await manager.importSession(bundle));
      return;
    }

    // ── answer a blocking interaction (permission, plan exit, question) ──
    // The historical route name survives from when permissions were the only
    // interaction it answered. Body by kind: permission/plan send {key,
    // optionId, cancel?, feedback?}; questions send {key, outcome, answers?}.
    // Validation lives in answerInteraction — wrong shapes come back 400 with
    // a sentence, never silently forwarded.
    if (url.pathname === "/permission") {
      const key = String(body.key ?? "");
      const result = manager.answerInteraction(
        key,
        typeof body.optionId === "string" ? body.optionId : null,
        body.cancel === true,
        {
          ...(body.feedback !== undefined ? { feedback: body.feedback } : {}),
          ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
          ...(body.answers !== undefined ? { answers: body.answers } : {}),
        },
      );
      json(res, 200, result);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
  } catch (err) {
    const e = err as any;
    // A refused sessionId, an already-running turn, a choice the agent never
    // offered: all caller errors, and all of them carry a sentence worth
    // showing. Anything genuinely unexpected still lands here as a 500.
    //
    // redact(): the /events URL carries the token, so an error that quotes a URL
    // must not reach the terminal or the response with it still in.
    const message = redact(String(e?.message ?? err));
    /* WP11 (Opus M2): an error marked `sent` comes from a changes action
       AFTER its request resolved (or from the send itself, which may have
       reached the agent). It must be a 500 no matter what its message text
       contains — agent-supplied text can otherwise match an unanchored
       caller-error pattern below and flip a fired action to a 400 "nothing
       was changed", a lie about the disk. The flag is checked first. */
    const isCallerError =
      e?.sent === true
        ? false
        : e?.badRequest === true ||
          /^this app does not hold a session|^session '.*' is in the map|^a turn is already running|^no open interaction|was not offered by the agent|^the agent is not ready|is already live in this app/.test(
            message,
          );
    // A caller error is a sentence, not an incident. Printing a stack for every
    // refused session id buries the ones that matter in noise the operator
    // cannot act on.
    console.error(
      isCallerError ? `[http] ${message}` : `[http] ${redact(String(e?.stack ?? err))}`,
    );
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, isCallerError ? 400 : 500, {
      error: message,
      ...(e?.offered ? { offered: e.offered } : {}),
      /* WP11 (Opus N2): a changes action marks provably pre-wire failures
         notSent, so the page can say "nothing was changed" without hedging —
         the 500 below it is then unambiguous: the action may have fired. */
      ...(e?.notSent === true ? { notSent: true } : {}),
    });
  }
});

// ── shutdown ────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[studio] shutting down (${reason})`);

  let disposition: ShutdownDisposition;
  try {
    const cleanup = await manager.stop();
    disposition = shutdownDisposition(cleanup);
  } catch (err) {
    const pgids = manager.acp.retainedGenerationPgids;
    const named = pgids.length > 0 ? pgids.join(", ") : "unavailable";
    disposition = {
      exitCode: 1,
      error:
        `[studio] FATAL: cleanup for original process group ${named} threw during shutdown; ` +
        `cleanup is unverified and processes may remain. ${(err as Error).stack ?? err}. ` +
        `Exiting non-zero.`,
    };
  }

  const after = configMd5();
  const verdict = after === CONFIG_MD5_AT_START ? "UNCHANGED" : "CHANGED";
  console.log(`[studio] ~/.grok/config.toml md5 at start: ${CONFIG_MD5_AT_START}`);
  console.log(`[studio] ~/.grok/config.toml md5 at exit : ${after}  [${verdict}]`);
  if (verdict !== "UNCHANGED") {
    console.error("[studio] !! config.toml changed during this run — investigate");
  }

  for (const c of sseClients) {
    try {
      c.res.end();
    } catch {
      /* going away anyway */
    }
  }
  server.close();
  completeShutdown(disposition, {
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
// SIGHUP matters specifically because the agent is spawned detached: closing the
// terminal signals the foreground process group, which the agent is no longer
// part of. Without this handler it would survive the window closing.
process.on("SIGHUP", () => void shutdown("SIGHUP"));
// Last resort: if we leave by any other door, do not orphan the child.
process.on("exit", () => manager.acp.killNow());

process.on("uncaughtException", (err) => {
  console.error(`[studio] uncaught exception: ${err.stack ?? err}`);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (err) => {
  console.error(`[studio] unhandled rejection: ${(err as Error)?.stack ?? err}`);
});

// ── go ──────────────────────────────────────────────────────────────────

server.listen(PORT, HOST, async () => {
  const startUrl = `http://${HOST}:${PORT}/?token=${RUN_TOKEN}`;
  console.log("");
  console.log("  Graphometer");
  console.log(`  listening on ${HOST}:${PORT}  (loopback only)`);
  console.log(`  default session cwd: ${DEFAULT_CWD}`);
  console.log(`  ~/.grok/config.toml md5 at start: ${CONFIG_MD5_AT_START}`);
  console.log("");
  console.log("  This app spawns a child 'grok' process. Its PID is printed below.");
  console.log("  It is killed when this server exits.");
  console.log("");
  console.log("  OPEN THIS — it is the only way in:");
  console.log("");
  console.log(`      ${startUrl}`);
  console.log("");
  console.log("  The token is in the URL because the page carries it: without the token there");
  console.log("  is no page to scrape it out of. New token every start; it dies with this");
  console.log("  process. Nothing is served to a caller that does not already hold it.");
  console.log("");
  if (DEV) {
    console.log("  STUDIO_DEV=1 — development surfaces are on. The raw event view is the");
    console.log("  same URL with /bridge in place of / :");
    console.log("");
    console.log(`      http://${HOST}:${PORT}/bridge?token=${RUN_TOKEN}`);
    console.log("");
  }

  try {
    await manager.start();
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[studio] agent bring-up FAILED: ${message}`);
    manager.acp.loud(`agent bring-up failed: ${message}`);
    broadcast(bridgeEvent("bridge.fatal", { error: message }, message));
    // Stay up so the browser can show what went wrong, rather than vanishing.
  }
});
