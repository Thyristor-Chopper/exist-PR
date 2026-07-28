import OpenAI from 'openai';
import db from './db.js';
import { listDecisions, listRecaps } from './recap.js';

/*
 * exist AI 총무 — 그룹 채팅에서 @AI 를 멘션하면 그 그룹의 기록
 * (결정 원장·통화 정리·할 일·최근 대화)을 근거로 답한다.
 * 원칙: 기록에 있는 것만 답하고, 없으면 없다고 말한다 (환각 방어).
 * OPENAI_API_KEY 없거나 실패 시 규칙 폴백 (최근 결정 나열).
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export const AGENT_NAME = 'exist AI';
/** @AI, @ai, @총무 멘션 감지 — 문장 처음이나 공백 뒤의 독립 토큰만 (이메일 주소 오탐 방지) */
export const AGENT_MENTION = /(^|\s)@(ai|총무)(?=\s|$)/i;

/** AI 아바타 — 클라이언트 Avatar가 이 값을 별(SparklesIcon)로 렌더 */
export const AGENT_AVATAR = '✦';

/** 시스템 유저(exist AI) 확보 — 채팅 메시지의 발신자로 쓴다 (로그인 불가 더미 해시) */
export function ensureAgentUser(): number {
  const existing = db.prepare('SELECT id, avatar FROM users WHERE username = ?').get(AGENT_NAME) as
    | { id: number; avatar: string | null }
    | undefined;
  if (existing) {
    if (existing.avatar !== AGENT_AVATAR)
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(AGENT_AVATAR, existing.id);
    return existing.id;
  }
  const info = db
    .prepare("INSERT INTO users (username, pw_hash, pw_salt, avatar) VALUES (?, 'x', 'x', ?)")
    .run(AGENT_NAME, AGENT_AVATAR);
  return info.lastInsertRowid as number;
}

interface AgentContext {
  meetingTitle: string;
  decisions: { decision: string; ts: number }[];
  recaps: { summary: string; ts: number }[];
  todos: { title: string; done: number; author: string }[];
  chat: { from: string; text: string }[];
}

function gatherContext(meetingId: number, channelId: number): AgentContext {
  const meeting = db.prepare('SELECT title FROM meetings WHERE id = ?').get(meetingId) as {
    title: string;
  };
  // 배경(why)까지 근거에 포함 — "이 결정 왜 이렇게 됐어?" 역질문에 답할 수 있게
  const decisions = listDecisions(meetingId, 30).map((d) => ({
    decision: d.why ? `${d.decision} (배경: ${d.why})` : d.decision,
    ts: d.ts,
  }));
  const recaps = listRecaps(meetingId, 5).map((r) => ({ summary: r.summary, ts: r.ts }));
  const todos = db
    .prepare(
      `SELECT t.title, t.done, u.username AS author FROM todos t
       JOIN users u ON u.id = t.user_id WHERE t.meeting_id = ? ORDER BY t.id DESC LIMIT 20`,
    )
    .all(meetingId) as { title: string; done: number; author: string }[];
  // AI 자신의 메시지는 근거에서 제외 — 과거 AI 답변을 다시 먹고 반복하는 자기 오염 방지
  const chat = db
    .prepare(
      `SELECT u.username AS "from", m.text FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND m.user_id != ? AND (m.channel_id = ? OR m.channel_id IS NULL) AND m.text != ''
       ORDER BY m.id DESC LIMIT 30`,
    )
    .all(meetingId, ensureAgentUser(), channelId)
    .reverse() as { from: string; text: string }[];
  // 최근 통화 음성 전사도 근거에 포함
  const voice = db
    .prepare(
      `SELECT u.username AS "from", t.text FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? ORDER BY t.id DESC LIMIT 30`,
    )
    .all(meetingId)
    .reverse() as { from: string; text: string }[];
  return { meetingTitle: meeting.title, decisions, recaps, todos, chat: [...voice, ...chat] };
}

/** 규칙 폴백 — 질문 키워드에 따라 기록을 그대로 보여준다 */
export function ruleBasedAnswer(question: string, ctx: AgentContext): string {
  const q = question.toLowerCase();
  if (/(결정|정했|확정|왜)/.test(q) && ctx.decisions.length > 0) {
    const lines = ctx.decisions.slice(0, 3).map((d) => `· ${d.decision}`);
    return `이 그룹의 최근 결정이에요:\n${lines.join('\n')}`;
  }
  if (/(할 ?일|해야|남은|todo)/i.test(q) && ctx.todos.length > 0) {
    const undone = ctx.todos.filter((t) => !t.done).slice(0, 5);
    if (undone.length > 0) {
      return `미완료 할 일 ${undone.length}개예요:\n${undone.map((t) => `· ${t.title} (${t.author})`).join('\n')}`;
    }
  }
  if (ctx.recaps.length > 0) {
    return `가장 최근 통화 정리예요: ${ctx.recaps[0].summary}`;
  }
  return '아직 이 그룹에 쌓인 결정·통화 기록이 없어서 답할 근거가 없어요.';
}

async function aiAnswer(question: string, asker: string, ctx: AgentContext): Promise<string> {
  const system =
    `너는 분산 근무 플랫폼 exist의 AI 총무다. "${ctx.meetingTitle}" 그룹에 상주하며 팀의 기록을 관리한다. ` +
    '아래 제공되는 그룹 기록(결정 원장·통화 정리·할 일·최근 대화)에 근거해서만 답한다. ' +
    '기록에 없는 내용은 추측하지 말고 "기록에 없다"고 답한다. 수치·사실을 만들지 않는다.\n' +
    '답변은 한국어로 간결하게(300자 이내), 필요하면 근거가 된 결정·대화를 짧게 인용한다. ' +
    '응답은 오직 JSON: {"answer": string}';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          question,
          asker,
          records: {
            decisions: ctx.decisions.map((d) => d.decision),
            call_summaries: ctx.recaps.map((r) => r.summary),
            todos: ctx.todos.map((t) => `${t.title} (${t.author}${t.done ? ', 완료' : ''})`),
            recent_chat: ctx.chat.map((c) => `${c.from}: ${c.text}`),
          },
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
    answer?: unknown;
  };
  const answer = String(parsed.answer ?? '').trim();
  if (!answer) throw new Error('empty answer');
  return answer.slice(0, 1000);
}

/* ── DM 1:1 질의 — 통합 메시지에서 exist AI에게 직접 묻기 ──
 * 근거 = 그 스코프(개인/조직)에서 내가 참가한 그룹들의 결정(+배경)·통화 정리·내 할 일.
 * 그룹 채팅 @AI가 공개 역질문이라면, 이건 조용히 묻는 1:1 — 심리적 안전의 사적 채널 */
export async function answerDmQuery(
  orgId: number | null,
  userId: number,
  question: string,
): Promise<string> {
  const scopeSql = orgId == null ? 'm.org_id IS NULL' : 'm.org_id = ?';
  const scopeArgs = orgId == null ? [] : [orgId];
  const meetings = db
    .prepare(
      `SELECT m.id, m.title FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ${scopeSql} AND mp.user_id = ? ORDER BY m.id DESC LIMIT 10`,
    )
    .all(...scopeArgs, userId) as { id: number; title: string }[];

  const decisions: { decision: string; ts: number }[] = [];
  const recaps: { summary: string; ts: number }[] = [];
  for (const m of meetings) {
    for (const d of listDecisions(m.id, 10)) {
      decisions.push({
        decision: `[${m.title}] ${d.decision}${d.why ? ` (배경: ${d.why})` : ''}`,
        ts: d.ts,
      });
    }
    for (const r of listRecaps(m.id, 2)) recaps.push({ summary: `[${m.title}] ${r.summary}`, ts: r.ts });
  }
  decisions.sort((a, b) => b.ts - a.ts);
  recaps.sort((a, b) => b.ts - a.ts);

  const todos = db
    .prepare(
      `SELECT t.title, t.done, u.username AS author FROM todos t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN meetings m ON m.id = t.meeting_id
       WHERE t.user_id = ? AND (${orgId == null ? 'm.id IS NULL OR m.org_id IS NULL' : 'm.org_id = ?'})
       ORDER BY t.id DESC LIMIT 20`,
    )
    .all(userId, ...scopeArgs) as { title: string; done: number; author: string }[];

  const ctx: AgentContext = {
    meetingTitle: orgId == null ? '개인 워크스페이스' : '조직 워크스페이스',
    decisions: decisions.slice(0, 30),
    recaps: recaps.slice(0, 8),
    todos,
    chat: [], // 1:1 질의는 그룹 대화를 근거로 안 씀 — 스코프 전체 기록만
  };

  if (openai) {
    try {
      const me = db.prepare('SELECT username, name FROM users WHERE id = ?').get(userId) as
        | { username: string; name: string | null }
        | undefined;
      return await aiAnswer(question, me?.name || me?.username || '사용자', ctx);
    } catch (err) {
      console.error('[steward] DM AI 실패, 규칙 폴백:', err);
    }
  }
  return ruleBasedAnswer(question, ctx);
}

/* ── 다음 회의 아젠다 제안 — 회의 "전"에도 총무가 일한다 ──
 * 재료: 최근 recap 요약/결정, 미완료 할 일, 최근 채팅.
 * AI 실패·키 없음 → 규칙 폴백 (미완료 할 일 상위). 10분 캐시. */

export interface AgendaItem {
  title: string;
  why: string; // 근거 한 줄 ("지난 통화 미결" / "미완료 할 일" 등)
}

export interface Agenda {
  items: AgendaItem[];
  source: 'ai' | 'rule';
  generatedAt: number;
}

const agendaCache = new Map<number, Agenda>();
const AGENDA_CACHE_MS = 10 * 60 * 1000;

/** 규칙 폴백 — 미완료 할 일과 최근 결정 후속을 안건으로 */
function ruleBasedAgenda(ctx: AgentContext): AgendaItem[] {
  const items: AgendaItem[] = [];
  for (const t of ctx.todos.filter((t) => !t.done).slice(0, 3)) {
    items.push({ title: `"${t.title}" 진행 상황 공유`, why: `${t.author}의 미완료 할 일` });
  }
  if (items.length < 2 && ctx.decisions[0]) {
    items.push({
      title: `지난 결정 후속 점검 — ${ctx.decisions[0].decision.slice(0, 40)}`,
      why: '가장 최근 결정',
    });
  }
  return items.slice(0, 4);
}

async function aiAgenda(ctx: AgentContext): Promise<AgendaItem[]> {
  const system =
    `너는 분산 근무 플랫폼 exist의 AI 총무다. "${ctx.meetingTitle}" 그룹의 다음 회의 안건 초안을 만든다. ` +
    '아래 기록(통화 정리·결정·미완료 할 일·최근 대화)에서 아직 끝나지 않았거나 다음에 논의하기로 한 것만 골라 ' +
    '안건 2~4개를 제안한다. 기록에 없는 내용은 만들지 않는다.\n' +
    '각 안건: title(한국어 30자 이내, 명사형), why(근거 한 줄 20자 이내 — 어떤 기록에서 나왔는지).\n' +
    '응답은 오직 JSON: {"items": [{"title": string, "why": string}]}';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          call_summaries: ctx.recaps.map((r) => r.summary),
          decisions: ctx.decisions.map((d) => d.decision),
          undone_todos: ctx.todos.filter((t) => !t.done).map((t) => `${t.title} (${t.author})`),
          recent_chat: ctx.chat.slice(-20).map((c) => `${c.from}: ${c.text}`),
        }),
      },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
    items?: unknown;
  };
  if (!Array.isArray(parsed.items)) throw new Error('no items');
  const items = parsed.items
    .map((it) => ({
      title: String((it as AgendaItem).title ?? '').trim().slice(0, 60),
      why: String((it as AgendaItem).why ?? '').trim().slice(0, 40),
    }))
    .filter((it) => it.title)
    .slice(0, 4);
  if (items.length === 0) throw new Error('empty agenda');
  return items;
}

/** recap 생성 등 기록이 갱신되면 아젠다 캐시를 버림 — 10분 캐시가 구버전 재료를 물고 있지 않게 */
export function invalidateAgenda(meetingId: number) {
  agendaCache.delete(meetingId);
}

export async function generateAgenda(meetingId: number, channelId: number): Promise<Agenda> {
  const cached = agendaCache.get(meetingId);
  if (cached && Date.now() - cached.generatedAt < AGENDA_CACHE_MS) return cached;

  const ctx = gatherContext(meetingId, channelId);
  let result: Agenda;
  if (openai) {
    try {
      result = { items: await aiAgenda(ctx), source: 'ai', generatedAt: Date.now() };
    } catch (err) {
      console.error('[steward] 아젠다 AI 실패, 규칙 폴백:', err);
      result = { items: ruleBasedAgenda(ctx), source: 'rule', generatedAt: Date.now() };
    }
  } else {
    result = { items: ruleBasedAgenda(ctx), source: 'rule', generatedAt: Date.now() };
  }
  agendaCache.set(meetingId, result);
  return result;
}

/** io 최소 인터페이스 — 테스트에서 스텁 주입용 */
interface Broadcaster {
  to(room: string): { emit(event: string, payload: unknown): void };
}

/* ── 채팅 결정 감지 — 부르지 않아도 일하는 총무 ──
 * "~하기로 했다/확정/합의" 패턴이 보이면 결정 후보로 제안 (기록은 사람이 버튼으로 확정).
 * 과잉 개입 방지: 회의당 2분 쿨다운. */
export const DECISION_RX = /(하기로 (했|함|결정)|확정(했|입니다|이에요)|합의(했|됐)|결정(했|됐))/;
const DECISION_SUGGEST_PREFIX = '💡 결정 후보: ';
const decisionCooldown = new Map<number, number>();
const DECISION_COOLDOWN_MS = 2 * 60 * 1000;

export function maybeSuggestDecision(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; from: string; text: string },
): void {
  if (!DECISION_RX.test(args.text)) return;
  if (AGENT_MENTION.test(args.text)) return; // @AI 질의는 답변 흐름이 따로 처리
  const last = decisionCooldown.get(args.meetingId) ?? 0;
  if (Date.now() - last < DECISION_COOLDOWN_MS) return;
  decisionCooldown.set(args.meetingId, Date.now());

  const quoted = args.text.trim().slice(0, 160);
  const suggest = `${DECISION_SUGGEST_PREFIX}"${quoted}" — ${args.from}님의 발언을 결정 원장에 기록할까요?`;
  const agentId = ensureAgentUser();
  db.prepare(
    'INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)',
  ).run(args.meetingId, agentId, suggest, args.channelId);
  io.to(`chat:${args.code.toUpperCase()}`).emit('chat:message', {
    code: args.code.toUpperCase(),
    from: AGENT_NAME,
    avatar: AGENT_AVATAR,
    text: suggest,
    channelId: args.channelId,
    ts: Date.now(),
  });
}

/**
 * @AI 멘션 처리 — 기록 기반 답변을 만들어 그 채널에 exist AI 명의로 게시.
 * chat:send에서 비동기로 호출 (사용자 메시지 브로드캐스트를 막지 않음).
 */
export async function handleAgentQuery(
  io: Broadcaster,
  args: { meetingId: number; code: string; channelId: number; asker: string; text: string },
): Promise<void> {
  const ctx = gatherContext(args.meetingId, args.channelId);
  const question = args.text.replace(AGENT_MENTION, '').trim() || '지금 상황 요약해줘';

  let answer: string;
  if (openai) {
    try {
      answer = await aiAnswer(question, args.asker, ctx);
    } catch (err) {
      console.error('[steward] AI 실패, 규칙 폴백:', err);
      answer = ruleBasedAnswer(question, ctx);
    }
  } else {
    answer = ruleBasedAnswer(question, ctx);
  }

  const agentId = ensureAgentUser();
  db.prepare(
    'INSERT INTO messages (meeting_id, user_id, text, channel_id) VALUES (?, ?, ?, ?)',
  ).run(args.meetingId, agentId, answer, args.channelId);
  io.to(`chat:${args.code.toUpperCase()}`).emit('chat:message', {
    code: args.code.toUpperCase(),
    from: AGENT_NAME,
    avatar: AGENT_AVATAR,
    text: answer,
    channelId: args.channelId,
    ts: Date.now(),
  });
}
