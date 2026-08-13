import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 아바타 이미지는 워크스페이스와 같은 업로드 디렉토리에 저장 (서빙도 그쪽 재사용)
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_AVATAR = 5 * 1024 * 1024;

export interface AuthedRequest extends Request {
  userId?: number;
  username?: string;
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** 복구 코드 생성 — "XXXX-XXXX-XXXX-XXXX" (혼동 문자 제외) */
export function generateRecoveryCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `${group()}-${group()}-${group()}-${group()}`;
}

const SESSION_TTL_DAYS = 30;

/** Bearer 토큰 검사 미들웨어 (30일 만료) — 새 탭 열기용으로 ?token= 쿼리도 허용 (/yjs와 동일 규약) */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const token =
    req.headers.authorization?.replace(/^Bearer /, '') ||
    (typeof req.query?.token === 'string' ? req.query.token : undefined);
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });

  const row = db
    .prepare(
      `SELECT s.user_id, u.username FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', '-${SESSION_TTL_DAYS} days')`,
    )
    .get(token) as { user_id: number; username: string } | undefined;
  if (!row) return res.status(401).json({ error: '세션이 만료됐습니다. 다시 로그인하세요' });

  req.userId = row.user_id;
  req.username = row.username;
  next();
}

/** 요청의 세션 토큰 — requireAuth와 동일 규약(헤더 우선, ?token= 쿼리 폴백).
 * 헤더만 보고 !를 걸면 쿼리 인증으로 들어온 요청에서 undefined.replace로 500이 난다. */
function sessionToken(req: AuthedRequest): string {
  return (
    req.headers.authorization?.replace(/^Bearer /, '') ||
    (typeof req.query?.token === 'string' ? req.query.token : '')
  );
}

const router = Router();

// ── 로그인 무차별 대입 방지: IP+아이디당 15분에 10회 ──
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

/** 표시 이름 정규화 — 빈 값은 null(아이디로 표시), 최대 20자 */
function cleanDisplayName(v: unknown): string | null {
  const name = String(v ?? '').trim().slice(0, 20);
  return name.length > 0 ? name : null;
}

router.post('/register', (req, res) => {
  const { username, password, name } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
  }
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(String(username))) {
    return res.status(400).json({ error: '아이디는 영문·숫자·_ 3~20자입니다' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: '이미 존재하는 아이디입니다' });
  }
  const displayName = cleanDisplayName(name);
  const salt = crypto.randomBytes(16).toString('hex');
  const recoveryCode = generateRecoveryCode();
  const recoverySalt = crypto.randomBytes(16).toString('hex');
  const info = db
    .prepare(
      'INSERT INTO users (username, pw_hash, pw_salt, recovery_hash, recovery_salt, name) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      username,
      hashPassword(password, salt),
      salt,
      hashPassword(recoveryCode, recoverySalt),
      recoverySalt,
      displayName,
    );

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, info.lastInsertRowid);
  // recoveryCode는 이 응답에서 단 한 번만 노출 — 서버는 해시만 보관
  res.json({
    token,
    user: { id: info.lastInsertRowid, username, name: displayName },
    recoveryCode,
  });
});

/** 비밀번호 재설정 — 아이디 + 복구 코드 검증 후 새 비밀번호 + 새 복구 코드 발급 */
router.post('/reset', (req, res) => {
  const { username, recoveryCode, newPassword } = req.body ?? {};
  const key = `reset:${req.ip}:${username ?? ''}`;
  if (rateLimited(key)) {
    return res.status(429).json({ error: '시도가 너무 많습니다. 15분 뒤에 다시 해보세요' });
  }
  if (!username || !recoveryCode || !newPassword) {
    return res.status(400).json({ error: '모든 항목을 입력하세요' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username)) as
    | {
        id: number;
        recovery_hash: string | null;
        recovery_salt: string | null;
      }
    | undefined;
  if (!user || !user.recovery_hash || !user.recovery_salt) {
    return res.status(400).json({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
  }
  const normalized = String(recoveryCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const grouped = normalized.match(/.{1,4}/g)?.join('-') ?? '';
  if (hashPassword(grouped, user.recovery_salt) !== user.recovery_hash) {
    return res.status(400).json({ error: '아이디 또는 복구 코드가 올바르지 않습니다' });
  }

  // 새 비밀번호 + 새 복구 코드 (기존 코드는 1회용)
  const salt = crypto.randomBytes(16).toString('hex');
  const newCode = generateRecoveryCode();
  const newRecoverySalt = crypto.randomBytes(16).toString('hex');
  db.prepare(
    'UPDATE users SET pw_hash = ?, pw_salt = ?, recovery_hash = ?, recovery_salt = ? WHERE id = ?',
  ).run(
    hashPassword(newPassword, salt),
    salt,
    hashPassword(newCode, newRecoverySalt),
    newRecoverySalt,
    user.id,
  );
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // 기존 세션 전부 무효화
  attempts.delete(key);

  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: { id: user.id, username }, recoveryCode: newCode });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const key = `${req.ip}:${username ?? ''}`;
  if (rateLimited(key)) {
    return res.status(429).json({ error: '시도가 너무 많습니다. 15분 뒤에 다시 해보세요' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '')) as
    | { id: number; username: string; pw_hash: string; pw_salt: string; name: string | null }
    | undefined;
  if (!user || hashPassword(typeof password === 'string' ? password : '', user.pw_salt) !== user.pw_hash) {
    return res.status(400).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  }
  attempts.delete(key); // 성공 시 카운터 리셋
  const token = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
  res.json({ token, user: { id: user.id, username: user.username, name: user.name ?? null } });
});

router.post('/logout', requireAuth, (req: AuthedRequest, res) => {
  const token = sessionToken(req);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

/** 내 정보 */
router.get('/me', requireAuth, (req: AuthedRequest, res) => {
  const me = db
    .prepare('SELECT id, username, avatar, name, email, phone, address FROM users WHERE id = ?')
    .get(req.userId) as {
    id: number;
    username: string;
    avatar: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  res.json(me);
});

/** 표시 이름 디렉터리 — username → name. 클라가 아이디 대신 이름을 보여줄 때 쓴다 */
router.get('/names', requireAuth, (_req, res) => {
  const rows = db.prepare('SELECT username, name FROM users WHERE name IS NOT NULL').all();
  res.json(rows);
});

/** 프로필 수정 — 아바타·이름·이메일·전화번호·주소 (넘어온 필드만 갱신, 빈 문자열 = 지움) */
router.patch('/me', requireAuth, (req: AuthedRequest, res) => {
  const { avatar, name, email, phone, address } = req.body ?? {};
  if (
    avatar === undefined &&
    name === undefined &&
    email === undefined &&
    phone === undefined &&
    address === undefined
  ) {
    return res.status(400).json({ error: '변경할 항목이 없어요' });
  }
  if (avatar !== undefined) {
    if (typeof avatar !== 'string' || avatar.length === 0 || avatar.length > 8) {
      return res.status(400).json({ error: '올바르지 않은 아바타입니다' });
    }
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.userId);
  }
  let displayName: string | null | undefined;
  if (name !== undefined) {
    displayName = cleanDisplayName(name);
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(displayName, req.userId);
  }
  if (email !== undefined) {
    const v = String(email ?? '').trim().slice(0, 80) || null;
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return res.status(400).json({ error: '이메일 형식이 올바르지 않아요' });
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(v, req.userId);
  }
  if (phone !== undefined) {
    const v = String(phone ?? '').trim().slice(0, 30) || null;
    if (v && !/^[0-9+\-() ]+$/.test(v)) {
      return res.status(400).json({ error: '전화번호는 숫자와 - + ( )만 쓸 수 있어요' });
    }
    db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(v, req.userId);
  }
  if (address !== undefined) {
    const v = String(address ?? '').trim().slice(0, 120) || null;
    db.prepare('UPDATE users SET address = ? WHERE id = ?').run(v, req.userId);
  }
  if (displayName !== undefined) return res.json({ ok: true, name: displayName });
  res.json({ ok: true });
});

/** 프로필 사진 업로드 — 이미지 raw body, 저장 후 avatar에 URL 설정 (최대 5MB) */
router.post('/avatar', requireAuth, (req: AuthedRequest, res) => {
  const ct = String(req.headers['content-type'] ?? '');
  if (!ct.startsWith('image/')) {
    return res.status(400).json({ error: '이미지 파일만 올릴 수 있어요' });
  }
  const ext = ct.split('/')[1]?.replace(/[^\w]/g, '').slice(0, 5) || 'png';
  const filename = `avatar-${crypto.randomUUID()}.${ext}`;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_AVATAR) {
      res.status(413).json({ error: '사진이 너무 커요 (최대 5MB)' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    if (size === 0) return res.status(400).json({ error: '빈 파일이에요' });
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.concat(chunks));
      const url = `/api/workspaces/uploads/${filename}`;
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(url, req.userId);
      res.json({ avatar: url });
    } catch (e) {
      // 이벤트 콜백 안의 예외는 Express가 못 잡는다 — 직접 응답
      console.error('[avatar]', e);
      res.status(500).json({ error: '업로드 저장에 실패했어요' });
    }
  });
});

/** 비밀번호 변경 — 현재 비밀번호 확인 후 */
router.post('/password', requireAuth, (req: AuthedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '모든 항목을 입력하세요' });
  }
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: '모든 항목을 입력하세요' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: '새 비밀번호는 8자 이상이어야 합니다' });
  }
  const user = db.prepare('SELECT pw_hash, pw_salt FROM users WHERE id = ?').get(req.userId) as {
    pw_hash: string;
    pw_salt: string;
  };
  if (hashPassword(currentPassword, user.pw_salt) !== user.pw_hash) {
    return res.status(400).json({ error: '현재 비밀번호가 올바르지 않습니다' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(
    hashPassword(newPassword, salt),
    salt,
    req.userId,
  );
  // 현재 세션 외 전부 무효화
  const token = sessionToken(req);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.userId, token);
  res.json({ ok: true });
});

export default router;
