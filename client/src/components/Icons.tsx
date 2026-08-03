/** exist 공용 아이콘 — PDF 디자인의 검정 미니멀 스타일 (currentColor 상속) */

interface IconProps {
  size?: number;
}

function Svg({ size = 18, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function PhoneIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C10.61 21 3 13.39 3 4c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function ChatIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      {/* 뒤 말풍선 (받는 쪽) — 내부 채움은 --chat-icon-fill로 상태(통화 채팅 토글 등)를 따라감 */}
      <path
        d="M3 6.2A2.2 2.2 0 0 1 5.2 4h8.6A2.2 2.2 0 0 1 16 6.2v3.6A2.2 2.2 0 0 1 13.8 12H8l-3 2.6V12h-.8a1.2 1.2 0 0 1-1.2-1.2V6.2z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        fill="var(--chat-icon-fill, var(--surface))"
      />
      {/* 앞 말풍선 (보내는 쪽) — 겹쳐서 대화 느낌 */}
      <path
        d="M9 13.2A1.8 1.8 0 0 1 10.8 11.4h7.4A1.8 1.8 0 0 1 20 13.2v3A1.8 1.8 0 0 1 18.2 18H18v2.2L15.2 18h-4.4A1.8 1.8 0 0 1 9 16.2v-3z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
        fill="var(--chat-icon-fill, var(--surface))"
      />
    </Svg>
  );
}

export function CalendarIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.3" y="5" width="17.4" height="15.7" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.3 9.3h17.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 3v3.4M16 3v3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="8" cy="13" r="1.1" fill="currentColor" />
      <circle cx="12" cy="13" r="1.1" fill="currentColor" />
      <circle cx="16" cy="13" r="1.1" fill="currentColor" />
      <circle cx="8" cy="16.8" r="1.1" fill="currentColor" />
      <circle cx="12" cy="16.8" r="1.1" fill="currentColor" />
    </Svg>
  );
}

export function GearIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"
        fill="currentColor"
      />
    </Svg>
  );
}

export function LogOutIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 8.5 20 12l-3.5 3.5M20 12H9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function PinIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M8 3.3h8l-.8 1.5v5.4c2 .7 3.4 1.9 3.4 3H5.4c0-1.1 1.4-2.3 3.4-3V4.8z"
        fill="currentColor"
      />
      <path d="M12 13.2v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function ClockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function FolderIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M3.5 6.5c0-1.1.9-2 2-2h4l2 2.2h7c1.1 0 2 .9 2 2v9c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2v-11.2z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function HomeIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M4.2 11c0-.6.3-1.2.8-1.6l5.8-4.4a2 2 0 0 1 2.4 0l5.8 4.4c.5.4.8 1 .8 1.6v8a1.4 1.4 0 0 1-1.4 1.4H5.6A1.4 1.4 0 0 1 4.2 19z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.7 20.4v-6h4.6v6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** 체크마크만 (박스 없음) — 커스텀 체크박스 안에 넣는 용도 */
export function CheckMarkIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M5 12.5l4.2 4.2L19 6.5"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function CheckIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="4" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M7.5 12.2l3 3 6-6.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function LockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function UnlockIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 7.8-1.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function MicIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" fill="currentColor" />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M12 18v3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function CamIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.5" y="6" width="13" height="12" rx="2" fill="currentColor" />
      <path d="M16.5 11l5-3.8v9.6l-5-3.8v-2z" fill="currentColor" />
    </Svg>
  );
}

export function ScreenIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="2.5" y="4" width="19" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8.5 21h7M12 17.5V21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function ExpandIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M14 3h7v7M10 21H3v-7M21 3l-8 8M3 21l8-8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ShrinkIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function CloseIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function BuildingIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4" y="3" width="11" height="18" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M15 8h4a1.5 1.5 0 0 1 1.5 1.5V21" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path
        d="M7.5 7h4M7.5 10.5h4M7.5 14h4M17.5 11.5h.01M17.5 15h.01"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function UsersIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.2a5.5 5.5 0 0 1 3 5.3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** 사람 내보내기 — ×만 쓰면 "닫기"로 오독되어 사람 실루엣과 결합 */
export function UserXIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="10" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
      <path d="M3 20c0-3.3 3-5.5 7-5.5 1.2 0 2.3.2 3.2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M16.5 15.5l5 5M21.5 15.5l-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function SearchIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function MailIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M3 7l9 6 9-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronUpIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronLeftIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ChevronRightIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** 새로고침 원형 화살표 */
export function RefreshIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19.8 3.8v3.4h-3.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** 가위 — 잘라내기 */
export function ScissorsIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="6" cy="6.5" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="6" cy="17.5" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.3 8.2 20 19M8.3 15.8 20 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

/** 위아래 화살표 — 정렬 */
export function SortIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8 4.5v15M8 4.5 4.5 8M8 4.5 11.5 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 19.5v-15M16 19.5 12.5 16M16 19.5 19.5 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** 되돌리기 화살표 — 실행 취소 */
export function UndoIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7.5 5 4 8.5 7.5 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 8.5h10a6 6 0 0 1 0 12H9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

/** 별 — 즐겨찾기 */
export function StarIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="m12 3.6 2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.2 6.9 19l1.1-5.6L3.8 9.5l5.7-.7L12 3.6z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** 편지봉투 — 가입 대기·신청 */
/** 경고 삼각형 — 인사이트 리스크 등 */
export function AlertIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 4 21 19.6H3L12 4z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 10v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.9" r="1.05" fill="currentColor" />
    </Svg>
  );
}

/** 전구 — 추천·제안 */
export function BulbIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M12 3.2a6 6 0 0 1 3.6 10.8c-.8.6-1.1 1.3-1.1 2H9.5c0-.7-.3-1.4-1.1-2A6 6 0 0 1 12 3.2z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9.8 19h4.4M10.6 21.4h2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

/** 잎 — ESG·친환경 */
export function LeafIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M19.5 4.5C13 4.5 6.8 6.8 6.8 13.4c0 3.4 2.4 5.9 5.5 5.9 6.2 0 7.2-8.4 7.2-14.8z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M4.5 20.5c2.5-5 6-8.5 10-11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

/** 단일 사용자 — 개인 워크스페이스 */
export function UserIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="8" r="3.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 20.5a7 7 0 0 1 14 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

/** 번개 — 빠른 시작 */
export function BoltIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M13.2 2.8 5.5 13.4h5l-1 7.8 7.9-10.9h-5l.8-7.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function PlusIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </Svg>
  );
}

export function GridIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" stroke="currentColor" strokeWidth="1.9" />
    </Svg>
  );
}

/** 이름 바꾸기 — Win11식: A가 든 상자 + 오른쪽을 관통하는 텍스트 커서(I-beam) */
export function RenameIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      {/* 상자 — 오른쪽 변은 커서가 지나가는 자리라 비움 */}
      <path
        d="M15.6 6.5H5.4Q3.2 6.5 3.2 8.7v6.6q0 2.2 2.2 2.2h10.2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        fill="none"
      />
      {/* A */}
      <path
        d="M6.8 14.4 9.2 8.6l2.4 5.8M7.7 12.5h3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* I-beam 커서 */}
      <path
        d="M18.6 4.8v14.4M16.9 4.8h3.4M16.9 19.2h3.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

export function FilterIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M4 5h16l-6.2 7.3V19l-3.6-1.8v-4.9L4 5z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function PenIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M14.5 5.5l4 4M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** @ 기호 — 채널 알림 '멘션만' 상태용 */
export function AtSignIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M16 12v1.6a2.4 2.4 0 0 0 4.8 0V12a8.8 8.8 0 1 0-3.4 6.95"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** 종 + 슬래시 — 채널 알림 '끔' 상태용 */
export function BellOffIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M18.5 9a6.5 6.5 0 0 0-13 0c0 6-2.5 7.5-2.5 7.5h18S18.5 15 18.5 9z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 20.5a2.3 2.3 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M4 3.5 20.5 20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

export function BellIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M18.5 9a6.5 6.5 0 0 0-13 0c0 6-2.5 7.5-2.5 7.5h18S18.5 15 18.5 9z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 20.5a2.3 2.3 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function PanelLeftIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M9 4.5v15" stroke="currentColor" strokeWidth="1.9" />
    </Svg>
  );
}

export function HistoryIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M3.5 8.5a9 9 0 1 1-1.2 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M3 4v4.5h4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8v4.2l2.8 1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function DocIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M6 3h8l4 4v14H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M13.5 3.2V7.5H18" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 12.5h6M9 16h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </Svg>
  );
}

export function SlideIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="5" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 20h8M12 17v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 9.5h7M7 12.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}

export function CopyIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="8" y="8" width="11" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4H7A3 3 0 0 0 4 7v6.5A2.5 2.5 0 0 0 6.5 16H8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function PlayIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M7 5.5l11 6.5-11 6.5z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </Svg>
  );
}

export function DownloadIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 4v10m0 0l-4-4m4 4l4-4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17.5v1a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </Svg>
  );
}

export function UploadIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 14V4m0 0L8 8m4-4l4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 17.5v1a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-1" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </Svg>
  );
}

export function SunIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5 5l1.8 1.8M17.2 17.2L19 19M19 5l-1.8 1.8M6.8 17.2L5 19" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

export function SparklesIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path
        d="M12 3l1.6 4.4c.2.55.45.8 1 1L19 10l-4.4 1.6c-.55.2-.8.45-1 1L12 17l-1.6-4.4c-.2-.55-.45-.8-1-1L5 10l4.4-1.6c.55-.2.8-.45 1-1L12 3z"
        fill="currentColor"
      />
      <path d="M19 14l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9z" fill="currentColor" />
    </Svg>
  );
}

export function MoonIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M20 13.5A8 8 0 1 1 10.5 4a6.3 6.3 0 0 0 9.5 9.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </Svg>
  );
}

export function SheetIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9 9.5v10M15 9.5v10" stroke="currentColor" strokeWidth="1.5" />
    </Svg>
  );
}

export function CodeIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M8.5 8.5L4 12l4.5 3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.5 8.5L20 12l-4.5 3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 5.5l-3 13" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </Svg>
  );
}

export function SlashIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}

export function ChartIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="4" y="11" width="4.2" height="8" rx="1.2" fill="currentColor" />
      <rect x="9.9" y="6" width="4.2" height="13" rx="1.2" fill="currentColor" />
      <rect x="15.8" y="9" width="4.2" height="10" rx="1.2" fill="currentColor" />
    </Svg>
  );
}

export function ListIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <circle cx="5" cy="7" r="1.4" fill="currentColor" />
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="5" cy="17" r="1.4" fill="currentColor" />
      <path d="M10 7h10M10 12h10M10 17h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  );
}

export function TrashIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M5 7h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M9.5 7V5.6c0-.9.7-1.6 1.6-1.6h1.8c.9 0 1.6.7 1.6 1.6V7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M6.7 7l.75 12.1c.05.9.8 1.6 1.7 1.6h5.7c.9 0 1.65-.7 1.7-1.6L17.3 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M10.2 10.8v5.6M13.8 10.8v5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}

export function ShareIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <path d="M12 3.5v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M8.5 6.8L12 3.3l3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 10.5H6.8c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h10.4c1.1 0 2-.9 2-2v-6c0-1.1-.9-2-2-2H16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ClipboardIcon({ size }: IconProps) {
  return (
    <Svg size={size}>
      <rect x="5.5" y="4.8" width="13" height="16.2" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M9.3 4.8v-.6c0-.8.6-1.4 1.4-1.4h2.6c.8 0 1.4.6 1.4 1.4v.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M9.3 11h5.4M9.3 14.6h5.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </Svg>
  );
}
