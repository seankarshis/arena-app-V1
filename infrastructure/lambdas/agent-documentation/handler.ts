/**
 * Documentation Analysis Agent
 *
 * Verifies that code changes include appropriate documentation (JSDoc comments,
 * inline explanations, examples). Identifies missing or inadequate documentation
 * and suggests improvements. Never auto-fixes — documentation improvements
 * are generated as recommendations for human review.
 *
 * Uses Claude via Bedrock to analyze documentation quality.
 */

import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

const MAX_TOKENS = 8192;
const JSON_BLOCK_PATTERN = /