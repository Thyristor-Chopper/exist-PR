import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';

/*
 * 조직 그룹 거버넌스 — OG-01 ~ OG-07
 * 그룹 생성 권한제 (owner/admin 또는 group:create 역할) + 관리자 전체 그룹 조회.
 */

const app = createApp();

let owner = '';
let plain = ''; // 아무 권한 없는 일반 멤버
let mid = ''; // group:create 역할을 받을 중간관리자
let plainId = 0;
let midId = 0;
let orgId = 0;

async function register(username: string) {
  const r = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123' });
  return { token: r.body.token as string, id: r.body.user.id as number };
}

const auth = (t: string) => `Bearer ${t}`;

beforeAll(async () => {
  owner = (await register('og_owner')).token;
  const p = await register('og_plain');
  plain = p.token;
  plainId = p.id;
  const m = await register('og_mid');
  mid = m.token;
  midId = m.id;

  // 조직 생성 + 두 명 가입/승인
  const org = await request(app)
    .post('/api/orgs')
    .set('Authorization', auth(owner))
    .send({ name: '거버넌스 테스트 조직' });
  orgId = org.body.id;
  const joinCode = org.body.joinCode as string;
  for (const [t, id] of [
    [plain, plainId],
    [mid, midId],
  ] as const) {
    await request(app)
      .post('/api/orgs/join')
      .set('Authorization', auth(t))
      .send({ joinCode });
    await request(app)
      .post(`/api/orgs/${orgId}/members/${id}/approve`)
      .set('Authorization', auth(owner))
      .send({});
  }
});

describe('조직 그룹 생성 권한제', () => {
  it('OG-01 아무 권한 없는 멤버는 조직 그룹 생성 불가 (403)', async () => {
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(plain))
      .send({ title: '몰래 만든 그룹', org_id: orgId });
    expect(r.status).toBe(403);
  });

  it('OG-02 개인 그룹(org_id 없음)은 누구나 생성 가능', async () => {
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(plain))
      .send({ title: '개인 그룹' });
    expect(r.status).toBe(200);
  });

  it('OG-03 owner는 조직 그룹 생성 가능', async () => {
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(owner))
      .send({ title: '운영 그룹', org_id: orgId });
    expect(r.status).toBe(200);
    expect(r.body.org_id).toBe(orgId);
  });

  it('OG-04 group:create 역할을 받으면 생성 가능해진다', async () => {
    const role = await request(app)
      .post(`/api/orgs/${orgId}/roles`)
      .set('Authorization', auth(owner))
      .send({ name: '그룹장', perms: ['group:create'] });
    expect(role.status).toBe(200);
    await request(app)
      .patch(`/api/orgs/${orgId}/members/${midId}`)
      .set('Authorization', auth(owner))
      .send({ roleId: role.body.id });
    const r = await request(app)
      .post('/api/meetings')
      .set('Authorization', auth(mid))
      .send({ title: '중간관리자 그룹', org_id: orgId });
    expect(r.status).toBe(200);
  });

  it('OG-05 조직 목록의 canCreateGroup이 권한을 반영한다', async () => {
    const forPlain = await request(app).get('/api/orgs').set('Authorization', auth(plain));
    expect(forPlain.body.find((o: { id: number }) => o.id === orgId).canCreateGroup).toBe(false);
    const forMid = await request(app).get('/api/orgs').set('Authorization', auth(mid));
    expect(forMid.body.find((o: { id: number }) => o.id === orgId).canCreateGroup).toBe(true);
  });
});

describe('관리자 전체 그룹 조회', () => {
  it('OG-06 관리자는 참가 안 한 그룹까지 전부 본다', async () => {
    const r = await request(app)
      .get(`/api/orgs/${orgId}/groups`)
      .set('Authorization', auth(owner));
    expect(r.status).toBe(200);
    const titles = r.body.map((g: { title: string }) => g.title);
    expect(titles).toContain('운영 그룹');
    expect(titles).toContain('중간관리자 그룹'); // owner가 참가하지 않은 그룹
    const midGroup = r.body.find((g: { title: string }) => g.title === '중간관리자 그룹');
    expect(midGroup.joined).toBe(false);
    expect(midGroup.host).toBe('og_mid');
  });

  it('OG-07 일반 멤버는 전체 그룹 조회 불가 (403)', async () => {
    const r = await request(app)
      .get(`/api/orgs/${orgId}/groups`)
      .set('Authorization', auth(plain));
    expect(r.status).toBe(403);
  });
});
