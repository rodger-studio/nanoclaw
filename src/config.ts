import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'USER_REPORTS_CHANNEL_ID',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
// Slack channel ID (e.g. C0AR3DSAVSL) where app/bot user reports land. Every
// new top-level bot post there is auto-triaged by the agent in its thread.
// Unset disables the feature.
export const USER_REPORTS_CHANNEL_ID =
  process.env.USER_REPORTS_CHANNEL_ID ||
  envConfig.USER_REPORTS_CHANNEL_ID ||
  undefined;
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts.
// HOST_PROJECT_ROOT overrides process.cwd() for Docker volume mount paths
// when NanoClaw itself runs inside a container (sibling container pattern).
const PROJECT_ROOT = process.cwd();
const HOST_PROJECT_ROOT = process.env.HOST_PROJECT_ROOT || PROJECT_ROOT;
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Host-side paths for Docker volume mounts (sibling container pattern).
// When NanoClaw runs inside a container, these resolve to the host filesystem
// paths that Docker needs for bind-mounting into agent containers.
export const HOST_GROUPS_DIR = path.resolve(HOST_PROJECT_ROOT, 'groups');
export const HOST_DATA_DIR = path.resolve(HOST_PROJECT_ROOT, 'data');
export const HOST_PROJECT_DIR = HOST_PROJECT_ROOT;

export const INSTANCE_NAME = process.env.INSTANCE_NAME || 'nanoclaw';
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || `${INSTANCE_NAME}-agent:latest`;
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const SESSION_MAX_AGE_DAYS = parseInt(
  process.env.SESSION_MAX_AGE_DAYS || '7',
  10,
); // Auto-rotate sessions older than this to prevent context rot
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
