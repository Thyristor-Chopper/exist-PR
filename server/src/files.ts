import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import type { AuthedRequest } from './auth.js';
import { ydocExists, deleteYdoc, copyYdoc, readYdocSnapshot, writeYdoc, roomPresence } from './ydoc.js';
import {
  parseCsv,
  parseXlsx,
  parseDocx,
  buildSheetYdoc,
  buildDocYdoc,
  buildDocYdocFromMarkdown,
} from './importFile.js';
import { notifyUser } from './notify.js';
import { canManageMeeting } from './perm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 업로드 파일(blob) 저장소 — DATA_DIR/uploads-files */
const BLOB_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads-files');
const MAX_UPLOAD = 25 * 1024 * 1024; // 25MB

function deleteBlob(blobPath: string | null | undefined) {
  if (!blobPath) return;
  try {
    fs.unlinkSync(path.join(BLOB_DIR, blobPath));
  } catch {
    /* 이미 없음 */
  }
}

/*
 * 공동편집 파일시스템 — 그룹 안에서 코드/문서/시트/발표 파일을 여러 개 만들고 폴더로 정리.
 * 각 파일은 Yjs 룸 하나(file-{id}). 그룹당 하나였던 레거시 문서(code-CODE 등)는
 * .bin이 존재하면 첫 조회 때 파일로 자동 흡수된다 (기존 내용 보존).
 * meetings 라우터에 /:code/files 로 마운트 (mergeParams).
 */

export type FileType = 'folder' | 'code' | 'doc' | 'sheet' | 'slide' | 'canvas' | 'file';
// 'file'(업로드)은 /upload로만 생김 — 일반 생성으론 못 만듦
const FILE_TYPES: FileType[] = ['folder', 'code', 'doc', 'sheet', 'slide', 'canvas'];
const MAX_FILES = 100;
const MAX_DEPTH = 5;

interface FileRow {
  id: number;
  parent_id: number | null;
  name: string;
  type: FileType;
  room: string | null;
  created_by: number;
}

/** 레거시 흡수 — 그룹당 1개였던 시절의 문서(.bin 존재)를 파일로 등록 */
const LEGACY: { name: string; type: FileType; prefix: string }[] = [
  { name: '코드', type: 'code', prefix: 'code-' },
  { name: '문서', type: 'doc', prefix: 'doc-' },
  { name: '시트', type: 'sheet', prefix: 'sheet-' },
  { name: '발표', type: 'slide', prefix: 'slide-' },
  { name: '캔버스', type: 'canvas', prefix: 'mt-' },
];

export function ensureLegacyFiles(meetingId: number, meetingCode: string, userId: number) {
  const has = db
    .prepare('SELECT 1 FROM collab_files WHERE meeting_id = ? LIMIT 1')
    .get(meetingId);
  if (has) return;
  let created = 0;
  for (const l of LEGACY) {
    const room = `${l.prefix}${meetingCode.toUpperCase()}`;
    if (!ydocExists(room)) continue;
    db.prepare(
      'INSERT INTO collab_files (meeting_id, parent_id, name, type, room, created_by) VALUES (?, NULL, ?, ?, ?, ?)',
    ).run(meetingId, l.name, l.type, room, userId);
    created++;
  }
  // 레거시가 없는 새 그룹은 빈 폴더 하나로 시작
  if (created === 0) {
    db.prepare(
      'INSERT INTO collab_files (meeting_id, parent_id, name, type, created_by) VALUES (?, NULL, ?, ?, ?)',
    ).run(meetingId, '새 폴더', 'folder', userId);
  }
}

/** 회의 삭제 시 파일·Yjs 상태 정리 (meetings.ts DELETE에서 호출) */
export function deleteMeetingFiles(meetingId: number, meetingCode: string) {
  const rows = db
    .prepare('SELECT room FROM collab_files WHERE meeting_id = ? AND room IS NOT NULL')
    .all(meetingId) as { room: string }[];
  for (const r of rows) deleteYdoc(r.room);
  const blobs = db
    .prepare('SELECT blob_path FROM collab_files WHERE meeting_id = ? AND blob_path IS NOT NULL')
    .all(meetingId) as { blob_path: string }[];
  for (const b of blobs) deleteBlob(b.blob_path);
  // 레거시 룸도 정리 (파일로 흡수 안 된 상태로 남았을 수 있음)
  for (const l of LEGACY) deleteYdoc(`${l.prefix}${meetingCode.toUpperCase()}`);
  deleteYdoc(`mt-${meetingCode.toUpperCase()}`); // 캔버스
  db.prepare('DELETE FROM collab_files WHERE meeting_id = ?').run(meetingId);
}

function cleanName(v: unknown): string | null {
  const name = String(v ?? '')
    .trim()
    .replace(/[/\\]/g, '')
    .slice(0, 60);
  return name.length >= 1 ? name : null;
}

function depthOf(meetingId: number, parentId: number | null): number {
  let depth = 0;
  let cur = parentId;
  while (cur != null && depth <= MAX_DEPTH) {
    const row = db
      .prepare('SELECT parent_id FROM collab_files WHERE id = ? AND meeting_id = ?')
      .get(cur, meetingId) as { parent_id: number | null } | undefined;
    if (!row) return -1; // 다른 회의의 폴더거나 없음
    depth++;
    cur = row.parent_id;
  }
  return depth;
}

interface MeetingRef {
  id: number;
  code: string;
  host_id: number;
  org_id: number | null;
}

/** 파일 관리 권한 — 만든 사람, 호스트, 조직 관리자, group:files 중간관리자 */
function canManageFile(f: { created_by: number }, meeting: MeetingRef, userId: number): boolean {
  return f.created_by === userId || canManageMeeting(meeting, userId, 'group:files');
}

/** 참가자 검증 (meetings.ts와 동일 패턴 — 순환 import 방지 위해 자체 보유) */
function checkParticipant(
  code: unknown,
  userId: number,
): { ok: false; status: 403 | 404; error: string } | { ok: true; meeting: MeetingRef } {
  const meeting = db
    .prepare('SELECT id, code, host_id, org_id FROM meetings WHERE code = ?')
    .get(String(code ?? '').toUpperCase()) as MeetingRef | undefined;
  if (!meeting) return { ok: false, status: 404, error: '존재하지 않는 회의입니다' };
  const isParticipant = db
    .prepare('SELECT 1 FROM meeting_participants WHERE meeting_id = ? AND user_id = ?')
    .get(meeting.id, userId);
  if (!isParticipant) return { ok: false, status: 403, error: '회의 참가자만 쓸 수 있어요' };
  return { ok: true, meeting };
}

const router = Router({ mergeParams: true });

/** 파일 목록 (평면 배열 — 클라가 parent_id로 트리 구성) */
router.get('/', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  ensureLegacyFiles(r.meeting.id, r.meeting.code, req.userId!);
  const rows = db
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.type, f.room, f.mime, f.size, f.created_at, u.username AS author
       FROM collab_files f JOIN users u ON u.id = f.created_by
       WHERE f.meeting_id = ? AND f.deleted_at IS NULL ORDER BY f.type = 'folder' DESC, f.name`,
    )
    .all(r.meeting.id);
  res.json(rows);
});

/** 파일별 현재 편집자 — { fileId: [{username, avatar}] } (awareness 기반, 접속 중인 룸만) */
router.get('/presence', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const rows = db
    .prepare('SELECT id, room FROM collab_files WHERE meeting_id = ? AND room IS NOT NULL AND deleted_at IS NULL')
    .all(r.meeting.id) as { id: number; room: string }[];
  const parts = db
    .prepare(
      `SELECT u.username, u.name, u.avatar FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ?`,
    )
    .all(r.meeting.id) as { username: string; name: string | null; avatar: string | null }[];
  const byKey = new Map<string, { username: string; avatar: string | null }>();
  for (const p of parts) {
    byKey.set(p.username, { username: p.username, avatar: p.avatar });
    if (p.name) byKey.set(p.name, { username: p.username, avatar: p.avatar });
  }
  const out: Record<number, { username: string; avatar: string | null }[]> = {};
  for (const f of rows) {
    const states = roomPresence(f.room);
    if (!states.length) continue;
    const seen = new Set<string>();
    const list: { username: string; avatar: string | null }[] = [];
    for (const s of states) {
      const p = byKey.get(s.name) ?? { username: s.name, avatar: null };
      if (seen.has(p.username)) continue;
      seen.add(p.username);
      list.push(p);
    }
    if (list.length) out[f.id] = list;
  }
  res.json(out);
});

/** 문서 @멘션 알림 — 멘션된 참가자에게 알림 (본인 제외) */
router.post('/:fileId/mention', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT name FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
    .get(req.params.fileId, r.meeting.id) as { name: string } | undefined;
  if (!f) return res.status(404).json({ error: '존재하지 않는 파일이에요' });
  const username = String(req.body?.username ?? '');
  const target = db
    .prepare(
      `SELECT u.id FROM users u JOIN meeting_participants mp ON mp.user_id = u.id
       WHERE mp.meeting_id = ? AND u.username = ?`,
    )
    .get(r.meeting.id, username) as { id: number } | undefined;
  if (!target) return res.status(404).json({ error: '이 그룹 참가자가 아니에요' });
  if (target.id !== req.userId) {
    notifyUser(target.id, {
      from: req.username ?? '누군가',
      text: `"${f.name}" 문서에서 회원님을 멘션했어요`,
      kind: 'mention',
      meetingCode: r.meeting.code,
    });
  }
  res.json({ ok: true });
});

/** 파일 업로드 — raw body, ?name=원본이름&parent_id= (중복 이름은 " (n)" 자동) */
router.post('/upload', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const rawName = cleanName(req.query.name);
  if (!rawName) return res.status(400).json({ error: '파일 이름이 없어요' });
  const parentId = req.query.parent_id != null && req.query.parent_id !== '' ? Number(req.query.parent_id) : null;
  if (parentId != null) {
    const parent = db
      .prepare('SELECT type FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
      .get(parentId, r.meeting.id) as { type: string } | undefined;
    if (!parent || parent.type !== 'folder')
      return res.status(400).json({ error: '폴더 안에만 올릴 수 있어요' });
  }
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ? AND deleted_at IS NULL').get(r.meeting.id) as {
      n: number;
    }
  ).n;
  if (count >= MAX_FILES) return res.status(400).json({ error: `파일은 그룹당 ${MAX_FILES}개까지예요` });

  // 중복 이름 자동 회피: "이름 (2).ext"
  const dot = rawName.lastIndexOf('.');
  const base = dot > 0 ? rawName.slice(0, dot) : rawName;
  const ext = dot > 0 ? rawName.slice(dot) : '';
  let name = rawName;
  for (let n = 2; n <= 20; n++) {
    const dup = db
      .prepare('SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL')
      .get(r.meeting.id, name, parentId);
    if (!dup) break;
    name = `${base} (${n})${ext}`;
  }

  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
  // 본문 버퍼링 (임포트 판단에 전체 필요)
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD && !aborted) {
      aborted = true;
      res.status(413).json({ error: '파일은 25MB까지 올릴 수 있어요' });
      req.destroy();
      return;
    }
    if (!aborted) chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    ensureLegacyFiles(r.meeting.id, r.meeting.code, req.userId!);
    void finishUpload(res, r.meeting, req.userId!, { name, base, ext: ext.toLowerCase(), parentId, mime, buf });
  });
  req.on('error', () => {
    if (!aborted && !res.headersSent) res.status(500).json({ error: '업로드에 실패했어요' });
  });
});

/** 업로드 마무리 — csv/xlsx는 시트로, txt·md/docx는 문서로 변환. 나머지는 blob 보관 */
async function finishUpload(
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  meeting: MeetingRef,
  userId: number,
  p: { name: string; base: string; ext: string; parentId: number | null; mime: string; buf: Buffer },
) {
  const dedupe = (candidate: string) => {
    let out = candidate;
    for (let n = 2; n <= 20; n++) {
      const dup = db
        .prepare('SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL')
        .get(meeting.id, out, p.parentId);
      if (!dup) break;
      out = `${candidate} (${n})`;
    }
    return out;
  };
  const insertTyped = (type: FileType) => {
    const name = dedupe(p.base);
    const info = db
      .prepare('INSERT INTO collab_files (meeting_id, parent_id, name, type, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(meeting.id, p.parentId, name, type, userId);
    const id = info.lastInsertRowid as number;
    const room = `file-${id}`;
    db.prepare('UPDATE collab_files SET room = ? WHERE id = ?').run(room, id);
    return { id, room, name };
  };
  try {
    if (p.ext === '.csv') {
      const grid = parseCsv(p.buf.toString('utf8'));
      const f = insertTyped('sheet');
      writeYdoc(f.room, (doc) => buildSheetYdoc(doc, [{ name: '시트1', grid }]));
      return res.json({ id: f.id, parent_id: p.parentId, name: p.base, type: 'sheet', imported: true });
    }
    if (p.ext === '.xlsx') {
      const sheets = await parseXlsx(p.buf);
      const f = insertTyped('sheet');
      writeYdoc(f.room, (doc) => buildSheetYdoc(doc, sheets));
      return res.json({ id: f.id, parent_id: p.parentId, name: p.base, type: 'sheet', imported: true });
    }
    if (p.ext === '.docx') {
      const paras = await parseDocx(p.buf);
      const f = insertTyped('doc');
      writeYdoc(f.room, (doc) => buildDocYdoc(doc, p.base, paras));
      return res.json({ id: f.id, parent_id: p.parentId, name: p.base, type: 'doc', imported: true });
    }
    if (p.ext === '.md') {
      const f = insertTyped('doc');
      writeYdoc(f.room, (doc) => buildDocYdocFromMarkdown(doc, p.base, p.buf.toString('utf8')));
      return res.json({ id: f.id, parent_id: p.parentId, name: f.name, type: 'doc', imported: true });
    }
    if (p.ext === '.txt') {
      const paras = p.buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
      const f = insertTyped('doc');
      writeYdoc(f.room, (doc) => buildDocYdoc(doc, p.base, paras));
      return res.json({ id: f.id, parent_id: p.parentId, name: f.name, type: 'doc', imported: true });
    }
  } catch {
    /* 파싱 실패 → 그냥 파일로 보관 */
  }
  const blobName = `${crypto.randomUUID()}${p.ext.replace(/[^.\w-]/g, '').slice(0, 10)}`;
  fs.mkdirSync(BLOB_DIR, { recursive: true });
  fs.writeFileSync(path.join(BLOB_DIR, blobName), p.buf);
  const info = db
    .prepare(
      'INSERT INTO collab_files (meeting_id, parent_id, name, type, created_by, mime, size, blob_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(meeting.id, p.parentId, p.name, 'file', userId, p.mime, p.buf.length, blobName);
  res.json({ id: info.lastInsertRowid, parent_id: p.parentId, name: p.name, type: 'file', mime: p.mime, size: p.buf.length });
}

/** 업로드 파일 다운로드/보기 */
router.get('/:fileId/download', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT name, type, mime, blob_path FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
    .get(req.params.fileId, r.meeting.id) as
    | { name: string; type: FileType; mime: string | null; blob_path: string | null }
    | undefined;
  if (!f || f.type !== 'file' || !f.blob_path)
    return res.status(404).json({ error: '업로드된 파일이 아니에요' });
  const filePath = path.join(BLOB_DIR, f.blob_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '파일이 사라졌어요' });
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  // 전역 X-Frame-Options: DENY가 같은 오리진 인앱 뷰어(iframe PDF)까지 막는다 — 이 라우트만 완화
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  fs.createReadStream(filePath).pipe(res);
});

/** 파일/폴더 생성 — 참가자 누구나 */
router.post('/', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: '이름을 입력하세요' });
  const type = req.body?.type as FileType;
  if (!FILE_TYPES.includes(type)) return res.status(400).json({ error: '잘못된 종류예요' });

  const parentId = req.body?.parent_id != null ? Number(req.body.parent_id) : null;
  if (parentId != null) {
    const parent = db
      .prepare('SELECT type FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
      .get(parentId, r.meeting.id) as { type: string } | undefined;
    if (!parent || parent.type !== 'folder')
      return res.status(400).json({ error: '폴더 안에만 만들 수 있어요' });
    const depth = depthOf(r.meeting.id, parentId);
    if (depth < 0 || depth >= MAX_DEPTH)
      return res.status(400).json({ error: `폴더는 ${MAX_DEPTH}단계까지예요` });
  }

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ? AND deleted_at IS NULL').get(r.meeting.id) as {
      n: number;
    }
  ).n;
  if (count >= MAX_FILES) return res.status(400).json({ error: `파일은 그룹당 ${MAX_FILES}개까지예요` });

  const dup = db
    .prepare(
      'SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL',
    )
    .get(r.meeting.id, name, parentId);
  if (dup) return res.status(409).json({ error: '같은 위치에 같은 이름이 있어요' });

  ensureLegacyFiles(r.meeting.id, r.meeting.code, req.userId!);
  const info = db
    .prepare(
      'INSERT INTO collab_files (meeting_id, parent_id, name, type, created_by) VALUES (?, ?, ?, ?, ?)',
    )
    .run(r.meeting.id, parentId, name, type, req.userId!);
  const id = info.lastInsertRowid as number;
  let room: string | null = null;
  if (type !== 'folder') {
    room = `file-${id}`;
    db.prepare('UPDATE collab_files SET room = ? WHERE id = ?').run(room, id);
  }
  res.json({ id, parent_id: parentId, name, type, room });
});

/** 이름 변경·이동 — 만든 사람·호스트·조직 관리자. body에 name(이름 변경) / parent_id(이동, null=루트) */
router.patch('/:fileId', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT id, parent_id, name, type, created_by FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
    .get(req.params.fileId, r.meeting.id) as FileRow | undefined;
  if (!f) return res.status(404).json({ error: '존재하지 않는 파일이에요' });
  if (!canManageFile(f, r.meeting, req.userId!)) {
    return res.status(403).json({ error: '만든 사람·호스트·조직 관리자만 바꿀 수 있어요' });
  }

  // 이동 (잘라내기 → 붙여넣기)
  if ('parent_id' in (req.body ?? {})) {
    const target = req.body.parent_id == null ? null : Number(req.body.parent_id);
    if (target != null) {
      const parent = db
        .prepare('SELECT id, type FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
        .get(target, r.meeting.id) as { id: number; type: string } | undefined;
      if (!parent || parent.type !== 'folder')
        return res.status(400).json({ error: '폴더로만 이동할 수 있어요' });
      // 자기 자신·자기 하위로의 이동 금지 (사이클 방지)
      let cur: number | null = target;
      while (cur != null) {
        if (cur === f.id) return res.status(400).json({ error: '자기 폴더 안으로는 이동할 수 없어요' });
        const row = db
          .prepare('SELECT parent_id FROM collab_files WHERE id = ?')
          .get(cur) as { parent_id: number | null } | undefined;
        cur = row?.parent_id ?? null;
      }
      const depth = depthOf(r.meeting.id, target);
      if (depth < 0 || depth >= MAX_DEPTH)
        return res.status(400).json({ error: `폴더는 ${MAX_DEPTH}단계까지예요` });
    }
    const dup = db
      .prepare('SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND id != ? AND deleted_at IS NULL')
      .get(r.meeting.id, f.name, target, f.id);
    if (dup) return res.status(409).json({ error: '옮길 위치에 같은 이름이 있어요' });
    db.prepare('UPDATE collab_files SET parent_id = ? WHERE id = ?').run(target, f.id);
    return res.json({ id: f.id, parent_id: target });
  }

  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ error: '이름을 입력하세요' });
  const dup = db
    .prepare(
      'SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND id != ? AND deleted_at IS NULL',
    )
    .get(r.meeting.id, name, f.parent_id, f.id);
  if (dup) return res.status(409).json({ error: '같은 위치에 같은 이름이 있어요' });
  db.prepare('UPDATE collab_files SET name = ? WHERE id = ?').run(name, f.id);
  res.json({ id: f.id, name });
});

/** 복제 (복사 → 붙여넣기) — 참가자 누구나. 폴더는 하위까지 재귀, Yjs 내용도 복사 */
router.post('/:fileId/copy', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const src = db
    .prepare('SELECT id, parent_id, name, type, room, created_by FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
    .get(req.params.fileId, r.meeting.id) as (FileRow & { room: string | null }) | undefined;
  if (!src) return res.status(404).json({ error: '존재하지 않는 파일이에요' });

  const target = req.body?.parent_id == null ? null : Number(req.body.parent_id);
  if (target != null) {
    const parent = db
      .prepare('SELECT type FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
      .get(target, r.meeting.id) as { type: string } | undefined;
    if (!parent || parent.type !== 'folder')
      return res.status(400).json({ error: '폴더에만 붙여넣을 수 있어요' });
  }

  const meetingId = r.meeting.id;
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM collab_files WHERE meeting_id = ? AND deleted_at IS NULL').get(meetingId) as {
      n: number;
    }
  ).n;

  /** 대상 위치에서 안 겹치는 이름 — "이름", "이름 (2)", "이름 (3)" … */
  function freeName(base: string, parentId: number | null): string {
    let name = base;
    for (let i = 2; ; i++) {
      const dup = db
        .prepare('SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL')
        .get(meetingId, name, parentId);
      if (!dup) return name;
      name = `${base} (${i})`.slice(0, 60);
    }
  }

  let created = 0;
  const copyRec = (node: FileRow & { room: string | null }, parentId: number | null): number => {
    if (count + created >= MAX_FILES) throw new Error('full');
    const name = freeName(node.name, parentId);
    const info = db
      .prepare(
        'INSERT INTO collab_files (meeting_id, parent_id, name, type, created_by) VALUES (?, ?, ?, ?, ?)',
      )
      .run(meetingId, parentId, name, node.type, req.userId!);
    created++;
    const newId = info.lastInsertRowid as number;
    if (node.type !== 'folder') {
      const room = `file-${newId}`;
      db.prepare('UPDATE collab_files SET room = ? WHERE id = ?').run(room, newId);
      if (node.room) copyYdoc(node.room, room);
    } else {
      const children = db
        .prepare('SELECT id, parent_id, name, type, room, created_by FROM collab_files WHERE parent_id = ? AND deleted_at IS NULL')
        .all(node.id) as (FileRow & { room: string | null })[];
      for (const c of children) copyRec(c, newId);
    }
    return newId;
  };

  try {
    const newId = copyRec(src, target);
    res.json({ id: newId, created });
  } catch (e) {
    if ((e as Error).message === 'full')
      return res.status(400).json({ error: `파일은 그룹당 ${MAX_FILES}개까지예요` });
    throw e;
  }
});

/** 하위 트리 id 수집 (BFS) — 삭제되지 않은 것만 */
function collectSubtree(rootId: number): number[] {
  const ids: number[] = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift()!;
    const children = db
      .prepare('SELECT id FROM collab_files WHERE parent_id = ? AND deleted_at IS NULL')
      .all(cur) as { id: number }[];
    for (const c of children) {
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  return ids;
}

/** 삭제 → 휴지통 (소프트) — 만든 사람·호스트·조직 관리자. 폴더는 하위까지 묶어서. Yjs는 보존 */
router.delete('/:fileId', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT id, created_by FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
    .get(req.params.fileId, r.meeting.id) as FileRow | undefined;
  if (!f) return res.status(404).json({ error: '존재하지 않는 파일이에요' });
  if (!canManageFile(f, r.meeting, req.userId!)) {
    return res.status(403).json({ error: '만든 사람·호스트·조직 관리자만 삭제할 수 있어요' });
  }

  const ids = collectSubtree(f.id);
  const ph = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE collab_files SET deleted_at = datetime('now'), deleted_root = ? WHERE id IN (${ph})`,
  ).run(f.id, ...ids);
  res.json({ ok: true, trashed: ids.length });
});

/** 휴지통 목록 — 삭제 묶음의 루트만 (하위 개수 포함) */
router.get('/trash/list', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const rows = db
    .prepare(
      `SELECT f.id, f.name, f.type, f.deleted_at, u.username AS author,
              (SELECT COUNT(*) - 1 FROM collab_files c WHERE c.deleted_root = f.id) AS children
       FROM collab_files f JOIN users u ON u.id = f.created_by
       WHERE f.meeting_id = ? AND f.deleted_root = f.id
       ORDER BY f.deleted_at DESC`,
    )
    .all(r.meeting.id);
  res.json(rows);
});

/** 휴지통 복원 — 원래 자리로 (부모가 삭제됐으면 루트로, 이름 겹치면 (2) 붙임) */
router.post('/trash/:fileId/restore', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare(
      'SELECT id, parent_id, name, created_by FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_root = id',
    )
    .get(req.params.fileId, r.meeting.id) as
    | { id: number; parent_id: number | null; name: string; created_by: number }
    | undefined;
  if (!f) return res.status(404).json({ error: '휴지통에 없는 항목이에요' });
  if (!canManageFile(f, r.meeting, req.userId!)) {
    return res.status(403).json({ error: '만든 사람·호스트·조직 관리자만 복원할 수 있어요' });
  }

  // 원래 부모가 삭제됐거나 없어졌으면 루트로
  let target: number | null = f.parent_id;
  if (target != null) {
    const parent = db
      .prepare('SELECT 1 FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
      .get(target, r.meeting.id);
    if (!parent) target = null;
  }
  // 복원 위치 이름 충돌 → "이름 (2)"
  let name = f.name;
  for (let i = 2; ; i++) {
    const dup = db
      .prepare(
        'SELECT 1 FROM collab_files WHERE meeting_id = ? AND name = ? AND parent_id IS ? AND deleted_at IS NULL AND id != ?',
      )
      .get(r.meeting.id, name, target, f.id);
    if (!dup) break;
    name = `${f.name} (${i})`.slice(0, 60);
  }
  db.prepare('UPDATE collab_files SET deleted_at = NULL, deleted_root = NULL WHERE deleted_root = ?').run(
    f.id,
  );
  db.prepare('UPDATE collab_files SET parent_id = ?, name = ? WHERE id = ?').run(target, name, f.id);
  res.json({ ok: true, parent_id: target, name });
});

/** 휴지통 영구 삭제 — Yjs 상태까지 제거 */
router.delete('/trash/:fileId', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT id, created_by FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_root = id')
    .get(req.params.fileId, r.meeting.id) as FileRow | undefined;
  if (!f) return res.status(404).json({ error: '휴지통에 없는 항목이에요' });
  if (!canManageFile(f, r.meeting, req.userId!)) {
    return res.status(403).json({ error: '만든 사람·호스트·조직 관리자만 지울 수 있어요' });
  }
  const rooms = db
    .prepare('SELECT room FROM collab_files WHERE deleted_root = ? AND room IS NOT NULL')
    .all(f.id) as { room: string }[];
  for (const row of rooms) deleteYdoc(row.room);
  const blobs = db
    .prepare('SELECT blob_path FROM collab_files WHERE deleted_root = ? AND blob_path IS NOT NULL')
    .all(f.id) as { blob_path: string }[];
  for (const row of blobs) deleteBlob(row.blob_path);
  const info = db.prepare('DELETE FROM collab_files WHERE deleted_root = ?').run(f.id);
  res.json({ ok: true, purged: info.changes });
});

/** 미리보기 — 문서 안에 뭐가 들었는지 (코드 파일/문서/시트 이름들, 슬라이드 수) */
router.get('/:fileId/preview', (req: AuthedRequest, res) => {
  const r = checkParticipant((req.params as { code?: string }).code, req.userId!);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const f = db
    .prepare('SELECT type, room, mime, size FROM collab_files WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL')
    .get(req.params.fileId, r.meeting.id) as
    | { type: FileType; room: string | null; mime: string | null; size: number | null }
    | undefined;
  if (!f) return res.status(404).json({ error: '존재하지 않는 파일이에요' });
  if (f.type === 'file') {
    const kb = f.size != null ? (f.size >= 1048576 ? `${(f.size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(f.size / 1024))}KB`) : '';
    return res.json({ items: [f.mime ?? '파일', kb].filter(Boolean) });
  }
  if (f.type === 'folder' || !f.room) return res.json({ items: [] });

  const doc = readYdocSnapshot(f.room);
  if (!doc) return res.json({ items: [] });
  try {
    if (f.type === 'code') {
      const items: { name: string; ord: number; dir?: boolean }[] = [];
      doc.getMap<{ name: string; ord: number; dir?: boolean }>('files').forEach((v) => items.push(v));
      items.sort((a, b) => a.ord - b.ord);
      return res.json({ items: items.slice(0, 12).map((i) => (i.dir ? `${i.name}/` : i.name)) });
    }
    if (f.type === 'doc') {
      const items: { name: string; ord: number }[] = [];
      doc.getMap<{ name: string; ord: number }>('docs').forEach((v) => items.push(v));
      items.sort((a, b) => a.ord - b.ord);
      return res.json({ items: items.slice(0, 12).map((i) => i.name) });
    }
    if (f.type === 'sheet') {
      const items: { name: string; ord: number }[] = [];
      doc.getMap<{ name: string; ord: number }>('sheets').forEach((v) => items.push(v));
      items.sort((a, b) => a.ord - b.ord);
      return res.json({ items: items.slice(0, 12).map((i) => i.name) });
    }
    if (f.type === 'slide') {
      return res.json({ items: [], count: doc.getMap('slides').size });
    }
    return res.json({ items: [] });
  } finally {
    doc.destroy();
  }
});

export default router;
