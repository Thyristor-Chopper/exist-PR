import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 데이터 디렉터리 — 배포(Docker)에선 DATA_DIR 볼륨, 개발은 server/
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const db = new Database(path.join(DATA_DIR, 'exist.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT NOT NULL UNIQUE,
    pw_hash    TEXT NOT NULL,
    pw_salt    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS organizations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    join_code  TEXT NOT NULL UNIQUE,
    owner_id   INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  /* role: owner | admin | member   status: pending | active */
  CREATE TABLE IF NOT EXISTS organization_members (
    org_id     INTEGER NOT NULL REFERENCES organizations(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    role       TEXT NOT NULL DEFAULT 'member',
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (org_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL,
    host_id    INTEGER NOT NULL REFERENCES users(id),
    org_id     INTEGER REFERENCES organizations(id),
    starts_at  TEXT,
    ends_at    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_participants (
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (meeting_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS workspaces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 통합 메시지함: 유저별·그룹별 마지막 읽은 채팅 메시지 id (안읽음 = messages.id > last_read)
  CREATE TABLE IF NOT EXISTS chat_reads (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    last_read  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, meeting_id)
  );

  CREATE TABLE IF NOT EXISTS todos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    due_at     TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    from_name  TEXT NOT NULL,
    text       TEXT NOT NULL,
    kind       TEXT,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

  /* 회의별 일정 이벤트 — 달력에서 관리 (회의 참가자 공유) */
  CREATE TABLE IF NOT EXISTS meeting_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    title      TEXT NOT NULL,
    date       TEXT NOT NULL,
    time       TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mevents_meeting ON meeting_events(meeting_id, date);

  -- 일정 수신확인 — 결정 원장 회람 사인의 일정판 ("일정 잡힌 것 봤음" 서명)
  CREATE TABLE IF NOT EXISTS event_acks (
    event_id   INTEGER NOT NULL REFERENCES meeting_events(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (event_id, user_id)
  );
`);

// 마이그레이션: 복구 코드 컬럼 (기존 DB에 없으면 추가)
try {
  db.exec(`ALTER TABLE users ADD COLUMN recovery_hash TEXT`);
  db.exec(`ALTER TABLE users ADD COLUMN recovery_salt TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 마지막 접속 종료 시각 — P2 "놓친 것" 브리핑의 기준점
try {
  db.exec(`ALTER TABLE users ADD COLUMN last_seen_at TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 프로필 아바타 (이모지)
try {
  db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT '🐧'`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 표시 이름 (실명 등 — 아이디와 별개, null이면 아이디로 표시)
try {
  db.exec(`ALTER TABLE users ADD COLUMN name TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 계정 연락처 정보 (이메일·전화번호·주소)
try {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN address TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의 조직 소속 (기존 DB에 컬럼 없으면 추가, null = 개인 회의)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN org_id INTEGER REFERENCES organizations(id)`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 작업공간 조직 소속 — meetings.org_id와 같은 규약 (null = 만든 사람 개인)
try {
  db.exec(`ALTER TABLE workspaces ADD COLUMN org_id INTEGER REFERENCES organizations(id)`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 조직 멤버의 직급(position)·부서(department) — 한국 회사 조직도
try {
  db.exec(`ALTER TABLE organization_members ADD COLUMN position TEXT`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE organization_members ADD COLUMN department TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 커스텀 역할(IAM식) — 소유자가 권한 조합을 만들어 멤버에게 부여(중간관리자).
// perms = JSON 배열 (액션 키: member:approve | member:edit | member:remove), 스코프는 자기 부서
db.exec(`
  CREATE TABLE IF NOT EXISTS org_roles (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL REFERENCES organizations(id),
    name       TEXT NOT NULL,
    perms      TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
try {
  db.exec(`ALTER TABLE organization_members ADD COLUMN role_id INTEGER REFERENCES org_roles(id)`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 구 액션 키를 세분화된 키로 확장 (1회성 변환 — 새 키는 재확장되지 않음)
// member:edit → edit-position + edit-department, group:manage → group:* 전체
{
  const GROUP_ALL = [
    'group:lock',
    'group:settings',
    'group:edit-info',
    'group:edit-period',
    'group:schedule',
    'group:kick',
    'group:transfer',
    'group:delete',
    'group:channels',
    'group:files',
    'group:recap',
  ];
  const legacyRoles = db.prepare('SELECT id, perms FROM org_roles').all() as {
    id: number;
    perms: string;
  }[];
  for (const r of legacyRoles) {
    try {
      const perms = JSON.parse(r.perms) as string[];
      if (!perms.some((p) => p === 'member:edit' || p === 'group:manage')) continue;
      const next = new Set<string>();
      for (const p of perms) {
        if (p === 'member:edit') {
          next.add('member:edit-position');
          next.add('member:edit-department');
        } else if (p === 'group:manage') {
          for (const g of GROUP_ALL) next.add(g);
        } else next.add(p);
      }
      const encoded = JSON.stringify([...next]);
      if (encoded !== r.perms) db.prepare('UPDATE org_roles SET perms = ? WHERE id = ?').run(encoded, r.id);
    } catch {
      /* 손상된 perms는 그대로 둠 */
    }
  }
}

// 마이그레이션 v3 (1회 플래그) — 그룹 액션 세분: group:edit → edit-info+edit-period,
// group:settings 보유자에게 group:lock 부여(기존 의미 보존). 플래그 없이 돌리면
// 소유자가 나중에 lock만 빼도 재부팅마다 되살아나는 함정이 있어 meta로 1회만 실행
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'org_roles_v3'").get()) {
  const v3roles = db.prepare('SELECT id, perms FROM org_roles').all() as {
    id: number;
    perms: string;
  }[];
  for (const r of v3roles) {
    try {
      const perms = JSON.parse(r.perms) as string[];
      const next = new Set<string>();
      for (const p of perms) {
        if (p === 'group:edit') {
          next.add('group:edit-info');
          next.add('group:edit-period');
        } else {
          next.add(p);
          if (p === 'group:settings') next.add('group:lock');
        }
      }
      const encoded = JSON.stringify([...next]);
      if (encoded !== r.perms)
        db.prepare('UPDATE org_roles SET perms = ? WHERE id = ?').run(encoded, r.id);
    } catch {
      /* 손상 perms 무시 */
    }
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('org_roles_v3', '1')").run();
}

// 감사 로그(CloudTrail식) — 조직 인사·권한 변경의 책임 추적. text는 한국어 스냅샷
db.exec(`
  CREATE TABLE IF NOT EXISTS org_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER NOT NULL REFERENCES organizations(id),
    actor_id   INTEGER NOT NULL REFERENCES users(id),
    action     TEXT NOT NULL,
    target_id  INTEGER REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_org_audit ON org_audit(org_id, id DESC);
`);

// 마이그레이션: 채팅 첨부 파일 (JSON: {name,url,size}) — 없으면 추가
try {
  db.exec(`ALTER TABLE messages ADD COLUMN file TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의 설정/권한 (JSON: {locked,guestEdit,muteOnJoin})
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN settings TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 프로젝트 기간(선택) — 시작일/종료일 (날짜만, null이면 기간 없음)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN period_start TEXT`);
  db.exec(`ALTER TABLE meetings ADD COLUMN period_end TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 알림 "치우기"(보관) — 지워도 지난 알림에서 볼 수 있게 soft delete
try {
  db.exec(`ALTER TABLE notifications ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의 썸네일 사진 (없으면 그라디언트+첫글자 폴백)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN thumbnail TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 회의별 할 일 — todos.meeting_id (null이면 개인 todo, 값 있으면 회의 공유)
try {
  db.exec(`ALTER TABLE todos ADD COLUMN meeting_id INTEGER REFERENCES meetings(id)`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 할 일 다중 담당자 — 회의 할 일 전용 조인 테이블 (개인 todo는 user_id 소유 그대로)
db.exec(`
  CREATE TABLE IF NOT EXISTS todo_assignees (
    todo_id INTEGER NOT NULL REFERENCES todos(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (todo_id, user_id)
  )
`);
// 기존 회의 할 일의 user_id(단일 담당)를 담당자로 1회 백필 — meta 플래그로 재실행 방지
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'todo_assignees_v1'").get()) {
  db.exec(`INSERT OR IGNORE INTO todo_assignees (todo_id, user_id)
           SELECT id, user_id FROM todos WHERE meeting_id IS NOT NULL`);
  db.prepare("INSERT INTO meta (key, value) VALUES ('todo_assignees_v1', '1')").run();
}

// 마이그레이션: 회의 일정 이벤트 종료 시간 (통화 시작~종료 블록) — null이면 종료 시간 없음
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN end_time TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 일정 이벤트가 '통화'인지 — 1이면 10분 전 "통화 들어오세요" 알림
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN is_call INTEGER NOT NULL DEFAULT 0`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 일정 이벤트 관련자 — 참가자 id JSON 배열 (애플 캘린더 초대 느낌)
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN people TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 일정 이벤트 메모
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN memo TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 일정 알림 시점(분 전) — null=기본(30·10분), 0=알림 없음 (애플식 선택)
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN remind INTEGER`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 개별 일정 반복 — daily/weekly/biweekly/monthly (null=없음) + 종료일
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN recur TEXT`);
  db.exec(`ALTER TABLE meeting_events ADD COLUMN recur_until TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 일정 색 (#rrggbb, null=기본 초록/통화 파랑)
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN color TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 여러 날 걸친 일정 — 종료 날짜 (null=하루짜리)
try {
  db.exec(`ALTER TABLE meeting_events ADD COLUMN end_date TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 웹푸시 구독 (PWA) — 기기별 구독, endpoint가 기기 식별자
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    endpoint   TEXT NOT NULL UNIQUE,
    sub        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subs(user_id);
`);

// 마이그레이션: 알림이 어느 회의에서 왔는지 — meeting_code (null이면 회의 무관)
try {
  db.exec(`ALTER TABLE notifications ADD COLUMN meeting_code TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 반복 회의 — recur(none|daily|weekly|biweekly|monthly), recur_until(날짜, null=무한/없음)
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN recur TEXT NOT NULL DEFAULT 'none'`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN recur_until TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 반복 회의에서 제외한 특정 회차 날짜들 (JSON 배열 텍스트, 예: ["2026-06-17"])
try {
  db.exec(`ALTER TABLE meetings ADD COLUMN recur_except TEXT`);
} catch {
  /* 이미 존재 */
}

/* 1:1 다이렉트 메시지 (DM).
 * org_id로 스코프 — 조직이 다르면 별도 대화방. org_id NULL = 개인(조직 무관) DM.
 * read: 받는 사람(to_id) 기준 읽음 여부. */
db.exec(`
  CREATE TABLE IF NOT EXISTS dm_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id     INTEGER REFERENCES organizations(id),
    from_id    INTEGER NOT NULL REFERENCES users(id),
    to_id      INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    read       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  /* 두 사람의 대화를 시간순으로 뽑기 좋게 */
  CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(org_id, from_id, to_id, id);
  CREATE INDEX IF NOT EXISTS idx_dm_inbox ON dm_messages(org_id, to_id, read);
`);

/* 채팅 채널 — 그룹(회의) 안에 채널 여러 개. 기본 채널 "일반"은 첫 접근 시 자동 생성. */
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    name       TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_channels_meeting ON chat_channels(meeting_id, id);
`);

// 마이그레이션: 채널 종류 — 'call' = 통화 전용 채널 (통화 중 채팅이 기본 채널과 섞이지 않게 분리)
try {
  db.exec(`ALTER TABLE chat_channels ADD COLUMN kind TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 메시지의 소속 채널 (null = 레거시, 기본 채널 생성 시 백필됨)
try {
  db.exec(`ALTER TABLE messages ADD COLUMN channel_id INTEGER REFERENCES chat_channels(id)`);
} catch {
  /* 이미 존재 */
}

/* 공동편집 파일시스템 — 그룹 안에서 코드/문서/시트/발표 파일을 여러 개, 폴더로 정리.
 * room = Yjs 룸 이름 (새 파일은 file-{id}, 레거시 문서는 code-CODE 등을 그대로 흡수). */
db.exec(`
  CREATE TABLE IF NOT EXISTS collab_files (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    parent_id  INTEGER REFERENCES collab_files(id),
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    room       TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cfiles_meeting ON collab_files(meeting_id, parent_id);
`);

// 마이그레이션: 공동편집 휴지통 — 소프트 삭제 (deleted_root = 삭제 묶음의 루트 id)
try {
  db.exec(`ALTER TABLE collab_files ADD COLUMN deleted_at TEXT`);
  db.exec(`ALTER TABLE collab_files ADD COLUMN deleted_root INTEGER`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 업로드 파일 (type='file') — 원본 메타와 저장 경로
try {
  db.exec(`ALTER TABLE collab_files ADD COLUMN mime TEXT`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE collab_files ADD COLUMN size INTEGER`);
} catch {
  /* 이미 존재 */
}
try {
  db.exec(`ALTER TABLE collab_files ADD COLUMN blob_path TEXT`);
} catch {
  /* 이미 존재 */
}


/* 통화 음성 전사 — 각 참가자 브라우저의 STT(Web Speech) 결과.
 * recap·결정 원장·AI 총무의 근거로 채팅과 함께 쓰인다. */
db.exec(`
  CREATE TABLE IF NOT EXISTS call_transcripts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON call_transcripts(meeting_id, id);
`);

/* P1 — 회의 통화가 끝나면 AI가 채팅에서 결정·할 일을 추출해 저장하고
 * 참석자/불참자에게 라우팅한다. decisions/actions/attendees는 JSON 텍스트. */
db.exec(`
  CREATE TABLE IF NOT EXISTS meeting_recaps (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id    INTEGER NOT NULL REFERENCES meetings(id),
    summary       TEXT NOT NULL,
    decisions     TEXT NOT NULL DEFAULT '[]',
    actions       TEXT NOT NULL DEFAULT '[]',
    attendees     TEXT NOT NULL DEFAULT '[]',
    source        TEXT NOT NULL DEFAULT 'rule',
    call_ended_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recaps_meeting ON meeting_recaps(meeting_id, id);

  -- 결정 수신 확인 (회람 사인의 디지털화) — recap 안의 결정 idx 단위로 "확인했다"를 기록
  CREATE TABLE IF NOT EXISTS decision_acks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recap_id     INTEGER NOT NULL REFERENCES meeting_recaps(id),
    decision_idx INTEGER NOT NULL,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(recap_id, decision_idx, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_decision_acks ON decision_acks(recap_id, decision_idx);
`);

// 마이그레이션: recap의 다음 회의 제안 (JSON {title,date,time,registered?} 또는 null)
// — meeting_recaps CREATE 뒤에 있어야 새 DB에도 적용됨 (ALTER가 먼저면 조용히 스킵)
try {
  db.exec(`ALTER TABLE meeting_recaps ADD COLUMN next_meeting TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 결정 배경 — decisions와 인덱스로 정렬된 "왜 그렇게 됐는지" 한 줄 (JSON string[])
// 실무자 인터뷰 반영: 결정 내용은 남는데 배경·검토된 대안은 유실된다는 게 제조 현장의 실제 페인
try {
  db.exec(`ALTER TABLE meeting_recaps ADD COLUMN whys TEXT`);
} catch {
  /* 이미 존재 */
}

// 마이그레이션: 수신확인의 현장 피드백 한 줄 — "봤음"에 더해 "현장 상황 한 줄" (LIG 현직자 제안)
try {
  db.exec(`ALTER TABLE decision_acks ADD COLUMN note TEXT`);
} catch {
  /* 이미 존재 */
}

// 미확인 리마인드 발송 기록 — recap×사용자당 1회만 보챈다 (중복 알림 방지)
db.exec(`
  CREATE TABLE IF NOT EXISTS decision_remind_sent (
    recap_id  INTEGER NOT NULL REFERENCES meeting_recaps(id),
    user_id   INTEGER NOT NULL REFERENCES users(id),
    sent_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (recap_id, user_id)
  );
`);

// 마이그레이션: 개인 DM 지원 — 기존 테이블 org_id가 NOT NULL이면 NULL 허용으로 재생성
try {
  const col = db
    .prepare(`SELECT "notnull" AS nn FROM pragma_table_info('dm_messages') WHERE name = 'org_id'`)
    .get() as { nn: number } | undefined;
  if (col && col.nn === 1) {
    db.exec(`
      CREATE TABLE dm_messages_new (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        org_id     INTEGER REFERENCES organizations(id),
        from_id    INTEGER NOT NULL REFERENCES users(id),
        to_id      INTEGER NOT NULL REFERENCES users(id),
        text       TEXT NOT NULL,
        read       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO dm_messages_new (id, org_id, from_id, to_id, text, read, created_at)
        SELECT id, org_id, from_id, to_id, text, read, created_at FROM dm_messages;
      DROP TABLE dm_messages;
      ALTER TABLE dm_messages_new RENAME TO dm_messages;
      CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages(org_id, from_id, to_id, id);
      CREATE INDEX IF NOT EXISTS idx_dm_inbox ON dm_messages(org_id, to_id, read);
    `);
  }
} catch {
  /* 이미 nullable */
}

// 채널별 채팅 알림 설정 — all(다 받기) | mention(@나 멘션만, 기본) | off(끄기)
db.exec(`
  CREATE TABLE IF NOT EXISTS channel_notify_prefs (
    user_id    INTEGER NOT NULL REFERENCES users(id),
    channel_id INTEGER NOT NULL REFERENCES chat_channels(id),
    mode       TEXT NOT NULL DEFAULT 'mention',
    PRIMARY KEY (user_id, channel_id)
  )
`);

export default db;
