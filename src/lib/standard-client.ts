/**
 * Standard Gemini API client (Route A fallback).
 *
 * Uses the generativelanguage.googleapis.com endpoint.
 * Only has access to gemini-2.5 models (no gemini-3 preview).
 */

import type {
  AuthResult,
  CaGenerateContentResponse,
  Content,
  GenerateContentParams,
  GenerateContentResponse,
  GeminiClientInterface,
  Part,
} from './types.js';
import { parseSSEStream } from './sse-parser.js';

/** Default fallback model when Code Assist API is unavailable. */
export const STANDARD_FALLBACK_MODEL = 'gemini-2.5-flash';

const STANDARD_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

// ─── Client ──────────────────────────────────────────────────────────────────

export class StandardClient implements GeminiClientInterface {
  constructor(private readonly auth: AuthResult) {}

  private getUrl(model: string, method: string): string {
    const base = `${STANDARD_ENDPOINT}/models/${model}:${method}`;
    if (this.auth.apiKey) {
      return `${base}?key=${this.auth.apiKey}`;
    }
    return base;
  }

  private async getHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!this.auth.apiKey) {
      const authHeaders = await this.auth.getHeaders();
      Object.assign(headers, authHeaders);
    }
    return headers;
  }

  private buildBody(params: GenerateContentParams): Record<string, unknown> {
    return {
      contents: params.contents,
      systemInstruction: params.systemInstruction,
      tools: params.tools,
      toolConfig: params.toolConfig,
      generationConfig: {
        temperature: params.generationConfig?.temperature,
        topP: params.generationConfig?.topP,
        maxOutputTokens: params.generationConfig?.maxOutputTokens,
        thinkingConfig: params.generationConfig?.thinkingConfig
          ? {
              includeThoughts: params.generationConfig.thinkingConfig.includeThoughts,
              thinkingBudget: params.generationConfig.thinkingConfig.thinkingBudget,
            }
          : undefined,
      },
    };
  }

  async generateContent(params: GenerateContentParams): Promise<GenerateContentResponse> {
    const url = this.getUrl(params.model, 'generateContent');
    const headers = await this.getHeaders();
    const body = this.buildBody(params);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Standard API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json() as { candidates?: Array<{ content: Content }> };
    return {
      candidates: data.candidates ?? [],
    };
  }

  async *generateContentStream(params: GenerateContentParams): AsyncGenerator<GenerateContentResponse> {
    const url = this.getUrl(params.model, 'streamGenerateContent') + (this.auth.apiKey ? '&alt=sse' : '?alt=sse');
    const headers = await this.getHeaders();
    const body = this.buildBody(params);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Standard API error ${res.status}: ${text.slice(0, 500)}`);
    }

    if (!res.body) {
      throw new Error('No response body for streaming request');
    }

    // Parse SSE stream — standard API returns same format as Code Assist
    for await (const chunk of parseSSEStream<{ candidates?: Array<{ content: Content }> }>(res.body)) {
      yield {
        candidates: chunk.candidates ?? [],
      };
    }
  }
}
