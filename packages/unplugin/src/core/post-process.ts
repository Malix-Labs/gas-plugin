import { stripExports, transformBigIntLiterals } from "./transforms.js";

// Match markers with or without the comment prefix (bundlers may strip comments)
const GLOBALS_MARKER_RE =
  /^\s*(?:\/\* __GAS_GLOBALS__ \*\/\s*)?globalThis\.__gas_keep__\s*=\s*\[.*?];\s*$/gm;

export interface PostProcessOptions {
  transformBigInt?: boolean;
}

/**
 * Post-process a bundled code string:
 * 1. Remove tree-shake protection injections (globalThis.__gas_keep__ markers)
 * 2. Strip export keywords and blocks in a single AST traversal pass
 * 3. Downlevel BigInt literals (default: true)
 * 4. Normalize trailing newline
 */
export function postProcessBundle(code: string, options: PostProcessOptions = {}): string {
  let result = code;

  // Remove tree-shake protection injections
  result = result.replace(GLOBALS_MARKER_RE, "");

  // Strip export keywords and blocks
  result = stripExports(result);

  // Downlevel BigInt literals (10n -> BigInt("10"))
  if (options.transformBigInt !== false) {
    result = transformBigIntLiterals(result);
  }

  // Normalize trailing newline
  return `${result.trimEnd()}\n`;
}
