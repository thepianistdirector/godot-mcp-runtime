/**
 * Input and UI geometry against a real engine, in the layout a pixel-art game uses: a 640x360
 * viewport stretched into a 1280x720 window, with Controls inside SubViewportContainers (1:1 and
 * shrunk), a rotated Control and an embedded Window. The fixture is
 * tests/fixtures/godot-input-project; its main.gd lists where every Control sits.
 *
 * Covers three contracts:
 * - a press, a motion and a release sent in ONE simulate_input batch give the motion the held
 *   button in its button_mask (the bridge used to read Input's mask before the queued press was
 *   processed, so the motion carried 0);
 * - get_ui_elements and click_element place a Control in root-viewport pixels however it is
 *   embedded, as the axis-aligned bounds of its four transformed corners, and refuse a Control no
 *   viewport on screen displays;
 * - run_project's userArgs reach OS.get_cmdline_user_args() unchanged.
 *
 * Requires GODOT_PATH. Runs in background mode, so the physical mouse cannot add events.
 */

import { describe, beforeAll, afterEach, expect } from 'vitest';
import { cpSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { itGodot } from '../helpers/godot-skip.js';
import { runProjectOrSkip } from '../helpers/run-project-or-skip.js';
import { inputFixtureProjectPath } from '../helpers/fixture-paths.js';
import { GodotRunner } from '../../src/utils/godot-runner.js';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Element {
  name: string;
  rect: Rect;
  mapped?: boolean;
}
interface FixtureState {
  root_clicks: number;
  nested_clicks: number;
  shrunk_clicks: number;
  window_clicks: number;
  offscreen_clicks: number;
  motions: number[][];
  buttons: number[][];
}

describe('input and embedding (real engine)', () => {
  let runner: GodotRunner;
  let tmpProject: string | null = null;

  beforeAll(async () => {
    runner = new GodotRunner({ godotPath: process.env.GODOT_PATH });
    await runner.detectGodotPath();
  });

  afterEach(async () => {
    try {
      await runner.stopProject();
    } catch {
      // already stopped
    }
    if (tmpProject) {
      rmSync(tmpProject, { recursive: true, force: true });
      tmpProject = null;
    }
  });

  function copyFixture(): string {
    tmpProject = join(tmpdir(), `godot-mcp-runtime-input-${randomBytes(6).toString('hex')}`);
    cpSync(inputFixtureProjectPath, tmpProject, { recursive: true });
    return tmpProject;
  }

  async function command(
    name: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return JSON.parse(await runner.sendCommand(name, params, 15000)) as Record<string, unknown>;
  }

  async function script(body: string): Promise<unknown> {
    const source = `extends RefCounted\nfunc execute(scene_tree: SceneTree) -> Variant:\n${body}\n`;
    const resp = await command('run_script', { source });
    if (resp.error) throw new Error(String(resp.error));
    return resp.result;
  }

  async function input(actions: Record<string, unknown>[]): Promise<Record<string, unknown>> {
    return command('input', { actions });
  }

  const state = async (): Promise<FixtureState> =>
    (await script('\treturn scene_tree.current_scene.state()')) as FixtureState;

  async function elements(): Promise<Map<string, Element>> {
    const resp = await command('get_ui_elements', { visible_only: true });
    return new Map((resp.elements as Element[]).map((e) => [e.name, e]));
  }

  function expectRect(actual: Rect | undefined, want: Rect): void {
    expect(actual).toBeDefined();
    for (const k of ['x', 'y', 'width', 'height'] as const) {
      expect(actual![k], `${k} of ${JSON.stringify(actual)}`).toBeCloseTo(want[k], 3);
    }
  }

  itGodot(
    'a press, a motion and a release in one batch give the motion the held button',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture(), { background: true });
      await script('\tscene_tree.current_scene.reset()\n\treturn true');

      const resp = await input([
        { type: 'mouse_button', button: 'left', pressed: true, x: 100, y: 320 },
        { type: 'mouse_motion', x: 180, y: 320, relative_x: 80, relative_y: 0 },
        { type: 'mouse_button', button: 'left', pressed: false, x: 180, y: 320 },
        { type: 'mouse_motion', x: 220, y: 320, relative_x: 40, relative_y: 0 },
      ]);
      expect(resp.error).toBeUndefined();

      const s = await state();
      const onRow = (rows: number[][], yIndex: number) => rows.filter((r) => r[yIndex] === 320);
      // [x, y, mask]: held during the first motion, released before the second.
      expect(onRow(s.motions, 1)).toEqual([
        [180, 320, 1],
        [220, 320, 0],
      ]);
      // [pressed, x, y, mask]: a physical press reports the button it holds, a release none.
      expect(onRow(s.buttons, 2)).toEqual([
        [1, 100, 320, 1],
        [0, 180, 320, 0],
      ]);
    },
    60000,
  );

  itGodot(
    'get_ui_elements reports embedded and rotated Controls in root-viewport pixels',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture(), { background: true });
      const els = await elements();
      expectRect(els.get('RootButton')?.rect, { x: 24, y: 24, width: 120, height: 32 });
      expectRect(els.get('NestedButton')?.rect, { x: 320, y: 70, width: 80, height: 24 });
      expectRect(els.get('ShrunkButton')?.rect, { x: 60, y: 220, width: 80, height: 32 });
      expectRect(els.get('Rotated')?.rect, { x: 480, y: 250, width: 20, height: 40 });
      expectRect(els.get('WindowButton')?.rect, { x: 530, y: 70, width: 60, height: 24 });
      expect(els.get('NestedButton')?.mapped).not.toBe(false);
      expect(els.get('OffscreenButton')?.mapped).toBe(false);
    },
    60000,
  );

  itGodot(
    'click_element clicks the Control inside each embedding, and nothing else',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture(), { background: true });
      await script('\tscene_tree.current_scene.reset()\n\treturn true');
      for (const element of ['NestedButton', 'ShrunkButton', 'WindowButton']) {
        const resp = await input([{ type: 'click_element', element }]);
        expect(resp.error, element).toBeUndefined();
      }
      const s = await state();
      expect([s.nested_clicks, s.shrunk_clicks, s.window_clicks, s.root_clicks]).toEqual([
        1, 1, 1, 0,
      ]);
    },
    60000,
  );

  itGodot(
    'click_element refuses a Control that no viewport on screen displays',
    async (ctx) => {
      await runProjectOrSkip(runner, ctx, copyFixture(), { background: true });
      const resp = await input([{ type: 'click_element', element: 'OffscreenButton' }]);
      expect(String(resp.error)).toMatch(/not displayed/);
      expect((await state()).offscreen_clicks).toBe(0);
    },
    60000,
  );

  itGodot(
    'run_project hands userArgs to the game unchanged, after a standalone --',
    async (ctx) => {
      const userArgs = [
        '--save-root=/tmp/he saves/a b',
        "it's",
        '$(echo pwned)',
        '; rm -rf nothing',
        'ñandú',
        '--path',
        '/nowhere',
        '--new',
      ];
      await runProjectOrSkip(runner, ctx, copyFixture(), { background: true, userArgs });
      expect(await script('\treturn Array(OS.get_cmdline_user_args())')).toEqual(userArgs);
    },
    60000,
  );
});
