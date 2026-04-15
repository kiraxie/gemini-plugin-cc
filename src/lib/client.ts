/**
 * Unified Gemini client with automatic fallback.
 *
 * Route B (Code Assist API, cloudcode-pa.googleapis.com) is the primary path.
 * For non-OAuth users (API key only), falls back to Route A (standard API)
 * after consecutive failures.
 *
 * For OAuth users, always stays on Code Assist API — the standard API
 * does not accept OAuth scopes from `gemini auth login`.
 */

import type {
  AuthResult,
  GenerateContentParams,
  GenerateContentResponse,
  GeminiClientInterface,
} from './types.js';
import { CodeAssistClient } from './code-assist-client.js';
import { StandardClient, STANDARD_FALLBACK_MODEL } from './standard-client.js';

const MAX_CONSECUTIVE_FAILURES = 3;

export class GeminiClient implements GeminiClientInterface {
  private codeAssistClient?: CodeAssistClient;
  private standardClient?: StandardClient;
  private consecutiveFailures = 0;
  private degraded = false;
  private readonly isOAuthUser: boolean;

  constructor(private readonly auth: AuthResult, forceStandard = false) {
    this.isOAuthUser = auth.type === 'oauth' || auth.type === 'adc';

    if (auth.oauthClient && !forceStandard) {
      this.codeAssistClient = new CodeAssistClient(auth.oauthClient);
    }
    if (forceStandard) {
      this.degraded = true;
    }
    // Standard client only useful for API key users
    if (!this.isOAuthUser) {
      this.standardClient = new StandardClient(auth);
    }
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  async generateContent(params: GenerateContentParams): Promise<GenerateContentResponse> {
    if (this.codeAssistClient && !this.degraded) {
      try {
        const result = await this.codeAssistClient.generateContent(params);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        // For OAuth users: re-throw (let caller handle rate limits/errors)
        // Only degrade to standard API for API key users
        if (this.isOAuthUser) {
          throw err;
        }
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.degraded = true;
          progress(`Code Assist API failed ${MAX_CONSECUTIVE_FAILURES} times, falling back to standard API.`);
        } else {
          throw err;
        }
      }
    }

    if (!this.standardClient) {
      throw new Error('No available API client. Code Assist API failed and standard API is not available for OAuth users.');
    }

    const fallbackParams = this.degraded
      ? { ...params, model: STANDARD_FALLBACK_MODEL }
      : params;
    return this.standardClient.generateContent(fallbackParams);
  }

  async *generateContentStream(params: GenerateContentParams): AsyncGenerator<GenerateContentResponse> {
    if (this.codeAssistClient && !this.degraded) {
      try {
        const stream = this.codeAssistClient.generateContentStream(params);
        let firstChunkReceived = false;
        for await (const chunk of stream) {
          firstChunkReceived = true;
          yield chunk;
        }
        if (firstChunkReceived) {
          this.consecutiveFailures = 0;
        }
        return;
      } catch (err) {
        if (this.isOAuthUser) {
          throw err;
        }
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.degraded = true;
          progress(`Code Assist API failed ${MAX_CONSECUTIVE_FAILURES} times, falling back to standard API.`);
        } else {
          throw err;
        }
      }
    }

    if (!this.standardClient) {
      throw new Error('No available API client. Code Assist API failed and standard API is not available for OAuth users.');
    }

    const fallbackParams = this.degraded
      ? { ...params, model: STANDARD_FALLBACK_MODEL }
      : params;
    yield* this.standardClient.generateContentStream(fallbackParams);
  }
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
