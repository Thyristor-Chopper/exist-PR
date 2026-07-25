import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import CodeDocEditor from './CodeDocEditor';
import DocEditor from './DocEditor';
import SheetEditor from './SheetEditor';
import SlideEditor from './SlideEditor';
import CanvasBoard from './CanvasBoard';
import Marquee from './Marquee';
import {
  FolderIcon,
  CodeIcon,
  DocIcon,
  SheetIcon,
  SlideIcon,
  PenIcon,
  ChevronIcon,
  PlusIcon,
  CopyIcon,
  TrashIcon,
  ShareIcon,
  ClipboardIcon,
} from './Icons';

/*
 * 공동편집 파일시스템 — 코드/문서/시트/발표/캔버스를 파일 단위로 여러 개, 폴더로 정리.
 * 데스크톱: 윈도우 파일탐색기식 — 내비게이션 바(뒤로/앞으로/상위/새로고침/경로/검색) +
 *           툴바(새로 만들기·잘라내기·복사·붙여넣기·이름 바꾸기·공유·삭제·정렬·보기·실행 취소).
 * 모바일: 기존 트리 UI 유지 (7/18 확정 모바일 UX).
 * 파일을 열면 에디터 전체 화면, ← 로 복귀. 한 번 연 파일은 마운트 유지(재연결 방지).
 */

type FileType = 'folder' | 'code' | 'doc' | 'sheet' | 'slide' | 'canvas';

interface CollabFile {
  id: number;
  parent_id: number | null;
  name: string;
  type: FileType;
  room: string | null;
  author: string;
  created_at?: string;
}

const TYPE_LABEL: Record<Exclude<FileType, 'folder'>, string> = {
  code: '코드',
  doc: '문서',
  sheet: '시트',
  slide: '발표',
  canvas: '캔버스',
};

function TypeIcon({ type, size = 15 }: { type: FileType; size?: number }) {
  if (type === 'folder') return <FolderIcon size={size} />;
  if (type === 'code') return <CodeIcon size={size} />;
  if (type === 'doc') return <DocIcon size={size} />;
  if (type === 'sheet') return <SheetIcon size={size} />;
  if (type === 'canvas') return <PenIcon size={size} />;
  return <SlideIcon size={size} />;
}

type SortKey = 'name' | 'type' | 'author';
type ViewMode = 'grid' | 'list';

/** 실행 취소 스택 항목 — 역연산 클로저 (삭제는 복구 불가라 스택에 안 쌓음) */
interface UndoOp {
  label: string;
  undo: () => Promise<void>;
}

function toast(message: string) {
  window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
}

export default function CollabFiles({ code, isHost }: { code: string; isHost: boolean }) {
  const user = useAuthStore((s) => s.user);
  const [files, setFiles] = useState<CollabFile[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [editorFull, setEditorFull] = useState(false); // 에디터 전체화면 (화면이 작을 때)
  const [openedIds, setOpenedIds] = useState<number[]>([]); // 마운트 유지용
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  // 생성 플로우: 타입 선택 → 이름 입력
  const [creating, setCreating] = useState<{ parentId: number | null; type: FileType } | null>(null);
  const [typeMenuFor, setTypeMenuFor] = useState<number | null | 'root'>(null); // 'root' | folderId
  const [nameInput, setNameInput] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);

  // ── 탐색기(데스크톱) 상태 ──
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [cwd, setCwd] = useState<number | null>(null); // 현재 폴더 (null=루트)
  const backStack = useRef<(number | null)[]>([]);
  const fwdStack = useRef<(number | null)[]>([]);
  const [, forceNav] = useState(0); // 스택 변경 시 버튼 활성화 갱신용
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set()); // 다중 선택
  const anchorRef = useRef<number | null>(null); // Shift 범위 선택 기준점
  const [clipboard, setClipboard] = useState<{ op: 'cut' | 'copy'; ids: number[] } | null>(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [sortMenu, setSortMenu] = useState(false);
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem('exist:cf-view') as ViewMode) || 'grid',
  );
  const undoStack = useRef<UndoOp[]>([]);
  const [, forceUndo] = useState(0);
  // 우클릭 메뉴 (targetId=null이면 빈 영역 메뉴)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; targetId: number | null } | null>(
    null,
  );
  // 휴지통 패널
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<
    { id: number; name: string; type: FileType; deleted_at: string; author: string; children: number }[]
  >([]);
  // 선택 파일 미리보기 (안에 뭐가 들었는지)
  const [preview, setPreview] = useState<{ id: number; items: string[]; count?: number } | null>(null);
  // 즐겨찾기 (기기별)
  const [favs, setFavs] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(`exist:cf-fav:${code}`) ?? '[]') as number[];
    } catch {
      return [];
    }
  });
  // 러버밴드(드래그 박스 선택) + 드래그 이동
  const [rubber, setRubber] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const rubberMoved = useRef(false);
  const entryRefs = useRef(new Map<number, HTMLElement>());
  const dragIdsRef = useRef<number[]>([]);
  const [dropTarget, setDropTarget] = useState<number | 'root' | null>(null);
  const renameTimerRef = useRef<number | null>(null); // 선택된 항목 이름 재클릭 → 지연 후 인라인 편집

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const load = useCallback(() => {
    void api<CollabFile[]>(`/api/meetings/${code}/files`)
      .then(setFiles)
      .catch(() => {});
  }, [code]);

  useEffect(load, [load]);

  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const byParent = useMemo(() => {
    const map = new Map<number | null, CollabFile[]>();
    for (const f of files) {
      const key = f.parent_id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [files]);

  const active = files.find((f) => f.id === activeId) ?? null;
  const openedFiles = openedIds
    .map((id) => files.find((f) => f.id === id))
    .filter((f): f is CollabFile => !!f && f.type !== 'folder' && !!f.room);

  const canEdit = (f: CollabFile) => isHost || f.author === user?.username;

  function pushUndo(op: UndoOp) {
    undoStack.current.push(op);
    if (undoStack.current.length > 20) undoStack.current.shift();
    forceUndo((n) => n + 1);
  }

  // ── 선택 ──
  function clearSel() {
    setSelectedIds(new Set());
    anchorRef.current = null;
  }

  function selectOnly(id: number) {
    setSelectedIds(new Set([id]));
    anchorRef.current = id;
  }

  /** 클릭 선택 — 윈도우식 (Ctrl 토글, Shift 범위, 그냥 클릭은 단일) */
  function clickSelect(f: CollabFile, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(f.id)) next.delete(f.id);
        else next.add(f.id);
        return next;
      });
      anchorRef.current = f.id;
    } else if (e.shiftKey && anchorRef.current != null) {
      const a = items.findIndex((x) => x.id === anchorRef.current);
      const b = items.findIndex((x) => x.id === f.id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        setSelectedIds(new Set(items.slice(lo, hi + 1).map((x) => x.id)));
      } else selectOnly(f.id);
    } else {
      selectOnly(f.id);
    }
  }

  // ── 내비게이션 ──
  function navigate(to: number | null) {
    if (to === cwd) return;
    backStack.current.push(cwd);
    fwdStack.current = [];
    setCwd(to);
    clearSel();
    setSearch('');
    forceNav((n) => n + 1);
  }

  function goBack() {
    if (backStack.current.length === 0) return;
    fwdStack.current.push(cwd);
    setCwd(backStack.current.pop()!);
    clearSel();
    forceNav((n) => n + 1);
  }

  function goForward() {
    if (fwdStack.current.length === 0) return;
    backStack.current.push(cwd);
    setCwd(fwdStack.current.pop()!);
    clearSel();
    forceNav((n) => n + 1);
  }

  function goUp() {
    if (cwd === null) return;
    navigate(byId.get(cwd)?.parent_id ?? null);
  }

  /** 경로(브레드크럼) — 루트부터 현재 폴더까지 */
  const crumbs = useMemo(() => {
    const list: CollabFile[] = [];
    let cur = cwd;
    while (cur != null) {
      const f = byId.get(cur);
      if (!f) break;
      list.unshift(f);
      cur = f.parent_id;
    }
    return list;
  }, [cwd, byId]);

  // ── 목록 (검색·정렬 반영) ──
  const items = useMemo(() => {
    let list: CollabFile[];
    if (search.trim()) {
      // 검색: 현재 폴더 하위 전체에서 이름 매칭
      const q = search.trim().toLowerCase();
      const inScope = new Set<number | null>([cwd]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of files) {
          if (f.type === 'folder' && inScope.has(f.parent_id) && !inScope.has(f.id)) {
            inScope.add(f.id);
            grew = true;
          }
        }
      }
      list = files.filter((f) => inScope.has(f.parent_id) && f.name.toLowerCase().includes(q));
    } else {
      list = byParent.get(cwd) ?? [];
    }
    const cmp: Record<SortKey, (a: CollabFile, b: CollabFile) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, 'ko'),
      type: (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'ko'),
      author: (a, b) => a.author.localeCompare(b.author, 'ko') || a.name.localeCompare(b.name, 'ko'),
    };
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      // 폴더 먼저 (윈도우식)
      if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1;
      return cmp[sortKey](a, b) * dir;
    });
  }, [files, byParent, cwd, search, sortKey, sortDir]);

  /** 단일 선택일 때만 상세 패널 대상 */
  const selected = selectedIds.size === 1 ? (byId.get([...selectedIds][0]) ?? null) : null;
  const selList = useMemo(
    () => [...selectedIds].map((id) => byId.get(id)).filter((f): f is CollabFile => !!f),
    [selectedIds, byId],
  );

  // 전체화면 Esc 종료 — 입력 중이거나 발표 모드가 떠 있으면 양보
  useEffect(() => {
    if (!editorFull) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (document.querySelector('.slide-present')) return; // 발표 모드 Esc가 우선
      setEditorFull(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorFull]);

  // ── 파일 열기 ──
  function openFile(f: CollabFile) {
    if (f.type === 'folder') {
      if (isMobile) {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(f.id)) next.delete(f.id);
          else next.add(f.id);
          return next;
        });
      } else {
        navigate(f.id);
      }
      return;
    }
    setActiveId(f.id);
    setOpenedIds((prev) => (prev.includes(f.id) ? prev : [...prev, f.id]));
  }

  // ── 액션 ──
  async function createEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!creating) return;
    const name = nameInput.trim();
    if (!name) return;
    try {
      const f = await api<CollabFile>(`/api/meetings/${code}/files`, {
        method: 'POST',
        body: { name, type: creating.type, parent_id: creating.parentId },
      });
      setFiles((prev) => [...prev, { ...f, author: user?.username ?? '' }]);
      setCreating(null);
      setNameInput('');
      pushUndo({
        label: `"${name}" 만들기`,
        undo: async () => {
          await api(`/api/meetings/${code}/files/${f.id}`, { method: 'DELETE' });
          load();
        },
      });
      if (f.type !== 'folder') openFile({ ...f, author: user?.username ?? '' });
    } catch {
      /* 전역 토스트 */
    }
  }

  async function renameEntry(f: CollabFile, e: React.FormEvent) {
    e.preventDefault();
    const name = nameInput.trim();
    setRenamingId(null);
    if (!name || name === f.name) return;
    const prevName = f.name;
    try {
      await api(`/api/meetings/${code}/files/${f.id}`, { method: 'PATCH', body: { name } });
      setFiles((prev) => prev.map((x) => (x.id === f.id ? { ...x, name } : x)));
      pushUndo({
        label: `이름 바꾸기 (${prevName} → ${name})`,
        undo: async () => {
          await api(`/api/meetings/${code}/files/${f.id}`, { method: 'PATCH', body: { name: prevName } });
          load();
        },
      });
    } catch {
      /* 전역 토스트 */
    }
  }

  /** 선택 항목들 → 휴지통 (복원 가능하므로 확인창 없이, 실행 취소는 복원) */
  async function deleteSelection(targets?: CollabFile[]) {
    const list = (targets ?? selList).filter((f) => canEdit(f));
    if (list.length === 0) return;
    const done: CollabFile[] = [];
    try {
      for (const f of list) {
        await api(`/api/meetings/${code}/files/${f.id}`, { method: 'DELETE' });
        done.push(f);
        if (activeId === f.id) setActiveId(null);
        setOpenedIds((prev) => prev.filter((id) => id !== f.id));
      }
    } catch {
      /* 일부 실패 — 전역 토스트 */
    }
    if (done.length > 0) {
      pushUndo({
        label: done.length === 1 ? `"${done[0].name}" 삭제` : `${done.length}개 삭제`,
        undo: async () => {
          for (const f of done)
            await api(`/api/meetings/${code}/files/trash/${f.id}/restore`, { method: 'POST' });
          load();
        },
      });
      toast(`휴지통으로 이동 — ${done.length === 1 ? `"${done[0].name}"` : `${done.length}개 항목`}`);
    }
    clearSel();
    setClipboard((c) => (c ? { ...c, ids: c.ids.filter((id) => !done.some((f) => f.id === id)) } : c));
    load();
  }

  async function paste() {
    if (!clipboard) return;
    const srcs = clipboard.ids.map((id) => byId.get(id)).filter((f): f is CollabFile => !!f);
    if (srcs.length === 0) {
      setClipboard(null);
      return;
    }
    try {
      if (clipboard.op === 'cut') {
        const moved: { id: number; from: number | null; name: string }[] = [];
        for (const src of srcs) {
          if (src.parent_id === cwd) continue;
          await api(`/api/meetings/${code}/files/${src.id}`, {
            method: 'PATCH',
            body: { parent_id: cwd },
          });
          moved.push({ id: src.id, from: src.parent_id, name: src.name });
        }
        if (moved.length > 0)
          pushUndo({
            label: moved.length === 1 ? `"${moved[0].name}" 이동` : `${moved.length}개 이동`,
            undo: async () => {
              for (const m of moved)
                await api(`/api/meetings/${code}/files/${m.id}`, {
                  method: 'PATCH',
                  body: { parent_id: m.from },
                });
              load();
            },
          });
        setClipboard(null);
      } else {
        const copied: { id: number; name: string }[] = [];
        for (const src of srcs) {
          const r = await api<{ id: number }>(`/api/meetings/${code}/files/${src.id}/copy`, {
            method: 'POST',
            body: { parent_id: cwd },
          });
          copied.push({ id: r.id, name: src.name });
        }
        if (copied.length > 0)
          pushUndo({
            label: copied.length === 1 ? `"${copied[0].name}" 복사` : `${copied.length}개 복사`,
            undo: async () => {
              for (const c of copied)
                await api(`/api/meetings/${code}/files/${c.id}`, { method: 'DELETE' });
              load();
            },
          });
      }
      load();
    } catch {
      /* 전역 토스트 */
    }
  }

  /** 드래그 앤 드롭 / 명령으로 여러 개를 폴더로 이동 */
  async function moveMany(ids: number[], target: number | null) {
    const moved: { id: number; from: number | null; name: string }[] = [];
    for (const id of ids) {
      const src = byId.get(id);
      if (!src || !canEdit(src) || src.parent_id === target || src.id === target) continue;
      // 자기 하위로 이동 방지 (클라 선검사 — 서버도 검사함)
      let cur: number | null = target;
      let cycle = false;
      while (cur != null) {
        if (cur === id) {
          cycle = true;
          break;
        }
        cur = byId.get(cur)?.parent_id ?? null;
      }
      if (cycle) continue;
      try {
        await api(`/api/meetings/${code}/files/${id}`, {
          method: 'PATCH',
          body: { parent_id: target },
        });
        moved.push({ id, from: src.parent_id, name: src.name });
      } catch {
        /* 이름 충돌 등 — 전역 토스트 */
      }
    }
    if (moved.length > 0) {
      pushUndo({
        label: moved.length === 1 ? `"${moved[0].name}" 이동` : `${moved.length}개 이동`,
        undo: async () => {
          for (const m of moved)
            await api(`/api/meetings/${code}/files/${m.id}`, {
              method: 'PATCH',
              body: { parent_id: m.from },
            });
          load();
        },
      });
      load();
    }
  }

  // ── 휴지통 ──
  async function loadTrash() {
    try {
      setTrashItems(
        await api<typeof trashItems>(`/api/meetings/${code}/files/trash/list`),
      );
    } catch {
      /* 전역 토스트 */
    }
  }

  async function restoreTrash(id: number) {
    try {
      await api(`/api/meetings/${code}/files/trash/${id}/restore`, { method: 'POST' });
      await loadTrash();
      load();
    } catch {
      /* 전역 토스트 */
    }
  }

  async function purgeTrash(id: number) {
    if (!confirm('영구 삭제하면 내용까지 완전히 사라져요. 계속할까요?')) return;
    try {
      await api(`/api/meetings/${code}/files/trash/${id}`, { method: 'DELETE' });
      await loadTrash();
    } catch {
      /* 전역 토스트 */
    }
  }

  // ── 즐겨찾기 (기기별) ──
  function toggleFav(id: number) {
    setFavs((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      localStorage.setItem(`exist:cf-fav:${code}`, JSON.stringify(next));
      return next;
    });
  }

  // ── 미리보기 — 단일 선택된 파일 안에 뭐가 들었는지 ──
  useEffect(() => {
    if (!selected || selected.type === 'folder') {
      setPreview(null);
      return;
    }
    const id = selected.id;
    let alive = true;
    void api<{ items: string[]; count?: number }>(`/api/meetings/${code}/files/${id}/preview`)
      .then((r) => {
        if (alive) setPreview({ id, items: r.items ?? [], count: r.count });
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  async function undo() {
    const op = undoStack.current.pop();
    forceUndo((n) => n + 1);
    if (!op) return;
    try {
      await op.undo();
      toast(`실행 취소: ${op.label}`);
    } catch {
      toast('실행 취소에 실패했어요 (이미 바뀌었을 수 있어요)');
    }
  }

  function startRename(f: CollabFile) {
    if (!canEdit(f)) return;
    setRenamingId(f.id);
    setNameInput(f.name);
  }

  /** 그리드 열 수 — 화살표 위/아래 이동용 (첫 줄에 놓인 엔트리 수를 실측) */
  function gridCols(): number {
    if (view === 'list') return 1;
    let cols = 0;
    let firstTop: number | null = null;
    for (const f of items) {
      const el = entryRefs.current.get(f.id);
      if (!el) continue;
      const t = Math.round(el.getBoundingClientRect().top);
      if (firstTop === null) firstTop = t;
      if (Math.abs(t - firstTop) < 4) cols++;
      else break;
    }
    return Math.max(1, cols);
  }

  /** 탐색기 키보드 — Enter 열기 / F2 이름 / Delete 삭제 / Ctrl+C·X·V·A / 방향키 */
  function onExplorerKey(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 검색·이름 입력 중엔 무시
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === 'Escape') {
      setCtxMenu(null);
      setSortMenu(false);
      clearSel();
      return;
    }
    if (ctrl && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      setSelectedIds(new Set(items.map((f) => f.id)));
      return;
    }
    if (ctrl && (e.key === 'c' || e.key === 'C')) {
      if (selectedIds.size > 0) setClipboard({ op: 'copy', ids: [...selectedIds] });
      return;
    }
    if (ctrl && (e.key === 'x' || e.key === 'X')) {
      const ids = selList.filter(canEdit).map((f) => f.id);
      if (ids.length > 0) setClipboard({ op: 'cut', ids });
      return;
    }
    if (ctrl && (e.key === 'v' || e.key === 'V')) {
      void paste();
      return;
    }
    if (e.key === 'Enter') {
      if (selected) openFile(selected);
      return;
    }
    if (e.key === 'F2') {
      if (selected) startRename(selected);
      return;
    }
    if (e.key === 'Delete') {
      void deleteSelection();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      if (items.length === 0) return;
      const curId = anchorRef.current ?? [...selectedIds][0];
      const cur = items.findIndex((f) => f.id === curId);
      const cols = gridCols();
      const delta =
        e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : cols;
      const next = cur < 0 ? 0 : Math.max(0, Math.min(items.length - 1, cur + delta));
      selectOnly(items[next].id);
      entryRefs.current.get(items[next].id)?.scrollIntoView({ block: 'nearest' });
    }
  }

  // 우클릭 메뉴 — 바깥 클릭·Escape로 닫기
  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: PointerEvent) {
      if (!(e.target as HTMLElement).closest('.cf-ctx')) setCtxMenu(null);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [ctxMenu]);

  // 정렬·새로 만들기 드롭다운 — 바깥 클릭으로 닫기
  useEffect(() => {
    if (!sortMenu && typeMenuFor === null) return;
    function onDown(e: PointerEvent) {
      if (!(e.target as HTMLElement).closest('.cf-type-menu, .cf-tool-wrap, .cf-actions')) {
        setSortMenu(false);
        setTypeMenuFor(null);
      }
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [sortMenu, typeMenuFor]);

  function share(f: CollabFile) {
    const link = `${location.origin}/meeting/${code}`;
    void navigator.clipboard
      .writeText(`[exist] ${f.name} — ${link}`)
      .then(() => toast('그룹 링크를 복사했어요'))
      .catch(() => toast('클립보드 복사에 실패했어요'));
  }

  function TypeMenu({ parentId }: { parentId: number | null }) {
    return (
      <div className="cf-type-menu">
        {(['folder', 'code', 'doc', 'sheet', 'slide', 'canvas'] as FileType[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setCreating({ parentId, type: t });
              setTypeMenuFor(null);
              setNameInput('');
            }}
          >
            <TypeIcon type={t} size={14} /> {t === 'folder' ? '폴더' : TYPE_LABEL[t]}
          </button>
        ))}
      </div>
    );
  }

  // ── 모바일 — 기존 트리 ──
  function renderTree(parentId: number | null, depth: number) {
    const children = byParent.get(parentId) ?? [];
    return (
      <>
        {children.map((f) => (
          <div key={f.id}>
            <div
              className={`cf-item${f.id === activeId ? ' active' : ''}`}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => openFile(f)}
            >
              {f.type === 'folder' && (
                <span className={`cf-chevron${collapsed.has(f.id) ? '' : ' open'}`}>
                  <ChevronIcon size={11} />
                </span>
              )}
              <span className={`cf-icon ${f.type}`}>
                <TypeIcon type={f.type} />
              </span>
              {renamingId === f.id ? (
                <form onSubmit={(e) => renameEntry(f, e)} onClick={(e) => e.stopPropagation()}>
                  <input
                    className="cf-name-input"
                    autoFocus
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={() => setRenamingId(null)}
                    maxLength={60}
                  />
                </form>
              ) : (
                <Marquee className="cf-name">{f.name}</Marquee>
              )}
              <span className="cf-actions" onClick={(e) => e.stopPropagation()}>
                {f.type === 'folder' && (
                  <button title="안에 만들기" onClick={() => setTypeMenuFor(f.id)}>
                    ＋
                  </button>
                )}
                {canEdit(f) && (
                  <>
                    <button
                      title="이름 변경"
                      onClick={() => {
                        setRenamingId(f.id);
                        setNameInput(f.name);
                      }}
                    >
                      ✎
                    </button>
                    <button title="삭제" className="danger" onClick={() => void deleteSelection([f])}>
                      ×
                    </button>
                  </>
                )}
              </span>
            </div>
            {typeMenuFor === f.id && <TypeMenu parentId={f.id} />}
            {creating?.parentId === f.id && (
              <form
                className="cf-new"
                style={{ paddingLeft: 10 + (depth + 1) * 14 }}
                onSubmit={createEntry}
              >
                <span className={`cf-icon ${creating.type}`}>
                  <TypeIcon type={creating.type} />
                </span>
                <input
                  className="cf-name-input"
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={() => {
                    if (!nameInput.trim()) setCreating(null);
                  }}
                  placeholder="이름"
                  maxLength={60}
                />
              </form>
            )}
            {f.type === 'folder' && !collapsed.has(f.id) && renderTree(f.id, depth + 1)}
          </div>
        ))}
      </>
    );
  }

  // ── 데스크톱 — 윈도우 탐색기 ──
  function renderExplorer() {
    const selCount = selectedIds.size;
    const disabledSel = selCount === 0;
    const editables = selList.filter(canEdit);
    const cantTouch = editables.length === 0;
    const favFiles = favs.map((id) => byId.get(id)).filter((f): f is CollabFile => !!f);
    const ctxTarget = ctxMenu?.targetId != null ? (byId.get(ctxMenu.targetId) ?? null) : null;
    // 컨텍스트 대상이 선택에 포함돼 있으면 선택 전체에 적용
    const ctxIds = ctxTarget
      ? selectedIds.has(ctxTarget.id)
        ? [...selectedIds]
        : [ctxTarget.id]
      : [];
    const ctxEditable = ctxIds.some((id) => {
      const x = byId.get(id);
      return x && canEdit(x);
    });
    const hdrClick = (k: SortKey) => {
      if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      else {
        setSortKey(k);
        setSortDir('asc');
      }
    };
    const hdrInd = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

    return (
      <div
        className="cf-explorer"
        style={{ display: active ? 'none' : undefined }}
        tabIndex={0}
        onKeyDown={onExplorerKey}
      >
        {/* 1줄 — 내비게이션 바 */}
        <div className="cf-nav">
          <button title="뒤로" disabled={backStack.current.length === 0} onClick={goBack}>
            ←
          </button>
          <button title="앞으로" disabled={fwdStack.current.length === 0} onClick={goForward}>
            →
          </button>
          <button title="상위 폴더" disabled={cwd === null} onClick={goUp}>
            ↑
          </button>
          <button title="새로고침" onClick={load}>
            ⟳
          </button>
          <div className="cf-path">
            <button
              className={`cf-crumb${dropTarget === 'root' ? ' droptarget' : ''}`}
              onClick={() => navigate(null)}
              onDragOver={(e) => {
                if (dragIdsRef.current.length === 0) return;
                e.preventDefault();
                setDropTarget('root');
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                const ids = dragIdsRef.current;
                dragIdsRef.current = [];
                setDropTarget(null);
                void moveMany(ids, null);
              }}
            >
              <FolderIcon size={13} /> 공동편집
            </button>
            {crumbs.map((c) => (
              <span key={c.id} className="cf-crumb-seg">
                <ChevronIcon size={11} />
                <button
                  className={`cf-crumb${dropTarget === c.id ? ' droptarget' : ''}`}
                  onClick={() => navigate(c.id)}
                  onDragOver={(e) => {
                    if (dragIdsRef.current.length === 0 || dragIdsRef.current.includes(c.id)) return;
                    e.preventDefault();
                    setDropTarget(c.id);
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === c.id ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault();
                    const ids = dragIdsRef.current;
                    dragIdsRef.current = [];
                    setDropTarget(null);
                    void moveMany(ids, c.id);
                  }}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          <input
            className="cf-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`${cwd === null ? '공동편집' : (byId.get(cwd)?.name ?? '')} 검색`}
          />
        </div>

        {/* 2줄 — 툴바 */}
        <div className="cf-toolbar">
          <div className="cf-tool-wrap">
            <button className="cf-tool primary" onClick={() => setTypeMenuFor('root')}>
              <PlusIcon size={13} /> 새로 만들기
            </button>
            {typeMenuFor === 'root' && <TypeMenu parentId={cwd} />}
          </div>
          <span className="cf-tool-sep" />
          <button
            className="cf-tool"
            disabled={cantTouch}
            onClick={() => setClipboard({ op: 'cut', ids: editables.map((f) => f.id) })}
          >
            ✂ 잘라내기
          </button>
          <button
            className="cf-tool"
            disabled={disabledSel}
            onClick={() => setClipboard({ op: 'copy', ids: [...selectedIds] })}
          >
            <CopyIcon size={13} /> 복사
          </button>
          <button className="cf-tool" disabled={!clipboard} onClick={() => void paste()}>
            <ClipboardIcon size={13} /> 붙여넣기
          </button>
          <button
            className="cf-tool"
            disabled={!selected || !canEdit(selected)}
            onClick={() => selected && startRename(selected)}
          >
            ✎ 이름 바꾸기
          </button>
          <button className="cf-tool" disabled={!selected} onClick={() => selected && share(selected)}>
            <ShareIcon size={13} /> 공유
          </button>
          <button className="cf-tool danger" disabled={cantTouch} onClick={() => void deleteSelection()}>
            <TrashIcon size={13} /> 삭제
          </button>
          <button
            className={`cf-tool${trashOpen ? ' on' : ''}`}
            onClick={() => {
              setTrashOpen((v) => !v);
              if (!trashOpen) void loadTrash();
            }}
          >
            ♻ 휴지통
          </button>
          <span className="cf-tool-sep" />
          <div className="cf-tool-wrap">
            <button className="cf-tool" onClick={() => setSortMenu((v) => !v)}>
              ⇅ 정렬
            </button>
            {sortMenu && (
              <div className="cf-type-menu">
                {(
                  [
                    ['name', '이름'],
                    ['type', '종류'],
                    ['author', '만든 사람'],
                  ] as [SortKey, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => {
                      setSortKey(k);
                      setSortMenu(false);
                    }}
                  >
                    {sortKey === k ? '✓ ' : ''}
                    {label}
                  </button>
                ))}
                <div className="cf-menu-sep" />
                <button
                  onClick={() => {
                    setSortDir('asc');
                    setSortMenu(false);
                  }}
                >
                  {sortDir === 'asc' ? '✓ ' : ''}오름차순
                </button>
                <button
                  onClick={() => {
                    setSortDir('desc');
                    setSortMenu(false);
                  }}
                >
                  {sortDir === 'desc' ? '✓ ' : ''}내림차순
                </button>
              </div>
            )}
          </div>
          <button
            className="cf-tool"
            onClick={() => {
              const next: ViewMode = view === 'grid' ? 'list' : 'grid';
              setView(next);
              localStorage.setItem('exist:cf-view', next);
            }}
          >
            {view === 'grid' ? '☰ 목록 보기' : '▦ 아이콘 보기'}
          </button>
          <button
            className="cf-tool"
            disabled={undoStack.current.length === 0}
            onClick={() => void undo()}
            title={undoStack.current.at(-1)?.label ?? ''}
          >
            ↩ 실행 취소
          </button>
        </div>

        {/* 즐겨찾기 바 — 우클릭으로 추가한 항목 바로가기 */}
        {favFiles.length > 0 && (
          <div className="cf-favbar">
            <span className="cf-favbar-label">★</span>
            {favFiles.map((f) => (
              <button
                key={f.id}
                className="cf-fav-chip"
                title={f.name}
                onClick={() => (f.type === 'folder' ? navigate(f.id) : openFile(f))}
              >
                <TypeIcon type={f.type} size={12} /> {f.name}
              </button>
            ))}
          </div>
        )}

        {/* 본문 — 현재 폴더 내용 (+ 선택 시 오른쪽 세부 정보) */}
        <div className="cf-body">
        <div
          className={`cf-main ${view}`}
          onClick={() => {
            if (rubberMoved.current) {
              rubberMoved.current = false;
              return;
            }
            clearSel();
          }}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.cf-entry')) return;
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, targetId: null });
          }}
          onPointerDown={(e) => {
            // 러버밴드 — 빈 곳에서 드래그로 박스 선택
            if (e.button !== 0) return;
            if ((e.target as HTMLElement).closest('.cf-entry, form, input, button')) return;
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {
              /* 캡처 불가 환경 무시 */
            }
            rubberMoved.current = false;
            setRubber({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
          }}
          onPointerMove={(e) => {
            if (!rubber) return;
            const nr = { ...rubber, x1: e.clientX, y1: e.clientY };
            setRubber(nr);
            if (Math.abs(nr.x1 - nr.x0) + Math.abs(nr.y1 - nr.y0) > 8) rubberMoved.current = true;
            if (!rubberMoved.current) return;
            const [lx, hx] = nr.x0 < nr.x1 ? [nr.x0, nr.x1] : [nr.x1, nr.x0];
            const [ly, hy] = nr.y0 < nr.y1 ? [nr.y0, nr.y1] : [nr.y1, nr.y0];
            const hit = new Set<number>();
            for (const f of items) {
              const el = entryRefs.current.get(f.id);
              if (!el) continue;
              const r2 = el.getBoundingClientRect();
              if (r2.right > lx && r2.left < hx && r2.bottom > ly && r2.top < hy) hit.add(f.id);
            }
            setSelectedIds(hit);
          }}
          onPointerUp={() => setRubber(null)}
        >
          {rubber && rubberMoved.current && (
            <div
              className="cf-rubber"
              style={{
                left: Math.min(rubber.x0, rubber.x1),
                top: Math.min(rubber.y0, rubber.y1),
                width: Math.abs(rubber.x1 - rubber.x0),
                height: Math.abs(rubber.y1 - rubber.y0),
              }}
            />
          )}
          {view === 'list' && items.length > 0 && (
            <div className="cf-listhead">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('name');
                }}
              >
                이름{hdrInd('name')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('type');
                }}
              >
                종류{hdrInd('type')}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('author');
                }}
              >
                만든 사람{hdrInd('author')}
              </button>
            </div>
          )}
          {creating && (
            <form className="cf-new cf-main-new" onSubmit={createEntry} onClick={(e) => e.stopPropagation()}>
              <span className={`cf-icon ${creating.type}`}>
                <TypeIcon type={creating.type} size={view === 'grid' ? 30 : 15} />
              </span>
              <input
                className="cf-name-input"
                autoFocus
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onBlur={() => {
                  if (!nameInput.trim()) setCreating(null);
                }}
                placeholder="이름"
                maxLength={60}
              />
            </form>
          )}
          {items.length === 0 && !creating ? (
            <div className="cf-empty">
              {search ? '검색 결과가 없어요' : '비어 있는 폴더예요 — 새로 만들기로 시작해보세요'}
            </div>
          ) : (
            items.map((f) => {
              const isSel = selectedIds.has(f.id);
              return (
              <div
                key={f.id}
                ref={(el) => {
                  if (el) entryRefs.current.set(f.id, el);
                  else entryRefs.current.delete(f.id);
                }}
                className={`cf-entry${isSel ? ' selected' : ''}${
                  clipboard?.op === 'cut' && clipboard.ids.includes(f.id) ? ' cutting' : ''
                }${dropTarget === f.id ? ' droptarget' : ''}`}
                draggable
                onDragStart={(e) => {
                  if (!selectedIds.has(f.id)) selectOnly(f.id);
                  const base = selectedIds.has(f.id) ? [...selectedIds, f.id] : [f.id];
                  const ids = [...new Set(base)].filter((id) => {
                    const x = byId.get(id);
                    return x && canEdit(x);
                  });
                  dragIdsRef.current = ids;
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', '');
                }}
                onDragEnd={() => {
                  dragIdsRef.current = [];
                  setDropTarget(null);
                }}
                onDragOver={(e) => {
                  if (
                    f.type !== 'folder' ||
                    dragIdsRef.current.length === 0 ||
                    dragIdsRef.current.includes(f.id)
                  )
                    return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropTarget(f.id);
                }}
                onDragLeave={() => setDropTarget((t) => (t === f.id ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (f.type !== 'folder') return;
                  const ids = dragIdsRef.current;
                  dragIdsRef.current = [];
                  setDropTarget(null);
                  void moveMany(ids, f.id);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  clickSelect(f, e);
                }}
                onDoubleClick={() => {
                  if (renameTimerRef.current) {
                    window.clearTimeout(renameTimerRef.current);
                    renameTimerRef.current = null;
                  }
                  openFile(f);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!selectedIds.has(f.id)) selectOnly(f.id);
                  setCtxMenu({ x: e.clientX, y: e.clientY, targetId: f.id });
                }}
                title={`${f.name} · ${f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]} · ${f.author}`}
              >
                <span className={`cf-entry-icon cf-icon ${f.type}`}>
                  <TypeIcon type={f.type} size={view === 'grid' ? 30 : 16} />
                </span>
                {renamingId === f.id ? (
                  <form onSubmit={(e) => renameEntry(f, e)} onClick={(e) => e.stopPropagation()}>
                    <input
                      className="cf-name-input"
                      autoFocus
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      onBlur={() => setRenamingId(null)}
                      maxLength={60}
                    />
                  </form>
                ) : (
                  <span
                    className="cf-entry-name"
                    onClick={(e) => {
                      // 윈도우식 — 이미 (단일)선택된 항목의 이름을 한 번 더 클릭하면 잠시 후 인라인 편집
                      if (isSel && selCount === 1 && canEdit(f) && renamingId == null) {
                        e.stopPropagation();
                        if (renameTimerRef.current) window.clearTimeout(renameTimerRef.current);
                        renameTimerRef.current = window.setTimeout(() => {
                          renameTimerRef.current = null;
                          startRename(f);
                        }, 450);
                      }
                    }}
                  >
                    {f.name}
                  </span>
                )}
                {view === 'list' && (
                  <>
                    <span className="cf-entry-type">
                      {f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]}
                    </span>
                    <span className="cf-entry-author">{f.author}</span>
                  </>
                )}
              </div>
              );
            })
          )}
        </div>

        {/* 세부 정보 패널 — 단일 선택은 상세, 다중 선택은 요약 */}
        {selCount > 1 && (
          <aside className="cf-details">
            <div className="cf-details-icon cf-icon folder">
              <CopyIcon size={36} />
            </div>
            <div className="cf-details-name">{selCount}개 항목 선택</div>
            <div className="cf-details-sub">
              폴더 {selList.filter((f) => f.type === 'folder').length}개 · 파일{' '}
              {selList.filter((f) => f.type !== 'folder').length}개
            </div>
          </aside>
        )}
        {selected && (
          <aside className="cf-details">
            <div className={`cf-details-icon cf-icon ${selected.type}`}>
              <TypeIcon type={selected.type} size={42} />
            </div>
            <div className="cf-details-name">
              {selected.name}
              <button
                className={`cf-fav-star${favs.includes(selected.id) ? ' on' : ''}`}
                title={favs.includes(selected.id) ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                onClick={() => toggleFav(selected.id)}
              >
                ★
              </button>
            </div>
            <div className="cf-details-sub">
              {selected.type === 'folder' ? '폴더' : `${TYPE_LABEL[selected.type]} 파일`}
            </div>
            <div className="cf-details-rows">
              <div className="cf-details-row">
                <span>위치</span>
                <b>
                  {['공동편집', ...crumbs.map((c) => c.name)].join(' › ')}
                </b>
              </div>
              <div className="cf-details-row">
                <span>만든 사람</span>
                <b>{selected.author || '—'}</b>
              </div>
              {selected.created_at && (
                <div className="cf-details-row">
                  <span>만든 날짜</span>
                  <b>
                    {new Date(selected.created_at + 'Z').toLocaleString('ko-KR', {
                      year: 'numeric',
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </b>
                </div>
              )}
              {selected.type === 'folder' && (
                <div className="cf-details-row">
                  <span>포함 항목</span>
                  <b>{(byParent.get(selected.id) ?? []).length}개</b>
                </div>
              )}
            </div>
            {/* 미리보기 — 문서 안에 뭐가 들었는지 */}
            {preview && preview.id === selected.id && (preview.items.length > 0 || preview.count != null) && (
              <div className="cf-details-preview">
                <div className="cf-details-prevtitle">내용</div>
                {preview.count != null ? (
                  <div className="cf-details-previtem">슬라이드 {preview.count}장</div>
                ) : (
                  preview.items.map((it, i) => (
                    <div key={i} className="cf-details-previtem">
                      {it}
                    </div>
                  ))
                )}
              </div>
            )}
            {selected.type !== 'folder' ? (
              <button className="cf-details-open" onClick={() => openFile(selected)}>
                열기
              </button>
            ) : (
              <button className="cf-details-open" onClick={() => navigate(selected.id)}>
                폴더 열기
              </button>
            )}
          </aside>
        )}
        </div>

        {/* 하단 상태바 — 윈도우식 */}
        <div className="cf-statusbar">
          항목 {items.length}개
          {selCount > 0 && ` · ${selCount}개 선택`}
          {search.trim() !== '' && ' · 검색 결과'}
        </div>

        {/* 우클릭 컨텍스트 메뉴 */}
        {ctxMenu && (
          <div
            className="cf-ctx"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 210),
              top: Math.min(ctxMenu.y, window.innerHeight - 330),
            }}
          >
            {ctxTarget ? (
              <>
                <button
                  onClick={() => {
                    openFile(ctxTarget);
                    setCtxMenu(null);
                  }}
                >
                  열기
                </button>
                <div className="cf-menu-sep" />
                <button
                  disabled={!ctxEditable}
                  onClick={() => {
                    setClipboard({
                      op: 'cut',
                      ids: ctxIds.filter((id) => {
                        const x = byId.get(id);
                        return x && canEdit(x);
                      }),
                    });
                    setCtxMenu(null);
                  }}
                >
                  잘라내기
                </button>
                <button
                  onClick={() => {
                    setClipboard({ op: 'copy', ids: ctxIds });
                    setCtxMenu(null);
                  }}
                >
                  복사
                </button>
                <button
                  disabled={!canEdit(ctxTarget) || ctxIds.length > 1}
                  onClick={() => {
                    startRename(ctxTarget);
                    setCtxMenu(null);
                  }}
                >
                  이름 바꾸기
                </button>
                <button
                  onClick={() => {
                    share(ctxTarget);
                    setCtxMenu(null);
                  }}
                >
                  공유
                </button>
                <button
                  onClick={() => {
                    toggleFav(ctxTarget.id);
                    setCtxMenu(null);
                  }}
                >
                  {favs.includes(ctxTarget.id) ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                </button>
                <div className="cf-menu-sep" />
                <button
                  className="danger"
                  disabled={!ctxEditable}
                  onClick={() => {
                    void deleteSelection(
                      ctxIds.map((id) => byId.get(id)).filter((f): f is CollabFile => !!f),
                    );
                    setCtxMenu(null);
                  }}
                >
                  삭제
                </button>
              </>
            ) : (
              <>
                <div className="cf-menu-label">새로 만들기</div>
                {(['folder', 'code', 'doc', 'sheet', 'slide', 'canvas'] as FileType[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setCreating({ parentId: cwd, type: t });
                      setNameInput('');
                      setCtxMenu(null);
                    }}
                  >
                    <TypeIcon type={t} size={13} /> {t === 'folder' ? '폴더' : TYPE_LABEL[t]}
                  </button>
                ))}
                <div className="cf-menu-sep" />
                <button
                  disabled={!clipboard}
                  onClick={() => {
                    void paste();
                    setCtxMenu(null);
                  }}
                >
                  붙여넣기
                </button>
                <button
                  onClick={() => {
                    setSelectedIds(new Set(items.map((f) => f.id)));
                    setCtxMenu(null);
                  }}
                >
                  모두 선택
                </button>
                <button
                  onClick={() => {
                    load();
                    setCtxMenu(null);
                  }}
                >
                  새로고침
                </button>
              </>
            )}
          </div>
        )}

        {/* 휴지통 패널 */}
        {trashOpen && (
          <div className="cf-trash">
            <div className="cf-trash-head">
              <b>♻ 휴지통</b>
              <button className="cf-trash-close" onClick={() => setTrashOpen(false)}>
                ×
              </button>
            </div>
            {trashItems.length === 0 ? (
              <div className="cf-empty">휴지통이 비어 있어요</div>
            ) : (
              trashItems.map((t) => (
                <div key={t.id} className="cf-trash-row">
                  <span className={`cf-icon ${t.type}`}>
                    <TypeIcon type={t.type} size={15} />
                  </span>
                  <span className="cf-trash-name" title={t.name}>
                    {t.name}
                    {t.children > 0 ? ` (+${t.children})` : ''}
                  </span>
                  <span className="cf-trash-meta">{t.author}</span>
                  <button onClick={() => void restoreTrash(t.id)}>복원</button>
                  <button className="danger" onClick={() => void purgeTrash(t.id)}>
                    영구 삭제
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`cf-wrap${active ? ' editing' : ''}`}>
      {isMobile ? (
        /* 모바일 — 기존 트리 탐색기 */
        <aside className="cf-side" style={{ display: active ? 'none' : undefined }}>
          <div className="cf-head">
            <span>파일</span>
            <button className="cf-add" title="새 파일/폴더" onClick={() => setTypeMenuFor('root')}>
              <PlusIcon size={14} />
            </button>
          </div>
          {typeMenuFor === 'root' && <TypeMenu parentId={null} />}
          <div className="cf-tree">
            {creating?.parentId === null && (
              <form className="cf-new" style={{ paddingLeft: 10 }} onSubmit={createEntry}>
                <span className={`cf-icon ${creating.type}`}>
                  <TypeIcon type={creating.type} />
                </span>
                <input
                  className="cf-name-input"
                  autoFocus
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={() => {
                    if (!nameInput.trim()) setCreating(null);
                  }}
                  placeholder="이름"
                  maxLength={60}
                />
              </form>
            )}
            {files.length === 0 && !creating ? (
              <div className="cf-empty">
                아직 파일이 없어요.
                <br />＋ 로 코드·문서·시트·발표·캔버스 파일을 만들어보세요.
              </div>
            ) : (
              renderTree(null, 0)
            )}
          </div>
        </aside>
      ) : (
        renderExplorer()
      )}

      {/* 에디터 — 파일을 열면 전체 화면, ← 로 탐색기 복귀 */}
      <div
        className={`cf-editor${editorFull && active ? ' full' : ''}`}
        style={{ display: active ? undefined : 'none' }}
      >
        {active && (
          <div className="cf-editor-bar">
            <button
              className="cf-back"
              title="파일 목록으로"
              onClick={() => {
                setActiveId(null);
                setEditorFull(false);
              }}
            >
              ←
            </button>
            {/* 경로 › [타입 아이콘] 파일명 — 아이콘은 파일명 바로 옆에 */}
            <span className="cf-editor-path">
              {(() => {
                const parts: string[] = [];
                let cur = active.parent_id;
                while (cur != null) {
                  const p = byId.get(cur);
                  if (!p) break;
                  parts.unshift(p.name);
                  cur = p.parent_id;
                }
                return ['공동편집', ...parts].map((s) => `${s} › `).join('');
              })()}
            </span>
            <span className={`cf-icon ${active.type}`}>
              <TypeIcon type={active.type} />
            </span>
            <Marquee className="cf-editor-name">{active.name}</Marquee>
            <button
              className={`cf-fullscreen${editorFull ? ' on' : ''}`}
              title={editorFull ? '창 크기로 (Esc)' : '전체화면'}
              onClick={() => setEditorFull((v) => !v)}
            >
              {editorFull ? '⤡' : '⛶'}
            </button>
          </div>
        )}
        {openedFiles.map((f) => (
          <div
            key={f.id}
            className="cf-editor-host"
            style={{ display: f.id === activeId ? 'flex' : 'none' }}
          >
            {f.type === 'code' && (
              <CodeDocEditor
                roomId={f.room!}
                // 같은 폴더의 이웃 문서 — 에디터 사이드바에서 바로 전환
                siblings={(byParent.get(f.parent_id) ?? [])
                  .filter((s) => s.type !== 'folder')
                  .map((s) => ({ id: s.id, name: s.name, type: s.type }))}
                currentSibId={f.id}
                onOpenSibling={(id) => {
                  const target = files.find((x) => x.id === id);
                  if (target) openFile(target);
                }}
              />
            )}
            {f.type === 'doc' && <DocEditor roomId={f.room!} />}
            {f.type === 'sheet' && <SheetEditor roomId={f.room!} />}
            {f.type === 'slide' && <SlideEditor roomId={f.room!} />}
            {f.type === 'canvas' && <CanvasBoard roomId={f.room!} />}
          </div>
        ))}
      </div>
    </div>
  );
}
