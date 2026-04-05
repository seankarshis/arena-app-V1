// Minimal ambient declaration for madge.
// @types/madge does not exist on DefinitelyTyped and madge does not bundle its
// own TypeScript declarations. This file covers the subset of the API used by
// blast-radius.ts. Expand as needed if additional madge methods are called.

declare module 'madge' {
  interface MadgeConfig {
    fileExtensions?: string[];
    tsConfig?: string;
    detectiveOptions?: Record<string, unknown>;
    [key: string]: unknown;
  }

  interface MadgeInstance {
    /** Returns an array of circular dependency chains, each chain being an ordered list of file paths. */
    circular(): string[][];
    /** Returns the full dependency graph as an adjacency map: filepath → list of imported filepaths. */
    obj(): Record<string, string[]>;
  }

  function madge(path: string, config?: MadgeConfig): Promise<MadgeInstance>;

  export = madge;
}
