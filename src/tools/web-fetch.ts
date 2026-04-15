/**
 * web_fetch tool — fetches content from URLs.
 *
 * Simplified version: HTTP fetch + basic HTML-to-text conversion.
 * Does not use the Google proprietary web-fetch model.
 */

import type { FunctionDeclaration } from '../lib/types.js';

const URL_FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_LENGTH = 250_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; GeminiPlugin/1.0)';

export const webFetchDeclaration: FunctionDeclaration = {
  name: 'web_fetch',
  description:
    'Fetches content from URL(s) embedded in a prompt. Include up to 20 URLs and instructions ' +
    '(e.g., summarize, extract specific data) directly in the prompt parameter.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'A comprehensive prompt that includes the URL(s) (up to 20) to fetch and specific instructions ' +
          'on how to process their content. All URLs must start with "http://" or "https://".',
      },
    },
    required: ['prompt'],
  },
};

function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  return [...new Set(text.match(urlRegex) ?? [])];
}

function stripHtml(html: string): string {
  return html
    // Remove scripts and styles
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Convert common block elements to newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n\n... [Content truncated due to size limit] ...';
}

async function fetchUrl(url: string): Promise<{ url: string; content: string } | { url: string; error: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { url, error: `HTTP ${response.status} ${response.statusText}` };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    let content: string;
    if (contentType.includes('text/html')) {
      content = stripHtml(text);
    } else {
      content = text;
    }

    return { url, content: truncate(content, MAX_CONTENT_LENGTH) };
  } catch (err) {
    return { url, error: (err as Error).message };
  }
}

export async function executeWebFetch(
  args: Record<string, unknown>,
  _cwd: string,
): Promise<string> {
  const prompt = String(args['prompt'] ?? '');
  if (!prompt) {
    return 'Error: prompt is required.';
  }

  const urls = extractUrls(prompt).slice(0, 20);
  if (urls.length === 0) {
    return 'Error: No valid URLs found in the prompt. URLs must start with http:// or https://.';
  }

  const results = await Promise.all(urls.map(fetchUrl));

  const parts: string[] = [];
  for (const result of results) {
    if ('error' in result) {
      parts.push(`<source url="${result.url}">\nError: ${result.error}\n</source>`);
    } else {
      parts.push(`<source url="${result.url}">\n${result.content}\n</source>`);
    }
  }

  return `Fetched ${urls.length} URL(s):\n\n${parts.join('\n\n')}`;
}
