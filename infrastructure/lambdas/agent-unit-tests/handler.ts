import { AgentRequest, AgentResponse, AgentReport, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TEST_FRAMEWORK = 'vitest';
const CLAUDE_MAX_TOKENS = 8192;
const TEST_FILE_PATTERNS = ['.test.', '.spec.', '__tests__/'];
const PACKAGE_JSON_NAMES = new Set(['package.json']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFindings(text: string): Finding[] {
  const jsonBlockMatch = text.match(/