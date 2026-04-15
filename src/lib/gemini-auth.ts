/**
 * Authentication module for Gemini API access.
 *
 * Priority order:
 * 1. ~/.gemini/oauth_creds.json (Gemini CLI parity)
 * 2. GOOGLE_APPLICATION_CREDENTIALS / gcloud ADC
 * 3. GEMINI_API_KEY environment variable
 */

import { OAuth2Client, GoogleAuth } from 'google-auth-library';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AuthResult } from './types.js';

// Public OAuth client credentials for the Gemini CLI installed app.
// Per OAuth 2.0 spec for installed apps, these are intentionally not secret.
const OAUTH_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = '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';
const OAUTH_CREDS_PATH = join(homedir(), '.gemini', 'oauth_creds.json');

// Scopes matching the official Gemini CLI
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

/**
 * Creates an auth result by probing available credential sources in priority order.
 */
export async function createAuth(): Promise<AuthResult> {
  // Priority 1: Gemini CLI OAuth credentials file
  if (existsSync(OAUTH_CREDS_PATH)) {
    let credentials: Record<string, unknown>;
    try {
      credentials = JSON.parse(readFileSync(OAUTH_CREDS_PATH, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to parse ${OAUTH_CREDS_PATH}: ${String(err)}`);
    }

    const client = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);
    client.setCredentials(credentials);

    return {
      type: 'oauth',
      oauthClient: client,
      getHeaders: async () => {
        const response = await client.getAccessToken();
        if (!response.token) {
          throw new Error('OAuth token refresh failed: no access token returned');
        }
        return { Authorization: `Bearer ${response.token}` };
      },
    };
  }

  // Priority 2: Application Default Credentials (service account or gcloud ADC)
  try {
    const auth = new GoogleAuth({ scopes: OAUTH_SCOPES });
    const authClient = await auth.getClient();

    // Try to get an OAuth2Client if possible
    let oauthClient: OAuth2Client | undefined;
    if (authClient instanceof OAuth2Client) {
      oauthClient = authClient;
    }

    return {
      type: 'adc',
      oauthClient,
      getHeaders: async () => {
        const headers = await authClient.getRequestHeaders();
        return headers as Record<string, string>;
      },
    };
  } catch {
    // ADC not available; fall through to API key
  }

  // Priority 3: GEMINI_API_KEY environment variable
  const apiKey = process.env['GEMINI_API_KEY'];
  if (apiKey) {
    return {
      type: 'apikey',
      apiKey,
      getHeaders: async () => ({}),
    };
  }

  throw new Error(
    'No Gemini authentication found. ' +
      'Please run `gemini auth login`, set GOOGLE_APPLICATION_CREDENTIALS, or set GEMINI_API_KEY.',
  );
}
