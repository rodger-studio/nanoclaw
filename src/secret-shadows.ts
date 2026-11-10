import fs from 'fs';
import path from 'path';

/**
 * Secrets that live inside the project root, which the main group mounts
 * read-only at /workspace/project. Each one is covered by an empty mount so
 * the agent cannot read it:
 * - every root-level `.env*` file (the live .env and any `.env.bak-*` copy),
 *   except `.env.example`;
 * - `secrets/` (GitHub App private key) and `data/env/` (legacy env copy).
 */
const SECRET_DIRS = ['secrets', path.join('data', 'env')];
const PUBLIC_ENV_FILES = new Set(['.env.example']);

export interface ShadowMount {
  /** Path on this machine (not yet mapped to the Docker host). */
  hostPath: string;
  containerPath: string;
}

export function projectSecretShadows(
  projectRoot: string,
  containerRoot: string,
  emptyDir: string,
): ShadowMount[] {
  const shadows: ShadowMount[] = [];

  for (const entry of fs.readdirSync(projectRoot)) {
    if (!entry.startsWith('.env') || PUBLIC_ENV_FILES.has(entry)) continue;
    if (!fs.statSync(path.join(projectRoot, entry)).isFile()) continue;
    shadows.push({
      hostPath: '/dev/null',
      containerPath: path.posix.join(containerRoot, entry),
    });
  }

  for (const dir of SECRET_DIRS) {
    if (!fs.existsSync(path.join(projectRoot, dir))) continue;
    fs.mkdirSync(emptyDir, { recursive: true });
    shadows.push({
      hostPath: emptyDir,
      containerPath: path.posix.join(containerRoot, ...dir.split(path.sep)),
    });
  }

  return shadows;
}
