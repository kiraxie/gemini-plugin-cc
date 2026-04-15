/**
 * Shared types for Gemini plugin.
 */

import type { OAuth2Client } from 'google-auth-library';

// ─── Auth ────────────────────────────────────────────────────────────────────

export type AuthType = 'oauth' | 'adc' | 'apikey';

export interface AuthResult {
  type: AuthType;
  /** OAuth2 client instance (available for 'oauth' and 'adc' types). */
  oauthClient?: OAuth2Client;
  /** Returns HTTP headers for authenticating a Gemini API request. */
  getHeaders: () => Promise<Record<string, string>>;
  /** API key value (only set for 'apikey' type). */
  apiKey?: string;
}

// ─── Code Assist API ─────────────────────────────────────────────────────────

export interface CAGenerateContentRequest {
  model: string;
  project?: string;
  user_prompt_id?: string;
  request: VertexGenerateContentRequest;
  enabled_credit_types?: string[];
}

export interface VertexGenerateContentRequest {
  contents: Content[];
  systemInstruction?: Content;
  tools?: Tool[];
  toolConfig?: ToolConfig;
  generationConfig?: VertexGenerationConfig;
}

export interface VertexGenerationConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  responseMimeType?: string;
  responseSchema?: unknown;
  thinkingConfig?: ThinkingConfig;
}

export interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: string; // 'HIGH' | 'MEDIUM' | 'LOW' etc.
}

export interface CaGenerateContentResponse {
  response?: {
    candidates?: Candidate[];
    usageMetadata?: UsageMetadata;
    modelVersion?: string;
  };
  traceId?: string;
}

// ─── Gemini API Common Types ─────────────────────────────────────────────────

export interface Content {
  role: string;
  parts: Part[];
}

export interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: { data: string; mimeType: string };
}

export interface FunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface FunctionResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema & { description?: string; items?: JsonSchema; minimum?: number }>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
}

export interface Tool {
  functionDeclarations?: FunctionDeclaration[];
}

export interface ToolConfig {
  functionCallingConfig?: {
    mode?: string;
  };
}

export interface Candidate {
  content: Content;
  finishReason?: string;
  index?: number;
}

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────

export interface AgentConfig {
  model: string;
  fallbackModel: string;
  systemPrompt: string;
  query: string;
  tools: FunctionDeclaration[];
  generationConfig: VertexGenerationConfig;
  maxTurns: number;
  maxTimeMs: number;
  outputSchema?: {
    outputName: string;
    description: string;
    schema: JsonSchema;
  };
  cwd: string;
}

export type TerminateReason = 'GOAL' | 'MAX_TURNS' | 'TIMEOUT' | 'ERROR';

export interface AgentResult {
  result: string;
  terminateReason: TerminateReason;
}

// ─── Unified Client Interface ────────────────────────────────────────────────

export interface GenerateContentParams {
  model: string;
  contents: Content[];
  systemInstruction?: Content;
  tools?: Tool[];
  toolConfig?: ToolConfig;
  generationConfig?: VertexGenerationConfig;
}

export interface GenerateContentResponse {
  candidates: Candidate[];
  usageMetadata?: UsageMetadata;
}

export interface GeminiClientInterface {
  generateContent(params: GenerateContentParams): Promise<GenerateContentResponse>;
  generateContentStream(params: GenerateContentParams): AsyncGenerator<GenerateContentResponse>;
}
