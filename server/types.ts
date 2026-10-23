/**
 * Internal server-side types for usage adapters. Never imported by client code.
 */

export interface RawUsageRow {
  backend: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Unique session identifier within the backend; used for session counts. */
  sessionId: string;
  /** Epoch milliseconds. */
  timeCreated: number;
}

export type AdapterStatus = "ok" | "no_data_source" | "error";

export interface AdapterResult {
  backend: string;
  status: AdapterStatus;
  detail?: string;
  rows: RawUsageRow[];
}

/**
 * UsageAdapter contract. One adapter per backend; every usage row comes from
 * exactly one adapter so totals never double-count.
 */
export interface UsageAdapter {
  backend: string;
  /** Read-only collection. Must never write to the data source. */
  collect(): Promise<AdapterResult>;
}
