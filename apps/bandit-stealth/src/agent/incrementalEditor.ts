import * as path from 'path';
import * as ts from 'typescript';

export interface IncrementalEditResult {
  content: string;
  replaced: number;
  total: number;
  confidence: number;
}

interface StatementInfo {
  name: string;
  start: number;
  end: number;
  text: string;
}

function canHandle(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return ext === '.ts' || ext === '.tsx';
}

function collectStatements(sourceFile: ts.SourceFile): StatementInfo[] {
  const statements: StatementInfo[] = [];
  for (const node of sourceFile.statements) {
    const name = getNodeName(node, sourceFile);
    if (!name) {
      continue;
    }
    statements.push({
      name,
      start: node.getFullStart(),
      end: node.getEnd(),
      text: node.getFullText(sourceFile)
    });
  }
  return statements;
}

function getNodeName(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return node.name?.getText(sourceFile);
  }
  if (ts.isEnumDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return node.name.getText(sourceFile);
  }
  if (ts.isVariableStatement(node)) {
    const [decl] = node.declarationList.declarations;
    if (!decl) {
      return undefined;
    }
    return decl.name.getText(sourceFile);
  }
  return undefined;
}

export function applyIncrementalEdits(original: string, updated: string, fileName: string): IncrementalEditResult {
  if (!canHandle(fileName)) {
    return { content: updated, replaced: 0, total: 0, confidence: 1 };
  }

  try {
    const originalFile = ts.createSourceFile(fileName, original, ts.ScriptTarget.Latest, true);
    const updatedFile = ts.createSourceFile(fileName, updated, ts.ScriptTarget.Latest, true);
    const originalStatements = collectStatements(originalFile);
    const updatedStatements = collectStatements(updatedFile);

    if (originalStatements.length === 0 || updatedStatements.length === 0) {
      return { content: updated, replaced: 0, total: updatedStatements.length, confidence: 1 };
    }

    const originalMap = new Map<string, StatementInfo>();
    for (const statement of originalStatements) {
      if (!originalMap.has(statement.name)) {
        originalMap.set(statement.name, statement);
      }
    }

    const edits: Array<{ start: number; end: number; text: string }> = [];
    let replaced = 0;
    for (const statement of updatedStatements) {
      const prior = originalMap.get(statement.name);
      if (!prior) {
        continue;
      }
      if (prior.text === statement.text) {
        continue;
      }
      edits.push({ start: prior.start, end: prior.end, text: statement.text });
      replaced += 1;
    }

    if (edits.length === 0) {
      return { content: updated, replaced: 0, total: updatedStatements.length, confidence: 1 };
    }

    let finalText = original;
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) {
      finalText = `${finalText.slice(0, edit.start)}${edit.text}${finalText.slice(edit.end)}`;
    }

    const total = Math.max(updatedStatements.length, 1);
    const confidence = Math.max(0.1, Math.min(1, 1 - replaced / total));
    return { content: finalText, replaced, total, confidence };
  } catch {
    return { content: updated, replaced: 0, total: 0, confidence: 0.75 };
  }
}
