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
  const drawingRef = useRef(false); // 포인터로 그리는/이동하는 중인지 (onChange 기반 — 늦게 켜짐)
  // 실제 포인터 눌림 상태 — DOM 캡처 단계에서 직접 추적. drawingRef는 Excalidraw의
  // 첫 onChange가 와야 켜져서, 초당 수십 번 오는 원격 커서 이벤트가 pointerdown 직후
  // 그 틈에 끼어들어 그리기를 깨뜨린다(도형이 점으로 뭉개짐·드래그 안 풀림).
  const pointerActiveRef = useRef(false);
  // 마지막 포인터 활동 시각 — updateScene(elements)은 릴리즈 "직후"에도 위험하다
  // (Excalidraw의 드래그 종료 처리와 경합해 놓아도 커서를 따라다니는 상태로 굳음).
  // 원격 요소 반영은 포인터가 350ms 이상 완전히 쉰 뒤에만 한다.
  const lastPointerRef = useRef(0);
  const pendingRemoteRef = useRef(false); // 보류된 원격 요소 변경
  const pendingAwarenessRef = useRef(false); // 보류된 원격 커서 갱신
  const applyRemoteRef = useRef<(() => void) | null>(null);
  const pushCollaboratorsRef = useRef<(() => void) | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const interacting = () => pointerActiveRef.current || drawingRef.current;
  const pointerBusy = () => interacting() || Date.now() - lastPointerRef.current < 350;
  // applyRemote가 주입한 요소의 (version, versionNonce) — onChange가 이걸 진짜 변경으로
  // 착각해 Yjs에 되쓰면(에코) 다른 사람이 그리는 중인 도형을 스테일 상태로 덮어쓴다.
  // 주입본과 완전히 같은 요소는 내 변경이 아니므로 절대 되쓰지 않는다.
  const injectedRef = useRef(new Map<string, { v: number; n: number | undefined }>());

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

    // 보류분 적용 스케줄러 — 포인터가 350ms 이상 쉰 뒤에만 updateScene을 허용.
    // 릴리즈 직후(수십 ms)에 쏘면 Excalidraw 드래그 종료 처리와 경합해
    // "놓아도 커서를 따라다니는" 상태로 굳는다 (실측 재현됨).
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (pointerBusy()) {
          scheduleFlush();
          return;
        }
        if (pendingRemoteRef.current) {
          pendingRemoteRef.current = false;
          applyRemote();
        }
        if (pendingAwarenessRef.current) {
          pendingAwarenessRef.current = false;
          pushCollaborators();
        }
      }, 200);
    };

    // 원격 변경 → Excalidraw 반영
    const applyRemote = () => {
      const api = apiRef.current;
      if (!api) return;
      // 포인터 사용 중(드래그·직후 350ms)엔 보류 — updateScene이 진행 중인 내 입력을
      // 덮어써 도형이 점으로 깨지거나 드래그가 안 풀리는 것 방지.
      if (pointerBusy()) {
        pendingRemoteRef.current = true;
        scheduleFlush();
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
        if (lv === undefined || (el.version ?? 0) > lv) {
          injectedRef.current.set(el.id, { v: el.version ?? 0, n: el.versionNonce });
          return el;
        }
        injectedRef.current.set(el.id, { v: lv + 1, n: el.versionNonce });
        return { ...el, version: lv + 1 };
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
    const pushCollaborators = () => {
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
    pushCollaboratorsRef.current = pushCollaborators;
    // 원격 커서는 40ms로 묶어서 반영 — 상대가 마우스를 흔들면 초당 수십 번
    // updateScene이 돌아 렌더 낭비 + 내 입력과 경합한다.
    let collabTimer: ReturnType<typeof setTimeout> | null = null;
    const onAwareness = () => {
      // 내가 포인터를 쓰는 중(드래그·직후)엔 updateScene이 끼어들면 안 됨 — 보류.
      if (pointerBusy()) {
        pendingAwarenessRef.current = true;
        scheduleFlush();
        return;
      }
      if (collabTimer) return;
      collabTimer = setTimeout(() => {
        collabTimer = null;
        if (pointerBusy()) {
          pendingAwarenessRef.current = true;
          scheduleFlush();
          return;
        }
        pushCollaborators();
      }, 40);
    };
    provider.awareness.on('change', onAwareness);

    // 실제 포인터 상태 추적 (onChange보다 믿을 수 있는 신호) — flush는 스케줄러가 담당
    const onPointerDown = (e: PointerEvent) => {
      // 이 캔버스 안에서 시작한 포인터만 (다른 UI 클릭·다른 에디터는 무관)
      if (wrapRef.current && wrapRef.current.contains(e.target as Node)) {
        pointerActiveRef.current = true;
        lastPointerRef.current = Date.now();
      }
    };
    // wedge 자가 복구 — 포인터는 떠 있는데(buttons=0) Excalidraw는 아직 드래그 중이라
    // 믿는 상태(놓아도 도형이 커서를 따라다님)를 감지하면 도구를 리셋해 탈출시킨다.
    // 순간적 이벤트 순서 어긋남 오탐을 피하려고 250ms 이상 지속될 때만 발동.
    let wedgeSince = 0;
    const onPointerMove = (e: PointerEvent) => {
      // 드래그 중엔 창 전체, 아니면 캔버스 위에서만 활동으로 기록
      const overCanvas = wrapRef.current && wrapRef.current.contains(e.target as Node);
      if (pointerActiveRef.current || overCanvas) {
        lastPointerRef.current = Date.now();
      }
      if (overCanvas && !pointerActiveRef.current && e.buttons === 0) {
        const api = apiRef.current;
        const st = api?.getAppState?.();
        if (st?.cursorButton === 'down') {
          const now = Date.now();
          if (!wedgeSince) wedgeSince = now;
          else if (now - wedgeSince > 250) {
            wedgeSince = 0;
            try {
              api.setActiveTool({ type: st.activeTool?.type ?? 'selection' });
            } catch {
              /* 무시 */
            }
          }
        } else {
          wedgeSince = 0;
        }
      }
    };
    const onPointerUp = () => {
      if (!pointerActiveRef.current && !drawingRef.current) return;
      pointerActiveRef.current = false;
      lastPointerRef.current = Date.now();
      setTimeout(() => {
        if (pointerActiveRef.current) return; // 그 사이 새 드래그 시작
        // 포인터가 떨어졌으면 그리기는 끝난 것 — 빈 선택 드래그처럼 Excalidraw가
        // 마지막 onChange를 안 쏘면 drawingRef가 true로 남아 원격 반영이 영영 멈춘다.
        drawingRef.current = false;
        if (pendingRemoteRef.current || pendingAwarenessRef.current) scheduleFlush();
      }, 60);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('pointercancel', onPointerUp, true);

    return () => {
      yEls.unobserve(onRemote);
      yFiles.unobserve(onRemote);
      provider.awareness.off('change', onAwareness);
      if (collabTimer) clearTimeout(collabTimer);
      if (flushTimer) clearTimeout(flushTimer);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerUp, true);
      pushCollaboratorsRef.current = null;
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
      // 그리기/이동 진행 상태 추적: 끝나는 순간(down→up) 보류된 원격 변경을 적용.
      // Excalidraw의 onChange 콜스택 안에서 updateScene을 부르면 내부 상태가 꼬일 수
      // 있어 setTimeout(0)으로 스택을 벗어난 뒤 적용한다.
      const drawing = (appState as Record<string, unknown>).cursorButton === 'down';
      const wasDrawing = drawingRef.current;
      drawingRef.current = drawing;
      if (wasDrawing && !drawing && (pendingRemoteRef.current || pendingAwarenessRef.current)) {
        const doRemote = pendingRemoteRef.current;
        const doAwareness = pendingAwarenessRef.current;
        pendingRemoteRef.current = false;
        pendingAwarenessRef.current = false;
        setTimeout(() => {
          if (drawingRef.current) {
            // 그 사이 새 드래그가 시작됐으면 다시 보류
            if (doRemote) pendingRemoteRef.current = true;
            if (doAwareness) pendingAwarenessRef.current = true;
            return;
          }
          if (doRemote) applyRemoteRef.current?.();
          if (doAwareness) pushCollaboratorsRef.current?.();
        }, 0);
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
          if (!cur || (cur.version ?? 0) < (el.version ?? 0) || cur.versionNonce !== el.versionNonce) {
            // applyRemote가 주입한 그대로면 내 변경이 아니라 에코 — 되쓰면 상대가
            // 그리는 중인 도형을 스테일 상태로 덮어써 뭉개진다. 스킵.
            const inj = injectedRef.current.get(el.id);
            if (inj && inj.v === (el.version ?? 0) && inj.n === el.versionNonce) continue;
            injectedRef.current.delete(el.id);
            // Excalidraw element는 Object.freeze로 동결돼 있어 그대로 넘기면
            // Yjs가 저장/직렬화를 못 함. 동결 해제된 깊은 사본을 저장한다.
            yEls.set(el.id, structuredClone(el) as SceneElement);
          }
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
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
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
