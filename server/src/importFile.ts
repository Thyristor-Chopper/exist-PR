import JSZip from 'jszip';
import * as Y from 'yjs';
import crypto from 'node:crypto';

/*
 * 업로드 임포트 — csv/xlsx → 협업 시트, txt·md/docx → 협업 문서.
 * SheetEditor 구조: getMap('sheets') { id → {name, ord, cellsKey} } + getMap(cellsKey)에 A1 키.
 * DocEditor 구조: getMap('docs') { id → {name, ord} } + getXmlFragment(`doc:${id}`)에 paragraph들.
 * 시트 그리드는 에디터 한계(26열×60행)에 맞춰 자른다.
 */

const MAX_COLS = 26;
const MAX_ROWS = 60;

function colLetter(i: number): string {
  return String.fromCharCode(65 + i);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

/** CSV 파싱 — 따옴표·개행 처리 포함 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      rows.push(row);
      row = [];
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** xlsx → 시트별 그리드 (값만, 수식은 계산값) */
export async function parseXlsx(buf: Buffer): Promise<{ name: string; grid: string[][] }[]> {
  const zip = await JSZip.loadAsync(buf);
  const wbXml = await zip.file('xl/workbook.xml')?.async('string');
  if (!wbXml) throw new Error('워크북 없음');
  const relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';
  const relMap = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(m[1], m[2].replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/'));
  }
  // 공유 문자열
  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) ?? '';
  const shared: string[] = [];
  for (const m of sstXml.matchAll(/<(?:\w+:)?si(?: [^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g)) {
    const texts = [...m[1].matchAll(/<(?:\w+:)?t(?:[ >][^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((t) => decodeEntities(t[1]));
    shared.push(texts.join(''));
  }
  const out: { name: string; grid: string[][] }[] = [];
  // 속성 순서는 생성기마다 달라서 개별 추출 (엑셀·한셀·구글시트 호환)
  const sheetTags = [...wbXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)];
  for (let si = 0; si < sheetTags.length; si++) {
    const attrs = sheetTags[si][1];
    const name = decodeEntities(/name="([^"]*)"/.exec(attrs)?.[1] ?? `시트${si + 1}`);
    const rid = /r:id="([^"]+)"/.exec(attrs)?.[1];
    const target = (rid && relMap.get(rid)) || `xl/worksheets/sheet${si + 1}.xml`;
    const xml = await zip.file(target)?.async('string');
    if (!xml) continue;
    const grid: string[][] = [];
    for (const c of xml.matchAll(/<(?:\w+:)?c ([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? '';
      const refM = /r="([A-Z]+)(\d+)"/.exec(attrs);
      if (!refM) continue;
      const colStr = refM[1];
      if (colStr.length > 1) continue; // 26열(A~Z) 초과는 버림
      const col = colStr.charCodeAt(0) - 65;
      const row = parseInt(refM[2], 10) - 1;
      if (col >= MAX_COLS || row >= MAX_ROWS || row < 0) continue;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let val = '';
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr')
        val = [...inner.matchAll(/<(?:\w+:)?t(?:[ >][^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((t) => decodeEntities(t[1])).join('');
      else val = v != null ? decodeEntities(v) : '';
      if (val === '') continue;
      while (grid.length <= row) grid.push([]);
      grid[row][col] = val;
    }
    out.push({ name, grid });
  }
  if (!out.length) throw new Error('시트 없음');
  return out;
}

/** docx → 문단 텍스트 배열 */
export async function parseDocx(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('본문 없음');
  const paras: string[] = [];
  for (const p of xml.matchAll(/<w:p(?:[ >][\s\S]*?<\/w:p>|\/>)/g)) {
    const text = [...p[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
      .map((t) => decodeEntities(t[1]))
      .join('');
    paras.push(text);
  }
  // 앞뒤 빈 문단 정리
  while (paras.length && paras[0].trim() === '') paras.shift();
  while (paras.length && paras[paras.length - 1].trim() === '') paras.pop();
  if (!paras.length) throw new Error('내용 없음');
  return paras;
}

/** 시트 Y.Doc 구성 — 여러 시트 지원 */
export function buildSheetYdoc(doc: Y.Doc, sheets: { name: string; grid: string[][] }[]) {
  const meta = doc.getMap<{ name: string; ord: number; cellsKey: string }>('sheets');
  sheets.forEach((s, i) => {
    const id = crypto.randomUUID();
    const cellsKey = `cells:${id}`;
    meta.set(id, { name: s.name || `시트${i + 1}`, ord: i + 1, cellsKey });
    const cells = doc.getMap(cellsKey);
    s.grid.slice(0, MAX_ROWS).forEach((row, r) => {
      (row ?? []).slice(0, MAX_COLS).forEach((val, c) => {
        if (val != null && val !== '') cells.set(`${colLetter(c)}${r + 1}`, String(val));
      });
    });
  });
}

/** 문서 Y.Doc 구성 — 문단 텍스트를 TipTap paragraph로 */
export function buildDocYdoc(doc: Y.Doc, docName: string, paragraphs: string[]) {
  const docsMap = doc.getMap<{ name: string; ord: number }>('docs');
  const id = crypto.randomUUID();
  docsMap.set(id, { name: docName || '문서 1', ord: 1 });
  const frag = doc.getXmlFragment(`doc:${id}`);
  const nodes = paragraphs.map((t) => {
    const p = new Y.XmlElement('paragraph');
    if (t) p.insert(0, [new Y.XmlText(t)]);
    return p;
  });
  frag.insert(0, nodes);
}

/** 마크다운 기본 구조 임포트 — #/## 제목, -/* 목록, 나머지는 문단 */
export function buildDocYdocFromMarkdown(doc: Y.Doc, docName: string, md: string) {
  const docsMap = doc.getMap<{ name: string; ord: number }>('docs');
  const id = crypto.randomUUID();
  docsMap.set(id, { name: docName || '문서 1', ord: 1 });
  const frag = doc.getXmlFragment(`doc:${id}`);

  const para = (text: string, nodeName = 'paragraph', level?: number) => {
    const el = new Y.XmlElement(nodeName);
    if (level != null) el.setAttribute('level', level as unknown as string);
    const clean = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    if (clean) el.insert(0, [new Y.XmlText(clean)]);
    return el;
  };

  const nodes: Y.XmlElement[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    const ul = new Y.XmlElement('bulletList');
    ul.insert(
      0,
      listItems.map((item) => {
        const li = new Y.XmlElement('listItem');
        li.insert(0, [para(item)]);
        return li;
      }),
    );
    nodes.push(ul);
    listItems = [];
  };

  for (const raw of md.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      nodes.push(para(h[2], 'heading', h[1].length === 1 ? 1 : 2));
    } else if (li) {
      listItems.push(li[1]);
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      nodes.push(para(line));
    }
  }
  flushList();
  if (!nodes.length) nodes.push(para(''));
  frag.insert(0, nodes);
}
