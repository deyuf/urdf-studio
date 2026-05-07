import * as vscode from 'vscode';
import * as path from 'node:path';
import { analyzeUrdf } from './core/urdfAnalysis';
import { discoverPackages } from './core/packageMap';
import type { JointInfo, PackageMap, RobotMetadata } from './core/types';

const URDF_LIKE_PATTERNS = ['**/*.urdf', '**/*.urdf.xacro', '**/*.xacro'];

interface CachedAnalysis {
  version: number;
  metadata: RobotMetadata;
}

const analysisCache = new Map<string, CachedAnalysis>();

function isUrdfLike(uri: vscode.Uri): boolean {
  const lower = uri.fsPath.toLowerCase();
  return lower.endsWith('.urdf') || lower.endsWith('.urdf.xacro') || lower.endsWith('.xacro');
}

async function ensureAnalysis(document: vscode.TextDocument): Promise<RobotMetadata | undefined> {
  if (!isUrdfLike(document.uri)) {
    return undefined;
  }
  const key = document.uri.toString();
  const cached = analysisCache.get(key);
  if (cached && cached.version === document.version) {
    return cached.metadata;
  }
  const text = document.getText();
  // For language features we work on the raw URDF/xacro text.  We do NOT
  // expand xacro: that would be too slow per keystroke and the metadata is
  // best-effort here.  analyzeUrdf is robust to xacro left in place — it
  // simply ignores tags it does not understand.
  const packages: PackageMap = {};
  const metadata = analyzeUrdf(text, document.uri.fsPath, packages);
  analysisCache.set(key, { version: document.version, metadata });
  return metadata;
}

function locateNamedTag(text: string, tag: string, name: string): { offset: number; length: number } | undefined {
  const escaped = name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const pattern = new RegExp(`<${tag}\\b[^>]*\\bname="${escaped}"`, 'g');
  const match = pattern.exec(text);
  if (!match) {
    return undefined;
  }
  return { offset: match.index, length: match[0].length };
}

function rangeForLine(document: vscode.TextDocument, oneBasedLine: number | undefined): vscode.Range | undefined {
  if (!oneBasedLine || oneBasedLine < 1 || oneBasedLine > document.lineCount) {
    return undefined;
  }
  const line = document.lineAt(oneBasedLine - 1);
  return new vscode.Range(line.range.start, line.range.end);
}

function wordRangeForLinkOrJoint(document: vscode.TextDocument, position: vscode.Position): { kind: 'link' | 'joint' | 'parent' | 'child' | 'mimic'; name: string; range: vscode.Range } | undefined {
  const line = document.lineAt(position.line).text;
  const offsetInLine = position.character;

  const matchers: Array<{ kind: 'link' | 'joint' | 'parent' | 'child' | 'mimic'; pattern: RegExp }> = [
    { kind: 'parent', pattern: /<parent\s+link="([^"]+)"/g },
    { kind: 'child', pattern: /<child\s+link="([^"]+)"/g },
    { kind: 'mimic', pattern: /<mimic\s+joint="([^"]+)"/g },
    { kind: 'link', pattern: /<link\s+name="([^"]+)"/g },
    { kind: 'joint', pattern: /<joint\s+name="([^"]+)"/g }
  ];

  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.pattern.exec(line)) !== null) {
      const valueStart = match.index + match[0].lastIndexOf(match[1]);
      const valueEnd = valueStart + match[1].length;
      if (offsetInLine >= valueStart && offsetInLine <= valueEnd) {
        return {
          kind: matcher.kind,
          name: match[1],
          range: new vscode.Range(position.line, valueStart, position.line, valueEnd)
        };
      }
    }
  }

  return undefined;
}

function describeJoint(joint: JointInfo | undefined): string {
  if (!joint) {
    return '';
  }
  const lines: string[] = [];
  lines.push(`**Joint** \`${joint.name}\``);
  lines.push(`- Type: \`${joint.type}\``);
  if (joint.parent || joint.child) {
    lines.push(`- Parent → child: \`${joint.parent ?? '?'}\` → \`${joint.child ?? '?'}\``);
  }
  lines.push(`- Axis: \`${joint.axis.join(' ')}\``);
  if (joint.limit.lower !== undefined || joint.limit.upper !== undefined) {
    lines.push(`- Limits: \`${joint.limit.lower ?? '?'} .. ${joint.limit.upper ?? '?'}\``);
  }
  if (joint.limit.effort !== undefined) {
    lines.push(`- Effort: \`${joint.limit.effort}\``);
  }
  if (joint.limit.velocity !== undefined) {
    lines.push(`- Velocity: \`${joint.limit.velocity}\``);
  }
  if (joint.mimic) {
    lines.push(`- Mimic: \`${joint.mimic.joint}\` × ${joint.mimic.multiplier} + ${joint.mimic.offset}`);
  }
  return lines.join('\n');
}

class UrdfHoverProvider implements vscode.HoverProvider {
  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const target = wordRangeForLinkOrJoint(document, position);
    if (!target) {
      return undefined;
    }
    const metadata = await ensureAnalysis(document);
    if (!metadata) {
      return undefined;
    }
    if (target.kind === 'joint' || target.kind === 'mimic') {
      return new vscode.Hover(new vscode.MarkdownString(describeJoint(metadata.joints[target.name])), target.range);
    }
    if (target.kind === 'parent' || target.kind === 'child') {
      const link = metadata.links[target.name];
      const parentJoint = link?.parentJoint ? metadata.joints[link.parentJoint] : undefined;
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Link** \`${target.name}\`\n`);
      md.appendMarkdown(`- Children: \`${link?.childJoints.length ?? 0}\`\n`);
      if (parentJoint) {
        md.appendMarkdown(`- Parent joint: \`${parentJoint.name}\` (${parentJoint.type})\n`);
      }
      if (link?.inertial) {
        md.appendMarkdown(`- Mass: \`${link.inertial.mass}\`\n`);
      }
      return new vscode.Hover(md, target.range);
    }
    if (target.kind === 'link') {
      const link = metadata.links[target.name];
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Link** \`${target.name}\`\n`);
      md.appendMarkdown(`- Children: \`${link?.childJoints.length ?? 0}\`\n`);
      if (link?.inertial) {
        md.appendMarkdown(`- Mass: \`${link.inertial.mass}\`\n`);
      }
      return new vscode.Hover(md, target.range);
    }
    return undefined;
  }
}

class UrdfDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Definition | undefined> {
    const target = wordRangeForLinkOrJoint(document, position);
    if (!target) {
      return undefined;
    }
    const text = document.getText();
    if (target.kind === 'parent' || target.kind === 'child' || target.kind === 'link') {
      const located = locateNamedTag(text, 'link', target.name);
      if (!located) {
        return undefined;
      }
      const start = document.positionAt(located.offset);
      return new vscode.Location(document.uri, new vscode.Range(start, document.positionAt(located.offset + located.length)));
    }
    if (target.kind === 'mimic' || target.kind === 'joint') {
      const located = locateNamedTag(text, 'joint', target.name);
      if (!located) {
        return undefined;
      }
      const start = document.positionAt(located.offset);
      return new vscode.Location(document.uri, new vscode.Range(start, document.positionAt(located.offset + located.length)));
    }
    return undefined;
  }
}

class UrdfReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Location[] | undefined> {
    const target = wordRangeForLinkOrJoint(document, position);
    if (!target) {
      return undefined;
    }
    const text = document.getText();
    const escaped = target.name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    const patterns = target.kind === 'joint' || target.kind === 'mimic'
      ? [new RegExp(`<joint\\s+name="${escaped}"`, 'g'), new RegExp(`<mimic\\s+joint="${escaped}"`, 'g')]
      : [
        new RegExp(`<link\\s+name="${escaped}"`, 'g'),
        new RegExp(`<parent\\s+link="${escaped}"`, 'g'),
        new RegExp(`<child\\s+link="${escaped}"`, 'g')
      ];
    const locations: vscode.Location[] = [];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const start = document.positionAt(match.index);
        locations.push(new vscode.Location(document.uri, new vscode.Range(start, document.positionAt(match.index + match[0].length))));
      }
    }
    return locations;
  }
}

class UrdfDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  async provideDocumentSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    const metadata = await ensureAnalysis(document);
    if (!metadata) {
      return [];
    }
    const symbols: vscode.DocumentSymbol[] = [];

    if (Object.keys(metadata.links).length > 0) {
      const linksRoot = new vscode.DocumentSymbol(
        'links',
        `${Object.keys(metadata.links).length} links`,
        vscode.SymbolKind.Namespace,
        new vscode.Range(0, 0, document.lineCount, 0),
        new vscode.Range(0, 0, 0, 0)
      );
      for (const link of Object.values(metadata.links)) {
        const range = rangeForLine(document, link.line) ?? new vscode.Range(0, 0, 0, 0);
        linksRoot.children.push(new vscode.DocumentSymbol(link.name, '', vscode.SymbolKind.Class, range, range));
      }
      symbols.push(linksRoot);
    }

    if (Object.keys(metadata.joints).length > 0) {
      const jointsRoot = new vscode.DocumentSymbol(
        'joints',
        `${Object.keys(metadata.joints).length} joints`,
        vscode.SymbolKind.Namespace,
        new vscode.Range(0, 0, document.lineCount, 0),
        new vscode.Range(0, 0, 0, 0)
      );
      for (const joint of Object.values(metadata.joints)) {
        const range = rangeForLine(document, joint.line) ?? new vscode.Range(0, 0, 0, 0);
        const detail = `${joint.type}${joint.parent && joint.child ? ` (${joint.parent} → ${joint.child})` : ''}`;
        jointsRoot.children.push(new vscode.DocumentSymbol(joint.name, detail, vscode.SymbolKind.Function, range, range));
      }
      symbols.push(jointsRoot);
    }

    return symbols;
  }
}

class UrdfCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const metadata = await ensureAnalysis(document);
    if (!metadata) {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const robotMatch = /<robot\b[^>]*>/.exec(text);
    if (robotMatch) {
      const start = document.positionAt(robotMatch.index);
      const range = new vscode.Range(start.line, 0, start.line, 0);
      lenses.push(new vscode.CodeLens(range, {
        title: `$(open-preview) URDF Studio: ${metadata.counts.links} links · ${metadata.counts.movableJoints} movable joints`,
        command: 'urdfStudio.openPreview'
      }));
    }
    return lenses;
  }
}

const MISSING_MESH_CODE = 'mesh.missing';
const MISSING_LIMIT_CODE = 'joint.limitMissing';

class UrdfCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.code === MISSING_MESH_CODE) {
        const action = await this.buildMissingMeshAction(document, diagnostic);
        if (action) {
          actions.push(...action);
        }
      } else if (diagnostic.code === MISSING_LIMIT_CODE) {
        const action = this.buildLimitInsertAction(document, diagnostic);
        if (action) {
          actions.push(action);
        }
      }
    }
    void range;
    return actions;
  }

  private async buildMissingMeshAction(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): Promise<vscode.CodeAction[] | undefined> {
    const lineText = document.lineAt(diagnostic.range.start.line).text;
    const filenameMatch = /filename="([^"]+)"/.exec(lineText);
    if (!filenameMatch) {
      return undefined;
    }
    const filename = filenameMatch[1];
    const baseName = path.basename(filename);
    if (!baseName) {
      return undefined;
    }
    const candidates = await vscode.workspace.findFiles(`**/${baseName}`, '**/{node_modules,dist,out,build}/**', 5);
    if (candidates.length === 0) {
      return undefined;
    }
    const documentDir = path.dirname(document.uri.fsPath);
    const packageRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const packages = await discoverPackages(packageRoots).catch(() => ({} as PackageMap));

    const result: vscode.CodeAction[] = [];
    for (const candidate of candidates) {
      const replacement = preferPackageUri(candidate.fsPath, packages) ?? toRelativeUri(candidate.fsPath, documentDir);
      const action = new vscode.CodeAction(`Replace mesh with ${vscode.workspace.asRelativePath(candidate)}`, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.edit = new vscode.WorkspaceEdit();
      const filenameStart = lineText.indexOf(filename);
      const lineNumber = diagnostic.range.start.line;
      action.edit.replace(
        document.uri,
        new vscode.Range(lineNumber, filenameStart, lineNumber, filenameStart + filename.length),
        replacement
      );
      result.push(action);
    }
    return result;
  }

  private buildLimitInsertAction(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction | undefined {
    const startLine = diagnostic.range.start.line;
    let insertLine: number | undefined;
    let indent = '  ';
    for (let i = startLine; i < Math.min(document.lineCount, startLine + 30); i += 1) {
      const text = document.lineAt(i).text;
      if (/<\/joint>/.test(text)) {
        insertLine = i;
        const earlierIndent = /^(\s*)/.exec(document.lineAt(Math.max(startLine, i - 1)).text);
        if (earlierIndent) {
          indent = earlierIndent[1] + '  ';
        }
        break;
      }
    }
    if (insertLine === undefined) {
      return undefined;
    }
    const action = new vscode.CodeAction('Insert default <limit>', vscode.CodeActionKind.QuickFix);
    action.diagnostics = [diagnostic];
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(
      document.uri,
      new vscode.Position(insertLine, 0),
      `${indent}<limit lower="-1.57" upper="1.57" effort="100" velocity="1.0"/>\n`
    );
    return action;
  }
}

function preferPackageUri(absolutePath: string, packages: PackageMap): string | undefined {
  const resolved = path.resolve(absolutePath);
  for (const entry of Object.values(packages)) {
    const root = path.resolve(entry.path);
    const rel = path.relative(root, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `package://${entry.name}/${rel.split(path.sep).join('/')}`;
    }
  }
  return undefined;
}

function toRelativeUri(absolutePath: string, documentDir: string): string {
  const rel = path.relative(documentDir, absolutePath);
  return rel.split(path.sep).join('/');
}

export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
  const selector: vscode.DocumentSelector = URDF_LIKE_PATTERNS.map(pattern => ({ scheme: 'file', pattern }));

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, new UrdfHoverProvider()),
    vscode.languages.registerDefinitionProvider(selector, new UrdfDefinitionProvider()),
    vscode.languages.registerReferenceProvider(selector, new UrdfReferenceProvider()),
    vscode.languages.registerDocumentSymbolProvider(selector, new UrdfDocumentSymbolProvider()),
    vscode.languages.registerCodeLensProvider(selector, new UrdfCodeLensProvider()),
    vscode.languages.registerCodeActionsProvider(selector, new UrdfCodeActionProvider(), {
      providedCodeActionKinds: UrdfCodeActionProvider.providedCodeActionKinds
    }),
    vscode.workspace.onDidCloseTextDocument(document => analysisCache.delete(document.uri.toString())),
    vscode.workspace.onDidChangeTextDocument(event => analysisCache.delete(event.document.uri.toString()))
  );
}

export const __test = {
  isUrdfLike,
  ensureAnalysis,
  wordRangeForLinkOrJoint,
  preferPackageUri,
  toRelativeUri
};
