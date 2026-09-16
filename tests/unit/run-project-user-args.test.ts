/**
 * run_project's userArgs reach the game as its own command-line arguments: appended after a
 * standalone `--` (so Godot never reads them as engine options), one argv entry each, and never
 * through a shell. `child_process.spawn` is mocked at the I/O boundary so the real runProject body
 * builds the argv under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { spawnMock, injectMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), injectMock: vi.fn() }));

vi.mock('child_process', async () => ({
  ...(await vi.importActual('child_process')),
  spawn: (...args: unknown[]) => spawnMock(...args),
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
  },
}));

import { GodotRunner } from '../../src/utils/godot-runner.js';

function fakeSpawnedProcess() {
  return {
    pid: 4243,
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  };
}

describe('runProject userArgs', () => {
  let projectDir: string;
  let runner: GodotRunner;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'gmr-user-args-'));
    writeFileSync(join(projectDir, 'project.godot'), '[application]');
    writeFileSync(join(projectDir, 'main.tscn'), '');
    spawnMock.mockReset().mockReturnValue(fakeSpawnedProcess());
    runner = new GodotRunner({ godotPath: process.execPath });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  const argv = (): string[] => spawnMock.mock.calls[0]![1] as string[];
  const options = (): Record<string, unknown> =>
    spawnMock.mock.calls[0]![2] as Record<string, unknown>;

  it('appends them after a standalone --, one argv entry each, with no shell', async () => {
    const userArgs = [
      '--save-root=/tmp/he saves/a b',
      "it's",
      '$(touch pwned)',
      '; rm -rf ~',
      '--path',
      '/elsewhere',
      '--script',
      'res://evil.gd',
    ];
    await runner.runProject(projectDir, undefined, true, undefined, false, userArgs);
    expect(argv()).toEqual(['--path', projectDir, '--', ...userArgs]);
    expect(options().shell).toBeFalsy();
  });

  it('keeps every engine argument, the scene included, before the --', async () => {
    await runner.runProject(projectDir, 'main.tscn', true, undefined, false, ['--new']);
    expect(argv()).toEqual(['--path', projectDir, 'main.tscn', '--', '--new']);
  });

  it('adds no -- when there are no user args', async () => {
    await runner.runProject(projectDir, undefined, true);
    await runner.runProject(projectDir, undefined, true, undefined, false, []);
    for (const call of spawnMock.mock.calls) {
      expect(call[1]).toEqual(['--path', projectDir]);
    }
  });
});
