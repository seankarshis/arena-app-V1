/**
 * Security Analysis Agent
 *
 * Performs security analysis on code changes to identify vulnerabilities,
 * unsafe patterns, injection risks, authentication/authorization issues,
 * and compliance violations.
 *
 * Uses Claude via Bedrock for intelligent security analysis.
 */

import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_TOKENS = 8192;
const JSON_BLOCK_PATTERN = /