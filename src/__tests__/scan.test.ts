import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import type PgBoss from "pg-boss";
import { runScanJob, enqueueScanJobs, NonRetryableError } from "../jobs/scan";

// Mock the adapter constructors to avoid needing real API keys
vi.mock("../adapters/openai", () => ({
  OpenAIAdapter: vi.fn().mockImplementation(() => ({
    engine: "chatgpt",
    query: vi.fn().mockResolvedValue("OpenAI response about the brand"),
  })),
}));
vi.mock("../adapters/anthropic", () => ({
  AnthropicAdapter: vi.fn().mockImplementation(() => ({
    engine: "claude",
    query: vi.fn().mockResolvedValue("Claude response about the brand"),
  })),
}));
vi.mock("../adapters/perplexity", () => ({
  PerplexityAdapter: vi.fn().mockImplementation(() => ({
    engine: "perplexity",
    query: vi.fn().mockResolvedValue("Perplexity response about the brand"),
  })),
}));

function mockPool(
  overrides: Partial<{ query: (...args: unknown[]) => Promise<Partial<QueryResult>> }> = {}
): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    ...overrides,
  } as unknown as Pool;
}

function mockBoss(): PgBoss {
  return {
    send: vi.fn().mockResolvedValue("job-id"),
  } as unknown as PgBoss;
}

describe("runScanJob", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("queries the chatgpt adapter and inserts a scan result", async () => {
    const pool = mockPool({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "scan-1" }] })                          // INSERT INTO scans
        .mockResolvedValueOnce({ rows: [{ name: "Acme", aliases: [] }] })             // SELECT brand
        .mockResolvedValue({ rows: [] }),                                              // remaining calls
    });

    await runScanJob(pool, {
      brandId: "brand-1",
      queryId: "query-1",
      queryText: "What is the best CRM?",
      engine: "chatgpt",
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scans"),
      ["brand-1", "query-1", "chatgpt", expect.any(String), null]
    );
  });

  it("queries the claude adapter and inserts a scan result", async () => {
    const pool = mockPool({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "scan-1" }] })
        .mockResolvedValueOnce({ rows: [{ name: "Acme", aliases: [] }] })
        .mockResolvedValue({ rows: [] }),
    });

    await runScanJob(pool, {
      brandId: "brand-1",
      queryId: "query-1",
      queryText: "What is the best CRM?",
      engine: "claude",
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scans"),
      ["brand-1", "query-1", "claude", expect.any(String), null]
    );
  });

  it("queries the perplexity adapter and inserts a scan result", async () => {
    const pool = mockPool({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "scan-1" }] })
        .mockResolvedValueOnce({ rows: [{ name: "Acme", aliases: [] }] })
        .mockResolvedValue({ rows: [] }),
    });

    await runScanJob(pool, {
      brandId: "brand-1",
      queryId: "query-1",
      queryText: "What is the best CRM?",
      engine: "perplexity",
    });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO scans"),
      ["brand-1", "query-1", "perplexity", expect.any(String), null]
    );
  });

  it("re-throws adapter errors so pg-boss can retry", async () => {
    const { OpenAIAdapter } = await import("../adapters/openai");
    (OpenAIAdapter as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      engine: "chatgpt",
      query: vi.fn().mockRejectedValue(new Error("API rate limited")),
    }));

    const pool = mockPool();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runScanJob(pool, {
        brandId: "brand-1",
        queryId: "query-1",
        queryText: "test",
        engine: "chatgpt",
      })
    ).rejects.toThrow("API rate limited");

    // Structured log entry must be written before propagating
    expect(consoleSpy).toHaveBeenCalledWith(
      "[scan] retryable error",
      expect.objectContaining({
        engine: "chatgpt",
        brandId: "brand-1",
        queryId: "query-1",
        error: "API rate limited",
      }),
    );

    consoleSpy.mockRestore();
  });

  it("throws NonRetryableError when brand is not found after INSERT", async () => {
    const pool = mockPool({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "scan-1" }] }) // INSERT INTO scans
        .mockResolvedValueOnce({ rows: [] }),                  // SELECT brand — not found
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runScanJob(pool, {
        brandId: "brand-missing",
        queryId: "query-1",
        queryText: "test",
        engine: "chatgpt",
      })
    ).rejects.toBeInstanceOf(NonRetryableError);

    expect(consoleSpy).toHaveBeenCalledWith(
      "[scan] non-retryable error",
      expect.objectContaining({
        brandId: "brand-missing",
        error: expect.stringContaining("Brand not found"),
      }),
    );

    consoleSpy.mockRestore();
  });
});

describe("enqueueScanJobs", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("enqueues one job per brand × query × engine (3 engines)", async () => {
    const pool = mockPool({
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "brand-1" }, { id: "brand-2" }] }) // SELECT brands
        .mockResolvedValueOnce({
          rows: [{ id: "q-1", query_text: "best CRM?" }],
        }) // queries for brand-1
        .mockResolvedValueOnce({
          rows: [
            { id: "q-2", query_text: "top alternatives?" },
            { id: "q-3", query_text: "pricing comparison?" },
          ],
        }), // queries for brand-2
    });
    const boss = mockBoss();

    const count = await enqueueScanJobs(pool, boss);

    // brand-1: 1 query × 3 engines = 3; brand-2: 2 queries × 3 engines = 6; total = 9
    expect(count).toBe(9);
    expect(boss.send).toHaveBeenCalledTimes(9);
  });

  it("returns 0 when there are no brands", async () => {
    const pool = mockPool({
      query: vi.fn().mockResolvedValueOnce({ rows: [] }),
    });
    const boss = mockBoss();

    const count = await enqueueScanJobs(pool, boss);

    expect(count).toBe(0);
    expect(boss.send).not.toHaveBeenCalled();
  });

  it("logs and skips brands whose query fetch fails", async () => {
    const pool = mockPool({
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "brand-1" }, { id: "brand-2" }] }) // SELECT brands
        .mockRejectedValueOnce(new Error("DB connection lost"))                   // queries for brand-1
        .mockResolvedValueOnce({ rows: [{ id: "q-1", query_text: "test?" }] }),  // queries for brand-2
    });
    const boss = mockBoss();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const count = await enqueueScanJobs(pool, boss);

    // brand-1 skipped (error), brand-2: 1 query × 3 engines = 3
    expect(count).toBe(3);
    expect(consoleSpy).toHaveBeenCalledWith(
      "[scan] failed to fetch queries for brand",
      expect.objectContaining({ brandId: "brand-1", error: "DB connection lost" }),
    );

    consoleSpy.mockRestore();
  });
});
