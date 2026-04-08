import type { ScanEngine } from "../types/supabase";

export interface EngineAdapter {
  readonly engine: ScanEngine;
  query(prompt: string): Promise<string>;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  timeoutMs = 30_000,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }
  throw lastError;
}
