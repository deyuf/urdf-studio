import YAML from 'yaml';
import { XacroParser } from '../vendor/xacro-parser/XacroParser.js';
import { getCoreIo } from './io';
import type { PackageMap, RenderedRobotDocument, StudioDiagnostic, XacroArgument } from './types';

type LogFn = (message: string) => void;

// Tunables — exported so callers/tests can introspect or adjust.
export const MAX_XACRO_RECOVERY_ATTEMPTS = 32;

// A "null-sink" value used by load_yaml when the YAML file can't be read.
// Every key access returns another sink, calls return a sink, and primitive
// coercion returns ''. This way a single missing yaml absorbs every
// downstream `${cfg['a']['b']}` access without exploding the expression
// evaluator — turning N cascading retries into zero.
export function createNullSink(): unknown {
  const handler: ProxyHandler<{ (): string }> = {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        return () => '';
      }
      if (prop === Symbol.iterator) {
        return function* () { /* empty */ };
      }
      if (prop === 'length') {
        return 0;
      }
      return createNullSink();
    },
    apply() {
      return createNullSink();
    },
    has() {
      return false;
    }
  };
  // Callable target so `cfg(...)` accidental usages also return a sink.
  return new Proxy(function () { return ''; }, handler);
}

let logFn: LogFn = () => {};

export function setLogger(fn: LogFn): void {
  logFn = fn;
}

// =============================================================================
// Concurrency: serialise xacro renders so concurrent callers cannot interleave
// inside the vendored parser. The vendored parser no longer touches globalThis
// (we inject domParser via XacroParser.domParser), so this lock is purely
// defensive — it also guarantees that a hypothetical future global mutation
// stays scoped to one render.
// =============================================================================

let xacroLock: Promise<void> = Promise.resolve();

async function withXacroLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = xacroLock;
  let release!: () => void;
  xacroLock = new Promise<void>(resolve => { release = resolve; });
  try {
    await previous;
    return await task();
  } finally {
    release();
  }
}

export async function renderRobotDocument(
  sourcePath: string,
  packages: PackageMap,
  xacroArguments: Record<string, unknown>
): Promise<RenderedRobotDocument> {
  const io = getCoreIo();
  const content = await io.readText(sourcePath);
  const isXacro = sourcePath.endsWith('.xacro') || sourcePath.endsWith('.urdf.xacro');
  if (!isXacro) {
    return {
      sourcePath,
      format: 'urdf',
      urdf: content,
      xacroArgs: extractXacroArgs(content),
      includedFiles: [],
      diagnostics: []
    };
  }

  return renderXacroFile(sourcePath, content, packages, xacroArguments);
}

export async function renderXacroFile(
  sourcePath: string,
  content: string,
  packages: PackageMap,
  xacroArguments: Record<string, unknown>
): Promise<RenderedRobotDocument> {
  return withXacroLock(async () => {
    const io = getCoreIo();
    const diagnostics: StudioDiagnostic[] = [];
    const includedFiles = new Set<string>();

    try {
      const xml = await parseXacroWithRecovery(sourcePath, content, packages, xacroArguments, diagnostics, includedFiles);
      const serializer = new io.XMLSerializer();
      return {
        sourcePath,
        format: 'xacro',
        urdf: serializer.serializeToString(xml),
        xacroArgs: extractXacroArgs(content),
        includedFiles: Array.from(includedFiles),
        diagnostics
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logFn(`xacro expansion failed: ${msg}`);
      diagnostics.push({
        severity: 'error',
        message: `xacro expansion failed: ${msg}`,
        code: 'xacro.expand',
        file: sourcePath
      });
      return {
        sourcePath,
        format: 'xacro',
        urdf: content,
        xacroArgs: extractXacroArgs(content),
        includedFiles: Array.from(includedFiles),
        diagnostics
      };
    }
  });
}

async function parseXacroWithRecovery(
  sourcePath: string,
  content: string,
  packages: PackageMap,
  xacroArguments: Record<string, unknown>,
  diagnostics: StudioDiagnostic[],
  includedFiles: Set<string>
): Promise<Document> {
  const skippedExpressions = new Set<string>();

  for (let attempt = 0; attempt <= MAX_XACRO_RECOVERY_ATTEMPTS; attempt += 1) {
    const attemptDiagnostics: StudioDiagnostic[] = [];
    try {
      const parser = createXacroParser(sourcePath, packages, xacroArguments, attemptDiagnostics, skippedExpressions, includedFiles);
      const sanitizedContent = sanitizeXacroContent(applyXacroCompatibilityRewrites(content), skippedExpressions);
      const xml = await parser.parse(sanitizedContent);
      diagnostics.push(...attemptDiagnostics);
      return xml;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedExpression = extractFailedExpression(message);
      if (!failedExpression || skippedExpressions.has(failedExpression)) {
        diagnostics.push(...attemptDiagnostics);
        throw error;
      }

      skippedExpressions.add(failedExpression);
      const detail = summarizeExpressionFailure(message);
      diagnostics.push({
        severity: 'warning',
        message: `Skipped unresolved xacro expression ${failedExpression}: ${detail}`,
        code: 'xacro.expressionSkipped',
        file: sourcePath
      });
      logFn(`Skipping unresolved xacro expression ${failedExpression}: ${detail}`);
    }
  }

  throw new Error(`xacro expansion exceeded ${MAX_XACRO_RECOVERY_ATTEMPTS} recovery attempts.`);
}

function createXacroParser(
  sourcePath: string,
  packages: PackageMap,
  xacroArguments: Record<string, unknown>,
  diagnostics: StudioDiagnostic[],
  skippedExpressions: ReadonlySet<string>,
  includedFiles: Set<string>
): XacroParser {
  const io = getCoreIo();
  const parser = new XacroParser();
  parser.inOrder = true;
  parser.requirePrefix = true;
  parser.localProperties = true;
  parser.workingPath = `${io.dirname(sourcePath)}${io.sep}`;
  parser.arguments = stringifyArgs(xacroArguments);
  // Inject the host's DOMParser so the vendored parser never touches globalThis.
  parser.domParser = io.DOMParser;
  parser.getFileContents = async includePath => {
    try {
      includedFiles.add(io.resolve(includePath));
    } catch {
      // ignore unresolvable paths
    }
    const includeContent = await io.readText(includePath);
    return sanitizeXacroContent(applyXacroCompatibilityRewrites(includeContent), skippedExpressions);
  };
  parser.rospackCommands = ((command: string, ...args: string[]) => {
    if (command === 'find' || command === 'find-pkg-share') {
      const packageName = args[0];
      const entry = packages[packageName];
      if (!entry) {
        diagnostics.push({ severity: 'warning', message: `Unknown ROS package "${packageName}"`, code: 'xacro.packageMissing', file: sourcePath });
        logFn(`rospack ${command}: unknown package "${packageName}"`);
        return '/unknown-package';
      }
      return entry.path;
    }
    if (command !== 'arg') {
      logFn(`Unsupported rospack command: ${command}`);
    }
    return undefined;
  }) as unknown as (command: string, ...args: string[]) => string;

  const parserWithExpressions = parser as XacroParser & { expressionParser: { functions: Record<string, unknown> } };
  const functions = parserWithExpressions.expressionParser.functions;
  functions.load_yaml = (yamlPath: string) => {
    const resolvedPath = io.isAbsolute(yamlPath) ? yamlPath : io.resolve(io.dirname(sourcePath), yamlPath);
    includedFiles.add(resolvedPath);
    try {
      // Tolerate duplicate keys — some real-world ROS packages (e.g. franka fp3's
      // inertials.yaml) ship YAML with repeated keys, and Python's loader accepts
      // them silently. The last entry wins.
      return YAML.parse(io.readTextSync(resolvedPath), { uniqueKeys: false });
    } catch (error) {
      // Common in user xacros: `load_yaml('$(find missing_pkg)/config.yaml')`
      // throws ENOENT because the package isn't in scope, then every
      // `${cfg['x']}` downstream fails one-at-a-time and exhausts the
      // recovery budget. Returning a null-sink lets all subsequent key
      // accesses and string coercions evaluate to empty in a single pass,
      // turning what would otherwise be N parser retries into zero.
      const detail = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        severity: 'warning',
        message: `load_yaml could not read "${resolvedPath}": ${detail}. Treating result as empty.`,
        code: 'xacro.yamlMissing',
        file: sourcePath
      });
      logFn(`load_yaml fallback (empty) for ${resolvedPath}: ${detail}`);
      return createNullSink();
    }
  };
  functions.bool = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
  functions.float = (value: unknown) => Number(value);
  functions.int = (value: unknown) => Math.trunc(Number(value));
  functions.str = (value: unknown) => String(value);
  functions.warning = (message: unknown) => {
    logFn(`xacro.warning: ${String(message)}`);
    return '';
  };
  functions.error = (message: unknown) => {
    logFn(`xacro.error: ${String(message)}`);
    return '';
  };
  functions.message = (message: unknown) => {
    logFn(`xacro.message: ${String(message)}`);
    return '';
  };
  functions.split_n = (value: unknown, separator: unknown, index: unknown) => {
    const parts = String(value).split(String(separator));
    const i = Number(index);
    return Number.isFinite(i) ? parts[i] : '';
  };
  functions.slice_from = (value: unknown, start: unknown) => {
    if (Array.isArray(value)) {
      return value.slice(Number(start));
    }
    return String(value).slice(Number(start));
  };
  functions.slice_to = (value: unknown, end: unknown) => {
    if (Array.isArray(value)) {
      return value.slice(0, Number(end));
    }
    return String(value).slice(0, Number(end));
  };
  functions.slice_range = (value: unknown, start: unknown, end: unknown) => {
    if (Array.isArray(value)) {
      return value.slice(Number(start), Number(end));
    }
    return String(value).slice(Number(start), Number(end));
  };
  functions.fatal = (message: unknown) => {
    logFn(`xacro.fatal: ${String(message)}`);
    throw new Error(`xacro.fatal: ${String(message)}`);
  };
  functions.__pytruthy__ = (value: unknown) => {
    if (value === null || value === undefined || value === false) {
      return false;
    }
    if (typeof value === 'string') {
      const lowered = value.toLowerCase();
      return lowered !== '' && lowered !== 'false' && lowered !== '0';
    }
    if (typeof value === 'number') {
      return value !== 0 && !Number.isNaN(value);
    }
    return true;
  };

  return parser;
}

// Erase "broken" expressions so the next xacro pass can succeed. Two kinds of
// failing tokens reach this function:
//
//   1. Python expressions inside `${...}` — e.g. `${some_undefined()}`.
//      We strip them only inside `${...}` blocks. The previous implementation
//      used a full-document `split().join('')` which could mangle XML
//      attribute values that happened to coincide with the expression's
//      literal text.
//
//   2. Rospack-style substitutions `$(command args)` — e.g. `$(arg name)`
//      with no arg default. These appear at the attribute level (NOT inside
//      `${...}`) and are unambiguous tokens, so removing them verbatim is
//      safe and preserves the legacy recovery behaviour that real ROS
//      packages depend on (xacros declaring `$(arg X)` without a default).
export function sanitizeXacroContent(content: string, skippedExpressions: ReadonlySet<string>): string {
  if (skippedExpressions.size === 0) {
    return content;
  }
  let result = content;

  // Step 1: rospack-style substitutions — remove every occurrence in the
  // document. They cannot validly nest inside other constructs, and their
  // `$(...)` form is distinctive enough that an unintentional match in
  // user text is vanishingly unlikely.
  for (const target of skippedExpressions) {
    if (target.startsWith('$(') && target.endsWith(')') && target.length > 0) {
      result = result.split(target).join('');
    }
  }

  // Step 2: Python `${...}` expressions — scope the removal to the inside of
  // `${...}` blocks. Empty strings and rospack tokens are skipped because
  // they were either handled above or aren't applicable. When ANY skip
  // target matches inside a block, drop the entire `${...}` block: the
  // expression failed to evaluate, so the only meaningful "skip" semantics
  // is "expression evaluated to empty". Preserving leftover operators or
  // whitespace (e.g. `${ + }`) would only re-fail the next parser pass.
  const expressionSkips = Array.from(skippedExpressions).filter(target =>
    target.length > 0 && !(target.startsWith('$(') && target.endsWith(')'))
  );
  if (expressionSkips.length === 0) {
    return result;
  }
  return result.replace(/\$\{([^{}]*)\}/g, (match, expression: string) => {
    let body = expression;
    let changed = false;
    for (const target of expressionSkips) {
      const next = body.split(target).join('');
      if (next !== body) {
        changed = true;
        body = next;
      }
    }
    return changed ? '' : match;
  });
}

// xacro-parser does not implement three constructs that ROS xacro accepts:
//   1) ROS Jade pass-through `param:=^` / `param:=^|default` macro defaults
//   2) Python ternary `X if cond else Y`
//   3) Python power operator `a ** b`
// We translate them on the source text before handing it to the library so the
// franka_description and similar ROS packages render without manual edits.
export function applyXacroCompatibilityRewrites(content: string): string {
  return rewriteListSlice(
    rewriteStringSplit(
      rewritePowerOperator(
        rewritePythonTernary(
          stripXacroNamespace(stripCaretMacroDefaults(content))
        )
      )
    )
  );
}

function rewriteListSlice(content: string): string {
  return content.replace(/\$\{([^{}]*)\}/g, (_match, expression: string) => {
    let rewritten = expression;
    rewritten = rewritten.replace(
      /([A-Za-z_]\w*)\s*\[\s*(\d+)\s*:\s*(\d+)\s*\]/g,
      'slice_range($1, $2, $3)'
    );
    rewritten = rewritten.replace(
      /([A-Za-z_]\w*)\s*\[\s*(\d+)\s*:\s*\]/g,
      'slice_from($1, $2)'
    );
    rewritten = rewritten.replace(
      /([A-Za-z_]\w*)\s*\[\s*:\s*(\d+)\s*\]/g,
      'slice_to($1, $2)'
    );
    return `\${${rewritten}}`;
  });
}

function rewriteStringSplit(content: string): string {
  return content.replace(/\$\{([^{}]*)\}/g, (_match, expression: string) => {
    const rewritten = expression.replace(
      /([A-Za-z_]\w*)\s*\.split\s*\(([^)]*)\)\s*\[\s*(\d+)\s*\]/g,
      'split_n($1, $2, $3)'
    );
    return `\${${rewritten}}`;
  });
}

function stripXacroNamespace(content: string): string {
  return content.replace(/\$\{([^{}]*)\}/g, (_match, expression: string) => {
    const rewritten = expression.replace(/\bxacro\.([A-Za-z_]\w*)/g, '$1');
    return `\${${rewritten}}`;
  });
}

function stripCaretMacroDefaults(content: string): string {
  return content.replace(/\bparams\s*=\s*"([^"]*)"/g, (_match, params: string) => {
    const tokens = params.match(/[^\s']+(?:'[^']*')?/g) ?? [];
    const kept = tokens.filter(token => !/:?=\s*\^/.test(token));
    return `params="${kept.join(' ')}"`;
  });
}

function rewritePythonTernary(content: string): string {
  return content.replace(/\$\{([^{}]*)\}/g, (_match, expression: string) => {
    let current = expression;
    let prev: string;
    do {
      prev = current;
      current = current.replace(
        /^(.+?)\s+if\s+(.+?)\s+else\s+(.+)$/,
        '(__pytruthy__($2) ? ($1) : ($3))'
      );
    } while (current !== prev);
    return `\${${current}}`;
  });
}

function rewritePowerOperator(content: string): string {
  return content.replace(/\$\{([^{}]*)\}/g, (_match, expression: string) => {
    const rewritten = expression.replace(
      /([A-Za-z_]\w*|\d+(?:\.\d+)?)\s*\*\*\s*([A-Za-z_]\w*|\d+(?:\.\d+)?)/g,
      'pow($1,$2)'
    );
    return `\${${rewritten}}`;
  });
}

function extractFailedExpression(message: string): string | undefined {
  const raw = /Failed to process expression "([^"]+)"/.exec(message)?.[1];
  if (!raw) {
    return undefined;
  }
  // XacroParser reports either the full attribute value or just the failing
  // `${expr}`. sanitizeXacroContent's Python-expression branch matches the
  // inner body — the surrounding `${...}` is the regex's job. Pull the first
  // `${...}` substring out so the next-attempt sanitiser actually erases the
  // failing fragment; without this, the loop adds the unmatched outer string
  // to skippedExpressions, the sanitiser finds no substring to remove, and
  // the second pass throws again with `skippedExpressions.has(...) === true`.
  const inner = /\$\{([^{}]+)\}/.exec(raw)?.[1];
  if (inner !== undefined) {
    return inner;
  }
  return raw;
}

function summarizeExpressionFailure(message: string): string {
  const summary = message
    .replace(/^[\s\S]*?Failed to process expression "[^"]+"\.\s*/m, '')
    .trim();
  return summary || 'unresolved expression';
}

export function extractXacroArgs(content: string): XacroArgument[] {
  const args: XacroArgument[] = [];
  const regexp = /<xacro:arg\s+([^>]+)>?/g;
  let match: RegExpExecArray | null;
  while ((match = regexp.exec(content)) !== null) {
    const attrs = match[1];
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    if (!name) {
      continue;
    }
    args.push({
      name,
      defaultValue: /default="([^"]*)"/.exec(attrs)?.[1]
    });
  }
  return args;
}

function stringifyArgs(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]));
}
