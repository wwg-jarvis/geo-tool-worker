import { describe, it, expect } from "vitest";
import { withRetry } from "../adapters/interface";

describe("withRetry", () => {
  it("returns the result of the function on success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("retries on failure and eventually throws", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          return Promise.reject(new Error("fail"));
        },
        2,
        5000,
      ),
    ).rejects.toThrow("fail");
    expect(attempts).toBe(2);
  });
});
