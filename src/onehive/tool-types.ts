import type { OneHiveToolResult } from './schemas.js';

/**
 * Neutral tool definition contract shared by domain tools, the Pi adapter, and
 * the Honey CLI. This intentionally contains no Pi runtime/UI types.
 */
export type ToolDefinition<TInput, TOutput> = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(input: TInput): Promise<OneHiveToolResult<TOutput>>;
};
