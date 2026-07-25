import JSZip from 'jszip';

/*
 * 발표 → .pptx 내보내기 — Open XML 최소 구조 수제 생성 (docx.ts/exportXlsx와 같은 방식).
 * 슬라이드 요소(텍스트/도형/이미지)를 EMU 좌표로 변환. 16:9 (12192000×6858000).
 * PowerPoint가 요구하는 최소 파트: presentation + slideMaster + slideLayout + theme + slides.
 */

export interface PptxEl {
  type?: 'text' | 'shape' | 'image';
  x: number; // %
  y: number;
  w: number;
  h: number;
  text?: string;
  size?: number; // px
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right';
  color?: string;
  font?: string;
  shape?: 'rect' | 'ellipse' | 'triangle' | 'line' | 'arrow';
  fill?: string;
  stroke?: string;
  src?: string;
  rot?: number; // deg
}

export interface PptxSlide {
  bg?: string;
  els: PptxEl[]; // z 오름차순 (그리는 순서)
}

const EMU_W = 12192000;
const EMU_H = 6858000;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hex(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const m = c.trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? m[1].toUpperCase() : fallback;
}
function ex(p: number, total: number): number {
  return Math.max(0, Math.round((p / 100) * total));
}
/** CSS font-family 문자열 → 첫 글꼴 이름 */
function typeface(font: string | undefined): string | null {
  if (!font) return null;
  const first = font.split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  return first || null;
}

function runProps(el: PptxEl): string {
  const sz = Math.max(100, Math.round((el.size ?? 22) * 75)); // px → pt(×0.75) → 1/100pt
  let a = ` sz="${sz}"`;
  if (el.bold) a += ' b="1"';
  if (el.italic) a += ' i="1"';
  if (el.underline) a += ' u="sng"';
  if (el.strike) a += ' strike="sngStrike"';
  const color = hex(el.color, '1C2024');
  const tf = typeface(el.font);
  const latin = tf ? `<a:latin typeface="${esc(tf)}"/><a:ea typeface="${esc(tf)}"/>` : '';
  return `<a:rPr lang="ko-KR"${a} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${latin}</a:rPr>`;
}

function textBody(el: PptxEl, anchorCenter: boolean): string {
  const algn = el.align === 'center' ? 'ctr' : el.align === 'right' ? 'r' : anchorCenter ? 'ctr' : 'l';
  const lines = (el.text ?? '').split('\n');
  const paras = lines
    .map((line) => `<a:p><a:pPr algn="${algn}"/>${line ? `<a:r>${runProps(el)}<a:t>${esc(line)}</a:t></a:r>` : ''}<a:endParaRPr lang="ko-KR"/></a:p>`)
    .join('');
  return `<p:txBody><a:bodyPr wrap="square" anchor="${anchorCenter ? 'ctr' : 't'}" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody>`;
}

function xfrm(el: PptxEl, cyOverride?: number): string {
  const rot = el.rot ? ` rot="${Math.round(el.rot * 60000)}"` : '';
  const cy = cyOverride ?? ex(el.h, EMU_H);
  return `<a:xfrm${rot}><a:off x="${ex(el.x, EMU_W)}" y="${ex(el.y, EMU_H)}"/><a:ext cx="${Math.max(1, ex(el.w, EMU_W))}" cy="${Math.max(cyOverride == null ? 1 : 0, cy)}"/></a:xfrm>`;
}

function shapeXml(el: PptxEl, id: number): string {
  const kind = el.shape ?? 'rect';
  if (kind === 'line' || kind === 'arrow') {
    // 선/화살표 — 수평 커넥터 (요소 세로 중앙)
    const midY = el.y + el.h / 2;
    const stroke = hex(el.stroke, '1971C2');
    const tail = kind === 'arrow' ? '<a:tailEnd type="triangle" w="med" len="med"/>' : '';
    const rot = el.rot ? ` rot="${Math.round(el.rot * 60000)}"` : '';
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="선 ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${rot}><a:off x="${ex(el.x, EMU_W)}" y="${ex(midY, EMU_H)}"/><a:ext cx="${Math.max(1, ex(el.w, EMU_W))}" cy="0"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill>${tail}</a:ln></p:spPr></p:cxnSp>`;
  }
  const prst = kind === 'ellipse' ? 'ellipse' : kind === 'triangle' ? 'triangle' : 'rect';
  const fill = el.fill ? `<a:solidFill><a:srgbClr val="${hex(el.fill, 'A5D8FF')}"/></a:solidFill>` : '<a:noFill/>';
  const ln = el.stroke
    ? `<a:ln w="19050"><a:solidFill><a:srgbClr val="${hex(el.stroke, '1971C2')}"/></a:solidFill></a:ln>`
    : '<a:ln><a:noFill/></a:ln>';
  const body = el.text ? textBody(el, true) : '<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR"/></a:p></p:txBody>';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="도형 ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill}${ln}</p:spPr>${body}</p:sp>`;
}

function textXml(el: PptxEl, id: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="텍스트 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${textBody(el, false)}</p:sp>`;
}

function imageXml(el: PptxEl, id: number, relId: string): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="그림 ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="exist"><a:themeElements><a:clrScheme name="exist"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1C2024"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="30A46C"/></a:accent1><a:accent2><a:srgbClr val="4F7CFF"/></a:accent2><a:accent3><a:srgbClr val="F76808"/></a:accent3><a:accent4><a:srgbClr val="E5484D"/></a:accent4><a:accent5><a:srgbClr val="8E4EC6"/></a:accent5><a:accent6><a:srgbClr val="0091FF"/></a:accent6><a:hlink><a:srgbClr val="4F7CFF"/></a:hlink><a:folHlink><a:srgbClr val="8E4EC6"/></a:folHlink></a:clrScheme><a:fontScheme name="exist"><a:majorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="exist"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="빈 화면"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`;

/** 이미지 src(서버 URL)를 blob으로 — 실패하면 null (해당 그림은 건너뜀) */
async function fetchImage(src: string, token: string | null): Promise<{ data: ArrayBuffer; ext: string } | null> {
  try {
    const res = await fetch(src, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
    if (!res.ok) return null;
    const blob = await res.blob();
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('gif') ? 'gif' : blob.type.includes('webp') ? 'webp' : 'jpeg';
    return { data: await blob.arrayBuffer(), ext };
  } catch {
    return null;
  }
}

export async function exportPptx(name: string, slides: PptxSlide[], token: string | null): Promise<void> {
  const zip = new JSZip();
  const mediaFiles: { path: string; data: ArrayBuffer }[] = [];
  const slideXmls: string[] = [];
  const slideRels: string[] = [];
  let mediaN = 0;

  for (const slide of slides) {
    let elId = 2;
    let body = '';
    const rels: string[] = [
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`,
    ];
    let relN = 2;
    for (const el of slide.els) {
      const type = el.type ?? 'text';
      if (type === 'image' && el.src) {
        const img = await fetchImage(el.src, token);
        if (!img) continue;
        mediaN += 1;
        const fname = `image${mediaN}.${img.ext}`;
        mediaFiles.push({ path: `ppt/media/${fname}`, data: img.data });
        const relId = `rId${relN}`;
        relN += 1;
        rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${fname}"/>`);
        body += imageXml(el, elId, relId);
      } else if (type === 'shape') {
        body += shapeXml(el, elId);
      } else {
        body += textXml(el, elId);
      }
      elId += 1;
    }
    const bg = slide.bg
      ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${hex(slide.bg, 'FFFFFF')}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      : '';
    slideXmls.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${body}</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`);
    slideRels.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  }

  const n = slides.length;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`;

  zip.file('[Content_Types].xml', contentTypes);
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  zip.file(
    'ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${EMU_W}" cy="${EMU_H}"/><p:notesSz cx="${EMU_H}" cy="${EMU_W}"/></p:presentation>`,
  );
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`,
  );
  zip.file('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER);
  zip.file(
    'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  zip.file('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT);
  zip.file(
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
  );
  zip.file('ppt/theme/theme1.xml', THEME);
  slideXmls.forEach((xml, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, slideRels[i]);
  });
  mediaFiles.forEach((m) => zip.file(m.path, m.data));

  const blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.pptx`;
  a.click();
  URL.revokeObjectURL(url);
}
