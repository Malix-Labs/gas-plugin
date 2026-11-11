import { parseSync } from "oxc-parser";

export interface GasSyntaxIssue {
  line: number;
  column: number;
  reason: string;
}

interface AstNodeLike {
  type: string;
  start?: number;
  bigint?: string;
  value?: unknown;
  raw?: string;
  regex?: { flags?: string } | null;
  operator?: string;
  name?: string;
  await?: boolean;
  kind?: string;
}

const FUNCTION_NODE_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const LOGICAL_ASSIGNMENT_OPERATORS = new Set(["??=", "||=", "&&="]);

function computeLineColumn(code: string, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, code.length));
  let line = 1;
  let lastNewline = -1;

  for (let i = 0; i < clamped; i += 1) {
    if (code.charCodeAt(i) === 10) {
      line += 1;
      lastNewline = i;
    }
  }

  return { line, column: clamped - lastNewline };
}

function getLiteralIssueReason(node: AstNodeLike): string | undefined {
  if (typeof node.bigint === "string") {
    const raw = typeof node.raw === "string" ? node.raw : `${node.bigint}n`;
    return `BigInt literal (${raw}) — rejected by Google Apps Script's parser (even under ES2020)`;
  }

  if (typeof node.value === "number" && typeof node.raw === "string" && node.raw.includes("_")) {
    return `Numeric separator (${node.raw}) (ES2021) — unsupported by Google Apps Script's parser`;
  }

  const flags = node.regex?.flags;
  if (typeof flags === "string") {
    if (flags.includes("d")) {
      return "RegExp /d (hasIndices) flag (ES2022) — unsupported by Google Apps Script's parser";
    }
    if (flags.includes("v")) {
      return "RegExp /v (unicodeSets) flag (ES2024) — unsupported by Google Apps Script's parser";
    }
  }

  return undefined;
}

function getNodeIssueReason(node: AstNodeLike, inFunction: boolean): string | undefined {
  switch (node.type) {
    case "Literal":
      return getLiteralIssueReason(node);
    case "AssignmentExpression":
      if (typeof node.operator === "string" && LOGICAL_ASSIGNMENT_OPERATORS.has(node.operator)) {
        return `Logical assignment operator (${node.operator}) (ES2021) — unsupported by Google Apps Script's parser`;
      }
      return undefined;
    case "PropertyDefinition":
      return "Class field declaration (ES2022) — unsupported by Google Apps Script's parser";
    case "PrivateIdentifier":
      return `Private class element (#${node.name ?? "private"}) (ES2022) — unsupported by Google Apps Script's parser`;
    case "StaticBlock":
      return "Class static initialization block (ES2022) — unsupported by Google Apps Script's parser";
    case "AwaitExpression":
      return inFunction
        ? undefined
        : "Top-level await (ES2022) — unsupported by Google Apps Script's parser";
    case "ForOfStatement":
      return !inFunction && node.await === true
        ? "Top-level for-await-of loop (ES2022) — unsupported by Google Apps Script's parser"
        : undefined;
    case "VariableDeclaration":
      if (node.kind === "using" || node.kind === "await using") {
        return `Explicit resource management (${node.kind}) — unsupported by Google Apps Script's parser`;
      }
      return undefined;
    case "Decorator":
      return "Decorator syntax — unsupported by Google Apps Script's parser";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function resolveChildInFunction(nodeType: string, current: boolean): boolean {
  if (FUNCTION_NODE_TYPES.has(nodeType)) {
    return true;
  }
  if (nodeType === "StaticBlock") {
    return false;
  }
  return current;
}

interface StackEntry {
  value: unknown;
  inFunction: boolean;
}

function pushArrayEntries(stack: StackEntry[], items: unknown[], inFunction: boolean): void {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    stack.push({ value: items[i], inFunction });
  }
}

function pushChildEntries(
  stack: StackEntry[],
  record: Record<string, unknown>,
  inFunction: boolean,
): void {
  const values = Object.values(record);
  for (let i = values.length - 1; i >= 0; i -= 1) {
    if (isRecord(values[i])) {
      stack.push({ value: values[i], inFunction });
    }
  }
}

function inspectStackRecord(
  record: Record<string, unknown>,
  inFunction: boolean,
  code: string,
  issues: GasSyntaxIssue[],
): boolean {
  const nodeType = typeof record.type === "string" ? record.type : undefined;
  if (!nodeType) {
    return inFunction;
  }

  const node = record as unknown as AstNodeLike;
  const reason = getNodeIssueReason(node, inFunction);
  if (reason) {
    const loc = computeLineColumn(code, typeof node.start === "number" ? node.start : 0);
    issues.push({ line: loc.line, column: loc.column, reason });
  }

  return resolveChildInFunction(nodeType, inFunction);
}

/**
 * Inspect bundled JavaScript for syntax constructs rejected by Google Apps Script's
 * server-side V8 parser (ES2020 syntax minus BigInt literals).
 */
export function findGasSyntaxIssues(code: string): GasSyntaxIssue[] {
  if (code.trim().length === 0) {
    return [];
  }

  const parsed = parseSync("bundle.js", code, { sourceType: "module" });
  const issues: GasSyntaxIssue[] = parsed.errors.map((err) => ({
    line: 1,
    column: 1,
    reason: `JavaScript syntax error: ${err.message}`,
  }));

  if (!parsed.program) {
    return issues;
  }

  const stack: StackEntry[] = [{ value: parsed.program, inFunction: false }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (Array.isArray(current.value)) {
      pushArrayEntries(stack, current.value, current.inFunction);
    } else if (isRecord(current.value)) {
      const childInFunction = inspectStackRecord(current.value, current.inFunction, code, issues);
      pushChildEntries(stack, current.value, childInFunction);
    }
  }

  return issues.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Validate that bundled JavaScript is syntactically compatible with Google Apps Script.
 * Throws an Error with line/column details for every unsupported construct found.
 */
export function validateGasSyntax(code: string): void {
  const issues = findGasSyntaxIssues(code);
  if (issues.length === 0) {
    return;
  }

  const details = issues
    .map((issue) => `  - Line ${issue.line}:${issue.column}: ${issue.reason}`)
    .join("\n");

  throw new Error(
    `[@gas-plugin/unplugin] Unsupported Google Apps Script syntax in bundle (set build.target to "es2020" and avoid ES2021+ / BigInt literals):\n${details}`,
  );
}
