#!/usr/bin/env node
/**
 * Blast Radius Analyzer
 *
 * Given a list of changed TypeScript files from a PR, computes the full set of
 * files that could be affected: the changed files themselves, all files they
 * transitively import (downstream), and all files that transitively import them
 * (upstream). Output is written to blast-radius.json.
 *
 * Usage:
 *   npx ts-node .github/scripts/blast-radius.ts --files "api/src/schema/resolvers/interview.ts,frontend/src/hooks/useInterview.ts"
 *   npx ts-node .github/scripts/blast-radius.ts --from-file changed-files.txt [--depth 3]
 */

// @ts-ignore
import madge from 'madge';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BlastRadiusOutput {
  changed_files: string[];
  downstream_dependencies: string[];
  upstream_dependents: string[];
  full_scope: string[];
  stats: {
    changed_count: number;
    downstream_count: number;
    upstream_count: number;
    total_scope: number;
    total_repo_files: number;
  };
}

interface Args {
  files: string[];
  depth: number;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let files: string[] = [];
  let depth = 3;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--files' && argv[i + 1]) {
      files = argv[++i]
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean);
    } else if (arg === '--from-file' && argv[i + 1]) {
      const filePath = argv[++i];
      const content = fs.readFileSync(filePath, 'utf-8');
      files = content
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean);
    } else if (arg === '--depth' && argv[i + 1]) {
      const parsed = parseInt(argv[++i], 10);
      if (!isNaN(parsed) && parsed > 0) depth = parsed;
    }
  }

  return { files, depth };
}

// ---------------------------------------------------------------------------
// Graph utilities
// ---------------------------------------------------------------------------

/**
 * Build a reverse adjacency map: for each file, which files import it?
 */
function buildReverseTree(tree: Record<string, string[]>): Record<string, string[]> {
  const reverse: Record<string, string[]> = {};
  for (const [file, deps] of Object.entries(tree)) {
    for (const dep of deps) {
      if (!reverse[dep]) reverse[dep] = [];
      reverse[dep].push(file);
    }
  }
  return reverse;
}

/**
 * BFS traversal through an adjacency map starting from a set of seed files.
 * Returns a map of filepath → first-encountered depth (0 = seed file).
 * Respects maxDepth: neighbors beyond maxDepth are not explored.
 */
function bfsTraversal(
  seedFiles: string[],
  adjacency: Record<string, string[]>,
  maxDepth: number,
): Map<string, number> {
  const visited = new Map<string, number>();
  const queue: Array<{ file: string; depth: number }> = [];

  for (const f of seedFiles) {
    if (!visited.has(f)) {
      visited.set(f, 0);
      queue.push({ file: f, depth: 0 });
    }
  }

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    for (const neighbor of adjacency[file] ?? []) {
      if (!visited.has(neighbor)) {
        visited.set(neighbor, depth + 1);
        queue.push({ file: neighbor, depth: depth + 1 });
      }
    }
  }

  return visited;
}

/**
 * Truncate the full scope to at most 100 files, prioritising lower-depth files.
 * Priority order: depth 0 (changed files) > depth 1 > depth 2 > ...
 */
function applyDepthCap(
  allByMinDepth: Map<string, number>,
  maxDepth: number,
  cap = 100,
): string[] {
  if (allByMinDepth.size <= cap) {
    return [...allByMinDepth.keys()].sort();
  }

  console.warn(
    `Truncating blast radius from ${allByMinDepth.size} to ${cap} files (depth-prioritised).`,
  );

  // Group files by their minimum depth
  const byDepth = new Map<number, string[]>();
  for (const [file, depth] of allByMinDepth) {
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)!.push(file);
  }

  const result: string[] = [];
  for (let d = 0; d <= maxDepth && result.length < cap; d++) {
    const filesAtDepth = (byDepth.get(d) ?? []).sort();
    for (const f of filesAtDepth) {
      if (result.length >= cap) break;
      result.push(f);
    }
  }

  return result.sort();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { files: changedFiles, depth: maxDepth } = parseArgs();
  const baseDir = process.cwd();
  const outputFile = path.join(baseDir, 'blast-radius.json');

  // No changed TS files — output empty scope so the pipeline skips agents
  if (changedFiles.length === 0) {
    console.log('No changed TypeScript files. Writing empty scope.');
    const output: BlastRadiusOutput = {
      changed_files: [],
      downstream_dependencies: [],
      upstream_dependents: [],
      full_scope: [],
      stats: {
        changed_count: 0,
        downstream_count: 0,
        upstream_count: 0,
        total_scope: 0,
        total_repo_files: 0,
      },
    };
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Analysing dependency graph (depth=${maxDepth}) for ${changedFiles.length} changed file(s)...`);

  // Run madge against the project root
  const madgeResult = await madge(baseDir, {
    fileExtensions: ['ts', 'tsx'],
    tsConfig: path.join(baseDir, 'tsconfig.json'),
    detectiveOptions: {
      ts: { skipTypeImports: false }, // Include type-only imports — they indicate coupling
    },
  });

  // Warn about circular deps (don't fail — visited-set in BFS prevents infinite loops)
  const circular = madgeResult.circular();
  if (circular.length > 0) {
    console.warn(`WARNING: ${circular.length} circular dependency chain(s) found:`);
    for (const chain of circular.slice(0, 5)) {
      console.warn(`  ${chain.join(' → ')}`);
    }
    if (circular.length > 5) {
      console.warn(`  ... and ${circular.length - 5} more.`);
    }
  }

  // madge returns paths relative to baseDir when baseDir is the entry point
  const tree = madgeResult.obj() as Record<string, string[]>;
  const totalRepoFiles = Object.keys(tree).length;
  console.log(`Dependency graph: ${totalRepoFiles} files.`);

  const reverseTree = buildReverseTree(tree);

  // Separate existing files from deleted ones.
  // Deleted files: skip in forward (downstream) walk, but still walk upstream
  // so we catch files with now-broken imports.
  const existingChangedFiles = changedFiles.filter((f) =>
    fs.existsSync(path.resolve(baseDir, f)),
  );
  const deletedChangedFiles = changedFiles.filter(
    (f) => !fs.existsSync(path.resolve(baseDir, f)),
  );

  if (deletedChangedFiles.length > 0) {
    console.log(
      `Skipping ${deletedChangedFiles.length} deleted file(s) in forward walk:`,
      deletedChangedFiles,
    );
  }

  // Walk downstream (imports of changed files) — only from existing files
  const downstreamByDepth = bfsTraversal(existingChangedFiles, tree, maxDepth);
  // Walk upstream (files that import changed files) — include deleted files so
  // we surface broken dependents
  const upstreamByDepth = bfsTraversal(changedFiles, reverseTree, maxDepth);

  const changedSet = new Set(changedFiles);
  const downstream = new Set<string>();
  const upstream = new Set<string>();

  // Collect all files with their minimum depth across both walks
  const allByMinDepth = new Map<string, number>();

  // Seed with changed files at depth 0
  for (const f of changedFiles) {
    allByMinDepth.set(f, 0);
  }

  for (const [file, depth] of downstreamByDepth) {
    if (!changedSet.has(file)) {
      downstream.add(file);
      const prev = allByMinDepth.get(file) ?? Infinity;
      allByMinDepth.set(file, Math.min(prev, depth));
    }
  }

  for (const [file, depth] of upstreamByDepth) {
    if (!changedSet.has(file)) {
      upstream.add(file);
      const prev = allByMinDepth.get(file) ?? Infinity;
      allByMinDepth.set(file, Math.min(prev, depth));
    }
  }

  if (allByMinDepth.size > 50) {
    console.warn(`WARNING: Blast radius is ${allByMinDepth.size} files (exceeds 50-file threshold).`);
  }

  // Apply depth-prioritised safety cap
  const fullScopeFiles = applyDepthCap(allByMinDepth, maxDepth);

  const fullScopeSet = new Set(fullScopeFiles);

  const output: BlastRadiusOutput = {
    changed_files: [...changedSet].sort(),
    downstream_dependencies: [...downstream]
      .filter((f) => fullScopeSet.has(f))
      .sort(),
    upstream_dependents: [...upstream]
      .filter((f) => fullScopeSet.has(f))
      .sort(),
    full_scope: fullScopeFiles,
    stats: {
      changed_count: changedFiles.length,
      downstream_count: downstream.size,
      upstream_count: upstream.size,
      total_scope: fullScopeFiles.length,
      total_repo_files: totalRepoFiles,
    },
  };

  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`Blast radius: ${fullScopeFiles.length} files in scope. Written to blast-radius.json.`);
}

main().catch((err) => {
  console.error('Blast radius analysis failed:', err);
  process.exit(1);
});
