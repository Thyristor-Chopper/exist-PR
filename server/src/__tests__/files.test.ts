import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../app.js';
import db from '../db.js';

/*
 * 공동편집 파일시스템 — 트리 CRUD, 레거시 흡수, 권한, 재귀 삭제, Yjs 정리.
 */
const app = createApp();
const YDOCS_DIR = path.join(process.env.DATA_DIR!, 'ydocs');

async function registerUser(username: string, password = 'password123') {
  const r = await request(app).post('/api/auth/register').send({ username, password });
  return r.body as { token: string };
}

async function setup(prefix: string) {
  const host = await registerUser(`${prefix}_host`);
  const member = await registerUser(`${prefix}_member`);
  const m = await request(app)
    .post('/api/meetings')
    .set('Authorization', `Bearer ${host.token}`)
    .send({ title: `${prefix} 그룹` });
  const code = m.body.code as string;
  await request(app)
    .post('/api/meetings/join')
    .set('Authorization', `Bearer ${member.token}`)
    .send({ code });
  return { host, member, code };
}

describe('공동편집 파일시스템', () => {
  it('레거시 문서(.bin 존재)를 첫 조회 때 파일로 흡수한다 (캔버스 mt- 포함)', async () => {
    const { host, code } = await setup('cf1');
    fs.mkdirSync(YDOCS_DIR, { recursive: true });
    fs.writeFileSync(path.join(YDOCS_DIR, `code-${code}.bin`), Buffer.alloc(0));
    fs.writeFileSync(path.join(YDOCS_DIR, `doc-${code}.bin`), Buffer.alloc(0));
    fs.writeFileSync(path.join(YDOCS_DIR, `mt-${code}.bin`), Buffer.alloc(0));

    const r = await request(app)
      .get(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(3);
    const names = r.body.map((f: { name: string }) => f.name).sort();
    expect(names).toEqual(['문서', '캔버스', '코드']);
    expect(r.body.find((f: { type: string }) => f.type === 'code').room).toBe(`code-${code}`);
    expect(r.body.find((f: { type: string }) => f.type === 'canvas').room).toBe(`mt-${code}`);
  });

  it('레거시 없는 새 그룹은 기본 빈 폴더 하나로 시작', async () => {
    const { host, code } = await setup('cf2');
    const r = await request(app)
      .get(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].type).toBe('folder');
    expect(r.body[0].name).toBe('새 폴더');
  });

  it('폴더 + 폴더 안 파일 생성, room은 file-{id}', async () => {
    const { member, code } = await setup('cf3');
    const folder = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '기획', type: 'folder' });
    expect(folder.status).toBe(200);
    expect(folder.body.room).toBeNull();

    const file = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '사업계획서', type: 'doc', parent_id: folder.body.id });
    expect(file.status).toBe(200);
    expect(file.body.room).toBe(`file-${file.body.id}`);
    expect(file.body.parent_id).toBe(folder.body.id);
  });

  it('검증 — 같은 위치 중복 409, 폴더 아닌 부모 400, 잘못된 타입 400', async () => {
    const { host, code } = await setup('cf4');
    const a = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '메모', type: 'doc' });
    const dup = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '메모', type: 'code' });
    expect(dup.status).toBe(409);

    const badParent = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '안됨', type: 'doc', parent_id: a.body.id });
    expect(badParent.status).toBe(400);

    const badType = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '이상한거', type: 'exe' });
    expect(badType.status).toBe(400);
  });

  it('이름 변경 — 만든 사람 OK, 남은 403, 호스트 OK', async () => {
    const { host, member, code } = await setup('cf5');
    const f = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '초안', type: 'doc' });

    const other = await registerUser('cf5_other');
    await request(app)
      .post('/api/meetings/join')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ code });
    const denied = await request(app)
      .patch(`/api/meetings/${code}/files/${f.body.id}`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ name: '탈취' });
    expect(denied.status).toBe(403);

    const byCreator = await request(app)
      .patch(`/api/meetings/${code}/files/${f.body.id}`)
      .set('Authorization', `Bearer ${member.token}`)
      .send({ name: '2차 초안' });
    expect(byCreator.status).toBe(200);

    const byHost = await request(app)
      .patch(`/api/meetings/${code}/files/${f.body.id}`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '최종' });
    expect(byHost.status).toBe(200);
  });

  it('폴더 재귀 삭제 + Yjs .bin 정리', async () => {
    const { host, code } = await setup('cf6');
    const folder = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '자료', type: 'folder' });
    const sub = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '하위', type: 'folder', parent_id: folder.body.id });
    const file = await request(app)
      .post(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`)
      .send({ name: '깊은 시트', type: 'sheet', parent_id: sub.body.id });

    // 편집된 상태를 흉내내 .bin 생성
    fs.mkdirSync(YDOCS_DIR, { recursive: true });
    const bin = path.join(YDOCS_DIR, `file-${file.body.id}.bin`);
    fs.writeFileSync(bin, Buffer.alloc(4));

    // 삭제 = 휴지통(소프트) — 하위까지 묶이고 .bin은 보존
    const del = await request(app)
      .delete(`/api/meetings/${code}/files/${folder.body.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(del.status).toBe(200);
    expect(del.body.trashed).toBe(3);
    expect(fs.existsSync(bin)).toBe(true);

    const list = await request(app)
      .get(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`);
    // 목록에선 사라지고 기본 "새 폴더"만 남는다
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('새 폴더');

    // 휴지통 목록 — 루트 1건 (하위 2개 포함)
    const trash = await request(app)
      .get(`/api/meetings/${code}/files/trash/list`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(trash.body).toHaveLength(1);
    expect(trash.body[0].children).toBe(2);

    // 복원 — 전부 되살아남
    const restore = await request(app)
      .post(`/api/meetings/${code}/files/trash/${folder.body.id}/restore`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(restore.status).toBe(200);
    const list2 = await request(app)
      .get(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(list2.body).toHaveLength(4); // 새 폴더 + 자료/하위/깊은 시트

    // 다시 삭제 → 영구 삭제하면 .bin까지 정리
    await request(app)
      .delete(`/api/meetings/${code}/files/${folder.body.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    const purge = await request(app)
      .delete(`/api/meetings/${code}/files/trash/${folder.body.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(purge.status).toBe(200);
    expect(purge.body.purged).toBe(3);
    expect(fs.existsSync(bin)).toBe(false);
  });

  it('내 파일 업로드 → 목록·다운로드 → 영구 삭제 시 blob 정리', async () => {
    const { host, code } = await setup('cf9');
    const body = Buffer.from('PDF-내용-흉내 1234567890');
    const up = await request(app)
      .post(`/api/meetings/${code}/files/upload?name=${encodeURIComponent('제안서.pdf')}`)
      .set('Authorization', `Bearer ${host.token}`)
      .set('Content-Type', 'application/pdf')
      .send(body);
    expect(up.status).toBe(200);
    expect(up.body.type).toBe('file');
    expect(up.body.size).toBe(body.length);

    const list = await request(app)
      .get(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${host.token}`);
    const f = (list.body as { id: number; name: string; type: string; mime: string }[]).find(
      (x) => x.name === '제안서.pdf',
    )!;
    expect(f.type).toBe('file');
    expect(f.mime).toBe('application/pdf');

    const dl = await request(app)
      .get(`/api/meetings/${code}/files/${f.id}/download`)
      .set('Authorization', `Bearer ${host.token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(dl.body as Buffer, body)).toBe(0);

    // 같은 이름 재업로드 → " (2)" 자동
    const up2 = await request(app)
      .post(`/api/meetings/${code}/files/upload?name=${encodeURIComponent('제안서.pdf')}`)
      .set('Authorization', `Bearer ${host.token}`)
      .set('Content-Type', 'application/pdf')
      .send(body);
    expect(up2.body.name).toBe('제안서 (2).pdf');

    // 휴지통 → 영구 삭제하면 blob 파일도 삭제
    const blobDir = path.join(process.env.DATA_DIR!, 'uploads-files');
    const before = fs.readdirSync(blobDir).length;
    await request(app)
      .delete(`/api/meetings/${code}/files/${f.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    await request(app)
      .delete(`/api/meetings/${code}/files/trash/${f.id}`)
      .set('Authorization', `Bearer ${host.token}`);
    expect(fs.readdirSync(blobDir).length).toBe(before - 1);
  });

  it('비참가자 403', async () => {
    const { code } = await setup('cf7');
    const stranger = await registerUser('cf7_stranger');
    const r = await request(app)
      .get(`/api/meetings/${code}/files`)
      .set('Authorization', `Bearer ${stranger.token}`);
    expect(r.status).toBe(403);
  });

  it('파일 있는 회의 삭제가 FK 강제 환경에서도 되고 파일도 정리된다', async () => {
    db.pragma('foreign_keys = ON');
    try {
      const { host, code } = await setup('cf8');
      const folder = await request(app)
        .post(`/api/meetings/${code}/files`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({ name: '폴더', type: 'folder' });
      await request(app)
        .post(`/api/meetings/${code}/files`)
        .set('Authorization', `Bearer ${host.token}`)
        .send({ name: '문서', type: 'doc', parent_id: folder.body.id });
      const mid = (
        db.prepare('SELECT id FROM meetings WHERE code = ?').get(code) as { id: number }
      ).id;
      const del = await request(app)
        .delete(`/api/meetings/${code}`)
        .set('Authorization', `Bearer ${host.token}`);
      expect(del.status).toBe(200);
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ?').get(mid),
      ).toEqual({ n: 0 });
    } finally {
      db.pragma('foreign_keys = OFF');
    }
  });
});
