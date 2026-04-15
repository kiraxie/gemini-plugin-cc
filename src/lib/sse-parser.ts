/**
 * Server-Sent Events (SSE) stream parser.
 *
 * Parses a Node.js Readable stream of SSE data into typed JSON objects.
 * Follows the same logic as Gemini CLI's CodeAssistServer.requestStreamingPost.
 */

import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

/**
 * Parses an SSE stream, yielding parsed JSON objects for each `data:` message.
 *
 * SSE format:
 *   data: {"key": "value"}
 *   data: (continuation line)
 *
 *   (empty line = message delimiter)
 */
export async function* parseSSEStream<T>(stream: AsyncIterable<unknown>): AsyncGenerator<T> {
  const rl = createInterface({
    input: Readable.from(stream),
    crlfDelay: Infinity,
  });

  let bufferedLines: string[] = [];

  for await (const line of rl) {
    const lineStr = typeof line === 'string' ? line : String(line);

    if (lineStr.startsWith('data: ')) {
      bufferedLines.push(lineStr.slice(6).trim());
    } else if (lineStr === '') {
      if (bufferedLines.length === 0) {
        continue;
      }
      const chunk = bufferedLines.join('\n');
      try {
        yield JSON.parse(chunk) as T;
      } catch {
        // Silently ignore malformed chunks (matches Gemini CLI behavior)
      }
      bufferedLines = [];
    }
    // Ignore other lines (comments starting with ':', id fields, etc.)
  }
}
