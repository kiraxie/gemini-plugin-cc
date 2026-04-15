/**
 * Unified Gemini client with automatic fallback.
 *
 * Route B (Code Assist API, cloudcode-pa.googleapis.com) is the primary path.
 * After 3 consecutive failures, degrades to Route A (standard API).
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

  constructor(private readonly auth: AuthResult, forceStandard = false) {
    // Code Assist requires an OAuth2Client
    if (auth.oauthClient && !forceStandard) {
      this.codeAssistClient = new CodeAssistClient(auth.oauthClient);
    }
    if (forceStandard) {
      this.degraded = true;
    }
    // Standard client works with any auth type
    this.standardClient = new StandardClient(auth);
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  async generateContent(params: GenerateContentParams): Promise<GenerateContentResponse> {
    if (!this.degraded && this.codeAssistClient) {
      try {
        const result = await this.codeAssistClient.generateContent(params);
        this.consecutiveFailures = 0;
        return result;
      } catch (err) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.degraded = true;
          progress(`Code Assist API failed ${MAX_CONSECUTIVE_FAILURES} times, falling back to standard API.`);
        } else {
          throw err;
        }
      }
    }

    // Fallback to standard client
    const fallbackParams = this.degraded
      ? { ...params, model: STANDARD_FALLBACK_MODEL }
      : params;
    return this.standardClient!.generateContent(fallbackParams);
  }

  async *generateContentStream(params: GenerateContentParams): AsyncGenerator<GenerateContentResponse> {
    if (!this.degraded && this.codeAssistClient) {
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
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.degraded = true;
          progress(`Code Assist API failed ${MAX_CONSECUTIVE_FAILURES} times, falling back to standard API.`);
        } else {
          throw err;
        }
      }
    }

    // Fallback to standard client
    const fallbackParams = this.degraded
      ? { ...params, model: STANDARD_FALLBACK_MODEL }
      : params;
    yield* this.standardClient!.generateContentStream(fallbackParams);
  }
}

function progress(message: string): void {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.error(`[${time}] ${message}`);
}
