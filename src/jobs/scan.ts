import type { Pool } from "pg";
import type PgBoss from "pg-boss";
import type { ScanEngine } from "../types/supabase";

const SCAN_CONCURRENCY = Number(process.env.SCAN_CONCURRENCY) || 5;
import { OpenAIAdapter } from "../adapters/openai";
import { AnthropicAdapter } from "../adapters/anthropic";
import { PerplexityAdapter } from "../adapters/perplexity";
import type { EngineAdapter } from "../adapters/interface";
import {
  extractMentions,
  persistMentionResult,
  computeAndPersistVisibilityScore,
} from "./extraction";
import { maybeSendScanCompleteEmail } from "./notify";

export interface ScanJobData {
  brandId: string;
  queryId: string;
  queryText: string;
  engine: ScanEngine;
  comparisonGroupId?: string;
}

/**
 * Thrown for errors that should not be retried (e.g. unsupported engine, brand not found).
 * Callers (e.g. pg-boss handler in index.ts) must catch this and fail the job explicitly
 * instead of re-throwing, so pg-boss does not schedule additional retry attempts.
 */
export class NonRetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "NonRetryableError";
  }
}

const ENGINES: ScanEngine[] = ["chatgpt", "claude", "perplexity"];

function getAdapter(engine: ScanEngine): EngineAdapter {
  switch (engine) {
    case "chatgpt":
      return new OpenAIAdapter();
    case "claude":
      return new AnthropicAdapter();
    case "perplexity":
      return new PerplexityAdapter();
    default:
      // Unsupported engine is a config/data error — retrying won't help
      throw new NonRetryableError(`Unsupported engine: ${engine}`);
  }
}

export async function runScanJob(pool: Pool, data: ScanJobData): Promise<void> {
  const { brandId, queryId, queryText, engine, comparisonGroupId } = data;

  let adapter: EngineAdapter;
  try {
    adapter = getAdapter(engine);
  } catch (err) {
    // getAdapter only throws NonRetryableError — propagate as-is
    throw err;
  }

  console.log(`[scan] start engine=${engine} brand=${brandId} query=${queryId}`);

  let scanId: string | undefined;
  try {
    const rawResponse = await adapter.query(queryText);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO scans (brand_id, query_id, engine, raw_response, mention_found, comparison_group_id)
       VALUES ($1, $2, $3, $4, false, $5) RETURNING id`,
      [brandId, queryId, engine, rawResponse, comparisonGroupId ?? null],
    );
    scanId = rows[0].id;

    console.log(`[scan] stored engine=${engine} brand=${brandId} query=${queryId} scan=${scanId}`);

    // Fetch brand name + aliases for mention extraction
    const { rows: brandRows } = await pool.query<{ name: string; aliases: string[] }>(
      `SELECT name, aliases FROM brands WHERE id = $1`,
      [brandId],
    );

    if (brandRows.length === 0) {
      // Brand deleted between enqueue and execution — no point retrying
      throw new NonRetryableError(
        `Brand not found: ${brandId} — skipping extraction`,
      );
    }

    const { name, aliases } = brandRows[0];
    const mentionResult = extractMentions(name, aliases, rawResponse);
    await persistMentionResult(pool, scanId, brandId, mentionResult);
    console.log(
      `[scan] extraction done detected=${mentionResult.detected} type=${mentionResult.matchType} scan=${scanId}`,
    );

    // Recompute visibility score for this brand/query after each engine completes
    await computeAndPersistVisibilityScore(pool, brandId, queryId);
    console.log(`[scan] visibility score updated brand=${brandId} query=${queryId}`);

    // Send scan-completion email if all jobs for this brand are done (once per day)
    await maybeSendScanCompleteEmail(pool, brandId);
  } catch (err) {
    if (err instanceof NonRetryableError) {
      console.error("[scan] non-retryable error", {
        engine,
        brandId,
        queryId,
        scanId,
        error: err.message,
      });
      throw err;
    }

    const error = err instanceof Error ? err : new Error(String(err));
    console.error("[scan] retryable error", {
      engine,
      brandId,
      queryId,
      scanId,
      error: error.message,
      stack: error.stack,
    });
    // Re-throw so pg-boss retries the job
    throw error;
  }
}

/**
 * Picks up pending rows from the scan_requests table (inserted by the Next.js
 * trigger API) and runs the scan jobs directly with bounded concurrency.
 *
 * We deliberately do NOT route through pg-boss here because pg-boss requires a
 * persistent/direct database connection and will crash if the DATABASE_URL
 * points to a transaction pooler (e.g. Supabase Supavisor on port 6543).
 * Running jobs inline keeps the manual-scan path working regardless of the
 * connection type configured in Railway.
 */
export async function processManualScanRequests(pool: Pool): Promise<void> {
  // Atomically claim pending rows by updating status to 'processing'
  const { rows: requests } = await pool.query<{ id: string; brand_id: string }>(
    `UPDATE scan_requests
     SET status = 'processing'
     WHERE id IN (
       SELECT id FROM scan_requests WHERE status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, brand_id`,
  );

  if (requests.length === 0) return;

  for (const request of requests) {
    try {
      const { rows: queries } = await pool.query<{ id: string; query_text: string }>(
        `SELECT id, query_text FROM monitoring_queries
         WHERE brand_id = $1 AND is_active = true`,
        [request.brand_id],
      );

      // Build the full job list: all queries × all engines for this brand
      const jobs: ScanJobData[] = [];
      for (const query of queries) {
        for (const engine of ENGINES) {
          jobs.push({
            brandId: request.brand_id,
            queryId: query.id,
            queryText: query.query_text,
            engine,
          });
        }
      }

      // Run jobs with bounded concurrency using chunked Promise.allSettled
      let succeeded = 0;
      let failed = 0;
      for (let i = 0; i < jobs.length; i += SCAN_CONCURRENCY) {
        const chunk = jobs.slice(i, i + SCAN_CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map((jobData) => runScanJob(pool, jobData)),
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            succeeded++;
          } else {
            failed++;
            const error = result.reason instanceof Error
              ? result.reason
              : new Error(String(result.reason));
            console.error("[scan] job failed in manual scan_request", {
              requestId: request.id,
              brandId: request.brand_id,
              error: error.message,
            });
          }
        }
      }

      await pool.query(
        `UPDATE scan_requests SET status = 'done', processed_at = now() WHERE id = $1`,
        [request.id],
      );

      console.log(
        `[scan] processed scan_request ${request.id}: ${succeeded} succeeded, ${failed} failed`,
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[scan] error processing scan_request", {
        requestId: request.id,
        brandId: request.brand_id,
        error: error.message,
      });
      await pool.query(
        `UPDATE scan_requests SET status = 'failed', error_message = $2 WHERE id = $1`,
        [request.id, error.message],
      );
    }
  }
}

export async function enqueueScanJobs(pool: Pool, boss: PgBoss): Promise<number> {
  const { rows: brands } = await pool.query<{ id: string }>("SELECT id FROM brands");

  let count = 0;
  for (const brand of brands) {
    let queries: { id: string; query_text: string }[];
    try {
      const result = await pool.query<{ id: string; query_text: string }>(
        "SELECT id, query_text FROM monitoring_queries WHERE brand_id = $1 AND is_active = true",
        [brand.id],
      );
      queries = result.rows;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[scan] failed to fetch queries for brand", {
        brandId: brand.id,
        error: error.message,
        stack: error.stack,
      });
      continue;
    }

    for (const query of queries) {
      for (const engine of ENGINES) {
        const jobData: ScanJobData = {
          brandId: brand.id,
          queryId: query.id,
          queryText: query.query_text,
          engine,
        };
        try {
          await boss.send("scan", jobData);
          count++;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error("[scan] failed to enqueue job", {
            brandId: brand.id,
            queryId: query.id,
            engine,
            error: error.message,
            stack: error.stack,
          });
        }
      }
    }
  }

  return count;
}
