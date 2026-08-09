/* 공동편집 AI — ① 개정 요약 자동 생성, ② 회람 미확인 자동 에스컬레이션.
 *
 * LLM 호출은 stt.ts의 correctCaption과 같은 격리 패턴 — OpenAI(OPENAI_API_KEY, gpt-4o-mini),
 * 실패·타임아웃·키 없음은 전부 조용한 null 폴백. 어떤 실패도 본 동작(개정 발행·회람 알림)을
 * 막지 않는다. 이 파일만 바꾸면 로컬 LLM으로 교체 가능. */
import OpenAI from 'openai';
import db from './db.js';
import { readYdocSnapshot } from './ydoc.js';
import { notifyUser } from './notify.js';

const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

/** 열람 서명 수동 리마인드 쿨다운 — 파일당 1시간 (files.ts ack-remind가 사용).
 * 자동 스윕도 이 시각을 봐서 수동 직후에 겹쳐 보채지 않는다 (순환 import 방지 위해 여기 보유) */
export const ackRemindLast = new Map<number, number>();

/** 문서 내용 추출 — 내용 검색·개정 스냅샷 공용. 에디터별 Yjs 공유 타입에서 텍스트만 긁는다 */
export function extractRoomText(room: string): string {
  const doc = readYdocSnapshot(room);
  if (!doc) return '';
  const parts: string[] = [];
  try {
    // 코드 — files 맵 + file:{id} 텍스트
    doc.getMap('files').forEach((v, k) => {
      const meta = v as { name?: string; dir?: boolean } | undefined;
      if (meta?.dir) return;
      parts.push(String(meta?.name ?? ''), doc.getText(`file:${k}`).toString());
    });
    // 문서 — docs 맵 + doc:{id} XmlFragment (태그 제거)
    doc.getMap('docs').forEach((v, k) => {
      const meta = v as { name?: string } | undefined;
      parts.push(
        String(meta?.name ?? ''),
        doc.getXmlFragment(`doc:${k}`).toString().replace(/<[^>]+>/g, ' '),
      );
    });
    // 시트 — sheets 맵 + cellsKey 맵 값들
    doc.getMap('sheets').forEach((v) => {
      const meta = v as { cellsKey?: string } | undefined;
      if (!meta?.cellsKey) return;
      doc.getMap(meta.cellsKey).forEach((cv) => parts.push(String(cv ?? '')));
    });
    // 발표 — slide-els:{id} 요소들의 text
    doc.getMap('slides').forEach((_v, k) => {
      doc.getMap(`slide-els:${k}`).forEach((el) => {
        const t = (el as { text?: unknown } | undefined)?.text;
        if (t) parts.push(String(t));
      });
    });
    // 캔버스 — elements 요소들의 text
    doc.getMap('elements').forEach((el) => {
      const t = (el as { text?: unknown } | undefined)?.text;
      if (t) parts.push(String(t));
    });
  } catch {
    /* 구조가 다른 룸 — 무시 */
  } finally {
    doc.destroy();
  }
  return parts.join('\n');
}

/** 파일 본문 평문 — Yjs 룸이 있는 편집 문서만. 업로드(blob)·폴더는 null (스냅샷에 null로 남김) */
function extractFileText(fileId: number): string | null {
  const f = db.prepare('SELECT type, room FROM collab_files WHERE id = ?').get(fileId) as
    | { type: string; room: string | null }
    | undefined;
  if (!f || !f.room || f.type === 'folder' || f.type === 'file') return null;
  return extractRoomText(f.room);
}

/** 요약 입력 캡 — 본문이 길면 앞뒤만 남기고 가운데를 잘라 각 4000자 */
function capText(t: string): string {
  if (t.length <= 4000) return t;
  return t.slice(0, 2500) + '\n…(중략)…\n' + t.slice(-1400);
}

/** (이전, 새) 본문 비교 → "이번 개정에서 바뀐 것" 최대 3줄 — 실패·변경 없음이면 null */
async function summarizeDiff(prev: string, next: string, fileName: string): Promise<string | null> {
  if (!openai) return null;
  try {
    const res = await openai.chat.completions.create(
      {
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content:
              `너는 문서 개정 비교기다. 이전 본문과 새 본문을 비교해 "이번 개정에서 바뀐 것"만 최대 3줄로 요약한다.\n` +
              `규칙: 한국어. 각 줄 40자 이내, 줄마다 바뀐 사실 하나(추가·삭제·수정된 내용). 본문에 없는 내용을 추측·창작·평가하지 않는다.\n` +
              `바뀐 게 없거나 판단이 어려우면 "변경 없음"만 출력한다. 머리말·번호·설명 없이 요약 줄만 줄바꿈으로 출력한다.`,
          },
          {
            role: 'user',
            content: `[파일] ${fileName}\n\n[이전 본문]\n${capText(prev)}\n\n[새 본문]\n${capText(next)}`,
          },
        ],
      },
      { timeout: 10_000 }, // 10초 넘으면 요약 없이 알림 발송 (본 동작 우선)
    );
    const raw = res.choices[0]?.message?.content?.trim();
    if (!raw || /^변경\s*없음/.test(raw)) return null;
    // 폭주 방어 — 3줄 캡, 줄머리 기호 제거, 줄당 60자 캡 (프롬프트는 40자 요청)
    const lines = raw
      .split('\n')
      .map((l) => l.replace(/^[-•*\d.)\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((l) => l.slice(0, 60));
    return lines.length ? lines.join('\n') : null;
  } catch {
    return null; // 요약 실패는 조용히 — 기존 문구로 알림
  }
}

/** 개정 발행 후처리 — files.ts reviseFile이 호출.
 * ① 스냅샷 저장(동기, 새 rev 번호로) → ② AI 요약(비동기, 10초 캡) → ③ 회람 알림(요약 여부와 무관하게 발송).
 * revise API 응답은 이 함수와 무관하게 즉시 반환된다 */
export function afterRevise(p: {
  meetingId: number;
  meetingCode: string;
  actorId: number;
  actorName: string;
  fileId: number;
  fileName: string;
  rev: number;
  ackRequired: boolean;
}): void {
  // ① 현재 본문 스냅샷 — 발행되는 새 rev 시점. 추출 불가 타입이면 text=null (기준 시각 기록은 유지)
  let text: string | null = null;
  let prevText: string | null = null;
  try {
    text = extractFileText(p.fileId);
  } catch {
    /* 추출 실패 = null 스냅샷 */
  }
  try {
    const prev = db
      .prepare(
        `SELECT text FROM file_rev_snapshots
         WHERE file_id = ? AND rev < ? AND text IS NOT NULL ORDER BY rev DESC LIMIT 1`,
      )
      .get(p.fileId, p.rev) as { text: string } | undefined;
    prevText = prev?.text ?? null;
    db.prepare(
      `INSERT INTO file_rev_snapshots (file_id, rev, text) VALUES (?, ?, ?)
       ON CONFLICT(file_id, rev) DO UPDATE SET text = excluded.text, created_at = datetime('now')`,
    ).run(p.fileId, p.rev, text);
  } catch (e) {
    console.error('[fileai] 개정 스냅샷 실패:', e);
  }

  // ②③ 요약 → 알림 — 비동기. 첫 개정(직전 스냅샷 없음)·추출 불가는 요약 생략, 알림은 기존 문구
  void (async () => {
    let note: string | null = null;
    if (prevText != null && text != null && text !== prevText) {
      note = await summarizeDiff(prevText, text, p.fileName);
      if (note) {
        try {
          db.prepare('UPDATE file_rev_snapshots SET note = ? WHERE file_id = ? AND rev = ?').run(
            note,
            p.fileId,
            p.rev,
          );
        } catch {
          /* note 저장 실패해도 알림은 나간다 */
        }
      }
    }
    if (!p.ackRequired) return; // 회람 문서 아니면 알림 없음 (기존 동작과 동일)
    try {
      const members = db
        .prepare('SELECT user_id FROM meeting_participants WHERE meeting_id = ? AND user_id != ?')
        .all(p.meetingId, p.actorId) as { user_id: number }[];
      const summaryLine = note ? note.split('\n').join(' · ').slice(0, 120) : null;
      const msg = summaryLine
        ? `『${p.fileName}』 개정 v${p.rev} 발행 — 바뀐 점: ${summaryLine} — 다시 열람 서명이 필요해요`
        : `"${p.fileName}" 문서의 개정 v${p.rev}이 발행됐어요 — 다시 열람 서명이 필요해요`;
      for (const m of members) {
        notifyUser(m.user_id, {
          from: p.actorName,
          text: msg,
          kind: 'file-ack',
          meetingCode: p.meetingCode,
        });
      }
    } catch (e) {
      console.error('[fileai] 개정 회람 알림 실패:', e);
    }
  })();
}

/** 자동 에스컬레이션 기준 시간 — env ACK_AUTOREMIND_HOURS, 기본 48. 소수 허용 (0.02 ≈ 1분, 데모용) */
export function ackAutoRemindHours(): number {
  const v = Number(process.env.ACK_AUTOREMIND_HOURS);
  return Number.isFinite(v) && v > 0 ? v : 48;
}

/** 회람 미확인 자동 에스컬레이션 스윕 — index.ts 스케줄러가 주기 호출.
 * 기준 시각(해당 rev의 개정 시각, 없으면 파일 수정 시각)에서 ACK_AUTOREMIND_HOURS가 지났고,
 * 그 rev의 마지막 자동 발송·수동 리마인드에서도 같은 시간이 지난 파일의 미서명자를 exist AI가 보챈다 */
export function sweepFileAckAutoReminders(): void {
  const ms = ackAutoRemindHours() * 3600_000;
  const now = Date.now();
  const files = db
    .prepare(
      `SELECT f.id, f.name, f.created_by, COALESCE(f.rev, 1) AS rev, f.meeting_id,
              COALESCE(f.updated_at, f.created_at) AS base_at, m.code
       FROM collab_files f JOIN meetings m ON m.id = f.meeting_id
       WHERE f.ack_required = 1 AND f.deleted_at IS NULL AND f.type != 'folder'`,
    )
    .all() as {
    id: number;
    name: string;
    created_by: number;
    rev: number;
    meeting_id: number;
    base_at: string;
    code: string;
  }[];
  for (const f of files) {
    try {
      // 기준 시각 — 이 rev의 개정 시각(스냅샷 created_at), 없으면 파일 updated_at (둘 다 UTC)
      const snap = db
        .prepare('SELECT created_at FROM file_rev_snapshots WHERE file_id = ? AND rev = ?')
        .get(f.id, f.rev) as { created_at: string } | undefined;
      const base = new Date((snap?.created_at ?? f.base_at) + 'Z').getTime();
      if (!Number.isFinite(base) || now - base < ms) continue;
      // 자동은 자체 기록 기준 — 이 rev의 마지막 자동 발송에서 같은 간격이 다시 지나야
      const lastAuto = db
        .prepare('SELECT MAX(sent_at) AS t FROM file_ack_autoremind WHERE file_id = ? AND rev = ?')
        .get(f.id, f.rev) as { t: string | null };
      if (lastAuto.t && now - new Date(lastAuto.t + 'Z').getTime() < ms) continue;
      // 수동 리마인드 직후엔 한 간격 쉼 — 같은 사람에게 겹쳐 보채지 않게 (쿨다운 로직과 충돌 없음)
      if (now - (ackRemindLast.get(f.id) ?? 0) < ms) continue;
      // 미서명자 — 요청자(만든 사람)는 대상에서 제외 (수동 리마인드와 같은 문법)
      const pending = db
        .prepare(
          `SELECT u.id, u.username FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
           WHERE mp.meeting_id = ? AND mp.user_id != ?
             AND NOT EXISTS(SELECT 1 FROM file_acks a WHERE a.file_id = ? AND a.user_id = mp.user_id)
           ORDER BY u.username`,
        )
        .all(f.meeting_id, f.created_by, f.id) as { id: number; username: string }[];
      if (pending.length === 0) continue;
      // "N일째 대기" — 하루 미만(데모 소수 시간)은 시간 단위로
      const days = Math.floor((now - base) / 86_400_000);
      const waited =
        days >= 1 ? `${days}일째` : `${Math.max(1, Math.floor((now - base) / 3_600_000))}시간째`;
      for (const t of pending) {
        notifyUser(t.id, {
          from: 'exist AI',
          text: `"${f.name}" 문서 열람 서명이 ${waited} 대기 중이에요 — 확인 부탁해요`,
          kind: 'file-ack',
          meetingCode: f.code,
        });
      }
      // 요청자 보고 — 침묵을 발신자에게 보이게 (인수인계 에스컬레이션과 같은 계열)
      const names = pending.map((x) => x.username);
      const roster =
        names.slice(0, 5).join(', ') + (names.length > 5 ? ` 외 ${names.length - 5}명` : '');
      notifyUser(f.created_by, {
        from: 'exist AI',
        text: `"${f.name}" 미확인 ${pending.length}명에게 자동 리마인드를 보냈어요 — ${roster}`,
        kind: 'file-ack',
        meetingCode: f.code,
      });
      db.prepare('INSERT INTO file_ack_autoremind (file_id, rev) VALUES (?, ?)').run(f.id, f.rev);
    } catch (e) {
      console.error('[fileai] 자동 리마인드 실패:', f.id, e);
    }
  }
}
