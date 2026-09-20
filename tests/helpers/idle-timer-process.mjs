// A real Node event loop runs the production interval and stop path. Only the
// minute interval is shortened; both two-second process-exit waits stay real.
// No Godot or OS process is ever signalled by these EventEmitter children.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GodotRunner } from '../../dist/utils/godot-runner.js';
import { RunnerPool } from '../../dist/utils/runner-pool.js';
import { DEFAULT_SERVER_CONFIG } from '../../dist/utils/server-config.js';

const originalSetInterval = globalThis.setInterval;
globalThis.setInterval = (callback, ms, ...args) =>
  originalSetInterval(callback, ms === 60_000 ? 10 : ms, ...args);
const scratch = process.argv[2];
assert(scratch, 'The parent test must supply its private scratch directory');
const state = join(scratch, 'state');
const stamp = 'Sun Sep 20 09:00:00 2026';
let now = 1;
const rows = [{ pid: process.pid, ppid: 1, rssKb: 1, startedAt: stamp, command: 'node fixture' }];
const pool = new RunnerPool({
  stateDir: state,
  now: () => now,
  listProcesses: () => rows,
  serverConfig: { ...DEFAULT_SERVER_CONFIG, idleStopMinutes: 1 },
  createRunner: (config) => new GodotRunner({ ...config, godotPath: process.execPath }),
});
globalThis.setInterval = originalSetInterval;
const children = [];
const signals = [];
const records = () =>
  readdirSync(join(state, 'sessions')).map((name) =>
    JSON.parse(readFileSync(join(state, 'sessions', name), 'utf8')),
  );
let errors = 0;
const originalError = console.error;
console.error = (...args) => {
  originalError(...args);
  if (args.map(String).join(' ').includes('Could not confirm exit')) {
    errors += 1;
    // Stop further automatic retries after this first bounded failure, so the
    // following assertions can inspect the preserved child without a race.
    pool.setNoIdleStop(children[0].key, true);
  }
};

try {
  for (const [index, label] of ['refused', 'sibling'].entries()) {
    const key = join(scratch, label);
    mkdirSync(key);
    writeFileSync(join(key, 'project.godot'), 'config_version=5\n');
    const resolution = pool.resolve('run_project', key);
    assert.equal(resolution.kind, 'runner');
    const runner = resolution.runner;
    assert.equal(pool.prepareLaunch(key), null);
    const child = Object.assign(new EventEmitter(), {
      pid: 70001 + index,
      kill(signal) {
        signals.push({ pid: this.pid, signal });
        if (index === 1) this.emit('exit', 0);
        return true;
      },
    });
    const proc = {
      process: child,
      output: [],
      errors: [],
      totalErrorsWritten: 0,
      exitCode: null,
      hasExited: false,
      sessionToken: 'private-unit-fixture',
    };
    // The runner's spawn boundary is doubled here; production pool ownership,
    // idle scheduling and stop logic remain intact.
    child.on('exit', (code) => {
      proc.hasExited = true;
      proc.exitCode = code;
      const row = rows.findIndex((entry) => entry.pid === child.pid);
      if (row !== -1) rows.splice(row, 1);
    });
    rows.push({
      pid: child.pid,
      ppid: process.pid,
      rssKb: 1,
      startedAt: stamp,
      command: `godot --path ${key}`,
    });
    runner.activeProcess = proc;
    runner.activeSessionMode = 'spawned';
    runner.activeProjectPath = key;
    runner.activeBridgePort = 12346 + index;
    runner.sendCommand = async () => '{}';
    children.push({ key, child, proc, runner });
    await pool.settleLaunch(key, true);
    pool.begin(key, 'fixture');
    pool.end(key);
  }
  const before = records().find((entry) => entry.pid === children[0].child.pid);
  now = 120001;
  console.log('ARMED_REAL_IDLE_CALLBACK');
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(errors, 1, 'refused automatic stop must produce one visible diagnostic');
  assert.deepEqual(
    signals.filter((entry) => entry.pid === 70001).map((entry) => entry.signal),
    ['SIGTERM', 'SIGKILL'],
  );
  assert.deepEqual(records(), [before]);
  assert.equal(children[0].proc.hasExited, false);
  assert.equal(children[1].proc.hasExited, true);
  assert.deepEqual(
    pool.list().recentlyEnded.map((entry) => entry.reason),
    ['idle_stop'],
  );
  console.log('SERVER_SURVIVED_REFUSED_IDLE_STOP_WITH_SIBLING_CLEANED');
} finally {
  for (const { child, proc } of children) if (!proc.hasExited) child.emit('exit', 0);
  await pool.stopAll();
  assert.deepEqual(records(), []);
  console.error = originalError;
}
