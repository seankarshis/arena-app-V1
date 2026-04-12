import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConverseCommand, BedrockRuntimeClient, ThrottlingException, ValidationException, AccessDeniedException } from '@aws-sdk/client-bedrock-runtime';
import { callLLM, callClaude } from './llm-client';

// Mock the Bedrock client
vi.mock('@aws-sdk/client-bedrock-runtime');

describe('llm-client', () => {
  let mockClient: any;
  let sendSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    sendSpy = vi.fn();
    mockClient = {
      send: sendSpy,
    };
    (BedrockRuntimeClient as any).mockImplementation(() => mockClient);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('callLLM', () => {
    it('should successfully call the LLM and return text response', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [
              { text: 'This is the response text' },
            ],
          },
        },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      const result = await callLLM('system prompt', 'user message', 2000);

      expect(result).toEqual({
        text: 'This is the response text',
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith(expect.any(ConverseCommand));
    });

    it('should use default max tokens when not specified', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [{ text: 'response' }],
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      await callLLM('system', 'user');

      const callArgs = sendSpy.mock.calls[0][0];
      expect(callArgs.input.inferenceConfig.maxTokens).toBe(4096);
    });

    it('should handle custom max tokens', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [{ text: 'response' }],
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      await callLLM('system', 'user', 8192);

      const callArgs = sendSpy.mock.calls[0][0];
      expect(callArgs.input.inferenceConfig.maxTokens).toBe(8192);
    });

    it('should handle missing output gracefully', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [],
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      await expect(callLLM('system', 'user')).rejects.toThrow('No text content block in Bedrock Converse response');
    });

    it('should handle missing content block', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [
              { toolResult: 'not text' },
            ],
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      await expect(callLLM('system', 'user')).rejects.toThrow('No text content block in Bedrock Converse response');
    });

    it('should retry on ThrottlingException', async () => {
      sendSpy
        .mockRejectedValueOnce(new ThrottlingException({ $metadata: {} as any, message: 'Throttled' }))
        .mockResolvedValueOnce({
          output: {
            message: {
              content: [{ text: 'success after retry' }],
            },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        });

      const result = await callLLM('system', 'user');

      expect(result.text).toBe('success after retry');
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    it('should throw immediately on ValidationException', async () => {
      sendSpy.mockRejectedValueOnce(new ValidationException({ $metadata: {} as any, message: 'Invalid input' }));

      await expect(callLLM('system', 'user')).rejects.toThrow(ValidationException);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately on AccessDeniedException', async () => {
      sendSpy.mockRejectedValueOnce(new AccessDeniedException({ $metadata: {} as any, message: 'Access denied' }));

      await expect(callLLM('system', 'user')).rejects.toThrow(AccessDeniedException);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately on HTTP 4xx errors (except 429)', async () => {
      const error = new Error('Bad request');
      (error as any).$metadata = { httpStatusCode: 400 };
      sendSpy.mockRejectedValueOnce(error);

      await expect(callLLM('system', 'user')).rejects.toThrow('Bad request');
      expect(sendSpy).toHaveBeenCalledTimes(1);
    });

    it('should retry on HTTP 5xx errors', async () => {
      const error500 = new Error('Service error');
      (error500 as any).$metadata = { httpStatusCode: 500 };
      
      sendSpy
        .mockRejectedValueOnce(error500)
        .mockResolvedValueOnce({
          output: {
            message: {
              content: [{ text: 'recovered' }],
            },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        });

      const result = await callLLM('system', 'user');

      expect(result.text).toBe('recovered');
      expect(sendSpy).toHaveBeenCalledTimes(2);
    });

    it('should exhaust retries and throw last error', async () => {
      const error = new Error('Persistent error');
      (error as any).$metadata = { httpStatusCode: 500 };
      sendSpy.mockRejectedValue(error);

      await expect(callLLM('system', 'user')).rejects.toThrow('Persistent error');
      expect(sendSpy).toHaveBeenCalledTimes(3); // MAX_RETRIES = 3
    });

    it('should handle exponential backoff delays', async () => {
      vi.useFakeTimers();
      
      const error = new Error('Transient error');
      (error as any).$metadata = { httpStatusCode: 503 };
      
      sendSpy
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({
          output: {
            message: {
              content: [{ text: 'success' }],
            },
          },
          usage: {
            inputTokens: 10,
            outputTokens: 20,
          },
        });

      const promise = callLLM('system', 'user');

      // Fast-forward through backoff delays
      await vi.advanceTimersByTimeAsync(1000); // First delay: 1000ms
      await vi.advanceTimersByTimeAsync(2000); // Second delay: 2000ms
      
      const result = await promise;
      expect(result.text).toBe('success');
      
      vi.useRealTimers();
    });

    it('should handle null usage tokens gracefully', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [{ text: 'response' }],
          },
        },
        usage: null,
      };
      sendSpy.mockResolvedValue(mockResponse);

      const result = await callLLM('system', 'user');

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    });

    it('should handle missing usage properties', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [{ text: 'response' }],
          },
        },
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      const result = await callLLM('system', 'user');

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    });

    it('should properly format Converse command', async () => {
      sendSpy.mockResolvedValue({
        output: {
          message: {
            content: [{ text: 'response' }],
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      });

      await callLLM('my system prompt', 'my user message', 5000);

      const callArgs = sendSpy.mock.calls[0][0];
      expect(callArgs.input.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
      expect(callArgs.input.system).toEqual([{ text: 'my system prompt' }]);
      expect(callArgs.input.messages).toEqual([
        {
          role: 'user',
          content: [{ text: 'my user message' }],
        },
      ]);
      expect(callArgs.input.inferenceConfig.maxTokens).toBe(5000);
    });
  });

  describe('callClaude', () => {
    it('should be an alias for callLLM', async () => {
      const mockResponse = {
        output: {
          message: {
            content: [{ text: 'response' }],
          },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
      sendSpy.mockResolvedValue(mockResponse);

      const result = await callClaude('system', 'user', 3000);

      expect(result.text).toBe('response');
      expect(sendSpy).toHaveBeenCalled();
    });
  });
});
