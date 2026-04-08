import { Pool } from "pg";

interface BrandSummary {
  brandId: string;
  brandName: string;
  recentMentions: number;
  recentScans: number;
}

interface DigestRecipient {
  userId: string;
  email: string;
}

function renderDigestEmail(
  recipientEmail: string,
  brands: BrandSummary[],
  appUrl: string
): string {
  const brandRows = brands
    .map(
      (b) => `
    <tr style="border-bottom:1px solid #e5e7eb;">
      <td style="padding:10px 12px;font-size:14px;">${escapeHtml(b.brandName)}</td>
      <td style="padding:10px 12px;font-size:14px;text-align:center;">${b.recentScans}</td>
      <td style="padding:10px 12px;font-size:14px;text-align:center;">${b.recentMentions}</td>
    </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f9fafb;margin:0;padding:0;">
  <div style="width:100%;max-width:600px;margin:32px auto;background:#fff;border-radius:8px;border:1px solid #e5e7eb;overflow:hidden;">
    <div style="background:#0f172a;padding:24px 32px;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:600;">OUTRANKgeo — Daily Digest</h1>
      <p style="color:#94a3b8;margin:6px 0 0;font-size:13px;">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
    </div>
    <div style="padding:24px 32px;">
      <p style="font-size:15px;color:#374151;margin:0 0 20px;">Here's your AI visibility summary for the past 24 hours.</p>
      ${
        brands.length === 0
          ? `<p style="font-size:14px;color:#6b7280;">No scan data in the last 24 hours. <a href="${appUrl}/brands" style="color:#7c3aed;">Add a brand</a> to start tracking.</p>`
          : `
      <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th style="padding:10px 12px;text-align:left;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Brand</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Scans</th>
            <th style="padding:10px 12px;text-align:center;font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Mentions</th>
          </tr>
        </thead>
        <tbody>${brandRows}</tbody>
      </table>`
      }
      <div style="margin-top:24px;text-align:center;">
        <a href="${appUrl}/dashboard" style="display:inline-block;background:#7c3aed;color:#fff;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.01em;">View Dashboard</a>
      </div>
    </div>
    <div style="padding:16px 32px;border-top:1px solid #e5e7eb;background:#f9fafb;">
      <p style="font-size:12px;color:#9ca3af;margin:0;">
        You're receiving this because you have email digest enabled.
        To unsubscribe, visit your
        <a href="${appUrl}/settings" style="color:#7c3aed;">account settings</a>.
      </p>
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function getDigestRecipients(pool: Pool): Promise<DigestRecipient[]> {
  const result = await pool.query<{ user_id: string; email: string }>(`
    SELECT up.user_id, au.email
    FROM user_preferences up
    JOIN auth.users au ON au.id = up.user_id
    WHERE up.email_digest_enabled = true
  `);
  return result.rows.map((r) => ({ userId: r.user_id, email: r.email }));
}

async function getBrandSummaries(pool: Pool, userId: string): Promise<BrandSummary[]> {
  const result = await pool.query<{
    brand_id: string;
    brand_name: string;
    recent_scans: string;
    recent_mentions: string;
  }>(
    `
    SELECT
      b.id AS brand_id,
      b.name AS brand_name,
      COUNT(s.id) AS recent_scans,
      COUNT(s.id) FILTER (WHERE s.mention_found = true) AS recent_mentions
    FROM brands b
    LEFT JOIN scans s
      ON s.brand_id = b.id
      AND s.scanned_at >= NOW() - INTERVAL '24 hours'
    WHERE b.owner_id = $1
    GROUP BY b.id, b.name
    ORDER BY b.name
    `,
    [userId]
  );

  return result.rows.map((r) => ({
    brandId: r.brand_id,
    brandName: r.brand_name,
    recentScans: Number(r.recent_scans),
    recentMentions: Number(r.recent_mentions),
  }));
}

async function sendDigestEmail(
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
      from: process.env.DIGEST_FROM_EMAIL ?? "OUTRANKgeo <digest@outrankgeo.com>",
      to,
      subject: `Your AI Visibility Digest — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

export async function runDigestJob(pool: Pool): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) {
    console.warn("[digest] RESEND_API_KEY not set — skipping email digest");
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.geotool.app";

  let recipients: DigestRecipient[];
  try {
    recipients = await getDigestRecipients(pool);
  } catch (err) {
    console.error("[digest] failed to fetch recipients:", err);
    return;
  }

  console.log(`[digest] sending to ${recipients.length} recipient(s)`);

  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    try {
      const brands = await getBrandSummaries(pool, recipient.userId);
      const html = renderDigestEmail(recipient.email, brands, appUrl);
      await sendDigestEmail(recipient.email, html, resendApiKey);
      sent++;
    } catch (err) {
      console.error(`[digest] failed to send to ${recipient.email}:`, err);
      failed++;
    }
  }

  console.log(`[digest] done — sent: ${sent}, failed: ${failed}`);
}
