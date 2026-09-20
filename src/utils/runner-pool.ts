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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';

import { GodotRunner, type GodotServerConfig } from './godot-runner.js';
import { findFreePort } from './bridge-protocol.js';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.js';
import { logDebug } from './logger.js';
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
  if (process.platform === 'win32') return [];
  try {
    // LC_ALL=C: `lstart` is localised. On a Spanish macOS it prints "sáb 19 sep …", which the
    // parser does not read, and an empty table silently switches the host budget off.
    const text = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,lstart=,command='], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return parsePs(text);
  } catch {
    return [];
  }
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
  const games: HostGame[] = [];
  for (const p of procs) {
    const tokens = p.command.split(/\s+/);
    const bin = tokens[0] ?? '';
    if (!/(^|\/)godot[^/]*$/i.test(bin)) continue;
    const end = tokens.indexOf('--');
    const engine = end === -1 ? tokens.slice(1) : tokens.slice(1, end);
    if (engine.includes('--headless') || engine.includes('-e') || engine.includes('--editor')) {
      continue;
    }
    const i = engine.indexOf('--path');
    if (i === -1 || i + 1 >= engine.length) continue;
    // A path with spaces is split by ps; rejoin up to the next engine flag.
    const parts: string[] = [];
    for (const token of engine.slice(i + 1)) {
      if (token.startsWith('--')) break;
      parts.push(token);
    }
    // A scene argument (res://… or *.tscn) follows the path; it is not part of it.
    while (parts.length > 1 && /(^res:\/\/|\.t?scn$)/.test(parts[parts.length - 1] ?? '')) {
      parts.pop();
    }
    games.push({ ...p, projectPath: projectKey(parts.join(' ')) });
  }
  return games;
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
const NO_PROJECT_TOOLS: ReadonlySet<string> = new Set(['list_projects', 'list_sessions']);

export type Resolution =
  | { kind: 'runner'; runner: GodotRunner; key: string | null }
  | { kind: 'refusal'; message: string };

export type EndReason = 'stopped' | 'exited' | 'idle' | 'replaced' | 'launch_failed';

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
}

interface PidFile {
  pid: number;
  startedAt: string;
  projectPath: string;
  serverPid: number;
  serverStartedAt: string;
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
    at: string;
  }[] = [];
  private idleEnded = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private fixedRunner: GodotRunner | null = null;
  private serverStartedAt: string | null = null;

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
      this.sweepTimer = setInterval(() => void this.sweepIdle(), 60_000);
      this.sweepTimer.unref();
    }
  }

  /**
   * A pool that always answers with one runner. `dispatchToolCall` wraps a bare
   * GodotRunner in it, so every existing call site and test keeps its meaning.
   */
  static single(runner: GodotRunner): RunnerPool {
    const pool = new RunnerPool({ createRunner: () => runner });
    pool.fixedRunner = runner;
    return pool;
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
        runner: this.createRunner(this.runnerConfig),
        launching: false,
        startedAt: null,
        lastFinishedAt: null,
        inFlight: 0,
        noIdleStop: false,
        lastCommand: null,
        chain: Promise.resolve(),
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
      .filter((e) => e.launching || RunnerPool.isLive(e.runner))
      .map((e) => e.key);
  }

  resolve(toolName: string, key: string | null): Resolution {
    if (this.fixedRunner) return { kind: 'runner', runner: this.fixedRunner, key };
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
      if (e && (e.launching || RunnerPool.hasSession(e.runner))) {
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
    return !this.fixedRunner && LIFECYCLE_TOOLS.has(toolName);
  }

  /**
   * Serialise launches and stops of one project. A second `run_project` for a
   * key that is launching waits for the first to settle and then replaces it; a
   * `stop_project` during a launch waits and then stops. The chain never
   * rejects, so one failed launch cannot wedge the next.
   */
  withLifecycle<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entryFor(key);
    const run = e.chain.then(fn, fn);
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
    const e = this.entryFor(key);
    const procs = this.listProcesses();
    const games = gamesOnHost(procs);
    const ownPid = e.runner.activeProcess?.process.pid ?? null;

    // Same-path strangers: the server kills only what a server of this build
    // started and whose server is gone. Anything else is a refusal.
    for (const g of games) {
      if (g.projectPath !== key || g.pid === ownPid) continue;
      const rec = this.readPidFile(key);
      const ours = rec !== null && rec.pid === g.pid && rec.startedAt === g.startedAt ? rec : null;
      const serverAlive =
        ours !== null &&
        procs.some((p) => p.pid === ours.serverPid && p.startedAt === ours.serverStartedAt);
      if (ours !== null && !serverAlive) {
        logDebug(`Reaping orphan game ${g.pid} for ${key} (its server ${ours.serverPid} is gone)`);
        this.kill(g.pid);
        this.removePidFile(key);
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
    this.idleEnded.delete(key);
    return null;
  }

  /**
   * End the `launching` state whatever happened. On success the ownership
   * record is written; on failure a surviving child is ours, so it is stopped.
   */
  async settleLaunch(key: string, succeeded: boolean): Promise<void> {
    const e = this.entries.get(key);
    if (!e) return;
    e.launching = false;
    const proc = e.runner.activeProcess;
    if (succeeded && proc && !proc.hasExited && proc.process.pid !== undefined) {
      e.startedAt = this.now();
      this.writePidFile(key, proc.process.pid);
      proc.process.once('exit', (code) => {
        this.removePidFile(key, proc.process.pid);
        this.noteEnded(key, 'exited', typeof code === 'number' ? code : null);
      });
      return;
    }
    if (!succeeded) {
      if (proc && !proc.hasExited) {
        try {
          await e.runner.stopProject();
        } catch {
          // best effort: the record below is removed either way
        }
      }
      this.removePidFile(key);
      this.noteEnded(key, 'launch_failed', null);
    }
  }

  noteStopped(key: string): void {
    this.removePidFile(key);
    this.noteEnded(key, 'stopped', null);
  }

  private noteEnded(key: string, reason: EndReason, exitCode: number | null): void {
    const last = this.recentlyEnded[this.recentlyEnded.length - 1];
    const at = new Date(this.now()).toISOString();
    if (last && last.projectPath === key && this.now() - Date.parse(last.at) < 2000) return;
    this.recentlyEnded.push({ projectPath: key, reason, exitCode, at });
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
      if (e.launching || e.inFlight > 0 || e.noIdleStop) continue;
      if (e.runner.activeSessionMode !== 'spawned' || !RunnerPool.isLive(e.runner)) continue;
      const since = e.lastFinishedAt ?? e.startedAt;
      if (since === null || this.now() - since < limitMs) continue;
      await this.withLifecycle(e.key, async () => {
        if (e.inFlight > 0) return;
        await e.runner.stopProject();
        this.removePidFile(e.key);
        this.idleEnded.set(e.key, this.now());
        this.noteEnded(e.key, 'idle', null);
      });
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

  private ownStartedAt(): string {
    if (this.serverStartedAt === null) {
      const me = this.listProcesses().find((p) => p.pid === process.pid);
      this.serverStartedAt = me?.startedAt ?? '';
    }
    return this.serverStartedAt;
  }

  private writePidFile(key: string, pid: number): void {
    const path = this.pidFilePath(key);
    if (!path) return;
    try {
      const startedAt = this.listProcesses().find((p) => p.pid === pid)?.startedAt ?? '';
      const rec: PidFile = {
        pid,
        startedAt,
        projectPath: key,
        serverPid: process.pid,
        serverStartedAt: this.ownStartedAt(),
      };
      mkdirSync(join(this.stateDir as string, 'sessions'), { recursive: true });
      writeFileSync(path, JSON.stringify(rec));
    } catch (error) {
      logDebug(`Could not write ownership record for ${key}: ${String(error)}`);
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

  private removePidFile(key: string, onlyIfPid?: number): void {
    const path = this.pidFilePath(key);
    if (!path) return;
    if (onlyIfPid !== undefined) {
      const rec = this.readPidFile(key);
      if (rec && rec.pid !== onlyIfPid) return;
    }
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
    limits: ServerConfig & { gamesOnHost: number; launching: number };
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
    return {
      sessions,
      recentlyEnded: [...this.recentlyEnded],
      limits: {
        ...this.serverConfig,
        gamesOnHost: gamesOnHost(this.listProcesses()).length,
        launching: [...this.entries.values()].filter((e) => e.launching).length,
      },
    };
  }

  async stopAll(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const runners = this.fixedRunner
      ? [this.fixedRunner]
      : [this.defaultRunner, ...[...this.entries.values()].map((e) => e.runner)];
    await Promise.allSettled(runners.map((r) => r.stopProject()));
    for (const key of this.entries.keys()) this.removePidFile(key);
  }

  cleanupBridgeArtifactsSync(): void {
    const runners = this.fixedRunner
      ? [this.fixedRunner]
      : [this.defaultRunner, ...[...this.entries.values()].map((e) => e.runner)];
    for (const r of runners) {
      try {
        r.cleanupBridgeArtifactsSync();
      } catch {
        // the exit path must not throw
      }
    }
  }
}
