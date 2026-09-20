import { describe, it, expect } from 'vitest';
import { DEFAULT_SERVER_CONFIG, loadServerConfig } from '../../src/utils/server-config.js';

const none = () => null;

describe('loadServerConfig', () => {
  it('a missing file is upstream behaviour, with no complaint', () => {
    const out = loadServerConfig({}, none, '/pkg/godot-mcp.config.json');
    expect(out).toEqual({ config: { ...DEFAULT_SERVER_CONFIG }, source: null, problems: [] });
  });

  it('reads the file beside the build', () => {
    const file = JSON.stringify({
      requireProjectPath: true,
      maxGames: 6,
      backgroundMaxFps: 60,
      backgroundAudioDriver: 'Dummy',
      idleStopMinutes: 60,
    });
    const out = loadServerConfig({}, (p) => (p === '/pkg/c.json' ? file : null), '/pkg/c.json');
    expect(out.source).toBe('/pkg/c.json');
    expect(out.problems).toEqual([]);
    expect(out.config).toEqual({
      requireProjectPath: true,
      maxGames: 6,
      backgroundMaxFps: 60,
      backgroundAudioDriver: 'Dummy',
      idleStopMinutes: 60,
    });
  });

  it('an environment variable overrides a key, and GODOT_MCP_CONFIG names another file', () => {
    const out = loadServerConfig(
      { GODOT_MCP_CONFIG: '/elsewhere.json', GODOT_MCP_MAX_GAMES: '3' },
      (p) => (p === '/elsewhere.json' ? '{"maxGames": 9, "requireProjectPath": true}' : null),
      '/pkg/c.json',
    );
    expect(out.config.maxGames).toBe(3);
    expect(out.config.requireProjectPath).toBe(true);
  });

  it('a wrong type or an unknown key is named and ignored; the rest still loads', () => {
    const out = loadServerConfig(
      {},
      () => '{"maxGames": "many", "idleStopMinutes": 30, "disableSecurity": true}',
      '/pkg/c.json',
    );
    expect(out.config.maxGames).toBe(0);
    expect(out.config.idleStopMinutes).toBe(30);
    expect(out.problems.length).toBe(2);
    expect(out.problems.join('\n')).toMatch(/maxGames/);
    expect(out.problems.join('\n')).toMatch(/unknown key "disableSecurity"/);
  });

  it('the security switches cannot be set from the file', () => {
    const out = loadServerConfig(
      {},
      () => '{"GODOT_MCP_DISABLE_SECURITY": true, "strictMode": false}',
      '/pkg/c.json',
    );
    expect(out.config).toEqual({ ...DEFAULT_SERVER_CONFIG });
    expect(out.problems.length).toBe(2);
  });

  it('broken JSON ignores the whole file and says so', () => {
    const out = loadServerConfig({}, () => '{nope', '/pkg/c.json');
    expect(out.config).toEqual({ ...DEFAULT_SERVER_CONFIG });
    expect(out.problems[0]).toMatch(/not valid JSON/);
  });

  it('a driver name with shell characters is refused', () => {
    const out = loadServerConfig(
      { GODOT_MCP_BACKGROUND_AUDIO_DRIVER: 'Dummy; rm -rf /' },
      none,
      '/x',
    );
    expect(out.config.backgroundAudioDriver).toBe('');
    expect(out.problems.length).toBe(1);
  });
});
