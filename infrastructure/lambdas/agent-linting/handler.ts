/**
 * Linting Agent
 *
 * Performs static analysis on code changes to identify style violations,
 * code organization issues, naming inconsistencies, and best practice violations.
 * Can auto-fix many issues by generating corrected code blocks.
 *
 * Uses Claude via Bedrock for intelligent linting beyond simple regex patterns.
 */

import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JSON_BLOCK_PATTERN = /