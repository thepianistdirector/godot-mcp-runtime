import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('get_server_info through private production stdio', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'starts with a warning for inherited config key %s and preserves valid settings',
    async (key) => {
      const release = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '../..'));
      const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'server-config-boundary-')));
      const configPath = join(scratch, 'config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          requireProjectPath: true,
          maxGames: 10,
          [key]: 1,
          backgroundMaxFps: 60,
          backgroundAudioDriver: 'Dummy',
          idleStopMinutes: 30,
        }),
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(release, 'dist/index.js')],
        stderr: 'pipe',
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                entry[1] !== undefined && !entry[0].startsWith('GODOT_MCP_'),
            ),
          ),
          GODOT_MCP_CONFIG: configPath,
          GODOT_MCP_STATE_DIR: join(scratch, 'state'),
        },
      });
      let stderr = '';
      transport.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const client = new Client({ name: 'P1-config-boundary-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: 'get_server_info', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          requireProjectPath: true,
          maxGames: 10,
          backgroundMaxFps: 60,
          backgroundAudioDriver: 'Dummy',
          idleStopMinutes: 30,
          live: 0,
          launching: 0,
        });
        expect(stderr).toContain(`unknown key "${key}"; ignored`);
        expect(stderr).not.toContain('TypeError');
      } finally {
        await client.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  it('discovers the read-only tool and reports effective config and resolved release', async () => {
    const release = realpathSync.native(join(dirname(fileURLToPath(import.meta.url)), '../..'));
    const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'server-info-')));
    const alias = join(scratch, 'release-alias');
    symlinkSync(release, alias, 'dir');
    const configPath = join(scratch, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        requireProjectPath: true,
        maxGames: 8,
        backgroundMaxFps: 30,
        backgroundAudioDriver: 'Dummy',
        idleStopMinutes: 60,
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(alias, 'dist/index.js')],
      stderr: 'pipe',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[1] !== undefined && !entry[0].startsWith('GODOT_MCP_'),
          ),
        ),
        GODOT_MCP_CONFIG: configPath,
        GODOT_MCP_STATE_DIR: join(scratch, 'state'),
        GODOT_MCP_MAX_GAMES: '3',
        GODOT_MCP_BACKGROUND_MAX_FPS: '60',
        P1_TEST_NONPUBLIC: 'do-not-expose-this-fixture-value',
      },
    });
    const client = new Client({ name: 'P1-server-info-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.find((t) => t.name === 'get_server_info')?.annotations?.readOnlyHint).toBe(
        true,
      );
      const result = await client.callTool({ name: 'get_server_info', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        version: JSON.parse(readFileSync(join(release, 'package.json'), 'utf8')).version,
        releasePath: release,
        requireProjectPath: true,
        maxGames: 3,
        backgroundMaxFps: 60,
        backgroundAudioDriver: 'Dummy',
        idleStopMinutes: 60,
        live: 0,
        launching: 0,
      });
      expect(JSON.stringify(result)).not.toContain('do-not-expose-this-fixture-value');
    } finally {
      await client.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 20000);
});
