import { distance } from "fastest-levenshtein";
import type { Pool } from "pg";

export interface MentionResult {
  detected: boolean;
  matchType: "exact" | "fuzzy" | null;
  position: number | null;
  context: string | null;
  mentionCount: number;
}

/**
 * Extract brand mentions from a raw LLM response.
 * Pass 1: Case-insensitive exact match for brand name and aliases.
 * Pass 2: Fuzzy match (Levenshtein ≤ 2) on individual words.
 */
export function extractMentions(
  brandName: string,
  aliases: string[],
  rawResponse: string,
): MentionResult {
  const terms = [brandName, ...aliases].filter(Boolean);
  const lower = rawResponse.toLowerCase();
  let mentionCount = 0;
  let firstPosition: number | null = null;

  // Pass 1: exact (case-insensitive) substring match
  for (const term of terms) {
    const termLower = term.toLowerCase();
    let idx = lower.indexOf(termLower);
    while (idx !== -1) {
      mentionCount++;
      if (firstPosition === null || idx < firstPosition) firstPosition = idx;
      idx = lower.indexOf(termLower, idx + 1);
    }
  }

  if (mentionCount > 0) {
    const contextStart = Math.max(0, firstPosition! - 40);
    const contextEnd = Math.min(rawResponse.length, firstPosition! + 80);
    return {
      detected: true,
      matchType: "exact",
      position: firstPosition,
      context: rawResponse.slice(contextStart, contextEnd).trim(),
      mentionCount,
    };
  }

  // Pass 2: fuzzy match on individual words (Levenshtein ≤ 2)
  const words = rawResponse.split(/\s+/);
  let charOffset = 0;

  for (const term of terms) {
    for (let i = 0; i < words.length; i++) {
      const word = words[i].replace(/[^a-zA-Z0-9]/g, "");
      if (word.length >= 3 && Math.abs(word.length - term.length) <= 2) {
        const dist = distance(word.toLowerCase(), term.toLowerCase());
        if (dist <= 2) {
          // Compute approximate char offset for this word
          const wordOffset = rawResponse.indexOf(words[i], charOffset);
          if (firstPosition === null || wordOffset < firstPosition) {
            firstPosition = wordOffset;
          }
          mentionCount++;
        }
      }
      charOffset += words[i].length + 1;
    }
    charOffset = 0;
  }

  if (mentionCount > 0) {
    const contextStart = Math.max(0, firstPosition! - 40);
    const contextEnd = Math.min(rawResponse.length, firstPosition! + 80);
    return {
      detected: true,
      matchType: "fuzzy",
      position: firstPosition,
      context: rawResponse.slice(contextStart, contextEnd).trim(),
      mentionCount,
    };
  }

  return { detected: false, matchType: null, position: null, context: null, mentionCount: 0 };
}

/**
 * Persist mention extraction results and update the scan row.
 */
export async function persistMentionResult(
  pool: Pool,
  scanId: string,
  brandId: string,
  result: MentionResult,
): Promise<void> {
  await pool.query(
    `INSERT INTO mention_results (scan_id, brand_id, detected, match_type, position)
     VALUES ($1, $2, $3, $4, $5)`,
    [scanId, brandId, result.detected, result.matchType, result.position],
  );

  await pool.query(
    `UPDATE scans
     SET mention_found = $1,
         mention_context = $2,
         mention_rank = $3
     WHERE id = $4`,
    [result.detected, result.context, result.position, scanId],
  );
}

/**
 * Compute visibility score for a brand/query after a scan completes.
 * Uses all scans recorded today for the brand/query combination.
 *
 * Score = MR×0.5 + PS×0.3 + FS×0.2
 *   MR = Mention Rate (% of engines that mentioned brand)
 *   PS = Position Score (1.0 if in first 20% of response, scaling down linearly)
 *   FS = Frequency Score (normalized: clamp mention count 0–5 → 0–1)
 */
export async function computeAndPersistVisibilityScore(
  pool: Pool,
  brandId: string,
  queryId: string,
): Promise<void> {
  const { rows: scans } = await pool.query<{
    id: string;
    mention_found: boolean;
    mention_rank: number | null;
    raw_response: string;
  }>(
    `SELECT s.id, s.mention_found, s.mention_rank, length(s.raw_response) as response_len,
            (SELECT count(*) FROM mention_results mr WHERE mr.scan_id = s.id) as mention_count
     FROM scans s
     WHERE s.brand_id = $1 AND s.query_id = $2
       AND s.scanned_at >= now() - interval '24 hours'`,
    [brandId, queryId],
  );

  if (scans.length === 0) return;

  const engineCount = scans.length;
  const mentionedCount = scans.filter((s) => s.mention_found).length;

  // MR: mention rate 0–1
  const mentionRate = mentionedCount / engineCount;

  // PS: position score — average across scans that had a mention
  let positionScore = 0;
  if (mentionedCount > 0) {
    const mentionedScans = scans.filter((s) => s.mention_found && s.mention_rank !== null);
    if (mentionedScans.length > 0) {
      const { rows: responseData } = await pool.query<{
        id: string;
        response_len: number;
        mention_rank: number;
      }>(
        `SELECT id, length(raw_response) as response_len, mention_rank
         FROM scans
         WHERE id = ANY($1) AND mention_rank IS NOT NULL`,
        [mentionedScans.map((s) => s.id)],
      );
      const scores = responseData.map(({ response_len, mention_rank }) => {
        const relPos = response_len > 0 ? mention_rank / response_len : 1;
        // 1.0 if in first 20%, scales to 0.0 at 100%
        return relPos <= 0.2 ? 1.0 : Math.max(0, 1.0 - (relPos - 0.2) / 0.8);
      });
      positionScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    }
  }

  // FS: frequency score — average normalized mention count (clamp 0–5 → 0–1)
  const { rows: mentionCounts } = await pool.query<{ scan_id: string; cnt: string }>(
    `SELECT scan_id, count(*) as cnt FROM mention_results
     WHERE scan_id = ANY($1) GROUP BY scan_id`,
    [scans.map((s) => s.id)],
  );
  const countByScanId = Object.fromEntries(mentionCounts.map((r) => [r.scan_id, parseInt(r.cnt)]));
  const freqScores = scans.map((s) => Math.min(1, (countByScanId[s.id] ?? 0) / 5));
  const freqScore = freqScores.reduce((a, b) => a + b, 0) / scans.length;

  const score = mentionRate * 0.5 + positionScore * 0.3 + freqScore * 0.2;
  const finalScore = Math.round(score * 100 * 100) / 100; // 0–100 scale, 2dp

  const breakdown = {
    mentionRate: Math.round(mentionRate * 100),
    positionScore: Math.round(positionScore * 100),
    freqScore: Math.round(freqScore * 100),
    engineCount,
    mentionedCount,
  };

  await pool.query(
    `INSERT INTO visibility_scores (brand_id, query_id, score, breakdown)
     VALUES ($1, $2, $3, $4)`,
    [brandId, queryId, finalScore, JSON.stringify(breakdown)],
  );
}
