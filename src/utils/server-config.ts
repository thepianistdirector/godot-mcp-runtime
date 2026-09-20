/**
 * Server-wide settings for running many games at once.
 *
 * Read from `godot-mcp.config.json` beside the build (the parent of `dist/`),
 * or from the file named by `GODOT_MCP_CONFIG`. An environment variable of the
 * same meaning overrides a key. A missing file means upstream behaviour: one
 * implicit session is still addressable without `projectPath`, no host budget,
 * no engine options on background runs, no idle stop.
 *
 * The security variables (GODOT_MCP_STRICT, GODOT_MCP_DISABLE_ELICITATION,
 * GODOT_MCP_DISABLE_SECURITY) are deliberately not settable from this file.
 */

export interface ServerConfig {
  /** Refuse a session tool call that omits `projectPath`, however many sessions are live. */
  requireProjectPath: boolean;
  /** Host budget: refuse a `run_project` that would add a game beyond this many. 0 = off. */
  maxGames: number;
  /** `--max-fps` added to `background: true` runs. 0 = none. */
  backgroundMaxFps: number;
  /** `--audio-driver` added to `background: true` runs unless the call asks for audio. '' = none. */
  backgroundAudioDriver: string;
  /** Stop a spawned session after this many minutes without a completed call. 0 = off. */
  idleStopMinutes: number;
}

export const DEFAULT_SERVER_CONFIG: Readonly<ServerConfig> = Object.freeze({
  requireProjectPath: false,
  maxGames: 0,
  backgroundMaxFps: 0,
  backgroundAudioDriver: '',
  idleStopMinutes: 0,
});

const ENV_KEYS: Record<keyof ServerConfig, string> = {
  requireProjectPath: 'GODOT_MCP_REQUIRE_PROJECT_PATH',
  maxGames: 'GODOT_MCP_MAX_GAMES',
  backgroundMaxFps: 'GODOT_MCP_BACKGROUND_MAX_FPS',
  backgroundAudioDriver: 'GODOT_MCP_BACKGROUND_AUDIO_DRIVER',
  idleStopMinutes: 'GODOT_MCP_IDLE_STOP_MINUTES',
};

const INT_LIMITS: Partial<Record<keyof ServerConfig, [number, number]>> = {
  maxGames: [0, 64],
  backgroundMaxFps: [0, 1000],
  idleStopMinutes: [0, 24 * 60],
};

export interface LoadedServerConfig {
  config: ServerConfig;
  /** Where the file was read from, or null when none was found. */
  source: string | null;
  /** Problems found; each ignored key is named. The server still starts. */
  problems: string[];
}

function coerce(key: keyof ServerConfig, raw: unknown, from: string, problems: string[]): unknown {
  if (key === 'requireProjectPath') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    problems.push(`${from}: ${key} must be true or false; ignored`);
    return undefined;
  }
  if (key === 'backgroundAudioDriver') {
    if (typeof raw === 'string' && /^[A-Za-z0-9_-]{0,32}$/.test(raw)) return raw;
    problems.push(`${from}: ${key} must be a driver name; ignored`);
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  const [lo, hi] = INT_LIMITS[key] as [number, number];
  if (Number.isInteger(n) && n >= lo && n <= hi) return n;
  problems.push(`${from}: ${key} must be an integer from ${lo} to ${hi}; ignored`);
  return undefined;
}

/**
 * Pure: the caller supplies the environment and a file reader, so tests need
 * neither a disk nor process.env. `readFile` returns null for a missing file.
 */
export function loadServerConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string | null,
  defaultPath: string,
): LoadedServerConfig {
  const problems: string[] = [];
  const config: ServerConfig = { ...DEFAULT_SERVER_CONFIG };
  const path = env.GODOT_MCP_CONFIG || defaultPath;
  let source: string | null = null;

  const text = readFile(path);
  if (text !== null) {
    source = path;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`${path}: not valid JSON; the whole file is ignored`);
      parsed = null;
    }
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      problems.push(`${path}: must be a JSON object; the whole file is ignored`);
    } else if (parsed !== null) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (!(k in ENV_KEYS)) {
          problems.push(`${path}: unknown key "${k}"; ignored`);
          continue;
        }
        const value = coerce(k as keyof ServerConfig, v, path, problems);
        if (value !== undefined) (config as unknown as Record<string, unknown>)[k] = value;
      }
    }
  } else if (env.GODOT_MCP_CONFIG) {
    problems.push(`${path}: named by GODOT_MCP_CONFIG but not readable`);
  }

  for (const key of Object.keys(ENV_KEYS) as (keyof ServerConfig)[]) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined) continue;
    const value = coerce(key, raw, ENV_KEYS[key], problems);
    if (value !== undefined) (config as unknown as Record<string, unknown>)[key] = value;
  }

  return { config, source, problems };
}
