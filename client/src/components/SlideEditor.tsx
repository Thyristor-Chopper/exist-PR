import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import { PlusIcon, CloseIcon, PlayIcon } from './Icons';
import ColorGrid from './ColorGrid';
import OverflowToolbar from './OverflowToolbar';
import { exportPptx } from '../lib/pptx';

interface SlideMeta {
  id: string;
  ord: number;
  note?: string;
  bg?: string;
}
type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'line' | 'arrow';
interface ElData {
  type?: 'text' | 'shape' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  z?: number; // 쌓임 순서 (클수록 앞)
  rot?: number; // 회전 (도)
  gid?: string; // 그룹 id — 같은 gid는 함께 선택·이동
  // 텍스트 (도형 안 텍스트에도 사용)
  text?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  align?: 'left' | 'center' | 'right';
  color?: string;
  font?: string;
  // 도형
  shape?: ShapeKind;
  fill?: string;
  stroke?: string;
  // 이미지
  src?: string;
}
type SlideValue = { ord: number; note?: string; bg?: string };

const COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];
const FONTS: { label: string; value: string | null }[] = [
  { label: '기본', value: null },
  { label: '명조', value: "'Nanum Myeongjo', 'Noto Serif KR', Georgia, serif" },
  { label: '고정폭', value: "ui-monospace, Consolas, 'Nanum Gothic Coding', monospace" },
  { label: '필기체', value: "'Nanum Pen Script', 'Segoe Script', cursive" },
];

/* 구글 슬라이드식 툴바 아이콘 */
const GI = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const GUndo = () => <GI><path d="M6 3 3 6l3 3" /><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H6" /></GI>;
const GRedo = () => <GI><path d="m10 3 3 3-3 3" /><path d="M13 6H6.5a3.5 3.5 0 0 0 0 7H10" /></GI>;
const GTitle = () => <GI><path d="M2.5 4V2.5h11V4" /><path d="M8 2.5v11" /><path d="M6 13.5h4" /></GI>;
const GTextBox = () => <GI><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M5 6V5h6v1" /><path d="M8 5v6" /><path d="M7 11h2" /></GI>;
const GImage = () => <GI><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="5.5" cy="6.5" r="1" fill="currentColor" stroke="none" /><path d="m4 12 3.5-3.5 2 2L12 8l2 2" /></GI>;
const GShape = () => <GI><rect x="2" y="2" width="8.5" height="8.5" rx="1" /><circle cx="10.5" cy="10.5" r="3.8" /></GI>;
const GDup = () => <GI><rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 2.5H3.5A1.5 1.5 0 0 0 2 4v7.5" /></GI>;
const GFront = () => <GI><rect x="2" y="6" width="8" height="8" rx="1" opacity="0.45" /><rect x="6" y="2" width="8" height="8" rx="1" fill="var(--surface)" /></GI>;
const GBack = () => <GI><rect x="6" y="2" width="8" height="8" rx="1" opacity="0.45" /><rect x="2" y="6" width="8" height="8" rx="1" fill="var(--surface)" /></GI>;
const GFwd = () => <GI><rect x="4" y="4" width="9" height="9" rx="1" opacity="0.45" /><path d="M8.5 8.5 12 5" /><path d="M9 5h3v3" /></GI>;
const GBwd = () => <GI><rect x="3" y="3" width="9" height="9" rx="1" opacity="0.45" /><path d="m7.5 7.5-3.5 3.5" /><path d="M7 11H4V8" /></GI>;
const GRotL = () => <GI><path d="M3 6a5 5 0 1 1 1 5.5" /><path d="M3 2.5V6h3.5" /></GI>;
const GRotR = () => <GI><path d="M13 6a5 5 0 1 0-1 5.5" /><path d="M13 2.5V6H9.5" /></GI>;
const GGroup = () => <GI><rect x="1.5" y="1.5" width="6" height="6" rx="1" /><rect x="8.5" y="8.5" width="6" height="6" rx="1" /><path d="M4.5 10.5v2a1 1 0 0 0 1 1h2" opacity="0.6" /><path d="M11.5 5.5v-2a1 1 0 0 0-1-1h-2" opacity="0.6" /></GI>;
const GUngroup = () => <GI><rect x="1.5" y="1.5" width="6" height="6" rx="1" /><rect x="8.5" y="8.5" width="6" height="6" rx="1" /><path d="m6.5 9.5-3 3" opacity="0.6" /><path d="m12.5 3.5-3 3" opacity="0.6" /></GI>;
const GBg = () => <GI><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" /><path d="M1.5 9.5 6 5l4 4 2.5-2.5 2 2" opacity="0.7" /></GI>;
const GAlign = ({ a }: { a: 'left' | 'center' | 'right' }) => (
  <GI>
    <line x1="2" y1="4" x2="14" y2="4" />
    <line x1={a === 'left' ? 2 : a === 'center' ? 4.5 : 7} y1="8" x2={a === 'left' ? 9 : a === 'center' ? 11.5 : 14} y2="8" />
    <line x1="2" y1="12" x2="14" y2="12" />
  </GI>
);

/** Yjs 기반 협업 슬라이드(PowerPoint형) — roomId 단위 공유 */
export default function SlideEditor({ roomId, fileName }: { roomId: string; fileName?: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const ydocRef = useRef<Y.Doc | null>(null);
  const slidesMapRef = useRef<Y.Map<SlideValue> | null>(null);
  const elsRef = useRef<Y.Map<ElData> | null>(null);
  const [, bump] = useState(0);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [slides, setSlides] = useState<SlideMeta[]>([]);
  const [activeSlideId, setActiveSlideId] = useState<string | null>(null);
  const [selIds, setSelIds] = useState<string[]>([]);
  const [editingEl, setEditingEl] = useState<string | null>(null);
  const [present, setPresent] = useState(false);
  const [presentIdx, setPresentIdx] = useState(0);
  const [presentNotes, setPresentNotes] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; items: { id: string; ox: number; oy: number }[] } | null>(null);
  const resizeRef = useRef<{ id: string; sx: number; sy: number; ow: number; oh: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const [printing, setPrinting] = useState(false);
  const [colorMenu, setColorMenu] = useState<'fill' | 'stroke' | 'text' | 'bg' | null>(null);
  const [fontMenu, setFontMenu] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);

  const selEl = selIds.length ? selIds[selIds.length - 1] : null;

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const slidesMap = ydoc.getMap<SlideValue>('slides');
    ydocRef.current = ydoc;
    slidesMapRef.current = slidesMap;
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const syncSlides = () => {
      const list: SlideMeta[] = [];
      slidesMap.forEach((v, id) => list.push({ id, ord: v.ord, note: v.note, bg: v.bg }));
      list.sort((a, b) => a.ord - b.ord);
      setSlides(list);
      setActiveSlideId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
    };
    slidesMap.observe(syncSlides);
    syncSlides();

    provider.on('sync', (isSynced: boolean) => {
      if (isSynced && slidesMap.size === 0) slidesMap.set(crypto.randomUUID(), { ord: 1 });
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    const color = COLORS[(user?.id ?? 0) % COLORS.length];
    provider.awareness.setLocalStateField('user', { name: user?.username ?? '익명', color });

    return () => {
      slidesMap.unobserve(syncSlides);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      slidesMapRef.current = null;
      elsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  // 활성 슬라이드 요소 바인딩 (+ 실행취소)
  const undoRef = useRef<Y.UndoManager | null>(null);
  useEffect(() => {
    const ydoc = ydocRef.current;
    if (!ydoc || !activeSlideId) return;
    const els = ydoc.getMap<ElData>(`slide-els:${activeSlideId}`);
    elsRef.current = els;
    const um = new Y.UndoManager([els], { captureTimeout: 350 });
    undoRef.current = um;
    setSelIds([]);
    bump((n) => n + 1);
    const onEls = () => bump((n) => n + 1);
    els.observe(onEls);
    return () => {
      els.unobserve(onEls);
      um.destroy();
      undoRef.current = null;
    };
  }, [activeSlideId]);

  function elsOf(slideId: string): [string, ElData][] {
    const m = ydocRef.current?.getMap<ElData>(`slide-els:${slideId}`);
    if (!m) return [];
    // z 오름차순 (뒤→앞), 같은 z는 키 순서로 고정
    return ([...m.entries()] as [string, ElData][]).sort(
      (a, b) => (a[1].z ?? 0) - (b[1].z ?? 0) || a[0].localeCompare(b[0]),
    );
  }
  const activeEls = activeSlideId ? elsOf(activeSlideId) : [];

  // ── 선택 ──
  function toggleSel(id: string) {
    setSelIds((cur) => (cur.includes(id) ? cur.filter((k) => k !== id) : [...cur, id]));
  }
  function clearSel() {
    setSelIds([]);
    setEditingEl(null);
  }

  function addSlide() {
    const map = slidesMapRef.current;
    if (!map) return;
    const ord = slides.reduce((m, s) => Math.max(m, s.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { ord });
    setActiveSlideId(id);
  }
  function deleteSlide(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = slidesMapRef.current;
    if (!map || slides.length <= 1) return;
    if (!confirm('이 슬라이드를 삭제할까요?')) return;
    ydocRef.current?.getMap(`slide-els:${id}`).clear();
    map.delete(id);
    if (id === activeSlideId) setActiveSlideId(slides.find((s) => s.id !== id)?.id ?? null);
  }
  function addText() {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    els.set(id, { type: 'text', x: 12, y: 36, w: 60, h: 14, text: '텍스트를 입력하세요', size: 22, align: 'left' });
    setSelIds([id]);
    setEditingEl(id);
  }
  function addTitle() {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    els.set(id, { type: 'text', x: 8, y: 8, w: 84, h: 16, text: '제목', size: 40, bold: true, align: 'center' });
    setSelIds([id]);
    setEditingEl(id);
  }
  function addShape(shape: ShapeKind) {
    const els = elsRef.current;
    if (!els) return;
    const id = crypto.randomUUID();
    const isLine = shape === 'line' || shape === 'arrow';
    els.set(id, {
      type: 'shape',
      shape,
      x: 30,
      y: 30,
      w: 30,
      h: isLine ? 6 : 22,
      fill: isLine ? '' : '#a5d8ff',
      stroke: '#1971c2',
    });
    setShapeMenu(false);
    setSelIds([id]);
    setEditingEl(null);
  }
  async function addImage(file: File) {
    const els = elsRef.current;
    if (!els) return;
    try {
      const res = await fetch(`/api/workspaces/uploads?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: file,
      });
      const { url } = (await res.json()) as { url: string };
      const id = crypto.randomUUID();
      els.set(id, { type: 'image', src: url, x: 25, y: 25, w: 40, h: 40 });
      setSelIds([id]);
    } catch {
      /* 업로드 실패 무시 */
    }
  }
  function updateEl(id: string, patch: Partial<ElData>) {
    const els = elsRef.current;
    const cur = els?.get(id);
    if (els && cur) els.set(id, { ...cur, ...patch });
  }
  /** 선택된 모든 요소에 패치 (텍스트 서식 등) */
  function updateSel(patch: Partial<ElData>) {
    ydocRef.current?.transact(() => {
      selIds.forEach((id) => updateEl(id, patch));
    });
  }
  function deleteSel() {
    ydocRef.current?.transact(() => {
      selIds.forEach((id) => elsRef.current?.delete(id));
    });
    setSelIds([]);
    setEditingEl(null);
  }

  // ── z-순서 / 복제 / 회전 / 그룹 ──
  function zBounds(): { min: number; max: number } {
    let min = 0;
    let max = 0;
    elsRef.current?.forEach((el) => {
      const z = el.z ?? 0;
      min = Math.min(min, z);
      max = Math.max(max, z);
    });
    return { min, max };
  }
  function bringFront(id: string) {
    updateEl(id, { z: zBounds().max + 1 });
  }
  function sendBack(id: string) {
    updateEl(id, { z: zBounds().min - 1 });
  }
  /** 한 단계 앞/뒤 — z를 그리는 순서 인덱스로 정규화한 뒤 이웃과 교환 */
  function stepZ(id: string, dir: -1 | 1) {
    if (!activeSlideId) return;
    const sorted = elsOf(activeSlideId);
    const idx = sorted.findIndex(([k]) => k === id);
    const swapIdx = idx + dir;
    if (idx === -1 || swapIdx < 0 || swapIdx >= sorted.length) return;
    ydocRef.current?.transact(() => {
      sorted.forEach(([k, el], i) => {
        const z = i === idx ? swapIdx : i === swapIdx ? idx : i;
        if ((el.z ?? 0) !== z) updateEl(k, { z });
      });
    });
  }
  function duplicateSel() {
    const els = elsRef.current;
    if (!els || !selIds.length) return;
    const gidMap = new Map<string, string>(); // 그룹 복제 시 새 gid로
    const newIds: string[] = [];
    ydocRef.current?.transact(() => {
      let z = zBounds().max;
      selIds.forEach((id) => {
        const cur = els.get(id);
        if (!cur) return;
        const nid = crypto.randomUUID();
        let gid = cur.gid;
        if (gid) {
          if (!gidMap.has(gid)) gidMap.set(gid, crypto.randomUUID());
          gid = gidMap.get(gid);
        }
        z += 1;
        els.set(nid, { ...cur, gid, x: Math.min(95, cur.x + 3), y: Math.min(95, cur.y + 3), z });
        newIds.push(nid);
      });
    });
    setSelIds(newIds);
  }
  function rotateSel(deg: number) {
    ydocRef.current?.transact(() => {
      selIds.forEach((id) => {
        const cur = elsRef.current?.get(id);
        if (!cur) return;
        let r = ((cur.rot ?? 0) + deg) % 360;
        if (r < 0) r += 360;
        updateEl(id, { rot: r === 0 ? undefined : r });
      });
    });
  }
  function groupSel() {
    if (selIds.length < 2) return;
    const gid = crypto.randomUUID();
    ydocRef.current?.transact(() => {
      selIds.forEach((id) => updateEl(id, { gid }));
    });
  }
  function ungroupSel() {
    const els = elsRef.current;
    if (!els) return;
    ydocRef.current?.transact(() => {
      selIds.forEach((id) => {
        const cur = els.get(id);
        if (!cur || !cur.gid) return;
        const { gid: _gid, ...rest } = cur;
        els.set(id, rest);
      });
    });
  }
  const selHasGroup = selIds.some((id) => !!elsRef.current?.get(id)?.gid);

  // ── 슬라이드 복제 / 순서 변경 / 노트 / 배경 ──
  function duplicateSlide(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = slidesMapRef.current;
    const ydoc = ydocRef.current;
    const src = map?.get(id);
    if (!map || !ydoc || !src) return;
    const nid = crypto.randomUUID();
    ydoc.transact(() => {
      // 원본 바로 뒤로 — 뒤 슬라이드 ord 한 칸씩 밀기
      map.forEach((v, k) => {
        if (v.ord > src.ord) map.set(k, { ...v, ord: v.ord + 1 });
      });
      map.set(nid, { ord: src.ord + 1, note: src.note, bg: src.bg });
      const srcEls = ydoc.getMap<ElData>(`slide-els:${id}`);
      const dstEls = ydoc.getMap<ElData>(`slide-els:${nid}`);
      srcEls.forEach((el, k) => dstEls.set(k, { ...el }));
    });
    setActiveSlideId(nid);
  }
  function moveSlide(id: string, dir: -1 | 1, e: React.MouseEvent) {
    e.stopPropagation();
    const map = slidesMapRef.current;
    if (!map) return;
    const idx = slides.findIndex((s) => s.id === id);
    const other = slides[idx + dir];
    if (idx === -1 || !other) return;
    const a = map.get(id);
    const b = map.get(other.id);
    if (!a || !b) return;
    ydocRef.current?.transact(() => {
      map.set(id, { ...a, ord: b.ord });
      map.set(other.id, { ...b, ord: a.ord });
    });
  }
  function setNote(text: string) {
    const map = slidesMapRef.current;
    if (!map || !activeSlideId) return;
    const cur = map.get(activeSlideId);
    if (cur) map.set(activeSlideId, { ...cur, note: text });
  }
  function setSlideBg(color: string | null) {
    const map = slidesMapRef.current;
    if (!map || !activeSlideId) return;
    const cur = map.get(activeSlideId);
    if (!cur) return;
    if (color) map.set(activeSlideId, { ...cur, bg: color });
    else {
      const { bg: _bg, ...rest } = cur;
      map.set(activeSlideId, rest);
    }
  }

  // ── PDF 내보내기 — 인쇄 전용 레이아웃 렌더 후 브라우저 인쇄(PDF 저장) ──
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => window.print(), 150);
    const done = () => setPrinting(false);
    window.addEventListener('afterprint', done);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printing]);

  async function doExportPptx() {
    setExportMenu(false);
    await exportPptx(
      fileName || '프레젠테이션',
      slides.map((s) => ({ bg: s.bg, els: elsOf(s.id).map(([, el]) => el) })),
      token,
    );
  }

  // 드래그 이동 / 크기 조절 — Pointer Events (터치·마우스 공용, 모바일 드래그 지원)
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      // 버튼이 이미 떨어져 있으면(놓친 pointerup) 드래그 강제 종료
      if (e.buttons === 0 && (dragRef.current || resizeRef.current)) {
        dragRef.current = null;
        resizeRef.current = null;
        document.body.style.userSelect = '';
        setGuides({ v: [], h: [] });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const d = dragRef.current;
      if (d) {
        const dx = ((e.clientX - d.sx) / rect.width) * 100;
        const dy = ((e.clientY - d.sy) / rect.height) * 100;
        if (d.items.length === 1) {
          const item = d.items[0];
          let nx = Math.max(0, Math.min(98, item.ox + dx));
          let ny = Math.max(0, Math.min(98, item.oy + dy));
          // 정렬 보조선 — 캔버스 중앙·다른 요소 가장자리/중앙에 스냅 (단일 선택일 때만)
          const SNAP = 0.8;
          const el = elsRef.current?.get(item.id);
          const gv: number[] = [];
          const gh: number[] = [];
          if (el) {
            const w = el.w;
            const h = el.h;
            const vT: { line: number; at: 'left' | 'center' | 'right' }[] = [{ line: 50, at: 'center' }];
            const hT: { line: number; at: 'top' | 'center' | 'bottom' }[] = [{ line: 50, at: 'center' }];
            elsRef.current?.forEach((o, k) => {
              if (k === item.id) return;
              vT.push({ line: o.x, at: 'left' }, { line: o.x + o.w / 2, at: 'center' }, { line: o.x + o.w, at: 'right' });
              hT.push({ line: o.y, at: 'top' }, { line: o.y + o.h / 2, at: 'center' }, { line: o.y + o.h, at: 'bottom' });
            });
            for (const t of vT) {
              const pos = t.at === 'left' ? nx : t.at === 'center' ? nx + w / 2 : nx + w;
              if (Math.abs(pos - t.line) < SNAP) {
                nx += t.line - pos;
                gv.push(t.line);
                break;
              }
            }
            for (const t of hT) {
              const pos = t.at === 'top' ? ny : t.at === 'center' ? ny + h / 2 : ny + h;
              if (Math.abs(pos - t.line) < SNAP) {
                ny += t.line - pos;
                gh.push(t.line);
                break;
              }
            }
          }
          setGuides({ v: gv, h: gh });
          updateEl(item.id, { x: nx, y: ny });
        } else {
          // 다중 이동 — 스냅 없이 전체 이동
          ydocRef.current?.transact(() => {
            d.items.forEach((item) => {
              updateEl(item.id, {
                x: Math.max(0, Math.min(98, item.ox + dx)),
                y: Math.max(0, Math.min(98, item.oy + dy)),
              });
            });
          });
        }
      }
      const z = resizeRef.current;
      if (z) {
        const dw = ((e.clientX - z.sx) / rect.width) * 100;
        const dh = ((e.clientY - z.sy) / rect.height) * 100;
        updateEl(z.id, {
          w: Math.max(3, z.ow + dw),
          h: Math.max(2, z.oh + dh),
        });
      }
    }
    function onUp() {
      if (dragRef.current || resizeRef.current) {
        dragRef.current = null;
        resizeRef.current = null;
        document.body.style.userSelect = '';
        setGuides({ v: [], h: [] });
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startDrag(id: string, el: ElData, e: React.PointerEvent) {
    if (editingEl === id) return;
    let ids: string[];
    if (e.shiftKey) {
      // shift-클릭 — 선택 토글 (드래그는 시작 안 함)
      toggleSel(id);
      e.preventDefault();
      return;
    }
    if (selIds.includes(id)) {
      ids = selIds; // 이미 선택된 묶음을 그대로 드래그
    } else {
      // 그룹이면 그룹 전체
      if (el.gid) {
        const g: string[] = [];
        elsRef.current?.forEach((o, k) => {
          if (o.gid === el.gid) g.push(k);
        });
        ids = [...g.filter((k) => k !== id), id];
      } else ids = [id];
      setSelIds(ids);
    }
    const items = ids
      .map((k) => {
        const o = elsRef.current?.get(k);
        return o ? { id: k, ox: o.x, oy: o.y } : null;
      })
      .filter(Boolean) as { id: string; ox: number; oy: number }[];
    dragRef.current = { sx: e.clientX, sy: e.clientY, items };
    document.body.style.userSelect = 'none';
    // 포인터 캡처 — 창 밖·빠른 릴리즈에서도 pointerup을 놓치지 않게 (안 하면 드래그가 안 놓아짐)
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch { /* 미지원 무시 */ }
    e.preventDefault();
  }
  function startResize(id: string, el: ElData, e: React.PointerEvent) {
    e.stopPropagation();
    setSelIds([id]);
    resizeRef.current = { id, sx: e.clientX, sy: e.clientY, ow: el.w, oh: el.h };
    document.body.style.userSelect = 'none';
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch { /* 미지원 무시 */ }
    e.preventDefault();
  }

  // 편집 키보드 — Delete 삭제, Esc 해제, 방향키 미세 이동, Ctrl+G 그룹
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (present || printing) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault();
        if (e.shiftKey) ungroupSel();
        else groupSel();
        return;
      }
      if (!selIds.length || editingEl) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSel();
      } else if (e.key === 'Escape') {
        setSelIds([]);
      } else if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 0.2 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        ydocRef.current?.transact(() => {
          selIds.forEach((id) => {
            const cur = elsRef.current?.get(id);
            if (cur) updateEl(id, { x: Math.max(0, Math.min(98, cur.x + dx)), y: Math.max(0, Math.min(98, cur.y + dy)) });
          });
        });
      }
    }
    function onUndoKey(e: KeyboardEvent) {
      if (present || printing) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) undoRef.current?.redo();
        else undoRef.current?.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        undoRef.current?.redo();
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onUndoKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onUndoKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIds, editingEl, present, printing]);

  // 발표 모드 키보드
  useEffect(() => {
    if (!present) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight' || e.key === ' ') setPresentIdx((i) => Math.min(slides.length - 1, i + 1));
      else if (e.key === 'ArrowLeft') setPresentIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'Escape') setPresent(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [present, slides.length]);

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const selElData = selEl ? elsRef.current?.get(selEl) ?? null : null;
  // 텍스트 서식 대상 — 텍스트 상자 또는 도형(도형 안 텍스트)
  const textFmtTarget = selElData && ((selElData.type ?? 'text') === 'text' || selElData.type === 'shape');

  const renderShapeSvg = (el: ElData) => {
    const fill = el.fill || 'none';
    const stroke = el.stroke || 'none';
    // 비율 늘어나도 선 굵기는 고정 (vector-effect) — 안 그러면 도형이 뭉개져 보임
    const ve = { vectorEffect: 'non-scaling-stroke' } as const;
    return (
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
        {el.shape === 'rect' && (
          <rect x="1" y="1" width="98" height="98" rx="2" fill={fill} stroke={stroke} strokeWidth="2" {...ve} />
        )}
        {el.shape === 'ellipse' && (
          <ellipse cx="50" cy="50" rx="49" ry="49" fill={fill} stroke={stroke} strokeWidth="2" {...ve} />
        )}
        {el.shape === 'triangle' && (
          <polygon points="50,2 98,98 2,98" fill={fill} stroke={stroke} strokeWidth="2" strokeLinejoin="round" {...ve} />
        )}
        {el.shape === 'line' && (
          <line x1="1" y1="50" x2="99" y2="50" stroke={el.stroke || '#1971c2'} strokeWidth="3" strokeLinecap="round" {...ve} />
        )}
        {el.shape === 'arrow' && (
          <g stroke={el.stroke || '#1971c2'} fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="50" x2="96" y2="50" {...ve} />
            <polyline points="82,32 98,50 82,68" {...ve} />
          </g>
        )}
      </svg>
    );
  };

  const textDecoration = (el: ElData) =>
    [el.underline ? 'underline' : '', el.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined;

  const renderEl = (id: string, el: ElData, editable: boolean) => {
    const isText = (el.type ?? 'text') === 'text';
    const isShape = el.type === 'shape';
    const isImage = el.type === 'image';
    const isLineShape = isShape && (el.shape === 'line' || el.shape === 'arrow');
    const selected = editable && selIds.includes(id);
    return (
      <div
        key={id}
        className={`slide-el${selected ? ' sel' : ''}${isText ? '' : ' bare'}`}
        style={{
          left: `${el.x}%`,
          top: `${el.y}%`,
          width: `${el.w}%`,
          height: isText ? undefined : `${el.h}%`,
          fontSize: isText || isShape ? `clamp(8px, ${(el.size ?? 22) / 10}vw, ${el.size ?? 22}px)` : undefined,
          fontWeight: el.bold ? 800 : 400,
          fontStyle: el.italic ? 'italic' : undefined,
          textDecoration: textDecoration(el),
          fontFamily: el.font || undefined,
          textAlign: el.align ?? 'left',
          color: el.color || undefined,
          transform: el.rot ? `rotate(${el.rot}deg)` : undefined,
          cursor: editable ? (editingEl === id ? 'text' : 'move') : 'default',
        }}
        onPointerDown={editable ? (e) => startDrag(id, el, e) : undefined}
        onDoubleClick={editable && (isText || (isShape && !isLineShape)) ? () => setEditingEl(id) : undefined}
      >
        {isText &&
          (editable && editingEl === id ? (
            <textarea
              className="slide-el-input"
              autoFocus
              value={el.text}
              style={{ fontSize: 'inherit', fontWeight: 'inherit', fontStyle: 'inherit', textDecoration: 'inherit', fontFamily: 'inherit', textAlign: 'inherit', color: 'inherit' }}
              onChange={(e) => updateEl(id, { text: e.target.value })}
              onBlur={() => setEditingEl(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingEl(null);
              }}
            />
          ) : (
            <span className="slide-el-text">{el.text || ' '}</span>
          ))}
        {isShape && renderShapeSvg(el)}
        {/* 도형 안 텍스트 — 더블클릭으로 편집 (선/화살표 제외) */}
        {isShape && !isLineShape && (editable && editingEl === id ? (
          <textarea
            className="slide-el-input slide-shape-textarea"
            autoFocus
            value={el.text ?? ''}
            style={{ fontSize: 'inherit', fontWeight: 'inherit', fontStyle: 'inherit', textDecoration: 'inherit', fontFamily: 'inherit', color: el.color || 'inherit' }}
            onChange={(e) => updateEl(id, { text: e.target.value })}
            onBlur={() => setEditingEl(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditingEl(null);
            }}
          />
        ) : el.text ? (
          <span className="slide-shape-text" style={{ textAlign: el.align ?? 'center' }}>{el.text}</span>
        ) : null)}
        {isImage && <img className="slide-el-img" src={el.src} alt="" draggable={false} />}
        {selected && selIds.length === 1 && editingEl !== id && (
          <>
            <button className="slide-el-del" onPointerDown={(e) => e.stopPropagation()} onClick={() => deleteSel()}>
              <CloseIcon size={11} />
            </button>
            <span className="slide-el-resize" onPointerDown={(e) => startResize(id, el, e)} />
          </>
        )}
      </div>
    );
  };

  if (present) {
    const slide = slides[presentIdx];
    return (
      <div className="slide-present" onClick={() => setPresentIdx((i) => Math.min(slides.length - 1, i + 1))}>
        <div className="slide-present-canvas" style={{ background: slide?.bg || undefined }}>
          {slide && elsOf(slide.id).map(([id, el]) => renderEl(id, el, false))}
        </div>
        {presentNotes && (
          <div className="slide-present-notes" onClick={(e) => e.stopPropagation()}>
            {slide?.note?.trim() ? slide.note : '이 슬라이드에는 노트가 없어요'}
          </div>
        )}
        <div className="slide-present-bar" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => setPresentIdx((i) => Math.max(0, i - 1))}>◀</button>
          <span>
            {presentIdx + 1} / {slides.length}
          </span>
          <button onClick={() => setPresentIdx((i) => Math.min(slides.length - 1, i + 1))}>▶</button>
          <button className={presentNotes ? 'on' : ''} onClick={() => setPresentNotes((v) => !v)}>
            노트
          </button>
          <button className="slide-present-exit" onClick={() => setPresent(false)}>
            나가기 (Esc)
          </button>
        </div>
      </div>
    );
  }

  const activeSlide = slides.find((s) => s.id === activeSlideId);

  return (
    <div className="slide-editor">
      <div className="slide-bar">
        <OverflowToolbar
          className="slide-tools"
          items={[
            <button key="undo" className="sht-btn" title="실행 취소 (Ctrl+Z)" onClick={() => undoRef.current?.undo()}>
              <GUndo />
            </button>,
            <button key="redo" className="sht-btn" title="다시 실행 (Ctrl+Y)" onClick={() => undoRef.current?.redo()}>
              <GRedo />
            </button>,
            <span key="s1" className="sht-sep" />,
            <button key="title" className="sht-btn" title="제목 추가" onClick={addTitle}>
              <GTitle />
            </button>,
            <button key="text" className="sht-btn" title="텍스트 상자" onClick={addText}>
              <GTextBox />
            </button>,
            <button key="img" className="sht-btn" title="그림 넣기" onClick={() => fileRef.current?.click()}>
              <GImage />
            </button>,
            <div key="shape" className="slide-shape-wrap">
              <button className="sht-btn" title="도형" onClick={() => setShapeMenu((v) => !v)}>
                <GShape />
              </button>
              {shapeMenu && (
                <>
                  <div className="slide-shape-back" onClick={() => setShapeMenu(false)} />
                  <div className="slide-shape-menu">
                    <button onClick={() => addShape('rect')}>▭ 사각형</button>
                    <button onClick={() => addShape('ellipse')}>◯ 원</button>
                    <button onClick={() => addShape('triangle')}>△ 삼각형</button>
                    <button onClick={() => addShape('line')}>— 선</button>
                    <button onClick={() => addShape('arrow')}>→ 화살표</button>
                  </div>
                </>
              )}
            </div>,
            <div key="bg" className="slide-shape-wrap">
              <button className="sht-btn" title="슬라이드 배경색" onClick={() => setColorMenu(colorMenu === 'bg' ? null : 'bg')}>
                <GBg />
              </button>
              {colorMenu === 'bg' && (
                <>
                  <div className="slide-shape-back" onClick={() => setColorMenu(null)} />
                  <div className="slide-color-pop">
                    <ColorGrid
                      value={activeSlide?.bg}
                      noneLabel="기본 배경"
                      onPick={(c) => {
                        setSlideBg(c || null);
                        setColorMenu(null);
                      }}
                    />
                  </div>
                </>
              )}
            </div>,
            ...(selElData
              ? [
                  <span key="s2" className="sht-sep" />,
                  <button key="dup" className="sht-btn" title="복제" onClick={duplicateSel}>
                    <GDup />
                  </button>,
                  <button key="fwd" className="sht-btn" title="한 단계 앞으로" onClick={() => stepZ(selEl!, 1)}>
                    <GFwd />
                  </button>,
                  <button key="bwd" className="sht-btn" title="한 단계 뒤로" onClick={() => stepZ(selEl!, -1)}>
                    <GBwd />
                  </button>,
                  <button key="front" className="sht-btn" title="맨 앞으로" onClick={() => bringFront(selEl!)}>
                    <GFront />
                  </button>,
                  <button key="back" className="sht-btn" title="맨 뒤로" onClick={() => sendBack(selEl!)}>
                    <GBack />
                  </button>,
                  <button key="rotl" className="sht-btn" title="왼쪽으로 15° 회전" onClick={() => rotateSel(-15)}>
                    <GRotL />
                  </button>,
                  <button key="rotr" className="sht-btn" title="오른쪽으로 15° 회전" onClick={() => rotateSel(15)}>
                    <GRotR />
                  </button>,
                ]
              : []),
            ...(selIds.length >= 2
              ? [
                  <button key="group" className="sht-btn" title="그룹화 (Ctrl+G)" onClick={groupSel}>
                    <GGroup />
                  </button>,
                ]
              : []),
            ...(selHasGroup
              ? [
                  <button key="ungroup" className="sht-btn" title="그룹 해제 (Ctrl+Shift+G)" onClick={ungroupSel}>
                    <GUngroup />
                  </button>,
                ]
              : []),
            ...(selElData && selElData.type === 'shape'
              ? [
                  <div key="fill" className="slide-shape-wrap">
                    <button
                      className="sht-btn cbtn"
                      title="채우기 색"
                      onClick={() => setColorMenu(colorMenu === 'fill' ? null : 'fill')}
                    >
                      <span className="cbtn-chip" style={{ background: selElData.fill || 'transparent' }} />
                      채움 ▾
                    </button>
                    {colorMenu === 'fill' && (
                      <>
                        <div className="slide-shape-back" onClick={() => setColorMenu(null)} />
                        <div className="slide-color-pop">
                          <ColorGrid
                            value={selElData.fill}
                            noneLabel="채움 없음"
                            onPick={(c) => {
                              updateSel({ fill: c });
                              setColorMenu(null);
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>,
                  <div key="stroke" className="slide-shape-wrap">
                    <button
                      className="sht-btn cbtn"
                      title="선 색"
                      onClick={() => setColorMenu(colorMenu === 'stroke' ? null : 'stroke')}
                    >
                      <span className="cbtn-chip" style={{ background: selElData.stroke || 'transparent' }} />
                      선 ▾
                    </button>
                    {colorMenu === 'stroke' && (
                      <>
                        <div className="slide-shape-back" onClick={() => setColorMenu(null)} />
                        <div className="slide-color-pop">
                          <ColorGrid
                            value={selElData.stroke}
                            noneLabel="선 없음"
                            onPick={(c) => {
                              updateSel({ stroke: c });
                              setColorMenu(null);
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>,
                ]
              : []),
            ...(textFmtTarget
              ? [
                  <span key="s3" className="sht-sep" />,
                  <button
                    key="bold"
                    className={`sht-btn${selElData!.bold ? ' on' : ''}`}
                    title="굵게"
                    onClick={() => updateSel({ bold: !selElData!.bold })}
                  >
                    <b>B</b>
                  </button>,
                  <button
                    key="italic"
                    className={`sht-btn${selElData!.italic ? ' on' : ''}`}
                    title="기울임"
                    onClick={() => updateSel({ italic: !selElData!.italic })}
                  >
                    <i>I</i>
                  </button>,
                  <button
                    key="underline"
                    className={`sht-btn${selElData!.underline ? ' on' : ''}`}
                    title="밑줄"
                    onClick={() => updateSel({ underline: !selElData!.underline })}
                  >
                    <u>U</u>
                  </button>,
                  <button
                    key="strike"
                    className={`sht-btn${selElData!.strike ? ' on' : ''}`}
                    title="취소선"
                    onClick={() => updateSel({ strike: !selElData!.strike })}
                  >
                    <s>S</s>
                  </button>,
                  <div key="font" className="slide-shape-wrap">
                    <button className="sht-btn cbtn" title="글꼴" onClick={() => setFontMenu((v) => !v)}>
                      {FONTS.find((f) => f.value === (selElData!.font ?? null))?.label ?? '글꼴'} ▾
                    </button>
                    {fontMenu && (
                      <>
                        <div className="slide-shape-back" onClick={() => setFontMenu(false)} />
                        <div className="slide-shape-menu">
                          {FONTS.map((f) => (
                            <button
                              key={f.label}
                              style={{ fontFamily: f.value ?? undefined }}
                              onClick={() => {
                                updateSel({ font: f.value ?? undefined });
                                setFontMenu(false);
                              }}
                            >
                              {f.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>,
                  ...(['left', 'center', 'right'] as const).map((a) => (
                    <button
                      key={`al-${a}`}
                      className={`sht-btn${(selElData!.align ?? 'left') === a ? ' on' : ''}`}
                      title={a === 'left' ? '왼쪽 정렬' : a === 'center' ? '가운데 정렬' : '오른쪽 정렬'}
                      onClick={() => updateSel({ align: a })}
                    >
                      <GAlign a={a} />
                    </button>
                  )),
                  <button
                    key="szm"
                    className="sht-btn"
                    title="글자 작게"
                    onClick={() => updateSel({ size: Math.max(10, (selElData!.size ?? 22) - 2) })}
                  >
                    A−
                  </button>,
                  <span key="szv" className="slide-prop-label">{selElData!.size ?? 22}</span>,
                  <button
                    key="szp"
                    className="sht-btn"
                    title="글자 크게"
                    onClick={() => updateSel({ size: Math.min(80, (selElData!.size ?? 22) + 2) })}
                  >
                    A＋
                  </button>,
                  <div key="tcolor" className="slide-shape-wrap">
                    <button
                      className="sht-btn cbtn"
                      title="글자색"
                      onClick={() => setColorMenu(colorMenu === 'text' ? null : 'text')}
                    >
                      <span className="cbtn-chip" style={{ background: selElData!.color || '#1c2024' }} />
                      A ▾
                    </button>
                    {colorMenu === 'text' && (
                      <>
                        <div className="slide-shape-back" onClick={() => setColorMenu(null)} />
                        <div className="slide-color-pop">
                          <ColorGrid
                            value={selElData!.color}
                            noneLabel="기본"
                            onPick={(c) => {
                              updateSel({ color: c });
                              setColorMenu(null);
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>,
                ]
              : []),
          ]}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void addImage(f);
            e.target.value = '';
          }}
        />
        <div className="slide-right">
          <div className="slide-shape-wrap">
            <button className="slide-pdf-btn" onClick={() => setExportMenu((v) => !v)} title="내보내기">
              내보내기 ▾
            </button>
            {exportMenu && (
              <>
                <div className="slide-shape-back" onClick={() => setExportMenu(false)} />
                <div className="slide-shape-menu slide-export-menu">
                  <button
                    onClick={() => {
                      setExportMenu(false);
                      setPrinting(true);
                    }}
                  >
                    PDF (인쇄)
                  </button>
                  <button onClick={() => void doExportPptx()}>파워포인트 (.pptx)</button>
                </div>
              </>
            )}
          </div>
          <button
            className="slide-present-btn"
            onClick={() => {
              setPresentIdx(slides.findIndex((s) => s.id === activeSlideId) || 0);
              setPresent(true);
            }}
          >
            <PlayIcon size={12} /> 발표
          </button>
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>
      <div className="slide-body">
        {/* 슬라이드 목록 */}
        <div className="slide-list">
          {slides.map((s, i) => (
            <div
              key={s.id}
              className={`slide-thumb${s.id === activeSlideId ? ' active' : ''}`}
              onClick={() => setActiveSlideId(s.id)}
            >
              <span className="slide-thumb-num">{i + 1}</span>
              <div className="slide-thumb-canvas" style={{ background: s.bg || undefined }}>
                {elsOf(s.id).map(([id, el]) => (
                  <div
                    key={id}
                    className="slide-thumb-el"
                    style={{
                      left: `${el.x}%`,
                      top: `${el.y}%`,
                      width: `${el.w}%`,
                      height: (el.type ?? 'text') === 'text' ? undefined : `${el.h}%`,
                      fontWeight: el.bold ? 800 : 400,
                      fontStyle: el.italic ? 'italic' : undefined,
                      textAlign: el.align ?? 'left',
                      color: el.color || undefined,
                      transform: el.rot ? `rotate(${el.rot}deg)` : undefined,
                    }}
                  >
                    {el.type === 'shape' && renderShapeSvg(el)}
                    {el.type === 'shape' && el.text && <span className="slide-thumb-shape-text">{el.text}</span>}
                    {el.type === 'image' && <img className="slide-el-img" src={el.src} alt="" />}
                    {(el.type ?? 'text') === 'text' && el.text}
                  </div>
                ))}
              </div>
              {slides.length > 1 && (
                <button className="slide-thumb-del" onClick={(e) => deleteSlide(s.id, e)}>
                  <CloseIcon size={10} />
                </button>
              )}
              <div className="slide-thumb-acts">
                <button title="복제" onClick={(e) => duplicateSlide(s.id, e)}>⧉</button>
                {i > 0 && (
                  <button title="위로" onClick={(e) => moveSlide(s.id, -1, e)}>↑</button>
                )}
                {i < slides.length - 1 && (
                  <button title="아래로" onClick={(e) => moveSlide(s.id, 1, e)}>↓</button>
                )}
              </div>
            </div>
          ))}
          <button className="slide-add" onClick={addSlide}>
            <PlusIcon size={16} /> 슬라이드
          </button>
        </div>
        {/* 편집 캔버스 */}
        <div className="slide-stage">
          <div
            className="slide-canvas"
            ref={canvasRef}
            style={{ background: activeSlide?.bg || undefined }}
            onMouseDown={() => clearSel()}
          >
            {activeEls.map(([id, el]) => renderEl(id, el, true))}
            {guides.v.map((x) => (
              <div key={`v${x}`} className="slide-guide-v" style={{ left: `${x}%` }} />
            ))}
            {guides.h.map((y) => (
              <div key={`h${y}`} className="slide-guide-h" style={{ top: `${y}%` }} />
            ))}
          </div>
          {/* 발표자 노트 */}
          <textarea
            className="slide-notes"
            placeholder="발표자 노트 — 발표 모드에서 '노트' 버튼으로 볼 수 있어요"
            value={slides.find((s) => s.id === activeSlideId)?.note ?? ''}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      {/* PDF 인쇄 전용 렌더 — 화면에선 숨김, 인쇄 시 슬라이드만 한 장씩 */}
      {printing && <style>{`@page { size: A4 landscape; margin: 8mm; }`}</style>}
      {printing && (
        <div className="slide-print">
          {slides.map((s) => (
            <div key={s.id} className="slide-print-page">
              <div className="slide-print-canvas" style={{ background: s.bg || undefined }}>
                {elsOf(s.id).map(([id, el]) => renderEl(id, el, false))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
