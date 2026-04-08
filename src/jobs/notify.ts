import type { Pool } from "pg";

const ENGINES_COUNT = 3; // chatgpt, claude, perplexity

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderScanCompleteEmail(params: {
  brandName: string;
  visibilityScore: number | null;
  scanDate: string;
  appUrl: string;
}): string {
  const { brandName, visibilityScore, scanDate, appUrl } = params;
  const scoreText =
    visibilityScore !== null
      ? `<p style="font-size:32px;font-weight:700;color:#7c3aed;margin:0 0 4px;">${visibilityScore}<span style="font-size:18px;color:#6b7280;">/100</span></p>`
      : `<p style="font-size:32px;font-weight:700;color:#7c3aed;margin:0 0 4px;">—</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f9fafb;margin:0;padding:0;">
  <div style="width:100%;max-width:600px;margin:32px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
    <div style="background:#0f172a;padding:24px 32px;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600;">Scan Complete</h1>
      <p style="color:#94a3b8;margin:6px 0 0;font-size:13px;">${escapeHtml(scanDate)}</p>
    </div>
    <div style="padding:24px 32px;">
      <p style="font-size:15px;color:#374151;margin:0 0 20px;">
        Your scan for <strong>${escapeHtml(brandName)}</strong> has completed.
      </p>
      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
        <p style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">AI Visibility Score</p>
        ${scoreText}
        <p style="font-size:12px;color:#9ca3af;margin:0;">Based on latest scan results</p>
      </div>
      <div style="text-align:center;">
        <a href="${appUrl}/brands" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.01em;">View Full Report</a>
      </div>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e5e7eb;background:#f9fafb;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        You're receiving this because scan notifications are enabled.
        To unsubscribe, visit your
        <a href="${appUrl}/settings" style="color:#7c3aed;">account settings</a>.
      </p>
    </div>
  </div>
</body>
</html>`;
}

async function sendScanCompleteEmail(
  to: string,
  html: string,
  resendApiKey: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM_EMAIL ?? "OUTRANKgeo <notify@outrankgeo.com>",
      to,
      subject: "Your scan has completed",
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/**
 * Called after every individual scan job completes.
 * Checks whether all active query × engine combinations for the brand have scans
 * within the last 15 minutes. If so, sends one scan-completion email per brand per day.
 */
export async function maybeSendScanCompleteEmail(
  pool: Pool,
  brandId: string
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return;

  // Count expected scan slots vs completed ones in the last 15 minutes
  const { rows: countRows } = await pool.query<{
    expected: string;
    actual: string;
  }>(
    `SELECT
      (SELECT COUNT(*) FROM monitoring_queries WHERE brand_id = $1 AND is_active = true)
        * $2 AS expected,
      COUNT(DISTINCT (s.query_id::text || '|' || s.engine)) AS actual
    FROM scans s
    WHERE s.brand_id = $1
      AND s.scanned_at >= NOW() - INTERVAL '15 minutes'`,
    [brandId, ENGINES_COUNT]
  );

  const expected = Number(countRows[0]?.expected ?? 0);
  const actual = Number(countRows[0]?.actual ?? 0);

  if (expected === 0 || actual < expected) return;

  // Claim the notification slot for today — only one notification per brand per day
  const today = new Date().toISOString().slice(0, 10);
  const { rowCount } = await pool.query(
    `INSERT INTO scan_notifications_sent (brand_id, batch_date)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [brandId, today]
  );
  if (!rowCount) return; // already sent today

  // Fetch brand name and owner
  const { rows: brandRows } = await pool.query<{ name: string; owner_id: string }>(
    `SELECT name, owner_id FROM brands WHERE id = $1`,
    [brandId]
  );
  if (!brandRows.length) return;
  const { name: brandName, owner_id: ownerId } = brandRows[0];

  // Check notification preference (default true if no preference row)
  const { rows: prefRows } = await pool.query<{
    scan_notifications: boolean;
    email: string;
  }>(
    `SELECT up.scan_notifications, au.email
     FROM auth.users au
     LEFT JOIN user_preferences up ON up.user_id = au.id
     WHERE au.id = $1`,
    [ownerId]
  );
  if (!prefRows.length) return;

  const { scan_notifications, email } = prefRows[0];
  if (scan_notifications === false) return;
  if (!email) return;

  // Get latest visibility score for this brand
  const { rows: scoreRows } = await pool.query<{ score: number }>(
    `SELECT score FROM visibility_scores
     WHERE brand_id = $1
     ORDER BY scored_at DESC
     LIMIT 1`,
    [brandId]
  );
  const visibilityScore = scoreRows[0]?.score ?? null;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.geotool.app";
  const scanDate = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const html = renderScanCompleteEmail({ brandName, visibilityScore, scanDate, appUrl });

  try {
    await sendScanCompleteEmail(email, html, resendApiKey);
    console.log(`[notify] scan-complete email sent brand=${brandId} to=${email}`);
  } catch (err) {
    console.error(`[notify] failed to send scan-complete email brand=${brandId}:`, err);
  }
}
