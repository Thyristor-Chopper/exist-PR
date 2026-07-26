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
  /** 만든 사람 — 클라가 이름 수정 버튼 노출 판단용 (수정 권한: 만든 사람·호스트·조직 관리자) */
  createdBy: number;
}

/** 기본 채널 확보 — 없으면 "일반" 생성 + 레거시 메시지(channel_id NULL) 백필 */
export function ensureDefaultChannel(meetingId: number, createdBy: number): number {
  const first = db
    .prepare('SELECT id FROM chat_channels WHERE meeting_id = ? ORDER BY id LIMIT 1')
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

/** 채널 목록 — 기본 채널(가장 오래된 것) 표시 포함 */
export function listChannels(meetingId: number, callerId: number): Channel[] {
  ensureDefaultChannel(meetingId, callerId);
  const rows = db
    .prepare('SELECT id, name, created_by FROM chat_channels WHERE meeting_id = ? ORDER BY id')
    .all(meetingId) as { id: number; name: string; created_by: number }[];
  return rows.map((r, i) => ({ id: r.id, name: r.name, isDefault: i === 0, createdBy: r.created_by }));
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
