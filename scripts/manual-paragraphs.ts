// Manual paragraph-length check: flags any <p> in the in-app manual sections
// that holds more than MAX_WORDS words of visible text.
//
// Usage:
//   npx tsx scripts/manual-paragraphs.ts            report only (exit 0)
//   npx tsx scripts/manual-paragraphs.ts --fail     exit 1 when any paragraph is too long
//   npx tsx scripts/manual-paragraphs.ts --file voice.tsx   limit to files whose name contains the text
//
// Static analysis only: reads client/src/help/manualSections/*.tsx with the
// TypeScript parser and counts words in JSX text and string literals, including
// nested elements such as <Code> and <strong>.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MAX_WORDS = 70;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'client', 'src', 'help', 'manualSections');

function textOf(node: ts.Node): string {
  if (ts.isJsxText(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isJsxExpression(node)) return node.expression ? textOf(node.expression) : '';
  if (ts.isJsxElement(node)) return node.children.map(textOf).join(' ');
  if (ts.isJsxFragment(node)) return node.children.map(textOf).join(' ');
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
  if (ts.isConditionalExpression(node)) return `${textOf(node.whenTrue)} ${textOf(node.whenFalse)}`;
  if (ts.isBinaryExpression(node)) return `${textOf(node.left)} ${textOf(node.right)}`;
  return '';
}

export interface LongParagraph { file: string; line: number; words: number; start: string }

export function findLongParagraphs(file: string, source: string, max = MAX_WORDS): LongParagraph[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: LongParagraph[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === 'p') {
      const text = textOf(node).replace(/\s+/g, ' ').trim();
      const words = text ? text.split(' ').length : 0;
      if (words > max) {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, words, start: text.slice(0, 60) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const fail = args.includes('--fail');
  const fi = args.indexOf('--file');
  const only = fi >= 0 ? args[fi + 1] : '';
  const files = readdirSync(DIR).filter((f) => f.endsWith('.tsx') && (!only || f.includes(only))).sort();
  const found: LongParagraph[] = [];
  for (const f of files) found.push(...findLongParagraphs(f, readFileSync(join(DIR, f), 'utf8')));
  for (const p of found) console.log(`${p.file}:${p.line}: ${p.words} words: ${p.start}...`);
  const perFile = new Map<string, number>();
  for (const p of found) perFile.set(p.file, (perFile.get(p.file) ?? 0) + 1);
  console.log(`manual paragraphs over ${MAX_WORDS} words: ${found.length} in ${perFile.size} of ${files.length} files${fail ? '' : ' (report only)'}`);
  if (fail && found.length) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
