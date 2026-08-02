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
  /** 반복 점검 체크리스트 스냅샷 — 발행 시점의 항목·체크 상태 */
  checks: { label: string; done: boolean }[];
  source: string;
  ts: number;
  acks: {
    username: string;
    ts: number;
    /** 복명복창 — 수신자가 자기 말로 남긴 이해 한 줄 (선택) */
    note: string | null;
    /** AI 대조 결과 — ok | mismatch | null(노트 없음/대조 전) */
    echoCheck: 'ok' | 'mismatch' | null;
    /** mismatch일 때 어긋난 지점 한 줄 */
    echoReason: string | null;
    /** 손 서명 PNG dataURL — 없으면 null (구 데이터·버튼 서명) */
    signature: string | null;
  }[];
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

/** AI 부족분 점검 — 초안과 이번 조 기록을 대조해 빠진 것을 제안 (강제 아님, 사람이 [추가]로 채움).
 *  현직자 페인: "작성자 주관에 따라 기록의 상세함이 달라진다" → 표준을 강제하는 대신 AI가 검토 */
export async function reviewHandover(
  meetingId: number,
  sections: unknown,
): Promise<{ suggestions: { section: keyof HandoverSections; text: string }[]; source: 'ai' | 'rule' }> {
  const draft = sanitizeSections(sections);
  const draftAll = [...draft.issues, ...draft.changes, ...draft.pending, ...draft.notes]
    .join(' ')
    .toLowerCase();
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
      `SELECT decisions FROM meeting_recaps WHERE meeting_id = ? AND created_at > ? ORDER BY id DESC LIMIT 10`,
    )
    .all(meetingId, since) as { decisions: string }[];
  const decisionTexts = decisions.flatMap((r) => {
    try {
      return JSON.parse(r.decisions) as string[];
    } catch {
      return [];
    }
  });
  const undone = db
    .prepare(
      `SELECT t.title, u.username AS author FROM todos t JOIN users u ON u.id = t.user_id
       WHERE t.meeting_id = ? AND t.done = 0 ORDER BY t.id DESC LIMIT 15`,
    )
    .all(meetingId) as { title: string; author: string }[];

  // 규칙 폴백 — 문자열 대조로 확실한 누락만: 초안에 안 보이는 미완료 할일·결정
  const rule = (): { suggestions: { section: keyof HandoverSections; text: string }[]; source: 'rule' } => {
    const suggestions: { section: keyof HandoverSections; text: string }[] = [];
    for (const t of undone) {
      if (!draftAll.includes(t.title.slice(0, 12).toLowerCase()))
        suggestions.push({ section: 'pending', text: `${t.title} (${t.author})` });
    }
    for (const d of decisionTexts) {
      if (!draftAll.includes(d.slice(0, 12).toLowerCase()))
        suggestions.push({ section: 'changes', text: d.slice(0, 120) });
    }
    return { suggestions: suggestions.slice(0, 5), source: 'rule' };
  };

  if (!openai) return rule();
  try {
    const system =
      '너는 교대 인수인계 노트를 검토하는 exist의 AI 총무다. 아래 초안과 이번 조의 기록을 대조해, 다음 조가 알아야 하는데 초안에 빠졌거나 너무 뭉뚱그려진 것을 찾는다.\n' +
      '응답은 오직 JSON: {"suggestions": [{"section": "issues"|"changes"|"pending"|"notes", "text": string}]}\n' +
      '- text는 초안에 그대로 추가할 수 있는 완성된 한 줄(한국어 80자 이내) — 기록에 근거한 것만, 추측 금지\n' +
      '- 이미 초안에 있는 내용은 제안하지 않는다. 최대 5개, 빠진 게 없으면 빈 배열.\n' +
      '- 특히 놓치기 쉬운 것: 설비·품질 이상 언급, 미완료 조치, 긴급 부품·자재 얘기, 다음 조에 걸리는 시간 약속';
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.2,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: JSON.stringify({
            draft,
            chat: chat.map((c) => `${c.from}: ${c.text}`),
            decisions: decisionTexts,
            undone_todos: undone.map((t) => `${t.title} (${t.author})`),
          }),
        },
      ],
    });
    const raw = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      suggestions?: unknown;
    };
    const valid: (keyof HandoverSections)[] = ['issues', 'changes', 'pending', 'notes'];
    const suggestions = (Array.isArray(parsed.suggestions) ? parsed.suggestions : [])
      .map((s) => {
        const o = s as { section?: unknown; text?: unknown };
        const section = valid.includes(o.section as keyof HandoverSections)
          ? (o.section as keyof HandoverSections)
          : 'notes';
        return { section, text: String(o.text ?? '').trim().slice(0, 160) };
      })
      .filter((s) => s.text)
      .slice(0, 5);
    return { suggestions, source: 'ai' };
  } catch (err) {
    console.error('[handover] AI 점검 실패, 규칙 폴백:', err);
    return rule();
  }
}

/** 반복 점검 체크리스트 — 그룹별 항목 관리 */
export function listChecklist(meetingId: number): { id: number; label: string }[] {
  return db
    .prepare('SELECT id, label FROM handover_checklist WHERE meeting_id = ? ORDER BY id')
    .all(meetingId) as { id: number; label: string }[];
}
export function addChecklistItem(meetingId: number, userId: number, label: string): number | null {
  const clean = label.trim().slice(0, 80);
  if (!clean) return null;
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM handover_checklist WHERE meeting_id = ?').get(meetingId) as { n: number }
  ).n;
  if (count >= 20) return null;
  return db
    .prepare('INSERT INTO handover_checklist (meeting_id, label, created_by) VALUES (?, ?, ?)')
    .run(meetingId, clean, userId).lastInsertRowid as number;
}
export function removeChecklistItem(meetingId: number, itemId: number): boolean {
  return (
    db.prepare('DELETE FROM handover_checklist WHERE id = ? AND meeting_id = ?').run(itemId, meetingId)
      .changes > 0
  );
}

function sanitizeChecks(raw: unknown): { label: string; done: boolean }[] {
  return (Array.isArray(raw) ? raw : [])
    .map((c) => {
      const o = c as { label?: unknown; done?: unknown };
      return { label: String(o.label ?? '').trim().slice(0, 80), done: o.done === true };
    })
    .filter((c) => c.label)
    .slice(0, 20);
}

/** 발행 — 저장 + 작성자 외 참가자에게 알림 (다음 조 서명 유도) */
export function publishHandover(
  meetingId: number,
  meetingCode: string,
  authorId: number,
  shiftLabel: string,
  sections: unknown,
  source: string,
  checks?: unknown,
): number {
  const clean = sanitizeSections(sections);
  const cleanChecks = sanitizeChecks(checks);
  const total =
    clean.issues.length + clean.changes.length + clean.pending.length + clean.notes.length + cleanChecks.length;
  if (total === 0) throw new Error('빈 인수인계는 발행할 수 없어요');
  const info = db
    .prepare(
      `INSERT INTO handovers (meeting_id, author_id, shift_label, sections, source, checks)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meetingId,
      authorId,
      shiftLabel.slice(0, 40),
      JSON.stringify(clean),
      source === 'ai' ? 'ai' : source === 'rule' ? 'rule' : 'manual',
      JSON.stringify(cleanChecks),
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

/** 미확인 에스컬레이션 스위퍼 — 발행 2시간 뒤에도 미서명자가 있으면 작성자에게 1회 알림.
 *  "침묵의 비용을 발신자가 실시간으로 보게" — 리마인드(수신자 조르기)의 반대 방향 */
export function sweepHandoverEscalations() {
  const rows = db
    .prepare(
      `SELECT h.id, h.meeting_id, h.author_id, h.shift_label, m.code FROM handovers h
       JOIN meetings m ON m.id = h.meeting_id
       WHERE h.escalated_at IS NULL
         AND h.created_at < datetime('now', '-2 hours')
         AND h.created_at > datetime('now', '-3 days')`,
    )
    .all() as { id: number; meeting_id: number; author_id: number; shift_label: string; code: string }[];
  for (const h of rows) {
    const parts = db
      .prepare(
        `SELECT u.id, u.username FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
         WHERE mp.meeting_id = ? AND mp.user_id != ?`,
      )
      .all(h.meeting_id, h.author_id) as { id: number; username: string }[];
    const acked = new Set(
      (db.prepare('SELECT user_id FROM handover_acks WHERE handover_id = ?').all(h.id) as { user_id: number }[]).map(
        (a) => a.user_id,
      ),
    );
    const missing = parts.filter((p) => !acked.has(p.id));
    db.prepare(`UPDATE handovers SET escalated_at = datetime('now') WHERE id = ?`).run(h.id);
    if (missing.length === 0) continue;
    notifyUser(h.author_id, {
      from: 'exist AI',
      text: `⚠️ ${h.shift_label ? `[${h.shift_label}] ` : ''}인수인계 발행 2시간 — 아직 ${missing.length}명이 확인하지 않았어요 (${missing.map((p) => p.username).join(', ')})`,
      kind: 'recap',
      meetingCode: h.code,
    });
    invalidateBrief(h.author_id);
  }
}

export function listHandovers(meetingId: number, limit = 20): HandoverRow[] {
  const rows = db
    .prepare(
      `SELECT h.id, h.shift_label, h.sections, h.checks, h.source, h.created_at, u.username AS author
       FROM handovers h JOIN users u ON u.id = h.author_id
       WHERE h.meeting_id = ? ORDER BY h.id DESC LIMIT ?`,
    )
    .all(meetingId, limit) as {
    id: number;
    shift_label: string;
    sections: string;
    checks: string | null;
    source: string;
    created_at: string;
    author: string;
  }[];
  const ackStmt = db.prepare(
    `SELECT u.username, a.created_at, a.note, a.echo_check, a.echo_reason, a.signature
     FROM handover_acks a JOIN users u ON u.id = a.user_id
     WHERE a.handover_id = ? ORDER BY a.rowid`,
  );
  return rows.map((r) => {
    let sections: HandoverSections;
    try {
      sections = sanitizeSections(JSON.parse(r.sections));
    } catch {
      sections = emptySections();
    }
    let checks: { label: string; done: boolean }[] = [];
    try {
      checks = r.checks ? sanitizeChecks(JSON.parse(r.checks)) : [];
    } catch {
      checks = [];
    }
    return {
      id: r.id,
      author: r.author,
      shiftLabel: r.shift_label,
      sections,
      checks,
      source: r.source,
      ts: new Date(r.created_at + 'Z').getTime(),
      acks: (
        ackStmt.all(r.id) as {
          username: string;
          created_at: string;
          note: string | null;
          echo_check: string | null;
          echo_reason: string | null;
          signature: string | null;
        }[]
      ).map((a) => ({
        username: a.username,
        ts: new Date(a.created_at + 'Z').getTime(),
        note: a.note ?? null,
        echoCheck: a.echo_check === 'ok' || a.echo_check === 'mismatch' ? a.echo_check : null,
        echoReason: a.echo_reason ?? null,
        signature: a.signature ?? null,
      })),
    };
  });
}

/** 서명 — "작업 전에 확인했다"의 기록. 멱등, 노트만 나중에 추가/갱신 가능.
 *  signature = 손 서명 PNG dataURL (종이 회람판의 디지털화 — 클릭보다 무거운 의사표시) */
export function ackHandover(
  handoverId: number,
  meetingId: number,
  userId: number,
  note?: string,
  signature?: string,
): boolean {
  const row = db
    .prepare('SELECT 1 FROM handovers WHERE id = ? AND meeting_id = ?')
    .get(handoverId, meetingId);
  if (!row) return false;
  db.prepare('INSERT OR IGNORE INTO handover_acks (handover_id, user_id) VALUES (?, ?)').run(
    handoverId,
    userId,
  );
  if (
    typeof signature === 'string' &&
    signature.startsWith('data:image/png;base64,') &&
    signature.length < 40_000
  ) {
    db.prepare('UPDATE handover_acks SET signature = ? WHERE handover_id = ? AND user_id = ?').run(
      signature,
      handoverId,
      userId,
    );
  }
  const clean = (note ?? '').trim().slice(0, 200);
  if (clean) {
    db.prepare(
      'UPDATE handover_acks SET note = ?, echo_check = NULL, echo_reason = NULL WHERE handover_id = ? AND user_id = ?',
    ).run(clean, handoverId, userId);
    // 복명복창 대조는 비동기 — 서명 응답을 막지 않는다
    void echoCheck(handoverId, meetingId, userId, clean).catch((err) =>
      console.error('[handover] 복명복창 대조 실패:', err),
    );
  }
  return true;
}

/** 복명복창 대조 — 수신자의 "이해 한 줄"을 원본과 의미 비교. 어긋나면 작성자·수신자 모두에게 알림.
 *  크로스체크의 본뜻: "봤다"가 아니라 "같은 맥락으로 이해했다"의 검증 */
async function echoCheck(handoverId: number, meetingId: number, userId: number, note: string) {
  if (!openai) return;
  const h = db
    .prepare('SELECT sections, shift_label, author_id FROM handovers WHERE id = ?')
    .get(handoverId) as { sections: string; shift_label: string; author_id: number } | undefined;
  if (!h) return;
  const system =
    '너는 교대 인수인계의 복명복창을 대조하는 exist의 AI 총무다. 수신자의 요약에서 원본과 모순되는 "진술"만 찾는다.\n' +
    '판정 기준은 단 하나: **두 진술이 동시에 참일 수 있으면 모순이 아니다.** 동시에 참일 수 없을 때만 모순이다.\n' +
    '예시 — 모순 O: 원본 "일요일 저녁 8시 브리핑" / 수신자 "브리핑은 월요일 저녁 8시" (요일이 동시에 참일 수 없음)\n' +
    '예시 — 모순 X: 원본 "최기술님이 브리핑 진행" / 수신자 "브리핑에 참석하겠다" (진행자와 참석자는 양립함)\n' +
    '예시 — 모순 X: 원본 "국산 A사로 결정" / 수신자 "A사로 진행으로 이해" (같은 뜻)\n' +
    '수신자가 언급하지 않은 것, 원본의 일부만 말한 것, 자기 할 일을 덧붙인 것은 모순이 아니다.\n' +
    '응답은 오직 JSON: {"contradictions": [{"receiver_said": string(수신자 문장 그대로 인용), "original_says": string(원본의 해당 사실)}]} — 없으면 빈 배열';
  const response = await openai.chat.completions.create({
    // 모순 판정은 mini가 오탐이 잦아 상위 모델 고정 (호출 빈도 낮음 — 복명복창 제출 시 1회)
    model: process.env.OPENAI_MODEL_JUDGE || 'gpt-4o',
    temperature: 0,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ original: JSON.parse(h.sections), receiver_understanding: note }) },
    ],
  });
  const raw = response.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
    contradictions?: unknown;
  };
  // 서버 검증 — 인용이 실제 노트에 있어야 하고(모델이 "누락"을 모순으로 둔갑 못 하게),
  // 사유에 누락·생략 계열 표현이 있으면 폐기 (복명복창은 시험이 아니라 모순 탐지)
  const nospace = (s: string) => s.replace(/\s+/g, '');
  const list = (Array.isArray(parsed.contradictions) ? parsed.contradictions : [])
    .map((c) => {
      const o = c as { receiver_said?: unknown; original_says?: unknown };
      return {
        said: String(o.receiver_said ?? '').trim(),
        orig: String(o.original_says ?? '').trim(),
      };
    })
    .filter(
      (c) =>
        c.said.length >= 4 &&
        nospace(note).includes(nospace(c.said).slice(0, 10)) &&
        !/(누락|언급하지 않|언급 안|생략|빠뜨|빠짐|없음)/.test(c.orig + c.said),
    );
  // 2차 검증 — 후보 쌍마다 "동시에 참일 수 있는가?" 단답 질문 (추출보다 판별이 훨씬 정확)
  const confirmed: typeof list = [];
  for (const c of list.slice(0, 3)) {
    try {
      const v = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL_JUDGE || 'gpt-4o',
        temperature: 0,
        max_tokens: 60,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '두 문장이 논리적으로 동시에 참일 수 있는지 판단한다. 서로 다른 측면을 말하는 것(예: 한쪽은 진행자, 한쪽은 참석 의사)은 동시에 참일 수 있다. 같은 속성(요일·시각·수치·업체·담당)에 다른 값을 말할 때만 동시에 참일 수 없다. 응답은 오직 JSON: {"compatible": true|false}',
          },
          { role: 'user', content: JSON.stringify({ 문장A: c.orig, 문장B: c.said }) },
        ],
      });
      const vr = v.choices[0]?.message?.content ?? '';
      const parsedV = JSON.parse(vr.slice(vr.indexOf('{'), vr.lastIndexOf('}') + 1)) as {
        compatible?: unknown;
      };
      if (parsedV.compatible === false) confirmed.push(c);
    } catch (err) {
      console.error('[handover] 복명복창 2차 검증 실패 — 쌍 폐기:', err);
    }
  }
  const verdict = confirmed.length > 0 ? 'mismatch' : 'ok';
  const reason =
    verdict === 'mismatch'
      ? `"${confirmed[0].said.slice(0, 40)}" ↔ 원본: ${confirmed[0].orig.slice(0, 60)}`
      : '';
  db.prepare(
    'UPDATE handover_acks SET echo_check = ?, echo_reason = ? WHERE handover_id = ? AND user_id = ?',
  ).run(verdict, reason || null, handoverId, userId);
  if (verdict === 'mismatch') {
    const meeting = db.prepare('SELECT code FROM meetings WHERE id = ?').get(meetingId) as
      | { code: string }
      | undefined;
    const receiver = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
      | { username: string }
      | undefined;
    // 작성자와 수신자 양쪽에 — 어긋남은 빨리 맞춰볼수록 싸다
    for (const target of new Set([h.author_id, userId])) {
      notifyUser(target, {
        from: 'exist AI',
        text: `${h.shift_label ? `[${h.shift_label}] ` : ''}인수인계 이해가 어긋난 것 같아요 — ${receiver?.username ?? '수신자'}: "${note.slice(0, 40)}" (${reason})`,
        kind: 'recap',
        meetingCode: meeting?.code ?? '',
      });
      invalidateBrief(target);
    }
  }
}
