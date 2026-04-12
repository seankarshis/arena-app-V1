import {
  AccessDeniedException,
  BedrockRuntimeClient,
  ConverseCommand,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';

// Claude Haiku 4.5 on Bedrock (US cross-region inference profile).
// Fast and cost-effective for CI/CD code analysis tasks.
const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const DEFAULT_MAX_TOKENS = 4096;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const ALLOWED_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1'];
const DEFAULT_REGION = 'us-east-2';
// If the model's output sits within this many tokens of the ceiling we treat
// it as effectively truncated — a few tokens of slack protects against
// Bedrock usage counters lagging the actual stop event.
const TRUNCATION_SLACK_TOKENS = 16;

/**
 * Thrown when Bedrock's Converse response was cut off at the max_tokens
 * ceiling. Handlers convert this into a critical finding so synthesis fails
 * the agent rather than silently shipping partial output.
 */
export class ResponseTruncatedError extends Error {
  readonly stopReason: string;
  readonly outputTokens: number;
  readonly maxTokens: number;

  constructor(stopReason: string, outputTokens: number, maxTokens: number) {
    super(
      `Bedrock response truncated: stopReason='${stopReason}' outputTokens=${outputTokens} maxTokens=${maxTokens}`,
    );
    this.name = 'ResponseTruncatedError';
    this.stopReason = stopReason;
    this.outputTokens = outputTokens;
    this.maxTokens = maxTokens;
  }
}

// Bedrock authenticates via the Lambda execution role — no API key needed.
// AWS_REGION is automatically available in the Lambda environment.
const region = process.env.AWS_REGION ?? DEFAULT_REGION;
if (!ALLOWED_REGIONS.includes(region)) {
  // eslint-disable-next-line no-console
  console.warn(
    `[llm-client] AWS_REGION '${region}' not in allowed list, using default: ${DEFAULT_REGION}`,
  );
}

const client = new BedrockRuntimeClient({
  region: ALLOWED_REGIONS.includes(region) ? region : DEFAULT_REGION,
});

export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const response = await client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: systemPrompt }],
          messages: [
            {
              role: 'user',
              content: [{ text: userMessage }],
            },
          ],
          inferenceConfig: {
            maxTokens,
          },
        }),
      );

      // Extract text from the first text content block in the response message.
      const content = response.output?.message?.content ?? [];
      const textBlock = content.find((block) => 'text' in block);
      if (!textBlock || !('text' in textBlock)) {
        throw new Error('No text content block in Bedrock Converse response');
      }

      const outputTokens = response.usage?.outputTokens ?? 0;
      const stopReason = response.stopReason ?? '';

      // Truncation guard: either Bedrock explicitly says max_tokens, or the
      // reported output size sits within slack of the ceiling. Both are
      // treated as hard failures so partial text never reaches disk.
      if (stopReason === 'max_tokens' || outputTokens >= maxTokens - TRUNCATION_SLACK_TOKENS) {
        throw new ResponseTruncatedError(stopReason, outputTokens, maxTokens);
      }

      return {
        text: textBlock.text as string,
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (isNonRetryable(lastError)) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error('callLLM failed after max retries');
}

/**
 * @deprecated Import callLLM from llm-client instead.
 * Kept as an alias so handlers only need an import path change.
 */
export const callClaude = callLLM;

function isNonRetryable(err: Error): boolean {
  // ThrottlingException is always retryable (equivalent to HTTP 429)
  if (err instanceof ThrottlingException) return false;
  // Bad request / validation — retrying won't help
  if (err instanceof ValidationException) return true;
  // Permissions error — retrying won't help
  if (err instanceof AccessDeniedException) return true;
  // Truncation is deterministic given the input and maxTokens — no point retrying
  if (err instanceof ResponseTruncatedError) return true;
  // Fall back to HTTP status code on the error metadata envelope
  const metadata = err as unknown as Record<string, unknown>;
  const status = (metadata.$metadata as Record<string, unknown>)?.httpStatusCode as
    | number
    | undefined;
  if (status === undefined) return false;
  return status >= 400 && status < 500 && status !== 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
