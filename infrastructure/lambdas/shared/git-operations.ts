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

export interface ParsedCodeBlock {
  filepath: string;
  content: string;
}

/**
 * Extract code blocks and their associated file paths from a Claude response.
 *
 * Handles two tagging conventions emitted by agents:
 *   1. Fenced block with filepath comment header:
 *        ```typescript
 *        // filepath: src/foo.ts
 *        ...code...
 *        ```
 *   2. Tagged fence directly:
 *        ```filepath: src/foo.ts
 *        ...code...
 *        ```
 */
export function parseClaudeCodeResponse(response: string): ParsedCodeBlock[] {
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
    // Check the text immediately before this code block for ```filepath: <path>
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
    // Avoid duplicates from convention 2 above
    if (!blocks.some((b) => b.filepath === filepath)) {
      blocks.push({ filepath, content: taggedMatch[2] });
    }
  }

  return blocks;
}
