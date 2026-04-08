import Anthropic from "@anthropic-ai/sdk";
import type { EngineAdapter } from "./interface";
import { withRetry } from "./interface";

export class AnthropicAdapter implements EngineAdapter {
  readonly engine = "claude" as const;
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");
    this.client = new Anthropic({ apiKey });
  }

  async query(prompt: string): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      const block = response.content[0];
      if (!block || block.type !== "text") throw new Error("Empty response from Anthropic");
      return block.text;
    });
  }
}
