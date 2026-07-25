import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

/*
 * 일정(meeting_events) 종합 시나리오 — EV-01 ~ EV-20
 * 생성 검증 / 필드 정리(관련자·메모·알림·반복·색·기간) / 부분 수정 / 권한 /
 * 알림 라우팅 / nowbar 일정 전개(반복·멀티데이)까지 일정 기능 전부를 커버한다.
 */

const app = createApp();

let host = ''; // 호스트 토큰
let member = ''; // 참가자 토큰
let outsider = ''; // 비참가자 토큰
let memberId = 0;
let code = ''; // 테스트 회의 코드

async function register(username: string) {
  const r = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123' });
  return { token: r.body.token as string, id: r.body.user.id as number };
}

const auth = (t: string) => `Bearer ${t}`;

async function createEvent(token: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/meetings/${code}/events`)
    .set('Authorization', auth(token))
    .send(body);
}

async function listEvents(token = host) {
  const r = await request(app)
    .get(`/api/meetings/${code}/events`)
    .set('Authorization', auth(token));
  return r.body as {
    id: number;
    title: string;
    date: string;
    time: string | null;
    end_time: string | null;
    end_date: string | null;
    is_call: number;
    memo: string | null;
    remind: number | null;
    recur: string | null;
    recur_until: string | null;
    color: string | null;
    people: { id: number; username: string; name: string | null }[];
    author: string;
  }[];
}

/** 오늘 기준 n일 뒤 YYYY-MM-DD (KST 로컬) */
function day(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeAll(async () => {
  const h = await register('ev_host');
  const m = await register('ev_member');
  const o = await register('ev_outsider');
  host = h.token;
  member = m.token;
  outsider = o.token;
  memberId = m.id;
  const meeting = await request(app)
    .post('/api/meetings')
    .set('Authorization', auth(host))
    .send({ title: '일정 테스트 회의' });
  code = meeting.body.code;
  await request(app).post('/api/meetings/join').set('Authorization', auth(member)).send({ code });
});

describe('일정 생성 검증 (EV-01~05)', () => {
  it('EV-01 제목 없으면 400', async () => {
    const r = await createEvent(host, { date: day(1) });
    expect(r.status).toBe(400);
  });

  it('EV-02 날짜 형식 오류 400', async () => {
    const r = await createEvent(host, { title: 'x', date: '2026/07/30' });
    expect(r.status).toBe(400);
  });

  it('EV-03 같은 날 종료<시작 400', async () => {
    const r = await createEvent(host, {
      title: 'x',
      date: day(1),
      time: '10:00',
      end_time: '09:00',
    });
    expect(r.status).toBe(400);
  });

  it('EV-04 여러 날이면 다음 날 이른 시각도 정상 (밤샘 워크숍)', async () => {
    const r = await createEvent(host, {
      title: '밤샘',
      date: day(1),
      time: '22:00',
      end_time: '08:00',
      end_date: day(2),
    });
    expect(r.status).toBe(200);
    const ev = (await listEvents()).find((e) => e.title === '밤샘')!;
    expect(ev.end_date).toBe(day(2));
    expect(ev.end_time).toBe('08:00');
  });

  it('EV-05 종료일이 시작일과 같거나 이전이면 무시(null) → 시간 검사 적용', async () => {
    const bad = await createEvent(host, {
      title: 'x',
      date: day(1),
      time: '10:00',
      end_time: '09:00',
      end_date: day(1), // 같은 날 = 무시
    });
    expect(bad.status).toBe(400);
  });
});

describe('일정 필드 정리 (EV-06~10)', () => {
  it('EV-06 메모 trim + 500자 제한', async () => {
    await createEvent(host, { title: '메모테스트', date: day(3), memo: '  긴 메모  '.padEnd(600, '가') });
    const ev = (await listEvents()).find((e) => e.title === '메모테스트')!;
    expect(ev.memo!.startsWith('긴 메모')).toBe(true);
    expect(ev.memo!.length).toBeLessThanOrEqual(500);
  });

  it('EV-07 관련자 — 참가자 아닌 id는 걸러지고 중복 제거', async () => {
    await createEvent(host, {
      title: '관련자테스트',
      date: day(3),
      people: [memberId, memberId, 99999],
    });
    const ev = (await listEvents()).find((e) => e.title === '관련자테스트')!;
    expect(ev.people.map((p) => p.username)).toEqual(['ev_member']);
  });

  it('EV-08 알림 시점 — 허용값 외는 기본(null), 0=없음 저장', async () => {
    await createEvent(host, { title: '알림A', date: day(3), time: '10:00', remind: 999 });
    await createEvent(host, { title: '알림B', date: day(3), time: '11:00', remind: 0 });
    await createEvent(host, { title: '알림C', date: day(3), time: '12:00', remind: 60 });
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '알림A')!.remind).toBeNull();
    expect(evs.find((e) => e.title === '알림B')!.remind).toBe(0);
    expect(evs.find((e) => e.title === '알림C')!.remind).toBe(60);
  });

  it('EV-09 반복 — 잘못된 주기는 null, weekly+종료일 저장', async () => {
    await createEvent(host, { title: '반복X', date: day(3), recur: 'hourly' });
    await createEvent(host, { title: '반복W', date: day(3), recur: 'weekly', recur_until: day(30) });
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '반복X')!.recur).toBeNull();
    const w = evs.find((e) => e.title === '반복W')!;
    expect(w.recur).toBe('weekly');
    expect(w.recur_until).toBe(day(30));
  });

  it('EV-10 색 — #rrggbb만 허용(소문자 정규화), 이상값은 null', async () => {
    await createEvent(host, { title: '색OK', date: day(3), color: '#8E4EF7' });
    await createEvent(host, { title: '색BAD', date: day(3), color: 'purple' });
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '색OK')!.color).toBe('#8e4ef7');
    expect(evs.find((e) => e.title === '색BAD')!.color).toBeNull();
  });
});

describe('일정 수정·권한 (EV-11~16)', () => {
  let evId = 0;

  beforeAll(async () => {
    const r = await createEvent(host, {
      title: '수정대상',
      date: day(5),
      time: '14:00',
      end_time: '15:00',
      memo: '원본 메모',
      people: [memberId],
      remind: 30,
      recur: 'weekly',
      recur_until: day(40),
      color: '#e5484d',
    });
    evId = r.body.id;
  });

  it('EV-11 제목만 수정해도 나머지 필드 전부 유지', async () => {
    const r = await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ title: '수정대상2' });
    expect(r.status).toBe(200);
    const ev = (await listEvents()).find((e) => e.id === evId)!;
    expect(ev.memo).toBe('원본 메모');
    expect(ev.people).toHaveLength(1);
    expect(ev.remind).toBe(30);
    expect(ev.recur).toBe('weekly');
    expect(ev.color).toBe('#e5484d');
  });

  it('EV-12 명시적으로 비우기 — memo·people·color', async () => {
    await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ memo: '', people: [], color: null });
    const ev = (await listEvents()).find((e) => e.id === evId)!;
    expect(ev.memo).toBeNull();
    expect(ev.people).toHaveLength(0);
    expect(ev.color).toBeNull();
  });

  it('EV-13 반복 해제하면 종료일도 함께 제거', async () => {
    await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ recur: null });
    const ev = (await listEvents()).find((e) => e.id === evId)!;
    expect(ev.recur).toBeNull();
    expect(ev.recur_until).toBeNull();
  });

  it('EV-14 참가자여도 남의 일정은 수정 불가 (작성자·호스트만)', async () => {
    const r = await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(member))
      .send({ title: '멋대로' });
    expect(r.status).toBe(403);
  });

  it('EV-15 참가자가 만든 일정은 호스트가 수정 가능', async () => {
    const mine = await createEvent(member, { title: '멤버일정', date: day(6) });
    const r = await request(app)
      .patch(`/api/meetings/${code}/events/${mine.body.id}`)
      .set('Authorization', auth(host))
      .send({ title: '호스트가 고침' });
    expect(r.status).toBe(200);
  });

  it('EV-16 수정으로 새로 지정된 관련자에게 알림', async () => {
    await request(app)
      .patch(`/api/meetings/${code}/events/${evId}`)
      .set('Authorization', auth(host))
      .send({ people: [memberId] });
    const notif = await request(app)
      .get('/api/notifications')
      .set('Authorization', auth(member));
    const texts = (notif.body.items ?? notif.body).map((n: { text: string }) => n.text);
    expect(texts.some((t: string) => t.includes('관련자로 지정됐어요'))).toBe(true);
  });
});

describe('일정 삭제 (EV-17)', () => {
  it('작성자·호스트 외 삭제 불가, 호스트는 남의 것도 삭제', async () => {
    const mine = await createEvent(member, { title: '삭제대상', date: day(7) });
    const deny = await request(app)
      .delete(`/api/meetings/${code}/events/${mine.body.id}`)
      .set('Authorization', auth(outsider));
    expect(deny.status).toBe(403);
    const ok = await request(app)
      .delete(`/api/meetings/${code}/events/${mine.body.id}`)
      .set('Authorization', auth(host));
    expect(ok.status).toBe(200);
    const evs = await listEvents();
    expect(evs.find((e) => e.title === '삭제대상')).toBeUndefined();
  });
});

describe('nowbar 일정 전개 (EV-18~20)', () => {
  it('EV-18 매주 반복은 종료일까지 occurrence로 전개', async () => {
    await createEvent(host, {
      title: '전개-매주',
      date: day(1),
      time: '09:00',
      recur: 'weekly',
      recur_until: day(22),
    });
    const r = await request(app)
      .get('/api/meetings/schedule?org=personal')
      .set('Authorization', auth(host));
    const occ = (r.body as { title: string; starts_at: string }[]).filter(
      (x) => x.title === '전개-매주',
    );
    expect(occ.length).toBe(4); // day+1, +8, +15, +22
    expect(occ[0].starts_at).toBe(`${day(1)}T09:00`);
  });

  it('EV-19 멀티데이 일정의 ends_at은 종료일+종료시각', async () => {
    await createEvent(host, {
      title: '전개-기간',
      date: day(2),
      time: '13:00',
      end_time: '10:00',
      end_date: day(4),
    });
    const r = await request(app)
      .get('/api/meetings/schedule?org=personal')
      .set('Authorization', auth(host));
    const occ = (r.body as { title: string; ends_at: string | null }[]).find(
      (x) => x.title === '전개-기간',
    )!;
    expect(occ.ends_at).toBe(`${day(4)}T10:00`);
  });

  it('EV-20 통합 — 매주 반복 + 2박3일 조합도 회차마다 같은 기간', async () => {
    await createEvent(host, {
      title: '전개-복합',
      date: day(3),
      time: '10:00',
      end_time: '17:00',
      end_date: day(5),
      recur: 'weekly',
      recur_until: day(17),
    });
    const r = await request(app)
      .get('/api/meetings/schedule?org=personal')
      .set('Authorization', auth(host));
    const occ = (r.body as { title: string; starts_at: string; ends_at: string | null }[]).filter(
      (x) => x.title === '전개-복합',
    );
    expect(occ.length).toBe(3); // day+3, +10, +17
    // 각 회차의 종료는 시작 +2일
    for (const o of occ) {
      const s = new Date(o.starts_at);
      const e = new Date(o.ends_at!);
      expect(Math.round((e.getTime() - s.getTime()) / 86_400_000)).toBe(2);
    }
  });

  it('EV-21 종일 일정(time 없음)도 /schedule에 allDay로 나온다', async () => {
    await createEvent(host, { title: '전개-종일', date: day(2) });
    const r = await request(app)
      .get('/api/meetings/schedule?org=personal')
      .set('Authorization', auth(host));
    const occ = (
      r.body as { title: string; starts_at: string; ends_at: string | null; allDay?: boolean }[]
    ).find((x) => x.title === '전개-종일')!;
    expect(occ).toBeDefined();
    expect(occ.allDay).toBe(true);
    expect(occ.starts_at).toBe(`${day(2)}T00:00`);
    // 종일은 ends_at을 비워 nowbar "진행 중" 판정에 안 걸림
    expect(occ.ends_at).toBeNull();
  });
});
