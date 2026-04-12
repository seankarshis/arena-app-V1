export interface DiffResult {
  file: string;
  addedLines: number[];
  removedLines: number[];
  changedLines: number[]; // union of added + lines adjacent to removed
}

/**
 * Parse a unified diff string and extract changed line numbers per file.
 * Returns a map of filepath → DiffResult.
 */
export function parseDiff(diffString: string): Map<string, DiffResult> {
  const results = new Map<string, DiffResult>();

  let currentFile: string | null = null;
  let newLineNumber = 0;
  let oldLineNumber = 0;

  for (const line of diffString.split('\n')) {
    // +++ b/path/to/file.ts — new file header
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch) {
      currentFile = newFileMatch[1];
      if (!results.has(currentFile)) {
        results.set(currentFile, { file: currentFile, addedLines: [], removedLines: [], changedLines: [] });
      }
      continue;
    }

    // @@ -oldStart,oldCount +newStart,newCount @@
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLineNumber = parseInt(hunkMatch[1], 10);
      newLineNumber = parseInt(hunkMatch[2], 10);
      continue;
    }

    if (!currentFile) continue;
    const result = results.get(currentFile)!;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      result.addedLines.push(newLineNumber);
      result.changedLines.push(newLineNumber);
      newLineNumber++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      result.removedLines.push(oldLineNumber);
      // Record the surrounding new-file line as changed context
      if (newLineNumber > 0) {
        result.changedLines.push(newLineNumber);
      }
      oldLineNumber++;
    } else if (!line.startsWith('\\')) {
      // Context line — advance both counters
      oldLineNumber++;
      newLineNumber++;
    }
  }

  // Deduplicate changedLines
  for (const result of results.values()) {
    result.changedLines = [...new Set(result.changedLines)].sort((a, b) => a - b);
  }

  return results;
}

/**
 * Format a file's contents with line numbers for Claude review.
 * Optionally highlights changed lines with a ">" marker.
 *
 * @param filepath - The file path (used as a header label)
 * @param content - Full file content
 * @param changedLines - Optional set of line numbers to highlight
 */
export function formatFileForReview(
  filepath: string,
  content: string,
  changedLines?: number[],
): string {
  const changedSet = new Set(changedLines ?? []);
  const lines = content.split('\n');
  const width = String(lines.length).length;

  const numbered = lines.map((line, idx) => {
    const lineNum = idx + 1;
    const marker = changedSet.has(lineNum) ? '>' : ' ';
    return `${marker}${String(lineNum).padStart(width, ' ')} | ${line}`;
  });

  return `// filepath: ${filepath}\n${numbered.join('\n')}`;
}

import * as ts from 'typescript';
import { Finding } from './types';

export interface ParsedCodeBlock {
  filepath: string;
  content: string;
}

export type RejectionReason =
  | 'unknown_path'
  | 'drastic_shrink'
  | 'invalid_syntax'
  | 'imports_lost'
  | 'exports_lost';

export interface ParseRejection {
  filepath: string;
  reason: RejectionReason;
  detail: string;
}

export interface ParseResult {
  blocks: ParsedCodeBlock[];
  rejections: ParseRejection[];
}

export interface ParseOptions {
  /**
   * Allow blocks whose filepath is not an exact key in originalFiles to be
   * accepted as *new* files. Used by the unit-tests agent, which creates
   * brand-new test files. When true, unknown-path blocks still receive the
   * syntax check but skip the shrink / import-export gates (no original to
   * compare against).
   */
  allowNewFiles?: boolean;
}

const SHRINK_FLOOR_LINES = 30;
const SHRINK_RATIO_THRESHOLD = 0.75;
const MAX_IMPORT_SOURCE_SHRINK = 1;

/**
 * Convert a ParseRejection into a critical Finding. Handlers push the result
 * into their findings list so determineStatus returns 'fail' and synthesis
 * marks the overall run as failed.
 */
export function rejectionToFinding(r: ParseRejection): Finding {
  return {
    severity: 'critical',
    file: r.filepath,
    message: `Agent output rejected by ${r.reason} gate: ${r.detail}`,
    fixed: false,
  };
}

/**
 * Build the critical finding emitted when Bedrock truncates the response.
 * Used by every handler's callClaude catch block.
 */
export function truncationToFinding(files: string[], detail: string): Finding {
  return {
    severity: 'critical',
    file: files[0] ?? '<unknown>',
    message: `Agent LLM response truncated before completion: ${detail}`,
    fixed: false,
  };
}

/**
 * Build the critical finding emitted when parseFindings could not decode the
 * agent's structured JSON. A silent empty array used to be indistinguishable
 * from "no findings".
 */
export function parseFindingsErrorToFinding(detail: string): Finding {
  return {
    severity: 'critical',
    file: '<agent-output>',
    message: `Agent findings JSON could not be parsed: ${detail}`,
    fixed: false,
  };
}

/**
 * Extract code blocks from a Claude response and validate each one against
 * the original file it claims to replace.
 *
 * Four gates reject bad output *before* it reaches disk:
 *   1. unknown_path  — block filepath is not an exact key in originalFiles
 *   2. drastic_shrink — fixed/original < 0.75 (for files ≥ 30 lines)
 *   3. invalid_syntax — ts.createSourceFile reports parseDiagnostics
 *   4. imports_lost / exports_lost — top-level import source set shrinks
 *      by more than one, or any exported name disappears
 *
 * Rejected blocks are dropped from `blocks` and recorded in `rejections` so
 * the agent handler can convert them into critical findings.
 */
export function parseClaudeCodeResponse(
  response: string,
  originalFiles: Record<string, string>,
  options: ParseOptions = {},
): ParseResult {
  const rawBlocks = extractRawBlocks(response);

  const blocks: ParsedCodeBlock[] = [];
  const rejections: ParseRejection[] = [];
  const seen = new Set<string>();

  for (const raw of rawBlocks) {
    const filepath = raw.filepath.trim();
    if (seen.has(filepath)) continue;
    seen.add(filepath);

    const original = originalFiles[filepath];
    const isNewFile = original === undefined;

    // Gate 1: exact path match against originalFiles (unless new files allowed)
    if (isNewFile && !options.allowNewFiles) {
      rejections.push({
        filepath,
        reason: 'unknown_path',
        detail: `block filepath '${filepath}' is not in the agent's input files`,
      });
      continue;
    }

    // Gate 2: drastic shrink (only meaningful when replacing an existing file)
    if (!isNewFile) {
      const originalLines = original.split('\n').length;
      const fixedLines = raw.content.split('\n').length;
      if (originalLines >= SHRINK_FLOOR_LINES) {
        const ratio = fixedLines / originalLines;
        if (ratio < SHRINK_RATIO_THRESHOLD) {
          rejections.push({
            filepath,
            reason: 'drastic_shrink',
            detail: `fixed file is ${fixedLines} lines vs ${originalLines} original (ratio ${ratio.toFixed(2)} < ${SHRINK_RATIO_THRESHOLD})`,
          });
          continue;
        }
      }
    }

    // Gate 3: TypeScript syntax check (always — applies to new and replacement files)
    const scriptKind = filepath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(
      filepath,
      raw.content,
      ts.ScriptTarget.Latest,
      false,
      scriptKind,
    );
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
      const first = diagnostics[0];
      const message = typeof first.messageText === 'string'
        ? first.messageText
        : first.messageText.messageText;
      rejections.push({
        filepath,
        reason: 'invalid_syntax',
        detail: `ts parseDiagnostics: ${diagnostics.length} error(s); first: ${message}`,
      });
      continue;
    }

    // Gate 4: import/export shrink (only meaningful when replacing an existing file)
    if (!isNewFile) {
      const importExportCheck = checkImportExportShrink(original, sourceFile);
      if (importExportCheck) {
        rejections.push({ filepath, ...importExportCheck });
        continue;
      }
    }

    blocks.push({ filepath, content: raw.content });
  }

  return { blocks, rejections };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractRawBlocks(response: string): ParsedCodeBlock[] {
  const blocks: ParsedCodeBlock[] = [];

  // Match fenced code blocks (``` ... ```)
  const fenceRegex = /```(?:\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(response)) !== null) {
    const body = match[1];

    // Convention 1: first line inside the block is "// filepath: <path>"
    const inlinePathMatch = body.match(/^\/\/ filepath:\s*(.+)\n([\s\S]*)$/);
    if (inlinePathMatch) {
      blocks.push({
        filepath: inlinePathMatch[1].trim(),
        content: inlinePathMatch[2],
      });
      continue;
    }

    // Convention 2: the opening fence itself carries the filepath tag
    const openingFenceIndex = match.index;
    const precedingText = response.slice(Math.max(0, openingFenceIndex - 200), openingFenceIndex);
    const taggedFenceMatch = precedingText.match(/```filepath:\s*(.+)\s*$/);
    if (taggedFenceMatch) {
      blocks.push({
        filepath: taggedFenceMatch[1].trim(),
        content: body,
      });
    }
  }

  // Also handle the "```filepath: src/foo.ts" syntax in the opening fence itself
  const taggedFenceRegex = /```filepath:\s*(.+)\n([\s\S]*?)```/g;
  let taggedMatch: RegExpExecArray | null;
  while ((taggedMatch = taggedFenceRegex.exec(response)) !== null) {
    const filepath = taggedMatch[1].trim();
    if (!blocks.some((b) => b.filepath === filepath)) {
      blocks.push({ filepath, content: taggedMatch[2] });
    }
  }

  return blocks;
}

function extractOriginalImportSources(content: string): Set<string> {
  const sources = new Set<string>();
  // Match: import ... from 'module'   or   import 'module'
  const importRegex = /^\s*import(?:\s+[\s\S]*?from)?\s+['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(content)) !== null) {
    sources.add(m[1]);
  }
  return sources;
}

function extractOriginalExportNames(content: string): Set<string> {
  const names = new Set<string>();
  // Named exports: export { a, b as c } — grab the whole block then split
  const exportBlockRegex = /^\s*export\s*\{([^}]+)\}/gm;
  let m: RegExpExecArray | null;
  while ((m = exportBlockRegex.exec(content)) !== null) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  // Declaration exports: export function foo / export const foo / export class Foo / export default
  const declRegex = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  while ((m = declRegex.exec(content)) !== null) {
    names.add(m[1]);
  }
  if (/^\s*export\s+default\s+/m.test(content)) {
    names.add('default');
  }
  return names;
}

function extractFixedImportSources(sourceFile: ts.SourceFile): Set<string> {
  const sources = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      sources.add(stmt.moduleSpecifier.text);
    }
  }
  return sources;
}

function extractFixedExportNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const hasExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const hasDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

    if (hasExport && hasDefault) names.add('default');

    if (hasExport) {
      if (
        ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt)
      ) {
        if (stmt.name) names.add(stmt.name.text);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
        }
      }
    }

    // export { a, b as c } and export { a } from '...'
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        names.add((el.name).text);
      }
    }

    if (ts.isExportAssignment(stmt)) {
      names.add('default');
    }
  }
  return names;
}

function checkImportExportShrink(
  original: string,
  fixed: ts.SourceFile,
): { reason: RejectionReason; detail: string } | null {
  const originalImports = extractOriginalImportSources(original);
  const fixedImports = extractFixedImportSources(fixed);
  const lostImports = [...originalImports].filter((s) => !fixedImports.has(s));
  if (lostImports.length > MAX_IMPORT_SOURCE_SHRINK) {
    return {
      reason: 'imports_lost',
      detail: `${lostImports.length} import sources removed: ${lostImports.slice(0, 5).join(', ')}`,
    };
  }

  const originalExports = extractOriginalExportNames(original);
  const fixedExports = extractFixedExportNames(fixed);
  const lostExports = [...originalExports].filter((n) => !fixedExports.has(n));
  if (lostExports.length > 0) {
    return {
      reason: 'exports_lost',
      detail: `exported names removed: ${lostExports.join(', ')}`,
    };
  }

  return null;
}
