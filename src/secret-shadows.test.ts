import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { projectSecretShadows } from './secret-shadows.js';

describe('projectSecretShadows', () => {
  let root: string;
  let emptyDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-shadows-'));
    emptyDir = path.join(root, 'data', 'empty');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const shadowsFor = () =>
    projectSecretShadows(root, '/workspace/project', emptyDir);

  it('hides the live .env and every .env backup, not .env.example', () => {
    for (const file of ['.env', '.env.bak-1', '.env.local', '.env.example']) {
      fs.writeFileSync(path.join(root, file), 'X=1');
    }
    fs.writeFileSync(path.join(root, 'package.json'), '{}');

    const files = shadowsFor()
      .filter((s) => s.hostPath === '/dev/null')
      .map((s) => s.containerPath)
      .sort();

    expect(files).toEqual([
      '/workspace/project/.env',
      '/workspace/project/.env.bak-1',
      '/workspace/project/.env.local',
    ]);
  });

  it('hides secrets/ and data/env/ behind an empty directory', () => {
    fs.mkdirSync(path.join(root, 'secrets'));
    fs.mkdirSync(path.join(root, 'data', 'env'), { recursive: true });

    const dirs = shadowsFor().filter((s) => s.hostPath === emptyDir);

    expect(dirs.map((s) => s.containerPath).sort()).toEqual([
      '/workspace/project/data/env',
      '/workspace/project/secrets',
    ]);
    expect(fs.readdirSync(emptyDir)).toEqual([]);
  });

  it('adds nothing when there is no secret in the project root', () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# hi');
    expect(shadowsFor()).toEqual([]);
  });
});
