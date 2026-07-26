import db from './db.js';

/*
 * 채팅 채널 — 그룹(회의) 안에 채널 여러 개 (Slack의 채널처럼).
 * - 기본 채널 "일반"은 첫 접근 시 자동 생성되고, 기존(레거시) 메시지를 백필로 흡수한다.
 * - 안읽음은 그룹 단위 유지(chat_reads) — 채널별 뱃지는 클라 세션 내에서만 표시.
 */

export interface Channel {
  id: number;
  name: string;
  isDefault: boolean;
  /** 'call' = 통화 전용 채널 (통화 중 채팅이 쌓임) */
  kind: string | null;
}

/** 기본 채널 확보 — 없으면 "일반" 생성 + 레거시 메시지(channel_id NULL) 백필.
 *  통화 채널(kind='call')은 기본이 될 수 없음 — 통화부터 시작한 그룹에서 기본을 뺏지 않게 */
export function ensureDefaultChannel(meetingId: number, createdBy: number): number {
  const first = db
    .prepare(
      "SELECT id FROM chat_channels WHERE meeting_id = ? AND (kind IS NULL OR kind <> 'call') ORDER BY id LIMIT 1",
    )
    .get(meetingId) as { id: number } | undefined;
  if (first) return first.id;
  const info = db
    .prepare('INSERT INTO chat_channels (meeting_id, name, created_by) VALUES (?, ?, ?)')
    .run(meetingId, '일반', createdBy);
  const id = info.lastInsertRowid as number;
  db.prepare('UPDATE messages SET channel_id = ? WHERE meeting_id = ? AND channel_id IS NULL').run(
    id,
    meetingId,
  );
  return id;
}

/** 통화 전용 채널 확보 — 통화 중 채팅이 기본 채널과 섞이지 않게 분리. 없으면 "통화" 생성 (이름 변경 가능, kind로 식별) */
export function ensureCallChannel(meetingId: number, createdBy: number): { id: number; name: string } {
  const row = db
    .prepare("SELECT id, name FROM chat_channels WHERE meeting_id = ? AND kind = 'call' LIMIT 1")
    .get(meetingId) as { id: number; name: string } | undefined;
  if (row) return row;
  const info = db
    .prepare("INSERT INTO chat_channels (meeting_id, name, created_by, kind) VALUES (?, ?, ?, 'call')")
    .run(meetingId, '통화', createdBy);
  return { id: info.lastInsertRowid as number, name: '통화' };
}

/** 채널 목록 — 기본 채널 표시 포함 (통화 채널은 kind로 구분) */
export function listChannels(meetingId: number, callerId: number): Channel[] {
  const defaultId = ensureDefaultChannel(meetingId, callerId);
  const rows = db
    .prepare('SELECT id, name, kind FROM chat_channels WHERE meeting_id = ? ORDER BY id')
    .all(meetingId) as { id: number; name: string; kind: string | null }[];
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, isDefault: r.id === defaultId }));
}

/** 채널이 이 회의 소속인지 검증 — 맞으면 id, 아니면 null */
export function resolveChannel(meetingId: number, channelId: unknown, callerId: number): number | null {
  if (channelId == null) return ensureDefaultChannel(meetingId, callerId);
  const id = Number(channelId);
  if (!Number.isInteger(id)) return null;
  const row = db
    .prepare('SELECT id FROM chat_channels WHERE id = ? AND meeting_id = ?')
    .get(id, meetingId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function cleanChannelName(v: unknown): string | null {
  const name = String(v ?? '')
    .trim()
    .replace(/^#/, '')
    .slice(0, 24);
  return name.length >= 1 ? name : null;
}
