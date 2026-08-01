import OpenAI from 'openai';
import db from './db.js';
import { notifyUser } from './notify.js';
import { invalidateBrief } from './agent.js';
import { invalidateAgenda, ensureAgentUser, settleAgendaAfterRecap } from './steward.js';

/*
 * exist P1 — 회의 통화가 끝나면 그 회의의 채팅에서 결정·할 일을 추출해
 * 참석자/불참자에게 배달한다. "회의에 없던 사람에게 결정이 흘러가는 것"이 목적.
 *
 * 흐름: sfu의 통화 방이 비워짐 → scheduleRecap(유예 후 실행, 재입장 시 취소)
 *       → runRecapForMeeting: 채팅 수집 → AI 추출(폴백: 규칙) → 저장
 *       → 담당자 매칭된 할 일 자동 생성 → 참석/불참 구분해 알림 라우팅.
 * OPENAI_API_KEY 없거나 실패 시 규칙 기반 폴백 (agent.ts와 동일 패턴).
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
/** 방이 비워진 뒤 이만큼 기다렸다 요약 — 새로고침·재입장이면 취소 (데모 땐 env로 줄임) */
const GRACE_MS = Number(process.env.RECAP_GRACE_MS ?? 30_000);
/** 요약할 최소 메시지 수 — 미만이면 조용히 스킵 */
const MIN_MESSAGES = 2;

export interface RecapAction {
  assignee: string | null; // 참여자 username 또는 null
  title: string;
}

/** 로그에서 명시적으로 합의된 다음 회의 시각 — AI 제안일 뿐, 등록은 사람이 버튼으로 확정 */
export interface NextMeeting {
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
  registered?: boolean; // 일정으로 등록 완료 (RecapPanel 버튼)
}

export interface RecapResult {
  summary: string;
  decisions: string[];
  /** 결정별 배경 한 줄 (decisions와 인덱스 정렬, 로그에 근거 없으면 '') —
   *  실무자 인터뷰 반영: "결정 내용은 남는데 왜 그렇게 됐는지는 유실된다" */
  whys: string[];
  /** 결정별 검토된 대안 ("대안 — 기각 사유" 한 줄씩, decisions와 인덱스 정렬) —
   *  실무자 인터뷰 반영: 기각된 대안의 기록이 없어 나중에 같은 검토를 처음부터 반복한다 */
  alts: string[][];
  actions: RecapAction[];
  nextMeeting: NextMeeting | null;
  source: 'ai' | 'rule';
}

interface ChatMsg {
  from: string;
  text: string;
}

/** 규칙 기반 폴백 — 키워드로 결정/할 일 후보를 추린다 (API 키 없이도 동작) */
export function ruleBasedRecap(msgs: ChatMsg[], participants: string[]): RecapResult {
  const decisions: string[] = [];
  const actions: RecapAction[] = [];
  const names = new Set(participants);

  for (const m of msgs) {
    const text = m.text.trim();
    if (!text) continue;
    if (/(하기로|결정|확정|합의|정했)/.test(text) && decisions.length < 5) {
      decisions.push(`${m.from}: ${text.slice(0, 120)}`);
      continue;
    }
    // 할 일 신호: 마감·요청 표현 + "~게요/~겠습니다"류 자기 약속 어미
    if (/(까지|해주세요|해 주세요|부탁|겠습니다|[가-힣]게요|담당)/.test(text) && actions.length < 5) {
      // @이름 멘션이 참여자와 일치하면 담당자로, "제가/내가 ...게요"면 화자 본인
      const mention = text.match(/@([\w가-힣.-]+)/);
      let assignee: string | null = null;
      if (mention && names.has(mention[1])) assignee = mention[1];
      else if (/(제가|내가)/.test(text) && /(게요|겠습니다)/.test(text)) assignee = m.from;
      actions.push({ assignee, title: text.slice(0, 120) });
    }
  }

  const summary =
    decisions.length > 0
      ? decisions[0].replace(/^[^:]+: /, '').slice(0, 80)
      : `메시지 ${msgs.length}건 논의 (뚜렷한 결정 없음)`;
  // 규칙 기반은 날짜 해석이 위험해서(오해석 → 엉뚱한 일정) 다음 회의 제안은 AI 경로에서만.
  // 배경 추론도 AI 경로에서만 — 규칙으로 "왜"를 짚으면 오염 위험
  // 대안 추출도 AI 경로에서만 — 규칙으로 "기각된 안"을 짚으면 오염 위험
  return { summary, decisions, whys: decisions.map(() => ''), alts: decisions.map(() => []), actions, nextMeeting: null, source: 'rule' };
}

/** OpenAI 기반 추출 — 결정·할 일·요약을 JSON으로 */
async function aiRecap(msgs: ChatMsg[], participants: string[]): Promise<RecapResult> {
  const system =
    '너는 분산 근무 플랫폼 exist의 AI 운영자다. 회의 채팅 로그에서 팀이 합의한 결정과 할 일을 추출한다. ' +
    '이 결과는 회의에 참석하지 못한 팀원에게 그대로 전달되므로, 로그에 없는 사실·수치를 만들지 않는다.\n' +
    '응답은 오직 JSON 한 개. 형식: {"summary": string, "decisions": [{"text": string, "why": string, "alternatives": string[]}], "actions": [{"assignee": string|null, "title": string}], "next_meeting": {"title": string, "date": "YYYY-MM-DD", "time": "HH:MM"|null} | null}.\n' +
    'summary는 논의 핵심 한 줄(한국어 80자 이내). decisions는 실제로 합의·확정된 것만(최대 5개, 없으면 빈 배열). ' +
    'decisions[].why는 그 결정의 배경·근거 한 줄(한국어 60자 이내) — 로그에서 언급된 이유만 담고, 로그에 근거가 없으면 반드시 빈 문자열 "" (추측 금지). ' +
    'decisions[].alternatives는 그 결정에 이르며 검토됐지만 채택되지 않은 다른 안 — "대안 내용 — 기각·보류 사유" 형식 한 줄씩(각 80자 이내, 최대 3개). 로그에서 실제로 언급된 대안만, 없으면 빈 배열 (추측 금지). ' +
    'actions는 구체적인 할 일(최대 5개). assignee는 반드시 participants 목록의 username 중 하나이거나, 로그로 담당자를 특정할 수 없으면 null.\n' +
    'next_meeting은 다음 회의 시각이 로그에서 명시적으로 제안·합의된 경우에만 채운다. ' +
    '상대 표현(내일, 수요일, 다음 주 금요일)은 요일을 직접 계산하지 말고 반드시 calendar 목록에서 해당 요일의 가장 가까운 날짜를 찾아 쓴다. ' +
    '날짜를 특정할 수 없거나("조만간", "나중에") 언급 자체가 없으면 반드시 null — 추측 금지. 시각 언급이 없으면 time만 null.';

  const response = await openai!.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: 600,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: JSON.stringify({
          // 상대 날짜("수요일") 해석 기준 — 모델이 요일 산수를 틀리므로 2주치 달력을 주고 찾게 한다
          now: `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16)} (${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' })})`,
          calendar: Array.from({ length: 14 }, (_, i) => {
            const d = new Date(Date.now() + i * 86_400_000);
            return `${d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })} (${d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', weekday: 'short' })})`;
          }),
          participants,
          chat: msgs.map((m) => `${m.from}: ${m.text}`),
        }),
      },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? '';
  if (!raw) throw new Error('empty AI response');
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s === -1 || e < s) throw new Error('no json');
  const parsed = JSON.parse(raw.slice(s, e + 1)) as {
    summary?: unknown;
    decisions?: unknown;
    actions?: unknown;
    next_meeting?: unknown;
  };

  const names = new Set(participants);
  const summary = String(parsed.summary ?? '').trim().slice(0, 160);
  if (!summary) throw new Error('empty summary');
  // 결정 파싱 — 새 형식({text, why, alternatives})과 구 형식(string) 모두 수용 (모델이 형식을 놓칠 수 있음)
  const decisions: string[] = [];
  const whys: string[] = [];
  const alts: string[][] = [];
  for (const d of (Array.isArray(parsed.decisions) ? parsed.decisions : []).slice(0, 5)) {
    if (d && typeof d === 'object') {
      const o = d as { text?: unknown; why?: unknown; alternatives?: unknown };
      const text = String(o.text ?? '').trim();
      if (!text) continue;
      decisions.push(text.slice(0, 200));
      whys.push(String(o.why ?? '').trim().slice(0, 160));
      alts.push(
        (Array.isArray(o.alternatives) ? o.alternatives : [])
          .map((a) => String(a).trim().slice(0, 120))
          .filter(Boolean)
          .slice(0, 3),
      );
    } else {
      const text = String(d).trim();
      if (!text) continue;
      decisions.push(text.slice(0, 200));
      whys.push('');
      alts.push([]);
    }
  }
  const actions: RecapAction[] = (Array.isArray(parsed.actions) ? parsed.actions : [])
    .map((a) => {
      const o = a as { assignee?: unknown; title?: unknown };
      const assignee = typeof o.assignee === 'string' && names.has(o.assignee) ? o.assignee : null;
      return { assignee, title: String(o.title ?? '').trim().slice(0, 160) };
    })
    .filter((a) => a.title)
    .slice(0, 5);

  // 다음 회의 제안 — 형식 검증 + 과거 날짜 거부 (틀린 제안이 일정으로 박히는 게 최악이라 보수적으로)
  let nextMeeting: NextMeeting | null = null;
  const nm = parsed.next_meeting as { title?: unknown; date?: unknown; time?: unknown } | null;
  if (nm && typeof nm === 'object') {
    const date = String(nm.date ?? '');
    const time = nm.time == null ? null : String(nm.time);
    const todayKst = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      (time === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) &&
      date >= todayKst
    ) {
      nextMeeting = { title: String(nm.title ?? '').trim().slice(0, 80) || '다음 회의', date, time };
    }
  }
  return { summary, decisions, whys, alts, actions, nextMeeting, source: 'ai' };
}

/** 관련성 라우팅 — 결정이 작업에 직접 영향을 주는 참가자 추론 (실패·불확실 시 빈 집합 = 일반 톤) */
async function inferAffected(
  decisions: string[],
  members: { id: number; username: string; position: string | null; department: string | null }[],
): Promise<Set<number>> {
  if (!openai || decisions.length === 0 || members.length < 2) return new Set();
  try {
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            '너는 exist의 AI 총무다. 회의 결정 목록과 참가자(직무·부서)를 보고, 결정이 그 사람의 "작업 방식·기준을 직접 바꾸는" 참가자만 고른다.\n' +
            '단순히 알아두면 좋은 정도는 제외. 직무 정보가 없거나 판단이 안 서면 고르지 않는다.\n' +
            '응답은 오직 JSON: {"critical": [username]} — 없으면 빈 배열',
        },
        {
          role: 'user',
          content: JSON.stringify({
            decisions,
            members: members.map((m) => ({
              username: m.username,
              position: m.position ?? '',
              department: m.department ?? '',
            })),
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      critical?: unknown;
    };
    const names = new Set(
      (Array.isArray(parsed.critical) ? parsed.critical : []).map((n) => String(n)),
    );
    return new Set(members.filter((m) => names.has(m.username)).map((m) => m.id));
  } catch (err) {
    console.error('[recap] 관련성 추론 실패 — 일반 톤 폴백:', err);
    return new Set();
  }
}

/** 추출 (AI → 실패 시 규칙 폴백) */
export async function extractRecap(msgs: ChatMsg[], participants: string[]): Promise<RecapResult> {
  if (openai) {
    try {
      return await aiRecap(msgs, participants);
    } catch (err) {
      console.error('[recap] OpenAI 실패, 규칙 기반 폴백:', err);
    }
  }
  return ruleBasedRecap(msgs, participants);
}

export interface RecapRow {
  id: number;
  summary: string;
  decisions: string[];
  /** 결정별 배경 (decisions와 인덱스 정렬, 없으면 '') */
  whys: string[];
  /** 결정별 검토된 대안 (없으면 빈 배열) */
  alts: string[][];
  actions: RecapAction[];
  attendees: string[];
  nextMeeting: NextMeeting | null;
  source: string;
  ts: number;
  /** 이 기록이 열린 일정 이벤트 — 즉석 회의면 null */
  eventId: number | null;
}

/** whys 컬럼 파싱 — 구 데이터(null)는 decisions 길이만큼 빈 문자열로 */
function parseWhys(raw: string | null, count: number): string[] {
  let whys: string[] = [];
  try {
    whys = raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    whys = [];
  }
  return Array.from({ length: count }, (_, i) => String(whys[i] ?? ''));
}

/** alts 컬럼 파싱 — 구 데이터(null)는 decisions 길이만큼 빈 배열로 */
function parseAlts(raw: string | null, count: number): string[][] {
  let alts: string[][] = [];
  try {
    alts = raw ? (JSON.parse(raw) as string[][]) : [];
  } catch {
    alts = [];
  }
  return Array.from({ length: count }, (_, i) =>
    Array.isArray(alts[i]) ? alts[i].map(String) : [],
  );
}

/** 회의의 recap 목록 (최신순) — API·클라 표시용 */
export function listRecaps(meetingId: number, limit = 20): RecapRow[] {
  const rows = db
    .prepare(
      `SELECT id, summary, decisions, whys, alts, actions, attendees, next_meeting, source, created_at, event_id
       FROM meeting_recaps WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(meetingId, limit) as {
    id: number;
    summary: string;
    decisions: string;
    whys: string | null;
    alts: string | null;
    actions: string;
    attendees: string;
    next_meeting: string | null;
    source: string;
    created_at: string;
    event_id: number | null;
  }[];
  return rows.map((r) => {
    const decisions = JSON.parse(r.decisions) as string[];
    return {
      id: r.id,
      summary: r.summary,
      decisions,
      whys: parseWhys(r.whys, decisions.length),
      alts: parseAlts(r.alts, decisions.length),
      actions: JSON.parse(r.actions),
      attendees: JSON.parse(r.attendees),
      nextMeeting: r.next_meeting ? (JSON.parse(r.next_meeting) as NextMeeting) : null,
      source: r.source,
      ts: new Date(r.created_at + 'Z').getTime(),
      eventId: r.event_id ?? null,
    };
  });
}

/**
 * P1 본체 — 통화가 끝난 회의의 채팅을 요약해 저장하고 라우팅한다.
 * @param code 회의 코드
 * @param sessionUserIds 이번 통화에 실제로 들어왔던 userId들
 * @returns 저장된 recap id, 스킵 시 null
 */
export async function runRecapForMeeting(
  code: string,
  sessionUserIds: number[],
  opts: { trigger?: 'call' | 'manual' } = {},
): Promise<number | null> {
  const trigger = opts.trigger ?? 'call';
  const meeting = db
    .prepare('SELECT id, code, title FROM meetings WHERE code = ?')
    .get(code.toUpperCase()) as { id: number; code: string; title: string } | undefined;
  if (!meeting) return null;

  // 요약 창: 마지막 recap 이후 ~ 지금. 첫 recap이면 최근 24시간.
  // 1건짜리 수동/자동 기록(source manual·auto)은 요약이 아니므로 창 기준에서 제외 —
  // 안 그러면 채팅 도중 자동 기록 하나가 창을 당겨 그 앞 메시지들이 요약에서 증발한다
  const last = db
    .prepare(
      `SELECT MAX(call_ended_at) AS t FROM meeting_recaps
       WHERE meeting_id = ? AND source NOT IN ('manual', 'auto')`,
    )
    .get(meeting.id) as { t: string | null };
  const since = last.t ?? new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

  // 채팅 + 통화 음성 전사를 시간순으로 합쳐서 요약 재료로 쓴다.
  // AI 자신의 메시지는 제외 — 과거 AI 답변("내용이 부족…")을 다시 먹고 그대로 요약하는 자기 오염 방지
  const agentId = ensureAgentUser();
  const chatMsgs = (
    db
      .prepare(
        `SELECT u.username AS "from", m.text, m.created_at AS at FROM messages m
         JOIN users u ON u.id = m.user_id
         WHERE m.meeting_id = ? AND m.user_id != ? AND m.created_at > ? AND m.text != ''
         ORDER BY m.id ASC LIMIT 200`,
      )
      .all(meeting.id, agentId, since) as (ChatMsg & { at: string })[]
  ) // "@AI"처럼 멘션만 있고 내용이 없는 메시지도 재료가 아님
    .filter((m) => m.text.replace(/@[\w가-힣.-]+/g, '').trim().length > 0);
  const voiceMsgs = db
    .prepare(
      `SELECT u.username AS "from", t.text, t.created_at AS at FROM call_transcripts t
       JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.created_at > ?
       ORDER BY t.id ASC LIMIT 300`,
    )
    .all(meeting.id, since) as (ChatMsg & { at: string })[];
  // 화자명은 순수 username 유지 — ruleBasedRecap의 담당자 매칭("제가 …게요")이 깨지지 않도록
  const msgs: ChatMsg[] = [...chatMsgs, ...voiceMsgs]
    .sort((a, b) => (a.at < b.at ? -1 : 1))
    .map((m) => ({ from: m.from, text: m.text }));
  if (msgs.length < MIN_MESSAGES) return null;

  // 회의 등록 참가자 전원 (배달 대상) — 참석/불참은 sessionUserIds로 구분
  const members = db
    .prepare(
      `SELECT u.id, u.username, u.position, u.department FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ?`,
    )
    .all(meeting.id) as { id: number; username: string; position: string | null; department: string | null }[];
  if (members.length === 0) return null;

  const recap = await extractRecap(
    msgs,
    members.map((m) => m.username),
  );

  const inCall = new Set(sessionUserIds);
  const attendees = members.filter((m) => inCall.has(m.id)).map((m) => m.username);

  // 이 기록이 어느 일정(이벤트)의 회의였는지 — 오늘 날짜의 이벤트 중 현재 시각에 가장 가까운 것.
  // 일정→기록 점프의 연결고리 (없으면 null — 즉석 회의)
  const todayKst = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  const nowHm = new Date().toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 5);
  const todayEvents = db
    .prepare('SELECT id, time FROM meeting_events WHERE meeting_id = ? AND date = ?')
    .all(meeting.id, todayKst) as { id: number; time: string | null }[];
  const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const eventId =
    todayEvents
      .map((e) => ({ id: e.id, diff: e.time ? Math.abs(toMin(e.time) - toMin(nowHm)) : 12 * 60 }))
      .sort((a, b) => a.diff - b.diff)[0]?.id ?? null;

  const info = db
    .prepare(
      `INSERT INTO meeting_recaps (meeting_id, summary, decisions, whys, alts, actions, attendees, next_meeting, source, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meeting.id,
      recap.summary,
      JSON.stringify(recap.decisions),
      JSON.stringify(recap.whys),
      JSON.stringify(recap.alts),
      JSON.stringify(recap.actions),
      JSON.stringify(attendees),
      recap.nextMeeting ? JSON.stringify(recap.nextMeeting) : null,
      recap.source,
      eventId,
    );
  const recapId = info.lastInsertRowid as number;

  // 담당자가 특정된 할 일은 그 사람의 회의 할 일로 자동 생성
  const byName = new Map(members.map((m) => [m.username, m.id]));
  const assignedCount = new Map<number, number>();
  for (const a of recap.actions) {
    if (!a.assignee) continue;
    const uid = byName.get(a.assignee);
    if (!uid) continue;
    const todoInfo = db
      .prepare('INSERT INTO todos (user_id, meeting_id, title, recap_id) VALUES (?, ?, ?, ?)')
      .run(uid, meeting.id, a.title.slice(0, 200), recapId);
    db.prepare('INSERT OR IGNORE INTO todo_assignees (todo_id, user_id) VALUES (?, ?)').run(
      todoInfo.lastInsertRowid,
      uid,
    );
    assignedCount.set(uid, (assignedCount.get(uid) ?? 0) + 1);
  }

  // 라우팅 — 참석자에겐 요약, 불참자에겐 "못 들어간 회의의 결정" (P1의 핵심)
  const stats = [
    recap.decisions.length > 0 ? `결정 ${recap.decisions.length}` : null,
    recap.actions.length > 0 ? `할 일 ${recap.actions.length}` : null,
    recap.nextMeeting ? '다음 회의 제안' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  // 관련성 라우팅 — 결정이 작업 방식을 바꾸는 사람에게는 "작업 전 확인 필수" 등급으로 (알림 피로 방지의 역설계:
  // 전원에게 같은 톤으로 뿌리면 중요한 것도 묻힌다. 직무·부서로 영향 범위를 추론해 톤을 가른다)
  const critical = await inferAffected(recap.decisions, members);

  const what = trigger === 'manual' ? '기록' : '통화';
  for (const m of members) {
    const mine = assignedCount.get(m.id);
    const mineSuffix = mine ? ` — 내 할 일 ${mine}개 배정됨` : '';
    const prefix = critical.has(m.id) ? '🔴 작업 전 확인 필수 — ' : '';
    const text = inCall.has(m.id)
      ? `${prefix}"${meeting.title}" ${what} 정리: ${recap.summary}${stats ? ` (${stats})` : ''}${mineSuffix}`
      : `${prefix}놓친 "${meeting.title}" ${what}의 결정이 도착했어요: ${recap.summary}${stats ? ` (${stats})` : ''}${mineSuffix}`;
    notifyUser(m.id, { from: 'exist AI', text, kind: 'recap', meetingCode: meeting.code });
    invalidateBrief(m.id);
  }

  // 새 recap이 생겼으니 아젠다는 다시 만들어야 함 (10분 캐시가 구재료를 물지 않게)
  invalidateAgenda(meeting.id);
  // 이월 안건 정산 — 이번 회의에서 결론 난 안건은 종결, 못 낸 안건은 rounds+1로 다음 안건에 재상정
  void settleAgendaAfterRecap(meeting.id, {
    summary: recap.summary,
    decisions: recap.decisions,
  }).catch((err) => console.error('[recap] 안건 정산 실패:', err));

  console.log(
    `[recap] ${meeting.code} 요약 저장 (${recap.source}) — 결정 ${recap.decisions.length}, 할 일 ${recap.actions.length}, 배달 ${members.length}명`,
  );
  return recapId;
}

export interface LedgerEntry {
  recapId: number;
  /** recap 안에서의 결정 순번 — 수신 확인의 키 (recapId + idx) */
  idx: number;
  decision: string;
  /** 결정 배경 한 줄 — 없으면 '' */
  why: string;
  /** 검토됐지만 채택되지 않은 대안 ("대안 — 기각 사유") — 없으면 빈 배열 */
  alts: string[];
  attendees: string[];
  ts: number;
  /** 수신 확인한 사람들 (회람 사인) — note = 현장 피드백 한 줄(선택) */
  acks: { username: string; ts: number; note: string | null }[];
  /** 이 recap에서 파생된 할 일 — 결정이 실행됐는지 추적 (P1 체인의 실행 단계) */
  todos: { title: string; done: number }[];
}

/** 결정 원장 — 이 그룹의 모든 recap 결정을 시간순(최신 먼저)으로 편다.
 *  "결정이 사람이 아니라 조직에 남는다"의 데이터 뷰. AI 질의응답의 근거로도 사용. */
export function listDecisions(meetingId: number, limit = 100): LedgerEntry[] {
  const rows = db
    .prepare(
      `SELECT id, decisions, whys, alts, attendees, created_at FROM meeting_recaps
       WHERE meeting_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .all(meetingId) as { id: number; decisions: string; whys: string | null; alts: string | null; attendees: string; created_at: string }[];
  const ackStmt = db.prepare(
    `SELECT a.decision_idx, u.username, a.created_at, a.note FROM decision_acks a
     JOIN users u ON u.id = a.user_id WHERE a.recap_id = ? ORDER BY a.id`,
  );
  const todoStmt = db.prepare('SELECT title, done FROM todos WHERE recap_id = ? ORDER BY id');
  const out: LedgerEntry[] = [];
  for (const r of rows) {
    const ts = new Date(r.created_at + 'Z').getTime();
    const attendees = JSON.parse(r.attendees) as string[];
    const ackRows = ackStmt.all(r.id) as {
      decision_idx: number;
      username: string;
      created_at: string;
      note: string | null;
    }[];
    const decisions = JSON.parse(r.decisions) as string[];
    const recapTodos = todoStmt.all(r.id) as { title: string; done: number }[];
    const whys = parseWhys(r.whys, decisions.length);
    const altsAll = parseAlts(r.alts, decisions.length);
    for (let idx = 0; idx < decisions.length; idx++) {
      out.push({
        recapId: r.id,
        idx,
        decision: decisions[idx],
        why: whys[idx],
        alts: altsAll[idx],
        attendees,
        ts,
        acks: ackRows
          .filter((a) => a.decision_idx === idx)
          .map((a) => ({
            username: a.username,
            ts: new Date(a.created_at + 'Z').getTime(),
            note: a.note ?? null,
          })),
        todos: recapTodos,
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 다음 회의 제안을 "등록됨"으로 표시 — 실제 일정 등록은 클라가 기존 events API로 하고,
 *  이 플래그는 RecapPanel 버튼 상태(중복 등록 방지)용. 참가자 검증은 라우트에서 */
export function markNextMeetingRegistered(recapId: number, meetingId: number): boolean {
  const row = db
    .prepare('SELECT next_meeting FROM meeting_recaps WHERE id = ? AND meeting_id = ?')
    .get(recapId, meetingId) as { next_meeting: string | null } | undefined;
  if (!row?.next_meeting) return false;
  const nm = JSON.parse(row.next_meeting) as NextMeeting;
  nm.registered = true;
  db.prepare('UPDATE meeting_recaps SET next_meeting = ? WHERE id = ?').run(
    JSON.stringify(nm),
    recapId,
  );
  return true;
}

/** 결정 수신 확인 — 참가자 검증은 라우트에서. 중복 확인은 무시(idempotent).
 *  note = 현장 피드백 한 줄(선택) — 이미 확인한 뒤에도 노트만 추가/갱신 가능 */
export function ackDecision(
  recapId: number,
  decisionIdx: number,
  userId: number,
  note?: string | null,
): boolean {
  const recap = db.prepare('SELECT decisions FROM meeting_recaps WHERE id = ?').get(recapId) as
    | { decisions: string }
    | undefined;
  if (!recap) return false;
  const count = (JSON.parse(recap.decisions) as string[]).length;
  if (decisionIdx < 0 || decisionIdx >= count) return false;
  db.prepare(
    'INSERT OR IGNORE INTO decision_acks (recap_id, decision_idx, user_id) VALUES (?, ?, ?)',
  ).run(recapId, decisionIdx, userId);
  if (note != null && note.trim()) {
    db.prepare(
      'UPDATE decision_acks SET note = ? WHERE recap_id = ? AND decision_idx = ? AND user_id = ?',
    ).run(note.trim().slice(0, 120), recapId, decisionIdx, userId);
  }
  return true;
}

/* ── 미확인자 자동 리마인드 — 현장 요구 반영 ("미확인자 알림"·"누가 봤는지 불명확") ──
 * recap 생성 후 DECISION_REMIND_MS(기본 24시간) 지나도 원장에 서명이 하나도 없는 참가자에게
 * 1회만 보챈다. 하나라도 확인한 사람은 원장을 본 것이므로 제외. */
const DECISION_REMIND_MS = Number(process.env.DECISION_REMIND_MS ?? 24 * 3600_000);

export function runDecisionReminders(): number {
  const now = Date.now();
  const fmt = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db
    .prepare(
      `SELECT r.id, r.meeting_id, r.decisions, m.title, m.code FROM meeting_recaps r
       JOIN meetings m ON m.id = r.meeting_id
       WHERE r.created_at <= ? AND r.created_at >= ? AND r.decisions != '[]'`,
    )
    .all(fmt(now - DECISION_REMIND_MS), fmt(now - 7 * 24 * 3600_000)) as {
    id: number;
    meeting_id: number;
    decisions: string;
    title: string;
    code: string;
  }[];
  const agentId = ensureAgentUser();
  let sent = 0;
  for (const r of rows) {
    const count = (JSON.parse(r.decisions) as string[]).length;
    if (!count) continue;
    const participants = db
      .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ?')
      .all(r.meeting_id) as { user_id: number }[];
    const acked = new Set(
      (
        db.prepare('SELECT DISTINCT user_id FROM decision_acks WHERE recap_id = ?').all(r.id) as {
          user_id: number;
        }[]
      ).map((a) => a.user_id),
    );
    for (const p of participants) {
      if (p.user_id === agentId || acked.has(p.user_id)) continue;
      const dup = db
        .prepare('SELECT 1 FROM decision_remind_sent WHERE recap_id = ? AND user_id = ?')
        .get(r.id, p.user_id);
      if (dup) continue;
      db.prepare('INSERT INTO decision_remind_sent (recap_id, user_id) VALUES (?, ?)').run(
        r.id,
        p.user_id,
      );
      notifyUser(p.user_id, {
        from: 'exist AI',
        text: `"${r.title}"의 결정 ${count}건이 아직 확인을 기다려요 — 결정 탭에서 서명해 주세요`,
        kind: 'recap',
        meetingCode: r.code,
      });
      sent++;
    }
  }
  if (sent) console.log(`[recap] 미확인 리마인드 ${sent}건 발송`);
  return sent;
}

// ── 통화 종료 유예 스케줄러 — 방이 비워지면 GRACE_MS 후 실행, 재입장 시 취소 ──
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleRecap(code: string, sessionUserIds: number[]) {
  const key = code.toUpperCase();
  cancelScheduledRecap(key);
  const timer = setTimeout(() => {
    pending.delete(key);
    runRecapForMeeting(key, sessionUserIds).catch((err) =>
      console.error('[recap] 실행 실패:', err),
    );
  }, GRACE_MS);
  pending.set(key, timer);
}

/** 통화 방이 다시 생기면(재입장) 예약된 요약 취소 — 세션이 이어진 것으로 본다 */
export function cancelScheduledRecap(code: string) {
  const key = code.toUpperCase();
  const t = pending.get(key);
  if (t) {
    clearTimeout(t);
    pending.delete(key);
  }
}
