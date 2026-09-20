# Test fixtures

## `godot-project/`

A minimal Godot 4.4 project used as a stable test surface for MCP tools. Committed to the repo (unlike `.test-project/`, which is gitignored for ad-hoc local testing) so contributors and CI share the same baseline.

Contents:
- `project.godot` — minimal config, references `main.tscn` as main scene
- `main.tscn` — `Node2D` root with `Label` and `Sprite2D` children
- `placeholder.gd`, `placeholder.png` — empty placeholder files used by handler tests that exercise `attach_script` / `load_sprite` runner-throws paths

## `godot-profiling-project/`

The same shape, with a `_process` loop that burns measurable time (`hot_loop.gd::burn`).
`integration/profiler-smoke.test.ts` launches it with `profiling: true` and expects that
function to come back at the top of the capture. Import it as `profilingFixtureProjectPath`.

## `godot-input-project/`

A 640x360 viewport stretched into a 1280x720 window (integer scale), like a pixel-art game. Its
`main.gd` builds a root button, buttons inside a 1:1 and a 2x-shrunk SubViewportContainer, a rotated
Control, a button in an embedded Window and one in a SubViewport nothing displays, and records every
mouse event's position and `button_mask` (`state()`, `reset()` through `run_script`). The comment at
the top of `main.gd` lists where each Control sits in root-viewport pixels.
`integration/input-and-embedding.test.ts` uses it. Import it as `inputFixtureProjectPath`.

Use it from tests by importing the path helper:

```ts
import { fixtureProjectPath } from '../helpers/fixture-paths.js';
```

`tests/helpers/fixture-paths.ts` exports `fixtureProjectPath`, `fixtureScenePath`, and `fixtureSceneAbsPath` so individual specs don't redo the `fileURLToPath` / `dirname` / `join` boilerplate.

Tests that exercise headless Godot (validate, scene operations) skip themselves when `GODOT_PATH` is not set, so this fixture is also safe to leave in place when Godot is not installed.

When you change a tool's contract, update this fixture or add a sibling fixture under `tests/fixtures/` rather than mutating `main.tscn` in place — old tests may depend on the existing shape.
