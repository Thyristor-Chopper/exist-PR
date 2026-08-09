import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../lib/socket';
import { parseHwpx, type HwpxBlock } from '../lib/hwpx';
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
  FolderGlyphIcon,
  type FolderGlyph,
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
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  PanelLeftIcon,
  FilterIcon,
  ClockIcon,
  UsersIcon,
  PinIcon,
  MusicIcon,
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
  updated_at?: string | null; // 수정한 날짜 — 이름변경·이동·편집 저장 시 갱신, 없으면 created_at 폴백
  mime?: string | null;
  size?: number | null;
  /** 열람 서명 (회람 사인) — 요청 여부·서명 수·내 서명 여부·대상 수(그룹 참가자) */
  ack_required?: number;
  ack_count?: number;
  my_ack?: number;
  ack_total?: number;
  /** 개정 번호 — 재회람(개정 발행)마다 +1, 서버가 NULL이면 1로 정규화 */
  rev?: number;
}

interface FileAckStatus {
  required: boolean;
  total: number;
  acks: { username: string; ack_at: string; signature: string | null }[];
  /** 미서명자 — 세부정보 "누가 아직 안 봤나" 명단 */
  pending: { username: string; avatar: string | null }[];
  /** 현재 개정 번호 */
  rev?: number;
  /** 최신 개정의 AI 요약 — "이번 개정에서 바뀐 것" 최대 3줄 (줄바꿈 구분, 없으면 null) */
  note?: string | null;
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

/* 기본 생성 폴더 → 폴더 안 글리프 (Win11 특수 폴더 문법) — 이름을 바꾸면 일반 폴더로 돌아간다 */
const FOLDER_GLYPHS: Record<string, FolderGlyph> = {
  '작업·교대 일지': 'log',
  '설비·정비': 'gear',
  '안전·환경': 'shield',
  '품질·검사': 'check',
  '작업표준·SOP': 'book',
  '도면·설계': 'ruler',
  '회의 자료': 'people',
};
function TypeIcon({ type, size = 15, name }: { type: FileType; size?: number; name?: string }) {
  if (type === 'folder') {
    const g = name ? FOLDER_GLYPHS[name] : undefined;
    return g ? <FolderGlyphIcon size={size} glyph={g} /> : <FolderIcon size={size} />;
  }
  if (type === 'code') return <CodeIcon size={size} />;
  if (type === 'doc') return <DocIcon size={size} />;
  if (type === 'sheet') return <SheetIcon size={size} />;
  if (type === 'canvas') return <WhiteboardIcon size={size} />;
  if (type === 'file') {
    // 업로드 파일 — 이름을 알면 종류별 아이콘 (음악 등)
    if (name && viewKindOf(name) === 'audio') return <MusicIcon size={size} />;
    return <BlobFileIcon size={size} />;
  }
  return <SlideIcon size={size} />;
}

type SortKey = 'name' | 'type' | 'author' | 'date' | 'size' | 'ack';
type ViewMode = 'grid' | 'list';

/** 자연 정렬 — "파일-2"가 "파일-10"보다 앞 (윈도우식) */
function byNameNat(a: CollabFile, b: CollabFile): number {
  return a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });
}

/** 미확인 수 — "확인" 컬럼 정렬 기준. 서명 요청이 없는 파일은 -1로 맨 뒤 */
function ackRemain(f: CollabFile): number {
  return f.ack_required ? Math.max((f.ack_total ?? 0) - (f.ack_count ?? 0), 0) : -1;
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
 * 제조 현업 격차 대응: 품의서·공문류가 hwp로 도는 환경. 구형 .hwp(바이너리)는 미지원 ──
 * 파싱 로직은 lib/hwpx.ts(순수 함수)로 분리 — 섹션 발견(spine→글롭→전수 탐색)·
 * 네임스페이스 변형·인코딩·서식 없는 텍스트 폴백까지 그쪽에서 처리 */

function HwpxPreview({ url }: { url: string }) {
  const [state, setState] = useState<'loading' | 'error' | HwpxBlock[]>('loading');
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const { default: JSZip } = await import('jszip');
        const zip = await JSZip.loadAsync(buf);
        // 파서가 볼 만한 엔트리만 추려 바이트로 넘긴다 (XML + spine(.hpf) + 미리보기 텍스트)
        const files: Record<string, Uint8Array> = {};
        for (const [name, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          if (!/\.(xml|hpf|txt)$/i.test(name)) continue;
          files[name] = await entry.async('uint8array');
        }
        const blocks = parseHwpx(files);
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
  // fromTrash = 휴지통 잘라내기 (윈도우 휴지통 문법 — 폴더에서 붙여넣으면 그 폴더로 복원).
  // 일반 이동(PATCH parent_id) 경로와 절대 섞지 않는다 — paste()에서 먼저 분기.
  const [clipboard, setClipboard] = useState<{
    op: 'cut' | 'copy';
    ids: number[];
    fromTrash?: boolean;
  } | null>(null);
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
  // 세부정보 회람 섹션 — 서명자 명단 접기 (기본 접힘, 미확인자가 주인공)
  const [ackSignedOpen, setAckSignedOpen] = useState(false);
  // 확인 필요 뷰 — 내가 미서명인 회람 문서만 모아 보는 "장소" (홈·휴지통과 같은 문법)
  const [ackOpen, setAckOpen] = useState(false);
  // 모바일 — 트리 상단 "확인 필요 N건" 배너의 목록 펼침 (현장 폰 열람·서명 진입점)
  const [mAckListOpen, setMAckListOpen] = useState(false);
  // 최근 항목 — 그룹에서 최근 열람·편집된 문서 (사이드바·홈 탭)
  const [recent, setRecent] = useState<
    { id: number; name: string; type: FileType; last_ts?: string }[]
  >([]);
  // 홈 하단 탭 — [확인 필요 | 작업 중 | 최근 항목] (Win11 홈 하단 탭 문법)
  const [homeTab, setHomeTab] = useState<'ack' | 'working' | 'recent'>('recent');
  // 홈 섹션 접기 — Win11처럼 헤더 ∨ 토글, 기기별 저장
  const [homeFold, setHomeFold] = useState<{ pins: boolean; list: boolean }>(() => {
    try {
      return {
        pins: false,
        list: false,
        ...(JSON.parse(localStorage.getItem('exist:cf-home-fold') ?? '{}') as object),
      };
    } catch {
      return { pins: false, list: false };
    }
  });
  const toggleHomeFold = (k: 'pins' | 'list') =>
    setHomeFold((prev) => {
      const next = { ...prev, [k]: !prev[k] };
      localStorage.setItem('exist:cf-home-fold', JSON.stringify(next));
      return next;
    });
  // 홈 타일·행 드래그 — 본문 목록과 같은 이동 경로 (사이드바 폴더·휴지통·크럼 드롭).
  // 선택에 포함된 항목을 끌면 선택 전체가 딸려온다 (바탕화면 문법)
  const homeDragStart = (f: CollabFile) => (e: React.DragEvent) => {
    const base = selectedIds.has(f.id) ? [...new Set([...selectedIds, f.id])] : [f.id];
    if (!selectedIds.has(f.id)) setSelectedIds(new Set([f.id]));
    const ids = base.filter((id) => {
      const x = byId.get(id);
      return x && canEdit(x);
    });
    if (ids.length === 0) {
      e.preventDefault();
      toast('만든 사람·호스트·관리자만 이동할 수 있는 항목이에요', 'error');
      return;
    }
    dragIdsRef.current = ids;
    e.dataTransfer.effectAllowed = 'copyMove'; // Ctrl 누르고 놓으면 복사
    e.dataTransfer.setData('text/plain', '');
  };
  const homeDragEnd = () => {
    dragIdsRef.current = [];
    setDropTarget(null);
  };
  // 홈 항목 클릭 = 선택 (Ctrl 다중), 더블클릭 = 열기 — 바탕화면 문법
  const homeSelect = (f: CollabFile) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(f.id)) next.delete(f.id);
        else next.add(f.id);
        return next;
      }
      return new Set([f.id]);
    });
  };
  // 홈 탭 — 즐겨찾기 + 최근 방문 (탐색기 홈, 휴지통과 같은 "장소" 패턴)
  const [homeOpen, setHomeOpen] = useState(false);
  // 홈 하단 알약 탭 — 최근 항목(기본) | 작업 중 (Win11 홈 하단 탭 문법)
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
  // 버전 기록 접기 — 기본 접힘 (세부정보 과밀 방지, 제목의 vN이 요약)
  const [versionsOpen, setVersionsOpen] = useState(false);
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
    folders: number; // 내역 표기 "폴더 N · 파일 M" — 카드 스택(최대 3장)과 실제 개수 혼동 방지
    excluded: number; // 편집 권한 없어 빠진 개수 — 선택 개수와 배지가 다른 이유를 표시
    types: FileType[];
    x: number;
    y: number;
  } | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);
  const explorerRef = useRef<HTMLDivElement | null>(null);
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
    {
      id: number;
      name: string;
      type: FileType;
      deleted_at: string;
      updated_at: string; // 수정한 날짜 (서버가 created_at 폴백 처리)
      author: string;
      children: number;
      size: number | null;
      location: string; // 원래 위치 (빈 문자열 = 루트)
    }[]
  >([]);
  // 휴지통 행 선택 — 툴바 "선택한 항목 복원"용 (클릭 선택, Ctrl 다중)
  const [trashSelIds, setTrashSelIds] = useState<Set<number>>(new Set());
  // 휴지통 우클릭 메뉴 — 윈도우 휴지통처럼 복원/영구 삭제
  const [trashCtx, setTrashCtx] = useState<{ x: number; y: number } | null>(null);
  // 휴지통 헤더 정렬 — 본문 목록과 같은 문법 (기본: 최근 지운 것부터)
  const [trashSort, setTrashSort] = useState<{
    key: 'name' | 'type' | 'author' | 'date' | 'size' | 'loc' | 'mdate';
    dir: 'asc' | 'desc';
  }>({ key: 'date', dir: 'desc' });
  // ── 컬럼 폭 조절 — 헤더 구분선 드래그 (윈도우식). CSS 변수로 헤더·행 동시 적용,
  // localStorage에 전역 저장, 핸들 더블클릭이면 기본폭 복원 ──
  // 폭은 전부 4의 배수 — 컬럼 간격이 4의 배수면 DPR 1.25/1.5/1.75에서 ×DPR가 정수라
  // 구분선들이 항상 같은 굵기로 스냅됨 (아니면 하나 걸러 1px/2px 뒤죽박죽)
  const COL_DEFAULTS: Record<string, number> = {
    name: 400, type: 92, author: 92, date: 112, size: 64, ack: 72, online: 132,
    tname: 260, tloc: 140, tauthor: 112, tdate: 112, tsize: 64, ttype: 92, tmdate: 112,
  };
  const [colW, setColW] = useState<Record<string, number>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('exist:cf-colw') ?? '{}') as Record<string, number>;
      // 예전에 저장된 4의 배수 아닌 폭 정규화
      for (const k of Object.keys(raw)) raw[k] = Math.round(raw[k] / 4) * 4;
      return raw;
    } catch {
      return {};
    }
  });
  const colDrag = useRef<{ k: string; startX: number; startW: number } | null>(null);
  function startColDrag(k: string, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (colDrag.current) return; // 이미 드래그 중 — 중복 시작 방지
    colDrag.current = { k, startX: e.clientX, startW: colW[k] ?? COL_DEFAULTS[k] };
    let lastW = colDrag.current.startW;
    const onMove = (ev: PointerEvent) => {
      const d = colDrag.current;
      // 내 드래그가 아니면(HMR 잔재 등 스테일 리스너) 스스로 해제 — 한 드래그에 여러 컬럼이 딸려오는 사고 방지
      if (!d || d.k !== k) {
        window.removeEventListener('pointermove', onMove);
        return;
      }
      // 4px 스텝 스냅 — 4의 배수 유지해야 구분선 굵기가 균일 (48·480도 4의 배수)
      lastW = Math.round(Math.max(48, Math.min(480, d.startW + (ev.clientX - d.startX))) / 4) * 4;
      // 드래그 중엔 React를 안 거치고 CSS 변수만 직접 갱신 — 매 이동마다
      // 탐색기 전체가 리렌더되면 끊긴다. 상태 커밋은 놓을 때 한 번
      explorerRef.current?.style.setProperty(`--cf-col-${k}`, `${lastW}px`);
    };
    const onUp = () => {
      colDrag.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setColW((prev) => {
        const next = { ...prev, [k]: lastW };
        localStorage.setItem('exist:cf-colw', JSON.stringify(next));
        return next;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }
  /* 구분선 드래그 핸들 — 클릭이 정렬로 새지 않게 전파 차단 */
  const colHandle = (k: string) => (
    <span
      className="cf-colresize"
      title="드래그로 폭 조절 · 더블클릭 기본폭"
      onPointerDown={(e) => startColDrag(k, e)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setColW((prev) => {
          const next = { ...prev };
          delete next[k];
          localStorage.setItem('exist:cf-colw', JSON.stringify(next));
          return next;
        });
      }}
    />
  );
  const colVars = Object.fromEntries(
    Object.entries(colW).map(([k, v]) => [`--cf-col-${k}`, `${v}px`]),
  ) as React.CSSProperties;
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
  // 휴지통 행 드래그 — 일반 이동(moveMany) 경로와 섞이면 안 되므로 별도 ref
  const trashDragIdsRef = useRef<number[]>([]);
  // 휴지통 러버밴드 — 본문(cf-main)과 같은 문법, 호스트·선택 대상만 다름.
  // rubber 상태 자체는 공유 (두 컨테이너는 동시에 상호작용하지 않음 — 휴지통 열리면 본문은 display:none)
  const trashMainRef = useRef<HTMLDivElement | null>(null);
  const trashRubberBase = useRef<Set<number>>(new Set()); // Ctrl 러버밴드 = 시작 시점 선택에 추가
  // 홈 러버밴드 — 바탕화면 문법 (클릭=선택, 더블클릭=열기, 빈 곳 드래그=박스 선택).
  // 선택 상태는 본문(selectedIds)과 공용 — 세부정보 패널·툴바가 홈 선택에도 그대로 반응한다
  const homeMainRef = useRef<HTMLDivElement | null>(null);
  const homeRubberBase = useRef<Set<number>>(new Set());
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
        // Ctrl = 복사 배지 — 휴지통 드래그(복원)엔 복사가 없으니 표시하지 않음
        el.classList.toggle('copy', e.ctrlKey && trashDragIdsRef.current.length === 0);
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
  // 에디터 닫고 목록으로 돌아오면 재조회 — 편집으로 갱신된 수정한 날짜·크기가 바로 보이게
  const prevActiveRef = useRef<number | null>(null);
  useEffect(() => {
    if (prevActiveRef.current != null && activeId == null) load();
    prevActiveRef.current = activeId;
  }, [activeId, load]);
  // 열람 시작 시점의 개정 번호 — 읽는 사이 개정이 발행되면 구본 경고 배너
  const [openedRev, setOpenedRev] = useState<number | null>(null);
  useEffect(() => {
    if (activeId == null) {
      setOpenedRev(null);
      return;
    }
    const f = files.find((x) => x.id === activeId);
    setOpenedRev(f ? (f.rev ?? 1) : null);
    // files는 의도적으로 deps 제외 — 열람 "시작" 시점만 캡처해야 개정 감지가 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);
  // 홈 열 때 스마트 기본 탭 — 서명 남은 게 있으면 확인 필요, 아니면 최근 항목. 떠나면 선택 해제
  useEffect(() => {
    if (homeOpen) setHomeTab(needAckFiles.length > 0 ? 'ack' : 'recent');
    else setSelectedIds(new Set());
    // needAckFiles는 의도적으로 deps 제외 — 열리는 순간만 판단 (서명 중 탭이 튀지 않게)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeOpen]);
  // 서명 모달 — "무엇에 서명하는지" 명시용 개정 요약 (모달 열릴 때만 조회)
  const [signModalNote, setSignModalNote] = useState<string | null>(null);
  useEffect(() => {
    if (ackSignFor == null) {
      setSignModalNote(null);
      return;
    }
    void api<{ note?: string | null }>(`/api/meetings/${code}/files/${ackSignFor}/acks`, {
      silent: true,
    })
      .then((d) => setSignModalNote(d.note ?? null))
      .catch(() => setSignModalNote(null));
  }, [ackSignFor, code]);
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
    setAckOpen(false);
    if (to === cwd) return;
    backStack.current.push(cwd);
    fwdStack.current = [];
    setCwd(to);
    clearSel();
    setSearch('');
    forceNav((n) => n + 1);
  }

  function goBack() {
    if (trashOpen || homeOpen || ackOpen) {
      setTrashOpen(false);
      setHomeOpen(false);
      setAckOpen(false);
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
    setAckOpen(false);
    backStack.current.push(cwd);
    setCwd(fwdStack.current.pop()!);
    clearSel();
    forceNav((n) => n + 1);
  }

  function goUp() {
    if (trashOpen || homeOpen || ackOpen) {
      setTrashOpen(false);
      setHomeOpen(false);
      setAckOpen(false);
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

  /** 부모 폴더 경로 라벨 — 홈 핀·최근 리스트·확인 필요 뷰 공용 (루트 › 폴더 › …) */
  function fileLoc(f: CollabFile): string {
    const segs: string[] = [];
    let p = f.parent_id;
    while (p != null) {
      const parent = byId.get(p);
      if (!parent) break;
      segs.unshift(parent.name);
      p = parent.parent_id;
    }
    return [rootName, ...segs].join(' › ');
  }

  // 확인 필요 — 내가 아직 서명 안 한 회람 문서 (사이드바 배지 + 전용 뷰)
  const needAckFiles = useMemo(
    () => files.filter((f) => f.type !== 'folder' && !!f.ack_required && !f.my_ack),
    [files],
  );

  // ── 주소줄 직접 입력 ── (윈도우 탐색기식 — 빈 영역 클릭 → 텍스트로 경로 이동)
  /** 편집 모드 진입 — 현재 경로를 텍스트로 채운다 (선택 등 다른 상태는 건드리지 않음) */
  function startPathEdit() {
    const text = trashOpen
      ? `${rootName}/휴지통`
      : homeOpen
        ? `${rootName}/홈`
        : ackOpen
          ? `${rootName}/확인 필요`
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
      setAckOpen(false);
      setPathEditing(false);
      return;
    }
    if (last === '홈') {
      clearSel();
      setTrashOpen(false);
      setHomeOpen(true);
      setAckOpen(false);
      setPathEditing(false);
      return;
    }
    if (last === '확인 필요') {
      clearSel();
      setTrashOpen(false);
      setHomeOpen(false);
      setAckOpen(true);
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
      date: (a, b) =>
        (a.updated_at ?? a.created_at ?? '').localeCompare(b.updated_at ?? b.created_at ?? '') ||
        byNameNat(a, b),
      size: (a, b) => (a.size ?? -1) - (b.size ?? -1) || byNameNat(a, b),
      // 확인 — 미확인 많은 순 (오름차순 클릭이 곧 "급한 것부터")
      ack: (a, b) => ackRemain(b) - ackRemain(a) || byNameNat(a, b),
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
    setAckSignedOpen(false); // 선택이 바뀌면 서명자 명단은 다시 접는다
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
    setVersionsOpen(false); // 선택이 바뀌면 다시 접는다 (서명자 명단과 같은 문법)
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
    // 회람 문서는 새 버전 = 자동 개정 발행 — 서명 리셋을 모르고 올리는 사고 방지
    if (
      f.ack_required &&
      !confirm('새 버전을 올리면 개정이 발행되어 전원 서명이 리셋됩니다. 지난 서명은 이력에 보관돼요. 계속할까요?')
    )
      return;
    try {
      await fetch(`/api/meetings/${code}/files/${f.id}/upload-version`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      toast(
        f.ack_required
          ? `"${f.name}" 새 버전을 올렸어요 — 개정 발행, 전원 서명 리셋(이력 보관)`
          : `"${f.name}" 새 버전을 올렸어요 — 이전 버전은 보관됨`,
      );
      load();
      if (f.ack_required) void loadAcks(f.id); // 리셋된 회람 현황 즉시 반영
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
    // 휴지통 잘라내기 → 폴더에서 붙여넣기 = 현재 폴더로 복원 (윈도우 휴지통 문법).
    // 소프트 삭제 항목은 byId에 없으므로 일반 이동 경로로 절대 흘리지 않는다.
    if (clipboard.fromTrash) {
      const ids = clipboard.ids;
      setClipboard(null);
      await restoreManyTo(ids, cwd);
      return;
    }
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
      setTrashSelIds(new Set()); // 목록이 바뀌면 선택 초기화
    } catch {
      /* 전역 토스트 */
    }
  }

  /** 여러 항목 복원 — 실패는 건너뛰고 개수만 보고 (권한 없는 항목 등) */
  function restoreMany(ids: number[]) {
    return restoreManyTo(ids);
  }

  /** target 지정 시 원래 위치 대신 그 폴더로 복원 — 휴지통 행 드래그 → 폴더 드롭 */
  async function restoreManyTo(ids: number[], target?: number | null) {
    let ok = 0;
    let fellBack = 0; // 원래 폴더 소실 → 루트로 떨어진 개수 (윈도우는 경로 재생성, 우리는 알림)
    const restored: number[] = [];
    for (const id of ids) {
      try {
        const r = await api<{ fellBack?: boolean }>(
          `/api/meetings/${code}/files/trash/${id}/restore`,
          target === undefined
            ? { method: 'POST' }
            : { method: 'POST', body: { parentId: target } },
        );
        ok++;
        restored.push(id);
        if (r.fellBack) fellBack++;
      } catch {
        /* 개별 실패 무시 — 아래에서 집계 */
      }
    }
    // 복원된 항목은 더는 휴지통에 없음 — 휴지통 클립보드에서 정리
    setClipboard((c) => {
      if (!c?.fromTrash) return c;
      const left = c.ids.filter((id) => !restored.includes(id));
      return left.length > 0 ? { ...c, ids: left } : null;
    });
    await loadTrash();
    load();
    if (ok > 0) {
      const base =
        ok === ids.length
          ? `${ok}개 항목을 복원했어요`
          : `${ok}개 복원 — 나머지 ${ids.length - ok}개는 복원하지 못했어요`;
      toast(
        fellBack > 0
          ? `${base} · 원래 폴더가 없어 ${fellBack}개는 루트로 복원했어요`
          : base,
      );
    } else {
      toast('복원하지 못했어요', 'error');
    }
  }

  /** 휴지통 비우기 — 권한 있는 항목 전부 영구 삭제 (권한 없는 건 서버가 남김) */
  async function emptyTrash() {
    if (!confirm('휴지통을 비우면 안의 항목이 완전히 사라져요. 계속할까요?')) return;
    try {
      const r = await api<{ purged: number; skipped: number }>(
        `/api/meetings/${code}/files/trash`,
        { method: 'DELETE' },
      );
      setClipboard((c) => (c?.fromTrash ? null : c)); // 비운 뒤엔 휴지통 클립보드 무효
      await loadTrash();
      toast(
        r.skipped > 0
          ? `휴지통 비우기 완료 — 권한이 없는 ${r.skipped}개는 남았어요`
          : '휴지통을 비웠어요',
      );
    } catch {
      /* 전역 토스트 */
    }
  }

  /** 선택 항목 영구 삭제 — 휴지통 모드 gbar 삭제 버튼용 (실패는 건너뛰고 개수만 보고) */
  async function purgeMany(ids: number[]) {
    if (ids.length === 0) return;
    if (!confirm(`${ids.length}개 항목을 영구 삭제할까요? 내용까지 완전히 사라져요.`)) return;
    let ok = 0;
    const purged: number[] = [];
    for (const id of ids) {
      try {
        await api(`/api/meetings/${code}/files/trash/${id}`, { method: 'DELETE' });
        ok++;
        purged.push(id);
      } catch {
        /* 개별 실패 무시 — 아래에서 집계 */
      }
    }
    // 영구 삭제된 항목은 휴지통 클립보드에서 정리
    setClipboard((c) => {
      if (!c?.fromTrash) return c;
      const left = c.ids.filter((id) => !purged.includes(id));
      return left.length > 0 ? { ...c, ids: left } : null;
    });
    await loadTrash();
    if (ok > 0) {
      toast(
        ok === ids.length
          ? `${ok}개 항목을 영구 삭제했어요`
          : `${ok}개 영구 삭제 — 나머지 ${ids.length - ok}개는 삭제하지 못했어요`,
      );
    } else {
      toast('영구 삭제하지 못했어요', 'error');
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

  /** 개정 발행(재회람) — rev +1, 회람 문서면 전원 서명 리셋(지난 서명은 이력 보관) */
  async function reviseNow(f: CollabFile) {
    if (
      !confirm(
        `개정을 발행하면 전원 서명이 리셋됩니다. 지난 서명은 이력에 보관돼요 — "${f.name}" 개정을 발행할까요?`,
      )
    )
      return;
    try {
      const r = await api<{ rev: number }>(`/api/meetings/${code}/files/${f.id}/revise`, {
        method: 'POST',
      });
      toast(`개정 v${r.rev}을 발행했어요${f.ack_required ? ' — 전원 서명이 리셋됐어요' : ''}`);
      load();
      if (f.ack_required) void loadAcks(f.id);
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
      // 낙관 반영 — 배너·트리 뱃지·"확인 필요 N건" 개수가 서버 재조회를 기다리지 않고 즉시 바뀜
      setFiles((prev) =>
        prev.map((x) =>
          x.id === fileId ? { ...x, my_ack: 1, ack_count: (x.ack_count ?? 0) + 1 } : x,
        ),
      );
      load();
      void loadAcks(fileId);
      toast('확인 완료 — 열람 서명이 기록됐어요');
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
  // 첫 진입 시드 — 저장된 고정이 아예 없으면(키 자체 없음) 기본 폴더 7종을 고정으로.
  // 사용자가 해제하면 키가 남아 다시 안 깔린다 (서버 SEED_FOLDERS와 같은 목록)
  useEffect(() => {
    if (files.length === 0) return;
    if (localStorage.getItem(`exist:cf-fav:${code}`) != null) return;
    const SEED = new Set([
      '작업·교대 일지', '설비·정비', '안전·환경', '품질·검사', '작업표준·SOP', '도면·설계', '회의 자료',
    ]);
    const ids = files
      .filter((f) => f.type === 'folder' && f.parent_id === null && SEED.has(f.name))
      .map((f) => f.id);
    localStorage.setItem(`exist:cf-fav:${code}`, JSON.stringify(ids));
    if (ids.length > 0) setFavs(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, code]);

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

  /** 탐색기 키보드 (포커스 종속) — Enter 열기 / 타이핑 점프 / 방향키
   *  잘라내기·복사·삭제 등 단축키는 아래 전역(window) 리스너가 담당 — 중복 발동 방지 */
  function onExplorerKey(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 검색·이름 입력 중엔 무시
    const ctrl = e.ctrlKey || e.metaKey;

    if (e.key === 'Enter') {
      if (selected) openFile(selected);
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

  // 윈도우 탐색기식 전역 단축키 — Ctrl+X·C·V / Delete / F2 / Ctrl+A / Ctrl+Z / Escape
  // 탭이 보일 때만 발동, 입력 요소·에디터(파일 열림) 상태에선 무시 — 에디터의 Ctrl+C/V를 뺏으면 안 됨
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!visible || active) return; // 다른 탭이거나 파일 편집 화면
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.tagName === 'SELECT' ||
          ae.isContentEditable)
      )
        return; // 검색·이름·경로 등 입력 중엔 무시
      const ctrl = e.ctrlKey || e.metaKey;

      if (e.key === 'Escape') {
        // 선택 해제 + 열려 있는 메뉴 닫기 (기본 동작 충돌 없음 — preventDefault 불필요)
        setCtxMenu(null);
        closeMenus();
        clearSel();
        return;
      }
      if (ctrl && (e.key === 'a' || e.key === 'A')) {
        if (trashOpen || homeOpen || ackOpen) return; // 본문 뷰에서만
        e.preventDefault();
        setSelectedIds(new Set(items.map((f) => f.id)));
        setTrashSel(false);
        return;
      }
      if (ctrl && (e.key === 'x' || e.key === 'X')) {
        if (trashOpen) {
          // 휴지통 잘라내기 — 폴더로 나가서 Ctrl+V 하면 그 폴더로 복원 (윈도우 휴지통 문법)
          if (trashSelIds.size === 0) return;
          e.preventDefault();
          setClipboard({ op: 'cut', ids: [...trashSelIds], fromTrash: true });
          return;
        }
        const ids = selList.filter(canEdit).map((f) => f.id); // 편집 가능 선택만
        if (ids.length === 0) return;
        e.preventDefault();
        setClipboard({ op: 'cut', ids });
        return;
      }
      if (ctrl && (e.key === 'c' || e.key === 'C')) {
        if (trashOpen || selectedIds.size === 0) return; // 선택 없으면 브라우저 기본 복사 유지
        e.preventDefault();
        setClipboard({ op: 'copy', ids: [...selectedIds] });
        return;
      }
      if (ctrl && (e.key === 'v' || e.key === 'V')) {
        if (trashOpen || !clipboard) return;
        e.preventDefault();
        void paste();
        return;
      }
      if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        if (undoStack.current.length === 0) return;
        e.preventDefault();
        void undo();
        return;
      }
      if (e.key === 'F2') {
        if (trashOpen || !selected || !canEdit(selected)) return; // 단일 선택 + 편집 가능일 때만
        e.preventDefault();
        startRename(selected);
        return;
      }
      if (e.key === 'Delete') {
        if (trashOpen) {
          // 휴지통 — 선택 항목 영구 삭제 (확인창은 purgeMany 안에)
          if (trashSelIds.size === 0) return;
          e.preventDefault();
          void purgeMany([...trashSelIds]);
        } else {
          const list = selList.filter(canEdit);
          if (list.length === 0) return;
          e.preventDefault();
          void deleteSelection();
        }
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, active, trashOpen, homeOpen, ackOpen, selectedIds, selList, clipboard, items, selected, trashSelIds]);

  // 우클릭 메뉴 — 바깥 클릭·Escape로 닫기
  useEffect(() => {
    if (!ctxMenu && !trashCtx) return;
    function onDown(e: PointerEvent) {
      if (!(e.target as HTMLElement).closest('.cf-ctx')) {
        setCtxMenu(null);
        setTrashCtx(null);
      }
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [ctxMenu, trashCtx]);

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

  // 이름만 쓰므로 휴지통 항목도 그대로 공유 가능 (클라 전용 — 그룹 링크 복사)
  function share(f: { name: string }) {
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
              {/* 회람 뱃지 — 빨강: 내 서명 필요 / 초록: 완료 (그리드 뷰 ackdot 색 문법) */}
              {f.type !== 'folder' && !!f.ack_required && (
                <span
                  className={`cf-ackdot${f.my_ack ? ' done' : ''}`}
                  title={f.my_ack ? '열람 서명 완료' : '내 열람 서명 필요'}
                />
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
    // Win11 탐색기식 정렬 표시 — 현재 정렬 컬럼명 위 중앙에 작은 셰브론
    const hdrMark = (k: SortKey) =>
      sortKey === k ? (
        <span className="cf-listhead-sortmark" aria-hidden="true">
          {sortDir === 'asc' ? <ChevronUpIcon size={9} /> : <ChevronIcon size={9} />}
        </span>
      ) : null;
    // 휴지통 헤더 정렬 — 본문과 같은 문법의 축소판
    const trashHdrClick = (k: 'name' | 'type' | 'author' | 'date' | 'size' | 'loc' | 'mdate') =>
      setTrashSort((s) => (s.key === k ? { key: k, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }));
    const trashHdrMark = (k: 'name' | 'type' | 'author' | 'date' | 'size' | 'loc' | 'mdate') =>
      trashSort.key === k ? (
        <span className="cf-listhead-sortmark" aria-hidden="true">
          {trashSort.dir === 'asc' ? <ChevronUpIcon size={9} /> : <ChevronIcon size={9} />}
        </span>
      ) : null;
    const sortedTrashItems = [...trashItems].sort((a, b) => {
      const v =
        trashSort.key === 'name'
          ? a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' })
          : trashSort.key === 'type'
            ? a.type.localeCompare(b.type)
            : trashSort.key === 'loc'
              ? a.location.localeCompare(b.location, 'ko')
            : trashSort.key === 'author'
              ? dn(a.author).localeCompare(dn(b.author), 'ko')
              : trashSort.key === 'size'
                ? (a.size ?? 0) - (b.size ?? 0)
                : trashSort.key === 'mdate'
                  ? a.updated_at.localeCompare(b.updated_at)
                  : a.deleted_at.localeCompare(b.deleted_at);
      return trashSort.dir === 'asc' ? v : -v;
    });
    // 휴지통 선택 항목 — 세부정보 패널용 (정렬 순서 그대로)
    const trashSelList = sortedTrashItems.filter((t) => trashSelIds.has(t.id));
    // 러버밴드 사각형 — 호스트(작업창) 경계 안으로 클램프, 툴바·바깥 화면을 덮지 않게. 본문·휴지통 공용
    const rubberOverlay = (host: HTMLDivElement | null) => {
      if (!rubber || !rubberMoved.current) return null;
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
    };

    return (
      <div
        ref={explorerRef}
        className="cf-explorer"
        style={{ display: active ? 'none' : undefined, ...colVars }}
        tabIndex={0}
        onKeyDown={onExplorerKey}
      >
        {/* 1줄 — 내비게이션 바 */}
        <div className="cf-nav">
          <button
            title="뒤로"
            disabled={!trashOpen && !homeOpen && !ackOpen && backStack.current.length === 0}
            onClick={goBack}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <button title="앞으로" disabled={fwdStack.current.length === 0} onClick={goForward}>
            <ChevronRightIcon size={14} />
          </button>
          <button title="상위 폴더" disabled={!trashOpen && !homeOpen && !ackOpen && cwd === null} onClick={goUp}>
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
                if (dragIdsRef.current.length === 0 && trashDragIdsRef.current.length === 0)
                  return;
                e.preventDefault();
                setDropTarget('root');
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                // 휴지통 행 드래그 — 루트로 복원 (휴지통 뷰의 크럼엔 루트만 보임)
                if (trashDragIdsRef.current.length > 0) {
                  const tids = trashDragIdsRef.current;
                  trashDragIdsRef.current = [];
                  void restoreManyTo(tids, null);
                  return;
                }
                const ids = dragIdsRef.current;
                dragIdsRef.current = [];
                if (e.ctrlKey) void copyMany(ids, null);
                else void moveMany(ids, null);
              }}
            >
              <FolderIcon size={13} /> {rootName}
            </button>
            {trashOpen && (
              <span className="cf-crumb-seg">
                <ChevronRightIcon size={11} />
                <button className="cf-crumb cf-crumb-trash">
                  <TrashIcon size={12} /> 휴지통
                </button>
              </span>
            )}
            {homeOpen && (
              <span className="cf-crumb-seg">
                <ChevronRightIcon size={11} />
                <button className="cf-crumb cf-crumb-home">
                  <HomeIcon size={12} /> 홈
                </button>
              </span>
            )}
            {ackOpen && (
              <span className="cf-crumb-seg">
                <ChevronRightIcon size={11} />
                <button className="cf-crumb cf-crumb-ack">
                  <CheckMarkIcon size={12} /> 확인 필요
                </button>
              </span>
            )}
            {/* 윈도우처럼 현재 위치 뒤에도 › — 다음 단계로 들어갈 수 있다는 신호 */}
            {!trashOpen && !homeOpen && !ackOpen && crumbs.map((c) => (
              <span key={c.id} className="cf-crumb-seg">
                <ChevronRightIcon size={11} />
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
            {/* 윈도우처럼 현재 위치 뒤에도 › — 홈·휴지통 포함 모든 위치에서 표시 */}
            <span className="cf-crumb-tail" aria-hidden>
              <ChevronRightIcon size={11} />
            </span>
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
                disabled={trashOpen || homeOpen || ackOpen}
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
              disabled={trashOpen || homeOpen || ackOpen}
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
              title={trashOpen ? '잘라내기 — 폴더에서 붙여넣으면 복원돼요' : '잘라내기'}
              aria-label="잘라내기"
              disabled={trashOpen ? trashSelIds.size === 0 : cantTouch}
              onClick={() =>
                trashOpen
                  ? setClipboard({ op: 'cut', ids: [...trashSelIds], fromTrash: true })
                  : setClipboard({ op: 'cut', ids: editables.map((f) => f.id) })
              }
            >
              <ScissorsIcon size={15} />
            </button>
            <button
              className="cf-tool"
              title={trashOpen ? '휴지통에서는 사용할 수 없어요' : '복사'}
              aria-label="복사"
              disabled={trashOpen || disabledSel}
              onClick={() => setClipboard({ op: 'copy', ids: [...selectedIds] })}
            >
              <CopyIcon size={15} />
            </button>
            <button
              className="cf-tool"
              title={
                trashOpen
                  ? '휴지통에서는 사용할 수 없어요'
                  : clipboard?.fromTrash
                    ? '붙여넣기 — 휴지통 항목을 이 폴더로 복원'
                    : '붙여넣기'
              }
              aria-label="붙여넣기"
              disabled={trashOpen || !clipboard}
              onClick={() => void paste()}
            >
              <ClipboardIcon size={15} />
            </button>
            <span className="cf-gsep" />
            <button
              className="cf-tool"
              title={trashOpen ? '휴지통에서는 사용할 수 없어요' : '이름 바꾸기'}
              aria-label="이름 바꾸기"
              disabled={trashOpen || !selected || !canEdit(selected)}
              onClick={() => selected && startRename(selected)}
            >
              <RenameIcon size={15} />
            </button>
            <button
              className="cf-tool"
              title="공유"
              aria-label="공유"
              disabled={trashOpen ? trashSelList.length !== 1 : !selected}
              onClick={() =>
                trashOpen
                  ? trashSelList.length === 1 && share(trashSelList[0])
                  : selected && share(selected)
              }
            >
              <ShareIcon size={15} />
            </button>
            <button
              className="cf-tool danger"
              title={trashOpen ? '영구 삭제' : '삭제'}
              aria-label={trashOpen ? '영구 삭제' : '삭제'}
              disabled={trashOpen ? trashSelIds.size === 0 : cantTouch}
              onClick={() =>
                trashOpen ? void purgeMany([...trashSelIds]) : void deleteSelection()
              }
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
                    ['date', '수정한 날짜'],
                    ['type', '유형'],
                    ['size', '크기'],
                    ['author', '만든 사람'],
                    ['ack', '확인'],
                  ] as [SortKey, string][]
                )
                  // 휴지통엔 확인 컬럼이 없다 — 메뉴에서도 숨김
                  .filter(([k]) => !(trashOpen && k === 'ack'))
                  .map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => {
                      // 휴지통 모드에선 휴지통 목록 정렬을 조작 (본문 정렬은 그대로 보존)
                      if (trashOpen) {
                        if (k !== 'ack') setTrashSort((s) => ({ ...s, key: k }));
                      } else setSortKey(k);
                      setSortMenu(false);
                    }}
                  >
                    <span className="cf-menu-check">
                      {(trashOpen ? trashSort.key === k : sortKey === k) && <CheckMarkIcon size={12} />}
                    </span>
                    {trashOpen && k === 'author' ? '지운 사람' : trashOpen && k === 'date' ? '지운 날짜' : label}
                  </button>
                ))}
                <div className="cf-menu-sep" />
                <button
                  onClick={() => {
                    if (trashOpen) setTrashSort((s) => ({ ...s, dir: 'asc' }));
                    else setSortDir('asc');
                    setSortMenu(false);
                  }}
                >
                  <span className="cf-menu-check">
                    {(trashOpen ? trashSort.dir === 'asc' : sortDir === 'asc') && <CheckMarkIcon size={12} />}
                  </span>
                  오름차순
                </button>
                <button
                  onClick={() => {
                    if (trashOpen) setTrashSort((s) => ({ ...s, dir: 'desc' }));
                    else setSortDir('desc');
                    setSortMenu(false);
                  }}
                >
                  <span className="cf-menu-check">
                    {(trashOpen ? trashSort.dir === 'desc' : sortDir === 'desc') && <CheckMarkIcon size={12} />}
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
              title={trashOpen ? '휴지통에서는 사용할 수 없어요' : undefined}
              disabled={trashOpen}
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
          {/* 필터 — 종류로 좁혀 보기 (탐색기식). 휴지통에선 버튼 자체를 숨긴다 */}
          {!trashOpen && (
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
          )}
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
                {trashOpen && (
                  /* 휴지통 모드 — 일괄 액션은 실행 취소 아래에 */
                  <>
                    <div className="cf-menu-sep" />
                    <button
                      className="cf-menu-danger"
                      disabled={trashItems.length === 0}
                      onClick={() => {
                        setMoreMenu(false);
                        void emptyTrash();
                      }}
                    >
                      <TrashIcon size={13} /> 휴지통 비우기
                    </button>
                    <button
                      disabled={trashItems.length === 0}
                      onClick={() => {
                        setMoreMenu(false);
                        if (!confirm(`휴지통의 ${trashItems.length}개 항목을 모두 복원할까요?`)) return;
                        void restoreMany(trashItems.map((t) => t.id));
                      }}
                    >
                      <UndoIcon size={13} /> 모든 항목 복원
                    </button>
                    {trashSelIds.size > 0 && (
                      <button
                        onClick={() => {
                          setMoreMenu(false);
                          void restoreMany([...trashSelIds]);
                        }}
                      >
                        <UndoIcon size={13} /> 선택한 항목 복원 ({trashSelIds.size})
                      </button>
                    )}
                  </>
                )}
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
                cwd === null && !trashOpen && !homeOpen && !ackOpen ? ' cur' : ''
              }${dropTarget === 'root' ? ' droptarget' : ''}`}
              onClick={() => navigate(null)}
              onDragOver={(e) => {
                if (dragIdsRef.current.length === 0 && trashDragIdsRef.current.length === 0)
                  return;
                e.preventDefault();
                e.dataTransfer.dropEffect =
                  trashDragIdsRef.current.length > 0 ? 'move' : e.ctrlKey ? 'copy' : 'move';
                setDropTarget('root');
              }}
              onDragLeave={() => setDropTarget((t) => (t === 'root' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                // 휴지통 행 드래그 — 이동이 아니라 루트로 복원
                if (trashDragIdsRef.current.length > 0) {
                  const tids = trashDragIdsRef.current;
                  trashDragIdsRef.current = [];
                  void restoreManyTo(tids, null);
                  return;
                }
                const ids = dragIdsRef.current;
                dragIdsRef.current = [];
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
                  setAckOpen(false);
                  setHomeOpen(true);
                }}
              >
                <span className="side-chevron" />
                <HomeIcon size={13} /> 홈
              </button>
            )}
            {/* 확인 필요는 사이드바에서 뺌 — 홈 하단 탭이 그 역할 (전용 뷰는 주소줄·크럼용으로 유지) */}
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
                        cwd === f.id && !trashOpen && !homeOpen && !ackOpen ? ' cur' : ''
                      }${dropTarget === f.id ? ' droptarget' : ''}`}
                      style={{ paddingLeft: 6 + depth * 14 }}
                      onClick={() => navigate(f.id)}
                      onDragOver={(e) => {
                        if (
                          (dragIdsRef.current.length === 0 ||
                            dragIdsRef.current.includes(f.id)) &&
                          trashDragIdsRef.current.length === 0
                        )
                          return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect =
                          trashDragIdsRef.current.length > 0
                            ? 'move'
                            : e.ctrlKey
                              ? 'copy'
                              : 'move';
                        setDropTarget(f.id);
                      }}
                      onDragLeave={() => setDropTarget((t) => (t === f.id ? null : t))}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDropTarget(null);
                        // 휴지통 행 드래그 — 이 폴더로 복원
                        if (trashDragIdsRef.current.length > 0) {
                          const tids = trashDragIdsRef.current;
                          trashDragIdsRef.current = [];
                          void restoreManyTo(tids, f.id);
                          return;
                        }
                        const ids = dragIdsRef.current;
                        dragIdsRef.current = [];
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
                      <TypeIcon type="folder" size={13} name={f.name} /> {f.name}
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
                setAckOpen(false);
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
        {/* 홈 — Win11 탐색기 홈 문법: 상단 즐겨찾기 핀 타일 그리드, 하단 알약 탭(최근 항목|작업 중) 리스트 */}
        {homeOpen &&
          (() => {
            const working = Object.entries(presence)
              .filter(([, ppl]) => ppl.length > 0)
              .map(([id, ppl]) => ({ f: byId.get(Number(id)), ppl }))
              .filter(
                (w): w is { f: CollabFile; ppl: { username: string; avatar: string | null }[] } =>
                  !!w.f,
              );
            return (
              <div
                ref={homeMainRef}
                className="cf-main cf-homeview"
                onClick={(e) => {
                  // 러버밴드 직후의 합성 클릭은 무시 (본문·휴지통과 동일 문법)
                  if (rubberMoved.current) {
                    rubberMoved.current = false;
                    return;
                  }
                  if (!(e.target as HTMLElement).closest('button, form, input'))
                    setSelectedIds(new Set());
                }}
                onPointerDown={(e) => {
                  // 러버밴드 — 빈 곳에서 박스 선택 (바탕화면 문법), 대상은 홈 타일·행
                  if (e.button !== 0) return;
                  if ((e.target as HTMLElement).closest('button, form, input')) return;
                  try {
                    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  } catch {
                    /* 캡처 불가 환경 무시 */
                  }
                  rubberMoved.current = false;
                  homeRubberBase.current =
                    e.ctrlKey || e.metaKey ? new Set(selectedIds) : new Set<number>();
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
                  if (Math.abs(nr.x1 - nr.x0) + Math.abs(nr.y1 - nr.y0) > 8)
                    rubberMoved.current = true;
                  if (!rubberMoved.current) return;
                  const host = homeMainRef.current;
                  if (host) {
                    const b = host.getBoundingClientRect();
                    let dy = 0;
                    if (e.clientY > b.bottom - 10) dy = e.clientY - (b.bottom - 10);
                    else if (e.clientY < b.top + 10) dy = e.clientY - (b.top + 10);
                    rubberScrollVel.current = dy;
                    if (dy !== 0 && rubberScrollRaf.current == null) {
                      const step = () => {
                        const m = homeMainRef.current;
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
                  const y0e = host ? nr.y0 - (host.scrollTop - nr.s0) : nr.y0;
                  const [lx, hx] = nr.x0 < nr.x1 ? [nr.x0, nr.x1] : [nr.x1, nr.x0];
                  const [ly, hy] = y0e < nr.y1 ? [y0e, nr.y1] : [nr.y1, y0e];
                  const hit = new Set(homeRubberBase.current);
                  host?.querySelectorAll<HTMLElement>('[data-fid]').forEach((el) => {
                    const id = Number(el.dataset.fid);
                    if (!Number.isFinite(id)) return;
                    const r2 = el.getBoundingClientRect();
                    if (r2.right > lx && r2.left < hx && r2.bottom > ly && r2.top < hy)
                      hit.add(id);
                  });
                  setSelectedIds(hit);
                }}
                onPointerUp={() => {
                  setRubber(null);
                  rubberScrollVel.current = 0;
                }}
              >
                {rubberOverlay(homeMainRef.current)}
                <div className="cf-home-sec">
                  {/* Win11처럼 섹션 접기 — 헤더 왼쪽 ∨ */}
                  <button
                    type="button"
                    className="cf-home-label cf-home-fold"
                    onClick={() => toggleHomeFold('pins')}
                  >
                    <span className={`side-chevron${homeFold.pins ? '' : ' open'}`}>
                      <ChevronIcon size={11} />
                    </span>
                    <PinIcon size={13} /> 고정됨
                  </button>
                  {homeFold.pins ? null : favFiles.length === 0 ? (
                    <div className="cf-empty">
                      자주 쓰는 파일을 고정해보세요 — 세부정보의 압정을 누르면 여기에 떠요
                    </div>
                  ) : (
                    /* Win11 즐겨찾기 핀 타일 — 아이콘 + 이름/위치 두 줄 + 핀 표시 */
                    <div className="cf-home-pins">
                      {favFiles.map((f) => (
                        <button
                          key={f.id}
                          data-fid={f.id}
                          className={`cf-home-pin${selectedIds.has(f.id) ? ' selected' : ''}`}
                          title={f.name}
                          draggable
                          onDragStart={homeDragStart(f)}
                          onDragEnd={homeDragEnd}
                          onClick={homeSelect(f)}
                          onDoubleClick={() => (f.type === 'folder' ? navigate(f.id) : openFile(f))}
                        >
                          <span className={`cf-icon ${f.type}`}>
                            <TypeIcon type={f.type} size={28} name={f.name} />
                          </span>
                          <span className="cf-home-pin-txt">
                            <span className="cf-home-pin-name">{f.name}</span>
                            <span className="cf-home-pin-loc">{fileLoc(f)}</span>
                          </span>
                          <span className="cf-home-pin-mark" aria-hidden>
                            <PinIcon size={11} />
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* 하단 — Win11 홈 하단 탭 문법: [확인 필요 | 작업 중 | 최근 항목], 왼쪽 ∨로 접기 */}
                <div className="cf-home-sec">
                  <div className="cf-home-tabs" role="tablist">
                    <button
                      type="button"
                      className="cf-home-fold cf-home-fold-tabs"
                      title={homeFold.list ? '펼치기' : '접기'}
                      onClick={() => toggleHomeFold('list')}
                    >
                      <span className={`side-chevron${homeFold.list ? '' : ' open'}`}>
                        <ChevronIcon size={11} />
                      </span>
                    </button>
                    <button
                      role="tab"
                      aria-selected={homeTab === 'ack'}
                      className={`cf-home-tab${homeTab === 'ack' ? ' on' : ''}`}
                      onClick={() => setHomeTab('ack')}
                    >
                      <CheckMarkIcon size={13} /> 확인 필요
                      {needAckFiles.length > 0 ? ` (${needAckFiles.length})` : ''}
                    </button>
                    <button
                      role="tab"
                      aria-selected={homeTab === 'working'}
                      className={`cf-home-tab${homeTab === 'working' ? ' on' : ''}`}
                      onClick={() => setHomeTab('working')}
                    >
                      <UsersIcon size={13} /> 작업 중
                      {working.length > 0 ? ` (${working.length})` : ''}
                    </button>
                    <button
                      role="tab"
                      aria-selected={homeTab === 'recent'}
                      className={`cf-home-tab${homeTab === 'recent' ? ' on' : ''}`}
                      onClick={() => setHomeTab('recent')}
                    >
                      <ClockIcon size={13} /> 최근 항목
                    </button>
                  </div>
                  {homeFold.list ? null : (
                  <>
                  {/* 흐린 컬럼 라벨 — 정렬 없음, 라벨만 (listhead와 같은 톤) */}
                  <div className="cf-home-listhead" aria-hidden>
                    <span>이름</span>
                    <span className="cf-home-col-r">
                      {homeTab === 'ack' ? '확인' : homeTab === 'working' ? '활동' : '날짜'}
                    </span>
                  </div>
                  {homeTab === 'ack' ? (
                    needAckFiles.length === 0 ? (
                      <div className="cf-empty">
                        확인할 문서가 없어요 — 요청받은 서명을 전부 마쳤어요
                      </div>
                    ) : (
                      <div className="cf-home-list">
                        {needAckFiles.map((f) => (
                          <button
                            key={f.id}
                            data-fid={f.id}
                            className={`cf-home-row${selectedIds.has(f.id) ? ' selected' : ''}`}
                            draggable
                            onDragStart={homeDragStart(f)}
                            onDragEnd={homeDragEnd}
                            onClick={homeSelect(f)}
                            onDoubleClick={() => openFile(f)}
                          >
                            <span className={`cf-icon ${f.type}`}>
                              <TypeIcon type={f.type} size={18} name={f.name} />
                            </span>
                            <span className="cf-home-row-txt">
                              <span className="cf-home-row-name">{f.name}</span>
                              <span className="cf-home-row-sub">{fileLoc(f)}</span>
                            </span>
                            <span className="cf-home-col-r">
                              <span className="cf-ack-cell">
                                {f.ack_count ?? 0}/{f.ack_total ?? 0}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  ) : homeTab === 'working' ? (
                    working.length === 0 ? (
                      <div className="cf-empty">지금 열려 있는 문서가 없어요</div>
                    ) : (
                      <div className="cf-home-list">
                        {working.map(({ f, ppl }) => (
                          <button
                            key={f.id}
                            data-fid={f.id}
                            className={`cf-home-row${selectedIds.has(f.id) ? ' selected' : ''}`}
                            draggable
                            onDragStart={homeDragStart(f)}
                            onDragEnd={homeDragEnd}
                            onClick={homeSelect(f)}
                            onDoubleClick={() => openFile(f)}
                          >
                            <span className={`cf-icon ${f.type}`}>
                              <TypeIcon type={f.type} size={18} name={f.name} />
                            </span>
                            <span className="cf-home-row-txt">
                              <span className="cf-home-row-name">{f.name}</span>
                              <span className="cf-home-row-sub">{fileLoc(f)}</span>
                            </span>
                            <span className="cf-home-col-r">
                              <PresenceStack fileId={f.id} />
                              {ppl.length}명 작업 중
                            </span>
                          </button>
                        ))}
                      </div>
                    )
                  ) : recent.length === 0 ? (
                    <div className="cf-empty">아직 활동이 없어요 — 문서를 열면 여기에 쌓여요</div>
                  ) : (
                    <div className="cf-home-list">
                      {recent.map((rf) => {
                        const f = byId.get(rf.id);
                        return (
                          <button
                            key={rf.id}
                            data-fid={f ? f.id : undefined}
                            className={`cf-home-row${f && selectedIds.has(f.id) ? ' selected' : ''}`}
                            draggable={!!f}
                            onDragStart={f ? homeDragStart(f) : undefined}
                            onDragEnd={homeDragEnd}
                            onClick={f ? homeSelect(f) : undefined}
                            onDoubleClick={() => {
                              if (f) openFile(f);
                            }}
                          >
                            <span className={`cf-icon ${rf.type}`}>
                              <TypeIcon type={rf.type} size={18} name={rf.name} />
                            </span>
                            <span className="cf-home-row-txt">
                              <span className="cf-home-row-name">{rf.name}</span>
                              <span className="cf-home-row-sub">
                                {f
                                  ? fileLoc(f)
                                  : rf.type === 'folder'
                                    ? '폴더'
                                    : TYPE_LABEL[rf.type as Exclude<FileType, 'folder'>]}
                              </span>
                            </span>
                            <span className="cf-home-col-r">
                              {rf.last_ts ? fmtDate(rf.last_ts) : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  </>
                  )}
                </div>
              </div>
            );
          })()}
        {/* 확인 필요 뷰 — 내가 서명 안 한 회람 문서만 모은 "장소" (홈과 같은 리스트 문법).
         * 행 클릭 = 문서 열기 → 서명하고 돌아오면 load()가 개수를 갱신한다 */}
        {ackOpen && (
          <div className="cf-main cf-homeview cf-ackview">
            <div className="cf-home-sec">
              <div className="cf-home-label cf-ack-label">
                <CheckMarkIcon size={13} /> 확인 필요 — 열람 서명이 남은 문서
              </div>
              {needAckFiles.length === 0 ? (
                <div className="cf-empty">확인할 문서가 없어요 — 요청받은 서명을 전부 마쳤어요</div>
              ) : (
                <>
                  <div className="cf-home-listhead" aria-hidden>
                    <span>이름</span>
                    <span className="cf-home-col-r">확인</span>
                  </div>
                  <div className="cf-home-list">
                    {needAckFiles.map((f) => (
                      <button key={f.id} className="cf-home-row" onClick={() => openFile(f)}>
                        <span className={`cf-icon ${f.type}`}>
                          <TypeIcon type={f.type} size={18} name={f.name} />
                        </span>
                        <span className="cf-home-row-txt">
                          <span className="cf-home-row-name">{f.name}</span>
                          <span className="cf-home-row-sub">{fileLoc(f)}</span>
                        </span>
                        <span className="cf-home-col-r">
                          <span className="cf-ack-cell">
                            {f.ack_count ?? 0}/{f.ack_total ?? 0}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
        {/* 휴지통 뷰 — 팝오버가 아니라 본문 전체를 쓰는 "장소" (8/2) */}
        {trashOpen && (
          <div
            ref={trashMainRef}
            className="cf-main list cf-trashmain"
            onClick={(e) => {
              // 러버밴드 직후의 합성 클릭은 무시 — 방금 만든 선택을 지우면 안 됨 (본문과 동일 문법)
              if (rubberMoved.current) {
                rubberMoved.current = false;
                return;
              }
              // 빈 곳 클릭 → 선택 해제 (행·헤더 버튼 위는 제외 — 각자 처리)
              if (!(e.target as HTMLElement).closest('.cf-trash-row, form, input, button'))
                setTrashSelIds(new Set());
            }}
            onPointerDown={(e) => {
              // 러버밴드 — 빈 곳에서 드래그로 박스 선택 (본문 목록과 동일 문법, 대상만 휴지통 행)
              if (e.button !== 0) return;
              if ((e.target as HTMLElement).closest('.cf-trash-row, form, input, button')) return;
              try {
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              } catch {
                /* 캡처 불가 환경 무시 */
              }
              rubberMoved.current = false;
              // Ctrl 러버밴드 = 기존 선택에 추가, 아니면 대체 — 시작 시점 선택을 기준으로
              trashRubberBase.current =
                e.ctrlKey || e.metaKey ? new Set(trashSelIds) : new Set<number>();
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
              const host = trashMainRef.current;
              // 가장자리를 넘겨 드래그하면 페이지가 아니라 목록 자신을 자동 스크롤
              if (host) {
                const b = host.getBoundingClientRect();
                let dy = 0;
                if (e.clientY > b.bottom - 10) dy = e.clientY - (b.bottom - 10);
                else if (e.clientY < b.top + 10) dy = e.clientY - (b.top + 10);
                rubberScrollVel.current = dy;
                if (dy !== 0 && rubberScrollRaf.current == null) {
                  const step = () => {
                    const m = trashMainRef.current;
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
              const y0e = host ? nr.y0 - (host.scrollTop - nr.s0) : nr.y0;
              const [lx, hx] = nr.x0 < nr.x1 ? [nr.x0, nr.x1] : [nr.x1, nr.x0];
              const [ly, hy] = y0e < nr.y1 ? [y0e, nr.y1] : [nr.y1, y0e];
              const hit = new Set(trashRubberBase.current);
              host?.querySelectorAll<HTMLElement>('.cf-trash-row').forEach((el) => {
                const id = Number(el.dataset.tid);
                if (!Number.isFinite(id)) return;
                const r2 = el.getBoundingClientRect();
                if (r2.right > lx && r2.left < hx && r2.bottom > ly && r2.top < hy) hit.add(id);
              });
              setTrashSelIds(hit);
            }}
            onPointerUp={() => {
              setRubber(null);
              rubberScrollVel.current = 0;
            }}
          >
            {rubberOverlay(trashMainRef.current)}
            {trashItems.length === 0 ? (
              <div className="cf-empty">휴지통이 비어 있어요</div>
            ) : (
              <>
                <div className="cf-listhead cf-trashhead-row">
                  <button type="button" title="이름으로 정렬" onClick={() => trashHdrClick('name')}>
                    {trashHdrMark('name')}이름
                    {colHandle('tname')}
                  </button>
                  <button type="button" title="원래 위치로 정렬" onClick={() => trashHdrClick('loc')}>
                    {trashHdrMark('loc')}원래 위치
                    {colHandle('tloc')}
                  </button>
                  <button type="button" title="지운 사람으로 정렬" onClick={() => trashHdrClick('author')}>
                    {trashHdrMark('author')}지운 사람
                    {colHandle('tauthor')}
                  </button>
                  <button type="button" title="지운 날짜로 정렬" onClick={() => trashHdrClick('date')}>
                    {trashHdrMark('date')}지운 날짜
                    {colHandle('tdate')}
                  </button>
                  <button type="button" title="크기로 정렬" onClick={() => trashHdrClick('size')}>
                    {trashHdrMark('size')}크기
                    {colHandle('tsize')}
                  </button>
                  <button type="button" title="항목 유형으로 정렬" onClick={() => trashHdrClick('type')}>
                    {trashHdrMark('type')}항목 유형
                    {colHandle('ttype')}
                  </button>
                  <button type="button" title="수정한 날짜로 정렬" onClick={() => trashHdrClick('mdate')}>
                    {trashHdrMark('mdate')}수정한 날짜
                    {colHandle('tmdate')}
                  </button>
                </div>
                {sortedTrashItems.map((t) => (
                  <div
                    key={t.id}
                    data-tid={t.id}
                    className={`cf-trash-row${trashSelIds.has(t.id) ? ' selected' : ''}${
                      clipboard?.fromTrash && clipboard.ids.includes(t.id) ? ' cutting' : ''
                    }`}
                    draggable
                    onDragStart={(e) => {
                      // 윈도우 문법 — 선택 밖 행을 끌면 그 행만 선택하고 시작, 선택 안이면 선택 전체
                      const inSel = trashSelIds.has(t.id);
                      if (!inSel) setTrashSelIds(new Set([t.id]));
                      const ids = inSel ? [...new Set([...trashSelIds, t.id])] : [t.id];
                      trashDragIdsRef.current = ids;
                      e.dataTransfer.effectAllowed = 'move'; // 복원은 이동만 — Ctrl 복사 없음
                      e.dataTransfer.setData('text/plain', '');
                      // 여러 개 들었으면 커스텀 고스트 (본문 목록과 동일 문법 — 카드 스택 + 개수 배지)
                      if (ids.length > 1 && dragEmptyImg.current) {
                        e.dataTransfer.setDragImage(dragEmptyImg.current, 0, 0);
                        const byTid = new Map(trashItems.map((x) => [x.id, x]));
                        // 폴더가 스택 맨 위에 보이게 — 나중에 렌더된 카드가 위로 오므로 폴더를 뒤로
                        const sorted = [...ids].sort((a, b) => {
                          const fa = byTid.get(a)?.type === 'folder' ? 1 : 0;
                          const fb = byTid.get(b)?.type === 'folder' ? 1 : 0;
                          return fa - fb;
                        });
                        setDragGhost({
                          count: ids.length,
                          folders: ids.filter((id) => byTid.get(id)?.type === 'folder').length,
                          excluded: 0,
                          types: sorted.slice(-3).map((id) => byTid.get(id)?.type ?? 'doc'),
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }
                    }}
                    onDragEnd={() => {
                      trashDragIdsRef.current = [];
                      setDropTarget(null);
                      setDragGhost(null);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      // 윈도우 문법 — 선택 밖 행을 우클릭하면 그 행만 선택하고 메뉴
                      setTrashSelIds((prev) => (prev.has(t.id) ? prev : new Set([t.id])));
                      setTrashCtx({ x: e.clientX, y: e.clientY });
                    }}
                    onClick={(e) => {
                      // 클릭 선택, Ctrl 다중 — 탐색기 본문과 동일 문법
                      setTrashSelIds((prev) => {
                        if (e.ctrlKey || e.metaKey) {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id);
                          else next.add(t.id);
                          return next;
                        }
                        return prev.has(t.id) && prev.size === 1 ? new Set() : new Set([t.id]);
                      });
                    }}
                  >
                    <span className={`cf-icon ${t.type}`}>
                      <TypeIcon type={t.type} size={15} name={t.name} />
                    </span>
                    <span className="cf-trash-name" title={t.name}>
                      {t.name}
                      {t.children > 0 ? ` (+${t.children})` : ''}
                    </span>
                    <span
                      className="cf-trash-loc"
                      title={[rootName, t.location].filter(Boolean).join(' › ')}
                    >
                      {[rootName, t.location].filter(Boolean).join(' › ')}
                    </span>
                    <span className="cf-trash-meta cf-trash-author">{dn(t.author)}</span>
                    <span className="cf-trash-meta cf-trash-date">
                      {new Date(t.deleted_at + 'Z').toLocaleString('ko-KR', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="cf-trash-size">
                      {t.type === 'folder' && !t.size ? '—' : fmtSize(t.size ?? 0)}
                    </span>
                    <span className="cf-trash-meta cf-trash-type">
                      {t.type === 'folder' ? '폴더' : `${TYPE_LABEL[t.type]} 파일`}
                    </span>
                    <span className="cf-trash-meta cf-trash-mdate">
                      {new Date(t.updated_at + 'Z').toLocaleString('ko-KR', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
        <div
          ref={mainRef}
          style={{ display: trashOpen || homeOpen || ackOpen ? 'none' : undefined }}
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
          {rubberOverlay(mainRef.current)}
          {view === 'list' && items.length > 0 && (
            <div className="cf-listhead">
              <button
                type="button"
                title="이름으로 정렬"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('name');
                }}
              >
                {hdrMark('name')}이름
                {colHandle('name')}
              </button>
              {/* 윈도우 순서: 이름 · 수정한 날짜 · 유형 · 크기 — 만든 사람·접속 중은 우리 고유라 뒤에 */}
              <button
                type="button"
                className="cf-listhead-date"
                title="수정한 날짜로 정렬"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('date');
                }}
              >
                {hdrMark('date')}수정한 날짜
                {colHandle('date')}
              </button>
              <button
                type="button"
                title="유형으로 정렬"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('type');
                }}
              >
                {hdrMark('type')}유형
                {colHandle('type')}
              </button>
              <button
                type="button"
                className="cf-listhead-size"
                title="크기로 정렬"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('size');
                }}
              >
                {hdrMark('size')}크기
                {colHandle('size')}
              </button>
              <button
                type="button"
                title="만든 사람으로 정렬"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('author');
                }}
              >
                {hdrMark('author')}만든 사람
                {colHandle('author')}
              </button>
              {/* 확인 — 회람(열람 서명) 진행 "서명 수/대상 수" (클릭 = 미확인 많은 순) */}
              <button
                type="button"
                className="cf-listhead-ack"
                title="확인으로 정렬 — 미확인 많은 순"
                onClick={(e) => {
                  e.stopPropagation();
                  hdrClick('ack');
                }}
              >
                {hdrMark('ack')}확인
                {colHandle('ack')}
              </button>
              {/* 접속 중 — 지금 이 파일을 편집·열람 중인 사람 (정렬 없음) */}
              <span className="cf-listhead-online">
                접속 중{colHandle('online')}
              </span>
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
                  {/* 컬럼 셀은 일반 행과 같은 5칸 구조(정렬 유지) — 시스템 항목이라 값은 비움 */}
                  <span className="cf-entry-date" />
                  <span className="cf-entry-type" />
                  <span className="cf-entry-size" />
                  <span className="cf-entry-author" />
                  <span className="cf-entry-online" />
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
                  isSel && !canEdit(f) ? ' readonly' : ''
                }${
                  clipboard?.op === 'cut' && !clipboard.fromTrash && clipboard.ids.includes(f.id)
                    ? ' cutting'
                    : ''
                }${dropTarget === f.id ? ' droptarget' : ''}`}
                draggable
                onDragStart={(e) => {
                  if (!selectedIds.has(f.id)) selectOnly(f.id);
                  const base = [...new Set(selectedIds.has(f.id) ? [...selectedIds, f.id] : [f.id])];
                  const ids = base.filter((id) => {
                    const x = byId.get(id);
                    return x && canEdit(x);
                  });
                  const excluded = base.length - ids.length; // 편집 권한 없어 이동에서 빠지는 항목
                  if (ids.length === 0) {
                    // 전부 권한 없음 — 조용히 빈 드래그가 되느니 시작을 막고 이유를 말한다
                    e.preventDefault();
                    toast('만든 사람·호스트·관리자만 이동할 수 있는 항목이에요', 'error');
                    return;
                  }
                  dragIdsRef.current = ids;
                  e.dataTransfer.effectAllowed = 'copyMove'; // Ctrl 누르고 놓으면 복사
                  e.dataTransfer.setData('text/plain', '');
                  // 여러 개 들었거나 제외가 생겼으면 커스텀 고스트 (개수 배지 + 제외 사유)
                  if ((ids.length > 1 || excluded > 0) && dragEmptyImg.current) {
                    e.dataTransfer.setDragImage(dragEmptyImg.current, 0, 0);
                    // 폴더가 스택 맨 위에 보이게 — 나중에 렌더된 카드가 위로 오므로 폴더를 뒤로
                    const sorted = [...ids].sort((a, b) => {
                      const fa = byId.get(a)?.type === 'folder' ? 1 : 0;
                      const fb = byId.get(b)?.type === 'folder' ? 1 : 0;
                      return fa - fb;
                    });
                    setDragGhost({
                      count: ids.length,
                      folders: ids.filter((id) => byId.get(id)?.type === 'folder').length,
                      excluded,
                      // 뒤 3개 — 폴더를 뒤로 정렬했으니 slice(0,3)이면 폴더가 스택에서 통째로 빠진다
                      types: sorted.slice(-3).map((id) => byId.get(id)?.type ?? 'doc'),
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
                title={`${f.name} · ${f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]} · ${dn(f.author)}${
                  !canEdit(f) ? ' · 이동·삭제는 만든 사람·호스트만' : ''
                }`}
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
                    <TypeIcon type={f.type} size={view === 'grid' ? 30 : 16} name={f.name} />
                  </span>
                )}
                {/* 열람 서명 배지 — 빨강: 내 서명 필요 / 초록: 서명 완료 (목록 뷰는 확인 컬럼이 대체) */}
                {view !== 'list' && !!f.ack_required && (
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
                    {/* 윈도우 순서 — 헤더(수정한 날짜·유형·크기·만든 사람)와 1:1 */}
                    <span className="cf-entry-date">{fmtDate(f.updated_at ?? f.created_at)}</span>
                    <span className="cf-entry-type">
                      {f.type === 'folder' ? '폴더' : TYPE_LABEL[f.type]}
                    </span>
                    <span className="cf-entry-size">
                      {/* 윈도우 문법 — 파일은 항상 숫자(빈 것도 0B), 폴더만 빈 경우 공란 */}
                      {f.type === 'folder'
                        ? f.size
                          ? fmtSize(f.size)
                          : '—'
                        : fmtSize(f.size ?? 0)}
                    </span>
                    <span className="cf-entry-author">{dn(f.author)}</span>
                    {/* 확인 — 회람 문서만 "서명 수/대상 수", 전원 완료면 초록 체크 (ackdot 색 문법) */}
                    <span className="cf-entry-ack">
                      {!!f.ack_required &&
                        ((f.ack_count ?? 0) >= (f.ack_total ?? 1) ? (
                          <span className="cf-ack-cell done" title="전원 확인 완료">
                            <CheckMarkIcon size={11} /> {f.ack_count ?? 0}/{f.ack_total ?? 0}
                          </span>
                        ) : (
                          <span
                            className="cf-ack-cell"
                            title={`미확인 ${Math.max((f.ack_total ?? 0) - (f.ack_count ?? 0), 0)}명`}
                          >
                            {f.ack_count ?? 0}/{f.ack_total ?? 0}
                          </span>
                        ))}
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
                        <TypeIcon type={h.type} size={14} name={h.name} />
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
          className={`cf-slidewrap cf-slide-r${detailsOn && !ackOpen ? ' open' : ''}`}
          aria-hidden={!detailsOn || ackOpen}
        >
        {/* 홈 — 선택이 없을 때만 홈 요약 카드 (선택하면 본문과 같은 파일 상세가 뜬다) */}
        {homeOpen && selCount === 0 && (
          <aside className="cf-details">
            <div className="cf-details-icon cf-icon file">
              <HomeIcon size={38} />
            </div>
            <div className="cf-details-name">홈</div>
            <div className="cf-details-sub">고정·확인·최근 모아보기</div>
            <div className="cf-details-rows">
              <div className="cf-details-row">
                <span>고정됨</span>
                <b>{favFiles.length}개</b>
              </div>
              <div className="cf-details-row">
                <span>확인 필요</span>
                <b>{needAckFiles.length}건</b>
              </div>
              <div className="cf-details-row">
                <span>최근 항목</span>
                <b>{recent.length}개</b>
              </div>
            </div>
          </aside>
        )}
        {((trashOpen && trashSelList.length === 0) || (!trashOpen && trashSel && selCount === 0)) && (
          <aside className="cf-details">
            <div className="cf-details-icon cf-icon file cf-details-trashicon">
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
        {/* 휴지통 단일 선택 — 일반 항목과 같은 레이아웃, 휴지통 필드로 (원래 위치·지운 사람·지운 날짜) */}
        {trashOpen && trashSelList.length === 1 && (() => {
          const t = trashSelList[0];
          return (
            <aside className="cf-details">
              <div className={`cf-details-icon cf-icon ${t.type}`}>
                <TypeIcon type={t.type} size={42} name={t.name} />
              </div>
              <div className="cf-details-name">{t.name}</div>
              <div className="cf-details-sub">
                {t.type === 'folder' ? '폴더' : `${TYPE_LABEL[t.type]} 파일`} · 휴지통
              </div>
              <div className="cf-details-rows">
                <div className="cf-details-row">
                  <span>원래 위치</span>
                  <b>{[rootName, t.location].filter(Boolean).join(' › ')}</b>
                </div>
                <div className="cf-details-row">
                  <span>지운 사람</span>
                  <b>{dn(t.author) || '—'}</b>
                </div>
                <div className="cf-details-row">
                  <span>지운 날짜</span>
                  <b>
                    {new Date(t.deleted_at + 'Z').toLocaleString('ko-KR', {
                      year: 'numeric',
                      month: 'numeric',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </b>
                </div>
                {t.type === 'folder' && t.children > 0 && (
                  <div className="cf-details-row">
                    <span>포함 항목</span>
                    <b>{t.children}개</b>
                  </div>
                )}
                <div className="cf-details-row">
                  <span>크기</span>
                  <b>{t.type === 'folder' && !t.size ? '—' : fmtSize(t.size ?? 0)}</b>
                </div>
              </div>
              <div className="cf-details-acts">
                <button className="cf-details-open" onClick={() => void restoreMany([t.id])}>
                  <UndoIcon size={13} /> 복원
                </button>
                <button
                  className="cf-details-open danger"
                  onClick={() => void purgeMany([t.id])}
                >
                  <TrashIcon size={13} /> 영구 삭제
                </button>
              </div>
            </aside>
          );
        })()}
        {/* 휴지통 다중 선택 — 본문 다중 선택 문법 + 합산 크기 + 일괄 복원·영구 삭제 */}
        {trashOpen && trashSelList.length > 1 && (
          <aside className="cf-details">
            <div className="cf-details-icon cf-icon folder">
              <CopyIcon size={36} />
            </div>
            <div className="cf-details-name">{trashSelList.length}개 항목 선택</div>
            <div className="cf-details-sub">
              폴더 {trashSelList.filter((t) => t.type === 'folder').length}개 · 파일{' '}
              {trashSelList.filter((t) => t.type !== 'folder').length}개
            </div>
            <div className="cf-details-rows">
              <div className="cf-details-row">
                <span>크기 합계</span>
                <b>{fmtSize(trashSelList.reduce((s, t) => s + (t.size ?? 0), 0))}</b>
              </div>
            </div>
            <div className="cf-details-acts">
              <button
                className="cf-details-open"
                onClick={() => void restoreMany(trashSelList.map((t) => t.id))}
              >
                <UndoIcon size={13} /> 복원 ({trashSelList.length})
              </button>
              <button
                className="cf-details-open danger"
                onClick={() => void purgeMany(trashSelList.map((t) => t.id))}
              >
                <TrashIcon size={13} /> 영구 삭제 ({trashSelList.length})
              </button>
            </div>
          </aside>
        )}
        {!trashOpen && !homeOpen && !ackOpen && !trashSel && selCount === 0 && (
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
              <TypeIcon type={selected.type} size={42} name={selected.name} />
            </div>
            <div className="cf-details-name">
              {selected.name}
              <button
                className={`cf-fav-star${favs.includes(selected.id) ? ' on' : ''}`}
                title={favs.includes(selected.id) ? '고정 해제' : '고정'}
                onClick={() => toggleFav(selected.id)}
              >
                <PinIcon size={14} />
              </button>
            </div>
            <div className="cf-details-sub">
              {selected.type === 'folder' ? '폴더' : `${TYPE_LABEL[selected.type]} 파일`}
              {/* 개정 뱃지 — v2부터 노출 (v1은 소음). Yjs 문서는 이게 유일한 개정 표시 */}
              {selected.type !== 'folder' && (selected.rev ?? 1) > 1 && (
                <span className="cf-rev-badge">개정 v{selected.rev}</span>
              )}
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
            {/* 업로드 파일 버전 기록 — 접기 섹션 (vN = 현재 개정), 지난 판 다운로드 */}
            {selected.type === 'file' && (
              <div className="cf-versions">
                <button
                  type="button"
                  className="cf-ack-fold cf-versions-fold"
                  onClick={() => setVersionsOpen((v) => !v)}
                >
                  <span className={`side-chevron${versionsOpen ? ' open' : ''}`}>
                    <ChevronIcon size={10} />
                  </span>
                  🕘 버전 기록 (v{selected.rev ?? 1})
                </button>
                {versionsOpen && (
                  <>
                    {(fileVersions?.length ?? 0) > 0 &&
                      /* 서버는 최신순(DESC) — 가장 오래된 판이 v1 */
                      fileVersions!.map((v, i) => (
                        <div key={v.id} className="cf-version-row">
                          <b className="cf-version-no">v{fileVersions!.length - i}</b>
                          <span className="cf-version-meta">
                            {v.username ? dn(v.username) : '—'} · {fmtDate(v.created_at)} ·{' '}
                            {fmtSize(v.size)}
                          </span>
                          <a
                            className="cf-version-dl"
                            href={`/api/meetings/${code}/files/${selected.id}/versions/${v.id}/download?token=${encodeURIComponent(token ?? '')}`}
                            onClick={(e) => {
                              // 구본 경고 — GMP 문법: 지난 판은 참고용, 현장 사용 금지
                              const vNo = fileVersions!.length - i;
                              if (
                                !confirm(
                                  `v${vNo}은(는) 구본이에요 — 최신은 v${selected.rev ?? 1}. 참고용으로만 받아주세요.`,
                                )
                              )
                                e.preventDefault();
                            }}
                          >
                            다운로드
                          </a>
                        </div>
                      ))}
                    {(fileVersions?.length ?? 0) === 0 && (
                      <div className="cf-version-none">이전 버전 없음</div>
                    )}
                  </>
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
                    {/* 회람 현황 — "확인 서명 수/대상 수" (전원 완료 초록 · 미완 빨강, ackdot 색 문법) */}
                    <div className="cf-ack-head">
                      <CheckMarkIcon size={13} /> 확인{' '}
                      <b
                        className={
                          ackStatus
                            ? ackStatus.pending.length === 0
                              ? 'ok'
                              : 'due'
                            : undefined
                        }
                      >
                        {ackStatus
                          ? `${ackStatus.acks.length}/${ackStatus.total}`
                          : `${selected.ack_count ?? 0}/${selected.ack_total ?? 0}`}
                      </b>
                    </div>
                    {/* 이번 개정에서 바뀐 것 — 개정 발행 시 AI가 이전·새 본문을 비교해 만든 요약 (없으면 숨김) */}
                    {ackStatus?.note && (
                      <div className="cf-ack-note">
                        <div className="cf-ack-note-title">
                          ✦ 이번 개정에서 바뀐 것{ackStatus.rev ? ` (v${ackStatus.rev})` : ''}
                        </div>
                        {ackStatus.note.split('\n').map((ln, i) => (
                          <div key={i} className="cf-ack-note-line">
                            {ln}
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 미확인자 명단 — 누가 아직 안 봤는지 (아바타 정사각 규칙) */}
                    {ackStatus &&
                      (ackStatus.pending.length > 0 ? (
                        <div className="cf-ack-pending">
                          {ackStatus.pending.map((p) => (
                            <span key={p.username} className="cf-ack-pend">
                              <Avatar value={p.avatar} className="cf-ack-pend-avatar" />
                              <span>{dn(p.username)}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="cf-ack-done">✓ 전원 확인 완료</div>
                      ))}
                    {/* 서명자 명단 — 기본 접힘 (미확인자가 주인공, 펼치면 손서명 칩) */}
                    {ackStatus && ackStatus.acks.length > 0 && (
                      <>
                        <button
                          type="button"
                          className="cf-ack-fold"
                          onClick={() => setAckSignedOpen((v) => !v)}
                        >
                          <span className={`side-chevron${ackSignedOpen ? ' open' : ''}`}>
                            <ChevronIcon size={10} />
                          </span>
                          서명자 {ackStatus.acks.length}명
                        </button>
                        {ackSignedOpen && (
                          <>
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
                            {/* 개정 발행 시 서명은 지워지지 않고 이관됨 — 이력 뷰어는 추후 */}
                            <div className="cf-ack-hist">지난 개정 서명은 이력에 보관됩니다</div>
                          </>
                        )}
                      </>
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
                    {/* 미서명자 리마인드 — 결정 리마인드의 문서판 (서버 쿨다운 1시간) */}
                    {canEdit(selected) && ackStatus && ackStatus.acks.length < ackStatus.total && (
                      <button
                        className="cf-ack-req"
                        onClick={async () => {
                          try {
                            const r = await api<{ reminded: number }>(
                              `/api/meetings/${code}/files/${selected.id}/ack-remind`,
                              { method: 'POST' },
                            );
                            toast(
                              r.reminded > 0
                                ? `미서명자 ${r.reminded}명에게 리마인드를 보냈어요`
                                : '보낼 대상이 없어요',
                            );
                          } catch {
                            /* 전역 토스트 (쿨다운 429 포함) */
                          }
                        }}
                      >
                        🔔 미서명자 리마인드
                      </button>
                    )}
                    {/* 자동 에스컬레이션 안내 — 서버 스케줄러(ACK_AUTOREMIND_HOURS, 기본 48시간) */}
                    {ackStatus && ackStatus.pending.length > 0 && (
                      <div className="cf-ack-auto">서명이 이틀째 없으면 AI가 자동으로 리마인드해요</div>
                    )}
                    {/* 개정 발행 (재회람) — 내용이 바뀌어 전원 재확인이 필요할 때 */}
                    {canEdit(selected) && (
                      <button
                        className="cf-ack-req"
                        title="개정 번호가 +1 되고 전원 서명이 리셋돼요 — 지난 서명은 이력에 보관"
                        onClick={() => void reviseNow(selected)}
                      >
                        ↻ 개정 발행 (재회람)
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
                      <CheckMarkIcon size={13} /> 열람 서명 요청
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
                {/* 개수 배지 — 스택 모서리에 귀속 (inner 기준이면 라벨 폭만큼 떨어져 나감) */}
                <span className="cf-dragghost-count">{dragGhost.count}</span>
              </div>
              {(dragGhost.excluded > 0 ||
                (dragGhost.folders > 0 && dragGhost.folders < dragGhost.count)) && (
                <div className="cf-dragghost-labels">
                  {dragGhost.folders > 0 && dragGhost.folders < dragGhost.count && (
                    <span className="cf-dragghost-break">
                      폴더 {dragGhost.folders} · 파일 {dragGhost.count - dragGhost.folders}
                    </span>
                  )}
                  {dragGhost.excluded > 0 && (
                    <span className="cf-dragghost-excl">권한 없는 {dragGhost.excluded}개 제외</span>
                  )}
                </div>
              )}
              <span className="cf-dragghost-plus">＋복사</span>
            </div>
          </div>
        )}

        <div className="cf-statusbar">
          {homeOpen ? (
            <>
              홈 — 고정 {favFiles.length}개 · 작업 중{' '}
              {Object.values(presence).filter((p) => p.length > 0).length}개 · 최근 {recent.length}개
            </>
          ) : ackOpen ? (
            <>확인 필요 문서 {needAckFiles.length}개</>
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
        {/* 휴지통 우클릭 — 윈도우 휴지통과 동일 (복원·영구 삭제) */}
        {trashCtx && trashOpen && trashSelIds.size > 0 && (
          <div
            className="cf-ctx"
            style={{
              left: Math.min(trashCtx.x, window.innerWidth - 210),
              top: Math.min(trashCtx.y, window.innerHeight - 120),
            }}
          >
            <button
              onClick={() => {
                setTrashCtx(null);
                void restoreMany([...trashSelIds]);
              }}
            >
              <UndoIcon size={13} /> 복원{trashSelIds.size > 1 ? ` (${trashSelIds.size})` : ''}
            </button>
            <button
              className="danger"
              onClick={() => {
                setTrashCtx(null);
                void purgeMany([...trashSelIds]);
              }}
            >
              <TrashIcon size={13} /> 영구 삭제{trashSelIds.size > 1 ? ` (${trashSelIds.size})` : ''}
            </button>
          </div>
        )}
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
                  {favs.includes(ctxTarget.id) ? '고정 해제' : '고정'}
                </button>
                {/* 개정 발행 (재회람) — Yjs 문서·업로드 공통, 폴더 제외·단일 대상만 */}
                {ctxTarget.type !== 'folder' && (
                  <button
                    disabled={!canEdit(ctxTarget) || ctxIds.length > 1}
                    title="개정 번호가 +1 되고, 열람 서명이 걸린 문서면 전원 서명이 리셋돼요 (지난 서명은 이력 보관)"
                    onClick={() => {
                      void reviseNow(ctxTarget);
                      setCtxMenu(null);
                    }}
                  >
                    개정 발행 (재회람)
                  </button>
                )}
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
          {/* 확인 필요 배너 — 현장 작업자가 폰으로 "읽고 서명할 문서"에 바로 들어가는 문 (N>0일 때만) */}
          {needAckFiles.length > 0 && (
            <div className="cf-mack">
              <button
                className="cf-mack-banner"
                onClick={() => setMAckListOpen((v) => !v)}
                aria-expanded={mAckListOpen}
              >
                <span className="cf-mack-dot" aria-hidden />
                확인 필요 {needAckFiles.length}건 — 열람 서명이 남았어요
                <span className={`cf-chevron${mAckListOpen ? ' open' : ''}`}>
                  <ChevronIcon size={11} />
                </span>
              </button>
              {mAckListOpen && (
                <div className="cf-mack-list">
                  {needAckFiles.map((f) => (
                    <button key={f.id} className="cf-mack-row" onClick={() => openFile(f)}>
                      <span className={`cf-icon ${f.type}`}>
                        <TypeIcon type={f.type} size={16} name={f.name} />
                      </span>
                      <span className="cf-mack-row-txt">
                        <span className="cf-mack-row-name">{f.name}</span>
                        <span className="cf-mack-row-sub">{fileLoc(f)}</span>
                      </span>
                      <span className="cf-ack-cell">
                        {f.ack_count ?? 0}/{f.ack_total ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
              <TypeIcon type={active.type} name={active.name} />
            </span>
            <Marquee className="cf-editor-name">{active.name}</Marquee>
            {(active.rev ?? 1) > 1 && (
              <span className="cf-rev-badge" title="현재 개정 번호 — 이 화면은 항상 최신판이에요">
                개정 v{active.rev}
              </span>
            )}
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
        {/* 열람 중 개정 감지 — 지금 읽던 내용이 구본이 됐다는 경고 (GMP 구본 오용 방지) */}
        {active && openedRev != null && (active.rev ?? 1) > openedRev && (
          <div className="cf-revbar">
            ⚠ 읽는 사이 문서가 v{active.rev}으로 개정됐어요 — 처음부터 다시 확인해 주세요
          </div>
        )}
        {/* 열람 서명 배너 — 서명이 필요한 문서를 열면 읽고 서명하도록 */}
        {active && !!active.ack_required && !active.my_ack && (
          <>
            <div className="cf-ackbar">
              <span>
                <CheckMarkIcon size={13} /> 이 문서는 열람 확인이 필요해요 — 다 읽었으면 서명해
                주세요
              </span>
              <button onClick={() => setAckSignFor((v) => (v === active.id ? null : active.id))}>
                서명하기
              </button>
            </div>
            {/* 서명 모달 — 인라인 대신 의식감 있는 팝업. 무엇에 서명하는지(문서·개정·바뀐 점) 명시
                (전자서명의 "서명 의미 명시" 관례) — 진입점은 열람 화면뿐: 안 읽고 서명 방지 */}
            {ackSignFor === active.id && (
              <div className="cf-signmodal-backdrop" onClick={() => setAckSignFor(null)}>
                <div className="cf-signmodal" onClick={(e) => e.stopPropagation()}>
                  <div className="cf-signmodal-head">열람 확인 서명</div>
                  <div className="cf-signmodal-doc">
                    <TypeIcon type={active.type} name={active.name} />
                    <b>{active.name}</b>
                    {(active.rev ?? 1) > 1 && <span className="cf-rev-badge">개정 v{active.rev}</span>}
                  </div>
                  {signModalNote && (
                    <div className="cf-signmodal-note">
                      <div className="cf-signmodal-note-t">✦ 이번 개정에서 바뀐 것</div>
                      {signModalNote.split('\n').map((l, i) => (
                        <div key={i}>{l}</div>
                      ))}
                    </div>
                  )}
                  <div className="cf-signmodal-desc">
                    아래 서명은 이 문서(현재 개정판)를 열람했음을 확인하는 기록으로 남아요.
                  </div>
                  <SignPad
                    title={
                      isMobile
                        ? '손가락으로 이름을 적어주세요'
                        : '마우스나 손가락으로 이름을 적어주세요'
                    }
                    fluid /* 모달 폭에 맞춰 가로 꽉 */
                    onConfirm={(dataUrl) => void signAck(active.id, dataUrl)}
                    onCancel={() => setAckSignFor(null)}
                  />
                </div>
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
