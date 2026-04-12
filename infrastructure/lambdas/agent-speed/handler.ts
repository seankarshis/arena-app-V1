/**
 * Speed/Performance Analysis Agent
 *
 * Analyzes code changes for performance anti-patterns, inefficient algorithms,
 * unnecessary computations, and architectural issues that could impact latency
 * or throughput.
 *
 * Uses Claude via Bedrock for intelligent performance analysis.
 */

import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSON_BLOCK_PATTERN = /