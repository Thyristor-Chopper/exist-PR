/* 통화 원음 녹음 → 회의 후 OpenAI 전사 — 기록·결정 추출 품질용 (자막과 무관).
 *
 * 실시간 자막은 각자 브라우저의 Web Speech가 그대로 담당하고(즉시성),
 * 이 모듈은 클라(MeetingView)가 sttOn && micOn 동안 올리는 30초 webm/opus
 * 원음 청크를 보관했다가, 통화가 끝나 recap이 돌기 직전에 한꺼번에 전사해
 * call_transcripts(source='whisper')로 넣는다. recap은 whisper 행을 우선 사용.
 * OPENAI_API_KEY 없으면 조용히 스킵 — Web Speech 기록만으로 동작(기존과 동일). */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import db from './db.js';
import type { AuthedRequest } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STT_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'stt-chunks');
const MAX_CHUNK = 5 * 1024 * 1024; // 30초 opus면 수백 KB — 5MB면 넉넉
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const STT_MODEL = process.env.OPENAI_STT_MODEL || 'gpt-4o-mini-transcribe';

/** 참가자 검증 (files.ts와 동일 패턴 — 순환 import 방지 위해 자체 보유) */
function checkParticipant(
  code: unknown,
  userId: number,
): { ok: false; status: 403 | 404; error: string } | { ok: true; meetingId: number } {
  const meeting = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(code ?? '').toUpperCase()) as { id: number } | undefined;
  if (!meeting) return { ok: false, status: 404, error: '존재하지 않는 회의입니다' };
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, userId);
  if (!isParticipant) return { ok: false, status: 403, error: '회의 참가자만 쓸 수 있어요' };
  return { ok: true, meetingId: meeting.id };
}

const router = Router({ mergeParams: true });

/** 원음 청크 업로드 — raw audio/webm, ?ts=청크 시작(ms epoch) */
router.post('/audio', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const startTs = Number(req.query.ts);
  if (!Number.isFinite(startTs) || startTs <= 0) {
    return res.status(400).json({ error: 'ts(청크 시작 시각)가 필요해요' });
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_CHUNK && !aborted) {
      aborted = true;
      res.status(413).json({ error: '오디오 청크가 너무 커요' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(c);
  });
  req.on('end', () => {
    if (aborted || res.headersSent) return;
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000) return res.json({ ok: true, skipped: true }); // 빈 조각
      const dir = path.join(STT_DIR, String(r.meetingId));
      fs.mkdirSync(dir, { recursive: true });
      // 파일명에 화자·시작시각을 박아 전사 시 타임라인 복원에 쓴다
      fs.writeFileSync(path.join(dir, `${req.userId}-${startTs}.webm`), buf);
      res.json({ ok: true });
    } catch (e) {
      // 이벤트 콜백 안의 예외는 Express가 못 잡는다 — 직접 응답
      console.error('[stt] chunk save', e);
      if (!res.headersSent) res.status(500).json({ error: '저장에 실패했어요' });
    }
  });
  req.on('error', () => {
    if (!aborted && !res.headersSent) res.status(500).json({ error: '업로드에 실패했어요' });
  });
});

export default router;

/** epoch ms → call_transcripts.created_at 형식(UTC 'YYYY-MM-DD HH:MM:SS') */
function toDbTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/** 회의의 대기 청크 전부 전사 → call_transcripts(source='whisper') 삽입.
 *  recap 직전에 호출된다. 실패한 청크는 남겨두지 않고 버린다(다음 회의에 섞이지 않게). */
export async function transcribeMeetingAudio(meetingId: number): Promise<number> {
  if (!openai) return 0;
  const dir = path.join(STT_DIR, String(meetingId));
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.webm'));
  } catch {
    return 0; // 청크 없음
  }
  // 시작 시각순 — 타임라인 순서 보존
  names.sort((a, b) => {
    const ta = Number(a.split('-')[1]?.replace('.webm', ''));
    const tb = Number(b.split('-')[1]?.replace('.webm', ''));
    return ta - tb;
  });

  const ins = db.prepare(
    "INSERT INTO call_transcripts (meeting_id, user_id, text, source, created_at) VALUES (?, ?, ?, 'whisper', ?)",
  );
  let saved = 0;
  for (const name of names) {
    const p = path.join(dir, name);
    const [userIdStr, tsStr] = name.replace('.webm', '').split('-');
    const userId = Number(userIdStr);
    const startTs = Number(tsStr);
    try {
      const out = await openai.audio.transcriptions.create({
        file: fs.createReadStream(p),
        model: STT_MODEL,
        language: 'ko',
      });
      const text = String(out.text ?? '').trim().slice(0, 2000);
      // 무음 청크에서 Whisper가 지어내는 상투구 방어 (유튜브 학습데이터 잔재)
      const junk = /시청해\s*주셔서\s*감사|구독과?\s*좋아요|다음\s*영상에서\s*만나요/;
      if (text && !junk.test(text) && Number.isInteger(userId) && Number.isFinite(startTs)) {
        ins.run(meetingId, userId, text, toDbTime(startTs));
        saved++;
      }
    } catch (e) {
      console.error('[stt] transcribe 실패:', name, (e as Error).message);
    } finally {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 이미 없음 */
      }
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* 비어있지 않으면 유지 */
  }
  if (saved > 0) console.log(`[stt] 회의 ${meetingId}: whisper 전사 ${saved}청크 저장`);
  return saved;
}
