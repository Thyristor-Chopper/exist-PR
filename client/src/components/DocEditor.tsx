import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { Mark } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Mention, { type MentionNodeAttrs } from '@tiptap/extension-mention';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { FontFamily, LineHeight } from '@tiptap/extension-text-style';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { api } from '../api';
import { useAuthStore } from '../store';
import { exportDocx } from '../lib/docx';
import Marquee from './Marquee';
import { PlusIcon, CloseIcon, DownloadIcon, CheckMarkIcon } from './Icons';
import ColorGrid from './ColorGrid';
import OverflowToolbar from './OverflowToolbar';

const CARET_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];


interface DocMeta {
  id: string;
  name: string;
  ord: number;
}

type Menu = 'export' | 'style' | 'color' | 'hl' | 'table' | 'link' | 'find' | 'font' | 'lh' | null;

const FONT_FAMILIES: { label: string; value: string | null; css?: string }[] = [
  { label: '기본', value: null },
  { label: '명조', value: "'Nanum Myeongjo', 'Noto Serif KR', Georgia, serif" },
  { label: '고정폭', value: "ui-monospace, Consolas, 'Nanum Gothic Coding', monospace" },
  { label: '필기체', value: "'Nanum Pen Script', 'Segoe Script', cursive" },
];
const LINE_HEIGHTS = ['1.15', '1.5', '1.8', '2.2'];

// ── 댓글 ──
interface CommentReply {
  author: string;
  ts: number;
  text: string;
}
interface CommentThread {
  author: string;
  ts: number;
  text: string;
  replies: CommentReply[];
  resolved?: boolean;
  anchor?: string; // 달린 본문 일부 (미리보기용)
}

/** 본문에 댓글 위치를 잡아두는 마크 — 스레드 내용은 Y.Map(comments:{docId})에 */
const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-comment-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-comment-id': attrs.id } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, class: 'doc-comment-mark' }, 0];
  },
});

// ── 변경이력 ──
interface VersionEntry {
  id: string;
  ts: number;
  author: string;
  label: string; // '수동' | '자동' | '복원 전'
  html: string;
}

/** 단어 단위 LCS diff — 큰 문서는 비용 때문에 건너뜀 */
function wordDiff(aText: string, bText: string): { t: 'same' | 'del' | 'add'; s: string }[] | null {
  const a = aText.split(/\s+/).filter(Boolean);
  const b = bText.split(/\s+/).filter(Boolean);
  if (a.length > 2500 || b.length > 2500) return null;
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: 'same' | 'del' | 'add'; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: 'same', s: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: 'del', s: a[i] });
      i++;
    } else {
      out.push({ t: 'add', s: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: 'del', s: a[i++] });
  while (j < m) out.push({ t: 'add', s: b[j++] });
  return out;
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${d.getMonth() + 1}/${d.getDate()} ${ampm} ${h12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function AlignSvg({ mode }: { mode: 'left' | 'center' | 'right' }) {
  const mid = mode === 'left' ? [1, 8.5] : mode === 'center' ? [3.2, 10.8] : [5.5, 13];
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="1" y1="3" x2="13" y2="3" />
      <line x1={mid[0]} y1="7" x2={mid[1]} y2="7" />
      <line x1="1" y1="11" x2="13" y2="11" />
    </svg>
  );
}

/* 구글 독스식 툴바 아이콘 — 16px stroke 미니 세트 */
const I = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const UndoSvg = () => <I><path d="M6 3 3 6l3 3" /><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H6" /></I>;
const RedoSvg = () => <I><path d="m10 3 3 3-3 3" /><path d="M13 6H6.5a3.5 3.5 0 0 0 0 7H10" /></I>;
const EraserSvg = () => <I><path d="m5.5 12.5-3-3a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0l3.6 3.6a1 1 0 0 1 0 1.4l-5.4 5.4Z" /><path d="M4 14h10" /></I>;
const LinkSvg = () => <I><path d="M6.5 9.5 9.5 6.5" /><path d="M7 4.5 8.5 3a2.8 2.8 0 0 1 4 4L11 8.5" /><path d="M9 11.5 7.5 13a2.8 2.8 0 0 1-4-4L5 7.5" /></I>;
const ImageSvg = () => <I><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="5.5" cy="6.5" r="1" fill="currentColor" stroke="none" /><path d="m4 12 3.5-3.5 2 2L12 8l2 2" /></I>;
const TableSvg = () => <I><rect x="2" y="2.5" width="12" height="11" rx="1" /><line x1="2" y1="6.5" x2="14" y2="6.5" /><line x1="7" y1="6.5" x2="7" y2="13.5" /></I>;
const SearchSvg = () => <I><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></I>;
const UlSvg = () => <I><circle cx="3" cy="4" r="1" fill="currentColor" stroke="none" /><circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" /><circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" /><line x1="6" y1="4" x2="14" y2="4" /><line x1="6" y1="8" x2="14" y2="8" /><line x1="6" y1="12" x2="14" y2="12" /></I>;
const OlSvg = () => <I><text x="1.2" y="5.4" fontSize="5" fill="currentColor" stroke="none">1</text><text x="1.2" y="9.6" fontSize="5" fill="currentColor" stroke="none">2</text><text x="1.2" y="13.8" fontSize="5" fill="currentColor" stroke="none">3</text><line x1="6" y1="4" x2="14" y2="4" /><line x1="6" y1="8" x2="14" y2="8" /><line x1="6" y1="12" x2="14" y2="12" /></I>;
const CheckSvg = () => <I><rect x="1.5" y="1.5" width="6" height="6" rx="1.5" /><path d="m3 4.6 1.3 1.3L6.5 3.5" /><rect x="1.5" y="9" width="6" height="6" rx="1.5" /><line x1="10" y1="4.5" x2="14.5" y2="4.5" /><line x1="10" y1="12" x2="14.5" y2="12" /></I>;
const CodeSvg = () => <I><path d="m5.5 4.5-3.5 3.5 3.5 3.5" /><path d="m10.5 4.5 3.5 3.5-3.5 3.5" /></I>;
const CommentSvg = () => <I><path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H6l-3.5 3v-3h-.5A1.5 1.5 0 0 1 .9 9.6" /><path d="M2 3.5v6A1.5 1.5 0 0 0 3.5 11H4v3l3.5-3h5A1.5 1.5 0 0 0 14 9.5v-6A1.5 1.5 0 0 0 12.5 2h-9A1.5 1.5 0 0 0 2 3.5Z" /></I>;
const HistorySvg = () => <I><path d="M8 4.5V8l2.5 1.5" /><path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9" /><path d="M2.5 12V8.8h3.2" /></I>;

/** Yjs 기반 리치텍스트 공동편집 — 여러 문서(탭), roomId 단위 공유 */
type MItem = { id: string; label: string; avatar: string | null };

export default function DocEditor({
  roomId,
  code,
  fileId,
  active = true,
}: {
  roomId: string;
  code?: string;
  fileId?: number;
  fileName?: string;
  /** false면 숨김 상태 — awareness를 내려서 프레즌스에서 빠짐 (연결은 유지) */
  active?: boolean;
}) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [conn, setConn] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const docsMapRef = useRef<Y.Map<{ name: string; ord: number }> | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [findCount, setFindCount] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // 댓글
  const commentsMapRef = useRef<Y.Map<CommentThread> | null>(null);
  const [comments, setComments] = useState<Record<string, CommentThread>>({});
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingNew, setPendingNew] = useState<{ from: number; to: number } | null>(null);
  const [commentDraft, setCommentDraft] = useState('');
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  // 변경이력
  const versionsRef = useRef<Y.Array<VersionEntry> | null>(null);
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [previewVer, setPreviewVer] = useState<VersionEntry | null>(null);
  const [diffMode, setDiffMode] = useState(false);
  const lastAutoHtmlRef = useRef('');
  // 개요 사이드바 / 인쇄
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [docPrinting, setDocPrinting] = useState(false);
  // @멘션 — 그룹 참가자 목록 (suggestion에서 ref로 참조)
  const participantsRef = useRef<{ username: string; name: string | null; avatar: string | null }[]>([]);
  const mentionCtxRef = useRef<{ code?: string; fileId?: number }>({});
  mentionCtxRef.current = { code, fileId };

  useEffect(() => {
    if (!code) return;
    void api<{ participants?: { username: string; name?: string | null; avatar?: string | null }[] }>(
      `/api/meetings/${code}`,
    )
      .then((d) => {
        participantsRef.current = (d.participants ?? []).map((p) => ({
          username: p.username,
          name: p.name ?? null,
          avatar: p.avatar ?? null,
        }));
      })
      .catch(() => {});
  }, [code]);

  useEffect(() => {
    if (!docPrinting) return;
    const t = setTimeout(() => window.print(), 150);
    const done = () => setDocPrinting(false);
    window.addEventListener('afterprint', done);
    document.body.classList.add('doc-printing');
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
      document.body.classList.remove('doc-printing');
    };
  }, [docPrinting]);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const docsMap = ydoc.getMap<{ name: string; ord: number }>('docs');
    docsMapRef.current = docsMap;
    setConn({ ydoc, provider });
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const syncDocs = () => {
      const list: DocMeta[] = [];
      docsMap.forEach((v, id) => list.push({ id, name: v.name, ord: v.ord }));
      list.sort((a, b) => a.ord - b.ord);
      setDocs(list);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
    };
    docsMap.observe(syncDocs);
    syncDocs();

    provider.on('sync', (isSynced: boolean) => {
      if (isSynced && docsMap.size === 0) {
        docsMap.set(crypto.randomUUID(), { name: '문서 1', ord: 1 });
      }
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    return () => {
      docsMap.unobserve(syncDocs);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      docsMapRef.current = null;
      setConn(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const color = CARET_COLORS[(user?.id ?? 0) % CARET_COLORS.length];
  const activeDoc = docs.find((d) => d.id === activeId) ?? null;
  const displayName = user?.name || user?.username || '익명';

  // 숨김(비활성) 동안 awareness를 내림 — 파일 목록 프레즌스·N명 참여에서 빠짐. 연결·문서 동기화는 유지
  // 주의: setLocalState(null) 후에는 setLocalStateField가 no-op이라 복귀는 setLocalState로 해야 함
  useEffect(() => {
    const p = conn?.provider;
    if (!p) return;
    if (active) {
      const cur = p.awareness.getLocalState();
      p.awareness.setLocalState({ ...(cur ?? {}), user: { name: user?.name || user?.username || '익명', color } });
    } else {
      p.awareness.setLocalState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, conn]);

  // 문서별 댓글·버전 맵 바인딩
  useEffect(() => {
    if (!conn || !activeId) return;
    const cMap = conn.ydoc.getMap<CommentThread>(`comments:${activeId}`);
    const vArr = conn.ydoc.getArray<VersionEntry>(`versions:${activeId}`);
    commentsMapRef.current = cMap;
    versionsRef.current = vArr;
    const syncC = () => setComments(Object.fromEntries(cMap.entries()));
    const syncV = () => setVersions(vArr.toArray());
    cMap.observe(syncC);
    vArr.observe(syncV);
    syncC();
    syncV();
    setActiveCommentId(null);
    setPendingNew(null);
    setPreviewVer(null);
    return () => {
      cMap.unobserve(syncC);
      vArr.unobserve(syncV);
      commentsMapRef.current = null;
      versionsRef.current = null;
    };
  }, [conn, activeId]);


  const baseExtensions = [
    StarterKit.configure({ undoRedo: false, link: { openOnClick: false, autolink: true } }),
    Image.configure({ allowBase64: true }),
    TableKit.configure({ table: { resizable: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TextStyle,
    Color,
    FontSize,
    FontFamily,
    LineHeight,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    CommentMark,
    // @멘션 — 그룹 참가자, 선택 시 상대에게 알림
    Mention.configure({
      HTMLAttributes: { class: 'doc-mention' },
      suggestion: {
        char: '@',
        items: ({ query }: { query: string }): MItem[] => {
          const q = query.toLowerCase();
          return participantsRef.current
            .filter(
              (p) =>
                p.username.toLowerCase().includes(q) || (p.name ?? '').toLowerCase().includes(q),
            )
            .slice(0, 6)
            .map((p) => ({
              id: p.username,
              label: p.name || p.username,
              avatar: p.avatar,
            }));
        },
        command: ({ editor: ed, range, props }) => {
          ed
            .chain()
            .focus()
            .insertContentAt(range, [
              { type: 'mention', attrs: { id: props.id, label: props.label } },
              { type: 'text', text: ' ' },
            ])
            .run();
          const ctx = mentionCtxRef.current;
          if (ctx.code && ctx.fileId && props.id) {
            void api(`/api/meetings/${ctx.code}/files/${ctx.fileId}/mention`, {
              method: 'POST',
              body: { username: props.id },
            }).catch(() => {});
          }
        },
        render: () => {
          let popup: HTMLDivElement | null = null;
          let selected = 0;
          let curItems: MItem[] = [];
          let curCommand: (attrs: MentionNodeAttrs) => void = () => {};
          const draw = (rect: DOMRect | null) => {
            if (!popup) return;
            popup.innerHTML = '';
            curItems.forEach((p, i) => {
              const row = document.createElement('button');
              row.type = 'button';
              row.className = `doc-mention-row${i === selected ? ' on' : ''}`;
              const av = document.createElement('span');
              av.className = 'doc-mention-av';
              const isImg = p.avatar && (p.avatar.startsWith('/api') || p.avatar.startsWith('http'));
              if (isImg) {
                const img = document.createElement('img');
                img.src = p.avatar!;
                av.appendChild(img);
              } else {
                av.textContent = p.avatar || '🙂';
              }
              row.appendChild(av);
              const nm = document.createElement('span');
              nm.textContent = p.label !== p.id ? `${p.label} (@${p.id})` : `@${p.id}`;
              row.appendChild(nm);
              row.onmousedown = (e) => {
                e.preventDefault();
                curCommand({ id: p.id, label: p.label });
              };
              popup!.appendChild(row);
            });
            if (!curItems.length) {
              const empty = document.createElement('div');
              empty.className = 'doc-mention-empty';
              empty.textContent = '참가자 없음';
              popup.appendChild(empty);
            }
            if (rect) {
              popup.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
              popup.style.top = `${rect.bottom + 4}px`;
            }
          };
          return {
            onStart: (props: SuggestionProps<MItem, MentionNodeAttrs>) => {
              curItems = props.items;
              curCommand = props.command;
              selected = 0;
              popup = document.createElement('div');
              popup.className = 'doc-mention-pop';
              document.body.appendChild(popup);
              draw(props.clientRect?.() ?? null);
            },
            onUpdate: (props: SuggestionProps<MItem, MentionNodeAttrs>) => {
              curItems = props.items;
              curCommand = props.command;
              if (selected >= curItems.length) selected = 0;
              draw(props.clientRect?.() ?? null);
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === 'ArrowDown') {
                selected = (selected + 1) % Math.max(1, curItems.length);
                draw(null);
                return true;
              }
              if (props.event.key === 'ArrowUp') {
                selected = (selected - 1 + Math.max(1, curItems.length)) % Math.max(1, curItems.length);
                draw(null);
                return true;
              }
              if (props.event.key === 'Enter') {
                if (curItems[selected])
                  curCommand({ id: curItems[selected].id, label: curItems[selected].label });
                return true;
              }
              if (props.event.key === 'Escape') {
                popup?.remove();
                popup = null;
                return true;
              }
              return false;
            },
            onExit: () => {
              popup?.remove();
              popup = null;
            },
          };
        },
      },
    }),
  ];

  const editor = useEditor(
    {
      extensions:
        conn && activeId
          ? [
              ...baseExtensions,
              Collaboration.configure({ document: conn.ydoc, field: `doc:${activeId}` }),
              CollaborationCaret.configure({
                provider: conn.provider,
                user: { name: user?.name || user?.username || '익명', color },
              }),
            ]
          : baseExtensions,
      editorProps: {
        attributes: { class: 'doc-prose' },
        handleClick: (view, pos) => {
          const node = view.state.doc.nodeAt(pos);
          const mark = node?.marks.find((m) => m.type.name === 'comment');
          if (mark?.attrs.id) {
            setActiveCommentId(mark.attrs.id as string);
            setCommentsOpen(true);
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const file = Array.from(event.clipboardData?.files ?? []).find((f) =>
            f.type.startsWith('image/'),
          );
          if (file) {
            insertImageFile(file);
            return true;
          }
          return false;
        },
        handleDrop: (_view, event) => {
          const file = Array.from(event.dataTransfer?.files ?? []).find((f) =>
            f.type.startsWith('image/'),
          );
          if (file) {
            event.preventDefault();
            insertImageFile(file);
            return true;
          }
          return false;
        },
      },
    },
    [conn, activeId],
  );
  editorRef.current = editor;

  // 자동 버전 — 5분마다, 내용이 바뀌었을 때만
  useEffect(() => {
    if (!editor) return;
    const t = setInterval(() => {
      const html = editorRef.current?.getHTML();
      if (!html || html === lastAutoHtmlRef.current) return;
      lastAutoHtmlRef.current = html;
      pushVersion('자동');
    }, 5 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // ── 댓글 동작 ──
  function startComment() {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from === to) {
      setCommentsOpen((v) => !v);
      return;
    }
    setPendingNew({ from, to });
    setCommentDraft('');
    setCommentsOpen(true);
  }
  function addComment() {
    const map = commentsMapRef.current;
    if (!editor || !map || !pendingNew || !commentDraft.trim()) return;
    const id = crypto.randomUUID();
    const anchor = editor.state.doc.textBetween(pendingNew.from, pendingNew.to).slice(0, 40);
    editor.chain().focus().setTextSelection(pendingNew).setMark('comment', { id }).run();
    map.set(id, {
      author: displayName,
      ts: Date.now(),
      text: commentDraft.trim(),
      replies: [],
      resolved: false,
      anchor,
    });
    setPendingNew(null);
    setCommentDraft('');
    setActiveCommentId(id);
  }
  function removeCommentMark(id: string) {
    if (!editor) return;
    const { state } = editor;
    const type = state.schema.marks.comment;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      for (const m of node.marks) {
        if (m.type === type && m.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, type);
      }
    });
    if (tr.docChanged) editor.view.dispatch(tr);
  }
  function resolveComment(id: string) {
    const map = commentsMapRef.current;
    const cur = map?.get(id);
    if (!map || !cur) return;
    removeCommentMark(id);
    map.set(id, { ...cur, resolved: true });
    if (activeCommentId === id) setActiveCommentId(null);
  }
  function deleteComment(id: string) {
    removeCommentMark(id);
    commentsMapRef.current?.delete(id);
    if (activeCommentId === id) setActiveCommentId(null);
  }
  function addReply(id: string) {
    const map = commentsMapRef.current;
    const cur = map?.get(id);
    const text = (replyDrafts[id] ?? '').trim();
    if (!map || !cur || !text) return;
    map.set(id, { ...cur, replies: [...cur.replies, { author: displayName, ts: Date.now(), text }] });
    setReplyDrafts((d) => ({ ...d, [id]: '' }));
  }
  function jumpToComment(id: string) {
    if (!editor) return;
    let found: { from: number; to: number } | null = null;
    editor.state.doc.descendants((node, pos) => {
      if (found || !node.isText) return;
      const m = node.marks.find((mk) => mk.type.name === 'comment' && mk.attrs.id === id);
      if (m) found = { from: pos, to: pos + node.nodeSize };
    });
    setActiveCommentId(id);
    if (found) editor.chain().focus().setTextSelection(found).scrollIntoView().run();
  }

  // ── 변경이력 동작 ──
  function pushVersion(label: string) {
    const arr = versionsRef.current;
    const html = editorRef.current?.getHTML();
    if (!arr || !html) return;
    const last = arr.length ? arr.get(arr.length - 1) : null;
    if (last && last.html === html) return; // 내용 동일하면 중복 저장 안 함
    arr.push([{ id: crypto.randomUUID(), ts: Date.now(), author: displayName, label, html }]);
    if (arr.length > 50) arr.delete(0, arr.length - 50);
  }
  function restoreVersion(v: VersionEntry) {
    if (!editor) return;
    if (!confirm(`${fmtTs(v.ts)} 버전으로 되돌릴까요? (현재 상태는 이력에 저장됩니다)`)) return;
    pushVersion('복원 전');
    editor.commands.setContent(v.html);
    setPreviewVer(null);
    setVersionsOpen(false);
  }
  function diffAgainstCurrent(v: VersionEntry) {
    const div = document.createElement('div');
    // 블록 닫힘마다 공백을 끼워 textContent에서 문단이 붙어버리는 것 방지
    div.innerHTML = v.html.replace(/<\/(p|h\d|li|td|th|blockquote|pre|div)>/gi, '</$1> ');
    const oldText = div.textContent ?? '';
    const curText = editor?.getText() ?? '';
    return wordDiff(oldText, curText);
  }

  function newDoc() {
    const map = docsMapRef.current;
    if (!map) return;
    const ord = docs.reduce((m, d) => Math.max(m, d.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { name: `문서 ${ord}`, ord });
    setActiveId(id);
  }
  function deleteDoc(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = docsMapRef.current;
    if (!map) return;
    if (docs.length <= 1) return; // 최소 1개 유지
    if (!confirm('이 문서를 삭제할까요? (실시간 공유)')) return;
    map.delete(id);
    if (id === activeId) setActiveId(docs.find((d) => d.id !== id)?.id ?? null);
  }
  function commitRename() {
    const map = docsMapRef.current;
    if (renaming && map) {
      const name = renaming.name.trim();
      const cur = map.get(renaming.id);
      if (name && cur) map.set(renaming.id, { ...cur, name });
    }
    setRenaming(null);
  }

  function exportAs(kind: 'html' | 'txt') {
    if (!editor || !activeDoc) return;
    const name = activeDoc.name;
    let content: string;
    let mime: string;
    let ext: string;
    if (kind === 'html') {
      content = `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body>${editor.getHTML()}</body></html>`;
      mime = 'text/html;charset=utf-8';
      ext = 'html';
    } else {
      content = editor.getText();
      mime = 'text/plain;charset=utf-8';
      ext = 'txt';
    }
    const url = URL.createObjectURL(new Blob(['﻿' + content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setMenu(null);
  }

  /** 이미지 파일 → 리사이즈(최대 1400px) 후 data URL로 본문 삽입 (Yjs로 함께 공유됨) */
  function insertImageFile(file: File) {
    const objUrl = URL.createObjectURL(file);
    const img = new window.Image();
    img.onload = () => {
      const MAX = 1400;
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      if (w > MAX) {
        h = Math.round((h * MAX) / w);
        w = MAX;
      }
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
      const keepAlpha = file.type === 'image/png' || file.type === 'image/gif';
      const src = keepAlpha ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', 0.85);
      editorRef.current?.chain().focus().setImage({ src }).run();
      URL.revokeObjectURL(objUrl);
    };
    img.src = objUrl;
  }

  function openLinkMenu() {
    if (!editor) return;
    setLinkUrl((editor.getAttributes('link').href as string | undefined) ?? '');
    setMenu(menu === 'link' ? null : 'link');
  }
  function applyLink() {
    if (!editor) return;
    const url = linkUrl.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      const href = /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`;
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setMenu(null);
  }

  /** 글자 크기 스테퍼 (독스식 − n +) — 기본 15px(doc-prose 본문 크기) */
  function curFontPx(): number {
    const v = editor?.getAttributes('textStyle').fontSize as string | undefined;
    return v ? parseInt(v, 10) || 15 : 15;
  }
  function applyFontPx(n: number) {
    const px = Math.max(8, Math.min(96, Math.round(n)));
    if (px === 15) editor?.chain().focus().unsetFontSize().run();
    else editor?.chain().focus().setFontSize(`${px}px`).run();
  }
  function clearFormatting() {
    editor?.chain().focus().unsetAllMarks().clearNodes().run();
  }

  /** 대소문자 무시 전체 매치 위치 */
  function getMatches(term: string): { from: number; to: number }[] {
    const out: { from: number; to: number }[] = [];
    if (!term || !editor) return out;
    const lower = term.toLowerCase();
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const text = node.text.toLowerCase();
      let i = text.indexOf(lower);
      while (i !== -1) {
        out.push({ from: pos + i, to: pos + i + term.length });
        i = text.indexOf(lower, i + term.length);
      }
    });
    return out;
  }
  function findNext() {
    if (!editor) return;
    const ms = getMatches(findText);
    setFindCount(ms.length);
    if (!ms.length) return;
    const after = editor.state.selection.to;
    const m = ms.find((x) => x.from >= after) ?? ms[0];
    editor.chain().focus().setTextSelection({ from: m.from, to: m.to }).scrollIntoView().run();
  }
  function replaceOne() {
    if (!editor || !findText) return;
    const { from, to } = editor.state.selection;
    const sel = editor.state.doc.textBetween(from, to);
    if (sel.toLowerCase() === findText.toLowerCase()) {
      editor.chain().focus().insertContentAt({ from, to }, replaceText).run();
    }
    findNext();
  }
  function replaceAll() {
    if (!editor || !findText) return;
    const ms = getMatches(findText);
    if (!ms.length) {
      setFindCount(0);
      return;
    }
    let chain = editor.chain().focus();
    for (const m of [...ms].reverse()) {
      chain = chain.insertContentAt({ from: m.from, to: m.to }, replaceText);
    }
    chain.run();
    setFindCount(0);
  }

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const btn = (active: boolean) => `doc-tool${active ? ' on' : ''}`;
  const curColor = (editor?.getAttributes('textStyle').color as string | undefined) ?? '#1c2024';
  const inTable = !!editor?.isActive('table');

  return (
    <div className="doc-editor">
      {/* 문서 탭 바 */}
      <div className="doc-tabbar">
        <div className="doc-tabs">
          {docs.map((d) => (
            <div
              key={d.id}
              className={`doc-tab${d.id === activeId ? ' active' : ''}`}
              onClick={() => setActiveId(d.id)}
              onDoubleClick={() => setRenaming({ id: d.id, name: d.name })}
              title="더블클릭하면 이름 변경"
            >
              {renaming?.id === d.id ? (
                <input
                  className="doc-tab-input"
                  autoFocus
                  value={renaming.name}
                  onChange={(e) => setRenaming({ id: d.id, name: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <Marquee className="doc-tab-name">{d.name}</Marquee>
              )}
              {docs.length > 1 && (
                <button className="doc-tab-close" onClick={(e) => deleteDoc(d.id, e)}>
                  <CloseIcon size={10} />
                </button>
              )}
            </div>
          ))}
          <button className="doc-newtab" title="새 문서" onClick={newDoc}>
            <PlusIcon size={14} />
          </button>
        </div>
        <div className="doc-tabbar-right">
          {/* 개요 (제목 목차) */}
          <button
            className={`doc-top-ico${outlineOpen ? ' on' : ''}`}
            title="문서 개요"
            onClick={() => setOutlineOpen((v) => !v)}
          >
            <I>
              <line x1="6" y1="3.5" x2="14" y2="3.5" />
              <line x1="6" y1="8" x2="14" y2="8" />
              <line x1="6" y1="12.5" x2="14" y2="12.5" />
              <circle cx="3" cy="3.5" r="1.1" fill="currentColor" stroke="none" />
              <circle cx="3" cy="8" r="1.1" fill="currentColor" stroke="none" />
              <circle cx="3" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
            </I>
          </button>
          {/* 댓글·이력 — 독스처럼 우상단 */}
          <button
            className={`doc-top-ico${commentsOpen ? ' on' : ''}`}
            title="댓글 (텍스트를 선택하고 누르면 새 댓글)"
            onClick={startComment}
          >
            <CommentSvg />
            {Object.values(comments).filter((c) => !c.resolved).length > 0 && (
              <span className="doc-cbadge">
                {Object.values(comments).filter((c) => !c.resolved).length}
              </span>
            )}
          </button>
          <button
            className="doc-top-ico"
            title="변경이력"
            onClick={() => {
              setPreviewVer(null);
              setDiffMode(false);
              setVersionsOpen(true);
            }}
          >
            <HistorySvg />
          </button>
          <div className="doc-dd-wrap">
            <button
              className="doc-top-ico"
              title="내보내기"
              onClick={() => setMenu(menu === 'export' ? null : 'export')}
            >
              <DownloadIcon size={16} />
            </button>
            {menu === 'export' && (
              <>
                <div className="doc-dd-back" onClick={() => setMenu(null)} />
                <div className="doc-dd right">
                  <button
                    className="item"
                    onClick={() => {
                      setMenu(null);
                      setDocPrinting(true);
                    }}
                  >
                    PDF / 인쇄
                  </button>
                  <button
                    className="item"
                    onClick={() => {
                      if (editor && activeDoc) void exportDocx(activeDoc.name, editor.getJSON());
                      setMenu(null);
                    }}
                  >
                    Word (.docx)
                  </button>
                  <button className="item" onClick={() => exportAs('html')}>HTML (.html)</button>
                  <button className="item" onClick={() => exportAs('txt')}>텍스트 (.txt)</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="doc-editor-bar">
        <OverflowToolbar
          className="doc-tools"
          items={[
            <button key="undo" className={btn(false)} title="실행 취소 (Ctrl+Z)" onClick={() => editor?.chain().focus().undo().run()}>
              <UndoSvg />
            </button>,
            <button key="redo" className={btn(false)} title="다시 실행 (Ctrl+Y)" onClick={() => editor?.chain().focus().redo().run()}>
              <RedoSvg />
            </button>,
            <button key="eraser" className={btn(false)} title="서식 지우기" onClick={clearFormatting}>
              <EraserSvg />
            </button>,
            <span key="s1" className="doc-tool-sep" />,
            <div key="style" className="doc-dd-wrap">
              <button
                className={`doc-tool doc-style-btn${menu === 'style' ? ' on' : ''}`}
                title="텍스트 스타일"
                onClick={() => setMenu(menu === 'style' ? null : 'style')}
              >
                {editor?.isActive('heading', { level: 1 })
                  ? '제목 1'
                  : editor?.isActive('heading', { level: 2 })
                    ? '제목 2'
                    : editor?.isActive('heading', { level: 3 })
                      ? '제목 3'
                      : '일반 텍스트'}
                <span className="doc-style-caret">▾</span>
              </button>
              {menu === 'style' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-dd">
                    <button
                      className={`item${!editor?.isActive('heading') ? ' on' : ''}`}
                      onClick={() => {
                        editor?.chain().focus().setParagraph().run();
                        setMenu(null);
                      }}
                    >
                      일반 텍스트
                    </button>
                    <button
                      className={`item${editor?.isActive('heading', { level: 1 }) ? ' on' : ''}`}
                      style={{ fontSize: 17, fontWeight: 700 }}
                      onClick={() => {
                        editor?.chain().focus().setHeading({ level: 1 }).run();
                        setMenu(null);
                      }}
                    >
                      제목 1
                    </button>
                    <button
                      className={`item${editor?.isActive('heading', { level: 2 }) ? ' on' : ''}`}
                      style={{ fontSize: 15, fontWeight: 700 }}
                      onClick={() => {
                        editor?.chain().focus().setHeading({ level: 2 }).run();
                        setMenu(null);
                      }}
                    >
                      제목 2
                    </button>
                    <button
                      className={`item${editor?.isActive('heading', { level: 3 }) ? ' on' : ''}`}
                      style={{ fontSize: 14, fontWeight: 700 }}
                      onClick={() => {
                        editor?.chain().focus().setHeading({ level: 3 }).run();
                        setMenu(null);
                      }}
                    >
                      제목 3
                    </button>
                  </div>
                </>
              )}
            </div>,
            <div key="font" className="doc-dd-wrap">
              <button
                className={`doc-tool doc-style-btn${menu === 'font' ? ' on' : ''}`}
                title="글꼴"
                onClick={() => setMenu(menu === 'font' ? null : 'font')}
              >
                {FONT_FAMILIES.find((f) => f.value && (editor?.getAttributes('textStyle').fontFamily as string | undefined) === f.value)?.label ?? '글꼴'}
                <span className="doc-style-caret">▾</span>
              </button>
              {menu === 'font' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-dd">
                    {FONT_FAMILIES.map((f) => (
                      <button
                        key={f.label}
                        className="item"
                        style={f.value ? { fontFamily: f.value } : undefined}
                        onClick={() => {
                          if (f.value) editor?.chain().focus().setFontFamily(f.value).run();
                          else editor?.chain().focus().unsetFontFamily().run();
                          setMenu(null);
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>,
            <div key="lh" className="doc-dd-wrap">
              <button
                className={`doc-tool${menu === 'lh' ? ' on' : ''}`}
                title="줄 간격"
                onClick={() => setMenu(menu === 'lh' ? null : 'lh')}
              >
                <I>
                  <path d="M3 2.5v11M3 2.5 1.5 4M3 2.5 4.5 4M3 13.5 1.5 12M3 13.5 4.5 12" />
                  <line x1="7" y1="4" x2="14.5" y2="4" />
                  <line x1="7" y1="8" x2="14.5" y2="8" />
                  <line x1="7" y1="12" x2="14.5" y2="12" />
                </I>
              </button>
              {menu === 'lh' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-dd">
                    <button
                      className="item"
                      onClick={() => {
                        editor?.chain().focus().unsetLineHeight().run();
                        setMenu(null);
                      }}
                    >
                      기본
                    </button>
                    {LINE_HEIGHTS.map((lh) => (
                      <button
                        key={lh}
                        className="item"
                        onClick={() => {
                          editor?.chain().focus().setLineHeight(lh).run();
                          setMenu(null);
                        }}
                      >
                        {lh}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>,
            <span key="s2" className="doc-tool-sep" />,
            <button key="szm" className={btn(false)} title="글자 작게" onClick={() => applyFontPx(curFontPx() - 1)}>
              −
            </button>,
            <input
              key={`szi-${curFontPx()}`}
              className="doc-size-input"
              defaultValue={curFontPx()}
              inputMode="numeric"
              title="글자 크기"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  applyFontPx(parseInt((e.target as HTMLInputElement).value, 10) || 15);
                }
              }}
              onBlur={(e) => {
                const n = parseInt(e.target.value, 10);
                if (n && n !== curFontPx()) applyFontPx(n);
              }}
            />,
            <button key="szp" className={btn(false)} title="글자 크게" onClick={() => applyFontPx(curFontPx() + 1)}>
              ＋
            </button>,
            <span key="s3" className="doc-tool-sep" />,
            <button key="b" className={btn(!!editor?.isActive('bold'))} onClick={() => editor?.chain().focus().toggleBold().run()} title="굵게">
              <b>B</b>
            </button>,
            <button key="i" className={btn(!!editor?.isActive('italic'))} onClick={() => editor?.chain().focus().toggleItalic().run()} title="기울임">
              <i>I</i>
            </button>,
            <button key="u" className={btn(!!editor?.isActive('underline'))} onClick={() => editor?.chain().focus().toggleUnderline().run()} title="밑줄">
              <u>U</u>
            </button>,
            <button key="st" className={btn(!!editor?.isActive('strike'))} onClick={() => editor?.chain().focus().toggleStrike().run()} title="취소선">
              <s>S</s>
            </button>,
            <div key="color" className="doc-dd-wrap">
              <button
                className={btn(!!editor?.getAttributes('textStyle').color)}
                title="글자색"
                onClick={() => setMenu(menu === 'color' ? null : 'color')}
              >
                <span className="doc-colorA" style={{ ['--c' as string]: curColor }}>
                  A
                </span>
              </button>
              {menu === 'color' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-dd sw">
                    <ColorGrid
                      value={editor?.getAttributes('textStyle').color as string | undefined}
                      noneLabel="기본"
                      onPick={(c) => {
                        if (c) editor?.chain().focus().setColor(c).run();
                        else editor?.chain().focus().unsetColor().run();
                        setMenu(null);
                      }}
                    />
                  </div>
                </>
              )}
            </div>,
            <div key="hl" className="doc-dd-wrap">
              <button
                className={btn(!!editor?.isActive('highlight'))}
                title="형광펜"
                onClick={() => setMenu(menu === 'hl' ? null : 'hl')}
              >
                <span className="doc-hl-ico">가</span>
              </button>
              {menu === 'hl' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-dd sw">
                    <ColorGrid
                      value={editor?.getAttributes('highlight').color as string | undefined}
                      noneLabel="형광펜 없음"
                      onPick={(c) => {
                        if (c) editor?.chain().focus().setHighlight({ color: c }).run();
                        else editor?.chain().focus().unsetHighlight().run();
                        setMenu(null);
                      }}
                    />
                  </div>
                </>
              )}
            </div>,
            <span key="s4" className="doc-tool-sep" />,
            ...(['left', 'center', 'right'] as const).map((m) => (
              <button
                key={`al-${m}`}
                className={btn(!!editor?.isActive({ textAlign: m }))}
                onClick={() => editor?.chain().focus().setTextAlign(m).run()}
                title={m === 'left' ? '왼쪽 정렬' : m === 'center' ? '가운데 정렬' : '오른쪽 정렬'}
              >
                <AlignSvg mode={m} />
              </button>
            )),
            <span key="s5" className="doc-tool-sep" />,
            <button key="ul" className={btn(!!editor?.isActive('bulletList'))} onClick={() => editor?.chain().focus().toggleBulletList().run()} title="글머리 목록">
              <UlSvg />
            </button>,
            <button key="ol" className={btn(!!editor?.isActive('orderedList'))} onClick={() => editor?.chain().focus().toggleOrderedList().run()} title="번호 목록">
              <OlSvg />
            </button>,
            <button key="task" className={btn(!!editor?.isActive('taskList'))} onClick={() => editor?.chain().focus().toggleTaskList().run()} title="체크리스트">
              <CheckSvg />
            </button>,
            <button key="quote" className={btn(!!editor?.isActive('blockquote'))} onClick={() => editor?.chain().focus().toggleBlockquote().run()} title="인용">
              ❝
            </button>,
            <button key="code" className={btn(!!editor?.isActive('codeBlock'))} onClick={() => editor?.chain().focus().toggleCodeBlock().run()} title="코드 블록">
              <CodeSvg />
            </button>,
            <button key="hr" className={btn(false)} onClick={() => editor?.chain().focus().setHorizontalRule().run()} title="구분선">
              <I><line x1="2" y1="8" x2="14" y2="8" /></I>
            </button>,
            <span key="s6" className="doc-tool-sep" />,
            <div key="link" className="doc-dd-wrap">
              <button className={btn(!!editor?.isActive('link'))} title="링크" onClick={openLinkMenu}>
                <LinkSvg />
              </button>
              {menu === 'link' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-find">
                    <input
                      autoFocus
                      placeholder="https://…"
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && applyLink()}
                    />
                    <div className="doc-find-btns">
                      <button className="doc-find-go" onClick={applyLink}>
                        적용
                      </button>
                      {!!editor?.isActive('link') && (
                        <button
                          onClick={() => {
                            editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                            setMenu(null);
                          }}
                        >
                          링크 제거
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>,
            <button key="img" className={btn(false)} title="이미지 삽입" onClick={() => fileInputRef.current?.click()}>
              <ImageSvg />
            </button>,
            <div key="table" className="doc-dd-wrap">
              <button
                className={btn(inTable)}
                title="표"
                onClick={() => setMenu(menu === 'table' ? null : 'table')}
              >
                <TableSvg />
              </button>
              {menu === 'table' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-dd">
                    {!inTable ? (
                      <button
                        className="item"
                        onClick={() => {
                          editor
                            ?.chain()
                            .focus()
                            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                            .run();
                          setMenu(null);
                        }}
                      >
                        3×3 표 삽입
                      </button>
                    ) : (
                      <>
                        <button className="item" onClick={() => editor?.chain().focus().addRowAfter().run()}>
                          행 추가
                        </button>
                        <button className="item" onClick={() => editor?.chain().focus().deleteRow().run()}>
                          행 삭제
                        </button>
                        <button className="item" onClick={() => editor?.chain().focus().addColumnAfter().run()}>
                          열 추가
                        </button>
                        <button className="item" onClick={() => editor?.chain().focus().deleteColumn().run()}>
                          열 삭제
                        </button>
                        <button className="item" onClick={() => editor?.chain().focus().toggleHeaderRow().run()}>
                          머리글 행 전환
                        </button>
                        <button
                          className="item danger"
                          onClick={() => {
                            editor?.chain().focus().deleteTable().run();
                            setMenu(null);
                          }}
                        >
                          표 삭제
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>,
            <div key="find" className="doc-dd-wrap">
              <button
                className={btn(menu === 'find')}
                title="찾기/바꾸기"
                onClick={() => {
                  setFindCount(null);
                  setMenu(menu === 'find' ? null : 'find');
                }}
              >
                <SearchSvg />
              </button>
              {menu === 'find' && (
                <>
                  <div className="doc-dd-back" onClick={() => setMenu(null)} />
                  <div className="doc-find">
                    <input
                      autoFocus
                      placeholder="찾을 내용"
                      value={findText}
                      onChange={(e) => {
                        setFindText(e.target.value);
                        setFindCount(null);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && findNext()}
                    />
                    <input
                      placeholder="바꿀 내용"
                      value={replaceText}
                      onChange={(e) => setReplaceText(e.target.value)}
                    />
                    <div className="doc-find-btns">
                      <button className="doc-find-go" onClick={findNext}>
                        다음
                      </button>
                      <button onClick={replaceOne}>바꾸기</button>
                      <button onClick={replaceAll}>모두 바꾸기</button>
                    </div>
                    {findCount !== null && (
                      <span className="doc-find-count">
                        {findCount === 0 ? '결과 없음' : `${findCount}개 일치`}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>,
          ]}
        />
        {/* 이미지 파일 입력 — 항상 렌더돼야 해서 items 밖 */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) insertImageFile(f);
            e.target.value = '';
          }}
        />
        <div className="doc-editor-right">
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className="doc-wordcount" title="글자 수(공백 제외) · 단어 수">
            {(() => {
              const t = editor?.getText() ?? '';
              const chars = t.replace(/\s/g, '').length;
              const words = t.trim() ? t.trim().split(/\s+/).length : 0;
              return `${chars.toLocaleString()}자 · ${words.toLocaleString()}단어`;
            })()}
          </span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>
      <div className="doc-editor-body">
        {/* 개요 사이드바 — 제목 기반 목차 */}
        {outlineOpen && (
          <aside className="doc-outline">
            <div className="doc-outline-head">개요</div>
            {(() => {
              const heads: { level: number; text: string; pos: number }[] = [];
              editor?.state.doc.descendants((node, pos) => {
                if (node.type.name === 'heading')
                  heads.push({ level: node.attrs.level as number, text: node.textContent, pos });
              });
              if (!heads.length)
                return <div className="doc-outline-empty">제목 1·2·3을 추가하면 목차가 생겨요</div>;
              return heads.map((h, i) => (
                <button
                  key={i}
                  className={`doc-outline-item lv${h.level}`}
                  onClick={() =>
                    editor?.chain().focus().setTextSelection(h.pos + 1).scrollIntoView().run()
                  }
                >
                  {h.text || '(빈 제목)'}
                </button>
              ));
            })()}
          </aside>
        )}
        <div className="doc-editor-scroll">
          <div className="doc-page">
            <EditorContent editor={editor} />
          </div>
        </div>

        {/* 댓글 패널 */}
        {commentsOpen && (
          <aside className="doc-comments-panel">
            <div className="doc-cpanel-head">
              <b>댓글</b>
              <button className="doc-cpanel-close" onClick={() => setCommentsOpen(false)}>
                <CloseIcon size={12} />
              </button>
            </div>
            <div className="doc-cpanel-list">
              {pendingNew && (
                <div className="doc-cthread new">
                  <div className="doc-cthread-anchor">
                    “{editor?.state.doc.textBetween(pendingNew.from, pendingNew.to).slice(0, 40)}”
                  </div>
                  <textarea
                    autoFocus
                    placeholder="댓글 입력…"
                    value={commentDraft}
                    onChange={(e) => setCommentDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        addComment();
                      }
                    }}
                  />
                  <div className="doc-cthread-btns">
                    <button className="primary" onClick={addComment}>등록</button>
                    <button onClick={() => setPendingNew(null)}>취소</button>
                  </div>
                </div>
              )}
              {Object.entries(comments)
                .filter(([, c]) => !c.resolved)
                .sort((a, b) => a[1].ts - b[1].ts)
                .map(([id, c]) => (
                  <div
                    key={id}
                    className={`doc-cthread${activeCommentId === id ? ' active' : ''}`}
                    onClick={() => jumpToComment(id)}
                  >
                    {c.anchor && <div className="doc-cthread-anchor">“{c.anchor}”</div>}
                    <div className="doc-cthread-meta">
                      <b>{c.author}</b> <span>{fmtTs(c.ts)}</span>
                    </div>
                    <div className="doc-cthread-text">{c.text}</div>
                    {c.replies.map((r, i) => (
                      <div key={i} className="doc-creply">
                        <div className="doc-cthread-meta">
                          <b>{r.author}</b> <span>{fmtTs(r.ts)}</span>
                        </div>
                        <div className="doc-cthread-text">{r.text}</div>
                      </div>
                    ))}
                    <div className="doc-creply-row" onClick={(e) => e.stopPropagation()}>
                      <input
                        placeholder="답글…"
                        value={replyDrafts[id] ?? ''}
                        onChange={(e) => setReplyDrafts((d) => ({ ...d, [id]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && addReply(id)}
                      />
                      <button onClick={() => addReply(id)}>등록</button>
                    </div>
                    <div className="doc-cthread-btns" onClick={(e) => e.stopPropagation()}>
                      <button className="primary" onClick={() => resolveComment(id)}><CheckMarkIcon size={12} /> 해결</button>
                      <button className="danger" onClick={() => deleteComment(id)}>삭제</button>
                    </div>
                  </div>
                ))}
              {Object.values(comments).filter((c) => c.resolved).length > 0 && (
                <details className="doc-cresolved">
                  <summary>
                    해결됨 {Object.values(comments).filter((c) => c.resolved).length}개
                  </summary>
                  {Object.entries(comments)
                    .filter(([, c]) => c.resolved)
                    .sort((a, b) => b[1].ts - a[1].ts)
                    .map(([id, c]) => (
                      <div key={id} className="doc-cthread resolved">
                        {c.anchor && <div className="doc-cthread-anchor">“{c.anchor}”</div>}
                        <div className="doc-cthread-meta">
                          <b>{c.author}</b> <span>{fmtTs(c.ts)}</span>
                        </div>
                        <div className="doc-cthread-text">{c.text}</div>
                        <div className="doc-cthread-btns">
                          <button className="danger" onClick={() => deleteComment(id)}>삭제</button>
                        </div>
                      </div>
                    ))}
                </details>
              )}
              {!pendingNew && Object.keys(comments).length === 0 && (
                <div className="doc-cpanel-empty">
                  본문에서 텍스트를 선택하고 [댓글]을 누르면 여기에 스레드가 생겨요
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {/* 선택된 댓글 본문 강조 */}
      {activeCommentId && (
        <style>{`.doc-prose [data-comment-id="${activeCommentId}"]{background:rgba(245,165,36,0.45);}`}</style>
      )}

      {/* 인쇄(PDF) — 문서는 세로 A4 */}
      {docPrinting && <style>{`@page { size: A4 portrait; margin: 14mm; }`}</style>}

      {/* 변경이력 모달 */}
      {versionsOpen && (
        <div className="modal-overlay" onClick={() => setVersionsOpen(false)}>
          <div className="modal-card doc-vers-card" onClick={(e) => e.stopPropagation()}>
            {!previewVer ? (
              <>
                <div className="modal-head">변경이력</div>
                <button className="doc-vers-save" onClick={() => pushVersion('수동')}>
                  ＋ 현재 상태를 버전으로 저장
                </button>
                <div className="doc-vers-list">
                  {[...versions].reverse().map((v) => (
                    <button
                      key={v.id}
                      className="doc-vers-row"
                      onClick={() => {
                        setDiffMode(false);
                        setPreviewVer(v);
                      }}
                    >
                      <b>{fmtTs(v.ts)}</b>
                      <span className="doc-vers-author">{v.author}</span>
                      <span className={`doc-vers-label${v.label === '자동' ? ' auto' : ''}`}>
                        {v.label}
                      </span>
                    </button>
                  ))}
                  {versions.length === 0 && (
                    <div className="doc-cpanel-empty">
                      아직 저장된 버전이 없어요. 5분마다 자동 저장되고, 위 버튼으로 직접 저장할 수도 있어요.
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="modal-head doc-vers-phead">
                  <button className="doc-vers-back" onClick={() => setPreviewVer(null)}>←</button>
                  {fmtTs(previewVer.ts)} · {previewVer.author}
                </div>
                <div className="doc-vers-pbtns">
                  <button className={diffMode ? 'on' : ''} onClick={() => setDiffMode((v) => !v)}>
                    현재와 비교
                  </button>
                  <button className="primary" onClick={() => restoreVersion(previewVer)}>
                    이 버전으로 복원
                  </button>
                </div>
                <div className="doc-vers-preview">
                  {diffMode ? (
                    (() => {
                      const d = diffAgainstCurrent(previewVer);
                      if (!d) return <div className="doc-cpanel-empty">문서가 너무 커서 비교를 건너뛰어요</div>;
                      if (d.every((x) => x.t === 'same')) return <div className="doc-cpanel-empty">텍스트 차이가 없어요</div>;
                      return (
                        <div className="doc-vers-diff">
                          {d.map((x, i) => (
                            <span key={i} className={x.t === 'same' ? '' : x.t === 'add' ? 'add' : 'del'}>
                              {x.s}{' '}
                            </span>
                          ))}
                        </div>
                      );
                    })()
                  ) : (
                    <div className="doc-prose" dangerouslySetInnerHTML={{ __html: previewVer.html }} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
