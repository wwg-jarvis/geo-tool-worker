import OpenAI from "openai";
import type { EngineAdapter } from "./interface";
import { withRetry } from "./interface";

export class OpenAIAdapter implements EngineAdapter {
  readonly engine = "chatgpt" as const;
  private client: OpenAI;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required");
    this.client = new OpenAI({ apiKey });
  }

  async query(prompt: string): Promise<string> {
    return withRetry(async () => {
      const response = await this.client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("Empty response from OpenAI");
      return content;
    });
  }
}
