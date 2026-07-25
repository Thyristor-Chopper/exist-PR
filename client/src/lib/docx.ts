import JSZip from 'jszip';

/*
 * 문서 → .docx 내보내기 — Open XML 최소 구조 수제 생성.
 * ProseMirror JSON을 걸어 문단/제목/목록/인용/코드/표(텍스트)를 w:p로 변환.
 * 서식은 굵게/기울임/밑줄/취소선/글자색까지 (v1).
 */

interface PMNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: PMNode[];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 인라인 노드들 → w:r 런들 */
function runs(nodes: PMNode[] | undefined, extra?: { bold?: boolean; sizeHalfPt?: number; mono?: boolean }): string {
  if (!nodes) return '';
  let out = '';
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out += '<w:r><w:br/></w:r>';
      continue;
    }
    if (n.type === 'mention') {
      const label = String(n.attrs?.label ?? n.attrs?.id ?? '');
      out += `<w:r><w:rPr><w:b/><w:color w:val="4F7CFF"/></w:rPr><w:t xml:space="preserve">@${esc(label)}</w:t></w:r>`;
      continue;
    }
    if (n.type !== 'text' || !n.text) continue;
    const m = new Set((n.marks ?? []).map((mk) => mk.type));
    const colorMark = (n.marks ?? []).find((mk) => mk.type === 'textStyle')?.attrs?.color as string | undefined;
    let rpr = '';
    if (m.has('bold') || extra?.bold) rpr += '<w:b/>';
    if (m.has('italic')) rpr += '<w:i/>';
    if (m.has('underline')) rpr += '<w:u w:val="single"/>';
    if (m.has('strike')) rpr += '<w:strike/>';
    if (colorMark) rpr += `<w:color w:val="${colorMark.replace('#', '').toUpperCase()}"/>`;
    if (extra?.sizeHalfPt) rpr += `<w:sz w:val="${extra.sizeHalfPt}"/>`;
    if (extra?.mono) rpr += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>';
    out += `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(n.text)}</w:t></w:r>`;
  }
  return out;
}

function para(inner: string, align?: string): string {
  const jc = align === 'center' ? '<w:jc w:val="center"/>' : align === 'right' ? '<w:jc w:val="right"/>' : '';
  return `<w:p>${jc ? `<w:pPr>${jc}</w:pPr>` : ''}${inner}</w:p>`;
}

function textPara(text: string, opts?: { bold?: boolean; sizeHalfPt?: number }): string {
  return para(runs([{ type: 'text', text }], opts));
}

function walk(nodes: PMNode[] | undefined, out: string[]): void {
  if (!nodes) return;
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push(para(runs(n.content), n.attrs?.textAlign as string | undefined));
        break;
      case 'heading': {
        const level = Number(n.attrs?.level ?? 1);
        const size = level === 1 ? 44 : level === 2 ? 34 : 28; // half-pt
        out.push(para(runs(n.content, { bold: true, sizeHalfPt: size }), n.attrs?.textAlign as string | undefined));
        break;
      }
      case 'bulletList':
        for (const li of n.content ?? []) {
          const first = li.content?.[0];
          out.push(para(`<w:r><w:t xml:space="preserve">• </w:t></w:r>${runs(first?.content)}`));
          walk(li.content?.slice(1), out);
        }
        break;
      case 'orderedList': {
        let i = 1;
        for (const li of n.content ?? []) {
          const first = li.content?.[0];
          out.push(para(`<w:r><w:t xml:space="preserve">${i}. </w:t></w:r>${runs(first?.content)}`));
          walk(li.content?.slice(1), out);
          i++;
        }
        break;
      }
      case 'taskList':
        for (const li of n.content ?? []) {
          const checked = !!li.attrs?.checked;
          const first = li.content?.[0];
          out.push(para(`<w:r><w:t xml:space="preserve">${checked ? '☑' : '☐'} </w:t></w:r>${runs(first?.content)}`));
        }
        break;
      case 'blockquote': {
        const inner: string[] = [];
        walk(n.content, inner);
        // 인용은 앞에 막대 문자로 표시 (v1)
        out.push(...inner.map((p) => p.replace('<w:p>', '<w:p><w:pPr><w:ind w:left="480"/></w:pPr>')));
        break;
      }
      case 'codeBlock': {
        const code = (n.content ?? []).map((c) => c.text ?? '').join('');
        for (const line of code.split('\n')) {
          out.push(para(runs([{ type: 'text', text: line }], { mono: true })));
        }
        break;
      }
      case 'table':
        for (const row of n.content ?? []) {
          const cells = (row.content ?? []).map((cell) => {
            const t: string[] = [];
            cell.content?.forEach((p) => t.push((p.content ?? []).map((x) => x.text ?? '').join('')));
            return t.join(' ');
          });
          out.push(textPara(cells.join('  |  ')));
        }
        break;
      case 'image':
        out.push(textPara('[이미지]'));
        break;
      case 'horizontalRule':
        out.push(textPara('────────────────────'));
        break;
      default:
        if (n.content) walk(n.content, out);
    }
  }
}

export async function exportDocx(name: string, json: unknown): Promise<void> {
  const paras: string[] = [];
  walk((json as PMNode).content, paras);
  if (!paras.length) paras.push(textPara(''));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file('word/document.xml', documentXml);

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
