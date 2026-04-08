import PgBoss from "pg-boss";
import { getPool } from "./db";
import { runScanJob, enqueueScanJobs, processManualScanRequests, NonRetryableError, type ScanJobData } from "./jobs/scan";
import { runDigestJob } from "./jobs/digest";

const SCAN_CRON = process.env.SCAN_CRON ?? "0 2 * * *";
const DIGEST_CRON = process.env.DIGEST_CRON ?? "0 9 * * *"; // 9am UTC daily

async function main(): Promise<void> {
  const pool = getPool();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const boss = new PgBoss({ connectionString: databaseUrl });

  boss.on("error", (err: Error) => console.error("[pg-boss] error:", err));

  await boss.start();
  console.log("[worker] pg-boss started");

  // Register scan job worker — processes individual (brand, query, engine) triples
  await boss.work<ScanJobData>("scan", { teamSize: 5, teamConcurrency: 5 }, async (job) => {
    try {
      await runScanJob(pool, job.data);
    } catch (err) {
      if (err instanceof NonRetryableError) {
        // Explicitly fail without retry — pg-boss retries on throw, so we swallow
        // and call fail() to record the error state without scheduling retries.
        await boss.fail(job.id, err);
        return;
      }
      throw err;
    }
  });

  // Schedule daily cron — fans out scan jobs for every brand × query × engine
  await boss.schedule("scan-cron", SCAN_CRON, {});
  await boss.work("scan-cron", async () => {
    const count = await enqueueScanJobs(pool, boss);
    console.log(`[worker] enqueued ${count} scan jobs`);
  });

  // Schedule daily digest — sends visibility summary emails at 9am UTC
  await boss.schedule("digest-cron", DIGEST_CRON, {});
  await boss.work("digest-cron", async () => {
    await runDigestJob(pool);
  });

  // Poll for manual scan_requests every 30 seconds
  const MANUAL_SCAN_POLL_MS = 30_000;
  const pollManualScans = async () => {
    try {
      await processManualScanRequests(pool, boss);
    } catch (err) {
      console.error("[worker] error polling manual scan requests:", err);
    }
  };
  await pollManualScans(); // run immediately on startup
  const manualScanInterval = setInterval(pollManualScans, MANUAL_SCAN_POLL_MS);

  console.log(`[worker] scan cron scheduled (${SCAN_CRON})`);
  console.log(`[worker] digest cron scheduled (${DIGEST_CRON})`);
  console.log("[worker] ready, polling scan_requests every 30s");

  process.on("SIGTERM", async () => {
    console.log("[worker] shutting down...");
    clearInterval(manualScanInterval);
    await boss.stop({ graceful: true });
    await pool.end();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
