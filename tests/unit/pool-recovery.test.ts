/** Production dispatch, handler and runner; only OS spawn and bridge I/O are doubled. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ChildProcess } from 'child_process';

const { spawnMock, injectMock, psMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  injectMock: vi.fn(),
  psMock: vi.fn(),
}));
vi.mock('child_process', async () => ({
  ...(await vi.importActual('child_process')),
  spawn: spawnMock,
  execFileSync: psMock,
}));
vi.mock('../../src/utils/bridge-protocol.js', async () => ({
  ...(await vi.importActual('../../src/utils/bridge-protocol.js')),
  findFreePort: async () => 12346,
}));
vi.mock('../../src/utils/path-validation.js', async () => ({
  ...(await vi.importActual('../../src/utils/path-validation.js')),
  checkDisplayAvailable: () => true,
}));
vi.mock('../../src/utils/bridge-manager.js', async () => ({
  ...(await vi.importActual('../../src/utils/bridge-manager.js')),
  BridgeManager: class {
    inject = injectMock;
    cleanup = vi.fn();
    getLastInjectedPort = () => 12346;
    readBakedPort = () => 12346;
  },
}));

import { GodotRunner } from '../../src/utils/godot-runner.js';
import {
  RunnerPool,
  defaultProcessLister,
  gamesOnHost,
  type HostProcess,
} from '../../src/utils/runner-pool.js';
import { DEFAULT_SERVER_CONFIG } from '../../src/utils/server-config.js';
import { dispatchToolCall, toolDispatch } from '../../src/dispatch.js';
import { createNullContext } from '../../src/utils/mcp-context.js';
import { BridgeAutoloadCollisionError } from '../../src/utils/bridge-manager.js';
import { DebuggerProfiler } from '../../src/utils/profiler.js';

const stamp = 'Sun Sep 20 09:00:00 2026';
const row = (pid: number, command: string, ppid = process.pid): HostProcess => ({
  pid,
  command,
  ppid,
  startedAt: stamp,
  rssKb: 1000,
});
let scratch: string, project: string, state: string, pool: RunnerPool, clock: number, pid: number;
let rows: HostProcess[],
  runners: GodotRunner[],
  children: Array<ChildProcess & { kill: ReturnType<typeof vi.fn> }>;
const context = () => createNullContext({ disableElicitation: true });
const run = (args = {}) =>
  dispatchToolCall(pool, 'run_project', { projectPath: project, ...args }, context());
const stop = () => dispatchToolCall(pool, 'stop_project', { projectPath: project }, context());
const records = () => {
  try {
    return readdirSync(join(state, 'sessions')).map((f) =>
      JSON.parse(readFileSync(join(state, 'sessions', f), 'utf8')),
    );
  } catch {
    return [];
  }
};
const makePool = (inspect = () => rows) =>
  new RunnerPool({
    stateDir: state,
    listProcesses: inspect,
    now: () => clock,
    serverConfig: { ...DEFAULT_SERVER_CONFIG, maxGames: 3, idleStopMinutes: 1 },
    runnerConfig: { godotPath: process.execPath },
    createRunner: (cfg) => {
      const r = new GodotRunner(cfg);
      runners.push(r);
      return r;
    },
  });

beforeEach(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'pool-recovery-')));
  project = join(scratch, 'game');
  state = join(scratch, 'state');
  mkdirSync(project);
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
  clock = 1000;
  pid = 70000;
  runners = [];
  children = [];
  rows = [row(process.pid, 'node /fixture/dist/index.js', 1)];
  injectMock.mockReset();
  spawnMock.mockReset();
  psMock.mockReset();
  vi.spyOn(GodotRunner.prototype, 'waitForBridge').mockResolvedValue({ ready: true });
  vi.spyOn(GodotRunner.prototype, 'sendCommand').mockResolvedValue('{}');
  spawnMock.mockImplementation((_bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: ++pid,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
    child.kill.mockImplementation(() => {
      rows = rows.filter((r) => r.pid !== child.pid);
      child.emit('exit', null);
      return true;
    });
    rows.push(row(pid, `/Applications/Godot.app/Contents/MacOS/Godot ${args.join(' ')}`));
    children.push(child);
    return child;
  });
  pool = makePool();
});
afterEach(async () => {
  await pool.stopAll();
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

describe('P1 production lifecycle recovery', () => {
  it('F2 observer shutdown preserves another pool ownership record', async () => {
    expect((await run()).isError).toBeFalsy();
    const before = records();
    expect(before).toHaveLength(1);
    const observer = makePool();
    observer.resolve('get_project_info', project);
    await observer.stopAll();
    expect(records()).toEqual(before);
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });
  it.each([
    { maxFps: -1 },
    { bridgePort: 0 },
    { audio: 'yes' },
    { background: 1 },
    { profiling: 1 },
    { userArgs: ['bad\0arg'] },
    { idleStopMinutes: -1 },
    { scene: '../elsewhere.tscn' },
    { scene: 'bad\0scene.tscn' },
  ])('F4 invalid replacement preserves old child and record: %j', async (invalid) => {
    await run({ idleStopMinutes: 0 });
    const before = records();
    expect((await run(invalid)).isError).toBe(true);
    expect(children).toHaveLength(1);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    expect(records()).toEqual(before);
    clock += 120000;
    await pool.sweepIdle();
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });
  it('F5 stop submitted in the same turn queues after the launch', async () => {
    const [started, stopped] = await Promise.all([run(), stop()]);
    expect(started.isError).toBeFalsy();
    expect(stopped.isError).toBeFalsy();
    expect(children[0]!.kill).toHaveBeenCalled();
    expect(pool.list().limits.launching).toBe(0);
    expect(records()).toEqual([]);
  });
  it('F5 implicit single-session stop also queues after the launch', async () => {
    const [started, stopped] = await Promise.all([
      run(),
      dispatchToolCall(pool, 'stop_project', {}, context()),
    ]);
    expect(started.isError).toBeFalsy();
    expect(stopped.isError).toBeFalsy();
    expect(children[0]!.kill).toHaveBeenCalled();
  });
  it('F2 shutdown does not remove a record replaced by another server identity', async () => {
    await run();
    const file = join(state, 'sessions', readdirSync(join(state, 'sessions'))[0]!);
    const foreign = {
      ...records()[0],
      serverPid: process.pid + 1,
      serverStartedAt: 'different start',
    };
    writeFileSync(file, JSON.stringify(foreign));
    await pool.stopAll();
    expect(records()).toEqual([foreign]);
  });
  it('F6 spawn ownership exists while bridge readiness is pending', async () => {
    let release!: (v: { ready: boolean }) => void;
    vi.mocked(GodotRunner.prototype.waitForBridge).mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = run();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const during = records();
    release({ ready: true });
    await pending;
    expect(during).toEqual([
      expect.objectContaining({
        pid: children[0]!.pid,
        serverPid: process.pid,
        startedAt: stamp,
        serverStartedAt: stamp,
      }),
    ]);
  });
  it('F7 ps failure refuses admission with a diagnostic instead of an empty host', async () => {
    await pool.stopAll();
    pool = makePool(() => {
      throw new Error('ps denied');
    });
    expect((await run()).content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/inspection failed.*ps denied/is) }),
      ]),
    );
    expect(children).toEqual([]);
    expect(pool.list().limits).toMatchObject({
      gamesOnHost: null,
      processInspectionError: expect.stringContaining('ps denied'),
    });
  });
  it('F7 default lister propagates OS inspection failure', () => {
    psMock.mockImplementation(() => {
      throw new Error('ps denied');
    });
    expect(() => defaultProcessLister()).toThrow(/ps denied/);
  });
  it('F7 an empty or unreadable ps table is an inspection failure', () => {
    psMock.mockReturnValue('unreadable output');
    expect(() => defaultProcessLister()).toThrow(/no readable process rows/);
  });
  it.each(['returned error', 'thrown exception', 'spawn error', 'readiness failure'] as const)(
    'F8 production dispatch releases failure reservation and permits retry: %s',
    async (shape) => {
      if (shape === 'returned error')
        injectMock.mockImplementationOnce(() => {
          throw new BridgeAutoloadCollisionError('injected collision');
        });
      if (shape === 'thrown exception') {
        const handler = toolDispatch.run_project;
        vi.spyOn(toolDispatch, 'run_project').mockImplementationOnce(async (...args) => {
          await handler(...args);
          throw new Error('injected exception');
        });
      }
      if (shape === 'spawn error') {
        spawnMock.mockImplementationOnce(() => {
          const p = Object.assign(new EventEmitter(), { kill: vi.fn() });
          queueMicrotask(() => p.emit('error', new Error('ENOENT')));
          return p;
        });
        vi.mocked(GodotRunner.prototype.waitForBridge).mockResolvedValueOnce({
          ready: false,
          error: 'ENOENT',
        });
      }
      if (shape === 'readiness failure')
        vi.mocked(GodotRunner.prototype.waitForBridge).mockResolvedValueOnce({
          ready: false,
          error: 'injected timeout',
        });
      if (shape === 'thrown exception') await expect(run()).rejects.toThrow('injected exception');
      else {
        const response = await run();
        expect(response.isError).toBe(true);
        if (shape === 'readiness failure')
          expect(response.content[0]?.text).toContain('Actual reason: injected timeout');
      }
      expect(pool.list().limits.launching).toBe(0);
      expect(records()).toEqual([]);
      expect((await run()).isError).toBeFalsy();
      expect(records()).toHaveLength(1);
      expect(pool.list().limits.launching).toBe(0);
    },
  );
  it.each([false, true])(
    'F9 omitted idle exemption restores default after stop=%s',
    async (stopped) => {
      await run({ idleStopMinutes: 0 });
      clock += 120000;
      await pool.sweepIdle();
      expect(children[0]!.kill).not.toHaveBeenCalled();
      if (stopped) await stop();
      await run();
      clock += 120000;
      await pool.sweepIdle();
      expect(children[1]!.kill).toHaveBeenCalled();
      expect(pool.list().recentlyEnded.at(-1)).toMatchObject({ reason: 'idle_stop' });
    },
  );
  it('F10 records each process termination once with its actual reason and crash code', async () => {
    await run();
    await stop();
    await run();
    clock += 120000;
    await pool.sweepIdle();
    await run();
    await run();
    const crashed = children.at(-1)!;
    crashed.emit('exit', 7);
    rows = rows.filter((r) => r.pid !== crashed.pid);
    await run();
    await pool.stopAll();
    expect(pool.list().recentlyEnded.map((r) => [r.reason, r.exitCode])).toEqual([
      ['stopped', null],
      ['idle_stop', null],
      ['replaced', null],
      ['exited', 7],
      ['server_shutdown', null],
    ]);
    expect(records()).toEqual([]);
  });
  it('F10 a late replaced-process exit cannot erase its replacement record', async () => {
    await run();
    const previous = children[0]!;
    // Confirm the real exit, then deliver a duplicate old notification after
    // replacement to retain the epoch/record guard assertion.
    previous.kill.mockImplementation(() => {
      previous.emit('exit', null);
      rows = rows.filter((r) => r.pid !== previous.pid);
      return true;
    });
    await run();
    const replacement = records();
    previous.emit('exit', null);
    rows = rows.filter((r) => r.pid !== previous.pid);
    expect(records()).toEqual(replacement);
    children[1]!.emit('exit', 7);
    rows = rows.filter((r) => r.pid !== children[1]!.pid);
    expect(pool.list().recentlyEnded.map((r) => [r.reason, r.exitCode])).toEqual([
      ['replaced', null],
      ['exited', 7],
    ]);
  });
  it('F10 history retains twenty independent pre-spawn failure attempts', async () => {
    injectMock.mockImplementation(() => {
      throw new BridgeAutoloadCollisionError('fixture collision');
    });
    for (let i = 0; i < 25; i++) expect((await run()).isError).toBe(true);
    expect(pool.list().recentlyEnded).toHaveLength(20);
  });
  it('F3 short flags and ambiguous path prefixes refuse a second game', () => {
    rows.push(row(60000, `/Applications/Godot.app/Contents/MacOS/Godot --path ${project} -d`));
    expect(pool.admit(project)).toMatch(/Another Godot game/);
    expect(pool.admit(project + ' -draft')).toMatch(/Another Godot game/);
  });
});

describe('shared process parser examples', () => {
  const cases = JSON.parse(
    readFileSync(new URL('./process-parser-cases.json', import.meta.url), 'utf8'),
  ) as Array<{ name: string; args: string; path: string | null }>;
  it.each(cases)('$name', (c) => {
    expect(
      gamesOnHost([row(50000, `/Applications/Godot.app/Contents/MacOS/Godot ${c.args}`)]).map(
        (g) => g.projectPath,
      ),
    ).toEqual(c.path === null ? [] : [c.path]);
  });
});

describe('round 2 production boundaries', () => {
  it('R2 ignored graceful termination escalates and confirms exit before replacement', async () => {
    await run();
    const old = children[0]!;
    old.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        old.emit('exit', null);
        rows = rows.filter((r) => r.pid !== old.pid);
      }
      return true;
    });
    vi.useFakeTimers();
    try {
      const replacing = run();
      await vi.advanceTimersByTimeAsync(100);
      expect(children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await replacing).isError).toBeFalsy();
      expect(old.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGKILL']);
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R2 unconfirmed forced termination refuses and later exit still clears the old session', async () => {
    await run();
    const old = children[0]!;
    old.kill.mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const replacing = run();
      await vi.advanceTimersByTimeAsync(4100);
      const response = await replacing;
      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain('Could not confirm exit');
      expect(children).toHaveLength(1);
      expect(records()).toHaveLength(1);
      expect(pool.list().limits.launching).toBe(0);
      old.emit('exit', 7);
      rows = rows.filter((r) => r.pid !== old.pid);
      expect(runners[1]!.activeSessionMode).toBeNull();
      expect(records()).toEqual([]);
      expect((await run()).isError).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('R2 replacement readiness failure tears down the new child and permits retry', async () => {
    await run();
    vi.mocked(GodotRunner.prototype.waitForBridge).mockResolvedValueOnce({
      ready: false,
      error: 'replacement readiness timeout',
    });
    const response = await run();
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain('Actual reason: replacement readiness timeout');
    expect(records()).toEqual([]);
    expect(runners[1]!.activeSessionMode).toBeNull();
    expect(pool.list().limits.launching).toBe(0);
    expect(pool.list().recentlyEnded.map((r) => r.reason)).toEqual(['replaced', 'launch_failed']);
    expect((await run()).isError).toBeFalsy();
  });
  it('R2 replacement waits for the old child before spawning its successor', async () => {
    await run();
    const old = children[0]!;
    old.kill.mockImplementation(() => true);
    const replacing = run();
    await vi.waitFor(() => expect(old.kill).toHaveBeenCalled());
    const childrenBeforeExit = children.length;
    old.emit('exit', null);
    rows = rows.filter((r) => r.pid !== old.pid);
    expect((await replacing).isError).toBeFalsy();
    expect(childrenBeforeExit).toBe(1);
    expect(rows.filter((r) => r.command.includes(`--path ${project}`))).toHaveLength(1);
  });

  it('R2 injection failure after replacement stop leaves no stranded spawned mode', async () => {
    await run();
    const old = children[0]!;
    old.kill.mockImplementation(() => true);
    injectMock.mockImplementationOnce(() => {
      throw new BridgeAutoloadCollisionError('replacement collision');
    });
    const replacing = run();
    await vi.waitFor(() => expect(old.kill).toHaveBeenCalled());
    old.emit('exit', 7);
    rows = rows.filter((r) => r.pid !== old.pid);
    expect((await replacing).isError).toBe(true);
    expect(runners[1]!.activeSessionMode).toBeNull();
    expect(runners[1]!.activeBridgePort).toBeNull();
    expect(runners[1]!.hasActiveRuntimeSession()).toBe(false);
    expect(records()).toEqual([]);
    expect(pool.list().limits.launching).toBe(0);
    expect((await run()).isError).toBeFalsy();
  });

  it.each(['spawn', 'profiler'])(
    'R2 pre-child %s failure after replacement clears all launch state',
    async (failure) => {
      await run();
      if (failure === 'spawn')
        spawnMock.mockImplementationOnce(() => {
          throw new Error('injected spawn failure');
        });
      else
        vi.spyOn(DebuggerProfiler, 'create').mockRejectedValueOnce(
          new Error('injected profiler failure'),
        );
      const response = await run({ profiling: failure === 'profiler' });
      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain(`injected ${failure} failure`);
      expect(runners[1]!.activeSessionMode).toBeNull();
      expect(runners[1]!.activeBridgePort).toBeNull();
      expect(runners[1]!.activeProjectPath).toBeNull();
      expect(runners[1]!.activeProcess).toBeNull();
      expect(runners[1]!.activeProfiler).toBeNull();
      expect(records()).toEqual([]);
      expect(pool.list().limits.launching).toBe(0);
      expect(pool.list().recentlyEnded.map((r) => r.reason)).toEqual(['replaced', 'launch_failed']);
      expect((await run()).isError).toBeFalsy();
    },
  );

  it('R2 orphan admission refuses until termination is confirmed and retains the record', async () => {
    await run();
    const old = children[0]!;
    const file = join(state, 'sessions', readdirSync(join(state, 'sessions'))[0]!);
    writeFileSync(file, JSON.stringify({ ...records()[0], serverPid: 99999 }));
    rows = rows.map((r) => (r.pid === old.pid ? { ...r, ppid: 1 } : r));
    const kills: number[] = [];
    const observer = new RunnerPool({
      stateDir: state,
      listProcesses: () => rows,
      runnerConfig: { godotPath: process.execPath },
      kill: (pid) => {
        kills.push(pid);
      },
      serverConfig: { ...DEFAULT_SERVER_CONFIG, maxGames: 3 },
    });
    try {
      expect(
        (await dispatchToolCall(observer, 'run_project', { projectPath: project }, context()))
          .isError,
      ).toBe(true);
      expect(kills).toEqual([old.pid]);
      expect(records()).toHaveLength(1);
      expect(children).toHaveLength(1);
    } finally {
      await observer.stopAll();
    }
  });

  it.each([' -e ', ' --editor ', ' --headless ', ' -p ', ' --project-manager ', ' -d '])(
    'R2 exact owned path takes precedence over flattened flags: %s',
    async (token) => {
      project = join(scratch, `game${token}suffix`);
      mkdirSync(project);
      writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
      await run();
      const observer = makePool();
      try {
        expect(
          (await dispatchToolCall(observer, 'run_project', { projectPath: project }, context()))
            .isError,
        ).toBe(true);
        expect(children).toHaveLength(1);
        expect(children[0]!.kill).not.toHaveBeenCalled();
      } finally {
        await observer.stopAll();
      }
    },
  );

  it.each([' -e ', ' --editor ', ' --headless ', ' -p ', ' --project-manager ', ' -s '])(
    'R2 unrecorded ambiguous external path refuses without a signal: %s',
    async (token) => {
      project = join(scratch, `game${token}suffix`);
      mkdirSync(project);
      writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
      rows.push(row(80000, `/Applications/Godot.app/Contents/MacOS/Godot --path ${project}`, 1));
      const kills = vi.spyOn(process, 'kill');
      expect((await run()).isError).toBe(true);
      expect(children).toEqual([]);
      expect(kills).not.toHaveBeenCalled();
      expect(pool.list().limits.launching).toBe(0);
    },
  );

  it('R2 unrelated excluded processes never consume game capacity or receive signals', async () => {
    for (const [index, flag] of ['--editor', '--headless', '--project-manager'].entries()) {
      rows.push(
        row(
          80000 + index,
          `/Applications/Godot.app/Contents/MacOS/Godot --path ${scratch}/unrelated${index} ${flag}`,
          1,
        ),
      );
    }
    const kills = vi.spyOn(process, 'kill');
    expect((await run()).isError).toBeFalsy();
    expect(pool.list().limits.gamesOnHost).toBe(1);
    expect(kills).not.toHaveBeenCalled();
    expect(children).toHaveLength(1);
  });

  it.each([null, '', '  ', 42, false, {}, []])(
    'R2 supplied invalid path never selects the sole session: %j',
    async (value) => {
      await run();
      const handler = vi.spyOn(toolDispatch, 'get_debug_output');
      for (const key of ['projectPath', 'project_path']) {
        expect(
          (await dispatchToolCall(pool, 'get_debug_output', { [key]: value }, context())).isError,
        ).toBe(true);
      }
      expect(handler).not.toHaveBeenCalled();
      expect((await dispatchToolCall(pool, 'get_debug_output', {}, context())).isError).toBeFalsy();
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it('R2 get_server_info is registered and reports context without a project or spawn', async () => {
    const ctx = {
      ...context(),
      serverIdentity: { version: '3.6.0', releasePath: '/fixture/release' },
    };
    const response = await dispatchToolCall(pool, 'get_server_info', {}, ctx);
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      version: '3.6.0',
      releasePath: '/fixture/release',
      maxGames: 3,
      live: 0,
      launching: 0,
    });
    expect(children).toEqual([]);
  });

  it('R2 get_server_info counts actual pending and live sessions without touching them', async () => {
    const ctx = {
      ...context(),
      serverIdentity: { version: '3.6.0', releasePath: '/fixture/release' },
    };
    let release!: (value: { ready: boolean }) => void;
    vi.mocked(GodotRunner.prototype.waitForBridge).mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = run();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const starting = await dispatchToolCall(pool, 'get_server_info', {}, ctx);
    release({ ready: true });
    await pending;
    expect(starting.structuredContent).toMatchObject({ live: 0, launching: 1 });
    expect(
      (await dispatchToolCall(pool, 'get_server_info', {}, ctx)).structuredContent,
    ).toMatchObject({ live: 1, launching: 0 });
    expect(children[0]!.kill).not.toHaveBeenCalled();
  });

  it.each([' -e ', ' -p ', ' -s '])(
    'R2 owned orphan with flattened flags remains protected until confirmed exit: %s',
    async (flag) => {
      project = join(scratch, `game${flag}suffix`);
      mkdirSync(project);
      writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
      await run();
      const old = children[0]!;
      const file = join(state, 'sessions', readdirSync(join(state, 'sessions'))[0]!);
      writeFileSync(file, JSON.stringify({ ...records()[0], serverPid: 99999 }));
      rows = rows.map((p) => (p.pid === old.pid ? { ...p, ppid: 1 } : p));
      const kills: number[] = [];
      const observer = new RunnerPool({
        stateDir: state,
        listProcesses: () => rows,
        kill: (p) => {
          kills.push(p);
        },
        runnerConfig: { godotPath: process.execPath },
      });
      try {
        expect(
          (await dispatchToolCall(observer, 'run_project', { projectPath: project }, context()))
            .isError,
        ).toBe(true);
        expect(kills).toEqual([old.pid]);
        expect(records()).toHaveLength(1);
        expect(children).toHaveLength(1);
        old.emit('exit', 0);
        rows = rows.filter((p) => p.pid !== old.pid);
        expect(
          (await dispatchToolCall(observer, 'run_project', { projectPath: project }, context()))
            .isError,
        ).toBeFalsy();
        expect(records()).toHaveLength(1);
      } finally {
        await observer.stopAll();
      }
    },
  );
});
