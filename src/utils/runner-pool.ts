/**
 * Many games at once: one GodotRunner per project, chosen by project path.
 *
 * GodotRunner stays what it was, a one-session machine with its epoch guard,
 * exit handler and per-command timeouts. The pool holds one runner per
 * canonical project path, so a `run_project` can only ever replace the game of
 * its own project, and a session tool reaches the session its `projectPath`
 * names or is refused: it never falls back to some other live session.
 *
 * Four things live here and nowhere else:
 *  - the project's identity (`canonicalizeProjectArgs`): one canonical string,
 *    put back into the arguments before any handler sees them;
 *  - the lifecycle lock per project (`withLifecycle`): launches and stops of
 *    one project are serialised, and a launch in progress counts as a game;
 *  - the host budget (`admit`): a count of Godot games in the process table;
 *  - ownership (`sessions/<key>.json`): the server kills only what it started.
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';

import { GodotRunner, type GodotProcess, type GodotServerConfig } from './godot-runner.js';
import { findFreePort } from './bridge-protocol.js';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.js';
import { logDebug, logError } from './logger.js';
import type { OperationParams } from '../mcp.types.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The canonical identity of a project directory. `realpathSync.native` resolves
 * symlinks (/var → /private/var) and, on macOS, restores the on-disk case, so
 * every spelling of one directory meets in one key without lower-casing, which
 * would merge two real projects on a case-sensitive volume.
 */
export function projectKey(projectPath: string, cwd: string = process.cwd()): string {
  const abs = isAbsolute(projectPath) ? projectPath : resolve(cwd, projectPath);
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    real = resolve(abs);
  }
  while (real.length > 1 && real.endsWith(sep)) real = real.slice(0, -1);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

export type Canonicalized =
  | { ok: true; args: OperationParams; key: string | null }
  | { ok: false; message: string };

/**
 * Normalise the parameter NAME first, then the path. The handlers run their own
 * `normalizeParameters`, which maps `project_path` onto `projectPath`; if only
 * `projectPath` were canonicalised here, a call carrying both spellings would
 * have the canonical value overwritten by the alias it kept.
 */
export function canonicalizeProjectArgs(args: OperationParams, cwd?: string): Canonicalized {
  for (const name of ['projectPath', 'project_path']) {
    if (
      Object.prototype.hasOwnProperty.call(args, name) &&
      (typeof args[name] !== 'string' ||
        (args[name] as string).trim() === '' ||
        (args[name] as string).includes('\0'))
    ) {
      return {
        ok: false,
        message: `${name} must be a non-empty project path string when supplied. Omit it only when this server permits implicit routing.`,
      };
    }
  }
  const camel = args.projectPath;
  const snake = args.project_path;
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    return {
      ok: false,
      message:
        'projectPath and project_path were both given with different values. Pass one of them.',
    };
  }
  const raw = camel !== undefined ? camel : snake;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: true, args, key: null };
  }
  const key = projectKey(raw, cwd);
  const next: OperationParams = { ...args, projectPath: key };
  delete next.project_path;
  return { ok: true, args: next, key };
}

// ---------------------------------------------------------------------------
// The process table
// ---------------------------------------------------------------------------

export interface HostProcess {
  pid: number;
  ppid: number;
  rssKb: number;
  /** `ps -o lstart`, the OS's own start stamp; identifies a pid across reuse. */
  startedAt: string;
  command: string;
}

export type ProcessLister = () => HostProcess[];

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/;

export function parsePs(text: string): HostProcess[] {
  const out: HostProcess[] = [];
  for (const line of text.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    out.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      startedAt: (m[4] ?? '').replace(/\s+/g, ' '),
      command: m[5] ?? '',
    });
  }
  return out;
}

export const defaultProcessLister: ProcessLister = () => {
  if (process.platform === 'win32') throw new Error('Process inspection is unavailable on Windows');
  // LC_ALL=C: `lstart` is localised. On a Spanish macOS it prints "sáb 19 sep …", which the
  // parser does not read, and an empty table silently switches the host budget off.
  const text = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,command='], {
    env: { ...process.env, LC_ALL: 'C' },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = parsePs(text);
  if (rows.length === 0) throw new Error('ps returned no readable process rows');
  return rows;
};

export interface HostGame extends HostProcess {
  /** The `--path` value as launched (canonicalised for comparison). */
  projectPath: string;
}

/**
 * A Godot *game*: a Godot binary with `--path` among its engine arguments and
 * neither `--headless` nor `-e`/`--editor`. Only arguments before a standalone
 * `--` are engine arguments; after it they are the game's own (`userArgs` may
 * contain `--path` or `--headless` and must not count). The project manager the
 * owner leaves open has no `--path` and is never a game.
 */
export function gamesOnHost(procs: HostProcess[]): HostGame[] {
  return parseHostGames(procs, false);
}

/** Admission also inspects flags after --path: ps may have split a folder name. */
function parseHostGames(procs: HostProcess[], includeAmbiguousPaths: boolean): HostGame[] {
  const games: HostGame[] = [];
  for (const p of procs) {
    const tokens = [...p.command.matchAll(/\S+/g)];
    const bin = tokens[0]?.[0] ?? '';
    if (!/(^|\/)godot[^/]*$/i.test(bin)) continue;
    const end = tokens.findIndex((t) => t[0] === '--');
    const engine = end === -1 ? tokens.slice(1) : tokens.slice(1, end);
    const i = engine.findIndex((t) => t[0] === '--path');
    if (i === -1 || i + 1 >= engine.length) continue;
    const excluded = engine.findIndex((t) =>
      ['--headless', '-e', '--editor', '-p', '--project-manager'].includes(t[0]),
    );
    if (excluded !== -1 && (!includeAmbiguousPaths || excluded < i + 1)) continue;
    // A path with spaces is split by ps; rejoin up to the next engine flag.
    const parts: RegExpExecArray[] = [];
    for (const token of engine.slice(i + 1)) {
      if (token[0].startsWith('-')) break;
      parts.push(token);
    }
    // A scene argument (res://… or *.tscn) follows the path; it is not part of it.
    while (parts.length > 1 && /(^res:\/\/|\.t?scn$)/.test(parts.at(-1)?.[0] ?? '')) {
      parts.pop();
    }
    const first = parts[0];
    const last = parts.at(-1);
    if (first && last) {
      games.push({
        ...p,
        projectPath: projectKey(p.command.slice(first.index, last.index + last[0].length)),
      });
    }
  }
  return games;
}

/** ps loses argv boundaries. An ambiguous space-prefix must refuse, never admit a duplicate. */
function possiblySameProject(parsed: string, key: string): boolean {
  const a = parsed.replace(/\s+/g, ' ');
  const b = key.replace(/\s+/g, ' ');
  return a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
}

// ---------------------------------------------------------------------------
// Tool classes
// ---------------------------------------------------------------------------

/** Tools that act on a running session and carry no other project reference. */
export const SESSION_TOOLS: ReadonlySet<string> = new Set([
  'detach_project',
  'get_debug_output',
  'stop_project',
  'take_screenshot',
  'simulate_input',
  'get_ui_elements',
  'run_script',
  'profile_project',
  'start_profiler',
  'stop_profiler',
]);

/** Tools that start or end a session: serialised per project. */
const LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
  'run_project',
  'attach_project',
  'stop_project',
  'detach_project',
]);

/** Tools that take no project at all. */
const NO_PROJECT_TOOLS: ReadonlySet<string> = new Set([
  'list_projects',
  'list_sessions',
  'get_server_info',
]);

export type Resolution =
  | { kind: 'runner'; runner: GodotRunner; key: string | null }
  | { kind: 'refusal'; message: string };

export type EndReason =
  | 'stopped'
  | 'exited'
  | 'idle_stop'
  | 'replaced'
  | 'launch_failed'
  | 'server_shutdown';

export interface SessionInfo {
  projectPath: string;
  mode: 'spawned' | 'attached' | null;
  state: 'launching' | 'live' | 'exited';
  running: boolean;
  exitCode: number | null;
  pid: number | null;
  bridgePort: number | null;
  profiling: boolean;
  startedAt: string | null;
  lastUsedAt: string | null;
  idleSeconds: number | null;
  lastCommand: { tool: string; startedAt: string; finishedAt: string | null } | null;
}

interface Entry {
  key: string;
  runner: GodotRunner;
  launching: boolean;
  startedAt: number | null;
  lastFinishedAt: number | null;
  inFlight: number;
  noIdleStop: boolean;
  lastCommand: { tool: string; startedAt: number; finishedAt: number | null } | null;
  /** Tail of the per-key lifecycle chain. */
  chain: Promise<unknown>;
  queued: number;
  attempt: { previous: GodotProcess | null; child: GodotProcess | null } | null;
  owned: OwnedProcess | null;
}

interface PidFile {
  pid: number;
  startedAt: string;
  projectPath: string;
  serverPid: number;
  serverStartedAt: string;
}

interface OwnedProcess {
  proc: GodotProcess;
  record: PidFile;
  intent: EndReason | null;
  ended: boolean;
}

export interface RunnerPoolOptions {
  runnerConfig?: GodotServerConfig;
  serverConfig?: ServerConfig;
  /** Where ownership records live. Shared by every server of one build. */
  stateDir?: string | null;
  listProcesses?: ProcessLister;
  now?: () => number;
  /** Test seam: build a runner. */
  createRunner?: (config: GodotServerConfig) => GodotRunner;
  /** Test seam: end a process. */
  kill?: (pid: number) => void;
}

const PORT_REUSE_MS = 30_000;

export class RunnerPool {
  private entries = new Map<string, Entry>();
  private readonly defaultRunner: GodotRunner;
  private readonly runnerConfig: GodotServerConfig;
  readonly serverConfig: ServerConfig;
  private readonly stateDir: string | null;
  private readonly listProcesses: ProcessLister;
  private readonly now: () => number;
  private readonly createRunner: (config: GodotServerConfig) => GodotRunner;
  private readonly kill: (pid: number) => void;
  private recentPorts = new Map<number, number>();
  private recentlyEnded: {
    projectPath: string;
    reason: EndReason;
    exitCode: number | null;
    pid: number | null;
    startedAt: string | null;
    at: string;
  }[] = [];
  private idleEnded = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;
  private serverStartedAt: string | null = null;
  private shuttingDown = false;

  constructor(options: RunnerPoolOptions = {}) {
    this.serverConfig = options.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
    this.stateDir = options.stateDir === undefined ? null : options.stateDir;
    this.listProcesses = options.listProcesses ?? defaultProcessLister;
    this.now = options.now ?? Date.now;
    this.kill =
      options.kill ??
      ((pid) => {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      });
    this.createRunner = options.createRunner ?? ((config) => new GodotRunner(config));
    this.runnerConfig = { ...options.runnerConfig, allocatePort: () => this.allocatePort() };
    this.defaultRunner = this.createRunner(this.runnerConfig);
    if (this.serverConfig.idleStopMinutes > 0) {
      this.sweepTimer = setInterval(() => {
        if (this.sweepInFlight || this.shuttingDown) return;
        this.sweepInFlight = true;
        void this.sweepIdle()
          .catch((error: unknown) => logError(`Idle sweep failed: ${String(error)}`))
          .finally(() => {
            this.sweepInFlight = false;
          });
      }, 60_000);
      this.sweepTimer.unref();
    }
  }

  get idleRunner(): GodotRunner {
    return this.defaultRunner;
  }

  /** Resolve the Godot binary once, then hand the answer to every runner. */
  async detectGodotPath(): Promise<string | null> {
    await this.defaultRunner.detectGodotPath();
    const path = this.defaultRunner.getGodotPath();
    if (path) this.runnerConfig.godotPath = path;
    return path;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private entryFor(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = {
        key,
        runner: this.createRunner({
          ...this.runnerConfig,
          onSpawn: (proc) => this.spawned(key, proc),
        }),
        launching: false,
        startedAt: null,
        lastFinishedAt: null,
        inFlight: 0,
        noIdleStop: false,
        lastCommand: null,
        chain: Promise.resolve(),
        queued: 0,
        attempt: null,
        owned: null,
      };
      this.entries.set(key, e);
    }
    return e;
  }

  private static hasSession(runner: GodotRunner): boolean {
    return (
      runner.activeSessionMode !== null ||
      runner.activeProcess !== null ||
      runner.activeProfiler !== null
    );
  }

  private static isLive(runner: GodotRunner): boolean {
    if (runner.activeSessionMode === 'attached') return true;
    return (
      runner.activeSessionMode === 'spawned' &&
      runner.activeProcess !== null &&
      !runner.activeProcess.hasExited
    );
  }

  private liveKeys(): string[] {
    return [...this.entries.values()]
      .filter((e) => e.queued > 0 || e.launching || RunnerPool.isLive(e.runner))
      .map((e) => e.key);
  }

  resolve(toolName: string, key: string | null): Resolution {
    if (NO_PROJECT_TOOLS.has(toolName)) {
      return { kind: 'runner', runner: this.defaultRunner, key: null };
    }
    if (!SESSION_TOOLS.has(toolName)) {
      // Names a project through its own arguments. A missing or invalid path
      // goes to the idle runner so the handler produces today's error text.
      return key === null
        ? { kind: 'runner', runner: this.defaultRunner, key: null }
        : { kind: 'runner', runner: this.entryFor(key).runner, key };
    }
    if (key !== null) {
      const e = this.entries.get(key);
      if (e && (e.queued > 0 || e.launching || RunnerPool.hasSession(e.runner))) {
        return { kind: 'runner', runner: e.runner, key };
      }
      return { kind: 'refusal', message: this.refusalNoSession(key) };
    }
    if (this.serverConfig.requireProjectPath) {
      return {
        kind: 'refusal',
        message:
          'projectPath is required on this server: several lanes share it. Pass the same projectPath you gave run_project.',
      };
    }
    const withSession = [...this.entries.values()].filter((e) => RunnerPool.hasSession(e.runner));
    const live = this.liveKeys();
    if (live.length >= 2) {
      return {
        kind: 'refusal',
        message: `${live.length} runtime sessions are live; say which with projectPath: ${live.join(', ')}.`,
      };
    }
    if (live.length === 1) {
      const e = this.entries.get(live[0] as string) as Entry;
      return { kind: 'runner', runner: e.runner, key: e.key };
    }
    if (withSession.length === 1) {
      const only = withSession[0] as Entry;
      return { kind: 'runner', runner: only.runner, key: only.key };
    }
    return { kind: 'runner', runner: this.defaultRunner, key: null };
  }

  private refusalNoSession(key: string): string {
    const idleAt = this.idleEnded.get(key);
    if (idleAt !== undefined) {
      return `No runtime session for ${key}.\nIt was stopped after ${this.serverConfig.idleStopMinutes} minutes idle; call run_project again.`;
    }
    const live = this.liveKeys();
    return `No runtime session for ${key}.\nLive sessions: ${live.length ? live.join(', ') : 'none'}.\nThis is not your session to borrow: check the projectPath you passed, or call run_project for your own project. Do not retry with another lane's path.`;
  }

  // -------------------------------------------------------------------------
  // Lifecycle lock and admission
  // -------------------------------------------------------------------------

  isLifecycleTool(toolName: string): boolean {
    return LIFECYCLE_TOOLS.has(toolName);
  }

  /**
   * Serialise launches and stops of one project. A second `run_project` for a
   * key that is launching waits for the first to settle and then replaces it; a
   * `stop_project` during a launch waits and then stops. The chain never
   * rejects, so one failed launch cannot wedge the next.
   */
  withLifecycle<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entryFor(key);
    e.queued += 1;
    const invoke = async () => {
      try {
        return await fn();
      } finally {
        e.queued -= 1;
      }
    };
    const run = e.chain.then(invoke, invoke);
    e.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * May this `run_project` add a game? Refuses; never waits, so no launch holds
   * a lifecycle lock while waiting for capacity. Returns a refusal message or
   * null. On null the entry is marked `launching`, which counts against the
   * budget until `settleLaunch`.
   */
  admit(key: string): string | null {
    if (this.shuttingDown) return 'The MCP server is shutting down; reconnect before launching.';
    const e = this.entryFor(key);
    let procs: HostProcess[];
    try {
      procs = this.listProcesses();
    } catch (error) {
      return `Process inspection failed: ${String(error)}. Cannot establish ownership or host capacity; retry when ps is available.`;
    }
    let games: HostGame[];
    try {
      games = this.knownGames(procs);
    } catch (error) {
      return `Ownership inspection failed: ${String(error)}. Cannot establish host capacity; retry when session records are readable.`;
    }
    const active = e.runner.activeProcess;
    const ownPid = active && !active.hasExited ? (active.process.pid ?? null) : null;
    const rec = this.readPidFile(key);

    // Same-path strangers: the server kills only what a server of this build
    // started and whose server is gone. Anything else is a refusal.
    const ambiguous = parseHostGames(procs, true).filter(
      (g) => !games.some((known) => known.pid === g.pid) && possiblySameProject(g.projectPath, key),
    );
    for (const g of [...games, ...ambiguous]) {
      const ours =
        rec !== null &&
        rec.projectPath === key &&
        rec.pid === g.pid &&
        rec.startedAt === g.startedAt
          ? rec
          : null;
      const ownedIdentityMatches = !e.owned || e.owned.record.startedAt === g.startedAt;
      if (
        (!ours && !possiblySameProject(g.projectPath, key)) ||
        (g.pid === ownPid && ownedIdentityMatches)
      )
        continue;
      const serverAlive =
        ours !== null &&
        procs.some((p) => p.pid === ours.serverPid && p.startedAt === ours.serverStartedAt);
      const liveNodeParent = procs.some(
        (p) => p.pid === g.ppid && /(?:^|\/)node(?:\s|$)/.test(p.command),
      );
      if (ours !== null && ours.serverStartedAt && !serverAlive && !liveNodeParent) {
        logDebug(`Reaping orphan game ${g.pid} for ${key} (its server ${ours.serverPid} is gone)`);
        this.kill(g.pid);
        let after: HostProcess[];
        try {
          after = this.listProcesses();
        } catch (error) {
          return `Orphan termination requested but process inspection failed: ${String(error)}. Ownership retained; retry run_project after inspection recovers.`;
        }
        if (after.some((p) => p.pid === g.pid && p.startedAt === g.startedAt)) {
          return `Orphan termination requested for pid ${g.pid}, but exit is unconfirmed. Ownership retained and no replacement started; wait and retry run_project.`;
        }
        this.removeMatchingRecord(ours);
        continue;
      }
      return (
        `Another Godot game is already running this project: pid ${g.pid}, parent ${g.ppid}, started ${g.startedAt}.\n` +
        (ours
          ? `It belongs to a live MCP server (pid ${ours.serverPid}). One game per worktree: stop it from that session, or use another worktree.`
          : 'This server did not start it, so it will not stop it. Stop it yourself, or use another worktree.')
      );
    }

    const max = this.serverConfig.maxGames;
    if (max > 0) {
      const replacingOwn = ownPid !== null && games.some((g) => g.pid === ownPid);
      const pending = [...this.entries.values()].filter(
        (x) => x.launching && x.key !== key && !games.some((g) => g.projectPath === x.key),
      ).length;
      const counted = games.filter((g) => g.projectPath !== key).length + pending;
      if (!replacingOwn && counted >= max) {
        const lines = games.map((g) => `  pid ${g.pid}  ${g.projectPath}`);
        return (
          `Host budget reached: ${counted} of ${max} Godot games are running on this machine.\n` +
          lines.join('\n') +
          (pending ? `\n  plus ${pending} starting on this server` : '') +
          '\nWait and retry, or report it. Do not stop a game that is not yours. The host may briefly exceed the cap when several servers start games at once.'
        );
      }
    }
    e.launching = true;
    e.attempt = { previous: e.runner.activeProcess, child: null };
    this.idleEnded.delete(key);
    return null;
  }

  /** Called only after the handler has validated and authorised every launch argument. */
  prepareLaunch(key: string): string | null {
    const refusal = this.admit(key);
    if (refusal !== null) return refusal;
    this.markStopping(key, 'replaced');
    return null;
  }

  /** Publish ownership synchronously at the runner's spawn boundary, before bridge readiness. */
  private spawned(key: string, proc: GodotProcess): void {
    const e = this.entryFor(key);
    if (e.owned?.proc === proc) return;
    if (e.attempt) e.attempt.child = proc;
    let procs: HostProcess[] = [];
    try {
      procs = this.listProcesses();
    } catch (error) {
      logDebug(`Spawn identity inspection failed: ${String(error)}`);
    }
    this.serverStartedAt ??= procs.find((p) => p.pid === process.pid)?.startedAt ?? '';
    const owned: OwnedProcess = {
      proc,
      intent: null,
      ended: false,
      record: {
        pid: proc.process.pid ?? -1,
        startedAt: procs.find((p) => p.pid === proc.process.pid)?.startedAt ?? '',
        projectPath: key,
        serverPid: process.pid,
        serverStartedAt: this.serverStartedAt,
      },
    };
    e.owned = owned;
    e.startedAt = this.now();
    this.writePidFile(owned.record);
    proc.process.once('exit', (code) =>
      this.finishProcess(owned, typeof code === 'number' ? code : null),
    );
    proc.process.once('error', () => {
      // A post-spawn error (for example kill EPERM) is not an exit event.
      if (proc.process.pid !== undefined) return;
      owned.intent = 'launch_failed';
      this.finishProcess(owned, null);
    });
    if (proc.hasExited) this.finishProcess(owned, proc.exitCode);
  }

  /** Reconcile only this attempt's child; a pre-flight error never owns the previous game. */
  async settleLaunch(key: string, succeeded: boolean): Promise<void> {
    const e = this.entries.get(key);
    if (!e?.attempt) return;
    const proc = e.runner.activeProcess;
    // Test/custom runners may not implement the callback; production has already registered it.
    if (proc && proc !== e.attempt?.previous && e.owned?.proc !== proc) this.spawned(key, proc);
    try {
      if (!succeeded) {
        const child = e.attempt?.child;
        if (child && e.owned?.proc === child) {
          e.owned.intent = 'launch_failed';
          if (e.runner.activeProcess === child) await e.runner.stopProject();
          this.finishProcess(e.owned, child.exitCode);
        } else if (e.owned && !e.owned.ended) {
          if (!e.owned.proc.terminationRequested) e.owned.intent = null;
        } else {
          this.recentlyEnded.push({
            projectPath: key,
            reason: 'launch_failed',
            exitCode: null,
            pid: null,
            startedAt: null,
            at: new Date(this.now()).toISOString(),
          });
          if (this.recentlyEnded.length > 20) this.recentlyEnded.shift();
        }
      }
    } finally {
      e.launching = false;
      e.attempt = null;
    }
  }

  markStopping(key: string, reason: EndReason): void {
    const owned = this.entries.get(key)?.owned;
    if (owned && !owned.ended) owned.intent = reason;
  }

  noteStopped(key: string): void {
    const owned = this.entries.get(key)?.owned;
    if (owned) {
      owned.intent ??= 'stopped';
      this.finishProcess(owned, owned.proc.exitCode);
    }
  }

  private finishProcess(owned: OwnedProcess, exitCode: number | null): void {
    if (owned.ended) return;
    owned.ended = true;
    this.removeMatchingRecord(owned.record);
    this.recentlyEnded.push({
      projectPath: owned.record.projectPath,
      reason: owned.intent ?? 'exited',
      exitCode,
      pid: owned.record.pid,
      startedAt: owned.record.startedAt,
      at: new Date(this.now()).toISOString(),
    });
    if (this.recentlyEnded.length > 20) this.recentlyEnded.shift();
  }

  // -------------------------------------------------------------------------
  // Bookkeeping around every call
  // -------------------------------------------------------------------------

  begin(key: string | null, tool: string): void {
    if (key === null) return;
    const e = this.entries.get(key);
    if (!e) return;
    e.inFlight += 1;
    e.lastCommand = { tool, startedAt: this.now(), finishedAt: null };
  }

  end(key: string | null): void {
    if (key === null) return;
    const e = this.entries.get(key);
    if (!e) return;
    e.inFlight = Math.max(0, e.inFlight - 1);
    e.lastFinishedAt = this.now();
    if (e.lastCommand) e.lastCommand.finishedAt = e.lastFinishedAt;
  }

  /**
   * Idle is measured from the completion of the last command and never while
   * one is in flight, so a long run_script or a slow reviewer is not idle.
   */
  async sweepIdle(): Promise<void> {
    const limitMs = this.serverConfig.idleStopMinutes * 60_000;
    if (limitMs <= 0) return;
    for (const e of this.entries.values()) {
      if (e.queued > 0 || e.launching || e.inFlight > 0 || e.noIdleStop) continue;
      if (e.runner.activeSessionMode !== 'spawned' || !RunnerPool.isLive(e.runner)) continue;
      const since = e.lastFinishedAt ?? e.startedAt;
      if (since === null || this.now() - since < limitMs) continue;
      try {
        await this.withLifecycle(e.key, async () => {
          if (e.inFlight > 0 || e.noIdleStop || !RunnerPool.isLive(e.runner)) return;
          this.markStopping(e.key, 'idle_stop');
          await e.runner.stopProject();
          this.noteStopped(e.key);
          this.idleEnded.set(e.key, this.now());
        });
      } catch (error) {
        // Keep this child's ownership and exit handler intact; the next
        // interval may retry it, while other idle projects still get cleaned.
        logError(`Idle stop failed for ${e.key}: ${String(error)}`);
      }
    }
  }

  /** `run_project` with `idleStopMinutes: 0` opts one session out of the sweep. */
  setNoIdleStop(key: string, off: boolean): void {
    this.entryFor(key).noIdleStop = off;
  }

  // -------------------------------------------------------------------------
  // Ports
  // -------------------------------------------------------------------------

  private async allocatePort(): Promise<number> {
    const held = new Set<number>();
    for (const e of this.entries.values()) {
      if (e.runner.activeBridgePort !== null) held.add(e.runner.activeBridgePort);
    }
    for (const [port, at] of this.recentPorts) {
      if (this.now() - at > PORT_REUSE_MS) this.recentPorts.delete(port);
    }
    let port = await findFreePort();
    for (let i = 0; i < 20 && (held.has(port) || this.recentPorts.has(port)); i++) {
      port = await findFreePort();
    }
    if (held.has(port) || this.recentPorts.has(port)) {
      throw new Error(
        'Could not allocate an unreserved bridge port after 20 retries. No new child was started; retry run_project.',
      );
    }
    this.recentPorts.set(port, this.now());
    return port;
  }

  // -------------------------------------------------------------------------
  // Ownership records
  // -------------------------------------------------------------------------

  private pidFilePath(key: string): string | null {
    if (!this.stateDir) return null;
    return join(this.stateDir, 'sessions', `${createHash('sha1').update(key).digest('hex')}.json`);
  }

  /** Exact recorded PID/start identity wins before ps's lossy editor/flag parsing. */
  private knownGames(procs: HostProcess[]): HostGame[] {
    const games = new Map<number, HostGame>();
    if (this.stateDir) {
      const directory = join(this.stateDir, 'sessions');
      if (existsSync(directory)) {
        for (const name of readdirSync(directory)) {
          if (!name.endsWith('.json')) continue;
          let rec: PidFile;
          try {
            rec = JSON.parse(readFileSync(join(directory, name), 'utf8')) as PidFile;
          } catch {
            continue;
          }
          if (!rec || typeof rec.projectPath !== 'string' || !rec.startedAt) continue;
          const live = procs.find((p) => p.pid === rec.pid && p.startedAt === rec.startedAt);
          if (live) games.set(live.pid, { ...live, projectPath: rec.projectPath });
        }
      }
    }
    for (const game of gamesOnHost(procs)) {
      if (!games.has(game.pid)) games.set(game.pid, game);
    }
    return [...games.values()];
  }

  private writePidFile(rec: PidFile): void {
    const path = this.pidFilePath(rec.projectPath);
    if (!path || rec.pid < 0) return;
    try {
      mkdirSync(join(this.stateDir as string, 'sessions'), { recursive: true });
      writeFileSync(path, JSON.stringify(rec));
    } catch (error) {
      logDebug(`Could not write ownership record for ${rec.projectPath}: ${String(error)}`);
    }
  }

  private readPidFile(key: string): PidFile | null {
    const path = this.pidFilePath(key);
    if (!path || !existsSync(path)) return null;
    try {
      const rec = JSON.parse(readFileSync(path, 'utf8')) as PidFile;
      return typeof rec.pid === 'number' && typeof rec.serverPid === 'number' ? rec : null;
    } catch {
      return null;
    }
  }

  private removeMatchingRecord(expected: PidFile): void {
    const path = this.pidFilePath(expected.projectPath);
    if (!path) return;
    const rec = this.readPidFile(expected.projectPath);
    if (
      !rec ||
      rec.pid !== expected.pid ||
      rec.startedAt !== expected.startedAt ||
      rec.serverPid !== expected.serverPid ||
      rec.serverStartedAt !== expected.serverStartedAt ||
      rec.projectPath !== expected.projectPath
    )
      return;
    try {
      rmSync(path, { force: true });
    } catch {
      // nothing to remove
    }
  }

  // -------------------------------------------------------------------------
  // Reporting and shutdown
  // -------------------------------------------------------------------------

  list(): {
    sessions: SessionInfo[];
    recentlyEnded: RunnerPool['recentlyEnded'];
    limits: ServerConfig & {
      gamesOnHost: number | null;
      launching: number;
      processInspectionError: string | null;
    };
  } {
    const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
    const sessions: SessionInfo[] = [];
    for (const e of this.entries.values()) {
      if (!e.launching && !RunnerPool.hasSession(e.runner)) continue;
      const proc = e.runner.activeProcess;
      const live = RunnerPool.isLive(e.runner);
      const last = e.lastFinishedAt ?? e.startedAt;
      sessions.push({
        projectPath: e.key,
        mode: e.runner.activeSessionMode,
        state: e.launching ? 'launching' : live ? 'live' : 'exited',
        running: live,
        exitCode: proc?.exitCode ?? null,
        pid: proc?.process.pid ?? null,
        bridgePort: e.runner.activeBridgePort,
        profiling: e.runner.activeProfiler !== null,
        startedAt: iso(e.startedAt),
        lastUsedAt: iso(last),
        idleSeconds: last === null || e.inFlight > 0 ? 0 : Math.round((this.now() - last) / 1000),
        lastCommand: e.lastCommand
          ? {
              tool: e.lastCommand.tool,
              startedAt: iso(e.lastCommand.startedAt) as string,
              finishedAt: iso(e.lastCommand.finishedAt),
            }
          : null,
      });
    }
    let hostCount: number | null = null;
    let processInspectionError: string | null = null;
    try {
      hostCount = this.knownGames(this.listProcesses()).length;
    } catch (error) {
      processInspectionError = String(error);
    }
    return {
      sessions,
      recentlyEnded: [...this.recentlyEnded],
      limits: {
        ...this.serverConfig,
        gamesOnHost: hostCount,
        processInspectionError,
        launching: [...this.entries.values()].filter((e) => e.launching).length,
      },
    };
  }

  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await Promise.allSettled([
      this.defaultRunner.stopProject(),
      ...[...this.entries.values()].map((e) =>
        this.withLifecycle(e.key, async () => {
          this.markStopping(e.key, 'server_shutdown');
          await e.runner.stopProject();
          this.noteStopped(e.key);
        }),
      ),
    ]);
  }

  cleanupBridgeArtifactsSync(): void {
    const runners = [this.defaultRunner, ...[...this.entries.values()].map((e) => e.runner)];
    for (const r of runners) {
      try {
        r.cleanupBridgeArtifactsSync();
      } catch {
        // the exit path must not throw
      }
    }
  }
}
