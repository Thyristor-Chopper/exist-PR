import 'dotenv/config';
import http from 'node:http';
import { Server } from 'socket.io';
import db from './db.js';
import { startMediasoup, attachSfu } from './sfu.js';
import { eventOccurrenceOnOrAfter } from './meetings.js';
import { getUserContext } from './agent.js';
import { attachYjs } from './ydoc.js';
import { initNotifier, notifyUser, emitToUser } from './notify.js';
import { setBlobViewing, clearBlobViewing } from './files.js';
import { sweepHandoverEscalations } from './handover.js';
import { ensureAgentUser } from './steward.js';
import { runTodoReminders } from './todos.js';
import { runDecisionReminders } from './recap.js';
import { createApp } from './app.js';

const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

const app = createApp();
const server = http.createServer(app);

// AI 유저 확보 + 아바타 마이그레이션(🤖→✦)이 부팅 시 바로 적용되게
ensureAgentUser();

// Socket.IO — SFU 시그널링 + presence + nowbar 알림 push
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN },
  // 탭 강제 종료·모바일 백그라운드 같은 비정상 이탈 감지 시간 단축 (기본 25s+20s ≈ 최대 45초 → 최대 ~15초)
  // 통화 인원 표시가 이 감지에 걸려 있어서 기본값이면 "나갔는데 한참 남아 있는" 것처럼 보인다
  pingInterval: 10_000,
  pingTimeout: 5_000,
});

// 소켓 인증: handshake.auth.token으로 세션 검증
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error('unauthorized'));
  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-30 days')`,
    )
    .get(token) as { user_id: number; username: string } | undefined;
  if (!row) return next(new Error('unauthorized'));
  socket.data.userId = row.user_id;
  socket.data.username = row.username;
  next();
});

attachSfu(io);
attachYjs(server); // tldraw /sync 제거 — 캔버스는 Excalidraw가 /yjs 사용
initNotifier(io); // orgs 등 라우터에서 notifyUser 사용 가능하게

// 인수인계 미확인 에스컬레이션 — 10분마다 스윕 (기동 30초 뒤 1회 선실행)
setTimeout(() => {
  try {
    sweepHandoverEscalations();
  } catch (err) {
    console.error('[handover] 에스컬레이션 스윕 실패:', err);
  }
}, 30_000);
setInterval(() => {
  try {
    sweepHandoverEscalations();
  } catch (err) {
    console.error('[handover] 에스컬레이션 스윕 실패:', err);
  }
}, 10 * 60_000);

/* ── 출근 브리핑 — 4시간 이상 자리를 비웠다 돌아오면(교대 출근의 신호) 밀린 확인거리를 한 번에.
 * 교대 누락의 타이밍 해법: 자는 사람에게 낮에 쏜 알림은 묻힌다 — 출근 순간에 다시 모아준다 */
const welcomedAt = new Map<number, number>();
function sendShiftBriefing(userId: number) {
  const recaps = db
    .prepare(
      `SELECT r.id, r.decisions FROM meeting_recaps r
       JOIN meeting_participants mp ON mp.meeting_id = r.meeting_id
       WHERE mp.user_id = ? AND r.created_at > datetime('now', '-3 days')`,
    )
    .all(userId) as { id: number; decisions: string }[];
  const ackStmt = db.prepare(
    'SELECT COUNT(DISTINCT decision_idx) AS n FROM decision_acks WHERE recap_id = ? AND user_id = ?',
  );
  let pendingDecisions = 0;
  for (const r of recaps) {
    let total = 0;
    try {
      total = (JSON.parse(r.decisions) as string[]).length;
    } catch {
      /* 구형 데이터 */
    }
    if (!total) continue;
    pendingDecisions += Math.max(0, total - (ackStmt.get(r.id, userId) as { n: number }).n);
  }
  const pendingHandover = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM handovers h
         JOIN meeting_participants mp ON mp.meeting_id = h.meeting_id
         WHERE mp.user_id = ? AND h.author_id != ? AND h.created_at > datetime('now', '-3 days')
           AND NOT EXISTS (SELECT 1 FROM handover_acks a WHERE a.handover_id = h.id AND a.user_id = ?)`,
      )
      .get(userId, userId, userId) as { n: number }
  ).n;
  if (pendingDecisions + pendingHandover === 0) return;
  const parts = [
    pendingDecisions ? `미확인 결정 ${pendingDecisions}건` : null,
    pendingHandover ? `인수인계 ${pendingHandover}건` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  notifyUser(userId, {
    from: 'exist AI',
    text: `출근 브리핑 — 자리 비운 사이 ${parts}이 기다리고 있어요. 작업 전에 확인해 주세요.`,
    kind: 'recap',
    meetingCode: '',
  });
}

// ── presence: 접속 중인 사용자 (exist의 존재감 레이어) ──
const online = new Map<number, { username: string; count: number }>();

function broadcastPresence() {
  io.emit('presence:update', { users: [...online.values()].map((u) => u.username) });
}

io.on('connection', (socket) => {
  const userId = socket.data.userId as number;
  const username = socket.data.username as string;
  const entry = online.get(userId);
  if (entry) entry.count++;
  else online.set(userId, { username, count: 1 });
  broadcastPresence();

  // 출근 브리핑 트리거 — 마지막 접속에서 4시간+ 지났고, 최근 4시간 내 브리핑한 적 없으면
  try {
    const last = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(userId) as
      | { last_seen_at: string | null }
      | undefined;
    const awayMs = last?.last_seen_at
      ? Date.now() - new Date(last.last_seen_at + 'Z').getTime()
      : 0;
    if (awayMs >= 4 * 3600_000 && Date.now() - (welcomedAt.get(userId) ?? 0) >= 4 * 3600_000) {
      welcomedAt.set(userId, Date.now());
      setTimeout(() => {
        try {
          sendShiftBriefing(userId);
        } catch (err) {
          console.error('[brief] 출근 브리핑 실패:', err);
        }
      }, 2500);
    }
  } catch {
    /* best effort */
  }

  // DM 창 열람 상태 — 보고 있는 상대의 메시지는 알림(notifyUser) 생략용
  socket.on('dm:viewing', (p: { peerId?: number | null } | undefined) => {
    const id = Number(p?.peerId);
    socket.data.dmPeer = Number.isInteger(id) ? id : null;
  });

  // 그룹 채팅 화면 열람 상태 — 채팅 알림 생략 판정용.
  // chat:CODE 룸 멤버십은 판정에 못 씀 (통합 메시지함이 전달용으로 전 그룹 룸을 구독함)
  socket.on('chat:viewing', (p: { code?: string | null } | undefined) => {
    socket.data.chatViewing = p?.code ? String(p.code).toUpperCase() : null;
  });

  // 업로드 파일 미리보기 열람 신고 — "누가 지금 이 파일을 보고 있나" (30초 심박, null=떠남)
  socket.on('file:viewing', (p: { code?: string; fileId?: number | null } | undefined) => {
    const code = p?.code ? String(p.code).toUpperCase() : null;
    if (!code) return;
    const meeting = db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as
      | { id: number }
      | undefined;
    if (!meeting) return;
    const isPart = db
      .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
      .get(meeting.id, userId);
    if (!isPart) return;
    const fid = Number(p?.fileId);
    setBlobViewing(meeting.id, userId, Number.isInteger(fid) && fid > 0 ? fid : null);
    // 참가자들에게 재조회 핑 — 편집 프레즌스(ydoc pingPresence)와 같은 채널
    const parts = db
      .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
      .all(meeting.id) as { user_id: number }[];
    for (const q of parts) emitToUser(q.user_id, 'files:presence', { code });
  });

  // 탭 가시성 — 접속 소켓이 있어도 전부 백그라운드면 웹푸시(OS 알림)를 쏘기 위한 신호.
  // 구버전 클라(신호 안 보냄)는 true로 남아 기존 동작(접속 중이면 푸시 생략) 유지
  socket.data.visible = true;
  socket.on('presence:visible', (p: { visible?: boolean } | undefined) => {
    socket.data.visible = p?.visible !== false;
  });

  socket.on('disconnect', () => {
    const e = online.get(userId);
    if (!e) return;
    e.count--;
    if (e.count <= 0) {
      online.delete(userId);
      clearBlobViewing(userId); // 마지막 소켓까지 끊김 — 미리보기 시청 상태 정리
      // 마지막 소켓이 끊긴 시각 = "자리를 비운 시점" — P2 놓친 것 브리핑의 기준
      db.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).run(userId);
    }
    broadcastPresence();
  });
});

app.get('/api/presence', (_req, res) => {
  res.json({ users: [...online.values()].map((u) => u.username) });
});

// ── AI agent 푸시 알림: 회의 시작 30분/10분 전 리마인더 ──
const notified = new Set<string>(); // `${userId}:${meetingTitle}:${threshold}`

setInterval(() => {
  const now = new Date();
  // 접속 여부와 무관하게 회의 참가자 전원 검사 — 오프라인이면 notifyUser가 웹푸시로 배달
  const userIds = (
    db.prepare('SELECT DISTINCT user_id FROM meeting_participants').all() as { user_id: number }[]
  ).map((r) => r.user_id);
  for (const userId of userIds) {
    const ctx = getUserContext(userId);
    for (const m of ctx.meetings) {
      if (!m.starts_at) continue;
      const min = Math.round((new Date(m.starts_at).getTime() - now.getTime()) / 60_000);
      // 걸린 임계값(30/10분)을 모두 소진 처리하되 알림은 한 번만 (중복 토스트 방지)
      const due = [30, 10].filter(
        (t) => min <= t && min > 0 && !notified.has(`${userId}:${m.title}:${t}`),
      );
      if (due.length > 0) {
        due.forEach((t) => notified.add(`${userId}:${m.title}:${t}`));
        // 알림함에 영속 + 접속 소켓에 푸시
        notifyUser(userId, {
          from: 'exist AI',
          text: `"${m.title}" 회의가 ${min}분 뒤에 시작돼요`,
          meetingCode: m.code,
        });
      }
    }

    // 회의 일정 이벤트(통화 등, 시간 있는 것) 리마인더 — 기본 30/10분 전, remind 지정 시 그 시점만 (0=끔)
    const events = db
      .prepare(
        `SELECT e.id AS eid, e.title AS etitle, e.date, e.time, e.is_call, e.remind, e.recur, e.recur_until, m.code, m.title AS mtitle
         FROM meeting_events e
         JOIN meetings m ON m.id = e.meeting_id
         JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.user_id = ? AND e.time IS NOT NULL`,
      )
      .all(userId) as {
      eid: number;
      etitle: string;
      date: string;
      time: string;
      is_call: number;
      remind: number | null;
      recur: string | null;
      recur_until: string | null;
      code: string;
      mtitle: string;
    }[];
    const todayY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    for (const ev of events) {
      // 반복 일정은 오늘 이후 첫 occurrence 기준 (키에 날짜 포함 — 회차마다 새로 알림)
      const effDate = ev.recur
        ? eventOccurrenceOnOrAfter(ev.date, ev.recur, ev.recur_until, todayY)
        : ev.date;
      if (!effDate) continue;
      const start = new Date(`${effDate}T${ev.time}`);
      const min = Math.round((start.getTime() - now.getTime()) / 60_000);
      const thresholds = ev.remind == null ? [30, 10] : ev.remind === 0 ? [] : [ev.remind];
      const due = thresholds.filter(
        (t) => min <= t && min > 0 && !notified.has(`${userId}:ev${ev.eid}:${effDate}:${t}`),
      );
      if (due.length > 0) {
        due.forEach((t) => notified.add(`${userId}:ev${ev.eid}:${effDate}:${t}`));
        // 1시간 이상 남은 알림(1시간·2시간·하루 전)은 분 대신 시간/일로
        const lead =
          min >= 1440
            ? `${Math.round(min / 1440)}일 뒤`
            : min >= 60
              ? `${Math.round(min / 60)}시간 뒤`
              : `${min}분 뒤`;
        notifyUser(userId, {
          from: 'exist AI',
          text: ev.is_call
            ? `'${ev.etitle}' 통화 ${lead} 시작 — 들어오세요 (${ev.mtitle})`
            : `'${ev.etitle}' ${lead} 시작 — ${ev.mtitle}`,
          meetingCode: ev.code,
          kind: ev.is_call ? 'call' : undefined,
        });
      }
    }

    // 하루 종일 일정(시간 없음) — 당일 오전 9시 이후 한 번 알림 (애플식 아침 리마인더)
    if (now.getHours() >= 9) {
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const alldays = db
        .prepare(
          `SELECT e.id AS eid, e.title AS etitle, e.date, e.recur, e.recur_until, m.code, m.title AS mtitle
           FROM meeting_events e
           JOIN meetings m ON m.id = e.meeting_id
           JOIN meeting_participants mp ON mp.meeting_id = m.id
           WHERE mp.user_id = ? AND e.time IS NULL AND (e.date = ? OR e.recur IS NOT NULL)`,
        )
        .all(userId, today) as {
        eid: number;
        etitle: string;
        date: string;
        recur: string | null;
        recur_until: string | null;
        code: string;
        mtitle: string;
      }[];
      for (const ev of alldays) {
        // 반복이면 오늘이 occurrence인 날만
        const eff = ev.recur
          ? eventOccurrenceOnOrAfter(ev.date, ev.recur, ev.recur_until, today)
          : ev.date;
        if (eff !== today) continue;
        const key = `${userId}:ev${ev.eid}:allday:${today}`;
        if (notified.has(key)) continue;
        notified.add(key);
        notifyUser(userId, {
          from: 'exist AI',
          text: `오늘 하루 종일 — '${ev.etitle}' (${ev.mtitle})`,
          meetingCode: ev.code,
        });
      }
    }
  }
}, 60_000);

// 할 일 마감 리마인드 — AI 총무가 임박(내일·오늘)·지남을 알아서 조름. 부팅 직후 1회 + 10분 간격
setTimeout(() => {
  try {
    runTodoReminders();
  } catch (err) {
    console.error('[todos] 마감 리마인드 실패:', err);
  }
}, 20_000);
setInterval(() => {
  try {
    runTodoReminders();
  } catch (err) {
    console.error('[todos] 마감 리마인드 실패:', err);
  }
}, 10 * 60_000);

// 미확인자 리마인드 — 원장에 서명이 없는 참가자를 recap당 1회 보챈다 (현장 요구: "미확인자 알림")
setInterval(() => {
  try {
    runDecisionReminders();
  } catch (err) {
    console.error('[recap] 리마인드 실패:', err);
  }
}, 10 * 60_000);

const PORT = Number(process.env.PORT ?? 4000);
startMediasoup().then(() => {
  server.listen(PORT, () => {
    console.log(`exist server listening on http://localhost:${PORT}`);
  });
});
