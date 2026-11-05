/**
 * GitHub App token generator.
 * Generates short-lived installation tokens from GitHub App credentials,
 * replacing static Personal Access Tokens for better security.
 */
import crypto from 'crypto';
import fs from 'fs';

import { readEnvFile } from './env.js';

const env = readEnvFile([
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
]);

const APP_ID = process.env.GITHUB_APP_ID || env.GITHUB_APP_ID;
const INSTALLATION_ID =
  process.env.GITHUB_APP_INSTALLATION_ID || env.GITHUB_APP_INSTALLATION_ID;
const PRIVATE_KEY_PATH =
  process.env.GITHUB_APP_PRIVATE_KEY_PATH || env.GITHUB_APP_PRIVATE_KEY_PATH;

// Cached token and its expiry
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function createJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: APP_ID, iat: now - 60, exp: now + 600 }),
  ).toString('base64url');

  const privateKey = fs.readFileSync(PRIVATE_KEY_PATH!, 'utf8');
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(privateKey, 'base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * Returns a fresh GitHub installation token, or null if GitHub App is not configured.
 * Caches the token and refreshes it 5 minutes before expiry.
 */
export async function getGitHubToken(): Promise<string | null> {
  if (!APP_ID || !INSTALLATION_ID || !PRIVATE_KEY_PATH) return null;

  // Return cached token if still valid (with 5-minute buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const jwt = createJWT();
  const res = await fetch(
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(
      `[github-app] Failed to get installation token: ${res.status} ${body}`,
    );
    return null;
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = data.token;
  tokenExpiresAt = new Date(data.expires_at).getTime();

  console.log(
    `[github-app] Installation token refreshed, expires ${data.expires_at}`,
  );
  return cachedToken;
}
