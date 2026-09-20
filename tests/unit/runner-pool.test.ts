import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import {
  RunnerPool,
  canonicalizeProjectArgs,
  gamesOnHost,
  parsePs,
  projectKey,
  type HostProcess,
} from '../../src/utils/runner-pool.js';
import type { GodotRunner } from '../../src/utils/godot-runner.js';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from '../../src/utils/server-config.js';
import { dispatchToolCall } from '../../src/dispatch.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRunner {
  id: number;
  activeSessionMode: 'spawned' | 'attached' | null;
  activeProcess: { process: { pid: number; once: () => void }; hasExited: boolean; exitCode: number | null } | null;
  activeProfiler: unknown;
  activeBridgePort: number | null;
  stops: number;
  stopProject: () => Promise<null>;
  cleanupBridgeArtifactsSync: () => void;
  detectGodotPath: () => Promise<void>;
  getGodotPath: () => string | null;
}

let nextId = 0;
function fakeRunner(): FakeRunner {
  const r: FakeRunner = {
    id: nextId++,
    activeSessionMode: null,
    activeProcess: null,
    activeProfiler: null,
    activeBridgePort: null,
    stops: 0,
    stopProject: async () => {
      r.stops += 1;
      r.activeSessionMode = null;
      r.activeProcess = null;
      return null;
    },
    cleanupBridgeArtifactsSync: () => undefined,
    detectGodotPath: async () => undefined,
    getGodotPath: () => '/fake/godot',
  };
  return r;
}

function goLive(r: FakeRunner, pid: number): void {
  r.activeSessionMode = 'spawned';
  r.activeProcess = { process: { pid, once: () => undefined }, hasExited: false, exitCode: null };
}

const START = 'Sat Sep 19 22:00:00 2026';
function proc(pid: number, command: string, ppid = 100, startedAt = START): HostProcess {
  return { pid, ppid, rssKb: 1000, startedAt, command };
}
const GODOT = '/Applications/Godot.app/Contents/MacOS/Godot';

function makePool(opts: {
  config?: Partial<ServerConfig>;
  procs?: () => HostProcess[];
  stateDir?: string | null;
  now?: () => number;
}) {
  const made: FakeRunner[] = [];
  const killed: number[] = [];
  const pool = new RunnerPool({
    serverConfig: { ...DEFAULT_SERVER_CONFIG, ...opts.config },
    listProcesses: opts.procs ?? (() => []),
    stateDir: opts.stateDir ?? null,
    ...(opts.now ? { now: opts.now } : {}),
    kill: (pid) => killed.push(pid),
    createRunner: () => {
      const r = fakeRunner();
      made.push(r);
      return r as unknown as GodotRunner;
    },
  });
  const runnerOf = (key: string) => {
    const res = pool.resolve('run_project', key);
    if (res.kind !== 'runner') throw new Error('expected a runner');
    return res.runner as unknown as FakeRunner;
  };
  return { pool, made, killed, runnerOf };
}

let scratch: string;
beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'pool-')));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Identity (amendment A1)
// ---------------------------------------------------------------------------

describe('projectKey: one identity for every spelling', () => {
  it('a symlink alias, a relative path and a trailing slash meet in one key', () => {
    const real = join(scratch, 'Proj');
    mkdirSync(real);
    writeFileSync(join(real, 'project.godot'), '');
    const alias = join(scratch, 'alias');
    symlinkSync(real, alias);
    const key = projectKey(real);
    expect(projectKey(alias)).toBe(key);
    expect(projectKey(real + '/')).toBe(key);
    expect(projectKey(relative(scratch, real), scratch)).toBe(key);
  });

  it('a prefix sibling is a different project', () => {
    mkdirSync(join(scratch, 'A1'));
    mkdirSync(join(scratch, 'A10'));
    expect(projectKey(join(scratch, 'A1'))).not.toBe(projectKey(join(scratch, 'A10')));
  });

  it('a path that does not exist yet still gets a stable key', () => {
    expect(projectKey(join(scratch, 'nope/'))).toBe(join(scratch, 'nope'));
  });
});

describe('canonicalizeProjectArgs: the name first, then the path', () => {
  it('maps project_path onto projectPath and removes the alias spelling', () => {
    const real = join(scratch, 'P');
    mkdirSync(real);
    const alias = join(scratch, 'link');
    symlinkSync(real, alias);
    const out = canonicalizeProjectArgs({ project_path: alias, limit: 5 });
    expect(out).toEqual({ ok: true, key: real, args: { projectPath: real, limit: 5 } });
  });

  it('refuses both spellings with different values', () => {
    const out = canonicalizeProjectArgs({ projectPath: '/a', project_path: '/b' });
    expect(out.ok).toBe(false);
  });

  it('accepts both spellings when they agree, and leaves no alias behind', () => {
    const out = canonicalizeProjectArgs({ projectPath: scratch, project_path: scratch });
    expect(out).toEqual({ ok: true, key: scratch, args: { projectPath: scratch } });
  });

  it('leaves a call with no project alone', () => {
    expect(canonicalizeProjectArgs({ limit: 1 })).toEqual({ ok: true, key: null, args: { limit: 1 } });
  });
});

// ---------------------------------------------------------------------------
// The process table (amendment A3's matching rules)
// ---------------------------------------------------------------------------

describe('gamesOnHost', () => {
  it('counts games and nothing else', () => {
    const games = gamesOnHost([
      proc(1, `${GODOT}`), // project manager: no --path
      proc(2, `${GODOT} -e --path /w/A1`), // editor
      proc(3, `${GODOT} --headless --path /w/A1 --import`),
      proc(4, `${GODOT} --path /w/A1 --max-fps 60 -- --save-root=/x`),
      proc(5, `${GODOT} --path /w/A10 res://main.tscn`),
      proc(6, `node /x/dist/index.js --path /w/A1`), // not godot
    ]);
    expect(games.map((g) => [g.pid, g.projectPath])).toEqual([
      [4, '/w/A1'],
      [5, '/w/A10'],
    ]);
  });

  it('reads engine arguments only before the standalone --', () => {
    const games = gamesOnHost([
      proc(7, `${GODOT} --path /w/B -- --headless --path /w/ELSEWHERE -e`),
    ]);
    expect(games.map((g) => g.projectPath)).toEqual(['/w/B']);
  });

  it('parses ps lines with lstart', () => {
    const [p] = parsePs(`  412   1  20480 Sat Sep 19 22:00:00 2026 ${GODOT} --path /w/A1\n`);
    expect(p).toEqual({ pid: 412, ppid: 1, rssKb: 20480, startedAt: START, command: `${GODOT} --path /w/A1` });
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe('resolve: a session tool reaches its own session or is refused', () => {
  it('never falls back to another project`s live session (R1)', () => {
    const { pool, runnerOf } = makePool({});
    goLive(runnerOf('/w/A'), 11);
    const res = pool.resolve('take_screenshot', '/w/B');
    expect(res.kind).toBe('refusal');
    expect(res.kind === 'refusal' && res.message).toMatch(/^No runtime session for \/w\/B\./);
    expect(res.kind === 'refusal' && res.message).toContain('Live sessions: /w/A');
  });

  it('refuses an omitted projectPath when the server requires it, even with one session (R2)', () => {
    const { pool, runnerOf } = makePool({ config: { requireProjectPath: true } });
    goLive(runnerOf('/w/A'), 11);
    const res = pool.resolve('simulate_input', null);
    expect(res.kind === 'refusal' && res.message).toMatch(/^projectPath is required on this server/);
  });

  it('default mode: none → idle runner, one → it, two → R3', () => {
    const { pool, runnerOf } = makePool({});
    expect(pool.resolve('stop_project', null)).toMatchObject({ kind: 'runner', key: null });
    const a = runnerOf('/w/A');
    goLive(a, 11);
    expect(pool.resolve('stop_project', null)).toMatchObject({ kind: 'runner', key: '/w/A' });
    goLive(runnerOf('/w/B'), 12);
    const res = pool.resolve('stop_project', null);
    expect(res.kind === 'refusal' && res.message).toMatch(/^2 runtime sessions are live; say which/);
  });

  it('a retained exited process is a record, not a live session', () => {
    const { pool, runnerOf } = makePool({});
    goLive(runnerOf('/w/A'), 11);
    const b = runnerOf('/w/B');
    goLive(b, 12);
    (b.activeProcess as NonNullable<FakeRunner['activeProcess']>).hasExited = true;
    // one live + one exited: the omitted path means the live one, not a refusal
    expect(pool.resolve('take_screenshot', null)).toMatchObject({ kind: 'runner', key: '/w/A' });
    // and the exited one is still reachable by name, for its logs
    expect(pool.resolve('get_debug_output', '/w/B')).toMatchObject({ kind: 'runner', key: '/w/B' });
  });

  it('dispatch hands the handler the runner of the named project, through an alias', async () => {
    const real = join(scratch, 'G');
    mkdirSync(real);
    const alias = join(scratch, 'g-link');
    symlinkSync(real, alias);
    const { pool, runnerOf } = makePool({});
    const a = runnerOf(real);
    goLive(a, 11);
    const other = runnerOf(join(scratch, 'other'));
    goLive(other, 12);
    const res = await dispatchToolCall(pool, 'stop_project', { project_path: alias });
    expect(a.stops).toBe(1);
    expect(other.stops).toBe(0);
    expect(res.isError).toBe(true); // the fake returns null: "No active Godot process to stop."
  });

  it('dispatch refuses conflicting spellings before any handler runs', async () => {
    const { pool, made } = makePool({});
    const res = await dispatchToolCall(pool, 'stop_project', { projectPath: '/a', project_path: '/b' });
    expect(res.isError).toBe(true);
    expect(made.every((r) => r.stops === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and admission (amendment A2)
// ---------------------------------------------------------------------------

describe('withLifecycle: launches of one project are serialised', () => {
  it('runs the second only after the first settles, and a failure does not wedge the chain', async () => {
    const { pool } = makePool({});
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = pool.withLifecycle('/w/A', async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
      throw new Error('spawn failed');
    });
    const second = pool.withLifecycle('/w/A', async () => {
      order.push('second');
      return 2;
    });
    const otherKey = pool.withLifecycle('/w/B', async () => {
      order.push('other');
    });
    await otherKey; // another project is not held up
    expect(order).toEqual(['first:start', 'other']);
    release();
    await expect(first).rejects.toThrow('spawn failed');
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'other', 'first:end', 'second']);
  });
});

describe('admit: the host budget', () => {
  it('three simultaneous admissions at N − 1 admit one, because a launch in progress counts', () => {
    const running = [proc(1, `${GODOT} --path /w/x1`), proc(2, `${GODOT} --path /w/x2`)];
    const { pool } = makePool({ config: { maxGames: 3 }, procs: () => running });
    expect(pool.admit('/w/A')).toBeNull();
    expect(pool.admit('/w/B')).toMatch(/^Host budget reached: 3 of 3/);
    expect(pool.admit('/w/C')).toMatch(/^Host budget reached/);
  });

  it('a failed launch settles: its reservation is released and the slot is reusable', async () => {
    const running = [proc(1, `${GODOT} --path /w/x1`), proc(2, `${GODOT} --path /w/x2`)];
    const { pool } = makePool({ config: { maxGames: 3 }, procs: () => running });
    expect(pool.admit('/w/A')).toBeNull();
    await pool.settleLaunch('/w/A', false);
    expect(pool.list().limits.launching).toBe(0);
    expect(pool.admit('/w/B')).toBeNull();
    expect(pool.list().recentlyEnded.at(-1)).toMatchObject({ projectPath: '/w/A', reason: 'launch_failed' });
  });

  it('a failed launch stops a child that survived it', async () => {
    const { pool, runnerOf } = makePool({});
    expect(pool.admit('/w/A')).toBeNull();
    const a = runnerOf('/w/A');
    goLive(a, 50);
    await pool.settleLaunch('/w/A', false);
    expect(a.stops).toBe(1);
  });

  it('replacing your own game does not count as adding one', () => {
    const procs = [proc(1, `${GODOT} --path /w/x1`), proc(9, `${GODOT} --path /w/A`)];
    const { pool, runnerOf } = makePool({ config: { maxGames: 2 }, procs: () => procs });
    goLive(runnerOf('/w/A'), 9);
    expect(pool.admit('/w/A')).toBeNull();
  });

  it('budget off (0) admits anything', () => {
    const procs = Array.from({ length: 30 }, (_, i) => proc(i + 1, `${GODOT} --path /w/g${i}`));
    const { pool } = makePool({ procs: () => procs });
    expect(pool.admit('/w/A')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ownership (amendment A3): the server kills only what it started
// ---------------------------------------------------------------------------

describe('admit: a Godot game already running this project', () => {
  function writeRecord(stateDir: string, key: string, rec: Record<string, unknown>) {
    // Let the pool write one for us, then overwrite its contents.
    const dir = join(stateDir, 'sessions');
    mkdirSync(dir, { recursive: true });
    const name = readdirSync(dir)[0];
    writeFileSync(join(dir, name as string), JSON.stringify({ projectPath: key, ...rec }));
  }

  async function poolWithRecord(procs: () => HostProcess[]) {
    const stateDir = join(scratch, 'state');
    const ctx = makePool({ procs, stateDir });
    // produce a record file for /w/A through the public path
    expect(ctx.pool.admit('/w/A')).toBeNull();
    goLive(ctx.runnerOf('/w/A'), 70);
    await ctx.pool.settleLaunch('/w/A', true);
    // forget the live child: simulate a new server that finds the old server's record
    const a = ctx.runnerOf('/w/A');
    a.activeProcess = null;
    a.activeSessionMode = null;
    return { ...ctx, stateDir };
  }

  it('a stranger (no record) is refused with a diagnostic and never killed', () => {
    const procs = [proc(70, `${GODOT} --path /w/A`, 1)]; // ppid 1 proves nothing
    const { pool, killed } = makePool({ procs: () => procs, stateDir: join(scratch, 's') });
    const msg = pool.admit('/w/A');
    expect(msg).toMatch(/^Another Godot game is already running this project: pid 70, parent 1/);
    expect(msg).toContain('This server did not start it');
    expect(killed).toEqual([]);
  });

  it('our own orphan, whose server is gone, is reaped', async () => {
    let table: HostProcess[] = [];
    const { pool, killed, stateDir } = await poolWithRecord(() => table);
    writeRecord(stateDir, '/w/A', { pid: 70, startedAt: START, serverPid: 4242, serverStartedAt: START });
    table = [proc(70, `${GODOT} --path /w/A`, 1)]; // server 4242 is not in the table
    expect(pool.admit('/w/A')).toBeNull();
    expect(killed).toEqual([70]);
  });

  it('a game whose server is alive is refused, not killed', async () => {
    let table: HostProcess[] = [];
    const { pool, killed, stateDir } = await poolWithRecord(() => table);
    writeRecord(stateDir, '/w/A', { pid: 70, startedAt: START, serverPid: 4242, serverStartedAt: START });
    table = [proc(70, `${GODOT} --path /w/A`, 4242), proc(4242, 'node /x/dist/index.js', 1)];
    expect(pool.admit('/w/A')).toMatch(/belongs to a live MCP server \(pid 4242\)/);
    expect(killed).toEqual([]);
  });

  it('a reused server pid with another start time does not make a dead server look alive', async () => {
    let table: HostProcess[] = [];
    const { pool, killed, stateDir } = await poolWithRecord(() => table);
    writeRecord(stateDir, '/w/A', { pid: 70, startedAt: START, serverPid: 4242, serverStartedAt: START });
    table = [
      proc(70, `${GODOT} --path /w/A`, 1),
      proc(4242, 'vim notes.txt', 1, 'Sun Sep 20 09:00:00 2026'),
    ];
    expect(pool.admit('/w/A')).toBeNull();
    expect(killed).toEqual([70]);
  });

  it('a reused game pid with another start time is a stranger', async () => {
    let table: HostProcess[] = [];
    const { pool, killed, stateDir } = await poolWithRecord(() => table);
    writeRecord(stateDir, '/w/A', { pid: 70, startedAt: START, serverPid: 4242, serverStartedAt: START });
    table = [proc(70, `${GODOT} --path /w/A`, 1, 'Sun Sep 20 09:00:00 2026')];
    expect(pool.admit('/w/A')).toMatch(/This server did not start it/);
    expect(killed).toEqual([]);
  });

  it('a prefix sibling`s game is not this project`s game', () => {
    const procs = [proc(70, `${GODOT} --path /w/A10`, 1)];
    const { pool } = makePool({ procs: () => procs });
    expect(pool.admit('/w/A1')).toBeNull();
  });

  it('stop removes the ownership record', async () => {
    const { pool, stateDir } = await poolWithRecord(() => []);
    expect(readdirSync(join(stateDir, 'sessions')).length).toBe(1);
    pool.noteStopped('/w/A');
    expect(existsSync(join(stateDir, 'sessions')) ? readdirSync(join(stateDir, 'sessions')).length : 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idle stop (amendment A10 b)
// ---------------------------------------------------------------------------

describe('sweepIdle', () => {
  it('measures from the completion of the last command and never while one is in flight', async () => {
    let t = 0;
    const { pool, runnerOf } = makePool({ config: { idleStopMinutes: 60 }, now: () => t });
    expect(pool.admit('/w/A')).toBeNull();
    const a = runnerOf('/w/A');
    goLive(a, 5);
    await pool.settleLaunch('/w/A', true);

    pool.begin('/w/A', 'run_script');
    t = 3 * 3600_000; // three hours inside one long command
    await pool.sweepIdle();
    expect(a.stops).toBe(0);

    pool.end('/w/A');
    t += 59 * 60_000;
    await pool.sweepIdle();
    expect(a.stops).toBe(0);

    t += 2 * 60_000;
    await pool.sweepIdle();
    expect(a.stops).toBe(1);
    const res = pool.resolve('take_screenshot', '/w/A');
    expect(res.kind === 'refusal' && res.message).toContain('stopped after 60 minutes idle');
    await pool.stopAll();
  });

  it('a session that opted out is left alone', async () => {
    let t = 0;
    const { pool, runnerOf } = makePool({ config: { idleStopMinutes: 60 }, now: () => t });
    pool.admit('/w/A');
    const a = runnerOf('/w/A');
    goLive(a, 5);
    await pool.settleLaunch('/w/A', true);
    pool.setNoIdleStop('/w/A', true);
    t = 10 * 3600_000;
    await pool.sweepIdle();
    expect(a.stops).toBe(0);
    await pool.stopAll();
  });
});

describe('list and stopAll', () => {
  it('reports launching and live sessions with the limits, and stops every runner', async () => {
    const procs = [proc(5, `${GODOT} --path /w/A`)];
    const { pool, runnerOf, made } = makePool({ config: { maxGames: 8 }, procs: () => procs });
    pool.admit('/w/A');
    goLive(runnerOf('/w/A'), 5);
    await pool.settleLaunch('/w/A', true);
    pool.admit('/w/B');
    const out = pool.list();
    expect(out.sessions.map((s) => [s.projectPath, s.state])).toEqual([
      ['/w/A', 'live'],
      ['/w/B', 'launching'],
    ]);
    expect(out.limits).toMatchObject({ maxGames: 8, gamesOnHost: 1, launching: 1 });
    await pool.stopAll();
    expect(made.filter((r) => r.stops > 0).length).toBe(made.length);
  });
});
