/**
 * Tool dispatch table.
 *
 * Maps every MCP tool name to a handler that takes the runner + raw args and
 * returns the tool response. Extracted from index.ts so tests can exercise
 * dispatch as a pure data structure (no Server / stdio / lifecycle setup).
 *
 * Behavioral contract preserved from the original switch in index.ts:
 *  - Each name routes to the same handler it did before.
 *  - Unknown tool names throw McpError(MethodNotFound, ...) — see
 *    `dispatchToolCall`.
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { GodotRunner } from './utils/godot-runner.js';
import { RunnerPool, canonicalizeProjectArgs } from './utils/runner-pool.js';
import { createErrorResponse } from './utils/error-response.js';
import type { OperationParams, ToolHandler, ToolName, ToolResponse } from './mcp.types.js';
import { createNullContext, type McpContext } from './utils/mcp-context.js';
import { isOk } from './utils/result.js';

import {
  handleLaunchEditor,
  handleRunProject,
  handleAttachProject,
  handleDetachProject,
  handleGetDebugOutput,
  handleStopProject,
  handleTakeScreenshot,
  handleSimulateInput,
  handleGetUiElements,
  handleRunScript,
  handleListSessions,
} from './tools/runtime-tools.js';

import {
  handleListAutoloads,
  handleAddAutoload,
  handleRemoveAutoload,
  handleUpdateAutoload,
} from './tools/autoload-tools.js';

import {
  handleListProjects,
  handleGetProjectInfo,
  handleGetProjectFiles,
  handleSearchProject,
  handleGetSceneDependencies,
  handleGetProjectSettings,
} from './tools/project-tools.js';

import {
  handleCreateScene,
  handleAddNode,
  handleLoadSprite,
  handleSaveScene,
  handleExportMeshLibrary,
  handleBatchSceneOperations,
} from './tools/scene-tools.js';

import {
  handleDeleteNodes,
  handleSetNodeProperties,
  handleGetNodeProperties,
  handleAttachScript,
  handleGetSceneTree,
  handleDuplicateNode,
  handleGetNodeSignals,
  handleConnectSignal,
  handleDisconnectSignal,
} from './tools/node-tools.js';

import {
  handleProfileProject,
  handleStartProfiler,
  handleStopProfiler,
} from './tools/profiler-tools.js';

import { handleValidate } from './tools/validate-tools.js';

export const toolDispatch = {
  // Project tools
  launch_editor: handleLaunchEditor,
  run_project: handleRunProject,
  attach_project: handleAttachProject,
  detach_project: handleDetachProject,
  get_debug_output: handleGetDebugOutput,
  stop_project: handleStopProject,
  list_projects: (_runner, args) => handleListProjects(args),
  list_sessions: handleListSessions,
  get_project_info: handleGetProjectInfo,
  take_screenshot: handleTakeScreenshot,
  simulate_input: handleSimulateInput,
  get_ui_elements: handleGetUiElements,
  run_script: handleRunScript,
  list_autoloads: (_runner, args) => handleListAutoloads(args),
  add_autoload: (_runner, args) => handleAddAutoload(args),
  remove_autoload: (_runner, args) => handleRemoveAutoload(args),
  update_autoload: (_runner, args) => handleUpdateAutoload(args),
  get_project_files: (_runner, args) => handleGetProjectFiles(args),
  search_project: (_runner, args) => handleSearchProject(args),
  get_scene_dependencies: (_runner, args) => handleGetSceneDependencies(args),
  get_project_settings: (_runner, args) => handleGetProjectSettings(args),

  // Scene tools
  create_scene: handleCreateScene,
  add_node: handleAddNode,
  load_sprite: handleLoadSprite,
  save_scene: handleSaveScene,
  export_mesh_library: handleExportMeshLibrary,
  batch_scene_operations: handleBatchSceneOperations,

  // Node tools
  delete_nodes: handleDeleteNodes,
  set_node_properties: handleSetNodeProperties,
  get_node_properties: handleGetNodeProperties,
  attach_script: handleAttachScript,
  get_scene_tree: handleGetSceneTree,
  duplicate_node: handleDuplicateNode,
  get_node_signals: handleGetNodeSignals,
  connect_signal: handleConnectSignal,
  disconnect_signal: handleDisconnectSignal,

  // Profiler tools
  profile_project: handleProfileProject,
  start_profiler: handleStartProfiler,
  stop_profiler: handleStopProfiler,

  // Validate tools
  validate: handleValidate,
} as const satisfies Record<ToolName, ToolHandler>;

/**
 * Route one tool call. `runnerOrPool` may be a bare GodotRunner (every existing
 * call site and test): bare runners use the original single-runner handler path.
 *
 * With a real pool the order is fixed, and each step exists because a reviewer
 * broke the plan without it:
 *  1. the project's identity is made canonical and put back into the arguments,
 *     parameter name first, so no handler ever holds a caller's spelling;
 *  2. the pool picks the runner, or refuses: a session tool never falls back to
 *     another project's session;
 *  3. launches and stops of one project are serialised, and a `run_project`
 *     passes the host budget before it spawns; whatever happens to the launch,
 *     its `launching` state is settled in a `finally`.
 */
export async function dispatchToolCall(
  runnerOrPool: GodotRunner | RunnerPool,
  toolName: string,
  args: OperationParams,
  ctx: McpContext = createNullContext(),
): Promise<ToolResponse> {
  const handler = toolDispatch[toolName as ToolName] as ToolHandler | undefined;
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
  }
  if (runnerOrPool instanceof GodotRunner || !(runnerOrPool instanceof RunnerPool)) {
    const result = await handler(runnerOrPool as GodotRunner, args, ctx);
    return isOk(result) ? result.value : result.error;
  }
  const pool = runnerOrPool;

  const canonical = canonicalizeProjectArgs(args);
  if (!canonical.ok) return createErrorResponse(canonical.message, []);
  const resolution = pool.resolve(toolName, canonical.key);
  if (resolution.kind === 'refusal') {
    const [first = '', ...rest] = resolution.message.split('\n');
    return createErrorResponse(first, rest);
  }
  const { runner, key } = resolution;
  const callCtx: McpContext = { ...ctx, sessions: pool, serverConfig: pool.serverConfig };

  const invoke = async (): Promise<ToolResponse> => {
    pool.begin(key, toolName);
    try {
      const result = await handler(runner, canonical.args, callCtx);
      return isOk(result) ? result.value : result.error;
    } finally {
      pool.end(key);
    }
  };

  if (key === null || !pool.isLifecycleTool(toolName)) return invoke();

  return pool.withLifecycle(key, async () => {
    if (toolName !== 'run_project') {
      if (toolName === 'stop_project') pool.markStopping(key, 'stopped');
      const response = await invoke();
      if (!response.isError && (toolName === 'stop_project' || toolName === 'detach_project')) {
        pool.noteStopped(key);
      }
      return response;
    }
    let succeeded = false;
    try {
      const response = await invoke();
      succeeded = !response.isError;
      return response;
    } finally {
      await pool.settleLaunch(key, succeeded);
    }
  });
}
