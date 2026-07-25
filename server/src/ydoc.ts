import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { emitToUser } from './notify.js';

/*
 * Yjs 텍스트 동시편집 백엔드 (코드/문서 공동편집).
 * y-websocket 클라이언트와 호환되는 표준 sync/awareness 프로토콜 구현.
 * ws://<host>/yjs/<room>?token=<세션토큰> 으로 연결.
 * 룸 상태는 server/ydocs/<room>.bin 에 디바운스 저장.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const YDOCS_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'ydocs');
fs.mkdirSync(YDOCS_DIR, { recursive: true });

const messageSync = 0;
const messageAwareness = 1;

/* 프레즌스 변경 푸시 — awareness가 바뀌면(입장/퇴장/복귀) 해당 그룹 참가자들에게
 * 'files:presence' 소켓 이벤트를 보내 클라가 즉시 재조회하게 한다 (폴링은 폴백).
 * 룸당 300ms 디바운스 — 커서 이동 같은 잦은 갱신으로 소켓이 넘치지 않게. */
const presenceTimers = new Map<string, NodeJS.Timeout>();
function pingPresence(room: string) {
  if (presenceTimers.has(room)) return;
  presenceTimers.set(
    room,
    setTimeout(() => {
      presenceTimers.delete(room);
      try {
        const row = db
          .prepare(
            `SELECT m.code, f.meeting_id FROM collab_files f JOIN meetings m ON m.id = f.meeting_id
             WHERE f.room = ? AND f.deleted_at IS NULL`,
          )
          .get(room) as { code: string; meeting_id: number } | undefined;
        if (!row) return;
        const parts = db
          .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
          .all(row.meeting_id) as { user_id: number }[];
        for (const p of parts) emitToUser(p.user_id, 'files:presence', { code: row.code });
      } catch {
        /* 프레즌스 푸시는 best effort */
      }
    }, 300),
  );
}

class SharedDoc extends Y.Doc {
  name: string;
  conns: Map<WebSocket, Set<number>> = new Map();
  awareness: awarenessProtocol.Awareness;
  saveTimer: NodeJS.Timeout | null = null;

  constructor(name: string) {
    super({ gc: true });
    this.name = name;
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);

    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, conn: WebSocket | null) => {
      const changed = added.concat(updated, removed);
      if (conn !== null) {
        const ctrl = this.conns.get(conn);
        if (ctrl) {
          added.forEach((id) => ctrl.add(id));
          removed.forEach((id) => ctrl.delete(id));
        }
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageAwareness);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      const buf = encoding.toUint8Array(enc);
      this.conns.forEach((_, c) => send(this, c, buf));
      // 입장/퇴장(추가·제거)일 때만 프레즌스 푸시 — 커서 이동(updated)은 제외
      if (added.length || removed.length) pingPresence(this.name);
    });

    this.on('update', (update: Uint8Array, _origin: unknown, doc: Y.Doc) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, messageSync);
      syncProtocol.writeUpdate(enc, update);
      const buf = encoding.toUint8Array(enc);
      (doc as SharedDoc).conns.forEach((_, c) => send(doc as SharedDoc, c, buf));
      scheduleSave(doc as SharedDoc);
    });
  }
}

const docs = new Map<string, SharedDoc>();

function filePath(name: string): string {
  return path.join(YDOCS_DIR, `${name.replace(/[^\w-]/g, '_')}.bin`);
}

function scheduleSave(doc: SharedDoc) {
  if (doc.saveTimer) clearTimeout(doc.saveTimer);
  doc.saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(filePath(doc.name), Buffer.from(Y.encodeStateAsUpdate(doc)));
    } catch {
      /* best effort */
    }
  }, 1500);
}

function getYDoc(name: string): SharedDoc {
  let doc = docs.get(name);
  if (doc) return doc;
  doc = new SharedDoc(name);
  const file = filePath(name);
  if (fs.existsSync(file)) {
    try {
      Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(file)));
    } catch {
      console.error(`[yjs] 상태 파싱 실패, 새로 시작: ${name}`);
    }
  }
  docs.set(name, doc);
  console.log(`[yjs] doc opened: ${name}`);
  return doc;
}

/** 룸의 영속 상태(.bin)가 있는지 — 레거시 문서를 파일시스템으로 흡수할 때 사용 */
export function ydocExists(name: string): boolean {
  return docs.has(name) || fs.existsSync(filePath(name));
}

/** 룸 상태 복사 — 파일 복제용. 열려 있는 문서는 현재 메모리 상태를, 아니면 .bin을 복사 */
export function copyYdoc(src: string, dst: string) {
  const open = docs.get(src);
  try {
    if (open) {
      fs.writeFileSync(filePath(dst), Buffer.from(Y.encodeStateAsUpdate(open)));
    } else if (fs.existsSync(filePath(src))) {
      fs.copyFileSync(filePath(src), filePath(dst));
    }
  } catch {
    /* 내용 없는 복제는 빈 문서로 시작 */
  }
}

/** 룸 상태를 읽기 전용 스냅샷으로 — 미리보기용. docs 맵에 올리지 않아 메모리 잔류 없음 */
export function readYdocSnapshot(name: string): Y.Doc | null {
  const open = docs.get(name);
  const doc = new Y.Doc();
  try {
    if (open) Y.applyUpdate(doc, Y.encodeStateAsUpdate(open));
    else if (fs.existsSync(filePath(name)))
      Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(filePath(name))));
    else return null;
  } catch {
    return null;
  }
  return doc;
}

/** 룸에 지금 접속해 편집 중인 사용자들 (awareness user 필드) — 파일 목록 프레즌스용 */
export function roomPresence(name: string): { name: string; color?: string }[] {
  const doc = docs.get(name);
  if (!doc) return [];
  const out: { name: string; color?: string }[] = [];
  doc.awareness.getStates().forEach((st) => {
    const u = (st as { user?: { name?: string; color?: string } }).user;
    if (u?.name) out.push({ name: u.name, color: u.color });
  });
  return out;
}

/** 새 룸 상태 생성 — 업로드 임포트용. build로 채운 문서를 .bin으로 저장 (룸이 열려있지 않아야 함) */
export function writeYdoc(name: string, build: (doc: Y.Doc) => void) {
  const doc = new Y.Doc();
  build(doc);
  fs.writeFileSync(filePath(name), Buffer.from(Y.encodeStateAsUpdate(doc)));
  doc.destroy();
}

/** 룸 완전 삭제 — 접속 종료 + 메모리 해제 + .bin 제거 (파일 삭제 시) */
export function deleteYdoc(name: string) {
  const doc = docs.get(name);
  if (doc) {
    if (doc.saveTimer) clearTimeout(doc.saveTimer);
    for (const conn of doc.conns.keys()) closeConn(doc, conn);
    doc.destroy();
    docs.delete(name);
  }
  try {
    fs.unlinkSync(filePath(name));
  } catch {
    /* 없으면 무시 */
  }
}

function send(doc: SharedDoc, conn: WebSocket, message: Uint8Array) {
  if (conn.readyState !== 1) {
    closeConn(doc, conn);
    return;
  }
  try {
    conn.send(message, (err?: Error) => {
      if (err) closeConn(doc, conn);
    });
  } catch {
    closeConn(doc, conn);
  }
}

function closeConn(doc: SharedDoc, conn: WebSocket) {
  const controlled = doc.conns.get(conn);
  if (controlled) {
    doc.conns.delete(conn);
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlled), null);
  }
  try {
    conn.close();
  } catch {
    /* ignore */
  }
}

function messageListener(conn: WebSocket, doc: SharedDoc, message: Uint8Array) {
  try {
    const enc = encoding.createEncoder();
    const dec = decoding.createDecoder(message);
    const type = decoding.readVarUint(dec);
    switch (type) {
      case messageSync:
        encoding.writeVarUint(enc, messageSync);
        syncProtocol.readSyncMessage(dec, enc, doc, conn);
        if (encoding.length(enc) > 1) send(doc, conn, encoding.toUint8Array(enc));
        break;
      case messageAwareness:
        awarenessProtocol.applyAwarenessUpdate(doc.awareness, decoding.readVarUint8Array(dec), conn);
        break;
    }
  } catch (e) {
    console.error('[yjs] message error', e);
  }
}

function validateToken(token: string | null): boolean {
  if (!token) return false;
  return !!db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
}

export function attachYjs(server: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (!url.pathname.startsWith('/yjs/')) return; // 다른 경로(/sync, socket.io)는 무시

    const token = url.searchParams.get('token');
    if (!validateToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const room = decodeURIComponent(url.pathname.slice('/yjs/'.length));
    if (!room) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      setupConn(ws, room);
    });
  });

  process.on('SIGINT', () => {
    for (const doc of docs.values()) {
      try {
        fs.writeFileSync(filePath(doc.name), Buffer.from(Y.encodeStateAsUpdate(doc)));
      } catch {
        /* best effort */
      }
    }
  });
}

function setupConn(conn: WebSocket, room: string) {
  conn.binaryType = 'arraybuffer';
  const doc = getYDoc(room);
  doc.conns.set(conn, new Set());

  conn.on('message', (data: ArrayBuffer | Buffer) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    messageListener(conn, doc, bytes);
  });

  // ping/pong 유지
  let alive = true;
  conn.on('pong', () => {
    alive = true;
  });
  const pingTimer = setInterval(() => {
    if (!alive) {
      closeConn(doc, conn);
      clearInterval(pingTimer);
      return;
    }
    alive = false;
    try {
      conn.ping();
    } catch {
      closeConn(doc, conn);
      clearInterval(pingTimer);
    }
  }, 25000);

  conn.on('close', () => {
    closeConn(doc, conn);
    clearInterval(pingTimer);
  });

  // 초기 sync step 1
  {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageSync);
    syncProtocol.writeSyncStep1(enc, doc);
    send(doc, conn, encoding.toUint8Array(enc));
  }
  // 현재 awareness 상태 전송
  const states = doc.awareness.getStates();
  if (states.size > 0) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, messageAwareness);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(doc.awareness, Array.from(states.keys())));
    send(doc, conn, encoding.toUint8Array(enc));
  }
}
