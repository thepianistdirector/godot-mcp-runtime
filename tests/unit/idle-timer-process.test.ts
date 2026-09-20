import { describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('automatic idle sweep in a real Node process', () => {
  it('contains refused stop rejection, reports it and keeps sibling cleanup alive', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'idle-timer-process-'));
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          '--unhandled-rejections=strict',
          fileURLToPath(new URL('../helpers/idle-timer-process.mjs', import.meta.url)),
          scratch,
        ],
        { timeout: 12000 },
      );
      expect(stdout).toContain('ARMED_REAL_IDLE_CALLBACK');
      expect(stdout).toContain('SERVER_SURVIVED_REFUSED_IDLE_STOP_WITH_SIBLING_CLEANED');
      expect(stderr).toContain('Could not confirm exit');
      expect(stderr).toContain('ownership is retained');
      expect(stderr).not.toContain('UnhandledPromiseRejection');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 15000);
});
