/* ── 한글(hwpx / OWPML) 파서 — CollabFiles 인앱 미리보기의 순수 로직.
 *
 * 강건화 포인트:
 *  1) 섹션 발견: Contents/section0.xml 하드코딩 대신
 *     META-INF/container.xml → *.hpf(spine) → section*.xml 글롭 → 본문 XML 전수 탐색 순.
 *  2) 네임스페이스 변형: hp:t / t / 임의 prefix 전부 localName 기준으로 파싱.
 *  3) 요소 커버리지: p(문단)·run·t·tbl/tr/tc(표)·tab·br/lineBreak — 어느 깊이에 있어도 수용.
 *  4) 인코딩: BOM(UTF-8/16LE/16BE)·BOM 없는 UTF-16·XML 선언의 encoding 속성 감지.
 *     엔티티: XML 5종 외의 HTML 엔티티(&nbsp; 등)로 파스가 깨지면 치환 후 재시도.
 *  5) 최후 폴백: 구조 파싱이 비면 Contents XML의 텍스트 노드(그마저 없으면 PrvText.txt)를
 *     서식 없는 문단으로 이어붙인다. 그래도 비면 []를 돌려 기존 안내 문구가 뜬다.
 *
 * DOM 의존은 전역 DOMParser·TextDecoder뿐 — Node에서 @xmldom/xmldom을 주입하면 단위 테스트 가능. */

export type HwpxBlock = { kind: 'p'; text: string } | { kind: 'table'; rows: string[][] };

/* 기존 상한 유지 + 방어적 가드 */
const MAX_SECTIONS = 20;
const MAX_BLOCKS = 3000;
const MAX_PLAIN_CHARS = 200_000; // 폴백 텍스트 상한 (TextPreview와 동일)
const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 비정상적으로 큰 단일 엔트리는 건너뜀

/* ── 저수준 헬퍼: 어떤 DOM 구현에서도 도는 최소 API(childNodes·nodeType·localName)만 사용 ── */

/** prefix·대소문자를 지운 localName — 'hp:t'든 't'든 'HP:T'든 't' */
function ln(node: Node): string {
  const el = node as Element;
  const raw = el.localName || el.nodeName || '';
  const i = raw.indexOf(':');
  return (i >= 0 ? raw.slice(i + 1) : raw).toLowerCase();
}

function childEls(node: Node): Element[] {
  const out: Element[] = [];
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as Element);
  return out;
}

function forEachEl(root: Node, fn: (el: Element) => void) {
  for (const c of childEls(root)) {
    fn(c);
    forEachEl(c, fn);
  }
}

/** 속성도 prefix 무시하고 localName으로 찾는다 (opf:href 같은 변형 수용) */
function attrOf(el: Element, name: string): string | null {
  const direct = el.getAttribute?.(name);
  if (direct != null && direct !== '') return direct;
  const attrs = el.attributes;
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      const an = a.localName || a.name || '';
      const j = an.indexOf(':');
      if ((j >= 0 ? an.slice(j + 1) : an).toLowerCase() === name.toLowerCase()) return a.value;
    }
  }
  return null;
}

/* ── 인코딩 ── */

/** BOM·UTF-16 휴리스틱·XML 선언의 encoding 속성까지 감지해 디코딩 */
export function decodeBytes(bytes: Uint8Array): string {
  const dec = (label: string, body: Uint8Array): string | null => {
    try {
      return new TextDecoder(label).decode(body);
    } catch {
      return null;
    }
  };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return dec('utf-8', bytes.subarray(3)) ?? '';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return dec('utf-16le', bytes.subarray(2)) ?? '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return dec('utf-16be', bytes.subarray(2)) ?? '';
  // BOM 없는 UTF-16 XML: '<'(0x3C) 뒤에 0x00이 오는 패턴
  if (bytes.length >= 2 && bytes[0] === 0x3c && bytes[1] === 0x00) return dec('utf-16le', bytes) ?? '';
  if (bytes.length >= 2 && bytes[0] === 0x00 && bytes[1] === 0x3c) return dec('utf-16be', bytes) ?? '';
  const utf8 = dec('utf-8', bytes) ?? '';
  // XML 선언이 다른 인코딩을 주장하면 그걸로 재디코딩 (예: euc-kr 변형)
  const m = /^<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(utf8);
  if (m && !/^utf-?8$/i.test(m[1])) {
    const re = dec(m[1].toLowerCase(), bytes);
    if (re != null) return re;
  }
  return utf8;
}

/* ── XML 파싱 (엔티티 강건화 포함) ── */

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
};

/** XML 5종 밖의 named 엔티티를 문자로 치환하고, 헐벗은 &를 이스케이프 — 파스 실패 시 재시도용 */
function sanitizeEntities(xml: string): string {
  return xml
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name: string) => {
      const lower = name.toLowerCase();
      if (lower === 'amp' || lower === 'lt' || lower === 'gt' || lower === 'quot' || lower === 'apos') return m;
      return HTML_ENTITIES[lower] ?? '';
    })
    .replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;');
}

function parseXmlSafe(xml: string): Document | null {
  const tryParse = (s: string): Document | null => {
    try {
      const doc = new DOMParser().parseFromString(s, 'application/xml');
      if (!doc || !doc.documentElement) return null;
      // 브라우저 DOMParser는 실패 시 parsererror 문서를 돌려준다
      if (ln(doc.documentElement) === 'parsererror') return null;
      if (doc.getElementsByTagName('parsererror').length > 0) return null;
      return doc;
    } catch {
      return null;
    }
  };
  // XML 5종 밖의 named 엔티티가 보이면 선제 치환 — 구현체에 따라 파스 실패(브라우저) 또는
  // 리터럴 잔존(xmldom)으로 갈리는 지점이라, 어느 쪽이든 결과가 같게 만든다
  const hasForeignEntity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)[a-zA-Z][a-zA-Z0-9]{0,31};/.test(xml);
  return tryParse(hasForeignEntity ? sanitizeEntities(xml) : xml) ?? tryParse(sanitizeEntities(xml));
}

/* ── 본문 추출 ── */

/** t 요소 내부 텍스트 — 안에 끼어드는 tab·lineBreak 마커까지 문자로 */
function textOfT(t: Node): string {
  let out = '';
  const kids = t.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 3 || n.nodeType === 4) out += n.nodeValue ?? '';
    else if (n.nodeType === 1) {
      const name = ln(n);
      if (name === 'tab') out += '\t';
      else if (name === 'br' || name === 'linebreak') out += '\n';
      else out += textOfT(n);
    }
  }
  return out;
}

/** el 아래 모든 t 텍스트 수집 (표 셀 등) */
function collectT(el: Node, out: string[]) {
  for (const c of childEls(el)) {
    if (ln(c) === 't') out.push(textOfT(c));
    else collectT(c, out);
  }
}

/** 표 → rows. 중첩 표의 tr이 바깥 표 행으로 새지 않게 tbl 경계에서 하강을 멈춘다 */
function tableRows(tbl: Element): string[][] {
  const rows: string[][] = [];
  const findTr = (el: Node) => {
    for (const c of childEls(el)) {
      const name = ln(c);
      if (name === 'tbl') continue;
      if (name === 'tr') {
        const row: string[] = [];
        for (const tc of childEls(c)) {
          if (ln(tc) !== 'tc') continue;
          const parts: string[] = [];
          collectT(tc, parts);
          row.push(parts.join(' ').replace(/\s+/g, ' ').trim());
        }
        if (row.length > 0) rows.push(row);
      } else findTr(c);
    }
  };
  findTr(tbl);
  return rows;
}

/** 문단 하나 → 텍스트 블록(+안에 든 표 블록). run 유무·깊이와 무관하게 t를 찾는다 */
function walkPara(p: Element, blocks: HwpxBlock[]) {
  let buf = '';
  const flush = () => {
    if (buf.trim()) blocks.push({ kind: 'p', text: buf.replace(/\s+$/, '') });
    buf = '';
  };
  const walk = (el: Node) => {
    for (const c of childEls(el)) {
      const name = ln(c);
      if (name === 't') buf += textOfT(c);
      else if (name === 'tab') buf += '\t';
      else if (name === 'br' || name === 'linebreak') buf += '\n';
      else if (name === 'tbl') {
        flush();
        const rows = tableRows(c);
        if (rows.length > 0) blocks.push({ kind: 'table', rows });
      } else if (name === 'lineseg' || name === 'linesegarray' || name === 'secpr') {
        continue; // 레이아웃 메타 — 본문 텍스트 없음
      } else walk(c); // run·개체(그리기 등) — 내부의 t를 계속 찾는다
    }
  };
  walk(p);
  flush();
}

/** 섹션 문서 전체에서 문단·표를 순서대로 추출 (루트가 몇 겹이든 하강) */
export function extractBlocksFromDoc(doc: Document, blocks: HwpxBlock[]) {
  const walkTop = (node: Node) => {
    if (blocks.length > MAX_BLOCKS) return;
    for (const c of childEls(node)) {
      if (blocks.length > MAX_BLOCKS) return;
      const name = ln(c);
      if (name === 'p') walkPara(c, blocks);
      else if (name === 'tbl') {
        const rows = tableRows(c);
        if (rows.length > 0) blocks.push({ kind: 'table', rows });
      } else walkTop(c);
    }
  };
  walkTop(doc);
}

/* ── 섹션 파일 발견 ── */

function normName(n: string): string {
  return n.replace(/\\/g, '/').replace(/^\.?\//, '');
}

function resolvePath(dir: string, href: string): string {
  const parts = (dir + normName(href)).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/** container.xml → *.hpf(spine) 순으로 본문 XML 경로를 알아낸다 */
function sectionsFromSpine(
  names: string[],
  textOf: (name: string) => string | null,
  realNameOf: (name: string) => string | undefined,
): string[] {
  const hpfPaths: string[] = [];
  const containerXml = textOf('META-INF/container.xml');
  if (containerXml) {
    const doc = parseXmlSafe(containerXml);
    if (doc)
      forEachEl(doc, (el) => {
        if (ln(el) === 'rootfile') {
          const p = attrOf(el, 'full-path');
          if (p) hpfPaths.push(normName(p));
        }
      });
  }
  if (hpfPaths.length === 0) for (const n of names) if (/\.hpf$/i.test(n)) hpfPaths.push(n);

  const out: string[] = [];
  for (const hpfPath of hpfPaths) {
    const hpfXml = textOf(hpfPath);
    if (!hpfXml) continue;
    const doc = parseXmlSafe(hpfXml);
    if (!doc) continue;
    const manifest = new Map<string, string>(); // id → href
    const spineIds: string[] = [];
    forEachEl(doc, (el) => {
      const name = ln(el);
      if (name === 'item') {
        const id = attrOf(el, 'id');
        const href = attrOf(el, 'href');
        if (id && href) manifest.set(id, href);
      } else if (name === 'itemref') {
        const idref = attrOf(el, 'idref');
        if (idref) spineIds.push(idref);
      }
    });
    const dir = hpfPath.includes('/') ? hpfPath.slice(0, hpfPath.lastIndexOf('/') + 1) : '';
    for (const id of spineIds) {
      const href = manifest.get(id);
      if (!href || !/\.xml$/i.test(href)) continue;
      // hpf 기준 상대경로와 zip 루트 기준 둘 다 시도
      for (const cand of [resolvePath(dir, href), normName(href)]) {
        const real = realNameOf(cand);
        if (real) {
          if (!out.includes(real)) out.push(real);
          break;
        }
      }
    }
  }
  return out;
}

/* ── 최후 폴백: 서식 없는 텍스트 ── */

function decodeEntitiesText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (_m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const lower = body.toLowerCase();
    const base: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return base[lower] ?? HTML_ENTITIES[lower] ?? '';
  });
}

/** DOM으로도 못 여는 XML에서 태그만 벗겨 텍스트 회수 */
function stripTags(xml: string): string {
  const noTags = xml
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '\n');
  return decodeEntitiesText(noTags);
}

function collectTextNodes(n: Node, out: string[]) {
  const kids = n.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType === 3 || c.nodeType === 4) {
      const v = (c.nodeValue ?? '').trim();
      if (v) out.push(v);
    } else if (c.nodeType === 1) collectTextNodes(c, out);
  }
}

/* ── 진입점 ── */

/**
 * hwpx zip 엔트리(이름 → 바이트)를 받아 미리보기 블록을 돌려준다.
 * 어떤 방법으로도 텍스트를 못 찾으면 [] — 호출부가 기존 안내 문구를 보여준다.
 */
export function parseHwpx(files: Record<string, Uint8Array>): HwpxBlock[] {
  const byName = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(files)) {
    if (v && v.length > 0 && v.length <= MAX_ENTRY_BYTES) byName.set(normName(k), v);
  }
  const lowerIndex = new Map<string, string>();
  for (const k of byName.keys()) lowerIndex.set(k.toLowerCase(), k);
  const realNameOf = (name: string) => lowerIndex.get(normName(name).toLowerCase());
  const textCache = new Map<string, string | null>();
  const textOf = (name: string): string | null => {
    const real = realNameOf(name);
    if (!real) return null;
    if (!textCache.has(real)) {
      const bytes = byName.get(real);
      textCache.set(real, bytes ? decodeBytes(bytes) : null);
    }
    return textCache.get(real) ?? null;
  };
  const docCache = new Map<string, Document | null>();
  const docOf = (name: string): Document | null => {
    const real = realNameOf(name);
    if (!real) return null;
    if (!docCache.has(real)) {
      const xml = textOf(real);
      docCache.set(real, xml ? parseXmlSafe(xml) : null);
    }
    return docCache.get(real) ?? null;
  };

  const allNames = [...byName.keys()];
  const xmlNames = allNames.filter((n) => /\.xml$/i.test(n));
  // 메타·설정류 제외 — 본문일 가능성이 있는 XML만
  const contentish = (n: string) =>
    !/^meta-inf\//i.test(n) && !/(^|\/)(settings|version|manifest|container)\.xml$/i.test(n);
  // Contents/ 우선, 이후 숫자 인식 정렬
  const contentsFirst = (a: string, b: string) => {
    const ac = /^contents\//i.test(a) ? 0 : 1;
    const bc = /^contents\//i.test(b) ? 0 : 1;
    return ac - bc || a.localeCompare(b, undefined, { numeric: true });
  };

  // 1) spine 기준 발견
  let sectionNames = sectionsFromSpine(allNames, textOf, realNameOf);
  // 2) 폴백: section*.xml 글롭 (경로·대소문자 무관)
  if (sectionNames.length === 0) {
    sectionNames = xmlNames
      .filter((n) => /(^|\/)section\d*\.xml$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  // 3) 폴백: 문단(p)과 텍스트(t)를 실제로 가진 XML 전수 탐색
  if (sectionNames.length === 0) {
    for (const n of xmlNames.filter(contentish).sort(contentsFirst)) {
      const doc = docOf(n);
      if (!doc) continue;
      let hasP = false;
      let hasT = false;
      forEachEl(doc, (el) => {
        const name = ln(el);
        if (name === 'p') hasP = true;
        else if (name === 't' && textOfT(el).trim()) hasT = true;
      });
      if (hasP && hasT) sectionNames.push(n);
    }
  }

  // 구조 파싱
  const blocks: HwpxBlock[] = [];
  for (const name of sectionNames.slice(0, MAX_SECTIONS)) {
    const doc = docOf(name);
    if (!doc) continue;
    extractBlocksFromDoc(doc, blocks);
    if (blocks.length > MAX_BLOCKS) break;
  }
  if (blocks.length > 0) return blocks.slice(0, MAX_BLOCKS);

  // 4) 최후 폴백 — 서식 없는 텍스트 모드
  let acc = '';
  const push = (s: string) => {
    if (acc.length < MAX_PLAIN_CHARS && s.trim()) acc += s.replace(/\s+$/, '') + '\n';
  };
  for (const name of xmlNames.filter(contentish).sort(contentsFirst)) {
    if (acc.length >= MAX_PLAIN_CHARS) break;
    const doc = docOf(name);
    if (doc) {
      const ts: string[] = [];
      collectT(doc, ts);
      if (ts.some((t) => t.trim())) push(ts.filter((t) => t.trim()).join('\n'));
      else {
        const texts: string[] = [];
        collectTextNodes(doc, texts);
        push(texts.join('\n'));
      }
    } else {
      const raw = textOf(name);
      if (raw) push(stripTags(raw));
    }
  }
  // 그래도 비면 한/글이 넣어두는 미리보기 텍스트(PrvText.txt)라도
  if (!acc.trim()) {
    for (const n of allNames) {
      if (/prvtext\.txt$/i.test(n)) {
        const bytes = byName.get(n);
        if (bytes) acc = decodeBytes(bytes);
        break;
      }
    }
  }
  return acc
    .slice(0, MAX_PLAIN_CHARS)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_BLOCKS)
    .map((text) => ({ kind: 'p' as const, text }));
}
