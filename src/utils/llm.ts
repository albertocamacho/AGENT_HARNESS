import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

export interface LLMCallOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
  /** Called with partial text chunks during streaming */
  onChunk?: (chunk: string) => void;
}

export interface LLMCallResult {
  text: string;
  usage: { input: number; output: number };
}

/**
 * Simple text-in, text-out LLM call. Every agent uses this
 * so we have one place to swap models, add retries, add caching, etc.
 */
export async function llmCall(options: LLMCallOptions): Promise<string> {
  const result = await llmCallWithUsage(options);
  return result.text;
}

export async function llmCallWithUsage(options: LLMCallOptions): Promise<LLMCallResult> {
  const {
    system,
    prompt,
    maxTokens = 4096,
    model = "claude-sonnet-4-6",
    temperature = 0.7,
    onChunk,
  } = options;

  // Format system prompt as a cacheable content block
  const systemContent = [
    {
      type: "text" as const,
      text: system,
      cache_control: { type: "ephemeral" as const },
    },
  ];

  // Use streaming when a chunk callback is provided
  if (onChunk) {
    const stream = getClient().messages.stream({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemContent,
      messages: [{ role: "user", content: prompt }],
    });

    stream.on("text", (text) => onChunk(text));

    const response = await stream.finalMessage();

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return {
      text,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  }

  // Non-streaming path
  const response = await getClient().messages.create({
    model,
    max_tokens: maxTokens,
    temperature,
    system: systemContent,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => {
      if (block.type === "text") return block.text;
      return "";
    })
    .join("\n");

  return {
    text,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}
