import { Router, type Response } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { isMember } from './orgs.js';
import { emitToUser, notifyUser, isViewingDm } from './notify.js';
import { invalidateBrief } from './agent.js';
import { ensureAgentUser, answerDmQuery, AGENT_NAME, AGENT_AVATAR } from './steward.js';

/*
 * 1:1 다이렉트 메시지(DM).
 * 스코프(:scope)는 조직 id(숫자) 또는 'personal'(조직 무관, org_id NULL).
 *  - 조직 스코프: 같은 조직 active 멤버끼리만. 상대 목록 = 조직 멤버 전원.
 *  - 개인 스코프: 아무 사용자와 가능. 상대 목록 = 대화한 적 있는 사람만 (+ 이름 검색으로 새 대화).
 * 실시간 전달은 emitToUser('dm:message') — 보내는 사람의 다른 탭도 함께 동기화.
 */

const router = Router();
router.use(requireAuth);

/** :scope 검증 → { orgId }. 조직 스코프면 멤버 여부 확인. 잘못되면 res 응답 후 null */
function resolveScope(req: AuthedRequest, res: Response): { orgId: number | null } | null {
  const raw = req.params.scope;
  if (raw === 'personal') return { orgId: null };
  const orgId = Number(raw);
  if (!Number.isInteger(orgId)) {
    res.status(400).json({ error: '잘못된 조직입니다' });
    return null;
  }
  if (!isMember(orgId, req.userId!)) {
    res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
    return null;
  }
  return { orgId };
}

/** org_id 조건절 — 개인(null)은 IS NULL, 조직은 = ? */
function scopeClause(orgId: number | null): { sql: string; args: number[] } {
  return orgId == null ? { sql: 'org_id IS NULL', args: [] } : { sql: 'org_id = ?', args: [orgId] };
}

function userExists(id: number): boolean {
  return !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
}

/** 상대(userId)가 이 스코프에서 대화 가능한 사람인지 */
function peerOk(orgId: number | null, peer: number): boolean {
  return orgId == null ? userExists(peer) : isMember(orgId, peer);
}

/** 대화 목록.
 *  조직: 멤버 전원 + (있으면) 마지막 메시지·안읽음.  개인: 대화한 적 있는 상대만. */
router.get('/:scope/threads', (req: AuthedRequest, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { orgId } = scope;
  const me = req.userId!;
  const sc = scopeClause(orgId);

  // 상대별 마지막 메시지 id
  const lastIds = db
    .prepare(
      `SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS partner, MAX(id) AS last_id
       FROM dm_messages
       WHERE ${sc.sql} AND (from_id = ? OR to_id = ?)
       GROUP BY partner`,
    )
    .all(me, ...sc.args, me, me) as { partner: number; last_id: number }[];

  const lastById = new Map<number, { text: string; ts: number; fromId: number }>();
  for (const { partner, last_id } of lastIds) {
    const m = db
      .prepare('SELECT text, from_id, created_at FROM dm_messages WHERE id = ?')
      .get(last_id) as { text: string; from_id: number; created_at: string } | undefined;
    if (m) {
      lastById.set(partner, {
        text: m.text,
        ts: new Date(m.created_at + 'Z').getTime(),
        fromId: m.from_id,
      });
    }
  }

  // 상대별 안읽음(나에게 온, 안읽은) 수
  const unreadRows = db
    .prepare(
      `SELECT from_id AS partner, COUNT(*) AS n
       FROM dm_messages
       WHERE ${sc.sql} AND to_id = ? AND read = 0
       GROUP BY from_id`,
    )
    .all(...sc.args, me) as { partner: number; n: number }[];
  const unreadById = new Map(unreadRows.map((r) => [r.partner, r.n]));

  // 상대 후보 — 조직은 멤버 전원, 개인은 대화한 상대만
  let base: {
    user_id: number;
    username: string;
    avatar: string | null;
    position: string | null;
    department: string | null;
  }[];

  if (orgId != null) {
    base = db
      .prepare(
        `SELECT u.id AS user_id, u.username, u.avatar, om.position, om.department
         FROM organization_members om JOIN users u ON u.id = om.user_id
         WHERE om.org_id = ? AND om.status = 'active' AND u.id != ?`,
      )
      .all(orgId, me) as typeof base;
  } else {
    const ids = [...lastById.keys()];
    base = ids.length
      ? (db
          .prepare(
            `SELECT id AS user_id, username, avatar, NULL AS position, NULL AS department
             FROM users WHERE id IN (${ids.map(() => '?').join(',')})`,
          )
          .all(...ids) as typeof base)
      : [];
  }

  // exist AI 항목 상시 노출 — 통합 메시지에서 총무에게 바로 1:1 질문 (조직·개인 스코프 공통)
  const agentId = ensureAgentUser();
  if (!base.some((b) => b.user_id === agentId)) {
    const au = db
      .prepare('SELECT id AS user_id, username, avatar FROM users WHERE id = ?')
      .get(agentId) as { user_id: number; username: string; avatar: string | null } | undefined;
    if (au) base.unshift({ ...au, position: 'AI 총무', department: null });
  }

  const threads = base.map((m) => {
    const last = lastById.get(m.user_id);
    return {
      userId: m.user_id,
      username: m.username,
      avatar: m.avatar,
      position: m.position,
      department: m.department,
      lastText: last?.text ?? null,
      lastTs: last?.ts ?? null,
      lastMine: last ? last.fromId === me : false,
      unread: unreadById.get(m.user_id) ?? 0,
    };
  });

  // 대화 있는 상대 먼저(최근순), 없는 상대는 이름순
  threads.sort((a, b) => {
    if (a.lastTs && b.lastTs) return b.lastTs - a.lastTs;
    if (a.lastTs) return -1;
    if (b.lastTs) return 1;
    return a.username.localeCompare(b.username, 'ko');
  });

  res.json(threads);
});

/** 새 대화 상대 검색 — 개인: 전체 사용자(본인 제외), 조직: 그 조직 active 멤버 */
router.get('/:scope/search', (req: AuthedRequest, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { orgId } = scope;
  const me = req.userId!;
  const q = String(req.query.q ?? '').trim();
  if (!q) return res.json([]);

  let rows: { userId: number; username: string; avatar: string | null }[];
  if (orgId == null) {
    rows = db
      .prepare(
        `SELECT id AS userId, username, avatar FROM users
         WHERE username LIKE ? AND id != ?
         ORDER BY CASE WHEN username = ? THEN 0 WHEN username LIKE ? THEN 1 ELSE 2 END, username
         LIMIT 8`,
      )
      .all(`%${q}%`, me, q, `${q}%`) as typeof rows;
  } else {
    rows = db
      .prepare(
        `SELECT u.id AS userId, u.username, u.avatar FROM users u
         JOIN organization_members om ON om.user_id = u.id
         WHERE om.org_id = ? AND om.status = 'active' AND u.id != ? AND u.username LIKE ?
         ORDER BY CASE WHEN u.username = ? THEN 0 WHEN u.username LIKE ? THEN 1 ELSE 2 END, u.username
         LIMIT 8`,
      )
      .all(orgId, me, `%${q}%`, q, `${q}%`) as typeof rows;
  }
  res.json(rows);
});

/** 스코프 전체 DM 안읽음 수 — 대시보드 배지용 */
router.get('/:scope/unread', (req: AuthedRequest, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const sc = scopeClause(scope.orgId);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM dm_messages WHERE ${sc.sql} AND to_id = ? AND read = 0`)
    .get(...sc.args, req.userId!) as { n: number };
  res.json({ unread: row.n });
});

/** 특정 상대와의 대화 히스토리(최근 200개) — 가져오면서 그 상대가 보낸 메시지는 읽음 처리 */
router.get('/:scope/with/:userId', (req: AuthedRequest, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { orgId } = scope;
  const me = req.userId!;
  const peer = Number(req.params.userId);
  if (!Number.isInteger(peer)) return res.status(400).json({ error: '잘못된 상대입니다' });
  // exist AI는 조직 멤버가 아니어도 어느 스코프에서나 대화 가능 — POST와 같은 예외 (없으면 조직 스코프 히스토리가 404)
  if (peer !== ensureAgentUser() && !peerOk(orgId, peer)) {
    return res.status(404).json({ error: '상대를 찾을 수 없어요' });
  }
  const sc = scopeClause(orgId);

  const rows = db
    .prepare(
      `SELECT m.id, m.from_id, m.to_id, m.text, m.read, m.created_at, u.username, u.avatar
       FROM dm_messages m JOIN users u ON u.id = m.from_id
       WHERE ${sc.sql}
         AND ((m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?))
       ORDER BY m.id DESC LIMIT 200`,
    )
    .all(...sc.args, me, peer, peer, me) as {
    id: number;
    from_id: number;
    to_id: number;
    text: string;
    read: number;
    created_at: string;
    username: string;
    avatar: string | null;
  }[];

  // 상대가 보낸 메시지 읽음 처리 — 응답에는 읽음 처리 "전" 상태(unread)를 실어
  // 클라가 "여기까지 읽었어요" 구분선을 그릴 수 있게 한다
  db.prepare(
    `UPDATE dm_messages SET read = 1 WHERE ${sc.sql} AND from_id = ? AND to_id = ? AND read = 0`,
  ).run(...sc.args, peer, me);

  res.json(
    rows.reverse().map((r) => ({
      id: r.id,
      fromId: r.from_id,
      from: r.username,
      avatar: r.avatar,
      mine: r.from_id === me,
      text: r.text,
      ts: new Date(r.created_at + 'Z').getTime(),
      unread: r.from_id === peer && r.read === 0 ? true : undefined,
    })),
  );
});

/** 특정 상대가 보낸 메시지를 읽음 처리 — 대화창이 열려 있을 때 실시간 수신분 정리용 */
router.post('/:scope/with/:userId/read', (req: AuthedRequest, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const peer = Number(req.params.userId);
  if (!Number.isInteger(peer)) return res.status(400).json({ error: '잘못된 상대입니다' });
  const sc = scopeClause(scope.orgId);
  db.prepare(
    `UPDATE dm_messages SET read = 1 WHERE ${sc.sql} AND from_id = ? AND to_id = ? AND read = 0`,
  ).run(...sc.args, peer, req.userId!);
  invalidateBrief(req.userId!); // 안읽음 수가 바뀜 — 브리핑 갱신
  res.json({ ok: true });
});

/** 메시지 전송 — 저장 후 받는 사람·보낸 사람 모든 소켓에 dm:message 푸시 */
router.post('/:scope/with/:userId', (req: AuthedRequest, res) => {
  const scope = resolveScope(req, res);
  if (!scope) return;
  const { orgId } = scope;
  const me = req.userId!;
  const peer = Number(req.params.userId);
  if (!Number.isInteger(peer) || peer === me) {
    return res.status(400).json({ error: '잘못된 상대입니다' });
  }
  // exist AI는 조직 멤버가 아니어도 어느 스코프에서나 대화 가능 (총무 1:1 질의)
  const agentId = ensureAgentUser();
  if (peer !== agentId && !peerOk(orgId, peer)) {
    return res.status(404).json({ error: '상대를 찾을 수 없어요' });
  }

  const text = String(req.body?.text ?? '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ error: '메시지를 입력하세요' });

  const info = db
    .prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text) VALUES (?, ?, ?, ?)')
    .run(orgId, me, peer, text);
  const id = info.lastInsertRowid as number;
  const ts = Date.now();
  const myAvatar = (
    db.prepare('SELECT avatar FROM users WHERE id = ?').get(me) as { avatar: string | null }
  )?.avatar;

  const payload = {
    id,
    orgId, // 개인 DM이면 null
    fromId: me,
    toId: peer,
    from: req.username,
    avatar: myAvatar ?? null,
    text,
    ts,
  };
  // 받는 사람 + 보낸 사람의 다른 탭 모두 동기화
  emitToUser(peer, 'dm:message', payload);
  emitToUser(me, 'dm:message', payload);
  invalidateBrief(peer); // 받는 쪽 안읽음이 늘었다 — 브리핑 갱신

  // 알림 센터·웹푸시 연결 — 메시지마다 알림, 단 이 DM 창을 보고 있는 중이면 생략 (7/27 버스트 억제 제거, 주호 결정)
  // AI가 상대면 알림 불필요 (사람 아님)
  if (peer !== agentId && !isViewingDm(peer, me)) {
    notifyUser(peer, {
      from: req.username!,
      text: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      kind: 'dm',
    });
  }

  res.json(payload);

  // ── exist AI 1:1 질의 — 상대가 총무면 스코프 기록 기반으로 답장 (비동기, 응답을 막지 않음) ──
  if (peer === agentId) {
    void (async () => {
      try {
        const answer = await answerDmQuery(orgId, me, text);
        const aInfo = db
          .prepare('INSERT INTO dm_messages (org_id, from_id, to_id, text) VALUES (?, ?, ?, ?)')
          .run(orgId, agentId, me, answer);
        const aPayload = {
          id: aInfo.lastInsertRowid as number,
          orgId,
          fromId: agentId,
          toId: me,
          from: AGENT_NAME,
          avatar: AGENT_AVATAR,
          text: answer,
          ts: Date.now(),
        };
        emitToUser(me, 'dm:message', aPayload);
        invalidateBrief(me);
      } catch (err) {
        console.error('[steward] DM 답변 실패:', err);
      }
    })();
  }
});

export default router;
