import OpenAI from 'openai';
import db from './db.js';
import { notifyUser } from './notify.js';
import { invalidateBrief } from './agent.js';
import { ensureAgentUser } from './steward.js';

/*
 * 교대 인수인계 — 조가 끝날 때 AI가 그 조 시간대의 기록(채팅·결정·할 일)에서
 * 표준 포맷 초안을 만들고, 조장이 다듬어 발행하면 다음 조가 서명(수신 확인)한다.
 * 현직자 페인 대응: 기록 형식 비통일(→ 고정 4섹션) · 야간조 전달 누락(→ 서명 도달률)
 * · 검색 불가(→ 전역 검색 포함). 원칙: 강제 입력 0 — 초안은 AI, 사람은 다듬고 확인만.
 */

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/** 고정 4섹션 — 작성자·연차에 따라 품질이 갈리지 않게 형식을 시스템이 강제 */
export interface HandoverSections {
  /** 설비·작업 이상 */
  issues: string[];
  /** 이번 조에서 정해진 변경 사항 */
  changes: string[];
  /** 미완료 조치 — 다음 조가 이어받아야 하는 것 */
  pending: string[];
  /** 다음 조 유의사항 */
  notes: string[];
}

export interface HandoverRow {
  id: number;
  author: string;
  shiftLabel: string;
  sections: HandoverSections;
  source: string;
  ts: number;
  acks: { username: string; ts: number }[];
}

const emptySections = (): HandoverSections => ({ issues: [], changes: [], pending: [], notes: [] });

function sanitizeSections(raw: unknown): HandoverSections {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x).trim().slice(0, 160))
      .filter(Boolean)
      .slice(0, 6);
  return { issues: arr(o.issues), changes: arr(o.changes), pending: arr(o.pending), notes: arr(o.notes) };
}

/** 초안 재료 창: 마지막 인수인계 이후 ~ 지금 (첫 작성이면 최근 12시간) */
function windowStart(meetingId: number): string {
  const last = db
    .prepare('SELECT MAX(created_at) AS t FROM handovers WHERE meeting_id = ?')
    .get(meetingId) as { t: string | null };
  return (
    last.t ?? new Date(Date.now() - 12 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
  );
}

/** AI 초안 — 이번 조 기록에서 4섹션 자동 추출. 실패·키 없음이면 규칙 폴백 */
export async function draftHandover(
  meetingId: number,
): Promise<{ sections: HandoverSections; source: 'ai' | 'rule' }> {
  const since = windowStart(meetingId);
  const chat = db
    .prepare(
      `SELECT u.username AS "from", m.text FROM messages m
       JOIN users u ON u.id = m.user_id
       WHERE m.meeting_id = ? AND m.user_id != ? AND m.created_at > ? AND m.text != ''
       ORDER BY m.id ASC LIMIT 120`,
    )
    .all(meetingId, ensureAgentUser(), since) as { from: string; text: string }[];
  const decisions = db
    .prepare(
      `SELECT decisions, whys FROM meeting_recaps WHERE meeting_id = ? AND created_at > ? ORDER BY id DESC LIMIT 10`,
    )
    .all(meetingId, since) as { decisions: string; whys: string | null }[];
  const undone = db
    .prepare(
      `SELECT t.title, u.username AS author FROM todos t JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.done = 0 ORDER BY t.id DESC LIMIT 15`,
    )
    .all(meetingId) as { title: string; author: string }[];

  const decisionTexts = decisions.flatMap((r) => {
    try {
      return JSON.parse(r.decisions) as string[];
    } catch {
      return [];
    }
  });

  // 규칙 폴백 — 확실한 재료만 기계적으로: 변경=이번 창의 결정, 미완료=열린 할 일
  const rule = (): { sections: HandoverSections; source: 'rule' } => ({
    sections: sanitizeSections({
      issues: [],
      changes: decisionTexts.slice(0, 5),
      pending: undone.map((t) => `${t.title} (${t.author})`),
      notes: [],
    }),
    source: 'rule',
  });

  if (!openai || (chat.length === 0 && decisionTexts.length === 0 && undone.length === 0))
    return rule();

  try {
    const system =
      '너는 교대 근무 팀의 인수인계 노트를 만드는 exist의 AI 총무다. 이번 조의 기록에서 다음 조가 알아야 할 것만 추린다.\n' +
      '응답은 오직 JSON: {"issues": string[], "changes": string[], "pending": string[], "notes": string[]}\n' +
      '- issues: 설비·작업 이상이나 트러블 (로그에 언급된 것만)\n' +
      '- changes: 이번 조에서 정해진 변경 사항·결정 (배경이 로그에 있으면 괄호로 한 줄 덧붙임)\n' +
      '- pending: 끝나지 않아 다음 조가 이어받아야 하는 조치 (담당이 있으면 괄호 표기)\n' +
      '- notes: 그 외 다음 조 유의사항\n' +
      '각 항목 한국어 한 줄(80자 이내), 섹션당 최대 5개. 로그에 없는 사실·수치는 만들지 않는다 — 해당 없으면 빈 배열.';
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            chat: chat.map((c) => `${c.from}: ${c.text}`),
            decisions: decisionTexts,
            undone_todos: undone.map((t) => `${t.title} (${t.author})`),
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const sections = sanitizeSections(
      JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)),
    );
    return { sections, source: 'ai' };
  } catch (err) {
    console.error('[handover] AI 초안 실패, 규칙 폴백:', err);
    return rule();
  }
}

/** 발행 — 저장 + 작성자 외 참가자에게 알림 (다음 조 서명 유도) */
export function publishHandover(
  meetingId: number,
  meetingCode: string,
  authorId: number,
  shiftLabel: string,
  sections: unknown,
  source: string,
): number {
  const clean = sanitizeSections(sections);
  const total = clean.issues.length + clean.changes.length + clean.pending.length + clean.notes.length;
  if (total === 0) throw new Error('빈 인수인계는 발행할 수 없어요');
  const info = db
    .prepare(
      `INSERT INTO handovers (meeting_id, author_id, shift_label, sections, source)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      meetingId,
      authorId,
      shiftLabel.slice(0, 40),
      JSON.stringify(clean),
      source === 'ai' ? 'ai' : source === 'rule' ? 'rule' : 'manual',
    );
  const id = info.lastInsertRowid as number;
  const author = db.prepare('SELECT username FROM users WHERE id = ?').get(authorId) as
    | { username: string }
    | undefined;
  const others = db
    .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?')
    .all(meetingId, authorId) as { user_id: number }[];
  for (const p of others) {
    notifyUser(p.user_id, {
      from: 'exist AI',
      text: `${shiftLabel ? `[${shiftLabel}] ` : ''}인수인계가 도착했어요 (${author?.username ?? ''} 작성, ${total}건) — 작업 전에 확인해 주세요`,
      kind: 'recap',
      meetingCode,
    });
    invalidateBrief(p.user_id);
  }
  return id;
}

export function listHandovers(meetingId: number, limit = 20): HandoverRow[] {
  const rows = db
    .prepare(
      `SELECT h.id, h.shift_label, h.sections, h.source, h.created_at, u.username AS author
       FROM handovers h JOIN users u ON u.id = h.author_id
       WHERE h.meeting_id = ? ORDER BY h.id DESC LIMIT ?`,
    )
    .all(meetingId, limit) as {
    id: number;
    shift_label: string;
    sections: string;
    source: string;
    created_at: string;
    author: string;
  }[];
  const ackStmt = db.prepare(
    `SELECT u.username, a.created_at FROM handover_acks a JOIN users u ON u.id = a.user_id
     WHERE a.handover_id = ? ORDER BY a.rowid`,
  );
  return rows.map((r) => {
    let sections: HandoverSections;
    try {
      sections = sanitizeSections(JSON.parse(r.sections));
    } catch {
      sections = emptySections();
    }
    return {
      id: r.id,
      author: r.author,
      shiftLabel: r.shift_label,
      sections,
      source: r.source,
      ts: new Date(r.created_at + 'Z').getTime(),
      acks: (ackStmt.all(r.id) as { username: string; created_at: string }[]).map((a) => ({
        username: a.username,
        ts: new Date(a.created_at + 'Z').getTime(),
      })),
    };
  });
}

/** 서명 — "작업 전에 확인했다"의 기록. 멱등 */
export function ackHandover(handoverId: number, meetingId: number, userId: number): boolean {
  const row = db
    .prepare('SELECT 1 FROM handovers WHERE id = ? AND meeting_id = ?')
    .get(handoverId, meetingId);
  if (!row) return false;
  db.prepare('INSERT OR IGNORE INTO handover_acks (handover_id, user_id) VALUES (?, ?)').run(
    handoverId,
    userId,
  );
  return true;
}
