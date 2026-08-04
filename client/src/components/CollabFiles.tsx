import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../store';
import { useDisplayName } from '../names';
import CodeDocEditor from './CodeDocEditor';
import DocEditor from './DocEditor';
import SheetEditor from './SheetEditor';
import SlideEditor from './SlideEditor';
import CanvasBoard from './CanvasBoard';
import Marquee from './Marquee';
import Avatar from './Avatar';
import SignPad from './SignPad';
import {
  FolderIcon,
  CodeIcon,
  DocIcon,
  SheetIcon,
  SlideIcon,
  ChevronIcon,
  PlusIcon,
  UploadIcon,
  GridIcon,
  DownloadIcon,
  CopyIcon,
  TrashIcon,
  ShareIcon,
  ClipboardIcon,
  CheckMarkIcon,
  CloseIcon,
  ScissorsIcon,
  RefreshIcon,
  SortIcon,
  UndoIcon,
  StarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  PanelLeftIcon,
  FilterIcon,
  ClockIcon,
  UsersIcon,
  ListViewIcon,
  HomeIcon,
  RenameIcon,
  SelectAllIcon,
  SelectNoneIcon,
  SelectInvertIcon,
  WhiteboardIcon,
} from './Icons';

/*
 * 공동편집 파일시스템 — 코드/문서/시트/발표/캔버스를 파일 단위로 여러 개, 폴더로 정리.
 * 데스크톱: 윈도우 파일탐색기식 — 내비게이션 바(뒤로/앞으로/상위/새로고침/경로/검색) +
 *           툴바(새로 만들기·잘라내기·복사·붙여넣기·이름 바꾸기·공유·삭제·정렬·보기·실행 취소).
 * 모바일: 기존 트리 UI 유지 (7/18 확정 모바일 UX).
 * 파일을 열면 에디터 전체 화면, ← 로 복귀. 한 번 연 파일은 마운트 유지(재연결 방지).
 */

type FileType = 'folder' | 'code' | 'doc' | 'sheet' | 'slide' | 'canvas' | 'file';

interface CollabFile {
  id: number;
  parent_id: number | null;
  name: string;
  type: FileType;
  room: string | null;
  author: string;
  created_at?: string;
  mime?: string | null;
  size?: number | null;
  /** 열람 서명 (회람 사인) — 요청 여부·서명 수·내 서명 여부 */
  ack_required?: number;
  ack_count?: number;
  my_ack?: number;
}

interface FileAckStatus {
  required: boolean;
  total: number;
  acks: { username: string; ack_at: string; signature: string | null }[];
}

const TYPE_LABEL: Record<Exclude<FileType, 'folder'>, string> = {
  code: '코드',
  doc: '문서',
  sheet: '시트',
  slide: '발표',
  canvas: '캔버스',
  file: '업로드',
};

/** 업로드 파일(범용) 아이콘 — 모서리 접힌 종이 */
function BlobFileIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2.5h8L19 7.5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1Z" />
      <path d="M14 2.5v5h5" />
    </svg>
  );
}

function TypeIcon({ type, size = 15 }: { type: FileType; size?: number }) {
  if (type === 'folder') return <FolderIcon size={size} />;
  if (type === 'code') return <CodeIcon size={size} />;
  if (type === 'doc') return <DocIcon size={size} />;
  if (type === 'sheet') return <SheetIcon size={size} />;
  if (type === 'canvas') return <WhiteboardIcon size={size} />;
  if (type === 'file') return <BlobFileIcon size={size} />;
  return <SlideIcon size={size} />;
}

type SortKey = 'name' | 'type' | 'author' | 'date' | 'size';
type ViewMode = 'grid' | 'list';

/** 자연 정렬 — "파일-2"가 "파일-10"보다 앞 (윈도우식) */
function byNameNat(a: CollabFile, b: CollabFile): number {
  return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
}

function fmtSize(size: number | null | undefined): string {
  if (size == null) return '—';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso + 'Z');
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}. ${d.getDate()}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

/* ── 업로드 파일 인앱 미리보기 — 이미지·PDF·영상·음성·텍스트·한글(hwpx)은 앱 안에서 바로 연다 ── */
type ViewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'hwpx' | 'other';
function viewKindOf(name: string): ViewKind {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', '3gp'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus', 'weba', 'oga'].includes(ext)) return 'audio';
  if (ext === 'hwpx') return 'hwpx';
  if (
    ['txt', 'md', 'csv', 'log', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'c', 'cpp', 'h', 'java', 'sql', 'yml', 'yaml', 'xml', 'html', 'css', 'sh', 'ini', 'conf', 'toml'].includes(ext)
  )
    return 'text';
  return 'other';
}

/** 텍스트 파일 미리보기 — 200KB까지만 (거대 로그로 브라우저가 죽지 않게) */
function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (alive) setText(t.length > 200_000 ? t.slice(0, 200_000) + '\n\n… (미리보기는 여기까지 — 전체는 저장해서 확인)' : t);
      })
      .catch(() => {
        if (alive) setText('불러오지 못했어요');
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return text === null ? (
    <div className="cf-viewer-loading">불러오는 중…</div>
  ) : (
    <pre className="cf-viewer-text">{text}</pre>
  );
}

/* ── 한글(hwpx) 미리보기 — OWPML zip에서 문단·표를 추출해 읽기 전용 렌더.
 * 제조 현업 격차 대응: 품의서·공문류가 hwp로 도는 환경. 구형 .hwp(바이너리)는 미지원 ── */
type HwpxBlock = { kind: 'p'; text: string } | { kind: 'table'; rows: string[][] };

function hwpxWalkPara(p: Element, blocks: HwpxBlock[]) {
  let buf = '';
  const flush = () => {
    if (buf.trim()) blocks.push({ kind: 'p', text: buf });
    buf = '';
  };
  for (const run of [...p.children]) {
    for (const child of [...run.children]) {
      if (child.localName === 't') {
        buf += child.textContent ?? '';
      } else if (child.localName === 'tbl') {
        flush();
        const rows: string[][] = [];
        for (const tr of [...child.getElementsByTagNameNS('*', 'tr')]) {
          const row: string[] = [];
          for (const tc of [...tr.children].filter((e) => e.localName === 'tc')) {
            row.push(
              [...tc.getElementsByTagNameNS('*', 't')]
                .map((t) => t.textContent ?? '')
                .join(' ')
                .trim(),
            );
          }
          if (row.length > 0) rows.push(row);
        }
        if (rows.length > 0) blocks.push({ kind: 'table', rows });
      }
    }
    // 문단 직속 텍스트(런 없이 오는 변형)도 수용
    if (run.localName === 't') buf += run.textContent ?? '';
  }
  flush();
}

function HwpxPreview({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | 'error' | HwpxBlock[]>('loading');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(buf);
        const sections = Object.keys(zip.files)
          .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .slice(0, 20);
        if (sections.length === 0) throw new Error('no sections');
        const blocks: HwpxBlock[] = [];
        const parser = new DOMParser();
        for (const name of sections) {
          const xml = parser.parseFromString(await zip.files[name].async('text'), 'application/xml');
          for (const p of [...xml.documentElement.children].filter((el) => el.localName === 'p')) {
            hwpxWalkPara(p, blocks);
            if (blocks.length > 3000) break;
          }
          if (blocks.length > 3000) break;
        }
        if (!alive) return;
        setState(blocks);
      } catch {
        if (alive) setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);
  if (state === 'loading') return <div className="cf-viewer-loading">불러오는 중…</div>;
  if (state === 'error' || state.length === 0)
    return (
      <div className="cf-viewer-loading">
        내용을 추출하지 못했어요 — 구형 .hwp이거나 지원하지 않는 구조예요. 다운로드로 확인해주세요.
      </div>
    );
  return (
    <div className="cf-hwpx">
      {state.map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>{b.text}</p>
        ) : (
          <table key={i}>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ),
      )}
    </div>
  );
}

/** 실행 취소 스택 항목 — 역연산 클로저 (삭제는 복구 불가라 스택에 안 쌓음) */
interface UndoOp {
  label: string;
  undo: () => Promise<void>;
}

/** 우상단 토스트 — 성공(체크)은 app:info, 실패(느낌표)는 app:error */
function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  window.dispatchEvent(
    new CustomEvent(kind === 'error' ? 'app:error' : 'app:info', { detail: message }),
  );
}

export default function CollabFiles({
  code,
  isHost,
  visible = true,
  groupName,
}: {
  code: string;
  isHost: boolean;
  /** 공동편집 화면이 실제로 보이는지 — 숨김 상태의 열린 에디터가 프레즌스에 잡히지 않게 */
  visible?: boolean;
  /** 파일 체계의 루트 이름 = 그룹 이름 (없으면 "공동편집" 폴백) */
  groupName?: string;
}) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const dn = useDisplayName();
  const rootName = (groupName ?? '').trim() || '공동편집';
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
  const [viewMenu, setViewMenu] = useState(false); // MS 탐색기식 "보기" 드롭다운
  const [moreMenu, setMoreMenu] = useState(false); // ⋯ 더보기 (실행 취소·선택 3종)

  /** 드롭다운은 한 번에 하나 — 다른 걸 열면 열려 있던 건 닫는다 */
  function closeMenus() {
    setSortMenu(false);
    setViewMenu(false);
    setFilterMenu(false);
    setMoreMenu(false);
    setTypeMenuFor(null);
  }
  const [filterMenu, setFilterMenu] = useState(false); // 필터 드롭다운 (탐색기식)
  const [typeFilter, setTypeFilter] = useState<FileType | null>(null); // null = 전체
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
  const [trashSel, setTrashSel] = useState(false); // 루트의 휴지통 항목이 단일 선택된 상태
  // 문서 열람 서명 (회람 사인) — 선택 파일의 서명 현황 + SignPad 대상
  const [ackStatus, setAckStatus] = useState<FileAckStatus | null>(null);
  const [ackSignFor, setAckSignFor] = useState<number | null>(null);
  // 최근 항목 — 그룹에서 최근 열람·편집된 문서 (사이드바·홈 탭)
  const [recent, setRecent] = useState<
    { id: number; name: string; type: FileType; last_ts?: string }[]
  >([]);
  // 홈 탭 — 즐겨찾기 + 최근 방문 (탐색기 홈, 휴지통과 같은 "장소" 패턴)
  const [homeOpen, setHomeOpen] = useState(false);
  // 주소줄 직접 입력 — 윈도우 탐색기식 (빈 영역 클릭 → 경로 타이핑해서 이동)
  const [pathEditing, setPathEditing] = useState(false);
  const [pathText, setPathText] = useState('');
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  // 내용 검색 — 문서 안 텍스트 일치 (드라이브식, 디바운스)
  const [contentHits, setContentHits] = useState<
    { id: number; name: string; type: FileType; snippet: string }[]
  >([]);
  // 업로드 파일 버전 기록
  const [fileVersions, setFileVersions] = useState<
    { id: number; size: number | null; created_at: string; username: string | null }[] | null
  >(null);
  const versionInputRef = useRef<HTMLInputElement | null>(null);
  // DM으로 파일 보내기 — 대상 파일 + 멤버 목록
  const [dmPickFor, setDmPickFor] = useState<CollabFile | null>(null);
  const [dmMembers, setDmMembers] = useState<
    { id: number; username: string; avatar: string | null }[] | null
  >(null);
  // 이동 다이얼로그 — 우클릭 "이동…" 대상 id들
  const [movePicker, setMovePicker] = useState<number[] | null>(null);
  // 왼쪽 사이드바 (즐겨찾기·최근·폴더·휴지통) — 기본 켜짐
  const [treeOn, setTreeOn] = useState<boolean>(
    () => localStorage.getItem('exist:cf-tree') !== '0',
  );
  // 사이드바 트리 펼침 상태 (윈도우 탐색기식 계층) — 셰브론으로 접고 펴기
  const [sideRootOpen, setSideRootOpen] = useState(true); // 루트(그룹명) 펼침
  const [sideOpenIds, setSideOpenIds] = useState<Set<number>>(new Set());
  function toggleSideOpen(id: number) {
    setSideOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  // 다중 드래그 고스트 — 네이티브 프리뷰 대신 포인터를 따라다니는 카드 스택 + 개수 배지
  const [dragGhost, setDragGhost] = useState<{
    count: number;
    types: FileType[];
    x: number;
    y: number;
  } | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const dragEmptyImg = useRef<HTMLImageElement | null>(null);
  if (!dragEmptyImg.current && typeof Image !== 'undefined') {
    const img = new Image();
    img.src =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    dragEmptyImg.current = img;
  }
  // 세부 정보 창 토글 — 탐색기처럼 켜고 끌 수 있게, 선택 없으면 현재 폴더 정보
  const [detailsOn, setDetailsOn] = useState<boolean>(
    () => localStorage.getItem('exist:cf-details') !== '0',
  );
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
  // 러버밴드(드래그 박스 선택) + 드래그 이동 — s0: 시작 시점 scrollTop (스크롤 중 기준점 보정)
  const [rubber, setRubber] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    s0: number;
  } | null>(null);
  const rubberMoved = useRef(false);
  // 타이핑 점프 — 목록에서 이름 첫 글자 입력으로 커서 이동 (윈도우식)
  const typeJumpBuf = useRef('');
  const typeJumpAt = useRef(0);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const rubberScrollVel = useRef(0);
  const rubberScrollRaf = useRef<number | null>(null);
  const entryRefs = useRef(new Map<number, HTMLElement>());
  const dragIdsRef = useRef<number[]>([]);
  const [dropTarget, setDropTarget] = useState<number | 'root' | 'trash' | null>(null);
  const renameTimerRef = useRef<number | null>(null); // 선택된 항목 이름 재클릭 → 지연 후 인라인 편집

  useEffect(
    () => () => {
      if (rubberScrollRaf.current != null) cancelAnimationFrame(rubberScrollRaf.current);
    },
    [],
  );

  // 회의록·일정에서 "다룬 문서" 클릭 → 해당 파일 열기 (목록 로드 전이면 대기 후 소비)
  const pendingOpenRef = useRef<number | null>(null);
  useEffect(() => {
    function onOpenNow(e: Event) {
      const d = (e as CustomEvent).detail as { code?: string; fileId?: number } | undefined;
      if (d?.code !== code || !d.fileId) return;
      pendingOpenRef.current = d.fileId;
      const f = files.find((x) => x.id === d.fileId);
      if (f && f.type !== 'folder') {
        pendingOpenRef.current = null;
        setTrashOpen(false);
        openFile(f);
      }
    }
    window.addEventListener('exist:open-file-now', onOpenNow);
    return () => window.removeEventListener('exist:open-file-now', onOpenNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, files]);
  useEffect(() => {
    if (pendingOpenRef.current == null) return;
    const f = files.find((x) => x.id === pendingOpenRef.current);
    if (f && f.type !== 'folder') {
      pendingOpenRef.current = null;
      setTrashOpen(false);
      openFile(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // 드래그 고스트가 포인터를 따라다니게 — dragover 좌표로 직접 이동 (리렌더 없이)
  useEffect(() => {
    if (!dragGhost) return;
    const onOver = (e: DragEvent) => {
      const el = dragGhostRef.current;
      if (el) {
        el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 16}px)`;
        el.classList.toggle('copy', e.ctrlKey); // Ctrl = 복사 배지
      }
    };
    document.addEventListener('dragover', onOver);
    return () => document.removeEventListener('dragover', onOver);
  }, [dragGhost]);

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
  // 휴지통 항목 수 — 루트의 휴지통 아이콘 배지용으로 처음부터 로드
  useEffect(() => {
    void loadTrash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  // 최근 항목 — 파일 목록이 갱신될 때마다 재조회 (활동이 있었을 확률이 높은 시점)
  useEffect(() => {
    void api<{ id: number; name: string; type: FileType; last_ts?: string }[]>(
      `/api/meetings/${code}/files/recent/list`,
      { silent: true },
    )
      .then(setRecent)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, files]);

  // 파일별 편집 중인 사람 (awareness) — 서버가 입장/퇴장 시 소켓으로 알려주면 즉시 재조회, 폴링은 폴백
  const [presence, setPresence] = useState<Record<number, { username: string; avatar: string | null }[]>>({});
  useEffect(() => {
    let alive = true;
    const tick = () => {
      void api<Record<number, { username: string; avatar: string | null }[]>>(
        `/api/meetings/${code}/files/presence`,
      )
        .then((d) => alive && setPresence(d))
        .catch(() => {});
    };
    tick();
    // 15초 폴링 제거 — files:presence 푸시가 전 케이스(입장·퇴장·소켓 끊김)를 커버한다.
    // 재연결 시에만 스냅샷 재조회 (끊긴 사이 놓친 변동 보정)
    const socket = getSocket();
    const onPresence = (p: { code?: string }) => {
      if (p?.code === code) tick();
    };
    socket.on('files:presence', onPresence);
    socket.on('connect', tick);
    // 파일 목록 변경 푸시 — 남이 만들고 올리고 지운 것이 즉시 보인다 (기존엔 갱신 경로 없음)
    const onFilesChanged = (p: { code?: string }) => {
      if (p?.code !== code.toUpperCase()) return;
      load();
      void loadTrash(); // 삭제·복원도 변경에 포함 — 휴지통 개수 배지 동기화
    };
    socket.on('files:changed', onFilesChanged);
    return () => {
      alive = false;
      socket.off('files:presence', onPresence);
      socket.off('connect', tick);
      socket.off('files:changed', onFilesChanged);
    };
  }, [code]);

  /** 파일 옆 겹친 아바타 스택 (최대 4 + n) */
  function PresenceStack({ fileId }: { fileId: number }) {
    const people = presence[fileId];
    if (!people?.length) return null;
    const shown = people.slice(0, 4);
    return (
      <span className="cf-presence">
        {shown.map((p) => (
          <Avatar key={p.username} value={p.avatar} className="cf-presence-avatar" />
        ))}
        {people.length > 4 && <span className="cf-presence-more">+{people.length - 4}</span>}
        {/* hover 시 전체 접속자 프로필 리스트 (할 일 담당자 팝업과 동일 톤) — 이름 우선 표기 */}
        <span className="hub-assign-tip cf-presence-tip" aria-hidden>
          {people.map((p) => (
            <span key={p.username} className="hub-assign-tip-row">
              <Avatar value={p.avatar} className="hub-assign-avatar" />
              <span>{dn(p.username)}</span>
            </span>
          ))}
        </span>
      </span>
    );
  }

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
    // 업로드 파일(type='file')은 room이 없어도 인플레이스 미리보기로 연다
    .filter((f): f is CollabFile => !!f && f.type !== 'folder' && (!!f.room || f.type === 'file'));

  const canEdit = (f: CollabFile) => isHost || f.author === user?.username;

  function pushUndo(op: UndoOp) {
    undoStack.current.push(op);
    if (undoStack.current.length > 20) undoStack.current.shift();
    forceUndo((n) => n + 1);
  }

  // ── 선택 ──
  function clearSel() {
    setSelectedIds(new Set());
    setTrashSel(false);
    anchorRef.current = null;
  }

  function selectOnly(id: number) {
    setSelectedIds(new Set([id]));
    setTrashSel(false);
    anchorRef.current = id;
  }

  /** 클릭 선택 — 윈도우식 (Ctrl 토글, Shift 범위, 그냥 클릭은 단일) */
  function clickSelect(f: CollabFile, e: React.MouseEvent) {
    setTrashSel(false); // 파일 선택이 시작되면 휴지통 선택은 해제 (세부정보 패널 중복 방지)
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

  // ── 내비게이션 ── (휴지통·홈은 "장소" — 어디로든 이동하면 빠져나온다)
  function navigate(to: number | null) {
    setTrashOpen(false);
    setHomeOpen(false);
    if (to === cwd) return;
    backStack.current.push(cwd);
    fwdStack.current = [];
    setCwd(to);
    clearSel();
    setSearch('');
    forceNav((n) => n + 1);
  }

  function goBack() {
    if (trashOpen || homeOpen) {
      setTrashOpen(false);
      setHomeOpen(false);
      return;
    }
    if (backStack.current.length === 0) return;
    fwdStack.current.push(cwd);
    setCwd(backStack.current.pop()!);
    clearSel();
    forceNav((n) => n + 1);
  }

  function goForward() {
    if (fwdStack.current.length === 0) return;
    setTrashOpen(false);
    setHomeOpen(false);
    backStack.current.push(cwd);
    setCwd(fwdStack.current.pop()!);
    clearSel();
    forceNav((n) => n + 1);
  }

  function goUp() {
    if (trashOpen || homeOpen) {
      setTrashOpen(false);
      setHomeOpen(false);
      return;
    }
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

  // ── 주소줄 직접 입력 ── (윈도우 탐색기식 — 빈 영역 클릭 → 텍스트로 경로 이동)
  /** 편집 모드 진입 — 현재 경로를 텍스트로 채운다 (선택 등 다른 상태는 건드리지 않음) */
  function startPathEdit() {
    const text = trashOpen
      ? `${rootName}/휴지통`
      : homeOpen
        ? `${rootName}/홈`
        : [rootName, ...crumbs.map((c) => c.name)].join('/');
    setPathText(text);
    setPathEditing(true);
  }

  /** Enter — 입력 경로를 루트부터 폴더 이름으로 해석해 이동. 못 찾으면 토스트 + 편집 유지 */
  function submitPathEdit() {
    // 구분자 `/`·`>`·`\` 모두 허용, 빈 세그먼트는 무시
    const segs = pathText
      .split(/[/>\\]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    // 선두 루트 이름(그룹명)·구칭 "공동편집"은 있어도 없어도 됨
    if (segs[0] === rootName || segs[0] === '공동편집') segs.shift();
    // 마지막 세그먼트가 "휴지통"·"홈"이면 해당 장소로 (휴지통·홈은 폴더가 아닌 "장소")
    const last = segs[segs.length - 1];
    if (last === '휴지통') {
      clearSel();
      void loadTrash();
      setTrashOpen(true);
      setHomeOpen(false);
      setPathEditing(false);
      return;
    }
    if (last === '홈') {
      clearSel();
      setTrashOpen(false);
      setHomeOpen(true);
      setPathEditing(false);
      return;
    }
    // 루트부터 순차 매칭 — 정확 일치 우선, 없으면 대소문자 무시
    let cur: number | null = null;
    for (const seg of segs) {
      const kids: CollabFile[] = (byParent.get(cur) ?? []).filter((x) => x.type === 'folder');
      const hit =
        kids.find((x) => x.name === seg) ??
        kids.find((x) => x.name.toLowerCase() === seg.toLowerCase());
      if (!hit) {
        toast(`"${seg}" 폴더를 찾을 수 없어요`, 'error');
        return; // 편집 모드 유지 — 고쳐서 다시 시도할 수 있게
      }
      cur = hit.id;
    }
    setPathEditing(false);
    navigate(cur); // 빈 입력·"공동편집"만이면 루트로
  }

  // 편집 모드 진입 시 포커스 + 전체 선택 (탐색기 주소줄 관례)
  useEffect(() => {
    if (pathEditing) {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    }
  }, [pathEditing]);

  // 현재 폴더로 이동하면 사이드바 트리에서 조상 경로를 자동으로 펼친다
  useEffect(() => {
    if (cwd == null) return;
    setSideOpenIds((prev) => {
      const next = new Set(prev);
      next.add(cwd);
      let cur = byId.get(cwd)?.parent_id ?? null;
      while (cur != null) {
        next.add(cur);
        cur = byId.get(cur)?.parent_id ?? null;
      }
      return next;
    });
  }, [cwd, byId]);

  // 폴더 트리 (이동 다이얼로그·데스크탑 사이드바 공용) — DFS 평탄화
  const folderTree = useMemo(() => {
    const out: { f: CollabFile; depth: number }[] = [];
    const walk = (pid: number | null, depth: number) => {
      const kids = (byParent.get(pid) ?? []).filter((x) => x.type === 'folder').sort(byNameNat);
      for (const f of kids) {
        out.push({ f, depth });
        if (depth < 6) walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [byParent]);

  /** 이동 금지 대상 — 옮기는 폴더 자신과 그 하위 (자기 안으로 이동 방지) */
  function moveExcluded(ids: number[]): Set<number> {
    const ex = new Set<number>();
    const addSub = (id: number) => {
      ex.add(id);
      for (const c of byParent.get(id) ?? []) if (c.type === 'folder') addSub(c.id);
    };
    for (const id of ids) {
      const f = byId.get(id);
      if (f?.type === 'folder') addSub(id);
    }
    return ex;
  }

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
      name: byNameNat,
      type: (a, b) => a.type.localeCompare(b.type) || byNameNat(a, b),
      author: (a, b) => a.author.localeCompare(b.author, 'ko') || byNameNat(a, b),
      date: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || byNameNat(a, b),
      size: (a, b) => (a.size ?? -1) - (b.size ?? -1) || byNameNat(a, b),
    };
    // 필터 — 종류 하나만 (폴더는 항상 표시해 탐색은 유지)
    if (typeFilter) list = list.filter((f) => f.type === typeFilter || f.type === 'folder');
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      // 폴더 먼저 (윈도우식)
      if ((a.type === 'folder') !== (b.type === 'folder')) return a.type === 'folder' ? -1 : 1;
      return cmp[sortKey](a, b) * dir;
    });
  }, [files, byParent, cwd, search, sortKey, sortDir, typeFilter]);

  /** 단일 선택일 때만 상세 패널 대상 */
  const selected = selectedIds.size === 1 ? (byId.get([...selectedIds][0]) ?? null) : null;
  const selList = useMemo(
    () => [...selectedIds].map((id) => byId.get(id)).filter((f): f is CollabFile => !!f),
    [selectedIds, byId],
  );

  // 선택 파일의 열람 서명 현황 로드
  useEffect(() => {
    if (selected && selected.type !== 'folder' && selected.ack_required) {
      void loadAcks(selected.id);
    } else {
      setAckStatus(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.ack_required]);

  // 내용 검색 — 400ms 디바운스로 서버 질의 (2자 이상)
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2 || trashOpen) {
      setContentHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api<{ id: number; name: string; type: FileType; snippet: string }[]>(
        `/api/meetings/${code}/files/search/content?q=${encodeURIComponent(q)}`,
        { silent: true },
      )
        .then(setContentHits)
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, code, trashOpen]);

  // 선택된 업로드 파일의 버전 기록
  useEffect(() => {
    setFileVersions(null);
    if (!selected || selected.type !== 'file') return;
    void api<{ id: number; size: number | null; created_at: string; username: string | null }[]>(
      `/api/meetings/${code}/files/${selected.id}/versions`,
      { silent: true },
    )
      .then(setFileVersions)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  // DM 보내기 모달 — 열릴 때 멤버 목록 로드
  useEffect(() => {
    if (!dmPickFor) {
      setDmMembers(null);
      return;
    }
    void api<{ id: number; username: string; avatar: string | null }[]>(
      `/api/meetings/${code}/files/members/list`,
    )
      .then(setDmMembers)
      .catch(() => setDmMembers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmPickFor?.id]);

  async function uploadNewVersion(f: CollabFile, file: File) {
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast(`파일은 ${MAX_UPLOAD_MB}MB까지 지원해요`, 'error');
      return;
    }
    try {
      await fetch(`/api/meetings/${code}/files/${f.id}/upload-version`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      toast(`"${f.name}" 새 버전을 올렸어요 — 이전 버전은 보관됨`);
      load();
      const rows = await api<
        { id: number; size: number | null; created_at: string; username: string | null }[]
      >(`/api/meetings/${code}/files/${f.id}/versions`, { silent: true });
      setFileVersions(rows);
    } catch {
      /* 전역 토스트 */
    }
  }

  async function sendFileDm(userId: number) {
    if (!dmPickFor) return;
    try {
      await api(`/api/meetings/${code}/files/${dmPickFor.id}/dm`, {
        method: 'POST',
        body: { userId },
      });
      toast('DM으로 보냈어요');
      setDmPickFor(null);
    } catch {
      /* 전역 토스트 */
    }
  }

  // 선택 파일을 다룬 회의들 — 문서 → 회의 역링크
  const [fileMeetings, setFileMeetings] = useState<
    { recapId: number; summary: string; ts: number }[] | null
  >(null);
  useEffect(() => {
    setFileMeetings(null);
    if (!selected || selected.type === 'folder') return;
    let alive = true;
    void api<{ recapId: number; summary: string; ts: number }[]>(
      `/api/meetings/${code}/files/${selected.id}/meetings`,
    )
      .then((rows) => alive && setFileMeetings(rows))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

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

  // ── 업로드 파일 (type='file') ──
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadParentRef = useRef<number | null>(null);
  // 업로드 진행률 — fetch는 진행 이벤트가 없어 XHR 사용. 파일명·퍼센트·n/m을 토스트로
  const [uploadProg, setUploadProg] = useState<{ name: string; pct: number; idx: number; total: number } | null>(null);

  function uploadOne(file: File, parentId: number | null, onProgress: (pct: number) => void) {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const q = new URLSearchParams({ name: file.name });
      if (parentId != null) q.set('parent_id', String(parentId));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/meetings/${code}/files/upload?${q}`);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
        let error: string | undefined;
        try {
          error = (JSON.parse(xhr.responseText) as { error?: string })?.error;
        } catch {
          /* 본문 없음 */
        }
        resolve({ ok: false, error });
      };
      xhr.onerror = () =>
        resolve({ ok: false, error: `"${file.name}"은 지원되지 않거나 전송이 끊긴 파일이에요` });
      xhr.send(file);
    });
  }

  const MAX_UPLOAD_MB = 25; // 서버 제한과 동일 — 초과분은 보내기 전에 걸러 경고

  // 업로드 큐 — 진행 중에 또 올리면 줄 뒤에 붙는다 (동시 호출이 진행 상태를 덮어쓰던 버그 방지)
  const uploadQueueRef = useRef<{ file: File; parentId: number | null }[]>([]);
  const uploadBusyRef = useRef(false);
  const uploadDoneRef = useRef(0);

  async function pumpUploads() {
    if (uploadBusyRef.current) return;
    uploadBusyRef.current = true;
    try {
      while (uploadQueueRef.current.length) {
        const { file, parentId } = uploadQueueRef.current.shift()!;
        uploadDoneRef.current++;
        const idx = uploadDoneRef.current;
        const prog = (pct: number) =>
          setUploadProg({
            name: file.name,
            pct,
            idx,
            total: idx + uploadQueueRef.current.length,
          });
        prog(0);
        const r = await uploadOne(file, parentId, prog);
        if (!r.ok) toast(r.error ?? `${file.name} 업로드 실패`, 'error');
        load(); // 파일별 갱신 — 끝난 것부터 목록에 바로 보이게
      }
    } finally {
      uploadBusyRef.current = false;
      uploadDoneRef.current = 0;
      setUploadProg(null);
    }
  }

  function uploadFiles(list: FileList | File[], parentId: number | null) {
    const arr = [...list];
    if (!arr.length) return;
    for (const file of arr) {
      // 올릴 수 없는 파일은 보내기 전에 경고 — 25MB 초과(서버 413과 동일 기준)·빈 파일
      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        toast(`"${file.name}"은 올릴 수 없어요 — 파일은 ${MAX_UPLOAD_MB}MB까지 지원해요`, 'error');
        continue;
      }
      if (file.size === 0) {
        toast(`"${file.name}"은 빈 파일이라 올릴 수 없어요`, 'error');
        continue;
      }
      uploadQueueRef.current.push({ file, parentId });
    }
    void pumpUploads();
  }

  /** 폴더째 드래그 업로드 — 구조를 유지하며 폴더 생성 + 파일 큐 적재 (윈도우·드라이브식).
   * entries는 drop 핸들러 안에서 동기로 캡처해 넘겨야 함 (핸들러 밖에선 무효) */
  async function uploadEntries(list: (FileSystemEntry | null)[], parentId: number | null) {
    const entries = list.filter((e): e is FileSystemEntry => !!e);
    const readAll = (dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> =>
      new Promise((resolve) => {
        const reader = dir.createReader();
        const acc: FileSystemEntry[] = [];
        const step = () =>
          reader.readEntries((batch) => {
            if (batch.length === 0) return resolve(acc);
            acc.push(...batch);
            step();
          }, () => resolve(acc));
        step();
      });
    const walk = async (entry: FileSystemEntry, pid: number | null): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File | null>((resolve) =>
          (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
        );
        if (file) uploadFiles([file], pid);
      } else if (entry.isDirectory) {
        try {
          const created = await api<CollabFile>(`/api/meetings/${code}/files`, {
            method: 'POST',
            body: { name: entry.name, type: 'folder', parent_id: pid },
          });
          load();
          for (const child of await readAll(entry as FileSystemDirectoryEntry)) {
            await walk(child, created.id);
          }
        } catch {
          /* 개수 제한 등 — 전역 토스트 */
        }
      }
    };
    for (const e of entries) await walk(e, parentId);
    load();
  }

  // 미리보기 열람 신고 — 소켓 연결에 귀속 (심박 불필요, 소켓이 끊기면 서버가 알아서 정리).
  // 열면 즉시 신고, 재연결되면 재신고, 떠나면 null
  const activeBlobId = active?.type === 'file' ? active.id : null;
  useEffect(() => {
    if (!visible || activeBlobId == null) return;
    const socket = getSocket();
    const report = () => socket.emit('file:viewing', { code, fileId: activeBlobId });
    report();
    // 와이파이 순단 등으로 소켓이 갈아끼워지면 새 소켓엔 내 시청 상태가 없다 — 재신고
    socket.on('connect', report);
    return () => {
      socket.off('connect', report);
      socket.emit('file:viewing', { code, fileId: null });
    };
  }, [activeBlobId, visible, code]);

  /** 볼 수 없는 형식의 업로드 파일 — 다운로드로 폴백 */
  function openBlobFile(f: CollabFile) {
    const url = `/api/meetings/${code}/files/${f.id}/download?token=${encodeURIComponent(token ?? '')}`;
    const win = window.open(url, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      a.click();
    }
  }

  // ── 파일 열기 ──
  function openFile(f: CollabFile) {
    if (f.type === 'file' && viewKindOf(f.name) === 'other') {
      // 볼 수 없는 형식만 다운로드 — 이미지·PDF·영상·음성·텍스트는 에디터처럼 안쪽에서 연다
      openBlobFile(f);
      return;
    }
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
    void loadTrash(); // 휴지통 배지 갱신
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
  /** Ctrl+드래그 복사 — 대상 폴더에 사본 생성 (이름 충돌은 서버가 "이름 (2)"로) */
  async function copyMany(ids: number[], target: number | null) {
    const copied: { id: number; name: string }[] = [];
    for (const id of ids) {
      const src = byId.get(id);
      if (!src) continue;
      try {
        const r = await api<{ id: number }>(`/api/meetings/${code}/files/${id}/copy`, {
          method: 'POST',
          body: { parent_id: target },
        });
        copied.push({ id: r.id, name: src.name });
      } catch {
        /* 전역 토스트 */
      }
    }
    if (copied.length > 0) {
      pushUndo({
        label: copied.length === 1 ? `"${copied[0].name}" 복사` : `${copied.length}개 복사`,
        undo: async () => {
          for (const c of copied) await api(`/api/meetings/${code}/files/${c.id}`, { method: 'DELETE' });
          load();
        },
      });
      toast(copied.length === 1 ? `"${copied[0].name}" 복사했어요` : `${copied.length}개 복사했어요`);
    }
    load();
  }

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

  // ── 문서 열람 서명 (회람 사인) ──
  async function loadAcks(fileId: number) {
    try {
      setAckStatus(await api<FileAckStatus>(`/api/meetings/${code}/files/${fileId}/acks`));
    } catch {
      /* 전역 토스트 */
    }
  }

  async function requestAck(f: CollabFile, on: boolean) {
    try {
      await api(`/api/meetings/${code}/files/${f.id}/ack-request`, {
        method: 'POST',
        body: { on },
      });
      load();
      void loadAcks(f.id);
      toast(on ? '열람 서명을 요청했어요 — 그룹원에게 알림이 가요' : '열람 서명 요청을 해제했어요');
    } catch {
      /* 전역 토스트 */
    }
  }

  async function signAck(fileId: number, signature: string) {
    try {
      await api(`/api/meetings/${code}/files/${fileId}/ack`, {
        method: 'POST',
        body: { signature },
      });
      setAckSignFor(null);
      load();
      void loadAcks(fileId);
      toast('열람 확인 서명 완료');
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
      toast('실행 취소에 실패했어요 (이미 바뀌었을 수 있어요)', 'error');
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
      setTrashSel(false);
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
    // 타이핑 점프 — 이름이 입력 문자로 시작하는 항목으로 (한글은 IME 특성상 완성 입력만 잡힘)
    if (e.key.length === 1 && !ctrl && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      if (now - typeJumpAt.current > 1000) typeJumpBuf.current = '';
      typeJumpAt.current = now;
      typeJumpBuf.current += e.key.toLowerCase();
      const hit = items.find((f) => f.name.toLowerCase().startsWith(typeJumpBuf.current));
      if (hit) {
        selectOnly(hit.id);
        entryRefs.current.get(hit.id)?.scrollIntoView({ block: 'nearest' });
      }
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
    if (!sortMenu && !viewMenu && !moreMenu && !filterMenu && typeMenuFor === null) return;
    function onDown(e: PointerEvent) {
      if (!(e.target as HTMLElement).closest('.cf-type-menu, .cf-tool-wrap, .cf-actions')) {
        setSortMenu(false);
        setViewMenu(false);
        setMoreMenu(false);
        setFilterMenu(false);
        setTypeMenuFor(null);
      }
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [sortMenu, viewMenu, moreMenu, filterMenu, typeMenuFor]);

  function share(f: CollabFile) {
    const link = `${location.origin}/meeting/${code}`;
    void navigator.clipboard
      .writeText(`[exist] ${f.name} — ${link}`)
      .then(() => toast('그룹 링크를 복사했어요'))
      .catch(() => toast('클립보드 복사에 실패했어요', 'error'));
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
              <PresenceStack fileId={f.id} />
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
                      <RenameIcon size={12} />
                    </button>
                    <button title="삭제" className="danger" onClick={() => void deleteSelection([f])}>
                      <CloseIcon size={12} />
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
          <button
            title="뒤로"
            disabled={!trashOpen && !homeOpen && backStack.current.length === 0}
            onClick={goBack}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <button title="앞으로" disabled={fwdStack.current.length === 0} onClick={goForward}>
            <ChevronRightIcon size={14} />
          </button>
          <button title="상위 폴더" disabled={!trashOpen && !homeOpen && cwd === null} onClick={goUp}>
            <ChevronUpIcon size={14} />
          </button>
          <button title="새로고침" onClick={load}>
            <RefreshIcon size={13} />
          </button>
          <div
            className="cf-path"
            onClick={(e) => {
              // 빈 영역 클릭 → 경로 직접 입력 모드 (크럼 버튼 클릭은 그대로 통과)
              if ((e.target as HTMLElement).closest('button')) return;
              if (!pathEditing) startPathEdit();
            }}
          >
            {pathEditing && (
              <span className="cf-path-editicon">
                <FolderIcon size={13} />
              </span>
            )}
            {pathEditing && (
              <input
                ref={pathInputRef}
                className="cf-path-input"
                value={pathText}
                onChange={(e) => setPathText(e.target.value)}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => setPathEditing(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitPathEdit();
                  else if (e.key === 'Escape') setPathEditing(false);
                }}
              />
            )}
            {!pathEditing && (<>
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
                if (e.ctrlKey) void copyMany(ids, null);
                else void moveMany(ids, null);
              }}
            >
              <FolderIcon size={13} /> {rootName}
            </button>
            {trashOpen && (
              <span className="cf-crumb-seg">
                <ChevronIcon size={11} />
                <button className="cf-crumb cf-crumb-trash">
                  <TrashIcon size={12} /> 휴지통
                </button>
              </span>
            )}
            {homeOpen && (
              <span className="cf-crumb-seg">
                <ChevronIcon size={11} />
                <button className="cf-crumb cf-crumb-home">
                  <HomeIcon size={12} /> 홈
                </button>
              </span>
            )}
            {!trashOpen && !homeOpen && crumbs.map((c) => (
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
            </>)}
          </div>
          <input
            className="cf-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`${cwd === null ? rootName : (byId.get(cwd)?.name ?? '')} 검색`}
          />
        </div>

        {/* 2줄 — 툴바: 이어진 알약 캡슐 (통화 [채팅|내보내기] 알약과 같은 언어) */}
        <div className="cf-toolbar">
          {/* 만들기·업로드 스플릿 캡슐 — 콘텐츠가 생기는 두 입구를 한 덩어리로 */}
          <div className="cf-newgroup">
            <div className="cf-tool-wrap">
              <button
                className="cf-tool primary"
                disabled={trashOpen || homeOpen}
                onClick={() => {
                  const wasOpen = typeMenuFor !== null;
                  closeMenus();
                  if (!wasOpen) setTypeMenuFor('root');
                }}
              >
                <PlusIcon size={13} /> 새로 만들기
              </button>
              {typeMenuFor === 'root' && <TypeMenu parentId={cwd} />}
            </div>
            <button
              className="cf-tool primary cf-upload"
              title="내 파일 업로드"
              disabled={trashOpen || homeOpen}
              onClick={() => {
                uploadParentRef.current = cwd;
                uploadInputRef.current?.click();
              }}
            >
              <UploadIcon size={14} /> 업로드
            </button>
          </div>
          {/* 구글 드라이브식 툴바 — 라운드 바 하나에 아이콘 버튼 + 얇은 구분선, 라벨은 툴팁 */}
          <div className="cf-gbar">
            <button
              className="cf-tool"
              title="잘라내기"
              aria-label="잘라내기"
              disabled={cantTouch}
              onClick={() => setClipboard({ op: 'cut', ids: editables.map((f) => f.id) })}
            >
              <ScissorsIcon size={15} />
            </button>
            <button
              className="cf-tool"
              title="복사"
              aria-label="복사"
              disabled={disabledSel}
              onClick={() => setClipboard({ op: 'copy', ids: [...selectedIds] })}
            >
              <CopyIcon size={15} />
            </button>
            <button
              className="cf-tool"
              title="붙여넣기"
              aria-label="붙여넣기"
              disabled={!clipboard}
              onClick={() => void paste()}
            >
              <ClipboardIcon size={15} />
            </button>
            <span className="cf-gsep" />
            <button
              className="cf-tool"
              title="이름 바꾸기"
              aria-label="이름 바꾸기"
              disabled={!selected || !canEdit(selected)}
              onClick={() => selected && startRename(selected)}
            >
              <RenameIcon size={15} />
            </button>
            <button
              className="cf-tool"
              title="공유"
              aria-label="공유"
              disabled={!selected}
              onClick={() => selected && share(selected)}
            >
              <ShareIcon size={15} />
            </button>
            <button
              className="cf-tool danger"
              title="삭제"
              aria-label="삭제"
              disabled={cantTouch}
              onClick={() => void deleteSelection()}
            >
              <TrashIcon size={15} />
            </button>
            <span className="cf-gsep" />
            <div className="cf-tool-wrap">
            <button
              className="cf-tool labeled"
              onClick={() => {
                const next = !sortMenu;
                closeMenus();
                setSortMenu(next);
              }}
            >
              <SortIcon size={13} /> 정렬
            </button>
            {sortMenu && (
              <div className="cf-type-menu">
                {(
                  [
                    ['name', '이름'],
                    ['type', '종류'],
                    ['author', '만든 사람'],
                    ['date', '날짜'],
                    ['size', '크기'],
                  ] as [SortKey, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => {
                      setSortKey(k);
                      setSortMenu(false);
                    }}
                  >
                    <span className="cf-menu-check">
                      {sortKey === k && <CheckMarkIcon size={12} />}
                    </span>
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
                  <span className="cf-menu-check">
                    {sortDir === 'asc' && <CheckMarkIcon size={12} />}
                  </span>
                  오름차순
                </button>
                <button
                  onClick={() => {
                    setSortDir('desc');
                    setSortMenu(false);
                  }}
                >
                  <span className="cf-menu-check">
                    {sortDir === 'desc' && <CheckMarkIcon size={12} />}
                  </span>
                  내림차순
                </button>
              </div>
            )}
          </div>
          {/* 보기 — MS 탐색기식 드롭다운 (정렬 옆 짝). 버튼 아이콘 = 현재 뷰 모드 */}
          <div className="cf-tool-wrap">
            <button
              className="cf-tool labeled"
              onClick={() => {
                const next = !viewMenu;
                closeMenus();
                setViewMenu(next);
              }}
            >
              {view === 'grid' ? <GridIcon size={13} /> : <ListViewIcon size={13} />} 보기
            </button>
            {viewMenu && (
              <div className="cf-type-menu">
                {(
                  [
                    ['grid', '아이콘'],
                    ['list', '목록'],
                  ] as [ViewMode, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => {
                      setView(k);
                      localStorage.setItem('exist:cf-view', k);
                      setViewMenu(false);
                    }}
                  >
                    <span className="cf-menu-check">
                      {view === k && <CheckMarkIcon size={12} />}
                    </span>
                    {k === 'grid' ? <GridIcon size={13} /> : <ListViewIcon size={13} />} {label}
                  </button>
                ))}
                {/* 표시 — 패널 켜고 끄기 (Win11 보기 > 표시) */}
                <div className="cf-menu-sep" />
                <button
                  onClick={() => {
                    setTreeOn((v) => {
                      localStorage.setItem('exist:cf-tree', v ? '0' : '1');
                      return !v;
                    });
                    setViewMenu(false);
                  }}
                >
                  <span className="cf-menu-check">
                    {treeOn && <CheckMarkIcon size={12} />}
                  </span>
                  <PanelLeftIcon size={13} /> 탐색 창
                </button>
              </div>
            )}
          </div>
          {/* 필터 — 종류로 좁혀 보기 (탐색기식) */}
          <div className="cf-tool-wrap">
            <button
              className={`cf-tool labeled${typeFilter ? ' on' : ''}`}
              onClick={() => {
                const next = !filterMenu;
                closeMenus();
                setFilterMenu(next);
              }}
            >
              <FilterIcon size={13} /> 필터
            </button>
            {filterMenu && (
              <div className="cf-type-menu cf-more-menu">
                <button
                  onClick={() => {
                    setTypeFilter(null);
                    setFilterMenu(false);
                  }}
                >
                  <span className="cf-menu-check">
                    {typeFilter === null && <CheckMarkIcon size={12} />}
                  </span>
                  전체
                </button>
                <div className="cf-menu-sep" />
                {(['doc', 'code', 'sheet', 'slide', 'canvas', 'file', 'folder'] as FileType[]).map(
                  (t) => (
                    <button
                      key={t}
                      onClick={() => {
                        setTypeFilter(t);
                        setFilterMenu(false);
                      }}
                    >
                      <span className="cf-menu-check">
                        {typeFilter === t && <CheckMarkIcon size={12} />}
                      </span>
                      <TypeIcon type={t} size={13} />{' '}
                      {t === 'folder' ? '폴더' : TYPE_LABEL[t]}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
          <span className="cf-gsep" />
          {/* ⋯ 더보기 — 윈도우 탐색기식 (실행 취소·선택 3종) */}
          <div className="cf-tool-wrap">
            <button
              className="cf-tool"
              title="더 보기"
              aria-label="더 보기"
              onClick={() => {
                const next = !moreMenu;
                closeMenus();
                setMoreMenu(next);
              }}
            >
              ⋯
            </button>
            {moreMenu && (
              <div className="cf-type-menu cf-more-menu">
                <button
                  disabled={undoStack.current.length === 0}
                  onClick={() => {
                    void undo();
                    setMoreMenu(false);
                  }}
                >
                  <UndoIcon size={13} /> 실행 취소
                  {undoStack.current.at(-1) ? ` — ${undoStack.current.at(-1)!.label}` : ''}
                </button>
                <div className="cf-menu-sep" />
                <button
                  disabled={items.length === 0}
                  onClick={() => {
                    setSelectedIds(new Set(items.map((f) => f.id)));
                    setTrashSel(false);
                    setMoreMenu(false);
                  }}
                >
                  <SelectAllIcon size={14} /> 모두 선택
                </button>
                <button
                  disabled={selCount === 0}
                  onClick={() => {
                    clearSel();
                    setMoreMenu(false);
                  }}
                >
                  <SelectNoneIcon size={14} /> 선택 안 함
                </button>
                <button
                  disabled={items.length === 0}
                  onClick={() => {
                    setSelectedIds(new Set(items.filter((f) => !selectedIds.has(f.id)).map((f) => f.id)));
                    setTrashSel(false);
                    setMoreMenu(false);
                  }}
                >
                  <SelectInvertIcon size={14} /> 선택 영역 반전
                </button>
              </div>
            )}
          </div>
          </div>
          <button
            className={`cf-tool cf-details-toggle${detailsOn ? ' on' : ''}`}
            title="세부 정보 창 켜기/끄기"
            onClick={() =>
              setDetailsOn((v) => {
                localStorage.setItem('exist:cf-details', v ? '0' : '1');
                return !v;
              })
            }
          >
            <span className="cf-flip-x">
              <PanelLeftIcon size={14} />
            </span>{' '}
            세부정보
          </button>
        </div>

        {/* 본문 — 현재 폴더 내용 (+ 선택 시 오른쪽 세부 정보) */}
        <div className="cf-body">
        {/* 왼쪽 사이드바 — 홈·즐겨찾기·최근·폴더·휴지통 한 공간 (윈도우 탐색기 탐색 창) */}
        <div
          className={`cf-slidewrap cf-slide-l${treeOn ? ' open' : ''}`}
          aria-hidden={!treeOn}
        >
          <aside className="cf-desktree">
            {/* 루트 = 그룹 이름 — 그 아래 홈·폴더·휴지통이 계층으로 (파일 체계 통일) */}
            <button
              className={`cf-desktree-item side-ic-folder${
                cwd === null && !trashOpen && !homeOpen ? ' cur' : ''
              }${dropTarget === 'root' ? ' droptarget' : ''}`}
              onClick={() => navigate(null)}
              onDragOver={(e) => {
                if (dragIdsRef.current.length === 0) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
                setDropTarget('root');
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                const ids = dragIdsRef.current;
                dragIdsRef.current = [];
                setDropTarget(null);
                if (e.ctrlKey) void copyMany(ids, null);
                else void moveMany(ids, null);
              }}
            >
              <span
                className={`side-chevron${sideRootOpen ? ' open' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSideRootOpen((v) => !v);
                }}
              >
                <ChevronIcon size={10} />
              </span>
              <FolderIcon size={13} /> {rootName}
            </button>
            {sideRootOpen && (
              <button
                className={`cf-desktree-item side-ic-home${homeOpen ? ' cur' : ''}`}
                style={{ paddingLeft: 20 }}
                onClick={() => {
                  clearSel();
                  setTrashOpen(false);
                  setHomeOpen(true);
                }}
              >
                <span className="side-chevron" />
                <HomeIcon size={13} /> 홈
              </button>
            )}
            {sideRootOpen &&
            (function renderSideFolders(pid: number | null, depth: number): React.ReactNode[] {
              return (byParent.get(pid) ?? [])
                .filter((x) => x.type === 'folder')
                .sort(byNameNat)
                .flatMap((f) => {
                  const hasKids = (byParent.get(f.id) ?? []).some((c) => c.type === 'folder');
                  const open = sideOpenIds.has(f.id);
                  return [
                    <button
                      key={f.id}
                      className={`cf-desktree-item side-ic-folder${
                        cwd === f.id && !trashOpen && !homeOpen ? ' cur' : ''
                      }${dropTarget === f.id ? ' droptarget' : ''}`}
                      style={{ paddingLeft: 6 + depth * 14 }}
                      onClick={() => navigate(f.id)}
                      onDragOver={(e) => {
                        if (dragIdsRef.current.length === 0 || dragIdsRef.current.includes(f.id))
                          return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
                        setDropTarget(f.id);
                      }}
                      onDragLeave={() => setDropTarget((t) => (t === f.id ? null : t))}
                      onDrop={(e) => {
                        e.preventDefault();
                        const ids = dragIdsRef.current;
                        dragIdsRef.current = [];
                        setDropTarget(null);
                        if (e.ctrlKey) void copyMany(ids, f.id);
                        else void moveMany(ids, f.id);
                      }}
                    >
                      <span
                        className={`side-chevron${open ? ' open' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (hasKids) toggleSideOpen(f.id);
                        }}
                      >
                        {hasKids && <ChevronIcon size={10} />}
                      </span>
                      <FolderIcon size={13} /> {f.name}
                    </button>,
                    ...(open && hasKids ? renderSideFolders(f.id, depth + 1) : []),
                  ];
                });
            })(null, 1)}
            {sideRootOpen && (
            <button
              className={`cf-desktree-item side-ic-trash${trashOpen ? ' cur' : ''}${
                dropTarget === 'trash' ? ' droptarget danger' : ''
              }`}
              style={{ paddingLeft: 20 }}
              onClick={() => {
                clearSel();
                setHomeOpen(false);
                void loadTrash();
                setTrashOpen(true);
              }}
              onDragOver={(e) => {
                if (dragIdsRef.current.length === 0) return;
                e.preventDefault();
                setDropTarget('trash');
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'trash' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                const ids = dragIdsRef.current;
                dragIdsRef.current = [];
                setDropTarget(null);
                const targets = ids
                  .map((id) => byId.get(id))
                  .filter((f): f is CollabFile => !!f);
                void deleteSelection(targets);
              }}
            >
              <span className="side-chevron" />
              <TrashIcon size={13} /> 휴지통{trashItems.length > 0 ? ` (${trashItems.length})` : ''}
            </button>
            )}
          </aside>
        </div>
        {/* 홈 — 상단 즐겨찾기, 하단 최근 방문 (탐색기 홈) */}
        {homeOpen && (
          <div className="cf-main cf-homeview">
            <div className="cf-home-sec">
              <div className="cf-home-label">
                <StarIcon size={13} /> 즐겨찾기
              </div>
              {favFiles.length === 0 ? (
                <div className="cf-empty">
                  파일을 선택하고 세부정보의 ★을 누르면 여기에 고정돼요
                </div>
              ) : (
                <div className="cf-home-grid">
                  {favFiles.map((f) => (
                    <button
                      key={f.id}
                      className="cf-home-tile"
                      title={f.name}
                      onClick={() => (f.type === 'folder' ? navigate(f.id) : openFile(f))}
                    >
                      {f.type === 'file' && viewKindOf(f.name) === 'image' ? (
                        <span className="cf-thumbwrap">
                          <img
                            className="cf-thumb"
                            loading="lazy"
                            src={`/api/meetings/${code}/files/${f.id}/download?token=${encodeURIComponent(token ?? '')}`}
                            alt=""
                          />
                        </span>
                      ) : (
                        <span className={`cf-icon ${f.type}`}>
                          <TypeIcon type={f.type} size={28} />
                        </span>
                      )}
                      <span className="cf-home-name">{f.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* 작업 중 — 지금 누군가 열어 두고 있는 파일 (실시간 프레즌스) */}
            <div className="cf-home-sec">
              <div className="cf-home-label">
                <UsersIcon size={13} /> 작업 중
              </div>
              {(() => {
                const working = Object.entries(presence)
                  .filter(([, ppl]) => ppl.length > 0)
                  .map(([id, ppl]) => ({ f: byId.get(Number(id)), ppl }))
                  .filter(
                    (w): w is { f: CollabFile; ppl: { username: string; avatar: string | null }[] } =>
                      !!w.f,
                  );
                if (working.length === 0)
                  return (
                    <div className="cf-empty">지금 열려 있는 문서가 없어요</div>
                  );
                return (
                  <div className="cf-home-list">
                    {working.map(({ f, ppl }) => (
                      <button
                        key={f.id}
                        className="cf-home-row"
                        onClick={() => openFile(f)}
                      >
                        <span className={`cf-icon ${f.type}`}>
                          <TypeIcon type={f.type} size={15} />
                        </span>
                        <span className="cf-home-row-name">{f.name}</span>
                        <PresenceStack fileId={f.id} />
                        <span className="cf-home-row-meta">{ppl.length}명 작업 중</span>
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="cf-home-sec">
              <div className="cf-home-label">
                <ClockIcon size={13} /> 최근 방문
              </div>
              {recent.length === 0 ? (
                <div className="cf-empty">아직 활동이 없어요 — 문서를 열면 여기에 쌓여요</div>
              ) : (
                <div className="cf-home-list">
                  {recent.map((rf) => {
                    const f = byId.get(rf.id);
                    return (
                      <button
                        key={rf.id}
                        className="cf-home-row"
                        onClick={() => {
                          if (f) openFile(f);
                        }}
                      >
                        <span className={`cf-icon ${rf.type}`}>
                          <TypeIcon type={rf.type} size={15} />
                        </span>
                        <span className="cf-home-row-name">{rf.name}</span>
                        <span className="cf-home-row-meta">
                          {rf.type === 'folder' ? '폴더' : TYPE_LABEL[rf.type as Exclude<FileType, 'folder'>]}
                        </span>
                        <span className="cf-home-row-meta">
                          {rf.last_ts ? fmtDate(rf.last_ts) : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {/* 휴지통 뷰 — 팝오버가 아니라 본문 전체를 쓰는 "장소" (8/2) */}
        {trashOpen && (
          <div className="cf-main list cf-trashmain">
            {trashItems.length === 0 ? (
              <div className="cf-empty">휴지통이 비어 있어요</div>
            ) : (
              <>
                <div className="cf-listhead cf-trashhead-row">
                  <span className="cf-trashhead-name">이름</span>
                  <span className="cf-trashhead-meta">지운 사람</span>
                  <span className="cf-trashhead-meta">지운 날짜</span>
                  <span className="cf-trashhead-actions" />
                </div>
                {trashItems.map((t) => (
                  <div key={t.id} className="cf-trash-row">
                    <span className={`cf-icon ${t.type}`}>
                      <TypeIcon type={t.type} size={15} />
                    </span>
                    <span className="cf-trash-name" title={t.name}>
                      {t.name}
                      {t.children > 0 ? ` (+${t.children})` : ''}
                    </span>
                    <span className="cf-trash-meta">{dn(t.author)}</span>
                    <span className="cf-trash-meta">
                      {new Date(t.deleted_at + 'Z').toLocaleString('ko-KR', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="cf-trash-actions">
                      <button className="cf-trash-restore" onClick={() => void restoreTrash(t.id)}>
                        복원
                      </button>
                      <button className="danger" onClick={() => void purgeTrash(t.id)}>
                        영구 삭제
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        <div
          ref={mainRef}
          style={{ display: trashOpen || homeOpen ? 'none' : undefined }}
          className={`cf-main ${view}`}
          onClick={() => {
            if (rubberMoved.current) {
              rubberMoved.current = false;
              return;
            }
            clearSel();
          }}
          onDragOver={(e) => {
            // OS에서 끌어온 파일 — 현재 폴더에 업로드
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            if (e.dataTransfer.files.length > 0 && dragIdsRef.current.length === 0) {
              e.preventDefault();
              // entry는 핸들러 안에서 동기 캡처 (밖에선 무효) — 폴더가 섞이면 구조 유지 업로드
              const entries = [...e.dataTransfer.items].map(
                (it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null),
              );
              if (entries.some((en) => en?.isDirectory)) void uploadEntries(entries, cwd);
              else void uploadFiles(e.dataTransfer.files, cwd);
            }
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
            setRubber({
              x0: e.clientX,
              y0: e.clientY,
              x1: e.clientX,
              y1: e.clientY,
              s0: e.currentTarget.scrollTop,
            });
          }}
          onPointerMove={(e) => {
            if (!rubber) return;
            const nr = { ...rubber, x1: e.clientX, y1: e.clientY };
            setRubber(nr);
            if (Math.abs(nr.x1 - nr.x0) + Math.abs(nr.y1 - nr.y0) > 8) rubberMoved.current = true;
            if (!rubberMoved.current) return;
            const host = mainRef.current;
            // 가장자리를 넘겨 드래그하면 페이지가 아니라 목록 자신을 자동 스크롤
            if (host) {
              const b = host.getBoundingClientRect();
              let dy = 0;
              if (e.clientY > b.bottom - 10) dy = e.clientY - (b.bottom - 10);
              else if (e.clientY < b.top + 10) dy = e.clientY - (b.top + 10);
              rubberScrollVel.current = dy;
              if (dy !== 0 && rubberScrollRaf.current == null) {
                const step = () => {
                  const m = mainRef.current;
                  if (rubberScrollVel.current === 0 || !m) {
                    rubberScrollRaf.current = null;
                    return;
                  }
                  m.scrollTop += rubberScrollVel.current * 0.2;
                  rubberScrollRaf.current = requestAnimationFrame(step);
                };
                rubberScrollRaf.current = requestAnimationFrame(step);
              }
            }
            setTrashSel(false); // 러버밴드 선택 시작 — 휴지통 선택 해제
            const y0e = host ? nr.y0 - (host.scrollTop - nr.s0) : nr.y0;
            const [lx, hx] = nr.x0 < nr.x1 ? [nr.x0, nr.x1] : [nr.x1, nr.x0];
            const [ly, hy] = y0e < nr.y1 ? [y0e, nr.y1] : [nr.y1, y0e];
            const hit = new Set<number>();
            for (const f of items) {
              const el = entryRefs.current.get(f.id);
              if (!el) continue;
              const r2 = el.getBoundingClientRect();
              if (r2.right > lx && r2.left < hx && r2.bottom > ly && r2.top < hy) hit.add(f.id);
            }
            setSelectedIds(hit);
          }}
          onPointerUp={() => {
            setRubber(null);
            rubberScrollVel.current = 0;
          }}
        >
          {rubber &&
            rubberMoved.current &&
            (() => {
              // 사각형을 작업창(cf-main) 경계 안으로 클램프 — 툴바·바깥 화면을 덮지 않게
              const host = mainRef.current;
              const b = host?.getBoundingClientRect();
              const y0e = host ? rubber.y0 - (host.scrollTop - rubber.s0) : rubber.y0;
              let left = Math.min(rubber.x0, rubber.x1);
              let top = Math.min(y0e, rubber.y1);
              let right = Math.max(rubber.x0, rubber.x1);
              let bottom = Math.max(y0e, rubber.y1);
              if (b) {
                left = Math.max(left, b.left);
                top = Math.max(top, b.top);
                right = Math.min(right, b.right);
                bottom = Math.min(bottom, b.bottom);
              }
              if (right <= left || bottom <= top) return null;
              return (
                <div
                  className="cf-rubber"
                  style={{ left, top, width: right - left, height: bottom - top }}
                />
              );
            })()}
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
              <button
                className="cf-listhead-date"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('date');
                }}
              >
                날짜{hdrInd('date')}
              </button>
              <button
                className="cf-listhead-size"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('size');
                }}
              >
                크기{hdrInd('size')}
              </button>
              {/* 접속 중 — 지금 이 파일을 편집·열람 중인 사람 (정렬 없음) */}
              <span className="cf-listhead-online">접속 중</span>
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
          {/* 휴지통 — 루트에 파일처럼 놓인 항목 (윈도우 바탕화면식). 더블클릭 열기, 끌어다 놓으면 삭제 */}
          {cwd === null && !search.trim() && (
            <div
              className={`cf-entry cf-entry-trash${trashSel ? ' selected' : ''}${
                dropTarget === 'trash' ? ' droptarget' : ''
              }`}
              onDragOver={(e) => {
                if (dragIdsRef.current.length === 0) return;
                e.preventDefault();
                setDropTarget('trash');
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'trash' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                const ids = dragIdsRef.current;
                dragIdsRef.current = [];
                setDropTarget(null);
                const targets = ids
                  .map((id) => byId.get(id))
                  .filter((f): f is CollabFile => !!f);
                void deleteSelection(targets);
              }}
              onClick={(e) => {
                e.stopPropagation();
                clearSel();
                setTrashSel(true);
              }}
              onDoubleClick={() => {
                clearSel();
                setHomeOpen(false);
                void loadTrash();
                setTrashOpen(true);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              title={`휴지통 · 항목 ${trashItems.length}개`}
            >
              <span className="cf-entry-icon cf-icon cf-icon-trash">
                <TrashIcon size={view === 'grid' ? 28 : 16} />
              </span>
              <span className="cf-entry-name">휴지통</span>
              {view === 'list' && (
                <>
                  <span className="cf-entry-type">시스템</span>
                  <span className="cf-entry-author">항목 {trashItems.length}개</span>
                  <span className="cf-entry-online">
                    <span className="cf-online-none">—</span>
                  </span>
                </>
              )}
            </div>
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
                  e.dataTransfer.effectAllowed = 'copyMove'; // Ctrl 누르고 놓으면 복사
                  e.dataTransfer.setData('text/plain', '');
                  // 여러 개 들었으면 네이티브 프리뷰 대신 커스텀 고스트 (개수 배지 + 애니메이션)
                  if (ids.length > 1 && dragEmptyImg.current) {
                    e.dataTransfer.setDragImage(dragEmptyImg.current, 0, 0);
                    setDragGhost({
                      count: ids.length,
                      types: ids.slice(0, 3).map((id) => byId.get(id)?.type ?? 'doc'),
                      x: e.clientX,
                      y: e.clientY,
                    });
                  }
                }}
                onDragEnd={() => {
                  dragIdsRef.current = [];
                  setDropTarget(null);
                  setDragGhost(null);
                }}
                onDragOver={(e) => {
                  if (
                    f.type !== 'folder' ||
                    dragIdsRef.current.length === 0 ||
                    dragIdsRef.current.includes(f.id)
                  )
                    return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
                  setDropTarget(f.id);
                }}
                onDragLeave={() => setDropTarget((t) => (t === f.id ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  if (f.type !== 'folder') return;
                  const ids = dragIdsRef.current;
                  dragIdsRef.current = [];
                  setDropTarget(null);
                  if (e.ctrlKey) void copyMany(ids, f.id);
                  else void moveMany(ids, f.id);
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
                title={`${f.name} · ${f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]} · ${dn(f.author)}`}
              >
                {f.type === 'file' && viewKindOf(f.name) === 'image' ? (
                  /* 이미지 썸네일 — 현장 사진을 아이콘이 아니라 실물로 (지연 로드) */
                  <span className={`cf-entry-icon cf-thumbwrap${view === 'list' ? ' sm' : ''}`}>
                    <img
                      className="cf-thumb"
                      loading="lazy"
                      draggable={false}
                      src={`/api/meetings/${code}/files/${f.id}/download?token=${encodeURIComponent(token ?? '')}`}
                      alt=""
                    />
                  </span>
                ) : (
                  <span className={`cf-entry-icon cf-icon ${f.type}`}>
                    <TypeIcon type={f.type} size={view === 'grid' ? 30 : 16} />
                  </span>
                )}
                {/* 열람 서명 배지 — 빨강: 내 서명 필요 / 초록: 서명 완료 */}
                {!!f.ack_required && (
                  <span
                    className={`cf-ackdot${f.my_ack ? ' done' : ''}`}
                    title={f.my_ack ? '열람 서명 완료' : '열람 서명 필요'}
                  />
                )}
                {/* 목록 뷰에선 접속 중 컬럼이 담당 — 아이콘 옆 스택은 그리드 전용 */}
                {view !== 'list' && <PresenceStack fileId={f.id} />}
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
                    <span className="cf-entry-author">{dn(f.author)}</span>
                    <span className="cf-entry-date">{fmtDate(f.created_at)}</span>
                    <span className="cf-entry-size">
                      {f.type === 'file' ? fmtSize(f.size) : '—'}
                    </span>
                    <span className="cf-entry-online">
                      {(presence[f.id]?.length ?? 0) > 0 ? (
                        <>
                          <PresenceStack fileId={f.id} />
                          <span className="cf-online-names">
                            {presence[f.id].map((p) => dn(p.username)).join(', ')}
                          </span>
                        </>
                      ) : (
                        <span className="cf-online-none">—</span>
                      )}
                    </span>
                  </>
                )}
              </div>
              );
            })
          )}
          {/* 내용 일치 — 문서 안 텍스트에서 찾은 것 (이름 일치 목록과 별도 섹션) */}
          {search.trim().length >= 2 &&
            (() => {
              const shown = new Set(items.map((f) => f.id));
              const extra = contentHits.filter((h) => !shown.has(h.id));
              if (extra.length === 0) return null;
              return (
                <div className="cf-contenthits">
                  <div className="cf-contenthits-label">문서 내용 일치</div>
                  {extra.map((h) => (
                    <button
                      key={h.id}
                      className="cf-contenthit"
                      onClick={(e) => {
                        e.stopPropagation();
                        const f = byId.get(h.id);
                        if (f) openFile(f);
                      }}
                    >
                      <span className={`cf-icon ${h.type}`}>
                        <TypeIcon type={h.type} size={14} />
                      </span>
                      <b>{h.name}</b>
                      <span className="cf-contenthit-snip">…{h.snippet}…</span>
                    </button>
                  ))}
                </div>
              );
            })()}
        </div>

        {/* 세부 정보 패널 — 단일 선택은 상세, 다중 선택은 요약, 선택 없으면 현재 폴더 (탐색기식) */}
        {/* 우선순위: 파일 선택 > 휴지통 선택 — 어떤 상태 조합에서도 패널은 하나만 */}
        <div
          className={`cf-slidewrap cf-slide-r${detailsOn && !homeOpen ? ' open' : ''}`}
          aria-hidden={!detailsOn || homeOpen}
        >
        {(trashOpen || (trashSel && selCount === 0)) && (
          <aside className="cf-details">
            <div className="cf-details-icon cf-icon file">
              <TrashIcon size={38} />
            </div>
            <div className="cf-details-name">휴지통</div>
            <div className="cf-details-sub">지워진 항목 보관함</div>
            <div className="cf-details-rows">
              <div className="cf-details-row">
                <span>항목</span>
                <b>{trashItems.length}개</b>
              </div>
            </div>
            {!trashOpen && (
              <button
                className="cf-details-open"
                onClick={() => {
                  clearSel();
                  setHomeOpen(false);
                  void loadTrash();
                  setTrashOpen(true);
                }}
              >
                휴지통 열기
              </button>
            )}
          </aside>
        )}
        {!trashOpen && !homeOpen && !trashSel && selCount === 0 && (
          <aside className="cf-details">
            <div className="cf-details-icon cf-icon folder">
              <TypeIcon type="folder" size={42} />
            </div>
            <div className="cf-details-name">
              {crumbs.length > 0 ? crumbs[crumbs.length - 1].name : rootName}
            </div>
            <div className="cf-details-sub">현재 폴더</div>
            <div className="cf-details-rows">
              <div className="cf-details-row">
                <span>위치</span>
                <b>{[rootName, ...crumbs.map((c) => c.name)].join(' › ')}</b>
              </div>
              <div className="cf-details-row">
                <span>포함 항목</span>
                <b>{items.length}개</b>
              </div>
              {items.length > 0 && (
                <div className="cf-details-row">
                  <span>구성</span>
                  <b>
                    폴더 {items.filter((f) => f.type === 'folder').length}개 · 파일{' '}
                    {items.filter((f) => f.type !== 'folder').length}개
                  </b>
                </div>
              )}
            </div>
          </aside>
        )}
        {!trashOpen && selCount > 1 && (
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
        {!trashOpen && selected && (
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
                <StarIcon size={14} />
              </button>
            </div>
            <div className="cf-details-sub">
              {selected.type === 'folder' ? '폴더' : `${TYPE_LABEL[selected.type]} 파일`}
            </div>
            <div className="cf-details-rows">
              <div className="cf-details-row">
                <span>위치</span>
                <b>
                  {[rootName, ...crumbs.map((c) => c.name)].join(' › ')}
                </b>
              </div>
              <div className="cf-details-row">
                <span>만든 사람</span>
                <b>{dn(selected.author) || '—'}</b>
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
            {/* 이 문서를 다룬 회의 — 클릭하면 기록 탭 해당 회의로 (문서 → 회의 다리) */}
            {(fileMeetings?.length ?? 0) > 0 && (
              <div className="cf-filemeets">
                <div className="cf-ack-head">🗓 다룬 회의</div>
                {fileMeetings!.map((m) => (
                  <button
                    key={m.recapId}
                    className="cf-filemeet-row"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('exist:goto-recap', {
                          detail: { code, recapId: m.recapId },
                        }),
                      )
                    }
                  >
                    <span className="cf-filemeet-date">
                      {new Date(m.ts).toLocaleDateString('ko-KR', {
                        month: 'numeric',
                        day: 'numeric',
                      })}
                    </span>
                    <span className="cf-filemeet-sum">{m.summary}</span>
                  </button>
                ))}
              </div>
            )}
            {/* 업로드 파일 버전 기록 — 새 버전 업로드 + 이전 버전 다운로드 */}
            {selected.type === 'file' && (
              <div className="cf-versions">
                <div className="cf-ack-head">🕘 버전 기록</div>
                {(fileVersions?.length ?? 0) > 0 &&
                  fileVersions!.map((v) => (
                    <a
                      key={v.id}
                      className="cf-version-row"
                      href={`/api/meetings/${code}/files/${selected.id}/versions/${v.id}/download?token=${encodeURIComponent(token ?? '')}`}
                    >
                      {fmtDate(v.created_at)} · {fmtSize(v.size)}
                      {v.username ? ` · ${dn(v.username)}` : ''}
                    </a>
                  ))}
                {(fileVersions?.length ?? 0) === 0 && (
                  <div className="cf-version-none">이전 버전 없음</div>
                )}
                <button className="cf-ack-req" onClick={() => versionInputRef.current?.click()}>
                  새 버전 업로드
                </button>
              </div>
            )}
            {/* DM으로 콕 집어 보내기 */}
            <button className="cf-ack-req" onClick={() => setDmPickFor(selected)}>
              ✉ DM으로 보내기
            </button>
            {/* 열람 서명 (회람 사인) — 요청·현황·서명 */}
            {selected.type !== 'folder' && (
              <div className="cf-ack">
                {selected.ack_required ? (
                  <>
                    <div className="cf-ack-head">
                      ✍ 열람 서명{' '}
                      <b>
                        {ackStatus ? `${ackStatus.acks.length}/${ackStatus.total}` : (selected.ack_count ?? 0)}
                      </b>
                    </div>
                    {ackStatus && ackStatus.acks.length > 0 && (
                      <div className="cf-ack-chips">
                        {ackStatus.acks.map((a) =>
                          a.signature ? (
                            <span key={a.username} className="cf-ack-chip">
                              <img src={a.signature} alt={`${dn(a.username)} 서명`} />
                              <i>{dn(a.username)}</i>
                            </span>
                          ) : (
                            <span key={a.username} className="cf-ack-chip plain">
                              <i>{dn(a.username)}</i>
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {selected.my_ack ? (
                      <div className="cf-ack-done">✓ 내 서명 완료</div>
                    ) : (
                      <button
                        className="cf-details-open"
                        onClick={() => {
                          openFile(selected);
                          setAckSignFor(null);
                        }}
                      >
                        읽고 서명하기
                      </button>
                    )}
                    {canEdit(selected) && (
                      <button className="cf-ack-off" onClick={() => void requestAck(selected, false)}>
                        서명 요청 해제
                      </button>
                    )}
                  </>
                ) : (
                  canEdit(selected) && (
                    <button
                      className="cf-ack-req"
                      title="그룹원 전원이 이 문서를 읽고 손서명으로 확인하게 해요 — 회람 사인의 디지털판"
                      onClick={() => void requestAck(selected, true)}
                    >
                      ✍ 열람 서명 요청
                    </button>
                  )
                )}
              </div>
            )}
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
        </div>

        {/* 하단 상태바 — 윈도우식 */}
        {/* 이동 다이얼로그 — 드라이브식 폴더 픽커 */}
        {movePicker && (
          <div className="cf-move-overlay" onClick={() => setMovePicker(null)}>
            <div className="cf-move-modal" onClick={(e) => e.stopPropagation()}>
              <div className="cf-move-title">
                {movePicker.length === 1
                  ? `"${byId.get(movePicker[0])?.name ?? ''}" 이동`
                  : `${movePicker.length}개 항목 이동`}
              </div>
              <div className="cf-move-tree">
                <button
                  onClick={() => {
                    void moveMany(movePicker, null);
                    setMovePicker(null);
                  }}
                >
                  <FolderIcon size={14} /> {rootName} (루트)
                </button>
                {(() => {
                  const ex = moveExcluded(movePicker);
                  return folderTree.map(({ f, depth }) => (
                    <button
                      key={f.id}
                      style={{ paddingLeft: 14 + depth * 18 }}
                      disabled={ex.has(f.id)}
                      onClick={() => {
                        void moveMany(movePicker, f.id);
                        setMovePicker(null);
                      }}
                    >
                      <FolderIcon size={14} /> {f.name}
                    </button>
                  ));
                })()}
                {folderTree.length === 0 && (
                  <div className="cf-move-empty">폴더가 없어요 — 루트로만 이동할 수 있어요</div>
                )}
              </div>
              <button className="cf-move-cancel" onClick={() => setMovePicker(null)}>
                취소
              </button>
            </div>
          </div>
        )}

        {/* 다중 드래그 고스트 — 포인터 옆 카드 스택 + 개수 배지 */}
        {dragGhost && (
          <div
            className="cf-dragghost"
            ref={dragGhostRef}
            style={{ transform: `translate(${dragGhost.x + 14}px, ${dragGhost.y + 16}px)` }}
          >
            <div className="cf-dragghost-inner">
              <div className="cf-dragghost-stack">
                {dragGhost.types.map((tp, i) => (
                  <span
                    key={i}
                    className={`cf-dragghost-card cf-icon ${tp}`}
                    style={{ '--i': i } as React.CSSProperties}
                  >
                    <TypeIcon type={tp} size={17} />
                  </span>
                ))}
              </div>
              <span className="cf-dragghost-count">{dragGhost.count}</span>
              <span className="cf-dragghost-plus">＋복사</span>
            </div>
          </div>
        )}

        <div className="cf-statusbar">
          {homeOpen ? (
            <>
              홈 — 즐겨찾기 {favFiles.length}개 · 작업 중{' '}
              {Object.values(presence).filter((p) => p.length > 0).length}개 · 최근 {recent.length}개
            </>
          ) : trashOpen ? (
            <>휴지통 항목 {trashItems.length}개</>
          ) : (
            <>
              항목 {items.length}개
              {selCount > 0 && ` · ${selCount}개 선택`}
              {search.trim() !== '' && ' · 검색 결과'}
            </>
          )}
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
                  disabled={!ctxEditable}
                  onClick={() => {
                    setMovePicker(
                      ctxIds.filter((id) => {
                        const x = byId.get(id);
                        return x && canEdit(x);
                      }),
                    );
                    setCtxMenu(null);
                  }}
                >
                  이동…
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
                    setDmPickFor(ctxTarget);
                    setCtxMenu(null);
                  }}
                >
                  DM으로 보내기
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
                    setTrashSel(false);
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

      {/* 내 파일 업로드 입력 (TypeMenu·드롭 공용) */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void uploadFiles(e.target.files, uploadParentRef.current);
          e.target.value = '';
        }}
      />
      {/* 새 버전 업로드 입력 — 세부정보 패널의 버전 기록에서 사용 */}
      <input
        ref={versionInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          const target = selected;
          if (file && target && target.type === 'file') void uploadNewVersion(target, file);
          e.target.value = '';
        }}
      />
      {/* DM으로 파일 보내기 — 멤버 픽커 */}
      {dmPickFor && (
        <div className="cf-move-overlay" onClick={() => setDmPickFor(null)}>
          <div className="cf-move-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cf-move-title">"{dmPickFor.name}" DM으로 보내기</div>
            <div className="cf-move-tree">
              {dmMembers === null && <div className="cf-move-empty">불러오는 중…</div>}
              {dmMembers?.length === 0 && (
                <div className="cf-move-empty">보낼 사람이 없어요 — 그룹에 다른 멤버가 없어요</div>
              )}
              {dmMembers?.map((m) => (
                <button key={m.id} onClick={() => void sendFileDm(m.id)}>
                  <Avatar value={m.avatar} className="cf-dm-avatar" /> {dn(m.username)}
                </button>
              ))}
            </div>
            <button className="cf-move-cancel" onClick={() => setDmPickFor(null)}>
              취소
            </button>
          </div>
        </div>
      )}
      {/* 업로드 진행률 토스트 — 얼마나 됐는지 보이게 (freeze 체감 방지) */}
      {uploadProg && (
        <div className="cf-upload-toast">
          <div className="cf-upload-toast-head">
            <span className="cf-upload-toast-name" title={uploadProg.name}>
              <UploadIcon size={13} /> {uploadProg.name}
            </span>
            <span className="cf-upload-toast-pct">
              {uploadProg.total > 1 ? `${uploadProg.idx}/${uploadProg.total} · ` : ''}
              {uploadProg.pct}%
            </span>
          </div>
          <div className="cf-upload-bar">
            <span style={{ width: `${uploadProg.pct}%` }} />
          </div>
        </div>
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
              <ChevronLeftIcon size={15} />
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
                return [rootName, ...parts].map((s) => `${s} › `).join('');
              })()}
            </span>
            <span className={`cf-icon ${active.type}`}>
              <TypeIcon type={active.type} />
            </span>
            <Marquee className="cf-editor-name">{active.name}</Marquee>
            <span className="cf-editor-right">
              <PresenceStack fileId={active.id} />
              <button
                className={`cf-fullscreen${editorFull ? ' on' : ''}`}
                title={editorFull ? '창 크기로 (Esc)' : '전체화면'}
                onClick={() => setEditorFull((v) => !v)}
              >
                {editorFull ? '⤡' : '⛶'}
              </button>
            </span>
          </div>
        )}
        {/* 열람 서명 배너 — 서명이 필요한 문서를 열면 읽고 서명하도록 */}
        {active && !!active.ack_required && !active.my_ack && (
          <>
            <div className="cf-ackbar">
              <span>✍ 이 문서는 열람 확인이 필요해요 — 다 읽었으면 서명해 주세요</span>
              <button onClick={() => setAckSignFor((v) => (v === active.id ? null : active.id))}>
                서명하기
              </button>
            </div>
            {ackSignFor === active.id && (
              <div className="cf-ackbar-pad">
                <SignPad
                  title="열람 확인 서명 — 마우스나 손가락으로 이름을 적어주세요"
                  onConfirm={(dataUrl) => void signAck(active.id, dataUrl)}
                  onCancel={() => setAckSignFor(null)}
                />
              </div>
            )}
          </>
        )}
        {active && !!active.ack_required && !!active.my_ack && (
          <div className="cf-ackbar done">
            <span>✓ 열람 확인 서명 완료</span>
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
                active={visible && f.id === activeId}
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
            {f.type === 'doc' && (
              <DocEditor roomId={f.room!} code={code} fileId={f.id} fileName={f.name} active={visible && f.id === activeId} />
            )}
            {f.type === 'sheet' && <SheetEditor roomId={f.room!} active={visible && f.id === activeId} />}
            {f.type === 'slide' && <SlideEditor roomId={f.room!} fileName={f.name} active={visible && f.id === activeId} />}
            {f.type === 'canvas' && <CanvasBoard roomId={f.room!} active={visible && f.id === activeId} />}
            {/* 업로드 파일 — 에디터와 같은 자리에서 미리보기 (이미지·PDF·영상·음성·텍스트) */}
            {f.type === 'file' &&
              (() => {
                const vUrl = `/api/meetings/${code}/files/${f.id}/download?token=${encodeURIComponent(token ?? '')}`;
                const kind = viewKindOf(f.name);
                return (
                  <div className="cf-blobview">
                    {/* PDF는 크롬 내장 뷰어에 다운로드가 있어 저장 바 생략 */}
                    {kind !== 'pdf' && (
                      <div className="cf-blobview-bar">
                        <a className="cf-viewer-dl" href={vUrl} download={f.name}>
                          <DownloadIcon size={13} /> 저장
                        </a>
                      </div>
                    )}
                    <div className={`cf-viewer-body ${kind}`}>
                      {kind === 'image' && <img src={vUrl} alt={f.name} />}
                      {kind === 'pdf' && <iframe title={f.name} src={vUrl} />}
                      {kind === 'video' && <video src={vUrl} controls />}
                      {kind === 'audio' && <audio src={vUrl} controls />}
                      {kind === 'text' && <TextPreview url={vUrl} />}
                      {kind === 'hwpx' && <HwpxPreview url={vUrl} />}
                    </div>
                  </div>
                );
              })()}
          </div>
        ))}
      </div>
    </div>
  );
}
