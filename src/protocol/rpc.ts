// JSON-RPC 2.0 framing: one UTF-8 JSON message per line (SPEC-0001 section 8).
import { z } from 'zod';

export const PROTOCOL_ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 };
export const APP_ERROR = -32000;

export const request = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().int(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type Request = z.infer<typeof request>;

export const response = z.union([
  z.object({ jsonrpc: z.literal('2.0'), id: z.number().int(), result: z.unknown() }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: z.number().int().nullable(),
    error: z.object({ code: z.number().int(), message: z.string() }),
  }),
]);
export type Response = z.infer<typeof response>;

// The first line of a relay connection. It proves that the caller can read the daemon token.
export const auth = z.object({ auth: z.string().min(16) });

export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

// Splits a byte stream into lines. Keeps a partial line until the next chunk.
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split('\n');
    this.rest = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0);
  }
}
