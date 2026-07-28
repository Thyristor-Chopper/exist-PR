import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { runRecapForMeeting } from '../recap.js';
import { handleAgentQuery, ensureAgentUser, AGENT_MENTION, AGENT_NAME } from '../steward.js';
import { ensureDefaultChannel } from '../channels.js';
import db from '../db.js';

/*
 * AI 총무 — 결정 원장 API + @AI 질의응답 (규칙 폴백 경로).
 */
const app = createApp();

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string };
}

function userId(username: string): number {
  return (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number }).id;
}

async function setupWithRecap(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const m = await request(app)
    .post('/api/meetings')
    .set('Authorization', `Bearer ${host.token}`)
    .send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  const meetingId = (db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number })
    .id;
  const uid = userId(`${prefix}_host`);
  db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
    meetingId,
    uid,
    '데모 시나리오는 오송 라인 점검으로 확정합니다',
  );
  db.prepare('INSERT INTO messages (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
    meetingId,
    uid,
    '콘티 정리 부탁해요',
  );
  await runRecapForMeeting(code, [uid]);
  return { host, code, meetingId, uid };
}

describe('결정 원장', () => {
  it('recap의 결정들이 시간순 원장으로 나온다 (참가자만)', async () => {
    const { host, code } = await setupWithRecap('lg1');
    const r = await request(app)
      .get(`/api/meetings/${code}/decisions`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body[0].decision).toContain('확정');
    expect(r.body[0].attendees).toEqual([`lg1_host`]);

    const stranger = await registerUser('lg1_stranger');
    const no = await request(app)
      .get(`/api/meetings/${code}/decisions`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(no.status).toBe(403);
  });
});

describe('AI 총무 @AI 질의응답', () => {
  it('멘션 패턴 — @AI/@ai/@총무 감지, 일반 텍스트는 무시', () => {
    expect(AGENT_MENTION.test('@AI 지난 결정 알려줘')).toBe(true);
    expect(AGENT_MENTION.test('@AI, 다음 일정 알려줘')).toBe(true); // 문장부호가 바로 붙어도
    expect(AGENT_MENTION.test('@ai?')).toBe(true);
    expect(AGENT_MENTION.test('@총무 요약해줘')).toBe(true);
    expect(AGENT_MENTION.test('ai 관련 얘기인데요')).toBe(false);
    expect(AGENT_MENTION.test('email@ai.com 으로 보내')).toBe(false);
  });

  it('결정 질문 → 원장 기반 답변이 채널에 게시되고 브로드캐스트된다 (규칙 폴백)', async () => {
    const { code, meetingId, uid } = await setupWithRecap('sw1');
    const channelId = ensureDefaultChannel(meetingId, uid);

    const emitted: { room: string; ev: string; payload: { from: string; text: string; channelId: number } }[] = [];
    const io = {
      to: (room: string) => ({
        emit: (ev: string, payload: unknown) =>
          emitted.push({ room, ev, payload: payload as (typeof emitted)[0]['payload'] }),
      }),
    };

    await handleAgentQuery(io, {
      meetingId,
      code,
      channelId,
      asker: 'sw1_host',
      text: '@AI 우리 뭐 결정했었지?',
    });

    // 브로드캐스트 — 준비 중 신호(chat:ai-thinking) 먼저, 답변(chat:message) 다음
    expect(emitted).toHaveLength(2);
    expect(emitted[0].ev).toBe('chat:ai-thinking');
    expect(emitted[1].ev).toBe('chat:message');
    expect(emitted[1].room).toBe(`chat:${code}`);
    expect(emitted[1].payload.from).toBe(AGENT_NAME);
    expect(emitted[1].payload.text).toContain('확정');
    expect(emitted[1].payload.channelId).toBe(channelId);

    // DB 영속 (exist AI 명의)
    const agentId = ensureAgentUser();
    const saved = db
      .prepare('SELECT text FROM messages WHERE meeting_id = ? AND user_id = ?')
      .all(meetingId, agentId) as { text: string }[];
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toContain('결정');
  });

  it('기록이 없으면 지어내지 않고 없다고 답한다', async () => {
    const host = await registerUser('sw2_host');
    const m = await request(app)
      .post('/api/meetings')
      .set('Authorization', `Bearer ${host.token}`)
      .send({ title: '빈 그룹' });
    const meetingId = (
      db.prepare('SELECT id FROM meetings WHERE code = ?').get(m.body.code) as { id: number }
    ).id;
    const channelId = ensureDefaultChannel(meetingId, userId('sw2_host'));

    const emitted: { ev: string; text: string }[] = [];
    const io = {
      to: () => ({
        emit: (ev: string, p: unknown) => emitted.push({ ev, ...(p as { text: string }) }),
      }),
    };
    await handleAgentQuery(io, {
      meetingId,
      code: m.body.code,
      channelId,
      asker: 'sw2_host',
      text: '@AI 매출 얼마였지?',
    });
    const answer = emitted.find((e) => e.ev === 'chat:message');
    expect(answer?.text).toContain('근거가 없어요');
  });

  it('시스템 유저는 한 번만 생성된다', () => {
    const a = ensureAgentUser();
    const b = ensureAgentUser();
    expect(a).toBe(b);
  });
});
