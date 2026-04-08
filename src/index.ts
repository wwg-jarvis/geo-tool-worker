import PgBoss from "pg-boss";
import { getPool } from "./db";
import { runScanJob, enqueueScanJobs, processManualScanRequests, NonRetryableError, type ScanJobData } from "./jobs/scan";
import { runDigestJob } from "./jobs/digest";

const SCAN_CRON = process.env.SCAN_CRON ?? "0 2 * * *";
const DIGEST_CRON = process.env.DIGEST_CRON ?? "0 9 * * *"; // 9am UTC daily
const MANUAL_SCAN_POLL_MS = 30_000;

async function main(): Promise<void> {
  const pool = getPool();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  // Attempt to start pg-boss for the scheduled daily cron jobs.
  // pg-boss requires a persistent/direct connection and will fail if DATABASE_URL
  // points to a transaction pooler (e.g. Supabase Supavisor port 6543).
  // This is intentionally non-fatal: manual scan_requests polling runs regardless.
  let boss: PgBoss | null = null;
  try {
    boss = new PgBoss({ connectionString: databaseUrl });
    boss.on("error", (err: Error) => console.error("[pg-boss] error:", err));
    await boss.start();
    console.log("[worker] pg-boss started");

    // Register scan job worker — processes individual (brand, query, engine) triples
    await boss.work<ScanJobData>("scan", { teamSize: 5, teamConcurrency: 5 }, async (job) => {
      try {
        await runScanJob(pool, job.data);
      } catch (err) {
        if (err instanceof NonRetryableError) {
          await boss!.fail(job.id, err);
          return;
        }
        throw err;
      }
    });

    // Schedule daily cron — fans out scan jobs for every brand × query × engine
    await boss.schedule("scan-cron", SCAN_CRON, {});
    await boss.work("scan-cron", async () => {
      const count = await enqueueScanJobs(pool, boss!);
      console.log(`[worker] enqueued ${count} scan jobs`);
    });

    // Schedule daily digest — sends visibility summary emails at 9am UTC
    await boss.schedule("digest-cron", DIGEST_CRON, {});
    await boss.work("digest-cron", async () => {
      await runDigestJob(pool);
    });

    console.log(`[worker] scan cron scheduled (${SCAN_CRON})`);
    console.log(`[worker] digest cron scheduled (${DIGEST_CRON})`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(
      "[worker] pg-boss failed to start — scheduled cron jobs are disabled.",
      "Check that DATABASE_URL is a direct connection or session pooler (not a transaction pooler).",
      { error: error.message },
    );
    boss = null;
  }

  // Poll for manual scan_requests every 30 seconds using recursive setTimeout
  // to prevent overlapping invocations when a poll takes longer than the interval.
  const scheduleNextPoll = () => {
    setTimeout(async () => {
      try {
        await processManualScanRequests(pool);
      } catch (err) {
        console.error("[worker] error polling manual scan requests:", err);
      }
      scheduleNextPoll();
    }, MANUAL_SCAN_POLL_MS);
  };

  // Run immediately on startup, then schedule recurring polls
  try {
    await processManualScanRequests(pool);
  } catch (err) {
    console.error("[worker] error on initial manual scan poll:", err);
  }
  scheduleNextPoll();

  console.log("[worker] ready, polling scan_requests every 30s");

  process.on("SIGTERM", async () => {
    console.log("[worker] shutting down...");
    if (boss) await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
