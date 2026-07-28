import { Router } from 'express';
import OpenAI from 'openai';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { isMember } from './orgs.js';

/*
 * exist 팀 인사이트 — 조직의 협업 데이터(회의·할 일·통화·채팅)를 집계하고
 * AI가 팀 상태를 진단(요약·리스크·추천)한다.
 * OPENAI_API_KEY 있으면 OpenAI, 없으면 규칙 기반 폴백. (agent.ts와 동일 패턴)
 * GET /api/insights/:orgId  — 해당 조직의 active 멤버만.
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const PERIOD_DAYS = 14;
// ESG 환산 계수 (공신력 출처 — 임의 수치 아님):
//  - 왕복 통근 17.3km·73분: 2024년 통신3사 모바일 데이터 기반 직장인 출퇴근 평균(이투데이/국민일보)
//  - 승용차 125.2g CO₂/km: 환경부·국립환경과학원 2020년 승용 평균 실배출량
export const COMMUTE_ROUND_KM = 17.3;
export const COMMUTE_ROUND_MIN = 73;
export const CAR_CO2_G_PER_KM = 125.2;

/**
 * ESG 환산 — 원격근무 person-day(통근 대체 횟수)를 통근거리·CO₂·시간 절감으로.
 * 순수함수(테스트 대상). 소수 첫째 자리 반올림.
 */
export function esgFromCommutes(replaced: number): {
  replacedCommutes: number;
  savedKm: number;
  savedCo2Kg: number;
  savedHours: number;
} {
  const savedKm = Math.round(replaced * COMMUTE_ROUND_KM * 10) / 10;
  const savedCo2Kg = Math.round(((savedKm * CAR_CO2_G_PER_KM) / 1000) * 10) / 10;
  const savedHours = Math.round(((replaced * COMMUTE_ROUND_MIN) / 60) * 10) / 10;
  return { replacedCommutes: replaced, savedKm, savedCo2Kg, savedHours };
}

export interface OrgMetrics {
  orgName: string;
  periodDays: number;
  memberCount: number;
  meetingCount: number;
  todos: { total: number; done: number; overdue: number; completionRate: number };
  calls: { count: number; totalMinutes: number };
  activity: { calls: number; messages: number };
  participation: { username: string; messages: number }[];
  quietMembers: string[];
  esg: {
    replacedCommutes: number; // 원격근무 person-day 추정(통근 대체 횟수)
    savedKm: number;
    savedCo2Kg: number;
    savedHours: number;
  };
  trends: {
    activityTrend: 'up' | 'down' | 'flat'; // 최근 7일 vs 이전 7일
    msgRecent: number;
    msgPrev: number;
    callRecent: number;
    callPrev: number;
  };
  signals: {
    soonDue: number; // 3일 내 마감 미완료
    nightRatio: number; // 야간(22~06시) 메시지 비율 %
    topShare: number; // 상위 1인 메시지 점유율 %
    callMinPerMember: number; // 인당 통화 시간(분)
  };
}

function collectOrgMetrics(orgId: number): OrgMetrics | null {
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as
    | { name: string }
    | undefined;
  if (!org) return null;

  const since = new Date(Date.now() - PERIOD_DAYS * 86_400_000).toISOString();
  const sinceDate = since.slice(0, 10);

  const meetings = db.prepare('SELECT id FROM meetings WHERE org_id = ?').all(orgId) as {
    id: number;
  }[];
  const mids = meetings.map((m) => m.id);
  const ph = mids.map(() => '?').join(',');

  const members = db
    .prepare(
      `SELECT u.username FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.status = 'active'`,
    )
    .all(orgId) as { username: string }[];

  // 할 일 진척 (조직 회의에 속한 todo)
  const todoRows = mids.length
    ? (db
        .prepare(`SELECT done, due_at FROM todos WHERE meeting_id IN (${ph})`)
        .all(...mids) as { done: number; due_at: string | null }[])
    : [];
  const total = todoRows.length;
  const done = todoRows.filter((t) => t.done).length;
  const now = Date.now();
  const overdue = todoRows.filter(
    (t) => !t.done && t.due_at && new Date(t.due_at).getTime() < now,
  ).length;

  // 통화 이벤트 (기간 내) — 횟수·총 시간(분)
  const callRows = mids.length
    ? (db
        .prepare(
          `SELECT time, end_time FROM meeting_events
           WHERE meeting_id IN (${ph}) AND is_call = 1 AND date >= ?`,
        )
        .all(...mids, sinceDate) as { time: string | null; end_time: string | null }[])
    : [];
  let totalMinutes = 0;
  for (const c of callRows) {
    if (c.time && c.end_time) {
      const [sh, sm] = c.time.split(':').map(Number);
      const [eh, em] = c.end_time.split(':').map(Number);
      const d = eh * 60 + em - (sh * 60 + sm);
      if (d > 0) totalMinutes += d;
    }
  }

  // 채팅 활동 + 멤버별 참여 분포 (기간 내)
  const msgRows = mids.length
    ? (db
        .prepare(
          `SELECT u.username AS username, COUNT(*) AS cnt FROM messages msg
           JOIN users u ON u.id = msg.user_id
           WHERE msg.meeting_id IN (${ph}) AND msg.created_at >= ?
           GROUP BY msg.user_id`,
        )
        .all(...mids, since) as { username: string; cnt: number }[])
    : [];
  const messages = msgRows.reduce((s, r) => s + r.cnt, 0);
  const active = new Set(msgRows.map((r) => r.username));
  const quietMembers = members.map((m) => m.username).filter((u) => !active.has(u));

  // ESG: 원격근무 person-day 추정 = 회의에 참여한 (멤버, 날짜) 고유 수
  // (exist로 원격 회의한 날 = 출근 1회 대체로 가정 — SKT 사회적 가치 환산 방법론)
  const replaced = mids.length
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT DISTINCT mp.user_id, date(mp.joined_at) AS d
               FROM meeting_participants mp
               WHERE mp.meeting_id IN (${ph}) AND mp.joined_at >= ?
             )`,
          )
          .get(...mids, since) as { n: number }
      ).n
    : 0;
  const esg = esgFromCommutes(replaced);

  // ── 추세·예측 신호 ──
  const weekAgoIso = new Date(now - 7 * 86_400_000).toISOString();
  const weekAgoDate = weekAgoIso.slice(0, 10);

  // 활동 추세: 최근 7일 vs 이전 7일 (메시지 + 통화 가중)
  const msgRecent = mids.length
    ? (
        db
          .prepare(`SELECT COUNT(*) n FROM messages WHERE meeting_id IN (${ph}) AND created_at >= ?`)
          .get(...mids, weekAgoIso) as { n: number }
      ).n
    : 0;
  const msgPrev = Math.max(0, messages - msgRecent);
  const callRecent = mids.length
    ? (
        db
          .prepare(
            `SELECT COUNT(*) n FROM meeting_events WHERE meeting_id IN (${ph}) AND is_call=1 AND date >= ?`,
          )
          .get(...mids, weekAgoDate) as { n: number }
      ).n
    : 0;
  const callPrev = Math.max(0, callRows.length - callRecent);
  const recentAct = msgRecent + callRecent * 5;
  const prevAct = msgPrev + callPrev * 5;
  const activityTrend: 'up' | 'down' | 'flat' =
    prevAct === 0
      ? recentAct > 0
        ? 'up'
        : 'flat'
      : recentAct > prevAct * 1.15
        ? 'up'
        : recentAct < prevAct * 0.85
          ? 'down'
          : 'flat';

  // 마감 임박(3일 내) 미완료 — 지연 위험 신호
  const soonLimit = now + 3 * 86_400_000;
  const soonDue = todoRows.filter(
    (t) => !t.done && t.due_at && new Date(t.due_at).getTime() <= soonLimit,
  ).length;

  // 야간(현지 22~06시) 메시지 비율 — 번아웃 신호
  const nightMsg = mids.length
    ? (
        db
          .prepare(
            `SELECT COUNT(*) n FROM messages
             WHERE meeting_id IN (${ph}) AND created_at >= ?
               AND (CAST(strftime('%H', created_at, '+9 hours') AS INTEGER) >= 22
                 OR CAST(strftime('%H', created_at, '+9 hours') AS INTEGER) < 6)`,
          )
          .get(...mids, since) as { n: number }
      ).n
    : 0;
  const nightRatio = messages > 0 ? Math.round((nightMsg / messages) * 100) : 0;
  const topMsg = msgRows.length ? Math.max(...msgRows.map((r) => r.cnt)) : 0;
  const topShare = messages > 0 ? Math.round((topMsg / messages) * 100) : 0;
  const callMinPerMember = members.length ? Math.round(totalMinutes / members.length) : 0;

  return {
    orgName: org.name,
    periodDays: PERIOD_DAYS,
    memberCount: members.length,
    meetingCount: mids.length,
    todos: {
      total,
      done,
      overdue,
      completionRate: total ? Math.round((done / total) * 100) : 0,
    },
    calls: { count: callRows.length, totalMinutes },
    activity: { calls: callRows.length, messages },
    participation: msgRows
      .map((r) => ({ username: r.username, messages: r.cnt }))
      .sort((a, b) => b.messages - a.messages),
    quietMembers,
    esg,
    trends: { activityTrend, msgRecent, msgPrev, callRecent, callPrev },
    signals: { soonDue, nightRatio, topShare, callMinPerMember },
  };
}

export interface Insights {
  summary: string;
  trend: string;
  burnoutRisk: { level: string; reason: string };
  delayRisk: { level: string; reason: string };
  risks: string[];
  recommendations: string[];
}

/** 규칙 기반 폴백 — API 키 없거나 AI 실패 시. 순수함수(metrics→insights, 테스트 대상) */
export function ruleBasedInsights(m: OrgMetrics): Insights {
  const risks: string[] = [];
  const recs: string[] = [];

  if (m.todos.total > 0 && m.todos.completionRate < 50)
    risks.push(`할 일 완료율 ${m.todos.completionRate}%로 낮음`);
  if (m.todos.overdue > 0) risks.push(`마감 지난 미완료 할 일 ${m.todos.overdue}건`);
  if (m.quietMembers.length > 0)
    risks.push(`최근 ${m.periodDays}일 활동 없는 멤버 ${m.quietMembers.length}명`);

  if (m.todos.overdue > 0) recs.push('마감 지난 할 일부터 점검하세요');
  if (m.quietMembers.length > 0) recs.push('참여 저조 멤버와 진행상황 동기화 필요');
  if (m.meetingCount > 0 && m.activity.messages === 0)
    recs.push('비동기 소통(채팅/문서) 활용을 늘려보세요');

  const summary =
    `최근 ${m.periodDays}일 동안 회의 ${m.meetingCount}개, 할 일 완료율 ` +
    `${m.todos.completionRate}%(${m.todos.done}/${m.todos.total}), 통화 ${m.calls.count}회 진행됐습니다.`;

  const trend =
    m.trends.activityTrend === 'up'
      ? '최근 7일 활동이 이전보다 늘었습니다'
      : m.trends.activityTrend === 'down'
        ? '최근 7일 활동이 이전보다 줄었습니다'
        : '최근 활동이 이전과 비슷하게 유지되고 있습니다';

  const burnoutLevel =
    m.signals.nightRatio >= 30 || m.signals.callMinPerMember >= 150 || m.signals.topShare >= 70
      ? '높음'
      : m.signals.nightRatio >= 15 || m.signals.callMinPerMember >= 80 || m.signals.topShare >= 55
        ? '보통'
        : '낮음';
  const burnoutReason =
    m.signals.nightRatio >= 15
      ? `야간 활동 ${m.signals.nightRatio}%`
      : m.signals.topShare >= 55
        ? `특정 멤버 편중 ${m.signals.topShare}%`
        : m.signals.callMinPerMember >= 80
          ? `인당 통화 ${m.signals.callMinPerMember}분`
          : '과부하 신호 낮음';

  const delayLevel =
    m.todos.overdue > 0 || (m.todos.total > 0 && m.todos.completionRate < 40)
      ? '높음'
      : m.signals.soonDue > 0 || m.trends.activityTrend === 'down'
        ? '보통'
        : '낮음';
  const delayReason =
    m.todos.overdue > 0
      ? `마감 지난 할 일 ${m.todos.overdue}건`
      : m.signals.soonDue > 0
        ? `임박 마감 ${m.signals.soonDue}건`
        : m.todos.total > 0 && m.todos.completionRate < 40
          ? `완료율 ${m.todos.completionRate}%`
          : '지연 신호 낮음';

  return {
    summary,
    trend,
    burnoutRisk: { level: burnoutLevel, reason: burnoutReason },
    delayRisk: { level: delayLevel, reason: delayReason },
    risks,
    recommendations: recs,
  };
}

async function aiInsights(m: OrgMetrics): Promise<Insights> {
  const system =
    '너는 재택근무 플랫폼 exist의 팀 분석 AI다. 조직의 협업 데이터 집계치(추세 trends·신호 signals 포함)를 보고 팀 상태를 진단하고 위험을 예측한다.\n' +
    '응답은 오직 JSON 하나. 형식: {"summary": string, "trend": string, "burnoutRisk": {"level": string, "reason": string}, "delayRisk": {"level": string, "reason": string}, "risks": string[], "recommendations": string[]}.\n' +
    'summary: 팀 상태 2문장(한국어). 사실 수치 중심으로 담백하게 서술하고, "어려움이 예상됩니다"류의 부정 단정·비관 전망은 금지 — 개선 여지는 recommendations에서만 제안한다. 활동이 적으면 "아직 기록이 쌓이는 중"으로 중립 서술. ' +
    'trend: 최근 7일 vs 이전 7일 활동 추세 해석 한 문장. ' +
    'burnoutRisk: 번아웃 위험 예측 — level은 "낮음"|"보통"|"높음" 중 하나, reason은 근거(40자내). 야간 메시지 비율(signals.nightRatio), 인당 통화시간(signals.callMinPerMember), 참여 편중(signals.topShare)을 종합 판단. ' +
    'delayRisk: 일정 지연 위험 예측 — level은 "낮음"|"보통"|"높음", reason은 근거(40자내). 완료율, 마감 지난 할 일(todos.overdue), 임박 마감(signals.soonDue), 활동 추세를 종합 판단. ' +
    'risks: 기타 리스크(각 40자내, 최대 3개). recommendations: 실행 제안(각 40자내, 최대 3개).\n' +
    '반드시 주어진 수치에 근거하고, 데이터에 없는 사실·수치는 지어내지 않는다. 데이터가 적으면 위험을 "낮음"으로 둔다.';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(m) },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('empty AI response');
  const parsed = JSON.parse(raw) as Partial<Insights>;
  const fallback = ruleBasedInsights(m);
  const risk = (r: unknown, fb: { level: string; reason: string }) => {
    const o = (r ?? {}) as { level?: unknown; reason?: unknown };
    return {
      level: String(o.level ?? fb.level).trim() || fb.level,
      reason: String(o.reason ?? fb.reason).trim() || fb.reason,
    };
  };
  return {
    summary: String(parsed.summary ?? '').trim() || fallback.summary,
    trend: String(parsed.trend ?? '').trim() || fallback.trend,
    burnoutRisk: risk(parsed.burnoutRisk, fallback.burnoutRisk),
    delayRisk: risk(parsed.delayRisk, fallback.delayRisk),
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 3) : [],
    recommendations: Array.isArray(parsed.recommendations)
      ? parsed.recommendations.map(String).slice(0, 3)
      : [],
  };
}

// 조직별 캐시 (5분) — OpenAI 호출 비용/지연 절감
const cache = new Map<number, { at: number; payload: unknown }>();
const CACHE_MS = 5 * 60 * 1000;

const router = Router();
router.use(requireAuth);

router.get('/:orgId', async (req: AuthedRequest, res) => {
  const orgId = Number(req.params.orgId);
  if (!Number.isInteger(orgId)) return res.status(400).json({ error: '잘못된 조직' });
  if (!isMember(orgId, req.userId!))
    return res.status(403).json({ error: '조직 멤버가 아닙니다' });

  // ?fresh=1 — 캐시 무시하고 즉시 재계산 (데모·시연에서 방금 활동을 바로 반영)
  const cached = cache.get(orgId);
  if (req.query.fresh !== '1' && cached && Date.now() - cached.at < CACHE_MS)
    return res.json(cached.payload);

  const metrics = collectOrgMetrics(orgId);
  if (!metrics) return res.status(404).json({ error: '조직을 찾을 수 없습니다' });

  let insights: Insights;
  let source = 'rule';
  if (openai) {
    try {
      insights = await aiInsights(metrics);
      source = 'ai';
    } catch (e) {
      console.error('[insights] OpenAI 실패, 규칙 기반 폴백:', e);
      insights = ruleBasedInsights(metrics);
    }
  } else {
    insights = ruleBasedInsights(metrics);
  }

  const payload = { metrics, insights, source };
  cache.set(orgId, { at: Date.now(), payload });
  res.json(payload);
});

export default router;
