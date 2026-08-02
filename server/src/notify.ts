import type { Server } from 'socket.io';
import db from './db.js';
import { sendPushToUser } from './push.js';

/*
 * 특정 사용자에게 알림 — DB에 영속 저장(알림함) + 접속 중이면 실시간 푸시(토스트).
 * io는 index.ts에서 주입. 오프라인 사용자도 로그인하면 알림함에서 확인 가능.
 */
let io: Server | null = null;

export function initNotifier(server: Server) {
  io = server;
}

export interface NotifyPayload {
  from: string;
  text: string;
  /** 클라가 받아 후처리(조직 목록 새로고침) / 'call'이면 "지금 들어가기" 버튼 / 'recap'=통화 요약 배달 / 'mention'=문서 멘션 / 'dm'=다이렉트 메시지 / 'todo'=할 일 담당 지정 / 'chat'=그룹 채팅(채널 설정 존중) */
  kind?:
    | 'org-approved'
    | 'org-request'
    | 'org-role'
    | 'call'
    | 'recap'
    | 'mention'
    | 'dm'
    | 'todo'
    | 'chat'
    | 'file-ack';
  /** 이 알림이 발생한 회의 코드 — 있으면 알림에 회의 썸네일 표시 + 클릭 시 열기 */
  meetingCode?: string;
}

/** userId에게 알림 — DB 저장 후 접속 소켓에 푸시(저장된 id·시각 포함) */
/** 특정 유저의 모든 소켓에 임의 이벤트 전송 (강퇴 등) */
export function emitToUser(userId: number, event: string, payload: unknown) {
  if (!io) return;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId) s.emit(event, payload);
  }
}

/** userId의 소켓 중 하나라도 peerId와의 DM 창을 보고 있는가 (dm:viewing presence — 보고 있으면 DM 알림 생략) */
export function isViewingDm(userId: number, peerId: number): boolean {
  if (!io) return false;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId && s.data.dmPeer === peerId) return true;
  }
  return false;
}

export function notifyUser(userId: number, payload: NotifyPayload) {
  // 발신자 표기 이름 우선 — from이 사용자 아이디면 name으로 치환 (표시 이름 규칙의 서버 몫, 전 알림 공통)
  const nameRow = db
    .prepare('SELECT name FROM users WHERE username = ?')
    .get(payload.from) as { name: string | null } | undefined;
  const from = nameRow?.name?.trim() ? nameRow.name! : payload.from;

  const info = db
    .prepare(
      'INSERT INTO notifications (user_id, from_name, text, kind, meeting_code) VALUES (?, ?, ?, ?, ?)',
    )
    .run(userId, from, payload.text, payload.kind ?? null, payload.meetingCode ?? null);

  if (!io) return;
  // 회의 알림이면 썸네일 표시용 회의 정보를 함께 실어 보낸다
  let meeting: { id: number; code: string; title: string; thumbnail: string | null } | null = null;
  if (payload.meetingCode) {
    meeting =
      (db
        .prepare('SELECT id, code, title, thumbnail FROM meetings WHERE code = ?')
        .get(payload.meetingCode) as typeof meeting) ?? null;
  }
  const full = {
    id: info.lastInsertRowid as number,
    from,
    text: payload.text,
    kind: payload.kind,
    meeting,
    created_at: new Date().toISOString(),
  };
  let delivered = false;
  let anyVisible = false;
  for (const s of io.sockets.sockets.values()) {
    if (s.data.userId === userId) {
      s.emit('agent:notify', full);
      delivered = true;
      if (s.data.visible !== false) anyVisible = true;
    }
  }
  // 접속 소켓이 없거나, 있어도 전부 백그라운드 탭이면 웹푸시(PWA) — 사용자가 화면을
  // 안 보고 있는데 벨함에만 조용히 쌓이면 "알림이 안 온다"가 됨 (백그라운드 탭 함정)
  if (!delivered || !anyVisible) {
    sendPushToUser(userId, {
      title: from,
      body: payload.text,
      tag: payload.kind ?? 'exist',
      url: '/',
    });
  }
}
