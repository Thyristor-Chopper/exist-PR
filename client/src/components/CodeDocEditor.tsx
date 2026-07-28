import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { php } from '@codemirror/lang-php';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sql } from '@codemirror/lang-sql';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { csharp, kotlin } from '@codemirror/legacy-modes/mode/clike';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { oneDark } from '@codemirror/theme-one-dark';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';
import { useAuthStore } from '../store';
import Marquee from './Marquee';
import { api } from '../api';
import {
  PlusIcon,
  CloseIcon,
  CodeIcon,
  PlayIcon,
  DownloadIcon,
  DocIcon,
  SheetIcon,
  SlideIcon,
  PenIcon,
  ChevronIcon,
  ChevronRightIcon,
} from './Icons';

const CURSOR_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

type OutLine = { type: 'log' | 'error' | 'warn' | 'info'; text: string };

// Pyodide (브라우저 Python) 지연 로드 — 한 번만
let pyodidePromise: Promise<unknown> | null = null;
function loadPyodide(): Promise<unknown> {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
    s.onload = async () => {
      try {
        const py = await (window as unknown as { loadPyodide: () => Promise<unknown> }).loadPyodide();
        resolve(py);
      } catch (e) {
        reject(e);
      }
    };
    s.onerror = () => reject(new Error('Pyodide 로드 실패 (인터넷 연결 필요)'));
    document.head.appendChild(s);
  });
  return pyodidePromise;
}

function runtimeForExt(ext: string): 'js' | 'py' | 'sql' | 'server' | null {
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return 'js';
  if (ext === 'py') return 'py';
  if (ext === 'sql') return 'sql';
  if (['c', 'cc', 'cpp', 'cxx', 'java', 'go', 'rs', 'php', 'rb', 'ts', 'tsx'].includes(ext))
    return 'server';
  return null;
}

function serverLang(ext: string): string {
  if (ext === 'c') return 'c';
  if (['cc', 'cpp', 'cxx'].includes(ext)) return 'cpp';
  if (ext === 'rs') return 'rust';
  if (['ts', 'tsx'].includes(ext)) return 'ts';
  return ext; // java, go, php, rb
}

interface FileMeta {
  id: string;
  name: string; // 전체 경로 (예: "src/app.js" 또는 폴더 "src")
  ord: number;
  dir?: boolean;
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function langForName(name: string): { ext: Extension; label: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'py':
      return { ext: python(), label: 'Python' };
    case 'ts':
    case 'tsx':
      return { ext: javascript({ typescript: true, jsx: ext === 'tsx' }), label: 'TypeScript' };
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return { ext: javascript({ jsx: ext.includes('x') }), label: 'JavaScript' };
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hpp':
      return { ext: cpp(), label: 'C/C++' };
    case 'java':
      return { ext: java(), label: 'Java' };
    case 'cs':
      return { ext: StreamLanguage.define(csharp), label: 'C#' };
    case 'kt':
    case 'kts':
      return { ext: StreamLanguage.define(kotlin), label: 'Kotlin' };
    case 'go':
      return { ext: go(), label: 'Go' };
    case 'rs':
      return { ext: rust(), label: 'Rust' };
    case 'rb':
      return { ext: StreamLanguage.define(ruby), label: 'Ruby' };
    case 'php':
      return { ext: php(), label: 'PHP' };
    case 'swift':
      return { ext: StreamLanguage.define(swift), label: 'Swift' };
    case 'sh':
    case 'bash':
    case 'zsh':
      return { ext: StreamLanguage.define(shell), label: 'Shell' };
    case 'html':
    case 'htm':
      return { ext: html(), label: 'HTML' };
    case 'css':
    case 'scss':
      return { ext: css(), label: 'CSS' };
    case 'sql':
      return { ext: sql(), label: 'SQL' };
    case 'json':
      return { ext: json(), label: 'JSON' };
    case 'md':
    case 'markdown':
      return { ext: markdown(), label: 'Markdown' };
    case 'xml':
    case 'svg':
      return { ext: xml(), label: 'XML' };
    case 'yaml':
    case 'yml':
      return { ext: yaml(), label: 'YAML' };
    default:
      return { ext: [], label: '일반 텍스트' };
  }
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    py: '🐍',
    ts: '🇹', tsx: '🇹',
    js: '🟨', jsx: '🟨', mjs: '🟨', cjs: '🟨',
    c: '🔵', cc: '🔵', cpp: '🔵', cxx: '🔵', h: '🔵', hpp: '🔵',
    java: '☕', cs: '🟣', kt: '🟪', kts: '🟪',
    go: '🐹', rs: '🦀', rb: '💎', php: '🐘', swift: '🕊️',
    sh: '🖥️', bash: '🖥️', zsh: '🖥️',
    html: '🌐', htm: '🌐', css: '🎨', scss: '🎨',
    sql: '🗃️', json: '⚙️', md: '📝', markdown: '📝',
    xml: '📰', svg: '📰', yaml: '🔧', yml: '🔧',
  };
  return map[ext] ?? '📄';
}

/** VS Code식 코드 공동편집 — 파일 탐색기 + 멀티파일 탭, Yjs 실시간 */
/** 탐색기(공동편집)에서 같은 폴더에 있는 이웃 문서 — 사이드바 하단에 표시해 바로 전환 */
export interface SiblingDoc {
  id: number;
  name: string;
  type: string;
}

export default function CodeDocEditor({
  roomId,
  siblings,
  currentSibId,
  onOpenSibling,
  active = true,
}: {
  roomId: string;
  siblings?: SiblingDoc[];
  currentSibId?: number;
  onOpenSibling?: (id: number) => void;
  /** false면 숨김 상태 — awareness를 내려서 프레즌스에서 빠짐 (연결은 유지) */
  active?: boolean;
}) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const filesMapRef = useRef<Y.Map<{ name: string; ord: number; dir?: boolean }> | null>(null);
  const dragIdRef = useRef<string | null>(null);

  const [conn, setConn] = useState<{ ydoc: Y.Doc; provider: WebsocketProvider } | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // 숨김(비활성) 동안 awareness를 내림 — 프레즌스·N명 참여에서 빠짐 (연결은 유지)
  // 주의: setLocalState(null) 후에는 setLocalStateField가 no-op이라 복귀는 setLocalState로 해야 함
  useEffect(() => {
    const p = conn?.provider;
    if (!p) return;
    if (active) {
      const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
      const cur = p.awareness.getLocalState();
      p.awareness.setLocalState({
        ...(cur ?? {}),
        user: { name: user?.name || user?.username || '익명', color, colorLight: color + '33' },
      });
    } else {
      p.awareness.setLocalState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, conn]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [creating, setCreating] = useState<{ dir: string } | null>(null);
  const [draftName, setDraftName] = useState('');
  const creatingRef = useRef(false); // Enter/blur 중복 생성 방지
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [currentDir, setCurrentDir] = useState(''); // 새 파일/폴더가 만들어질 위치
  // 코드 에디터 테마는 앱 전체 다크모드(html.dark)를 따라감
  const [appDark, setAppDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setAppDark(document.documentElement.classList.contains('dark')),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const [output, setOutput] = useState<OutLine[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [running, setRunning] = useState(false);
  const [showGit, setShowGit] = useState(false);
  // 모바일 — 탐색기가 오버레이 서랍이라 열림 상태 관리 (데스크톱은 상시 표시, CSS로 무시)
  const [sideOpen, setSideOpen] = useState(false);
  const [git, setGit] = useState({
    remote: localStorage.getItem('exist:git-remote') ?? '',
    token: '',
    branch: 'main',
    message: 'exist에서 업로드',
  });

  // ── 연결 + 파일 목록 ──
  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const filesMap = ydoc.getMap<{ name: string; ord: number; dir?: boolean }>('files');
    filesMapRef.current = filesMap;
    setConn({ ydoc, provider });
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', {
      name: user?.name || user?.username || '익명',
      color,
      colorLight: color + '33',
    });

    const syncFiles = () => {
      const list: FileMeta[] = [];
      filesMap.forEach((v, id) => list.push({ id, name: v.name, ord: v.ord, dir: v.dir }));
      list.sort((a, b) => a.ord - b.ord);
      setFiles(list);
      const firstFile = list.find((f) => !f.dir);
      setActiveId((cur) => (cur && list.some((f) => f.id === cur && !f.dir) ? cur : firstFile?.id ?? null));
      setOpenTabs((tabs) => {
        const valid = tabs.filter((t) => list.some((f) => f.id === t && !f.dir));
        if (valid.length === 0 && firstFile) return [firstFile.id];
        return valid;
      });
    };
    filesMap.observe(syncFiles);
    syncFiles();

    // 빈 프로젝트면 기본 파일 생성 (동기화 후, 한 번만)
    const ensureDefault = () => {
      if (filesMap.size === 0) {
        filesMap.set(crypto.randomUUID(), { name: 'main.js', ord: 1 });
      }
    };
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) ensureDefault();
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);

    return () => {
      filesMap.unobserve(syncFiles);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      filesMapRef.current = null;
      setConn(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  const activeFile = files.find((f) => f.id === activeId) ?? null;

  // ── 에디터 (활성 파일 바뀔 때 재생성) ──
  useEffect(() => {
    if (!conn || !activeId || !hostRef.current || !activeFile) return;
    const ytext = conn.ydoc.getText(`file:${activeId}`);
    const { ext } = langForName(activeFile.name);

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        ext,
        ...(appDark ? [oneDark] : []),
        yCollab(ytext, conn.provider.awareness),
        EditorView.updateListener.of((u) => {
          if (u.selectionSet || u.docChanged) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            setCursor({ line: line.number, col: head - line.from + 1 });
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '13.5px' },
          '.cm-scroller': {
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Consolas, 'NanumSquareNeo', 'Malgun Gothic', monospace",
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, activeId, activeFile?.name, appDark]);

  function runActive() {
    if (!activeFile || !conn || running) return;
    const code = conn.ydoc.getText(`file:${activeId}`).toString();
    const ext = activeFile.name.split('.').pop()?.toLowerCase() ?? '';
    const rt = runtimeForExt(ext);
    setShowOutput(true);
    if (rt === 'js') runJS(code);
    else if (rt === 'py') runPython(code);
    else if (rt === 'sql') runSql(code);
    else if (rt === 'server') runServer(ext);
    else {
      setOutput([{ type: 'error', text: `.${ext} 파일은 실행을 지원하지 않아요` }]);
    }
  }

  async function runServer(ext: string) {
    if (!conn || !activeFile) return;
    setRunning(true);
    setOutput([{ type: 'info', text: '▶ 서버에서 실행 중…' }]);
    const projFiles = files
      .filter((f) => !f.dir)
      .map((f) => ({ path: f.name, content: conn.ydoc.getText(`file:${f.id}`).toString() }));
    try {
      const r = await api<{ lines: OutLine[] }>('/api/run/exec', {
        method: 'POST',
        body: { lang: serverLang(ext), entry: activeFile.name, files: projFiles },
      });
      setOutput(r.lines.length ? r.lines : [{ type: 'info', text: '(출력 없음)' }]);
    } catch (e) {
      setOutput([{ type: 'error', text: '서버 실행 실패: ' + String((e as Error)?.message ?? e) }]);
    } finally {
      setRunning(false);
    }
  }

  async function pushGit() {
    if (!conn) return;
    localStorage.setItem('exist:git-remote', git.remote);
    setShowGit(false);
    setShowOutput(true);
    setRunning(true);
    setOutput([{ type: 'info', text: '▶ git push 중… (잠시 걸릴 수 있어요)' }]);
    const projFiles = files
      .filter((f) => !f.dir)
      .map((f) => ({ path: f.name, content: conn.ydoc.getText(`file:${f.id}`).toString() }));
    try {
      const r = await api<{ lines: OutLine[] }>('/api/run/git', {
        method: 'POST',
        body: { ...git, files: projFiles },
      });
      setOutput(r.lines);
    } catch (e) {
      setOutput([{ type: 'error', text: 'git 실패: ' + String((e as Error)?.message ?? e) }]);
    } finally {
      setRunning(false);
    }
  }

  async function runSql(sql: string) {
    setRunning(true);
    setOutput([{ type: 'info', text: '▶ SQL 실행 중…' }]);
    try {
      const r = await api<{ lines: OutLine[] }>('/api/run/sql', { method: 'POST', body: { sql } });
      setOutput(r.lines);
    } catch (e) {
      setOutput([{ type: 'error', text: 'SQL 실행 실패: ' + String((e as Error)?.message ?? e) }]);
    } finally {
      setRunning(false);
    }
  }

  function runJS(code: string) {
    setRunning(true);
    setOutput([{ type: 'info', text: '▶ JavaScript 실행 중…' }]);
    const workerSrc = `
      self.onmessage = (e) => {
        const fmt = (a) => { try { return (typeof a === 'object' && a !== null) ? JSON.stringify(a) : String(a); } catch { return String(a); } };
        const send = (type) => (...args) => self.postMessage({ line: { type, text: args.map(fmt).join(' ') } });
        const console = { log: send('log'), info: send('log'), debug: send('log'), warn: send('warn'), error: send('error') };
        try {
          const fn = new Function('console', e.data);
          const r = fn(console);
          if (r !== undefined) self.postMessage({ line: { type: 'log', text: fmt(r) } });
          self.postMessage({ done: true });
        } catch (err) {
          self.postMessage({ line: { type: 'error', text: (err && err.stack) ? String(err.stack) : String(err) } });
          self.postMessage({ done: true });
        }
      };`;
    const url = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));
    const worker = new Worker(url);
    const lines: OutLine[] = [];
    const finish = (extra?: OutLine) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      setRunning(false);
      setOutput(extra ? [...lines, extra] : [...lines]);
    };
    const timer = setTimeout(
      () => finish({ type: 'error', text: '⏱ 시간 초과(3초) — 실행을 중단했어요' }),
      3000,
    );
    worker.onmessage = (e: MessageEvent) => {
      const d = e.data as { line?: OutLine; done?: boolean };
      if (d.line) {
        lines.push(d.line);
        setOutput([...lines]);
      }
      if (d.done) {
        clearTimeout(timer);
        finish({ type: 'info', text: '✓ 완료' });
      }
    };
    worker.postMessage(code);
  }

  async function runPython(code: string) {
    setRunning(true);
    setOutput([{ type: 'info', text: '🐍 Python 준비 중… (처음 실행은 몇 초 걸려요)' }]);
    try {
      const py = (await loadPyodide()) as {
        setStdout: (o: { batched: (s: string) => void }) => void;
        setStderr: (o: { batched: (s: string) => void }) => void;
        runPythonAsync: (c: string) => Promise<unknown>;
      };
      const lines: OutLine[] = [{ type: 'info', text: '▶ Python 실행 중…' }];
      setOutput([...lines]);
      py.setStdout({
        batched: (s: string) => {
          lines.push({ type: 'log', text: s });
          setOutput([...lines]);
        },
      });
      py.setStderr({
        batched: (s: string) => {
          lines.push({ type: 'error', text: s });
          setOutput([...lines]);
        },
      });
      await py.runPythonAsync(code);
      lines.push({ type: 'info', text: '✓ 완료' });
      setOutput([...lines]);
    } catch (e) {
      setOutput((l) => [...l, { type: 'error', text: String((e as Error)?.message ?? e) }]);
    } finally {
      setRunning(false);
    }
  }

  function openFile(id: string) {
    setActiveId(id);
    setOpenTabs((tabs) => (tabs.includes(id) ? tabs : [...tabs, id]));
    setSideOpen(false); // 모바일 서랍: 파일 고르면 닫고 에디터 보여주기
  }
  function closeTab(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setOpenTabs((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (id === activeId) setActiveId(next[next.length - 1] ?? null);
      return next;
    });
  }
  function createEntry() {
    const map = filesMapRef.current;
    const raw = draftName.trim();
    const c = creating;
    setCreating(null);
    setDraftName('');
    if (!map || !raw || !c || !creatingRef.current) return;
    creatingRef.current = false; // 두 번째 호출(blur) 무시
    // 확장자(.xxx)가 있으면 파일, 없으면 폴더
    const isFile = /\.[^./\\]+$/.test(raw);
    const fullName = c.dir ? `${c.dir}/${raw}` : raw;
    if (files.some((f) => f.name === fullName)) return; // 중복 방지
    const ord = files.reduce((m, f) => Math.max(m, f.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { name: fullName, ord, dir: !isFile });
    if (!isFile) {
      setCollapsed((s) => {
        const n = new Set(s);
        n.delete(fullName);
        return n;
      });
      setCurrentDir(fullName);
    } else {
      openFile(id);
    }
  }
  function startCreating(dir: string) {
    creatingRef.current = true;
    setCreating({ dir });
    setDraftName('');
    setCollapsed((s) => {
      const n = new Set(s);
      n.delete(dir);
      return n;
    });
  }
  function moveEntry(id: string, targetDir: string) {
    const map = filesMapRef.current;
    if (!map) return;
    const entry = files.find((f) => f.id === id);
    if (!entry) return;
    const oldName = entry.name;
    const base = basename(oldName);
    const newName = targetDir ? `${targetDir}/${base}` : base;
    if (newName === oldName) return;
    // 폴더를 자기 자신/하위로 이동 금지
    if (entry.dir && (targetDir === oldName || targetDir.startsWith(oldName + '/'))) return;
    if (files.some((f) => f.id !== id && f.name === newName)) return; // 충돌
    if (entry.dir) {
      files.forEach((f) => {
        if (f.id === id || f.name.startsWith(oldName + '/')) {
          const np = newName + f.name.slice(oldName.length);
          const cur = map.get(f.id);
          if (cur) map.set(f.id, { ...cur, name: np });
        }
      });
    } else {
      const cur = map.get(id);
      if (cur) map.set(id, { ...cur, name: newName });
    }
  }
  function toggleFolder(path: string) {
    setCurrentDir(path);
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }
  function deleteFile(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = filesMapRef.current;
    if (!map) return;
    if (!confirm('이 파일을 삭제할까요? (실시간 공유 파일)')) return;
    map.delete(id);
    conn?.ydoc.getText(`file:${id}`).delete(0, conn.ydoc.getText(`file:${id}`).length);
    setOpenTabs((tabs) => tabs.filter((t) => t !== id));
    if (id === activeId) {
      const remaining = files.filter((f) => f.id !== id && !f.dir);
      setActiveId(remaining[0]?.id ?? null);
    }
  }
  function deleteFolder(path: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = filesMapRef.current;
    if (!map) return;
    if (!confirm(`폴더 "${basename(path)}" 와 그 안의 모든 항목을 삭제할까요?`)) return;
    const victims = files.filter((f) => f.name === path || f.name.startsWith(path + '/'));
    victims.forEach((f) => {
      if (!f.dir) conn?.ydoc.getText(`file:${f.id}`).delete(0, conn.ydoc.getText(`file:${f.id}`).length);
      map.delete(f.id);
    });
    const ids = new Set(victims.map((v) => v.id));
    setOpenTabs((tabs) => tabs.filter((t) => !ids.has(t)));
    if (activeId && ids.has(activeId)) {
      setActiveId(files.find((f) => !f.dir && !ids.has(f.id))?.id ?? null);
    }
  }

  async function exportZip() {
    if (!conn) return;
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    let count = 0;
    files
      .filter((f) => !f.dir)
      .forEach((f) => {
        zip.file(f.name, conn.ydoc.getText(`file:${f.id}`).toString());
        count++;
      });
    // 빈 폴더도 포함
    files.filter((f) => f.dir).forEach((f) => zip.folder(f.name));
    if (count === 0) zip.file('README.txt', 'exist 코드 프로젝트');
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${roomId.replace(/^code-/, 'project_')}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusLabel =
    status === 'connected' ? '연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const langLabel = activeFile ? langForName(activeFile.name).label : '';

  const canRun = !!activeFile && runtimeForExt(activeFile.name.split('.').pop()?.toLowerCase() ?? '') !== null;

  // 폴더 경로(명시적 + 파일 경로에서 유추한 조상)
  const folderPaths = new Set<string>();
  files.forEach((f) => {
    if (f.dir) folderPaths.add(f.name);
    let d = dirname(f.name);
    while (d) {
      folderPaths.add(d);
      d = dirname(d);
    }
  });

  const draftIsFile = /\.[^./\\]+$/.test(draftName.trim());
  const createInput = (dir: string, depth: number) => (
    <div key={`new:${dir}`} className="vsc-file creating" style={{ paddingLeft: 10 + depth * 14 }}>
      <span className="vsc-file-ic">{draftName.trim() && !draftIsFile ? '📁' : '📄'}</span>
      <input
        className="vsc-file-input"
        autoFocus
        placeholder="이름.js = 파일 / 이름 = 폴더"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={createEntry}
        onKeyDown={(e) => {
          if (e.key === 'Enter') createEntry();
          else if (e.key === 'Escape') {
            creatingRef.current = false;
            setCreating(null);
            setDraftName('');
          }
        }}
      />
    </div>
  );

  const renderTree = (parent: string, depth: number): React.ReactNode[] => {
    const subFolders = [...folderPaths].filter((p) => dirname(p) === parent).sort();
    const subFiles = files
      .filter((f) => !f.dir && dirname(f.name) === parent)
      .sort((a, b) => a.ord - b.ord);
    const out: React.ReactNode[] = [];
    for (const fp of subFolders) {
      const open = !collapsed.has(fp);
      const folderEntry = files.find((f) => f.dir && f.name === fp);
      out.push(
        <div
          key={`d:${fp}`}
          className={`vsc-file vsc-folder${currentDir === fp ? ' cur' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => toggleFolder(fp)}
          title={fp}
          draggable={!!folderEntry}
          onDragStart={(e) => {
            if (folderEntry) dragIdRef.current = folderEntry.id;
            e.stopPropagation();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).classList.add('drop-target');
          }}
          onDragLeave={(e) => (e.currentTarget as HTMLElement).classList.remove('drop-target')}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).classList.remove('drop-target');
            if (dragIdRef.current) moveEntry(dragIdRef.current, fp);
            dragIdRef.current = null;
          }}
        >
          <span className="vsc-chev">{open ? <ChevronIcon size={10} /> : <ChevronRightIcon size={10} />}</span>
          <span className="vsc-file-ic">📁</span>
          <Marquee className="vsc-file-name">{basename(fp)}</Marquee>
          <button className="vsc-file-del" title="폴더 삭제" onClick={(e) => deleteFolder(fp, e)}>
            <CloseIcon size={11} />
          </button>
        </div>,
      );
      if (open) {
        out.push(...renderTree(fp, depth + 1));
        if (creating && creating.dir === fp) out.push(createInput(fp, depth + 1));
      }
    }
    for (const f of subFiles) {
      out.push(
        <div
          key={f.id}
          className={`vsc-file${f.id === activeId ? ' active' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => openFile(f.id)}
          title={f.name}
          draggable
          onDragStart={(e) => {
            dragIdRef.current = f.id;
            e.stopPropagation();
          }}
        >
          <span className="vsc-file-ic">{fileIcon(f.name)}</span>
          <Marquee className="vsc-file-name">{basename(f.name)}</Marquee>
          <button className="vsc-file-del" title="삭제" onClick={(e) => deleteFile(f.id, e)}>
            <CloseIcon size={11} />
          </button>
        </div>,
      );
    }
    return out;
  };

  return (
    <div className={`vsc ${appDark ? 'dark' : 'light'}`}>
      {/* 파일 탐색기 — 모바일에선 ☰로 여닫는 오버레이 서랍 */}
      {sideOpen && <div className="vsc-side-scrim" onClick={() => setSideOpen(false)} />}
      <div className={`vsc-sidebar${sideOpen ? ' m-open' : ''}`}>
        <div className="vsc-sidebar-head">
          <span>탐색기{currentDir && <span className="vsc-curdir"> · {basename(currentDir)}/</span>}</span>
          <span className="vsc-head-btns">
            <button
              className="vsc-newfile"
              title="새로 만들기 (확장자 있으면 파일, 없으면 폴더)"
              onClick={() => startCreating(currentDir)}
            >
              <PlusIcon size={15} />
            </button>
            {currentDir && (
              <button className="vsc-newfile" title="최상위로" onClick={() => setCurrentDir('')}>
                ⤴
              </button>
            )}
          </span>
        </div>
        <div
          className="vsc-files"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (dragIdRef.current) moveEntry(dragIdRef.current, '');
            dragIdRef.current = null;
          }}
        >
          {renderTree('', 0)}
          {creating && creating.dir === '' && createInput('', 0)}
          {files.length === 0 && !creating && (
            <div className="vsc-empty">파일/폴더를 만들어보세요</div>
          )}
        </div>

        {/* 공동편집 현재 폴더의 이웃 문서 — 뒤로 안 나가고 바로 전환 */}
        {siblings && siblings.length > 1 && (
          <div className="vsc-siblings">
            <div className="vsc-sidebar-sub">같은 폴더</div>
            {siblings.map((s) => (
              <button
                key={s.id}
                className={`vsc-sib${s.id === currentSibId ? ' on' : ''}`}
                title={s.name}
                onClick={() => s.id !== currentSibId && onOpenSibling?.(s.id)}
              >
                {s.type === 'doc' ? (
                  <DocIcon size={12} />
                ) : s.type === 'sheet' ? (
                  <SheetIcon size={12} />
                ) : s.type === 'slide' ? (
                  <SlideIcon size={12} />
                ) : s.type === 'canvas' ? (
                  <PenIcon size={12} />
                ) : (
                  <CodeIcon size={12} />
                )}
                <span className="vsc-sib-name">{s.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 에디터 영역 */}
      <div className="vsc-main">
        <div className="vsc-tabbar">
          <button
            className="vsc-side-toggle"
            onClick={() => setSideOpen((v) => !v)}
            title="파일 탐색기"
          >
            ☰
          </button>
          <div className="vsc-tabs">
            {openTabs.map((id) => {
              const f = files.find((x) => x.id === id);
              if (!f) return null;
              return (
                <div
                  key={id}
                  className={`vsc-tab${id === activeId ? ' active' : ''}`}
                  onClick={() => setActiveId(id)}
                >
                  <span className="vsc-tab-ic">{fileIcon(f.name)}</span>
                  {f.name}
                  <button className="vsc-tab-close" onClick={(e) => closeTab(id, e)}>
                    <CloseIcon size={10} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="vsc-actions">
            <button
              className="vsc-run"
              onClick={runActive}
              disabled={!canRun || running}
              title={canRun ? '실행' : '실행 미지원 파일'}
            >
              <PlayIcon size={13} /> {running ? '실행 중…' : '실행'}
            </button>
            <div className="vsc-git-wrap">
              <button className="vsc-act" onClick={() => setShowGit((v) => !v)} title="Git 업로드(push)">
                ⬆ git
              </button>
              {showGit && (
                <>
                  <div className="vsc-git-back" onClick={() => setShowGit(false)} />
                  <div className="vsc-git-menu" onClick={(e) => e.stopPropagation()}>
                    <div className="vsc-git-title">GitHub 업로드 (push)</div>
                    <input
                      placeholder="원격 URL (https://github.com/유저/레포.git)"
                      value={git.remote}
                      onChange={(e) => setGit({ ...git, remote: e.target.value })}
                    />
                    <input
                      type="password"
                      placeholder="액세스 토큰 (PAT)"
                      value={git.token}
                      onChange={(e) => setGit({ ...git, token: e.target.value })}
                    />
                    <div className="vsc-git-row">
                      <input
                        placeholder="브랜치"
                        value={git.branch}
                        onChange={(e) => setGit({ ...git, branch: e.target.value })}
                      />
                      <input
                        placeholder="커밋 메시지"
                        value={git.message}
                        onChange={(e) => setGit({ ...git, message: e.target.value })}
                      />
                    </div>
                    <button
                      className="vsc-git-push"
                      onClick={pushGit}
                      disabled={!git.remote || !git.token || running}
                    >
                      ⬆ 푸시 (강제)
                    </button>
                    <div className="vsc-git-hint">토큰은 저장되지 않고 푸시에만 사용돼요</div>
                  </div>
                </>
              )}
            </div>
            <button
              className="vsc-act"
              onClick={exportZip}
              title="전체 프로젝트 zip 내보내기"
            >
              <DownloadIcon size={16} />
            </button>
          </div>
        </div>
        {activeFile ? (
          <div className="vsc-editor" ref={hostRef} />
        ) : (
          <div className="vsc-welcome">
            <CodeIcon size={40} />
            <p>왼쪽에서 파일을 선택하거나 새로 만들어 시작하세요</p>
          </div>
        )}
        {showOutput && (
          <div className="vsc-output">
            <div className="vsc-output-head">
              <span>출력</span>
              <div className="vsc-output-tools">
                <button onClick={() => setOutput([])} title="지우기">
                  지우기
                </button>
                <button onClick={() => setShowOutput(false)} title="닫기">
                  <CloseIcon size={12} />
                </button>
              </div>
            </div>
            <div className="vsc-output-body">
              {output.length === 0 ? (
                <div className="vsc-out-line info">실행 결과가 여기 표시돼요</div>
              ) : (
                output.map((o, i) => (
                  <div key={i} className={`vsc-out-line ${o.type}`}>
                    {o.text}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
        <div className="vsc-statusbar">
          <div className="vsc-status-left">
            <span className={`vsc-conn ${status}`}>
              <i /> {statusLabel}
            </span>
            <span>{peers}명 참여</span>
          </div>
          <div className="vsc-status-right">
            {activeFile && (
              <>
                <span>
                  줄 {cursor.line}, 열 {cursor.col}
                </span>
                <span>공백: 2</span>
                <span>UTF-8</span>
                <span>{langLabel}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
