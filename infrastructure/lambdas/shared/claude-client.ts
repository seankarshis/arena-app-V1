/**
 * @deprecated This file has been superseded by llm-client.ts (Bedrock Converse API).
 * It re-exports from llm-client so existing references continue to compile
 * while the codebase completes the migration. Delete this file once all
 * imports have been updated.
 */
export { callLLM as callClaude, callLLM } from './llm-client';
