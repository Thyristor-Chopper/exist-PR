import { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';

/*
 * Excalidraw 동시편집 캔버스 (MIT, 워터마크/라이선스 없음).
 * 협업은 기존 Yjs 백엔드(/yjs)를 재사용한다 — 엘리먼트를 Y.Map<id, element>에
 * 담고, Excalidraw의 element.version(높을수록 최신)으로 충돌을 해소한다.
 * 이미지 등 바이너리는 Y.Map<id, BinaryFileData>로 함께 동기화.
 * 커서/이름은 provider.awareness 로 표시.
 */

const CURSOR_COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

// Excalidraw 깊은 타입 의존을 피하기 위한 최소 구조 타입
type SceneElement = { id: string; version: number; versionNonce?: number; isDeleted?: boolean; [k: string]: unknown };
type BinaryFile = { id: string; [k: string]: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExcalidrawAPI = any;

export default function CanvasBoard({ roomId, active = true }: { roomId: string; active?: boolean }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);

  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const ydocRef = useRef<Y.Doc | null>(null);
  const yElsRef = useRef<Y.Map<SceneElement> | null>(null);
  const yFilesRef = useRef<Y.Map<BinaryFile> | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const applyingRemote = useRef(false);
  const drawingRef = useRef(false); // 포인터로 그리는/이동하는 중인지
  const pendingRemoteRef = useRef(false); // 그리는 중 보류된 원격 변경
  const applyRemoteRef = useRef<(() => void) | null>(null);

  // 앱 다크모드(html.dark) 추종
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains('dark')),
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);

  // ── Yjs 연결 ──
  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const yEls = ydoc.getMap<SceneElement>('elements');
    const yFiles = ydoc.getMap<BinaryFile>('files');
    ydocRef.current = ydoc;
    yElsRef.current = yEls;
    yFilesRef.current = yFiles;
    providerRef.current = provider;

    const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
    provider.awareness.setLocalStateField('user', { name: user?.username ?? '익명', color });

    // 원격 변경 → Excalidraw 반영
    const applyRemote = () => {
      const api = apiRef.current;
      if (!api) return;
      // 그리는/이동하는 중(포인터 down)엔 원격 적용을 보류한다 — updateScene이
      // 진행 중인 내 입력을 덮어써 도형이 점으로 깨지는 것 방지. 끝나면 onChange에서 적용.
      if (drawingRef.current) {
        pendingRemoteRef.current = true;
        return;
      }
      const elements = Array.from(yEls.values());
      const files = Array.from(yFiles.values());
      // Excalidraw updateScene은 version으로 reconcile하는데, 반복 적용으로 부풀려진
      // 로컬 version 때문에 원격 이동(version이 조금만 증가)이 무시된다. 원격을 항상
      // 채택하도록 로컬보다 낮거나 같은 version은 로컬+1로 보정(versionNonce 유지 → 에코 없음).
      const localVer = new Map<string, number>();
      for (const e of (api.getSceneElementsIncludingDeleted?.() ?? []) as SceneElement[])
        localVer.set(e.id, e.version ?? 0);
      const reconciled = elements.map((el) => {
        const lv = localVer.get(el.id);
        return lv === undefined || (el.version ?? 0) > lv ? el : { ...el, version: lv + 1 };
      });
      applyingRemote.current = true;
      try {
        if (files.length) api.addFiles(files);
        api.updateScene({ elements: reconciled });
      } finally {
        applyingRemote.current = false;
      }
    };
    applyRemoteRef.current = applyRemote;
    // 로컬 변경(내가 그리는 중)엔 반응 안 함 — 자기 observe가 updateScene으로
    // 드래그 중인 도형을 시작 크기(w=0)로 되돌리는 self-reset 버그 방지. 원격만 반영.
    const onRemote = (_e: unknown, txn: Y.Transaction) => {
      if (txn.local) return;
      applyRemote();
    };
    yEls.observe(onRemote);
    yFiles.observe(onRemote);
    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) applyRemote();
    });

    // 원격 커서/선택 → collaborators
    const onAwareness = () => {
      const api = apiRef.current;
      if (!api) return;
      const collaborators = new Map<string, unknown>();
      provider.awareness.getStates().forEach((state, clientId) => {
        if (clientId === provider.awareness.clientID) return;
        const u = (state as { user?: { name: string; color: string }; pointer?: { x: number; y: number } }).user;
        const p = (state as { pointer?: { x: number; y: number } }).pointer;
        if (!u) return;
        collaborators.set(String(clientId), {
          username: u.name,
          color: { background: u.color, stroke: u.color },
          pointer: p ? { x: p.x, y: p.y, tool: 'pointer' } : undefined,
        });
      });
      api.updateScene({ collaborators });
    };
    provider.awareness.on('change', onAwareness);

    return () => {
      yEls.unobserve(onRemote);
      yFiles.unobserve(onRemote);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      yElsRef.current = null;
      yFilesRef.current = null;
      providerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  // 숨김(비활성) 동안 awareness를 내림 — 프레즌스·커서에서 빠짐 (연결은 유지)
  // 주의: setLocalState(null) 후에는 setLocalStateField가 no-op이라 복귀는 setLocalState로 해야 함
  useEffect(() => {
    const p = providerRef.current;
    if (!p) return;
    if (active) {
      const color = CURSOR_COLORS[(user?.id ?? 0) % CURSOR_COLORS.length];
      const cur = p.awareness.getLocalState();
      p.awareness.setLocalState({ ...(cur ?? {}), user: { name: user?.username ?? '익명', color } });
    } else {
      p.awareness.setLocalState(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, roomId]);

  // ── 로컬 변경 → Yjs ──
  const onChange = useCallback(
    (elements: readonly SceneElement[], appState: unknown, files: Record<string, BinaryFile>) => {
      // 그리기/이동 진행 상태 추적: 끝나는 순간(down→up) 보류된 원격 변경을 적용
      const drawing = (appState as Record<string, unknown>).cursorButton === 'down';
      const wasDrawing = drawingRef.current;
      drawingRef.current = drawing;
      if (wasDrawing && !drawing && pendingRemoteRef.current) {
        pendingRemoteRef.current = false;
        applyRemoteRef.current?.();
      }
      if (applyingRemote.current) return;
      const yEls = yElsRef.current;
      const yFiles = yFilesRef.current;
      const ydoc = ydocRef.current;
      if (!yEls || !yFiles || !ydoc) return;
      ydoc.transact(() => {
        for (const el of elements) {
          const cur = yEls.get(el.id);
          // version 또는 versionNonce가 바뀌면 기록. Excalidraw는 드래그 중
          // version을 거의 안 올리고 versionNonce(난수)만 갱신하므로, version만
          // 비교하면 드래그한 크기 변화가 누락돼 시작점(w=0)만 저장됨.
          // 에코는 onChange의 applyingRemote 가드 + observe의 txn.local 가드로 방지.
          if (!cur || (cur.version ?? 0) < (el.version ?? 0) || cur.versionNonce !== el.versionNonce)
            // Excalidraw element는 Object.freeze로 동결돼 있어 그대로 넘기면
            // Yjs가 저장/직렬화를 못 함. 동결 해제된 깊은 사본을 저장한다.
            yEls.set(el.id, structuredClone(el) as SceneElement);
        }
        if (files) {
          for (const id of Object.keys(files)) {
            if (!yFiles.has(id)) yFiles.set(id, files[id]);
          }
        }
      });
    },
    [],
  );

  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number } }) => {
      providerRef.current?.awareness.setLocalStateField('pointer', {
        x: payload.pointer.x,
        y: payload.pointer.y,
      });
    },
    [],
  );

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Excalidraw
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        excalidrawAPI={(api: any) => {
          apiRef.current = api;
        }}
        onChange={onChange as never}
        onPointerUpdate={onPointerUpdate as never}
        theme={dark ? 'dark' : 'light'}
        isCollaborating
      />
    </div>
  );
}
