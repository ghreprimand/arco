import { createRequire } from 'node:module';
import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import * as XLSX from 'xlsx';
import * as CFB from 'cfb';
import { imageResult, imageType } from './images.js';
import { positive, selection, textResult, type FileContentBlock, type FileContentOptions, type FileContentResult } from './types.js';
const require = createRequire(import.meta.url);
type Xml = { nodeType: number; localName?: string; nodeName: string; textContent: string | null; childNodes: ArrayLike<Xml>; getAttribute?: (name: string) => string | null };
type Unit = { label: string; text: string; images: string[] };

function xml(bytes: Uint8Array): Xml {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Document XML declarations are not accepted');
  return new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(message); } }).parseFromString(text, 'text/xml') as unknown as Xml;
}
function nodes(root: Xml, name: string): Xml[] {
  const out: Xml[] = [];
  const walk = (n: Xml) => { if (n.localName === name) out.push(n); for (const c of Array.from(n.childNodes ?? [])) walk(c); };
  walk(root); return out;
}
function rendered(n: Xml): string {
  if (n.nodeType === 3) return n.textContent ?? '';
  const tag = n.localName;
  if (tag === 'br') return n.getAttribute?.('w:type') === 'page' ? '\f' : '\n';
  if (tag === 'tab') return '\t';
  const text = Array.from(n.childNodes ?? []).map(rendered).join('');
  if (tag === 'p' || tag === 'h') return text + '\n';
  if (tag === 'tc' || tag === 'table-cell') return text.trimEnd() + '\t';
  if (tag === 'tr' || tag === 'table-row') return text.trimEnd() + '\n';
  return text;
}
function zipParts(bytes: Buffer): Record<string, Uint8Array> {
  const sizes = new Map<string, number>();
  unzipSync(bytes, { filter: f => {
    if (sizes.size >= 4096) throw new Error('Document archive has too many entries');
    if (!f.name.endsWith('/')) sizes.set(f.name, f.originalSize);
    return false;
  } });
  const cache: Record<string, Uint8Array> = {}; let total = 0;
  return new Proxy(cache, {
    ownKeys: () => [...sizes.keys()],
    has: (_target, key) => typeof key === 'string' && sizes.has(key),
    getOwnPropertyDescriptor: (_target,key) => typeof key === 'string' && sizes.has(key) ? {enumerable:true,configurable:true} : undefined,
    get: (target,key) => {
      if (typeof key !== 'string' || !sizes.has(key)) return undefined;
      if (Object.hasOwn(target,key)) return target[key];
      const size=sizes.get(key)!;
      if (size>512*1024*1024 || (key.endsWith('.xml') && size>32*1024*1024) || (total+=size)>512*1024*1024) throw new Error('Selected document parts exceed the safe expansion limit; select a smaller range');
      const decoded=unzipSync(bytes,{filter:f=>f.name===key});
      target[key]=decoded[key];return target[key];
    },
  });
}
function referencedImages(root: Xml, part: string, parts: Record<string, Uint8Array>): string[] {
  const rel = posix.join(posix.dirname(part), '_rels', posix.basename(part) + '.rels');
  const links = new Map<string, string>();
  if (parts[rel]) for (const r of nodes(xml(parts[rel]), 'Relationship')) {
    if (r.getAttribute?.('TargetMode') === 'External') continue;
    const target = r.getAttribute?.('Target'); const id = r.getAttribute?.('Id');
    if (target && id) links.set(id, posix.normalize(posix.join(posix.dirname(part), target)));
  }
  const out = new Set<string>();
  for (const n of [...nodes(root, 'blip'), ...nodes(root, 'imagedata')]) {
    const id = n.getAttribute?.('r:embed') ?? n.getAttribute?.('r:id');
    if (id && links.has(id)) out.add(links.get(id)!);
  }
  for (const n of nodes(root, 'image')) {
    const target = n.getAttribute?.('xlink:href');
    if (target && !target.includes(':')) out.add(posix.normalize(target.replace(/^\.\//, '')));
  }
  return [...out].filter(p => p in parts);
}
function sections(root: Xml, part: string, parts: Record<string, Uint8Array>): Unit[] {
  const units: Unit[] = []; let text = '', images: string[] = [];
  const flush = () => { if (text.trim() || images.length) units.push({ label: `Section ${units.length + 1}`, text, images }); text = ''; images = []; };
  for (const child of Array.from(root.childNodes)) {
    const body = rendered(child);
    const refs = referencedImages(child, part, parts);
    for (const [i, chunk] of body.split('\f').entries()) {
      if (i > 0 || text.length + chunk.length > 12000) flush();
      text += chunk; images.push(...refs);
    }
  }
  flush(); return units.length ? units : [{ label: 'Section 1', text: rendered(root), images: referencedImages(root, part, parts) }];
}
async function finish(units: Unit[], parts: Record<string, Uint8Array>, name: string, kind: string, bytes: number, options: FileContentOptions): Promise<FileContentResult> {
  const selected = selection(options.pages, units.length, 100);
  const chosen = selected.map(i => units[i]);
  const result = textResult(kind, `document: ${name}, ${kind}, ${bytes} bytes, units ${selected.map(i => i + 1).join(', ')} of ${units.length}\n\n` + chosen.map(u => `${u.label}\n${u.text}`).join('\n\n'), options, undefined, selected.length < units.length);
  const blocks: FileContentBlock[] = [...result.blocks];
  const cap = positive(options.limits?.maxImages, 20, 100);
  const images = [...new Set(chosen.flatMap(u => u.images))];
  for (const path of images.slice(0, cap)) {
    const data = parts[path]; if (!data || !imageType(data)) continue;
    try { blocks.push(...(await imageResult(Buffer.from(data), posix.basename(path), options)).blocks); }
    catch { blocks.push({ type: 'text', text: `[Embedded image ${posix.basename(path)} could not be decoded.]` }); }
  }
  if (images.length > cap) blocks.push({ type: 'text', text: '[Additional embedded images omitted; select a smaller range.]' });
  return { ...result, blocks };
}

// Legacy PowerPoint containers and text atoms (MS-PPT). Records are bounded
// by their enclosing stream; VBA and embedded programs are never executed.
function powerpointText(bytes: Buffer): Unit[] {
  const units: Unit[] = []; let current: Unit = { label: 'Slide 1', text: '', images: [] };
  const walk = (start: number, end: number, depth: number) => {
    if (depth > 64) throw new Error('PowerPoint record nesting exceeds its limit');
    for (let i = start; i + 8 <= end;) {
      const header = bytes.readUInt16LE(i), type = bytes.readUInt16LE(i + 2), size = bytes.readUInt32LE(i + 4), next = i + 8 + size;
      if (next > end || next <= i) throw new Error('Malformed PowerPoint record');
      if (type === 1006) { if (current.text) units.push(current); current = { label: `Slide ${units.length + 1}`, text: '', images: [] }; }
      if ((header & 15) === 15) walk(i + 8, next, depth + 1);
      else if (type === 4000) current.text += bytes.toString('utf16le', i + 8, next).replace(/\r/g, '\n') + '\n';
      else if (type === 4008) current.text += new TextDecoder('windows-1252').decode(bytes.subarray(i + 8, next)).replace(/\r/g, '\n') + '\n';
      i = next;
    }
  };
  walk(0, bytes.length, 0); if (current.text) units.push(current);
  return units.length ? units : [{ label: 'Slide 1', text: '[No extractable slide text.]', images: [] }];
}

export async function officeResult(bytes: Buffer, name: string, options: FileContentOptions): Promise<FileContentResult> {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const parts = zipParts(bytes);
    if (parts['word/document.xml']) {
      const doc = xml(parts['word/document.xml']);
      return finish(sections(nodes(doc, 'body')[0] ?? doc, 'word/document.xml', parts), parts, name, 'docx', bytes.length, options);
    }
    const slides = Object.keys(parts).filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
    if (slides.length) return finish(slides.map((p, i) => { let doc: Xml | undefined; const read=()=>doc??=xml(parts[p]); return { label: `Slide ${i + 1}`, get text() { return rendered(read()); }, get images() { return referencedImages(read(), p, parts); } }; }), parts, name, 'pptx', bytes.length, options);
    if ('xl/workbook.xml' in parts || Buffer.from(parts.mimetype ?? []).toString().includes('spreadsheet')) {
      const names = XLSX.read(bytes, { type: 'buffer', bookSheets: true }).SheetNames;
      const book = XLSX.read(bytes, { type: 'buffer', sheets: selection(options.pages, names.length, 100), cellFormula: false, cellHTML: false, bookVBA: false });
      const units = book.SheetNames.map(label => ({ label: `Sheet: ${label}`, text: book.Sheets[label] ? XLSX.utils.sheet_to_csv(book.Sheets[label], { FS: '\t', RS: '\n' }) : '', images: [] as string[] }));
      // Drawings are independent zip parts; expose their media when reading the whole workbook.
      if (!options.pages && units[0]) units[0].images = Object.keys(parts).filter(p => p.startsWith('xl/media/') || p.startsWith('Pictures/'));
      return finish(units, parts, name, parts['xl/workbook.xml'] ? 'xlsx' : 'ods', bytes.length, options);
    }
    if (parts['content.xml']) {
      const doc = xml(parts['content.xml']), pages = nodes(doc, 'page');
      if (pages.length) return finish(pages.map((p,i) => ({ label: `Slide ${i+1}`, text: rendered(p), images: referencedImages(p,'content.xml',parts) })),parts,name,'odp',bytes.length,options);
      return finish(sections(nodes(doc,'text')[0] ?? doc,'content.xml',parts),parts,name,'odt',bytes.length,options);
    }
    return textResult('binary', `file: ${name}, ZIP archive, ${bytes.length} bytes; not an office document.`, options);
  }
  const container = CFB.read(bytes, { type: 'buffer' });
  const entry = (label: string) => container.FileIndex.find((f, i) => container.FullPaths[i].endsWith('/' + label));
  if (entry('Workbook') || entry('Book')) {
    const names = XLSX.read(bytes, { type: 'buffer', bookSheets: true }).SheetNames;
      const book = XLSX.read(bytes, { type: 'buffer', sheets: selection(options.pages, names.length, 100), cellFormula: false, cellHTML: false, bookVBA: false });
    return finish(book.SheetNames.map(label => ({ label: `Sheet: ${label}`, text: book.Sheets[label] ? XLSX.utils.sheet_to_csv(book.Sheets[label], { FS: '\t' }) : '', images: [] })),{},name,'xls',bytes.length,options);
  }
  const ppt = entry('PowerPoint Document');
  if (ppt?.content) return finish(powerpointText(Buffer.from(ppt.content)),{},name,'ppt',bytes.length,options);
  if (entry('WordDocument')) {
    const Extractor = require('word-extractor') as new () => { extract: (b: Buffer) => Promise<{ getBody: () => string }> };
    const doc = await new Extractor().extract(bytes);
    const text = doc.getBody();
    const units = text.split('\f').map((text,i) => ({ label: `Section ${i+1}`, text, images: [] }));
    return finish(units,{},name,'doc',bytes.length,options);
  }
  return textResult('binary', `file: ${name}, compound binary document, ${bytes.length} bytes; unsupported content.`, options);
}

export async function rtfResult(bytes: Buffer, name: string, options: FileContentOptions): Promise<FileContentResult> {
  const input = bytes.toString('latin1'); let text = '', skip = false, unicodeSkip = 1;
  const stack: Array<{ skip: boolean; unicodeSkip: number }> = [];
  const tokens = input.match(/\\'[0-9a-f]{2}|\\[a-z]+-?\d* ?|\\[^a-z]|[{}]|[^\\{}]+/gi) ?? [];
  let fallback = 0;
  for (const token of tokens) {
    if (token === '{') { stack.push({ skip, unicodeSkip }); continue; }
    if (token === '}') { const prior = stack.pop(); if (prior) ({ skip, unicodeSkip } = prior); continue; }
    if (/^\\(?:fonttbl|colortbl|stylesheet|info|pict|object|header|footer)\b/.test(token) || token === '\\*') { skip = true; continue; }
    if (skip) continue;
    if (token.startsWith('\\')) {
      const unicode = /^\\u(-?\d+)/.exec(token), uc = /^\\uc(\d+)/.exec(token);
      if (uc) unicodeSkip = Math.min(16, Number(uc[1]));
      else if (unicode) { text += String.fromCharCode(Number(unicode[1]) & 0xffff); fallback = unicodeSkip; }
      else if (/^\\(?:par|line|row)\b/.test(token)) text += '\n';
      else if (/^\\(?:tab|cell)\b/.test(token)) text += '\t';
      else if (/^\\page\b/.test(token)) text += '\f';
      else if (/^\\'[0-9a-f]{2}/i.test(token)) { if (fallback) fallback--; else text += new TextDecoder('windows-1252').decode(Uint8Array.of(parseInt(token.slice(2),16))); }
      else if (/^\\[\\{}]$/.test(token)) { if (fallback) fallback--; else text += token.slice(1); }
    } else { const n = Math.min(fallback, token.length); fallback -= n; text += token.slice(n).replace(/[\r\n]/g,''); }
  }
  const units = text.split('\f').map((text,i) => ({ label: `Section ${i+1}`,text,images: [] as string[] }));
  const parts: Record<string,Uint8Array> = {};
  for (const [i, match] of [...input.matchAll(/\{\\pict\b([^{}]*)\}/g)].entries()) {
    const data = match[1].replace(/\\[a-z]+-?\d* ?/gi,'').replace(/\s/g,'');
    if (/^[0-9a-f]+$/i.test(data) && data.length % 2 === 0) { const key=`embedded-${i}`; parts[key]=Buffer.from(data,'hex'); if (!options.pages) units[0].images.push(key); }
  }
  return finish(units,parts,name,'rtf',bytes.length,options);
}
