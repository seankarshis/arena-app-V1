import { AgentReport, AgentRequest, AgentResponse, Finding } from '../shared/types';
import { callClaude } from '../shared/llm-client';
import { formatFileForReview, parseClaudeCodeResponse } from '../shared/git-operations';
import { SYSTEM_PROMPT } from './prompt';

// Constants
const DEFAULT_MAX_TOKENS = 8192;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFindings(text: string): Finding[] {
  const jsonBlockMatch = text.match(/