import { Router, type RequestHandler } from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { requireAuth } from './auth.js';

/*
 * 로컬 실행 엔드포인트 — 서버(이 PC)의 툴체인을 child_process로 실행.
 * 로컬 개발 도구이므로 코드 실행을 허용. 임시 디렉터리에 격리, 타임아웃 적용.
 */

const router = Router();
router.use(requireAuth);

/*
 * 보안 모델 — 코드/명령 실행은 서버 셸/파일시스템을 건드린다.
 *
 *  · /exec  : 격리된 별도 컨테이너(runner 서비스)로 위임한다. RUNNER_URL 이 설정되면
 *             그쪽으로 프록시 → 임의 코드는 internal 네트워크·cap_drop·non-root·read_only
 *             로 격리된 컨테이너 안에서만 돌아 호스트/DB 에 닿지 못한다.
 *             RUNNER_URL 이 없으면(로컬 개발) CODE_EXEC_ENABLED=1 일 때만 직접 실행.
 *  · /git   : 외부(GitHub) 접근이 필요해 격리망에 못 둔다 → CODE_EXEC_ENABLED 게이트.
 *  · /sql   : 인메모리 SQLite. ATTACH/확장 로드만 막으면 파일 접근이 없어 안전.
 */
const CODE_EXEC_ENABLED = process.env.CODE_EXEC_ENABLED === '1';
const RUNNER_URL = process.env.RUNNER_URL?.replace(/\/$/, '');

const requireExecEnabled: RequestHandler = (_req, res, next) => {
  if (!CODE_EXEC_ENABLED) {
    res.status(403).json({
      lines: [
        {
          type: 'error',
          text: '이 환경에서는 서버 코드 실행이 비활성화되어 있어요. (관리자: CODE_EXEC_ENABLED=1)',
        },
      ],
    });
    return;
  }
  next();
};

const RUN_TIMEOUT = 12000;
const isWin = process.platform === 'win32';
const OUT = isWin ? 'prog.exe' : 'prog'; // 빌드 산출물 파일명 (-o)
const EXE = isWin ? '.\\prog.exe' : './prog'; // 실행 명령 (cwd 기준)

interface RunFile {
  path: string;
  content: string;
}

interface Cmd {
  build?: string;
  run: string;
}

/** 언어 → 실행 명령(빌드/런). entry는 상대 경로. */
function commandFor(lang: string, entry: string, files: RunFile[]): Cmd | { error: string } {
  const q = (s: string) => `"${s}"`;
  const cppFiles = files.filter((f) => /\.(c|cc|cpp|cxx)$/i.test(f.path)).map((f) => q(f.path));
  switch (lang) {
    case 'js':
      return { run: `node ${q(entry)}` };
    case 'py':
      return { run: `${isWin ? 'python' : 'python3'} ${q(entry)}` };
    case 'ts':
      return { run: `npx --yes tsx ${q(entry)}` };
    case 'c':
      return { build: `gcc ${cppFiles.join(' ')} -o ${OUT}`, run: EXE };
    case 'cpp':
      return { build: `g++ -std=c++17 ${cppFiles.join(' ')} -o ${OUT}`, run: EXE };
    case 'java': {
      const cls = path.basename(entry).replace(/\.java$/, '');
      return { build: `javac ${q(entry)}`, run: `java ${cls}` };
    }
    case 'go':
      return { run: `go run ${q(entry)}` };
    case 'rust':
      return { build: `rustc ${q(entry)} -o ${OUT}`, run: EXE };
    case 'rb':
      return { run: `ruby ${q(entry)}` };
    case 'php':
      return { run: `php ${q(entry)}` };
    default:
      return { error: `${lang} 는 서버 실행을 지원하지 않아요` };
  }
}

function runShell(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT);
    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 100000) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(e.message), code: 1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

/** 코드 실행 — 격리 러너로 위임(RUNNER_URL), 없으면 로컬 직접 실행(게이트) */
router.post('/exec', async (req, res) => {
  const { lang, entry, files } = (req.body ?? {}) as { lang: string; entry: string; files: RunFile[] };
  if (
    typeof lang !== 'string' ||
    typeof entry !== 'string' ||
    !Array.isArray(files) ||
    files.some((f) => typeof f?.path !== 'string')
  ) {
    return res.status(400).json({ error: '잘못된 요청' });
  }

  // 격리 러너가 설정돼 있으면 그쪽으로 위임한다(프로덕션 경로).
  if (RUNNER_URL) {
    try {
      const upstream = await fetch(`${RUNNER_URL}/exec`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lang, entry, files }),
        // 러너 자체 타임아웃(12s)보다 넉넉히
        signal: AbortSignal.timeout(20000),
      });
      const data = await upstream.json();
      return res.status(upstream.status).json(data);
    } catch {
      return res.json({
        lines: [{ type: 'error', text: '실행 러너에 연결할 수 없어요. 잠시 후 다시 시도해주세요.' }],
      });
    }
  }

  // 러너 미설정(로컬 개발): 명시적으로 켠 경우에만 이 컨테이너에서 직접 실행.
  if (!CODE_EXEC_ENABLED) {
    return res.status(403).json({
      lines: [
        { type: 'error', text: '서버 코드 실행이 비활성화되어 있어요. (관리자: RUNNER_URL 또는 CODE_EXEC_ENABLED=1)' },
      ],
    });
  }
  const cmd = commandFor(lang, entry, files);
  if ('error' in cmd) {
    return res.json({ lines: [{ type: 'error', text: cmd.error }] });
  }

  const dir = path.join(os.tmpdir(), 'exist-run-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 파일 쓰기 (경로/폴더 보존, 디렉터리 탈출 방지)
    for (const f of files) {
      const safe = path.normalize(f.path).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(dir, safe);
      if (!full.startsWith(dir)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content ?? '');
    }

    const lines: { type: string; text: string }[] = [];
    if (cmd.build) {
      const b = await runShell(cmd.build, dir);
      if (b.stderr.trim()) lines.push({ type: b.code === 0 ? 'warn' : 'error', text: b.stderr.trim() });
      if (b.code !== 0) {
        if (/not (found|recognized)|command not found|'\w+' is not recognized/i.test(b.stderr)) {
          lines.push({
            type: 'error',
            text: `컴파일러를 찾을 수 없어요. 서버 PC에 설치가 필요해요 (${cmd.build.split(' ')[0]}).`,
          });
        }
        lines.push({ type: 'error', text: '✗ 빌드 실패' });
        return res.json({ lines });
      }
    }
    const r = await runShell(cmd.run, dir);
    if (r.stdout) lines.push(...r.stdout.replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).map((text) => ({ type: 'log', text })));
    if (r.stderr.trim()) {
      if (/not (found|recognized)|command not found|is not recognized/i.test(r.stderr)) {
        lines.push({
          type: 'error',
          text: `실행기를 찾을 수 없어요. 서버 PC에 설치가 필요해요 (${cmd.run.split(' ')[0]}).`,
        });
      } else {
        lines.push({ type: 'error', text: r.stderr.trim() });
      }
    }
    if (r.timedOut) lines.push({ type: 'error', text: `⏱ 시간 초과(${RUN_TIMEOUT / 1000}초)` });
    else lines.push({ type: 'info', text: `✓ 종료 코드 ${r.code ?? 0}` });
    res.json({ lines });
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
});

/** SQL 실행 — 인메모리 SQLite (ATTACH/확장 로드 차단 → 파일시스템 격리) */
router.post('/sql', (req, res) => {
  const { sql } = (req.body ?? {}) as { sql: string };
  if (typeof sql !== 'string') return res.status(400).json({ error: '잘못된 요청' });
  const lines: { type: string; text: string }[] = [];
  const sdb = new Database(':memory:');
  try {
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      // 인메모리를 벗어나 호스트 파일에 접근하는 경로 차단
      if (/^\s*(attach|detach)\b/i.test(stmt) || /\bload_extension\s*\(/i.test(stmt)) {
        lines.push({ type: 'error', text: 'ATTACH/확장 로드는 허용되지 않아요.' });
        continue;
      }
      try {
        if (/^\s*(select|pragma|with|explain)\b/i.test(stmt)) {
          const rows = sdb.prepare(stmt).all() as Record<string, unknown>[];
          if (rows.length === 0) {
            lines.push({ type: 'info', text: '(행 없음)' });
          } else {
            const cols = Object.keys(rows[0]);
            lines.push({ type: 'log', text: cols.join(' | ') });
            lines.push({ type: 'log', text: cols.map((c) => '-'.repeat(Math.max(3, c.length))).join('-+-') });
            for (const row of rows.slice(0, 200)) {
              lines.push({ type: 'log', text: cols.map((c) => String(row[c] ?? '')).join(' | ') });
            }
            if (rows.length > 200) lines.push({ type: 'info', text: `… 외 ${rows.length - 200}행` });
          }
        } else {
          const info = sdb.prepare(stmt).run();
          lines.push({ type: 'info', text: `OK (${info.changes}행 변경)` });
        }
      } catch (e) {
        lines.push({ type: 'error', text: String((e as Error).message) });
      }
    }
    if (lines.length === 0) lines.push({ type: 'info', text: '실행할 SQL이 없어요' });
    lines.push({ type: 'info', text: '✓ 완료' });
    res.json({ lines });
  } finally {
    sdb.close();
  }
});

/** git push — 외부 GitHub 접근이 필요해 격리망에 못 둔다 → 명시적 게이트 */
router.post('/git', requireExecEnabled, async (req, res) => {
  const {
    remote,
    token,
    branch = 'main',
    message = 'exist에서 업로드',
    name = 'exist',
    email = 'exist@local',
    files,
  } = (req.body ?? {}) as {
    remote: string;
    token: string;
    branch?: string;
    message?: string;
    name?: string;
    email?: string;
    files: RunFile[];
  };
  if (
    typeof remote !== 'string' ||
    typeof token !== 'string' ||
    !remote ||
    !token ||
    !Array.isArray(files) ||
    files.some((f) => typeof f?.path !== 'string')
  ) {
    return res.status(400).json({ error: 'remote · token · files 필요' });
  }
  const lines: { type: string; text: string }[] = [];
  const redact = (s: string) => s.split(token).join('***');
  const authRemote = remote.replace(/^https:\/\//, `https://x-access-token:${token}@`);

  const dir = path.join(os.tmpdir(), 'exist-git-' + crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of files) {
      const safe = path.normalize(f.path).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(dir, safe);
      if (!full.startsWith(dir)) continue;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.content ?? '');
    }
    const steps = [
      `git init -b ${branch}`,
      `git config user.name "${name}"`,
      `git config user.email "${email}"`,
      `git add -A`,
      `git commit -m "${message.replace(/"/g, "'")}"`,
      `git remote add origin "${authRemote}"`,
      `git push -u origin ${branch} --force`,
    ];
    for (const step of steps) {
      const r = await runShell(step, dir);
      const out = (r.stdout + r.stderr).trim();
      if (out) lines.push({ type: r.code === 0 ? 'log' : 'error', text: redact(out) });
      if (r.code !== 0) {
        if (/not (found|recognized)|is not recognized/i.test(r.stderr)) {
          lines.push({ type: 'error', text: '서버 PC에 git 이 설치되어 있지 않아요.' });
        }
        lines.push({ type: 'error', text: `✗ 실패: ${redact(step)}` });
        return res.json({ lines });
      }
    }
    lines.push({ type: 'info', text: `✓ ${branch} 브랜치로 푸시 완료` });
    res.json({ lines });
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
});

export default router;
