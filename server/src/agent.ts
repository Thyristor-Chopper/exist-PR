import { Router, type Response } from 'express';
import OpenAI from 'openai';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { getRoomSize } from './sfu.js';
import { isOrgMember } from './perm.js';

/*
 * exist AI agent — 사용자의 일정·투두 상태(목표 vs 현재)를 분석해
 * nowbar에 띄울 한 줄 브리핑 + 보여줄 카드를 결정한다.
 *
 * OPENAI_API_KEY가 있으면 OpenAI API, 없으면 규칙 기반 폴백.
 * (모델: OPENAI_MODEL, 기본 gpt-4o-mini)
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

interface TodoRow {
  title: string;
  done: number;
  due_at: string | null;
}

interface MeetingRow {
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  /** 지금 통화 중인 인원 (라이브) */
  in_call: number;
}

interface UserContext {
  now: Date;
  todos: TodoRow[];
  meetings: MeetingRow[];
}

/*
 * AI 스코프 — 개인 탭과 조직 탭은 완전히 다른 컨텍스트다.
 * 'personal' = 조직 소속이 아닌 그룹(m.org_id IS NULL)과 개인 할 일만.
 * number    = 그 조직 소속 그룹만. undefined = 전체(레거시/nowbar).
 */
export type AgentScope = 'personal' | number | undefined;

/** meetings 별칭 m 기준 스코프 SQL 조각 + 바인딩 값 */
function scopeSql(scope: AgentScope): { sql: string; args: number[] } {
  if (scope === 'personal') return { sql: ' AND m.org_id IS NULL', args: [] };
  if (typeof scope === 'number') return { sql: ' AND m.org_id = ?', args: [scope] };
  return { sql: '', args: [] };
}

/** dm_messages 기준 스코프 조각 — DM도 조직별로 분리된 대화다 (dm_messages.org_id) */
function dmScopeSql(scope: AgentScope): { sql: string; args: number[] } {
  if (scope === 'personal') return { sql: ' AND org_id IS NULL', args: [] };
  if (typeof scope === 'number') return { sql: ' AND org_id = ?', args: [scope] };
  return { sql: '', args: [] };
}

export function getUserContext(userId: number, scope?: AgentScope): UserContext {
  const sc = scopeSql(scope);
  // 개인 todo(meeting_id 없음)는 LEFT JOIN에서 m.org_id가 NULL이라 'personal' 스코프에 자연 포함
  const todos = db
    .prepare(
      `SELECT t.title, t.done, t.due_at FROM todos t
       LEFT JOIN meetings m ON m.id = t.meeting_id
       WHERE t.user_id = ?${sc.sql}`,
    )
    .all(userId, ...sc.args) as TodoRow[];
  const meetings = (
    db
      .prepare(
        `SELECT m.code, m.title, m.starts_at, m.ends_at FROM meetings m
         JOIN meeting_participants mp ON mp.meeting_id = m.id
         WHERE mp.user_id = ?${sc.sql}`,
      )
      .all(userId, ...sc.args) as Omit<MeetingRow, 'in_call'>[]
  ).map((m) => ({ ...m, in_call: getRoomSize(m.code) }));
  return { now: new Date(), todos, meetings };
}

function minutesUntil(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
}

/** 규칙 기반 폴백 — API 키 없이도 의미 있는 브리핑 */
function ruleBasedBrief(ctx: UserContext): string {
  const { now, todos, meetings } = ctx;
  const undone = todos.filter((t) => !t.done);

  // 0순위 — 내 회의에서 지금 통화가 열려 있으면 알려준다
  const live = meetings
    .filter((m) => m.in_call > 0)
    .sort((a, b) => b.in_call - a.in_call)[0];
  if (live) {
    return `지금 "${live.title}"에서 ${live.in_call}명이 통화 중이에요`;
  }

  const ongoing = meetings.find(
    (m) =>
      m.starts_at &&
      m.ends_at &&
      new Date(m.starts_at) <= now &&
      now < new Date(m.ends_at),
  );
  if (ongoing) {
    return undone.length > 0
      ? `회의 진행 중 — 미완료 할 일 ${undone.length}개가 기다리고 있어요`
      : `회의 진행 중 — 할 일은 모두 완료된 상태예요`;
  }

  const upcoming = meetings
    .filter((m) => m.starts_at && new Date(m.starts_at) > now)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming) {
    const min = minutesUntil(upcoming.starts_at!, now);
    if (min <= 60) {
      return undone.length > 0
        ? `"${upcoming.title}" ${min}분 전 — 미완료 할 일 ${undone.length}개 점검하세요`
        : `"${upcoming.title}" ${min}분 전 — 준비 완료 상태예요`;
    }
  }

  if (undone.length > 0) return `예정된 회의 없음 — 할 일 ${undone.length}개에 집중할 시간이에요`;
  return '오늘 할 일과 회의가 모두 정리됐어요';
}

export type CardId = 0 | 1 | 2; // 0=일정 1=할 일 2=진행 타임라인

/** 규칙 기반 카드 결정 — API 키 없거나 AI 실패 시 폴백 */
function ruleBasedDecision(ctx: UserContext): { card: CardId; reason: string } {
  const { now, todos, meetings } = ctx;
  const t = now.getTime();

  const ongoing = meetings.find(
    (m) => m.starts_at && m.ends_at && new Date(m.starts_at) <= now && now < new Date(m.ends_at),
  );
  if (ongoing) return { card: 2, reason: '회의가 진행 중이에요' };

  const pending = todos.filter((td) => !td.done);
  const dueSoon = pending.filter(
    (td) => td.due_at && new Date(td.due_at).getTime() <= t + 24 * 3600_000,
  );

  const upcoming = meetings
    .filter((m) => m.starts_at && new Date(m.starts_at).getTime() > t)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming && minutesUntil(upcoming.starts_at!, now) <= 30) {
    return { card: 0, reason: '곧 시작하는 회의가 있어요' };
  }
  if (dueSoon.length > 0) return { card: 1, reason: '마감이 가까운 할 일이 있어요' };

  const todayUpcoming = meetings.some(
    (m) =>
      m.starts_at &&
      new Date(m.starts_at).getTime() > t &&
      new Date(m.starts_at).toDateString() === now.toDateString(),
  );
  if (todayUpcoming) return { card: 0, reason: '오늘 예정된 회의가 있어요' };
  if (pending.length > 0) return { card: 1, reason: '할 일이 남아 있어요' };
  return { card: 0, reason: '다가오는 일정을 보여드려요' };
}

/** 진행 중 회의가 없으면 card 2(타임라인)는 의미 없으니 보정 */
function hasOngoing(ctx: UserContext): boolean {
  const { now, meetings } = ctx;
  return meetings.some(
    (m) => m.starts_at && m.ends_at && new Date(m.starts_at) <= now && now < new Date(m.ends_at),
  );
}

/** 응답에서 첫 JSON 객체만 추출 (코드펜스·잡설 방어) */
function extractJson(raw: string): unknown {
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) throw new Error('no json');
  return JSON.parse(raw.slice(s, e + 1));
}

interface Decision {
  brief: string;
  card: CardId;
  reason: string;
}

/** nowbar 브리핑 재료 — 데이터에서 직접 만든 사실 문장만.
 *  일정이 없으면 "없다"가 사실로 들어가서 AI가 "곧 시작"을 지어낼 수 없다 (환각 방어). */
function buildBriefFacts(ctx: UserContext): string[] {
  const { now, todos, meetings } = ctx;
  const facts: string[] = [];
  const live = meetings.filter((m) => m.in_call > 0).sort((a, b) => b.in_call - a.in_call)[0];
  if (live) facts.push(`지금 "${live.title}"에서 ${live.in_call}명이 통화 중이다`);
  const ongoing = meetings.find(
    (m) => m.starts_at && m.ends_at && new Date(m.starts_at) <= now && now < new Date(m.ends_at),
  );
  if (ongoing) facts.push(`"${ongoing.title}" 회의가 지금 진행 중이다`);
  const upcoming = meetings
    .filter((m) => m.starts_at && new Date(m.starts_at) > now)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  if (upcoming) {
    const min = minutesUntil(upcoming.starts_at!, now);
    facts.push(
      min <= 90
        ? `"${upcoming.title}" 회의가 ${min}분 뒤에 시작한다`
        : `다음 회의는 "${upcoming.title}"(${new Date(upcoming.starts_at!).getMonth() + 1}/${new Date(upcoming.starts_at!).getDate()})이다`,
    );
  } else if (!ongoing && !live) {
    facts.push('예정된 회의가 없다');
  }
  const undone = todos.filter((t) => !t.done);
  const dueSoon = undone.filter(
    (t) => t.due_at && new Date(t.due_at).getTime() <= now.getTime() + 24 * 3600_000,
  );
  if (dueSoon[0]) facts.push(`24시간 내 마감 할 일: "${dueSoon[0].title}"`);
  else if (undone.length > 0) facts.push(`미완료 할 일이 ${undone.length}개 있다`);
  else facts.push('할 일은 모두 완료됐다');
  return facts;
}

/** OpenAI API 기반 — 브리핑 + 지금 보여줄 nowbar 카드를 함께 결정.
 *  자유 작문 금지: 서버가 만든 사실 문장에서 고르고 다듬기만 한다
 *  (원본 데이터를 주면 없는 일정을 "곧 시작"이라 지어내는 사고가 실제로 났음) */
async function aiDecision(ctx: UserContext): Promise<Decision> {
  const facts = buildBriefFacts(ctx);

  const system =
    '너는 분산 근무 플랫폼 exist의 AI 총무로, 상단 상태바(nowbar)를 관리한다. ' +
    '아래 "사실 문장" 목록에서 가장 시급한 것 하나를 골라 한 줄 브리핑으로 다듬고, 보여줄 카드를 고른다.\n' +
    '절대 규칙: 목록에 있는 사실만 쓴다. 새 사실·시각·수치를 만들지 않는다.\n' +
    '카드: 0 = 일정, 1 = 할 일, 2 = 진행 타임라인. ' +
    '통화 중·진행 중 회의 사실이 있으면 2, 곧 시작하는 회의 사실이 있으면 0, ' +
    '마감 임박 할 일 사실이 있으면 1. "진행 중" 사실이 없으면 절대 2를 고르지 않는다.\n' +
    '응답은 오직 JSON: {"brief": string, "card": 0|1|2, "reason": string}. ' +
    'brief는 한국어 50자 이내(인사말·이모지 없이), 반드시 "~요"로 끝나는 해요체 문장. ' +
    'reason은 카드 선택 이유 20자 이내 — ' +
    'reason도 사실 문장에 있는 표현만 사용한다 (예: 목록에 "마감"이 없으면 "마감"이라 쓰지 않는다).';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ facts }) },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('empty AI response');

  const parsed = extractJson(raw) as { brief?: unknown; card?: unknown; reason?: unknown };
  const brief = String(parsed.brief ?? '').trim();
  let card = Number(parsed.card) as CardId;
  if (![0, 1, 2].includes(card)) card = 0;
  // 진행 중 회의 없는데 2를 골랐으면 룰 기반으로 보정
  if (card === 2 && !hasOngoing(ctx)) card = ruleBasedDecision(ctx).card;
  const reason = String(parsed.reason ?? '').trim() || ruleBasedDecision(ctx).reason;
  if (!brief) throw new Error('empty brief');
  return { brief, card, reason };
}

interface BriefResult {
  text: string;
  source: string;
  card: CardId;
  reason: string;
}

// 사용자별 브리핑 캐시 (2분 — 단 라이브 통화 인원이 바뀌면 즉시 무효)
const briefCache = new Map<number, BriefResult & { at: number; liveSig: string }>();
const CACHE_MS = 2 * 60 * 1000;

export async function generateBrief(userId: number): Promise<BriefResult> {
  const ctx = getUserContext(userId);
  const liveSig = ctx.meetings.map((m) => `${m.code}:${m.in_call}`).join(',');

  const cached = briefCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_MS && cached.liveSig === liveSig) {
    return { text: cached.text, source: cached.source, card: cached.card, reason: cached.reason };
  }

  let result: BriefResult;
  if (openai) {
    try {
      const d = await aiDecision(ctx);
      result = { text: d.brief, source: 'ai', card: d.card, reason: d.reason };
    } catch (err) {
      console.error('[agent] OpenAI API 실패, 규칙 기반 폴백:', err);
      const dec = ruleBasedDecision(ctx);
      result = { text: ruleBasedBrief(ctx), source: 'rule', card: dec.card, reason: dec.reason };
    }
  } else {
    const dec = ruleBasedDecision(ctx);
    result = { text: ruleBasedBrief(ctx), source: 'rule', card: dec.card, reason: dec.reason };
  }

  briefCache.set(userId, { ...result, at: Date.now(), liveSig });
  return result;
}

/** 투두/회의/메시지 변경 시 캐시 무효화용 — nowbar 브리핑 + 오늘 브리핑(전 스코프) */
export function invalidateBrief(userId: number) {
  briefCache.delete(userId);
  for (const k of dailyCache.keys()) if (k.startsWith(`${userId}:`)) dailyCache.delete(k);
}

/** 그룹 단위 변화(새 메시지 등) — 참가자 전원의 브리핑 무효화 */
export function invalidateBriefForMeeting(meetingId: number) {
  const rows = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
    .all(meetingId) as { user_id: number }[];
  for (const r of rows) invalidateBrief(r.user_id);
}

/*
 * P2 — "놓친 것" 브리핑 (catch-up).
 * 마지막 접속 종료(users.last_seen_at) 이후 생긴 것들을 모아 브리핑한다:
 * 통화 recap(특히 불참한 것)·새로 배정된 할 일·안 읽은 DM·안 읽은 그룹 채팅.
 * 항목은 전부 DB 사실에서 규칙으로 계산 (AI가 지어낼 수 없음) — AI는 헤드라인 한 줄만.
 */

export interface CatchupItem {
  type: 'recap' | 'todo' | 'dm' | 'chat';
  text: string;
  meeting?: { code: string; title: string };
}

export interface Catchup {
  since: string | null;
  headline: string;
  source: 'ai' | 'rule';
  items: CatchupItem[];
  /** 안 읽은 메시지 총계(그룹 채팅 + DM) — 통합 메시지함과 같은 기준 */
  unreadTotal: number;
}

export async function getCatchup(userId: number, scope?: AgentScope): Promise<Catchup> {
  const me = db.prepare('SELECT username, last_seen_at FROM users WHERE id = ?').get(userId) as
    | { username: string; last_seen_at: string | null }
    | undefined;
  if (!me) return { since: null, headline: '', source: 'rule', items: [], unreadTotal: 0 };
  const sc = scopeSql(scope);

  // 창: 마지막 접속 종료 이후, 최대 7일 (첫 접속이면 24시간)
  const floor7d = new Date(Date.now() - 7 * 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const floor24h = new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const since = me.last_seen_at ? (me.last_seen_at < floor7d ? floor7d : me.last_seen_at) : floor24h;

  const items: CatchupItem[] = [];

  // 1) 내 회의의 통화 recap — 불참한 것 먼저
  const recaps = db
    .prepare(
      `SELECT r.summary, r.attendees, r.decisions, m.code, m.title
       FROM meeting_recaps r
       JOIN meetings m ON m.id = r.meeting_id
       JOIN meeting_participants mp ON mp.meeting_id = r.meeting_id
       WHERE mp.user_id = ? AND r.created_at > ?${sc.sql}
       ORDER BY r.id DESC LIMIT 5`,
    )
    .all(userId, since, ...sc.args) as { summary: string; attendees: string; decisions: string; code: string; title: string }[];
  for (const r of recaps) {
    const missed = !(JSON.parse(r.attendees) as string[]).includes(me.username);
    const decisionCount = (JSON.parse(r.decisions) as string[]).length;
    items.push({
      type: 'recap',
      text: missed
        ? `놓친 통화 정리 — ${r.summary}${decisionCount ? ` (결정 ${decisionCount}건)` : ''}`
        : `통화 정리 — ${r.summary}`,
      meeting: { code: r.code, title: r.title },
    });
  }

  // 2) 새로 배정된 회의 할 일
  const newTodos = db
    .prepare(
      `SELECT t.title, m.code, m.title AS mtitle FROM todos t
       JOIN meetings m ON m.id = t.meeting_id
       WHERE t.user_id = ? AND t.done = 0 AND t.created_at > ?${sc.sql}
       ORDER BY t.id DESC LIMIT 5`,
    )
    .all(userId, since, ...sc.args) as { title: string; code: string; mtitle: string }[];
  for (const t of newTodos) {
    items.push({
      type: 'todo',
      text: `새 할 일 — ${t.title}`,
      meeting: { code: t.code, title: t.mtitle },
    });
  }

  // 3) 안 읽은 DM (읽음 상태 기준 — 시점 무관). DM도 조직별 대화라 같은 스코프로 센다
  const dsc = dmScopeSql(scope);
  const dm = db
    .prepare(
      `SELECT COUNT(*) AS n, (
         SELECT u.username FROM dm_messages d2 JOIN users u ON u.id = d2.from_id
         WHERE d2.to_id = ? AND d2.read = 0${dsc.sql.replace(/org_id/g, 'd2.org_id')} ORDER BY d2.id DESC LIMIT 1
       ) AS top
       FROM dm_messages WHERE to_id = ? AND read = 0${dsc.sql}`,
    )
    .get(userId, ...dsc.args, userId, ...dsc.args) as { n: number; top: string | null };
  if (dm.n > 0) {
    items.push({
      type: 'dm',
      text: `안 읽은 DM ${dm.n}개${dm.top ? ` — 최근: ${dm.top}` : ''}`,
    });
  }

  // 4) 안 읽은 그룹 채팅 (chat_reads 기준, 상위 3개 회의)
  const chats = db
    .prepare(
      `SELECT m.code, m.title, COUNT(*) AS n FROM messages msg
       JOIN meetings m ON m.id = msg.meeting_id
       JOIN meeting_participants mp ON mp.meeting_id = msg.meeting_id AND mp.user_id = ?
       LEFT JOIN chat_reads cr ON cr.meeting_id = msg.meeting_id AND cr.user_id = ?
       WHERE msg.user_id != ? AND msg.id > COALESCE(cr.last_read, 0)${sc.sql}
       GROUP BY msg.meeting_id ORDER BY n DESC LIMIT 3`,
    )
    .all(userId, userId, userId, ...sc.args) as { code: string; title: string; n: number }[];
  for (const c of chats) {
    items.push({
      type: 'chat',
      text: `안 읽은 메시지 ${c.n}개`,
      meeting: { code: c.code, title: c.title },
    });
  }
  // 항목은 상위 3곳만 싣지만 총계는 전체 기준으로 (통합 메시지함과 일치)
  const chatAgg = db
    .prepare(
      `SELECT COUNT(DISTINCT msg.meeting_id) AS n, COUNT(*) AS msgs FROM messages msg
       JOIN meetings m ON m.id = msg.meeting_id
       JOIN meeting_participants mp ON mp.meeting_id = msg.meeting_id AND mp.user_id = ?
       LEFT JOIN chat_reads cr ON cr.meeting_id = msg.meeting_id AND cr.user_id = ?
       WHERE msg.user_id != ? AND msg.id > COALESCE(cr.last_read, 0)${sc.sql}`,
    )
    .get(userId, userId, userId, ...sc.args) as { n: number; msgs: number };
  const chatTotal = chatAgg.n;
  const unreadTotal = chatAgg.msgs + dm.n;

  // 헤드라인 — 규칙 요약이 기본, AI가 있으면 자연스러운 한 줄로
  const missedRecaps = items.filter((i) => i.type === 'recap' && i.text.startsWith('놓친')).length;
  const parts = [
    missedRecaps > 0 ? `놓친 통화 ${missedRecaps}건` : null,
    newTodos.length > 0 ? `새 할 일 ${newTodos.length}개` : null,
    dm.n > 0 ? `안 읽은 DM ${dm.n}개` : null,
    chatTotal > 0 ? `안 읽은 그룹 채팅 ${chatTotal}곳` : null,
  ].filter(Boolean);
  let headline =
    parts.length > 0 ? `자리 비운 사이 ${parts.join(' · ')} 있어요` : '자리 비운 사이 놓친 건 없어요';
  let source: 'ai' | 'rule' = 'rule';

  if (openai && items.length > 0) {
    try {
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.3,
        max_tokens: 120,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '너는 분산 근무 플랫폼 exist의 AI 운영자다. 사용자가 자리를 비운 사이 놓친 것들의 목록을 받아 ' +
              '한 줄 헤드라인(한국어 60자 이내, 가장 중요한 것 하나를 짚어서)으로 요약한다. ' +
              '문체는 반드시 "~요"로 끝나는 해요체 ("~습니다"체 금지). ' +
              '목록에 없는 사실은 만들지 않는다. 응답은 JSON: {"headline": string}',
          },
          { role: 'user', content: JSON.stringify(items.map((i) => i.text)) },
        ],
      });
      const raw = response.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
        headline?: unknown;
      };
      const h = String(parsed.headline ?? '').trim();
      if (h) {
        headline = h;
        source = 'ai';
      }
    } catch (err) {
      console.error('[agent] catchup 헤드라인 AI 실패, 규칙 사용:', err);
    }
  }

  return { since, headline, source, items, unreadTotal };
}

/* ── 오늘 브리핑 — 홈 대시보드용. nowbar 한 줄(brief)보다 긴 2~3문장으로
 * 오늘 일정 + 자리 비운 사이 놓친 것 + 급한 할 일을 하루 세팅 문단으로 묶는다 ── */

export interface DailyBrief {
  text: string;
  source: 'ai' | 'rule';
}

// 키: `${userId}:${scope}` — 개인 탭·조직 탭의 브리핑은 서로 다른 문서다
const dailyCache = new Map<string, DailyBrief & { at: number }>();
const DAILY_CACHE_MS = 5 * 60 * 1000;

/** 브리핑 재료 — 서버가 데이터에서 직접 만든 사실 문장만.
 *  AI는 이 문장들을 다듬기만 하고 새 사실(특히 시각·수치)을 만들 수 없다 (환각 방어). */
function buildDailyFacts(ctx: UserContext, catchup: Catchup): string[] {
  const facts: string[] = [];
  const today = ctx.meetings
    .filter(
      (m) =>
        m.starts_at &&
        new Date(m.starts_at) > ctx.now &&
        new Date(m.starts_at).toDateString() === ctx.now.toDateString(),
    )
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());
  if (today[0]) {
    const d = new Date(today[0].starts_at!);
    const ampm = d.getHours() < 12 ? '오전' : '오후';
    facts.push(`오늘 ${ampm} ${d.getHours() % 12 || 12}시 "${today[0].title}" 일정이 있다`);
  } else {
    facts.push('오늘 예정된 일정은 없다');
  }
  const live = ctx.meetings.filter((m) => m.in_call > 0)[0];
  if (live) facts.push(`지금 "${live.title}"에서 ${live.in_call}명이 통화 중이다`);
  // 안 읽은 메시지는 AI가 항목들을 합산하다 틀리지 않게 서버가 계산한 총계 한 문장으로
  for (const i of catchup.items.filter((x) => x.type === 'recap' || x.type === 'todo').slice(0, 3))
    facts.push(`자리 비운 사이: ${i.text}`);
  if (catchup.unreadTotal > 0) facts.push(`안 읽은 메시지가 총 ${catchup.unreadTotal}개 있다`);
  const urgent = ctx.todos
    .filter((t) => !t.done && t.due_at)
    .sort((a, b) => new Date(a.due_at!).getTime() - new Date(b.due_at!).getTime())[0];
  const undone = ctx.todos.filter((t) => !t.done);
  if (urgent) facts.push(`할 일 중 마감이 가장 가까운 것은 "${urgent.title}"이다`);
  else if (undone.length > 0)
    facts.push(
      `미완료 할 일 ${undone.length}개: ${undone.slice(0, 3).map((t) => t.title).join(', ')}`,
    );
  return facts;
}

function ruleBasedDaily(ctx: UserContext, catchup: Catchup): string {
  const facts = buildDailyFacts(ctx, catchup);
  const meaningful = facts.filter((f) => f !== '오늘 예정된 일정은 없다');
  if (meaningful.length === 0) return '오늘은 예정된 일정이 없어요. 밀린 일을 정리하기 좋은 날이에요.';
  return facts.map((f) => f + '요.').join(' ').replace(/다요\./g, '어요.').slice(0, 300);
}

export async function getDailyBrief(userId: number, scope?: AgentScope): Promise<DailyBrief> {
  const key = `${userId}:${scope ?? 'all'}`;
  const cached = dailyCache.get(key);
  if (cached && Date.now() - cached.at < DAILY_CACHE_MS) {
    return { text: cached.text, source: cached.source };
  }
  const ctx = getUserContext(userId, scope);
  const catchup = await getCatchup(userId, scope);

  let result: DailyBrief;
  if (openai) {
    try {
      // 자유 작문 금지 — 서버가 만든 사실 문장만 주고 "다듬기"만 시킨다.
      // (원본 데이터를 주면 모델이 없는 시각·일정을 지어내는 사고가 실제로 났음)
      const facts = buildDailyFacts(ctx, catchup);
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.3,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '너는 분산 근무 플랫폼 exist의 AI 총무다. 아래 "사실 문장" 목록을 자연스러운 ' +
              '"오늘 브리핑" 문단(한국어 2~3문장, 220자 이내)으로 다듬는다.\n' +
              '문체: 모든 문장은 반드시 "~요"로 끝나는 해요체. "~습니다"체 절대 금지.\n' +
              '절대 규칙: 사실은 목록에 있는 것만 쓴다. 새 사실·시각·수치·일정을 추가하지 않는다. ' +
              '중요도 순 재배열 허용, 덜 중요한 사실은 생략 가능.\n' +
              '판단은 자유: 목록의 사실들에 근거해 "무엇부터 하면 좋을지" 우선순위 제안 한 문장은 ' +
              '적극 권장한다 (단 그 근거가 되는 사실이 목록에 있어야 함). 인사말·이모지 없이.\n' +
              '응답은 오직 JSON: {"text": string}',
          },
          { role: 'user', content: JSON.stringify({ facts }) },
        ],
      });
      const raw = response.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
        text?: unknown;
      };
      const text = String(parsed.text ?? '').trim();
      if (!text) throw new Error('empty daily brief');
      result = { text: text.slice(0, 300), source: 'ai' };
    } catch (err) {
      console.error('[agent] 오늘 브리핑 AI 실패, 규칙 폴백:', err);
      result = { text: ruleBasedDaily(ctx, catchup), source: 'rule' };
    }
  } else {
    result = { text: ruleBasedDaily(ctx, catchup), source: 'rule' };
  }
  dailyCache.set(key, { ...result, at: Date.now() });
  return result;
}

const router = Router();
router.use(requireAuth);

/** ?org= 파싱 — 'personal' | 조직 id(멤버십 검증) | 없으면 전체. 실패 시 응답 쓰고 null */
function parseScope(req: AuthedRequest, res: Response): AgentScope | null {
  const raw = req.query.org;
  if (raw === undefined) return undefined;
  if (raw === 'personal') return 'personal';
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: '잘못된 org 값입니다' });
    return null;
  }
  if (!isOrgMember(id, req.userId!)) {
    res.status(403).json({ error: '조직 멤버가 아닙니다' });
    return null;
  }
  return id;
}

router.get('/brief', async (req: AuthedRequest, res) => {
  const brief = await generateBrief(req.userId!);
  res.json(brief);
});

/** 오늘 브리핑 — 홈 대시보드 상단 문단 (?org= 스코프) */
router.get('/daily', async (req: AuthedRequest, res) => {
  const scope = parseScope(req, res);
  if (scope === null) return;
  res.json(await getDailyBrief(req.userId!, scope));
});

/** P2 — 자리 비운 사이 놓친 것 브리핑 (?org= 스코프) */
router.get('/catchup', async (req: AuthedRequest, res) => {
  const scope = parseScope(req, res);
  if (scope === null) return;
  res.json(await getCatchup(req.userId!, scope));
});

/** 개인 대시보드 요약 — 참여 회의·미완료 할 일·다음 일정·라이브 통화 (?org= 스코프) */
router.get('/overview', (req: AuthedRequest, res) => {
  const scope = parseScope(req, res);
  if (scope === null) return;
  const sc = scopeSql(scope);
  const ctx = getUserContext(req.userId!, scope);
  const now = ctx.now.getTime();
  const undone = ctx.todos.filter((t) => !t.done);
  const overdue = undone.filter((t) => t.due_at && new Date(t.due_at).getTime() < now);
  const next = ctx.meetings
    .filter((m) => m.starts_at && new Date(m.starts_at).getTime() > now)
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime())[0];
  const u = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.userId!) as
    | { avatar?: string }
    | undefined;

  // 히어로 뱃지 — 안 읽은 합계(DM+그룹 채팅, catchup과 같은 기준). DM도 조직별 대화 — 같은 스코프
  const dsc = dmScopeSql(scope);
  const dmUnread = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM dm_messages WHERE to_id = ? AND read = 0${dsc.sql}`)
      .get(req.userId, ...dsc.args) as { n: number }
  ).n;
  const chatUnread = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages msg
         JOIN meetings m ON m.id = msg.meeting_id
         JOIN meeting_participants mp ON mp.meeting_id = msg.meeting_id AND mp.user_id = ?
         LEFT JOIN chat_reads cr ON cr.meeting_id = msg.meeting_id AND cr.user_id = ?
         WHERE msg.user_id != ? AND msg.id > COALESCE(cr.last_read, 0)${sc.sql}`,
      )
      .get(req.userId, req.userId, req.userId, ...sc.args) as { n: number }
  ).n;

  // 히어로 뱃지 — 수신확인 대기 결정 (내 그룹의 결정 중 내가 ack 안 한 것)
  const recapRows = db
    .prepare(
      `SELECT r.decisions FROM meeting_recaps r
       JOIN meetings m ON m.id = r.meeting_id
       JOIN meeting_participants mp ON mp.meeting_id = r.meeting_id AND mp.user_id = ?${sc.sql}`,
    )
    .all(req.userId, ...sc.args) as { decisions: string }[];
  const totalDecisions = recapRows.reduce(
    (s, r) => s + (JSON.parse(r.decisions) as string[]).length,
    0,
  );
  const myAcks = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM decision_acks a
         JOIN meeting_recaps r ON r.id = a.recap_id
         JOIN meetings m ON m.id = r.meeting_id
         JOIN meeting_participants mp ON mp.meeting_id = r.meeting_id AND mp.user_id = a.user_id
         WHERE a.user_id = ?${sc.sql}`,
      )
      .get(req.userId, ...sc.args) as { n: number }
  ).n;

  res.json({
    avatar: u?.avatar ?? '🐧',
    meetingCount: ctx.meetings.length,
    todoUndone: undone.length,
    todoOverdue: overdue.length,
    unreadTotal: dmUnread + chatUnread,
    pendingAcks: Math.max(0, totalDecisions - myAcks),
    liveCalls: ctx.meetings
      .filter((m) => m.in_call > 0)
      .map((m) => ({ title: m.title, code: m.code, inCall: m.in_call })),
    recentMeetings: ctx.meetings
      .slice(0, 8)
      .map((m) => ({ title: m.title, code: m.code, inCall: m.in_call })),
    nextMeeting: next ? { title: next.title, code: next.code, startsAt: next.starts_at } : null,
  });
});

export default router;
