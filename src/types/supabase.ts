export type ScanEngine = "chatgpt" | "claude" | "gemini" | "perplexity";
export type ScanSentiment = "positive" | "neutral" | "negative";
export type QueryCategory = "discovery" | "comparison" | "recommendation";
export type PlanTier = "free" | "starter" | "growth";

export interface Brand {
  id: string;
  owner_id: string;
  name: string;
  domain: string | null;
  aliases: string[];
  plan_tier: PlanTier;
  created_at: string;
}

export interface MonitoringQuery {
  id: string;
  brand_id: string;
  query_text: string;
  category: QueryCategory;
  is_active: boolean;
  created_at: string;
}

export interface Scan {
  id: string;
  brand_id: string;
  query_id: string;
  engine: ScanEngine;
  raw_response: string;
  mention_found: boolean;
  mention_context: string | null;
  mention_rank: number | null;
  sentiment: ScanSentiment | null;
  scanned_at: string;
  comparison_group_id: string | null;
}

export interface ScanInsert {
  id?: string;
  brand_id: string;
  query_id: string;
  engine: ScanEngine;
  raw_response: string;
  mention_found?: boolean;
  mention_context?: string | null;
  mention_rank?: number | null;
  sentiment?: ScanSentiment | null;
  scanned_at?: string;
  comparison_group_id?: string | null;
}
