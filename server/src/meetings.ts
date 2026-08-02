import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { emitToUser, notifyUser } from './notify.js';
import { getRoomSize, getRoomPeers } from './sfu.js';
import { isMember, canCreateOrgGroup, audit as orgAudit } from './orgs.js';
import { canManageMeeting } from './perm.js';
import { byPositionDesc } from './positions.js';
import {
  listRecaps,
  listDecisions,
  ackDecision,
  markNextMeetingRegistered,
  runRecapForMeeting,
  getRecapSource,
} from './recap.js';
import {
  listChannels,
  ensureDefaultChannel,
  ensureCallChannel,
  resolveChannel,
  cleanChannelName,
  setNotifyMode,
} from './channels.js';
import { generateAgenda, generateDecisionHistory, invalidateAgenda, ensureAgentUser } from './steward.js';
import { draftHandover, publishHandover, listHandovers, ackHandover, reviewHandover, listChecklist, addChecklistItem, removeChecklistItem } from './handover.js';
import filesRouter, { deleteMeetingFiles } from './files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_THUMB = 5 * 1024 * 1024;

const router = Router();
router.use(requireAuth);
// 공동편집 파일시스템 — /:code/files (files.ts, mergeParams)
router.use('/:code/files', filesRouter);

// 모든 변경 요청 후 AI 브리핑 캐시 무효화
router.use((req: AuthedRequest, _res, next) => {
  if (req.method !== 'GET') invalidateBrief(req.userId!);
  next();
});

/** 6자리 회의 코드 생성 (예: "X4K9PQ") */
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

type Recur = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
const RECURS: Recur[] = ['none', 'daily', 'weekly', 'biweekly', 'monthly'];
function cleanRecur(v: unknown): Recur {
  return RECURS.includes(v as Recur) ? (v as Recur) : 'none';
}
function cleanDate(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
function toLocalISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function stepDate(d: Date, recur: Recur): Date {
  const n = new Date(d);
  if (recur === 'daily') n.setDate(n.getDate() + 1);
  else if (recur === 'weekly') n.setDate(n.getDate() + 7);
  else if (recur === 'biweekly') n.setDate(n.getDate() + 14);
  else if (recur === 'monthly') n.setMonth(n.getMonth() + 1);
  return n;
}

/** 반복 회의를 달력에 표시할 개별 occurrence(시작/종료)들로 펼친다.
 *  창: [now-31일, min(recur_until, now+90일)], 최대 120개 */
function expandOccurrences(
  startsAt: string | null,
  endsAt: string | null,
  recur: Recur,
  recurUntil: string | null,
  now: Date,
  except?: Set<string>,
): { starts_at: string; ends_at: string | null }[] {
  if (!startsAt) return [];
  const base = new Date(startsAt);
  if (isNaN(base.getTime())) return [];
  const ymdOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (recur === 'none') {
    if (except && except.has(ymdOf(base))) return [];
    return [{ starts_at: startsAt, ends_at: endsAt }];
  }

  const dur = endsAt ? new Date(endsAt).getTime() - base.getTime() : 0;
  const horizon = new Date(now.getTime() + 90 * 24 * 3600_000);
  const until = recurUntil ? new Date(recurUntil + 'T23:59:59') : null;
  const end = until && until < horizon ? until : horizon;
  const lower = new Date(now.getTime() - 31 * 24 * 3600_000);

  const out: { starts_at: string; ends_at: string | null }[] = [];
  let cur = new Date(base);
  for (let guard = 0; guard < 500 && cur <= end; guard++) {
    if (cur >= lower && !(except && except.has(ymdOf(cur)))) {
      out.push({
        starts_at: toLocalISO(cur),
        ends_at: dur ? toLocalISO(new Date(cur.getTime() + dur)) : null,
      });
      if (out.length >= 120) break;
    }
    cur = stepDate(cur, recur);
  }
  return out;
}

/** meetings.recur_except (JSON 배열 텍스트) → 제외 날짜 Set */
function parseExcept(raw: unknown): Set<string> {
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))
      : new Set();
  } catch {
    return new Set();
  }
}

router.post('/', (req: AuthedRequest, res) => {
  const { title, starts_at, ends_at } = req.body ?? {};
  if (!title) return res.status(400).json({ error: '회의 이름을 입력하세요' });
  const recur = cleanRecur(req.body?.recur);
  const recurUntil = recur === 'none' ? null : cleanDate(req.body?.recur_until);

  // org_id가 주어지면 해당 조직의 active 멤버만 회의를 만들 수 있다 (null = 개인 회의)
  const orgId = req.body?.org_id != null ? Number(req.body.org_id) : null;
  if (orgId != null) {
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버만 회의를 만들 수 있어요' });
    }
    // 조직 그룹 생성은 권한제 — owner/admin 또는 group:create 역할 보유자만
    if (!canCreateOrgGroup(orgId, req.userId!)) {
      return res.status(403).json({ error: '조직에 그룹을 만들 권한이 없어요 — 관리자에게 요청하세요' });
    }
  }

  let code = generateCode();
  while (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code)) code = generateCode();

  const info = db
    .prepare(
      'INSERT INTO meetings (code, title, host_id, org_id, starts_at, ends_at, recur, recur_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(code, title, req.userId, orgId, starts_at ?? null, ends_at ?? null, recur, recurUntil);
  const meetingId = info.lastInsertRowid as number;
  db.prepare('INSERT INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)').run(
    meetingId,
    req.userId,
  );
  // 통합 메시지함 실시간 반영 — 새 그룹이 생겼으니 목록 재조회 신호 (다른 탭·기기 포함)
  emitToUser(req.userId!, 'inbox:changed', { code });

  // 초대한 사람들 바로 참가자로 추가 + 알림
  const invited: string[] = [];
  const list = Array.isArray(req.body?.invite) ? req.body.invite : [];
  const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
    | { username: string }
    | undefined;
  for (const raw of list.slice(0, 30)) {
    const uname = String(raw ?? '').trim();
    if (!uname) continue;
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(uname) as
      | { id: number; username: string }
      | undefined;
    if (!u || u.id === req.userId) continue;
    // 조직 회의는 그 조직의 active 멤버만 초대 가능
    if (orgId != null && !isMember(orgId, u.id)) continue;
    db.prepare(
      'INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)',
    ).run(meetingId, u.id);
    invited.push(u.username);
    emitToUser(u.id, 'meeting:invited', { code, title });
    emitToUser(u.id, 'inbox:changed', { code });
    notifyUser(u.id, {
      from: me?.username ?? '누군가',
      text: `'${title}' 회의에 초대했어요. (코드 ${code})`,
      meetingCode: code,
    });
  }

  res.json({ id: meetingId, code, title, org_id: orgId, invited });
});

/** 코드로 회의 참여 */
router.post('/join', (req: AuthedRequest, res) => {
  const { code } = req.body ?? {};
  const meeting = db.prepare('SELECT * FROM meetings WHERE code = ?').get((code ?? '').toUpperCase()) as
    | { id: number; code: string; title: string; settings: string | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의 코드입니다' });

  // 입장 잠금 — 새로운 사람만 차단 (기존 참가자의 재입장은 허용)
  const already = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, req.userId);
  if (!already) {
    try {
      const settings = meeting.settings ? (JSON.parse(meeting.settings) as { locked?: boolean }) : null;
      if (settings?.locked) {
        return res.status(403).json({ error: '입장이 잠긴 그룹이에요 — 호스트에게 요청하세요' });
      }
    } catch {
      /* settings 파싱 실패 시 잠금 없음으로 취급 */
    }
  }

  if (!already) emitToUser(req.userId!, 'inbox:changed', { code: meeting.code });
  db.prepare(
    'INSERT OR IGNORE INTO meeting_participants (meeting_id, user_id) VALUES (?, ?)',
  ).run(meeting.id, req.userId);
  res.json({ id: meeting.id, code: meeting.code, title: meeting.title });
});

/** 사용자 검색 — 회의에 초대할 사람 찾기 (username 부분일치, 본인 제외)
 *  ?org=<id> 가 주어지면 그 조직의 active 멤버만 검색 (개인 회의는 전체 사용자) */
router.get('/users/search', (req: AuthedRequest, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);

  const orgParam = req.query.org;
  let rows: { username: string; avatar: string | null }[];

  if (orgParam != null && orgParam !== '' && orgParam !== 'personal') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    rows = db
      .prepare(
        `SELECT u.username, u.avatar FROM users u
         JOIN organization_members om ON om.user_id = u.id
         WHERE om.org_id = ? AND om.status = 'active' AND u.id != ? AND u.username LIKE ?
         ORDER BY CASE WHEN u.username = ? THEN 0 WHEN u.username LIKE ? THEN 1 ELSE 2 END, u.username
         LIMIT 8`,
      )
      .all(orgId, req.userId, `%${q}%`, q, `${q}%`) as typeof rows;
  } else {
    rows = db
      .prepare(
        `SELECT username, avatar FROM users
         WHERE username LIKE ? AND id != ?
         ORDER BY CASE WHEN username = ? THEN 0 WHEN username LIKE ? THEN 1 ELSE 2 END, username
         LIMIT 8`,
      )
      .all(`%${q}%`, req.userId, q, `${q}%`) as typeof rows;
  }
  res.json(rows);
});

/** 최근 회의 목록 — 조직 컨텍스트로 필터
 *  ?org=<id>  : 그 조직의 회의   ?org=personal : 개인(조직 없는) 회의   생략: 전부 */
router.get('/recent', (req: AuthedRequest, res) => {
  const orgParam = req.query.org;
  let where = 'mp.user_id = ?';
  const params: (number | string)[] = [req.userId!];

  if (orgParam === 'personal') {
    where += ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    where += ' AND m.org_id = ?';
    params.push(orgId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.org_id, m.thumbnail, m.starts_at, m.ends_at, mp.joined_at FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ${where} ORDER BY mp.joined_at DESC LIMIT 7`,
    )
    .all(...params);
  res.json(rows);
});

/** 통합 메시지함 — 스코프(조직/개인) 내 내가 참여한 그룹들의 채팅 최근·안읽음 */
router.get('/inbox', (req: AuthedRequest, res) => {
  const me = req.userId!;
  const orgParam = req.query.org;
  let orgFilter = '';
  const orgArgs: number[] = [];
  if (orgParam === 'personal') {
    orgFilter = ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, me)) return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    orgFilter = ' AND m.org_id = ?';
    orgArgs.push(orgId);
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.thumbnail,
         lm.text AS lastText, lm.created_at AS lastTs,
         (SELECT COUNT(*) FROM messages msg
            WHERE msg.meeting_id = m.id
              AND msg.user_id != ?
              AND msg.id > COALESCE((SELECT last_read FROM chat_reads WHERE user_id = ? AND meeting_id = m.id), 0)
         ) AS unread
       FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = ?
       LEFT JOIN (
         SELECT meeting_id, text, created_at FROM messages
         WHERE id IN (SELECT MAX(id) FROM messages GROUP BY meeting_id)
       ) lm ON lm.meeting_id = m.id
       WHERE 1 = 1 ${orgFilter}
       ORDER BY COALESCE(lm.created_at, '') DESC, m.id DESC`,
    )
    .all(me, me, me, ...orgArgs);
  res.json(rows);
});

/** 그룹 채팅 읽음 처리 — last_read = 그룹 최신 메시지 id */
router.post('/:code/messages/read', (req: AuthedRequest, res) => {
  const me = req.userId!;
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 그룹이에요' });
  const last = db
    .prepare('SELECT MAX(id) AS mx FROM messages WHERE meeting_id = ?')
    .get(meeting.id) as { mx: number | null };
  db.prepare(
    `INSERT INTO chat_reads (user_id, meeting_id, last_read) VALUES (?, ?, ?)
     ON CONFLICT(user_id, meeting_id) DO UPDATE SET last_read = excluded.last_read`,
  ).run(me, meeting.id, last.mx ?? 0);
  res.json({ ok: true });
});

/** 일정용 — 예정/반복 회의를 occurrence 단위로 펼쳐 반환 (달력·nowbar용)
 *  ?org=<id>|personal 로 필터 (recent와 동일 규칙) */
router.get('/schedule', (req: AuthedRequest, res) => {
  const orgParam = req.query.org;
  // 조직 필터 (회의/이벤트 공용)
  let orgFilter = '';
  const orgArgs: number[] = [];
  if (orgParam === 'personal') {
    orgFilter = ' AND m.org_id IS NULL';
  } else if (orgParam != null && orgParam !== '') {
    const orgId = Number(orgParam);
    if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직입니다' });
    if (!isMember(orgId, req.userId!)) {
      return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    }
    orgFilter = ' AND m.org_id = ?';
    orgArgs.push(orgId);
  }

  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.org_id, m.thumbnail, m.starts_at, m.ends_at, m.recur, m.recur_until, m.recur_except
       FROM meetings m JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.user_id = ? AND m.starts_at IS NOT NULL${orgFilter}`,
    )
    .all(req.userId!, ...orgArgs) as {
    id: number;
    code: string;
    title: string;
    org_id: number | null;
    thumbnail: string | null;
    starts_at: string | null;
    ends_at: string | null;
    recur: Recur;
    recur_until: string | null;
    recur_except: string | null;
  }[];

  const now = new Date();
  const out: unknown[] = [];
  for (const m of rows) {
    const occ = expandOccurrences(
      m.starts_at,
      m.ends_at,
      cleanRecur(m.recur),
      m.recur_until,
      now,
      parseExcept(m.recur_except),
    );
    for (const o of occ) {
      out.push({
        id: m.id,
        occId: `${m.id}@${o.starts_at}`,
        code: m.code,
        title: m.title,
        meetingTitle: m.title,
        thumbnail: m.thumbnail,
        starts_at: o.starts_at,
        ends_at: o.ends_at,
        recur: m.recur,
      });
    }
  }

  // 회의 안에서 추가한 일정 이벤트도 일정에 포함 — 종일(time null) 포함, 반복이면 occurrence 전개
  const events = db
    .prepare(
      `SELECT e.id AS eid, e.title AS etitle, e.date, e.time, e.end_time, e.end_date, e.recur, e.recur_until,
              m.id AS mid, m.code, m.title AS mtitle, m.thumbnail
       FROM meeting_events e
       JOIN meetings m ON m.id = e.meeting_id
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE mp.user_id = ?${orgFilter}`,
    )
    .all(req.userId!, ...orgArgs) as {
    eid: number;
    etitle: string;
    date: string;
    time: string | null;
    end_time: string | null;
    end_date: string | null;
    recur: string | null;
    recur_until: string | null;
    mid: number;
    code: string;
    mtitle: string;
    thumbnail: string | null;
  }[];
  const lower = now.getTime() - 31 * 24 * 3600_000;
  const upper = now.getTime() + 90 * 24 * 3600_000;
  for (const e of events) {
    // 반복 없으면 자기 날짜 하나, 반복이면 [lower, upper] 창 안의 occurrence 전부
    const dates: string[] = [];
    if (!e.recur) {
      dates.push(e.date);
    } else {
      let cur = new Date(e.date + 'T00:00:00');
      for (let i = 0; i < 200 && cur.getTime() <= upper; i++) {
        const y = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        if (e.recur_until && y > e.recur_until) break;
        if (cur.getTime() >= lower) dates.push(y);
        cur = stepEventDate(cur, e.recur);
      }
    }
    // 여러 날 걸친 일정 — 종료는 (시작일+span)일의 종료 시각
    const spanDays =
      e.end_date && e.end_date > e.date
        ? Math.round(
            (new Date(e.end_date + 'T00:00:00').getTime() -
              new Date(e.date + 'T00:00:00').getTime()) /
              86_400_000,
          )
        : 0;
    const allDay = e.time == null;
    for (const d of dates) {
      const startsAt = `${d}T${e.time ?? '00:00'}`;
      const ts = new Date(startsAt).getTime();
      if (isNaN(ts) || ts < lower || ts > upper) continue;
      const endD = new Date(d + 'T00:00:00');
      endD.setDate(endD.getDate() + spanDays);
      const endYmd = `${endD.getFullYear()}-${String(endD.getMonth() + 1).padStart(2, '0')}-${String(endD.getDate()).padStart(2, '0')}`;
      // 종일 일정은 ends_at을 비워 nowbar "진행 중" 판정에 안 걸리게 (표시는 allDay 플래그로)
      const endClock = allDay ? null : (e.end_time ?? (spanDays > 0 ? '23:59' : null));
      out.push({
        id: e.mid,
        occId: `ev${e.eid}@${d}`,
        code: e.code,
        title: e.etitle, // 이벤트 제목 (회의 썸네일로 어느 회의인지 표시)
        meetingTitle: e.mtitle, // 그룹명(회의 이름) — nowbar 그룹 구성용
        thumbnail: e.thumbnail,
        starts_at: startsAt,
        ends_at: endClock ? `${endYmd}T${endClock}` : null,
        recur: e.recur ?? 'none',
        kind: 'event',
        allDay,
      });
    }
  }

  out.sort(
    (a, b) =>
      new Date((a as { starts_at: string }).starts_at).getTime() -
      new Date((b as { starts_at: string }).starts_at).getTime(),
  );
  res.json(out);
});

/** 회의 상세 (허브 탭용) — 제목/일정/호스트/현재 통화 인원 */
router.get('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.starts_at, m.ends_at, m.recur, m.recur_until, m.recur_except, m.host_id, m.org_id, m.thumbnail, m.settings,
              m.period_start, m.period_end, u.username AS host, o.name AS org_name
       FROM meetings m JOIN users u ON u.id = m.host_id
       LEFT JOIN organizations o ON o.id = m.org_id
       WHERE m.code = ?`,
    )
    .get(String(req.params.code ?? '').toUpperCase()) as
    | {
        id: number;
        code: string;
        title: string;
        starts_at: string | null;
        ends_at: string | null;
        recur: string | null;
        recur_until: string | null;
        recur_except: string | null;
        host_id: number;
        org_id: number | null;
        thumbnail: string | null;
        settings: string | null;
        period_start: string | null;
        period_end: string | null;
        host: string;
        org_name: string | null;
      }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  // 조직 회의면 그 조직 기준 직급·부서를 함께 (개인 회의면 null)
  const participants = db
    .prepare(
      `SELECT u.id AS userId, u.username, u.avatar, om.role, om.position, om.department
       FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN organization_members om
         ON om.user_id = u.id AND om.org_id = ? AND om.status = 'active'
       WHERE mp.meeting_id = ? ORDER BY mp.joined_at`,
    )
    .all(meeting.org_id, meeting.id) as {
    userId: number;
    username: string;
    avatar: string | null;
    role: string | null;
    position: string | null;
    department: string | null;
  }[];

  // 조직 회의는 부서→직급순 정렬
  if (meeting.org_id != null) {
    participants.sort((a, b) => {
      const dep = (a.department ?? 'zzz').localeCompare(b.department ?? 'zzz', 'ko');
      if (dep !== 0) return dep;
      return byPositionDesc(a, b);
    });
  }

  res.json({
    id: meeting.id,
    code: meeting.code,
    title: meeting.title,
    starts_at: meeting.starts_at,
    ends_at: meeting.ends_at,
    recur: meeting.recur ?? 'none',
    recur_until: meeting.recur_until,
    recur_except: [...parseExcept(meeting.recur_except)],
    host: meeting.host,
    isHost: meeting.host_id === req.userId,
    // 관리 권한 — 클라 관리 UI 노출 기준 (호스트/조직 관리자/부서 스코프 중간관리자)
    canManage: canManageMeeting(meeting, req.userId!),
    orgId: meeting.org_id,
    orgName: meeting.org_name,
    thumbnail: meeting.thumbnail,
    settings: meeting.settings ? JSON.parse(meeting.settings) : { locked: false, guestEdit: true, muteOnJoin: false },
    period:
      meeting.period_start || meeting.period_end
        ? { start: meeting.period_start, end: meeting.period_end }
        : null,
    online: getRoomSize(meeting.code),
    callPeers: getRoomPeers(meeting.code),
    participants: participants.map((p) => ({
      userId: p.userId,
      username: p.username,
      avatar: p.avatar,
      role: p.role,
      position: p.position,
      department: p.department,
      isHost: p.username === meeting.host,
    })),
  });
});

/** 회의 설정/권한 변경 (호스트·조직 관리자) */
router.patch('/:code/settings', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id, title, settings FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null; title: string; settings: string | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  const { locked, guestEdit, muteOnJoin } = req.body ?? {};
  let cur: { locked?: boolean; guestEdit?: boolean; muteOnJoin?: boolean } = {};
  try {
    cur = meeting.settings ? (JSON.parse(meeting.settings) as typeof cur) : {};
  } catch {
    /* 손상 settings — 기본값 취급 */
  }
  const settings = { locked: !!locked, guestEdit: guestEdit !== false, muteOnJoin: !!muteOnJoin };
  // 바꾸려는 필드별로 액션 검사 — 잠금(group:lock)과 운영 설정(group:settings)은 별개 권한
  if (settings.locked !== !!cur.locked && !canManageMeeting(meeting, req.userId!, 'group:lock')) {
    return res.status(403).json({ error: '입장 잠금을 변경할 권한이 없어요' });
  }
  if (
    (settings.guestEdit !== (cur.guestEdit !== false) || settings.muteOnJoin !== !!cur.muteOnJoin) &&
    !canManageMeeting(meeting, req.userId!, 'group:settings')
  ) {
    return res.status(403).json({ error: '그룹 설정을 변경할 권한이 없어요' });
  }
  db.prepare('UPDATE meetings SET settings = ? WHERE id = ?').run(JSON.stringify(settings), meeting.id);
  if (meeting.org_id) {
    if (settings.locked !== !!cur.locked)
      orgAudit(meeting.org_id, req.userId!, 'group.lock', null, `그룹 "${meeting.title}" 입장 잠금 ${settings.locked ? '설정' : '해제'}`);
    if (settings.guestEdit !== (cur.guestEdit !== false) || settings.muteOnJoin !== !!cur.muteOnJoin)
      orgAudit(meeting.org_id, req.userId!, 'group.settings', null, `그룹 "${meeting.title}" 설정 변경`);
  }
  res.json({ settings });
});

/** 프로젝트 기간 설정 (호스트·조직 관리자) — start/end는 'YYYY-MM-DD' 또는 null(없음) */
router.patch('/:code/period', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (!canManageMeeting(meeting, req.userId!, 'group:edit-period')) return res.status(403).json({ error: '호스트나 조직 관리자만 변경할 수 있어요' });
  const clean = (v: unknown) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  const start = clean(req.body?.start);
  const end = clean(req.body?.end);
  db.prepare('UPDATE meetings SET period_start = ?, period_end = ? WHERE id = ?').run(
    start,
    end,
    meeting.id,
  );
  res.json({ period: start || end ? { start, end } : null });
});

/** 참가자 강퇴 (호스트·조직 관리자) */
router.delete('/:code/participants/:username', (req: AuthedRequest, res) => {
  const code = String(req.params.code ?? '').toUpperCase();
  const meeting = db
    .prepare('SELECT id, host_id, org_id, title FROM meetings WHERE code = ?')
    .get(code) as { id: number; host_id: number; org_id: number | null; title: string } | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (!canManageMeeting(meeting, req.userId!, 'group:kick')) return res.status(403).json({ error: '호스트나 조직 관리자만 강퇴할 수 있어요' });
  const target = db
    .prepare('SELECT id, username FROM users WHERE username = ?')
    .get(String(req.params.username)) as { id: number; username: string } | undefined;
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없어요' });
  if (target.id === meeting.host_id) return res.status(400).json({ error: '호스트는 강퇴할 수 없어요' });
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ? AND user_id = ?').run(
    meeting.id,
    target.id,
  );
  emitToUser(target.id, 'meeting:kicked', { code, title: meeting.title });
  notifyUser(target.id, {
    from: meeting.title,
    text: '회의에서 내보내졌어요.',
    meetingCode: code,
  });
  if (meeting.org_id)
    orgAudit(meeting.org_id, req.userId!, 'group.kick', target.id, `그룹 "${meeting.title}"에서 ${target.username}님 내보내기`);
  res.json({ ok: true });
});

/** 호스트 위임 (호스트·조직 관리자 — 호스트 부재 시 관리자가 재지정) */
router.patch('/:code/host', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '회의를 찾을 수 없어요' });
  if (!canManageMeeting(meeting, req.userId!, 'group:transfer')) return res.status(403).json({ error: '호스트나 조직 관리자만 위임할 수 있어요' });
  const target = db
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(String(req.body?.username)) as { id: number } | undefined;
  if (!target) return res.status(404).json({ error: '사용자를 찾을 수 없어요' });
  db.prepare('UPDATE meetings SET host_id = ? WHERE id = ?').run(target.id, meeting.id);
  if (meeting.org_id) {
    const t = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meeting.id) as { title: string };
    orgAudit(meeting.org_id, req.userId!, 'group.transfer', target.id, `그룹 "${t.title}" 호스트를 ${String(req.body?.username)}님에게 위임`);
  }
  res.json({ ok: true });
});

/** 회의 수정 (호스트·조직 관리자) — 제목/시작/종료 */
router.patch('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (!canManageMeeting(meeting, req.userId!, 'group:edit-info')) {
    return res.status(403).json({ error: '호스트나 조직 관리자만 수정할 수 있어요' });
  }
  const { title, starts_at, ends_at } = req.body ?? {};
  if (title !== undefined && !String(title).trim()) {
    return res.status(400).json({ error: '회의 이름을 입력하세요' });
  }
  if (req.body?.recur !== undefined) {
    // 반복 정보까지 함께 갱신 (일정 잡기/수정)
    const recur = cleanRecur(req.body.recur);
    const recurUntil = recur === 'none' ? null : cleanDate(req.body.recur_until);
    db.prepare(
      `UPDATE meetings SET
         title = COALESCE(?, title), starts_at = ?, ends_at = ?, recur = ?, recur_until = ?
       WHERE id = ?`,
    ).run(title ?? null, starts_at ?? null, ends_at ?? null, recur, recurUntil, meeting.id);
  } else {
    db.prepare(
      `UPDATE meetings SET
         title = COALESCE(?, title), starts_at = ?, ends_at = ?
       WHERE id = ?`,
    ).run(title ?? null, starts_at ?? null, ends_at ?? null, meeting.id);
  }
  res.json({ ok: true });
});

/** 회의 사진(썸네일) 업로드 (호스트·조직 관리자) — 이미지 raw body, 최대 5MB */
router.post('/:code/thumbnail', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (!canManageMeeting(meeting, req.userId!, 'group:edit-info')) {
    return res.status(403).json({ error: '호스트나 조직 관리자만 사진을 바꿀 수 있어요' });
  }
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.startsWith('image/')) {
    return res.status(400).json({ error: '이미지 파일만 올릴 수 있어요' });
  }
  const ext = ct.split('/')[1]?.replace(/[^\w]/g, '').slice(0, 5) || 'png';
  const filename = `mthumb-${crypto.randomUUID()}.${ext}`;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_THUMB) {
      res.status(413).json({ error: '사진이 너무 커요 (최대 5MB)' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    if (size === 0) return res.status(400).json({ error: '빈 파일이에요' });
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.concat(chunks));
    const url = `/api/workspaces/uploads/${filename}`;
    db.prepare('UPDATE meetings SET thumbnail = ? WHERE id = ?').run(url, meeting.id);
    res.json({ thumbnail: url });
  });
});

/** 회의 삭제 (호스트·조직 관리자) — 참가 기록/채팅도 함께 */
router.delete('/:code', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (!canManageMeeting(meeting, req.userId!, 'group:delete')) {
    return res.status(403).json({ error: '호스트나 조직 관리자만 삭제할 수 있어요' });
  }
  if (meeting.org_id) {
    const t = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meeting.id) as { title: string };
    orgAudit(meeting.org_id, req.userId!, 'group.delete', null, `그룹 "${t.title}" 삭제`);
  }
  // 삭제 전에 참가자 목록 확보 — 삭제 후 열려 있는 탭을 실시간으로 닫으라고 알림
  const participantIds = (
    db.prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?').all(meeting.id) as {
      user_id: number;
    }[]
  ).map((r) => r.user_id);
  db.prepare('DELETE FROM messages WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meeting_participants WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM meeting_events WHERE meeting_id = ?').run(meeting.id);
  // todos.recap_id(SET NULL)보다 먼저 지워도 되지만, 순서를 todos 뒤로 두면 FK 정책과 무관하게 안전
  try {
    db.prepare(
      'DELETE FROM todo_assignees WHERE todo_id IN (SELECT id FROM todos WHERE meeting_id = ?)',
    ).run(meeting.id);
    db.prepare('DELETE FROM todos WHERE meeting_id = ?').run(meeting.id);
  } catch {
    /* todos에 meeting_id 컬럼이 없으면 무시 */
  }
  // 수신확인은 recap을 FK로 물고 있음 — 먼저 안 지우면 recap 삭제가 FK로 막힘 (기존 잠복 버그)
  db.prepare(
    'DELETE FROM decision_acks WHERE recap_id IN (SELECT id FROM meeting_recaps WHERE meeting_id = ?)',
  ).run(meeting.id);
  db.prepare('DELETE FROM meeting_recaps WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM chat_reads WHERE meeting_id = ?').run(meeting.id);
  // 채널 알림 설정이 채널을 FK로 물고 있음 — 채널보다 먼저
  db.prepare(
    'DELETE FROM channel_notify_prefs WHERE channel_id IN (SELECT id FROM chat_channels WHERE meeting_id = ?)',
  ).run(meeting.id);
  db.prepare('DELETE FROM chat_channels WHERE meeting_id = ?').run(meeting.id);
  db.prepare('DELETE FROM call_transcripts WHERE meeting_id = ?').run(meeting.id);
  deleteMeetingFiles(meeting.id, String(req.params.code).toUpperCase());
  db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting.id);
  const upper = String(req.params.code).toUpperCase();
  for (const uid of participantIds) emitToUser(uid, 'meeting:deleted', { code: upper });
  res.json({ ok: true });
});

/** 반복 회의의 특정 회차(날짜) 삭제/복원 — 호스트·조직 관리자.
 *  body: { date: 'YYYY-MM-DD', restore?: boolean } */
router.post('/:code/occurrences/exclude', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id, recur, recur_except FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null; recur: string | null; recur_except: string | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (!canManageMeeting(meeting, req.userId!, 'group:schedule')) {
    return res.status(403).json({ error: '호스트나 조직 관리자만 회차를 삭제할 수 있어요' });
  }
  const date = cleanDate(req.body?.date);
  if (!date) return res.status(400).json({ error: '날짜를 확인하세요' });
  const set = parseExcept(meeting.recur_except);
  if (req.body?.restore) set.delete(date);
  else set.add(date);
  db.prepare('UPDATE meetings SET recur_except = ? WHERE id = ?').run(
    JSON.stringify([...set]),
    meeting.id,
  );
  res.json({ ok: true, recur_except: [...set] });
});

/** 회의 일정 이벤트 목록 (참가자 공유) */
router.get('/:code/events', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const rows = db
    .prepare(
      `SELECT e.id, e.title, e.date, e.time, e.end_time, e.end_date, e.is_call, e.memo, e.people, e.remind, e.recur, e.recur_until, e.color, u.username AS author, e.created_by
       FROM meeting_events e JOIN users u ON u.id = e.created_by
       WHERE e.meeting_id = ? ORDER BY e.date, COALESCE(e.time, '99:99')`,
    )
    .all(meeting.id) as { people: string | null; [k: string]: unknown }[];
  // people(JSON id 배열)을 이름으로 풀어서 내려줌 — 못 찾는 id(탈퇴 등)는 제외
  const pickUser = db.prepare('SELECT id, username, name FROM users WHERE id = ?');
  // 일정 수신확인 명단 — 회람 사인의 일정판
  const pickAcks = db.prepare(
    `SELECT u.username FROM event_acks a JOIN users u ON u.id = a.user_id
     WHERE a.event_id = ? ORDER BY a.created_at`,
  );
  res.json(
    rows.map((r) => {
      let ids: number[] = [];
      try {
        ids = JSON.parse(r.people ?? '[]');
      } catch {
        /* 손상된 값은 빈 배열 취급 */
      }
      const people = ids
        .map((id) => pickUser.get(id) as { id: number; username: string; name: string | null } | undefined)
        .filter((u): u is { id: number; username: string; name: string | null } => !!u);
      const acks = (pickAcks.all(r.id) as { username: string }[]).map((a) => a.username);
      return { ...r, people, acks };
    }),
  );
});

/** 일정 수신확인 — "일정 잡힌 것 봤음" 서명 (참가자만, 멱등) */
router.post('/:code/events/:eventId/ack', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const ev = db
    .prepare('SELECT id FROM meeting_events WHERE id = ? AND meeting_id = ?')
    .get(req.params.eventId, r.meeting.id) as { id: number } | undefined;
  if (!ev) return res.status(404).json({ error: '존재하지 않는 일정이에요' });
  db.prepare('INSERT OR IGNORE INTO event_acks (event_id, user_id) VALUES (?, ?)').run(
    ev.id,
    req.userId,
  );
  res.json({ ok: true });
});

/** body.people을 회의 참가자 id만 남긴 중복 없는 배열로 정리 */
function cleanPeople(meetingId: number, people: unknown): number[] {
  if (!Array.isArray(people)) return [];
  const partIds = new Set(
    (
      db.prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?').all(meetingId) as {
        user_id: number;
      }[]
    ).map((p) => p.user_id),
  );
  return [...new Set(people.map(Number).filter((n) => Number.isInteger(n) && partIds.has(n)))].slice(0, 30);
}

const cleanMemo = (v: unknown) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, 500) : null;
};

/** 알림 시점 검증 — 허용값(분) 외엔 null(기본 30·10분)로. 0은 "알림 없음" */
const REMIND_CHOICES = new Set([0, 5, 10, 30, 60, 120, 1440]);
const cleanRemind = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return REMIND_CHOICES.has(n) ? n : null;
};

/** 일정 색 검증 — #rrggbb만 (null=기본) */
const cleanColor = (v: unknown): string | null =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;

/** 개별 일정 반복 검증 */
const EV_RECURS = new Set(['daily', 'weekly', 'biweekly', 'monthly']);
const cleanEvRecur = (v: unknown): string | null =>
  typeof v === 'string' && EV_RECURS.has(v) ? v : null;
const cleanEvUntil = (v: unknown): string | null =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;

/** 반복 일정 다음 날짜 (개별 이벤트용 — meetings의 stepDate와 동일 규칙) */
export function stepEventDate(d: Date, recur: string): Date {
  const n = new Date(d);
  if (recur === 'daily') n.setDate(n.getDate() + 1);
  else if (recur === 'weekly') n.setDate(n.getDate() + 7);
  else if (recur === 'biweekly') n.setDate(n.getDate() + 14);
  else n.setMonth(n.getMonth() + 1);
  return n;
}

const ymdOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 반복 일정의 fromYmd 이후 첫 occurrence 날짜 — 없으면 null (리마인더·일정 확장 공용) */
export function eventOccurrenceOnOrAfter(
  anchor: string,
  recur: string,
  until: string | null,
  fromYmd: string,
): string | null {
  let cur = new Date(anchor + 'T00:00:00');
  if (isNaN(cur.getTime())) return null;
  for (let i = 0; i < 500; i++) {
    const y = ymdOf(cur);
    if (until && y > until) return null;
    if (y >= fromYmd) return y;
    cur = stepEventDate(cur, recur);
  }
  return null;
}

/** AI 겹침 시간 제안 — 참가자 전원의 일정을 보고 다음 7일 중 모두 비는 회의 시간 후보를 찾는다.
 *  규칙 기반(P1 ⑥ 업그레이드): 평일 10~17시 1시간 슬롯, 종일·여러 날 일정은 그 날 전체 차단.
 *  AI는 후보 제시까지 — 등록은 사람이 원클릭 확정 */
router.get('/:code/schedule/suggest', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const aiId = ensureAgentUser();
  const parts = (
    db
      .prepare(
        `SELECT u.id, u.username FROM meeting_participants mp
         JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ?`,
      )
      .all(r.meeting.id) as { id: number; username: string }[]
  ).filter((p) => p.id !== aiId);
  if (parts.length === 0) return res.json({ total: 0, slots: [] });

  // 후보 창: 내일부터 7일, 평일만
  const days: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue;
    days.push(ymdOf(d));
  }
  const windowStart = days[0];
  const windowEnd = days[days.length - 1];
  if (!windowStart) return res.json({ total: parts.length, slots: [] });

  const toMin = (hhmm: string | null): number | null => {
    if (!hhmm) return null;
    const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };

  // 참가자별 바쁜 구간 — 그 사람이 참가한 모든 그룹의 일정 이벤트에서 수집.
  // 관련자(people)가 지정된 일정은 그 사람들만, 비어 있으면 그 그룹 참가자 전원이 바쁜 것으로 본다
  const busy = new Map<number, Map<string, { s: number; e: number }[]>>();
  const dayBlock = (uid: number, date: string) => addBusy(uid, date, 0, 24 * 60);
  const addBusy = (uid: number, date: string, s: number, e: number) => {
    if (!busy.has(uid)) busy.set(uid, new Map());
    const byDay = busy.get(uid)!;
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date)!.push({ s, e });
  };

  const evStmt = db.prepare(
    `SELECT DISTINCT e.id, e.date, e.time, e.end_time, e.end_date, e.recur, e.recur_until, e.people
     FROM meeting_events e
     JOIN meeting_participants mp ON mp.meeting_id = e.meeting_id
     WHERE mp.user_id = ? AND (e.recur IS NOT NULL OR COALESCE(e.end_date, e.date) >= ?) AND e.date <= ?`,
  );
  for (const p of parts) {
    const rows = evStmt.all(p.id, windowStart, windowEnd) as {
      date: string;
      time: string | null;
      end_time: string | null;
      end_date: string | null;
      recur: string | null;
      recur_until: string | null;
      people: string | null;
    }[];
    for (const ev of rows) {
      // 관련자 지정 일정이면 이 참가자가 목록에 있을 때만 바쁨
      try {
        const ids = JSON.parse(ev.people ?? '[]') as number[];
        if (Array.isArray(ids) && ids.length > 0 && !ids.includes(p.id)) continue;
      } catch {
        /* 손상된 people은 전원 공유로 취급 */
      }
      const sMin = toMin(ev.time);
      const eMin = ev.end_time ? (toMin(ev.end_time) ?? (sMin ?? 0) + 60) : (sMin ?? 0) + 60;
      const mark = (date: string) => {
        if (date < windowStart || date > windowEnd) return;
        if (sMin == null) dayBlock(p.id, date); // 종일 일정 = 그 날 차단 (휴가 등)
        else addBusy(p.id, date, sMin, Math.max(eMin, sMin + 30));
      };
      if (ev.recur) {
        // 반복 일정 — 창 안의 occurrence들 전개
        let occ = eventOccurrenceOnOrAfter(ev.date, ev.recur, ev.recur_until, windowStart);
        while (occ && occ <= windowEnd) {
          mark(occ);
          occ = eventOccurrenceOnOrAfter(occ, ev.recur, ev.recur_until, ymdOf(stepEventDate(new Date(occ + 'T00:00:00'), ev.recur)));
        }
      } else if (ev.end_date && ev.end_date > ev.date) {
        // 여러 날 일정 — 걸친 날 전부 차단
        for (const d of days) if (d >= ev.date && d <= ev.end_date) dayBlock(p.id, d);
      } else {
        mark(ev.date);
      }
    }
  }

  // 슬롯 채점 — 평일 10~17시, 1시간 단위
  const slots: { date: string; time: string; free: number; busy: string[] }[] = [];
  for (const date of days) {
    for (let h = 10; h <= 16; h++) {
      const s = h * 60;
      const e = s + 60;
      const busyNames = parts
        .filter((p) => (busy.get(p.id)?.get(date) ?? []).some((b) => b.s < e && s < b.e))
        .map((p) => p.username);
      slots.push({ date, time: `${String(h).padStart(2, '0')}:00`, free: parts.length - busyNames.length, busy: busyNames });
    }
  }
  // 전원 가능 우선, 그다음 빈 사람 많은 순 — 같은 점수면 빠른 시간
  slots.sort((a, b) => b.free - a.free || a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  res.json({ total: parts.length, slots: slots.slice(0, 3) });
});

/** 회의 일정 이벤트 추가 */
router.post('/:code/events', (req: AuthedRequest, res) => {
  const {
    title,
    date,
    time,
    end_time,
    end_date,
    is_call,
    people,
    memo,
    remind,
    recur,
    recur_until,
    color,
  } = req.body ?? {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: '일정 제목을 입력하세요' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: '날짜를 확인하세요' });
  }
  const code = String(req.params.code ?? '').toUpperCase();
  const meeting = db
    .prepare('SELECT id, title FROM meetings WHERE code = ?')
    .get(code) as { id: number; title: string } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const hhmm = (v: unknown) => (v && /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
  // 여러 날 걸친 일정 — 종료일이 시작일보다 뒤일 때만 유효
  const endDate =
    typeof end_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end_date) && end_date > String(date)
      ? end_date
      : null;
  const t = hhmm(time);
  const tEnd = t ? hhmm(end_time) : null; // 시작이 있어야 종료 의미 있음
  // 같은 날일 때만 시작<종료 검사 (여러 날이면 다음 날 이른 시각도 정상)
  if (t && tEnd && !endDate && tEnd <= t) {
    return res.status(400).json({ error: '종료 시간이 시작보다 빨라요' });
  }
  const isCall = is_call ? 1 : 0;
  const cleanTitle = String(title).trim().slice(0, 80);
  const ppl = cleanPeople(meeting.id, people);
  const memoVal = cleanMemo(memo);
  const remindVal = cleanRemind(remind);
  const recurVal = cleanEvRecur(recur);
  const untilVal = recurVal ? cleanEvUntil(recur_until) : null;
  const colorVal = cleanColor(color);
  const info = db
    .prepare(
      'INSERT INTO meeting_events (meeting_id, title, date, time, end_time, end_date, is_call, people, memo, remind, recur, recur_until, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(meeting.id, cleanTitle, String(date), t, tEnd, endDate, isCall, JSON.stringify(ppl), memoVal, remindVal, recurVal, untilVal, colorVal, req.userId);

  // 회의 참가자 전원(작성자 제외)에게 일정 알림 — 회의 썸네일과 함께
  const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
    | { username: string }
    | undefined;
  const others = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?')
    .all(meeting.id, req.userId) as { user_id: number }[];
  const md = String(date).slice(5).replace('-', '/'); // MM/DD
  const timeStr = t ? (tEnd ? `${t}~${tEnd}` : t) : '';
  const when = timeStr ? `${md} ${timeStr}` : md;
  for (const p of others) {
    // 관련자로 지정된 사람은 "나를 콕 집었다"가 보이게 문구 분리
    notifyUser(p.user_id, {
      from: me?.username ?? meeting.title,
      text: ppl.includes(p.user_id)
        ? `'${cleanTitle}' 일정의 관련자로 지정됐어요 (${when}) — ${meeting.title}`
        : `'${meeting.title}'에 ${isCall ? '통화' : '일정'} 추가 — ${cleanTitle} (${when})`,
      meetingCode: code,
    });
  }

  res.json({ id: info.lastInsertRowid, title, date, time: t, end_time: tEnd, is_call: isCall });
});

/** 회의 일정 이벤트 삭제 (작성자·호스트·조직 관리자) */
router.delete('/:code/events/:eventId', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const ev = db
    .prepare('SELECT created_by FROM meeting_events WHERE id = ? AND meeting_id = ?')
    .get(req.params.eventId, meeting.id) as { created_by: number } | undefined;
  if (!ev) return res.json({ ok: true });
  if (ev.created_by !== req.userId && !canManageMeeting(meeting, req.userId!, 'group:schedule')) {
    return res.status(403).json({ error: '작성자·호스트·조직 관리자만 삭제할 수 있어요' });
  }
  db.prepare('DELETE FROM event_acks WHERE event_id = ?').run(req.params.eventId);
  db.prepare('DELETE FROM meeting_events WHERE id = ?').run(req.params.eventId);
  res.json({ ok: true });
});

/** 회의 일정 이벤트 수정 (작성자·호스트·조직 관리자) */
router.patch('/:code/events/:eventId', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as
    | { id: number; host_id: number; org_id: number | null }
    | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const ev = db
    .prepare('SELECT created_by, title, date, time, end_time, end_date, is_call, people, memo, remind, recur, recur_until, color FROM meeting_events WHERE id = ? AND meeting_id = ?')
    .get(req.params.eventId, meeting.id) as
    | { created_by: number; title: string; date: string; time: string | null; end_time: string | null; end_date: string | null; is_call: number; people: string | null; memo: string | null; remind: number | null; recur: string | null; recur_until: string | null; color: string | null }
    | undefined;
  if (!ev) return res.status(404).json({ error: '존재하지 않는 일정입니다' });
  if (ev.created_by !== req.userId && !canManageMeeting(meeting, req.userId!, 'group:schedule')) {
    return res.status(403).json({ error: '작성자·호스트·조직 관리자만 수정할 수 있어요' });
  }

  const {
    title,
    date,
    time,
    end_time,
    end_date,
    is_call,
    people,
    memo,
    remind,
    recur,
    recur_until,
    color,
  } = req.body ?? {};
  const hhmm = (v: unknown) => (v && /^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
  const newTitle = title !== undefined ? String(title).trim().slice(0, 80) : ev.title;
  if (!newTitle) return res.status(400).json({ error: '일정 제목을 입력하세요' });
  const newDate =
    date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : ev.date;
  const rawEndDate = end_date !== undefined ? end_date : ev.end_date;
  const newEndDate =
    typeof rawEndDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawEndDate) && rawEndDate > newDate
      ? rawEndDate
      : null;
  const t = time !== undefined ? hhmm(time) : ev.time;
  const tEnd = t ? (end_time !== undefined ? hhmm(end_time) : ev.end_time) : null;
  if (t && tEnd && !newEndDate && tEnd <= t) {
    return res.status(400).json({ error: '종료 시간이 시작보다 빨라요' });
  }
  const isCall = is_call !== undefined ? (is_call ? 1 : 0) : ev.is_call;
  let oldPpl: number[] = [];
  try {
    oldPpl = JSON.parse(ev.people ?? '[]');
  } catch {
    /* 손상된 값은 빈 배열 취급 */
  }
  const newPpl = people !== undefined ? cleanPeople(meeting.id, people) : oldPpl;
  const newMemo = memo !== undefined ? cleanMemo(memo) : ev.memo;
  const newRemind = remind !== undefined ? cleanRemind(remind) : ev.remind;
  const newRecur = recur !== undefined ? cleanEvRecur(recur) : ev.recur;
  const newUntil = newRecur
    ? recur_until !== undefined
      ? cleanEvUntil(recur_until)
      : ev.recur_until
    : null;
  const newColor = color !== undefined ? cleanColor(color) : ev.color;

  db.prepare(
    'UPDATE meeting_events SET title = ?, date = ?, time = ?, end_time = ?, end_date = ?, is_call = ?, people = ?, memo = ?, remind = ?, recur = ?, recur_until = ?, color = ? WHERE id = ?',
  ).run(newTitle, newDate, t, tEnd, newEndDate, t ? isCall : 0, JSON.stringify(newPpl), newMemo, newRemind, newRecur, newUntil, newColor, req.params.eventId);

  // 수정으로 새로 지정된 관련자에게만 알림 (원래 있던 사람에게 또 보내지 않음)
  const added = newPpl.filter((id) => !oldPpl.includes(id) && id !== req.userId);
  if (added.length > 0) {
    const editor = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
      | { username: string }
      | undefined;
    const md = newDate.slice(5).replace('-', '/');
    const when = t ? `${md} ${tEnd ? `${t}~${tEnd}` : t}` : md;
    for (const id of added) {
      notifyUser(id, {
        from: editor?.username ?? '일정',
        text: `'${newTitle}' 일정의 관련자로 지정됐어요 (${when})`,
        meetingCode: String(req.params.code ?? '').toUpperCase(),
      });
    }
  }

  res.json({ id: Number(req.params.eventId), title: newTitle, date: newDate, time: t, end_time: tEnd, is_call: t ? isCall : 0 });
});

/** P1 — 통화 종료 후 AI가 뽑은 결정·할 일 목록 (참가자만) */
router.get('/:code/recaps', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, req.userId);
  if (!isParticipant) return res.status(403).json({ error: '회의 참가자만 볼 수 있어요' });
  res.json(listRecaps(meeting.id));
});

/** 수동 recap — 통화 없이도 지금까지의 채팅을 즉시 정리 (호스트만).
 *  참석자 = 정리 창 안에서 채팅에 참여한 사람 (통화 세션 개념의 채팅판) */
router.post('/:code/recaps/run', async (req: AuthedRequest, res) => {
  const code = String(req.params.code ?? '').toUpperCase();
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(code) as { id: number; host_id: number; org_id: number | null } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  if (!canManageMeeting(meeting, req.userId!, 'group:recap')) {
    return res.status(403).json({ error: '호스트나 조직 관리자만 정리를 실행할 수 있어요' });
  }
  // 정리 창 = 마지막 recap 이후 (runRecapForMeeting과 동일 기준 — 수동/자동 1건 기록은 제외)
  const last = db
    .prepare(
      `SELECT MAX(call_ended_at) AS t FROM meeting_recaps
       WHERE meeting_id = ? AND source NOT IN ('manual', 'auto')`,
    )
    .get(meeting.id) as { t: string | null };
  const since =
    last.t ?? new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const chatters = db
    .prepare(
      // AI는 참석자가 아님 — 참석 목록에 exist AI가 끼지 않게 제외
      `SELECT DISTINCT user_id FROM messages WHERE meeting_id = ? AND created_at > ? AND user_id != ?`,
    )
    .all(meeting.id, since, ensureAgentUser()) as { user_id: number }[];
  const id = await runRecapForMeeting(code, chatters.map((c) => c.user_id), {
    trigger: 'manual',
  });
  res.json({ id }); // id null = 정리할 새 기록 부족
});

/** 채팅 결정 수동 기록 — AI 제안 카드의 [기록] 버튼 (참가자 누구나) */
router.post('/:code/decisions/manual', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const text = String(req.body?.text ?? '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: '기록할 내용이 없어요' });
  const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
    | { username: string }
    | undefined;
  const info = db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, actions, attendees, source)
       VALUES (?, ?, ?, ?, ?, 'manual')`,
    )
    .run(
      r.meeting.id,
      text.slice(0, 80),
      JSON.stringify([text]),
      JSON.stringify([]),
      JSON.stringify(me ? [me.username] : []),
    );
  invalidateAgenda(r.meeting.id);
  // 기록자 외 참가자에게 알림
  const others = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?')
    .all(r.meeting.id, req.userId) as { user_id: number }[];
  for (const p of others) {
    notifyUser(p.user_id, {
      from: 'exist AI',
      text: `결정이 원장에 기록됐어요 — ${text.slice(0, 60)}`,
      kind: 'recap',
      meetingCode: String(req.params.code).toUpperCase(),
    });
    invalidateBrief(p.user_id);
  }
  res.json({ id: info.lastInsertRowid });
});

// ── 교대 인수인계 — AI 초안 → 발행 → 다음 조 서명 (참가자만) ──

/** 인수인계 목록 (최신순, 서명 포함) */
router.get('/:code/handovers', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(listHandovers(r.meeting.id));
});

/** AI 초안 — 마지막 인수인계 이후 기록에서 4섹션 자동 추출 */
router.post('/:code/handovers/draft', async (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(await draftHandover(r.meeting.id));
});

// ── 반복 점검 체크리스트 — 매 교대 반복되는 정형 항목 (참가자 누구나 관리) ──
router.get('/:code/handovers/checklist', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(listChecklist(r.meeting.id));
});
router.post('/:code/handovers/checklist', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const id = addChecklistItem(r.meeting.id, req.userId!, String(req.body?.label ?? ''));
  if (id == null) return res.status(400).json({ error: '항목을 추가할 수 없어요 (최대 20개)' });
  res.json({ id });
});
router.delete('/:code/handovers/checklist/:itemId', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (!removeChecklistItem(r.meeting.id, Number(req.params.itemId)))
    return res.status(404).json({ error: '없는 항목이에요' });
  res.json({ ok: true });
});

/** AI 부족분 점검 — 초안과 이번 조 기록 대조, 빠진 항목 제안 */
router.post('/:code/handovers/review', async (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(await reviewHandover(r.meeting.id, req.body?.sections));
});

/** 발행 — 작성자 외 참가자에게 알림 */
router.post('/:code/handovers', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  try {
    const id = publishHandover(
      r.meeting.id,
      String(req.params.code).toUpperCase(),
      req.userId!,
      String(req.body?.shiftLabel ?? '').trim(),
      req.body?.sections,
      String(req.body?.source ?? 'manual'),
      req.body?.checks,
    );
    res.json({ id });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '발행 실패' });
  }
});

/** 서명 — "작업 전에 확인했다" (멱등). note = 복명복창 한 줄(선택, AI가 원본과 대조) */
router.post('/:code/handovers/:id/ack', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (
    !ackHandover(
      Number(req.params.id),
      r.meeting.id,
      req.userId!,
      String(req.body?.note ?? ''),
      typeof req.body?.signature === 'string' ? req.body.signature : undefined,
    )
  )
    return res.status(404).json({ error: '없는 인수인계예요' });
  res.json({ ok: true });
});

/** AI 자동 기록 취소 — 채팅의 [취소] 버튼 (참가자 누구나, 사후 거부권). source='auto'만 지울 수 있다 */
router.delete('/:code/decisions/auto/:recapId', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const recapId = Number(req.params.recapId);
  const row = db
    .prepare('SELECT source FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, r.meeting.id) as { source: string } | undefined;
  if (!row) return res.status(404).json({ error: '이미 취소됐거나 없는 기록이에요' });
  if (row.source !== 'auto')
    return res.status(403).json({ error: 'AI가 자동 기록한 결정만 취소할 수 있어요' });
  db.prepare('DELETE FROM decision_acks WHERE recap_id = ?').run(recapId);
  db.prepare('DELETE FROM meeting_recaps WHERE id = ?').run(recapId);
  invalidateAgenda(r.meeting.id);
  const parts = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
    .all(r.meeting.id) as { user_id: number }[];
  for (const p of parts) invalidateBrief(p.user_id);
  res.json({ ok: true });
});

/** 회의 원문 — 이 recap의 재료가 된 발언 전부 (참가자만) */
router.get('/:code/recaps/:recapId/source', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const src = getRecapSource(r.meeting.id, Number(req.params.recapId));
  if (!src) return res.status(404).json({ error: '원문이 없는 기록이에요 (1건짜리 수동·자동 기록)' });
  res.json(src);
});

/** recap의 다음 회의 제안을 등록됨으로 표시 — 클라가 events POST 성공 후 호출 (참가자만) */
router.post('/:code/recaps/:recapId/next-registered', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, req.userId);
  if (!isParticipant) return res.status(403).json({ error: '회의 참가자만 쓸 수 있어요' });
  if (!markNextMeetingRegistered(Number(req.params.recapId), meeting.id)) {
    return res.status(404).json({ error: '다음 회의 제안이 없는 정리예요' });
  }
  res.json({ ok: true });
});

/** 결정 원장 — 이 그룹의 모든 recap 결정 시간순 (참가자만) */
router.get('/:code/decisions', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(listDecisions(r.meeting.id));
});

/** 변경 이력 뷰 — 원장을 같은 주제끼리 묶은 타임라인 (AI 그룹핑, 10분 캐시, 규칙 폴백) */
router.get('/:code/decisions/history', async (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(await generateDecisionHistory(r.meeting.id));
});

/** 결정 수신 확인 — 회람 사인. recap이 이 회의 것인지 검증 후 기록 */
router.post('/:code/decisions/ack', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const recapId = Number(req.body?.recapId);
  const idx = Number(req.body?.idx);
  if (!Number.isInteger(recapId) || !Number.isInteger(idx)) {
    return res.status(400).json({ error: '잘못된 요청입니다' });
  }
  const owns = db
    .prepare('SELECT 1 FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, r.meeting.id);
  if (!owns) return res.status(404).json({ error: '존재하지 않는 결정입니다' });
  // note = 현장 피드백 한 줄(선택) — 확인 후에 노트만 추가하는 재호출도 허용
  const note = typeof req.body?.note === 'string' ? req.body.note : null;
  const signature = typeof req.body?.signature === 'string' ? req.body.signature : undefined;
  if (!ackDecision(recapId, idx, req.userId!, note, signature)) {
    return res.status(404).json({ error: '존재하지 않는 결정입니다' });
  }
  res.json({ ok: true });
});

/** 미확인자 리마인드 쿨다운 — 같은 결정에 1시간 1회 (조르기 스팸 방지). 키 = recapId:idx */
const decisionRemindLast = new Map<string, number>();

/** 결정 미확인자 리마인드 — 호스트·관리자가 버튼으로 조름. AI 총무 명의로 미확인 참가자에게만 */
router.post('/:code/decisions/remind', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (!canManageMeeting(r.meeting, req.userId!)) {
    return res.status(403).json({ error: '호스트나 관리자만 리마인드할 수 있어요' });
  }
  const recapId = Number(req.body?.recapId);
  const idx = Number(req.body?.idx);
  if (!Number.isInteger(recapId) || !Number.isInteger(idx)) {
    return res.status(400).json({ error: '잘못된 요청입니다' });
  }
  const recap = db
    .prepare('SELECT decisions FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, r.meeting.id) as { decisions: string } | undefined;
  if (!recap) return res.status(404).json({ error: '존재하지 않는 결정입니다' });
  const decision = (JSON.parse(recap.decisions) as string[])[idx];
  if (!decision) return res.status(404).json({ error: '존재하지 않는 결정입니다' });

  const key = `${recapId}:${idx}`;
  const last = decisionRemindLast.get(key) ?? 0;
  if (Date.now() - last < 60 * 60_000) {
    return res.status(429).json({ error: '이미 최근에 리마인드했어요 — 1시간 뒤에 다시' });
  }

  const acked = new Set(
    (
      db
        .prepare('SELECT user_id FROM decision_acks WHERE recap_id = ? AND decision_idx = ?')
        .all(recapId, idx) as { user_id: number }[]
    ).map((a) => a.user_id),
  );
  const parts = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
    .all(r.meeting.id) as { user_id: number }[];
  const title = (
    db.prepare('SELECT title FROM meetings WHERE id = ?').get(r.meeting.id) as { title: string }
  ).title;
  let reminded = 0;
  for (const p of parts) {
    if (acked.has(p.user_id) || p.user_id === req.userId) continue;
    notifyUser(p.user_id, {
      from: 'exist AI',
      text: `'${decision.slice(0, 60)}' 결정을 아직 확인 안 하셨어요 — 확인 부탁해요 ('${title}')`,
      kind: 'recap',
      meetingCode: String(req.params.code).toUpperCase(),
    });
    reminded++;
  }
  if (reminded > 0) decisionRemindLast.set(key, Date.now());
  res.json({ reminded });
});

/** 다음 회의 아젠다 제안 — AI 총무가 미결 기록에서 안건 초안 (참가자만, 10분 캐시) */
router.get('/:code/agenda', async (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const channelId = resolveChannel(r.meeting.id, undefined, req.userId!);
  res.json(await generateAgenda(r.meeting.id, channelId ?? 0));
});

/** 회의 채팅 히스토리 (채널당 최근 100개) — ?channel=ID, 없으면 기본 채널 */
router.get('/:code/messages', (req: AuthedRequest, res) => {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(req.params.code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return res.status(404).json({ error: '존재하지 않는 회의입니다' });

  const channelId = resolveChannel(meeting.id, req.query.channel, req.userId!);
  if (channelId == null) return res.status(404).json({ error: '존재하지 않는 채널이에요' });

  const rows = db
    .prepare(
      `SELECT m.id, m.user_id, u.username AS "from", u.avatar, m.text, m.file, m.channel_id, m.created_at FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND (m.channel_id = ? OR m.channel_id IS NULL)
       ORDER BY m.id DESC LIMIT 100`,
    )
    .all(meeting.id, channelId) as {
    id: number;
    user_id: number;
    from: string;
    avatar: string | null;
    text: string;
    file: string | null;
    channel_id: number | null;
    created_at: string;
  }[];

  // "여기까지 읽었어요" 구분선용 — 내 last_read 이후의 남이 보낸 메시지에 unread 표시
  const lastRead =
    (
      db
        .prepare('SELECT last_read FROM chat_reads WHERE user_id = ? AND meeting_id = ?')
        .get(req.userId!, meeting.id) as { last_read: number } | undefined
    )?.last_read ?? 0;

  res.json(
    rows.reverse().map((r) => ({
      id: r.id,
      from: r.from,
      avatar: r.avatar,
      text: r.text,
      file: r.file ? JSON.parse(r.file) : undefined,
      channelId: r.channel_id ?? channelId,
      ts: new Date(r.created_at + 'Z').getTime(),
      unread: r.id > lastRead && r.user_id !== req.userId ? true : undefined,
    })),
  );
});

// ── 채팅 채널 — 그룹 안에 여러 채널 (기본 "일반" 자동 생성) ──

/** 참가자 검증 헬퍼 — 채널 라우트 공용 */
type ParticipantCheck =
  | { ok: false; status: 403 | 404; error: string }
  | { ok: true; meeting: { id: number; host_id: number; org_id: number | null } };

function meetingForParticipant(code: unknown, userId: number): ParticipantCheck {
  const meeting = db
    .prepare('SELECT id, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(code ?? '').toUpperCase()) as { id: number; host_id: number; org_id: number | null } | undefined;
  if (!meeting) return { ok: false, status: 404, error: '존재하지 않는 회의입니다' };
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, userId);
  if (!isParticipant) return { ok: false, status: 403, error: '회의 참가자만 쓸 수 있어요' };
  return { ok: true, meeting };
}

/** 채널 목록 */
router.get('/:code/channels', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json(listChannels(r.meeting.id, req.userId!));
});

/** 통화 전용 채널 확보(get-or-create) — 통화 패널 채팅이 여기 물림. 참가자 누구나 */
router.get('/:code/channels/call', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  ensureDefaultChannel(r.meeting.id, req.userId!); // 기본 채널 먼저 — 통화 채널이 기본을 차지하는 일 없게
  const ch = ensureCallChannel(r.meeting.id, req.userId!);
  res.json({ id: ch.id, name: ch.name, kind: 'call' });
});

/** 채널 생성 — 참가자 누구나 */
router.post('/:code/channels', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const name = cleanChannelName(req.body?.name);
  if (!name) return res.status(400).json({ error: '채널 이름을 입력하세요' });
  ensureDefaultChannel(r.meeting.id, req.userId!);
  const dup = db
    .prepare('SELECT 1 FROM chat_channels WHERE meeting_id = ? AND name = ?')
    .get(r.meeting.id, name);
  if (dup) return res.status(409).json({ error: '이미 있는 채널 이름이에요' });
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM chat_channels WHERE meeting_id = ?').get(r.meeting.id) as {
      n: number;
    }
  ).n;
  if (count >= 20) return res.status(400).json({ error: '채널은 그룹당 20개까지예요' });
  const info = db
    .prepare('INSERT INTO chat_channels (meeting_id, name, created_by) VALUES (?, ?, ?)')
    .run(r.meeting.id, name, req.userId!);
  res.json({ id: info.lastInsertRowid, name, isDefault: false });
});

/** 채널 이름 변경 — 호스트나 만든 사람 */
router.patch('/:code/channels/:channelId', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const ch = db
    .prepare('SELECT id, created_by FROM chat_channels WHERE id = ? AND meeting_id = ?')
    .get(req.params.channelId, r.meeting.id) as { id: number; created_by: number } | undefined;
  if (!ch) return res.status(404).json({ error: '존재하지 않는 채널이에요' });
  if (ch.created_by !== req.userId && !canManageMeeting(r.meeting, req.userId!, 'group:channels')) {
    return res.status(403).json({ error: '만든 사람·호스트·조직 관리자만 바꿀 수 있어요' });
  }
  const name = cleanChannelName(req.body?.name);
  if (!name) return res.status(400).json({ error: '채널 이름을 입력하세요' });
  db.prepare('UPDATE chat_channels SET name = ? WHERE id = ?').run(name, ch.id);
  res.json({ id: ch.id, name });
});

/** 채널 삭제 — 호스트·조직 관리자, 기본 채널은 불가. 채널 메시지도 함께 삭제 */
router.delete('/:code/channels/:channelId', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  if (!canManageMeeting(r.meeting, req.userId!, 'group:channels')) {
    return res.status(403).json({ error: '호스트나 조직 관리자만 채널을 삭제할 수 있어요' });
  }
  const defaultId = ensureDefaultChannel(r.meeting.id, req.userId!);
  const id = Number(req.params.channelId);
  if (id === defaultId) return res.status(400).json({ error: '기본 채널은 삭제할 수 없어요' });
  const ch = db
    .prepare('SELECT id, kind FROM chat_channels WHERE id = ? AND meeting_id = ?')
    .get(id, r.meeting.id) as { id: number; kind: string | null } | undefined;
  if (!ch) return res.status(404).json({ error: '존재하지 않는 채널이에요' });
  // 통화 채널을 지우면 진행 중인 통화 채팅이 유실됨 — 삭제 불가
  if (ch.kind === 'call') return res.status(400).json({ error: '통화 채널은 삭제할 수 없어요' });
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(id);
  db.prepare('DELETE FROM channel_notify_prefs WHERE channel_id = ?').run(id);
  db.prepare('DELETE FROM chat_channels WHERE id = ?').run(id);
  res.json({ ok: true });
});

/** 채널 알림 설정 — 본인 것만 (all: 다 받기 / mention: @멘션만, 기본 / off: 끄기) */
router.put('/:code/channels/:channelId/notify', (req: AuthedRequest, res) => {
  const r = meetingForParticipant(req.params.code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const mode = req.body?.mode;
  if (mode !== 'all' && mode !== 'mention' && mode !== 'off') {
    return res.status(400).json({ error: '알 수 없는 알림 모드예요' });
  }
  const ch = db
    .prepare('SELECT id FROM chat_channels WHERE id = ? AND meeting_id = ?')
    .get(req.params.channelId, r.meeting.id) as { id: number } | undefined;
  if (!ch) return res.status(404).json({ error: '존재하지 않는 채널이에요' });
  setNotifyMode(req.userId!, ch.id, mode);
  res.json({ id: ch.id, notifyMode: mode });
});

export default router;
