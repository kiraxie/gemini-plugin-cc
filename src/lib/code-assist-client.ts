/**
 * Code Assist API client (Route B).
 *
 * Communicates with https://cloudcode-pa.googleapis.com — the same backend
 * used by the official Gemini CLI. This endpoint serves gemini-3 preview
 * models that are not available on the standard generativelanguage API.
 */

import type { OAuth2Client } from 'google-auth-library';
import { parseSSEStream } from './sse-parser.js';
import type {
  CAGenerateContentRequest,
  CaGenerateContentResponse,
  GenerateContentParams,
  GenerateContentResponse,
  GeminiClientInterface,
  VertexGenerateContentRequest,
} from './types.js';

const CODE_ASSIST_ENDPOINT =
  process.env['CODE_ASSIST_ENDPOINT'] ?? 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_API_VERSION =
  process.env['CODE_ASSIST_API_VERSION'] ?? 'v1internal';

function getBaseUrl(): string {
  return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}`;
}

function getMethodUrl(method: string): string {
  return `${getBaseUrl()}:${method}`;
}

// ─── Request / Response Converters ───────────────────────────────────────────

function toVertexRequest(params: GenerateContentParams): VertexGenerateContentRequest {
  // Code Assist API expects systemInstruction without role, or role 'user'
  const systemInstruction = params.systemInstruction
    ? { role: 'user' as const, parts: params.systemInstruction.parts }
    : undefined;

  return {
    contents: params.contents,
    systemInstruction,
    tools: params.tools,
    toolConfig: params.toolConfig,
    generationConfig: params.generationConfig,
  };
}

function toCARequest(
  params: GenerateContentParams,
  project?: string,
  enableCredits?: boolean,
): CAGenerateContentRequest {
  return {
    model: params.model,
    project,
    user_prompt_id: crypto.randomUUID(),
    request: toVertexRequest(params),
    // Enable paid credits (Google One AI) if user has a paid tier
    enabled_credit_types: enableCredits ? ['GOOGLE_ONE_AI'] : undefined,
  };
}

function fromCAResponse(res: CaGenerateContentResponse): GenerateContentResponse {
  const candidates = res.response?.candidates ?? [];
  return {
    candidates,
    usageMetadata: res.response?.usageMetadata,
  };
}

// ─── LoadCodeAssist types ────────────────────────────────────────────────────

interface LoadCodeAssistRequest {
  cloudaicompanionProject?: string;
  metadata: {
    ideType: string;
    platform: string;
    pluginType: string;
    duetProject?: string;
  };
}

interface LoadCodeAssistResponse {
  currentTier?: { id?: string; name?: string; hasOnboardedPreviously?: boolean };
  cloudaicompanionProject?: string;
  paidTier?: { id?: string; name?: string };
  allowedTiers?: Array<{ id?: string }>;
}

interface OnboardUserRequest {
  tierId?: string;
  cloudaicompanionProject?: string;
  metadata: {
    ideType: string;
    platform: string;
    pluginType: string;
  };
}

interface OnboardUserResponse {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: { id?: string };
    tier?: { id?: string };
  };
  name?: string;
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class CodeAssistClient implements GeminiClientInterface {
  private projectId?: string;
  private initialized = false;
  private hasPaidTier = false;

  constructor(private readonly oauthClient: OAuth2Client) {}

  /**
   * Initialize the client by calling loadCodeAssist to get the project ID.
   * This must be called before making generateContent requests.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const metadata = {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    };

    try {
      const loadRes = await this.post<LoadCodeAssistResponse>('loadCodeAssist', {
        cloudaicompanionProject: undefined,
        metadata,
      } satisfies LoadCodeAssistRequest);

      if (loadRes.cloudaicompanionProject) {
        this.projectId = loadRes.cloudaicompanionProject;
      }

      // Check for paid tier (enables higher quotas via GOOGLE_ONE_AI credits)
      if (loadRes.paidTier?.id || (loadRes.currentTier?.id && loadRes.currentTier.id !== 'free-tier')) {
        this.hasPaidTier = true;
      }

      // If user has a current tier, they're already onboarded
      if (loadRes.currentTier) {
        this.initialized = true;
        if (process.env['DEBUG']) {
          console.error(`[CodeAssist] Initialized. Project: ${this.projectId}, Tier: ${loadRes.paidTier?.id ?? loadRes.currentTier.id ?? 'unknown'}, PaidCredits: ${this.hasPaidTier}`);
        }
        return;
      }

      // Need to onboard — try free tier first
      const freeTier = loadRes.allowedTiers?.find(t => t.id === 'free-tier');
      const tierId = freeTier?.id ?? 'free-tier';

      const onboardRes = await this.post<OnboardUserResponse>('onboardUser', {
        tierId,
        cloudaicompanionProject: undefined,
        metadata,
      } satisfies OnboardUserRequest);

      // Poll for completion if needed
      if (onboardRes.name && !onboardRes.done) {
        for (let i = 0; i < 12; i++) { // max 60s
          await new Promise(r => setTimeout(r, 5000));
          const opRes = await this.get<OnboardUserResponse>(onboardRes.name);
          if (opRes.done) {
            if (opRes.response?.cloudaicompanionProject?.id) {
              this.projectId = opRes.response.cloudaicompanionProject.id;
            }
            break;
          }
        }
      } else if (onboardRes.response?.cloudaicompanionProject?.id) {
        this.projectId = onboardRes.response.cloudaicompanionProject.id;
      }

      this.initialized = true;
      if (process.env['DEBUG']) {
        console.error(`[CodeAssist] Onboarded. Project: ${this.projectId}`);
      }
    } catch (err) {
      // If setup fails, mark as initialized anyway — generateContent will fail with a clearer error
      this.initialized = true;
      if (process.env['DEBUG']) {
        console.error(`[CodeAssist] Init failed: ${(err as Error).message}`);
      }
    }
  }

  async generateContent(params: GenerateContentParams): Promise<GenerateContentResponse> {
    await this.init();
    const body = toCARequest(params, this.projectId, this.hasPaidTier);
    const res = await this.oauthClient.request<CaGenerateContentResponse>({
      url: getMethodUrl('generateContent'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      responseType: 'json',
      retryConfig: {
        retryDelay: 100,
        retry: 3,
        noResponseRetries: 3,
        statusCodesToRetry: [[429, 429], [499, 499], [500, 599]],
      },
    });
    return fromCAResponse(res.data);
  }

  async *generateContentStream(params: GenerateContentParams): AsyncGenerator<GenerateContentResponse> {
    await this.init();
    const body = toCARequest(params, this.projectId, this.hasPaidTier);
    if (process.env['DEBUG']) {
      console.error('[CodeAssist] Request URL:', getMethodUrl('streamGenerateContent'));
      console.error('[CodeAssist] Model:', body.model, '| Project:', body.project);
    }
    const res = await this.oauthClient.request<AsyncIterable<unknown>>({
      url: getMethodUrl('streamGenerateContent'),
      method: 'POST',
      params: { alt: 'sse' },
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      responseType: 'stream' as 'json',
      retry: false,
    });

    for await (const chunk of parseSSEStream<CaGenerateContentResponse>(res.data)) {
      yield fromCAResponse(chunk);
    }
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private async post<T>(method: string, body: object): Promise<T> {
    const res = await this.oauthClient.request<T>({
      url: getMethodUrl(method),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      responseType: 'json',
      retryConfig: {
        retryDelay: 100,
        retry: 3,
        noResponseRetries: 3,
        statusCodesToRetry: [[429, 429], [499, 499], [500, 599]],
      },
    });
    return res.data;
  }

  private async get<T>(name: string): Promise<T> {
    const res = await this.oauthClient.request<T>({
      url: `${getBaseUrl()}/${name}`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      responseType: 'json',
    });
    return res.data;
  }
}
