import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import YAML from 'yaml';
import { XacroParser } from 'xacro-parser';
import type { PackageMap, RenderedRobotDocument, StudioDiagnostic, XacroArgument } from './types';

type LogFn = (message: string) => void;
const MAX_XACRO_RECOVERY_ATTEMPTS = 16;
let logFn: LogFn = () => {};

export function setLogger(fn: LogFn): void {
  logFn = fn;
}

export async function renderRobotDocument(
  sourcePath: string,
  packages: PackageMap,
  xacroArguments: Record<string, unknown>
): Promise<RenderedRobotDocument> {
  const content = await fs.readFile(sourcePath, 'utf8');
  const isXacro = sourcePath.endsWith('.xacro') || sourcePath.endsWith('.urdf.xacro');
  if (!isXacro) {
    return {
      sourcePath,
      format: 'urdf',
      urdf: content,
      xacroArgs: extractXacroArgs(content),
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
  const diagnostics: StudioDiagnostic[] = [];
  const window = new JSDOM('<root/>', { contentType: 'text/xml' }).window;
  const previousDomParser = (globalThis as { DOMParser?: typeof window.DOMParser }).DOMParser;
  const previousXmlSerializer = (globalThis as { XMLSerializer?: typeof window.XMLSerializer }).XMLSerializer;
  (globalThis as { DOMParser?: typeof window.DOMParser }).DOMParser = window.DOMParser;
  (globalThis as { XMLSerializer?: typeof window.XMLSerializer }).XMLSerializer = window.XMLSerializer;

  try {
    const xml = await parseXacroWithRecovery(sourcePath, content, packages, xacroArguments, diagnostics);
    const serializer = new window.XMLSerializer();
    return {
      sourcePath,
      format: 'xacro',
      urdf: serializer.serializeToString(xml),
      xacroArgs: extractXacroArgs(content),
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
      diagnostics
    };
  } finally {
    (globalThis as { DOMParser?: typeof window.DOMParser }).DOMParser = previousDomParser;
    (globalThis as { XMLSerializer?: typeof window.XMLSerializer }).XMLSerializer = previousXmlSerializer;
    window.close();
  }
}

async function parseXacroWithRecovery(
  sourcePath: string,
  content: string,
  packages: PackageMap,
  xacroArguments: Record<string, unknown>,
  diagnostics: StudioDiagnostic[]
): Promise<Document> {
  const skippedExpressions = new Set<string>();

  for (let attempt = 0; attempt <= MAX_XACRO_RECOVERY_ATTEMPTS; attempt += 1) {
    const attemptDiagnostics: StudioDiagnostic[] = [];
    try {
      const parser = createXacroParser(sourcePath, packages, xacroArguments, attemptDiagnostics, skippedExpressions);
      const sanitizedContent = sanitizeXacroContent(content, skippedExpressions);
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
  skippedExpressions: ReadonlySet<string>
): XacroParser {
  const parser = new XacroParser();
  parser.inOrder = true;
  parser.requirePrefix = true;
  parser.localProperties = true;
  parser.workingPath = `${path.dirname(sourcePath)}${path.sep}`;
  parser.arguments = stringifyArgs(xacroArguments);
  parser.getFileContents = async includePath => {
    const includeContent = await fs.readFile(includePath, 'utf8');
    return sanitizeXacroContent(includeContent, skippedExpressions);
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
    const resolvedPath = path.isAbsolute(yamlPath) ? yamlPath : path.resolve(path.dirname(sourcePath), yamlPath);
    return YAML.parse(readFileSync(resolvedPath, 'utf8'));
  };
  functions.bool = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
  functions.float = (value: unknown) => Number(value);
  functions.int = (value: unknown) => Math.trunc(Number(value));
  functions.str = (value: unknown) => String(value);

  return parser;
}

function sanitizeXacroContent(content: string, skippedExpressions: ReadonlySet<string>): string {
  let sanitized = content;
  for (const expression of skippedExpressions) {
    sanitized = sanitized.split(expression).join('');
  }
  return sanitized;
}

function extractFailedExpression(message: string): string | undefined {
  return /Failed to process expression "([^"]+)"/.exec(message)?.[1];
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
