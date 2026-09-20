# Tools

The full MCP tool reference for Godot MCP Runtime. This file always reflects `main`; for older releases, browse the corresponding git tag.

## Runtime sessions in this fork

Each canonical `projectPath` owns one runner, bridge, process, output buffer and profiler. Pass the same absolute `projectPath` to every runtime and profiler call, including `stop_project`. Symlink, relative and on-disk case aliases resolve to the same project. Conflicting `projectPath` and `project_path` values are refused. A path naming no session never borrows another project's game.

A second `run_project` for the same project replaces only that project's game. Argument and security checks finish before launch admission can stop anything. Lifecycle calls on one path queue in order, including a stop submitted immediately behind a launch; calls to different projects can overlap. A failed launch releases its reservation and cleans up only the child created by that attempt. Processes are recorded at spawn, before bridge readiness.

`list_sessions` is read-only. It returns `sessions`, `recentlyEnded` and `limits`. Sessions identify the path, mode (`spawned` or `attached`), state (`launching`, `live` or `exited`), PID, bridge port, profiler, start, idle duration and last command times. History keeps the last 20 process endings, each with PID and OS start identity, reason (`stopped`, `idle_stop`, `replaced`, `exited`, `launch_failed`, `server_shutdown`), exit code and time. A launch failure before a child exists has a null PID. A retained exited record is not a live session.

When `requireProjectPath` is false, an omitted path can select the sole live session; two or more sessions require an explicit path. When it is true, every session call needs a path regardless of session count. Headless scene editing remains blocked only by a runtime on that same project.

`run_project` launch options:

- `background: true` parks the window and blocks physical input while preserving programmatic input and captures. Background defaults may cap frames and silence audio.
- `maxFps` is an integer from 0 to 1000; 0 means uncapped. It overrides the background frame cap and also works on a visible run. It does not control audio.
- `audio: true` preserves the normal audio driver even on a background run. Use it for sound review. A driver name or an internal bus capture alone does not prove system output.
- `idleStopMinutes: 0` exempts this session from idle cleanup. Omission (or a positive value) restores the server setting for each new session, including replacement. Idle time starts when the last command completes; an in-flight command is never idle.
- `userArgs` stays after a standalone `--` and cannot become engine options. `bridgePort`, `scene` and `profiling` retain their existing meanings.

## Multi-game server configuration

The server reads `<package-root>/godot-mcp.config.json`, or the file named by `GODOT_MCP_CONFIG`. The environment overrides file values. Missing settings preserve upstream behavior. Invalid settings are diagnosed on stderr and ignored; security switches cannot be configured through this file.

| Setting                 | Environment override                | Default               |
| ----------------------- | ----------------------------------- | --------------------- |
| `requireProjectPath`    | `GODOT_MCP_REQUIRE_PROJECT_PATH`    | `false`               |
| `maxGames`              | `GODOT_MCP_MAX_GAMES`               | `0` (no cap)          |
| `backgroundMaxFps`      | `GODOT_MCP_BACKGROUND_MAX_FPS`      | `0` (no cap)          |
| `backgroundAudioDriver` | `GODOT_MCP_BACKGROUND_AUDIO_DRIVER` | empty (normal driver) |
| `idleStopMinutes`       | `GODOT_MCP_IDLE_STOP_MINUTES`       | `0` (disabled)        |

`GODOT_MCP_STATE_DIR` selects the ownership-record directory (default `<package-root>/state`). Each record contains the game PID and OS start time, canonical path, server PID and server start time. Shutdown removes only records belonging to children this pool actually spawned, matching both identities. An observer pool cannot remove another server's record.

Admission counts host Godot games plus this server's pending launches. At the cap it refuses immediately; it never waits while holding a project mutex. A process-table inspection failure refuses admission and reports `limits.gamesOnHost: null` with `processInspectionError`, never a false zero. The host cap is soft across different servers starting simultaneously. Windows process inspection is unavailable, so this fork refuses pooled launches there until an inspector is provided; this Mac fork does not claim Windows multi-game support.

The process parser reads engine arguments only before `--`, excludes headless, editor and project-manager processes (`-e`, `--editor`, `-p`, `--project-manager`), and stops the parsed path at the first short or long option. Spaces inside a path are retained. Because `ps` loses argument boundaries, ambiguous space-prefix matches are conservatively treated as the same project. A matching PID/start record takes precedence over the parsed path. A foreign live game is refused; automatic orphan cleanup requires a matching ownership record whose server has exited.

## Project Management

| Tool               | Description                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch_editor`    | Open the Godot editor GUI for a project                                                                                                                                                                                                                                                                                                                                                |
| `run_project`      | Run a project and inject the MCP bridge. Pass `background: true` to hide the window; `profiling: true` to enable the profiling tools; pass `bridgePort` (integer 1–65535) to pin the bridge port - auto-selects a free port when omitted; pass `userArgs` (array of strings) for the game's own arguments, appended after a standalone `--` and read with `OS.get_cmdline_user_args()` |
| `attach_project`   | Inject the MCP bridge for a project you'll launch yourself. Pass `bridgePort` (integer 1–65535) to pin a specific port - auto-selects a free port when omitted                                                                                                                                                                                                                         |
| `detach_project`   | Remove the injected bridge after manual-launch use, leaving the external process alone. Mostly optional: a disconnected bridge ends the attached session on the next tool call, and calling this afterwards succeeds idempotently                                                                                                                                                      |
| `stop_project`     | Stop the running project and remove the bridge (also detaches attached-mode state). Call it even if you closed the Godot window yourself - it frees the retained process slot and reports `alreadyExited` with the logs captured then                                                                                                                                                  |
| `get_debug_output` | Read stdout/stderr from an MCP-spawned project, including after it exits or crashes (unavailable in attached mode)                                                                                                                                                                                                                                                                     |
| `list_projects`    | Find Godot projects in a directory                                                                                                                                                                                                                                                                                                                                                     |
| `get_project_info` | Get project metadata and Godot version                                                                                                                                                                                                                                                                                                                                                 |

## Runtime (requires `run_project` or `attach_project` first)

Both `run_project` and `attach_project` wait for the bridge before returning success, so runtime tools are usable immediately after the call returns. `attach_project` waits up to 15 s for the externally launched Godot process to come up. If you (the agent) are launching Godot yourself, kick the launch off in parallel with `attach_project` so the wait absorbs Godot's startup - don't sequentialize. If a human is launching Godot and they don't make it inside the window, retry `attach_project` (`bridge.inject` is idempotent). Both `run_project` and `attach_project` auto-select a free bridge port when `bridgePort` is omitted; pass `bridgePort` to pin a specific port.

| Tool              | Description                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `take_screenshot` | Capture a PNG; defaults to a 960x540 inline preview. Use `responseMode: "full"` for pixel-perfect, `"path_only"` for path metadata only  |
| `simulate_input`  | Send batched input: key, mouse_button, mouse_motion, click_element, action, wait                                                         |
| `get_ui_elements` | Get all visible Control nodes with positions (root-viewport pixels, through SubViewportContainers and embedded Windows), types, and text |
| `run_script`      | Execute arbitrary GDScript at runtime with full SceneTree access                                                                         |

`take_screenshot` defaults to `responseMode: "preview"` - the full PNG is saved to `.mcp/godot-runtime/screenshots/` and a 960x540-bounded preview is returned inline. Use `"full"` for pixel-level inspection or `"path_only"` to skip the inline image.

## Profiling (requires `run_project` with `profiling: true`)

`profiling: true` adds `--remote-debug` to the launch, so the numbers are Godot's own editor profiler measurements. The channel is set at launch: an already-running session, and every `attach_project` session, returns "Profiling is not enabled for this session."

| Tool              | Description                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `profile_project` | Capture a window (default 5 s, max 60) and return the most expensive GDScript functions   |
| `start_profiler`  | Start a capture and return immediately, so runtime tools can drive the game while it runs |
| `stop_profiler`   | Stop (or re-read) that capture and rank its functions                                     |

A capture returns the same three things the editor's Profiler tab shows:

| Field        | Editor equivalent                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rows[]`     | The **Script Functions** list. `function`, `file`, `line` (the tooltip's `res://…gd:371`), summed `calls`, own `selfMs` and inclusive `totalMs`, per-frame averages, `msPerCall` (the editor's "Average Time"), `percentOfFrame` ("Frame %", a share of the capture's own average frame, not of a 16.67 ms target), and `peak` frame |
| `frame`      | The **Frame Time** category: `frameMs`, `processMs`, `physicsMs`, `physicsFrameMs`, `scriptMs`, each as `{ avg, max }` over the capture                                                                                                                                                                                              |
| `servers[]`  | One entry per server category (`audio_thread`, `physics_2d`, …) with its functions, in milliseconds per frame                                                                                                                                                                                                                        |
| `worstFrame` | The slowest single frame: its timings plus its top 30 functions by inclusive time - the spike you would click in the editor's graph                                                                                                                                                                                                  |

`sort` ranks rows by `selfMs` (default), `totalMs`, or `calls`. Milliseconds are rounded to four decimals.

Reading the numbers:

- Times are elapsed wall clock, including waits — not CPU utilization. Inclusive rows overlap, so summing `totalMs` is meaningless.
- Totals sum the received frames after the first, which is discarded: enabling the profiler inside a running VM call gives that sample a zero start timestamp.
- Godot picks the rows it sends by inclusive time and caps them at `captureLimit`. `limitReached`, `frameGaps` and `undecodablePackets` say when rows, whole frames, or packets are missing; a function that is absent is not a function that is free.
- Totals are summed from the frame packets. The engine's own `servers:profile_total` is capped by the same `captureLimit` and carries nothing the frames did not, while top-N membership rotates between frames — so summing them covers strictly more functions than that packet does.
- The injected `mcp_bridge.gd` polls its socket every frame, so it shows up in the rows like any other script. That is real observer overhead (well under 0.05 ms/frame in practice), not a measurement artifact. A `run_script` you execute during a capture is profiled the same way and appears under its own generated script name — discount it when reading a capture you drove yourself.
- Native engine calls are not profiled as separate rows (the editor's "Display internal functions" toggle), so `selfMs` matches the editor's Self column in its default configuration.
- A capture stops itself at its time limit, measured from the first frame folded rather than from the enable round trip. `stop_project` ends it along with the session.
- A capture that folded no usable frames errors rather than returning zeroes: the first frame received is always discarded, so a window shorter than two rendered frames has nothing to average.
- A finished capture stays readable after the game exits, so the capture taken just before a crash can still be ranked.

While the debugger is attached, a script error or a `breakpoint` would normally pause the game; the server answers every break with `continue`, so the game keeps running and the error still shows up in `get_debug_output`.

## Scene Editing (headless)

All mutation operations save automatically. Use `save_scene` only for save-as (`newPath`) or to re-canonicalize a `.tscn` file.

Every tool below errors while a Godot runtime session is active on the same project - a running process can write its own scene files at any point, so a headless write would race it. Call `stop_project` (or `detach_project`) to clear the block. A spawned process that exits on its own clears the block at that moment, without a tool call.

| Tool                     | Description                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `create_scene`           | Create a new scene file                                                                  |
| `add_node`               | Add a node, or instance an existing scene, into a scene                                  |
| `load_sprite`            | Set a texture on a Sprite2D, Sprite3D, or TextureRect                                    |
| `save_scene`             | Re-pack and save the scene, or save-as with `newPath`                                    |
| `export_mesh_library`    | Export scenes as a MeshLibrary for GridMap                                               |
| `batch_scene_operations` | Run multiple add_node/load_sprite/set_node_properties/save ops in a single Godot process |

`add_node` takes either a Godot class name or a project-relative scene path (`.tscn` or `.scn`, matched case-insensitively) as `nodeType`. A scene path is loaded and instanced, and serializes as `instance=ExtResource(...)` on save, so scenes can be composed without hand-editing `.tscn` files.

Spatial properties (`position`, `rotation`, `scale`, `visible`, `modulate`) may be passed as top-level params instead of under `properties`, on the standalone tool and on `add_node` items inside `batch_scene_operations` alike. `properties` wins on a key conflict. `position` takes `{x, y}` on a 2D node and `{x, y, z}` on a 3D node.

`set_node_properties` items inside `batch_scene_operations` accept the same per-update params (`nodePath`, `property`, `value`) as the standalone tool, plus a per-operation `scenePath` and `abortOnError`; per-update results appear under `results[].updates`.

Every path argument is confined to the project root. A path that resolves outside it (for example `../enemy.tscn`) is rejected rather than followed, on both the standalone and batch paths.

## Node Editing (headless)

All mutation operations save automatically. Property and delete tools take always-array input - pass a single-element array for one-off operations, or many for batched work in one Godot process.

`set_node_properties`, `attach_script`, `duplicate_node`, `delete_nodes`, `connect_signal`, and `disconnect_signal` error while a Godot runtime session is active on the same project - a running process can write its own scene files at any point, so a headless write would race it. Call `stop_project` (or `detach_project`) to clear the block. The three read-only tools (`get_scene_tree`, `get_node_properties`, `get_node_signals`) are unaffected.

| Tool                  | Description                                                               |
| --------------------- | ------------------------------------------------------------------------- |
| `get_scene_tree`      | Get the full scene tree hierarchy (use `maxDepth: 1` for shallow listing) |
| `get_node_properties` | Read properties from one or more nodes (always-array `nodes`)             |
| `set_node_properties` | Set properties on one or more nodes (always-array `updates`)              |
| `attach_script`       | Attach a GDScript to a node                                               |
| `duplicate_node`      | Duplicate a node within the scene                                         |
| `delete_nodes`        | Remove one or more nodes from the scene (always-array `nodePaths`)        |
| `get_node_signals`    | List all signals on a node with their connections                         |
| `connect_signal`      | Connect a signal to a method on another node                              |
| `disconnect_signal`   | Disconnect a signal connection                                            |

## Property Values (`add_node`, `set_node_properties`)

Both tools take JSON property values and assign them through the same validated path. `node.set()` casts through the property's typed setter with no validity return, so an incompatible value would silently store the declared type's zero value (a string on an int stores `0`, a dict on a Resource clears it). Every value is therefore checked against the property's declared type first, and a mismatch errors instead of reporting a write that did not land.

### Automatic conversions

| Input                        | Becomes                     |
| ---------------------------- | --------------------------- |
| `{x, y}`                     | `Vector2`                   |
| `{x, y, z}`                  | `Vector3`                   |
| `{r, g, b}` / `{r, g, b, a}` | `Color` (`a` defaults to 1) |

A property whose declared type is `Dictionary` skips this coercion, so a dict with `x`/`y` or `r`/`g`/`b` keys is stored as a plain `Dictionary`.

### Accepted widening conversions

Godot performs these on store, so they are allowed: float to int, string to `NodePath` or `StringName`, bool to int or float, `Vector2` to `Vector2i` (and back), `Vector3` to `Vector3i` (and back), and `Array` to any `Packed*Array`. Everything else errors.

### Object-typed properties

Properties declared as a `Resource` or `Node` (for example `CollisionShape2D.shape`, `Sprite2D.texture`) reject plain values. They accept one of three forms:

| Form                                | Behavior                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `"res://path/to/file.tres"`         | Loads the saved resource. Errors if the path does not exist or the asset has not been imported. |
| `{ "type": "ClassName", ...props }` | Constructs the Resource inline via `ClassDB.instantiate`, then assigns each inner property.     |
| `null`                              | Clears the property.                                                                            |

Inline construction example:

```json
{ "shape": { "type": "RectangleShape2D", "size": { "x": 80, "y": 16 } } }
```

Inner properties are assigned through the same validation described above, so nested typed dicts and nested `res://` paths both work at any depth. The scene is persisted with `PackedScene.pack()`, so a constructed Resource is written out as a normal `[sub_resource]` block.

Construction errors are explicit and nothing is persisted when one fires:

- `type` names an unknown class
- `type` names a class that is not a `Resource` subclass
- `type` names an abstract or native-only class that cannot be instantiated
- the constructed class does not satisfy the property's declared resource hint (for example a `RectangleShape2D` assigned to `Sprite2D.texture`)
- an inner property does not exist on the constructed class, or its value fails the type check (the error names the inner property)

## Project Config (no Godot process required)

These tools edit `project.godot` directly or read the filesystem. Safe to use even when autoloads are broken.

| Tool                     | Description                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `list_autoloads`         | List all registered autoloads with paths and singleton status        |
| `add_autoload`           | Register a new autoload                                              |
| `remove_autoload`        | Unregister an autoload by name                                       |
| `update_autoload`        | Modify an existing autoload's path or singleton flag                 |
| `get_project_settings`   | Read settings from `project.godot`, optionally filtered by `section` |
| `get_project_files`      | Get the project file tree with types and extensions                  |
| `search_project`         | Search for a string across project source files                      |
| `get_scene_dependencies` | List all resources a scene depends on                                |

## Validation: `validate`

Validate before attaching or running. Catches syntax errors and missing resource references before they cause headless crashes or runtime failures. Supports `scriptPath`, `source` (inline GDScript), `scenePath`, or a `targets` array for batch validation.
