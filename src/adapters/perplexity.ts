import type { EngineAdapter } from "./interface";
import { withRetry } from "./interface";

interface PerplexityMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface PerplexityResponse {
  choices: Array<{
    message: PerplexityMessage;
  }>;
}

export class PerplexityAdapter implements EngineAdapter {
  readonly engine = "perplexity" as const;
  private apiKey: string;

  constructor() {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY is required");
    this.apiKey = apiKey;
  }

  async query(prompt: string): Promise<string> {
    return withRetry(async () => {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: "sonar-small-chat",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        throw new Error(`Perplexity API error: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as PerplexityResponse;
      const content = data.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from Perplexity");
      return content;
    });
  }
}
