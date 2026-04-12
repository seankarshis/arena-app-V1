/**
 * API Contracts Analysis Agent
 *
 * Analyzes code changes to identify API contract violations, breaking changes,
 * and inconsistencies in REST/GraphQL endpoints, request/response schemas, and
 * serialization logic. Reports findings to be tracked and fixed.
 *
 * Uses Claude via Bedrock to perform static analysis on modified files.
 */

import { AgentReport, AgentRequest, AgentResponse, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// Constants
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses Claude's response text to extract structured findings as JSON.
 * Expects findings wrapped in a markdown JSON code block.
 *
 * @param text - Claude's response text
 * @returns Array of Finding objects; empty array if parsing fails
 *
 * @example
 * const text = `...analysis...\n\`\`\`json\n[{"file":"src/api.ts",...}]\n\`\`\``;
 * const findings = parseFindings(text);
 */
function parseFindings(text: string): Finding[] {
  const jsonBlockMatch = text.match(/