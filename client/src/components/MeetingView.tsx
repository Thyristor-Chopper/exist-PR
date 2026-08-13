import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Device } from 'mediasoup-client';
import type { Transport, Producer } from 'mediasoup-client/types';
import { getSocket, request } from '../lib/socket';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useDisplayName, displayNameOf } from '../names';
import Logo from './Logo';
import Avatar from './Avatar';
import MentionInput, { type MentionCandidate } from './MentionInput';
import { MicIcon, CamIcon, ScreenIcon, ChatIcon, SlashIcon, ExpandIcon, ShrinkIcon, LockIcon, UnlockIcon, ChevronIcon, ChevronUpIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CheckMarkIcon, GearIcon, PinIcon, UserXIcon } from './Icons';

interface RemotePeer {
  peerId: string;
  username: string;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
  screenTrack?: MediaStreamTrack;
  videoPaused?: boolean;
  /** 상대 마이크 음소거 (producer pause) — 이름표 옆 아이콘 표시용 */
  audioMuted?: boolean;
}

interface ProducerInfo {
  producerId: string;
  peerId: string;
  username: string;
  kind: 'audio' | 'video';
  source?: string;
  /** 입장 시점의 pause 상태 — 늦게 들어와도 음소거·카메라 꺼짐 반영 */
  paused?: boolean;
}

export interface ChatFile {
  name: string;
  /** 다운로드 경로 — 공동편집 문서 카드(열기 전용)는 없음 */
  url?: string;
  size?: number;
  /** 공동편집 파일 id — 있으면 카드 클릭 = 그룹 탭→공동편집→해당 문서로 착지 */
  fileId?: number;
}
export interface ChatMessage {
  code?: string;
  /** 히스토리 조회에만 있음 (소켓 실시간 메시지엔 없음) */
  id?: number;
  from: string;
  avatar?: string | null;
  text: string;
  file?: ChatFile;
  /** 소속 채팅 채널 (없으면 기본 채널) */
  channelId?: number | null;
  ts: number;
  /** 히스토리 조회 시점 기준 안읽음 — "여기까지 읽었어요" 구분선용 */
  unread?: boolean;
}

/** 마이크 오디오 처리 제약 — 에코 제거·소음 억제·자동 게인.
 * 브라우저 대부분 기본 on이지만 deviceId를 지정하면 구현마다 기본값이 갈릴 수 있어 명시.
 * 에코(스피커→마이크 되돌이)가 한국어 STT를 제일 많이 깨뜨린다 */
const MIC_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
} as const;

/** 선택한 장치 우선 getUserMedia — 선택 장치가 뽑혔거나 못 잡으면 기본 장치로 재시도 */
async function getUserMediaPreferred(camId: string, micId: string): Promise<MediaStream> {
  const prefer: MediaStreamConstraints = {
    video: camId ? { deviceId: { exact: camId } } : true,
    audio: micId ? { deviceId: { exact: micId }, ...MIC_PROCESSING } : { ...MIC_PROCESSING },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(prefer);
  } catch (err) {
    if (!camId && !micId) throw err;
    return navigator.mediaDevices.getUserMedia({ video: true, audio: { ...MIC_PROCESSING } });
  }
}

/** 카메라가 없을 때 쓰는 캔버스 기반 가짜 비디오 (개발·데모용) */
function makeFallbackStream(label: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(2);
  const track = stream.getVideoTracks()[0];
  const timer = setInterval(() => {
    // 통화가 끝나 트랙이 정지되면 그리기도 멈춘다 (기존엔 clearInterval이 없어 호출마다 영구 누수)
    if (!track || track.readyState === 'ended') {
      clearInterval(timer);
      return;
    }
    ctx.fillStyle = '#1c1f26';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2db400';
    ctx.font = 'bold 48px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, canvas.width / 2, canvas.height / 2 - 10);
    ctx.fillStyle = '#888';
    ctx.font = '20px sans-serif';
    ctx.fillText(new Date().toLocaleTimeString('ko-KR'), canvas.width / 2, canvas.height / 2 + 40);
  }, 500);
  return stream;
}

function VideoTile({
  track,
  username,
  avatar,
  isLocal,
  isScreen,
  paused,
  micMuted,
  speaking,
  onKick,
  onPress,
}: {
  track?: MediaStreamTrack;
  username: string;
  /** 프로필 아바타 (이모지/사진) — 카메라 꺼짐 자리에 표시 */
  avatar?: string | null;
  isLocal?: boolean;
  isScreen?: boolean;
  paused?: boolean;
  /** 마이크 음소거 — 이름표 옆 아이콘 */
  micMuted?: boolean;
  /** 말하는 중 — 초록 링 (자막 신호 기반) */
  speaking?: boolean;
  onKick?: () => void;
  /** 타일 탭 — 핀 토글 */
  onPress?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const showVideo = !!track && !paused;
  // 화면공유 실비율 — 타일을 콘텐츠 비율에 맞춰 레터박스 없이 (창 리사이즈도 추적)
  const [mediaRatio, setMediaRatio] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !isScreen || !showVideo) {
      setMediaRatio(null);
      return;
    }
    const upd = () => {
      if (el.videoWidth && el.videoHeight) setMediaRatio(el.videoWidth / el.videoHeight);
    };
    el.addEventListener('loadedmetadata', upd);
    el.addEventListener('resize', upd);
    upd();
    return () => {
      el.removeEventListener('loadedmetadata', upd);
      el.removeEventListener('resize', upd);
    };
  }, [track, isScreen, showVideo]);
  // RTP가 끊기면 브라우저는 트랙을 mute시키고 <video>는 마지막 프레임에 얼어붙는다
  // — 얼어 보이는 대신 수신 대기 상태를 표시 (원격 트랙만)
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!track || isLocal) {
      setStalled(false);
      return;
    }
    setStalled(track.muted);
    const onMute = () => setStalled(true);
    const onUnmute = () => setStalled(false);
    track.addEventListener('mute', onMute);
    track.addEventListener('unmute', onUnmute);
    track.addEventListener('ended', onMute);
    return () => {
      track.removeEventListener('mute', onMute);
      track.removeEventListener('unmute', onUnmute);
      track.removeEventListener('ended', onMute);
    };
  }, [track, isLocal]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track || !showVideo) return;
    el.srcObject = new MediaStream([track]);
    // 모바일은 자동재생이 거부될 수 있음(NotAllowedError) — 다음 사용자 터치에서 1회 재시도
    const retry = () => void el.play().catch(() => {});
    void el.play().catch(() => {
      window.addEventListener('pointerdown', retry, { once: true, capture: true });
    });
    return () => window.removeEventListener('pointerdown', retry, true);
  }, [track, showVideo]);
  return (
    <div
      className={`video-tile${isScreen ? ' screen' : ''}${speaking && !isScreen ? ' speaking' : ''}${onPress ? ' pressable' : ''}`}
      style={isScreen && mediaRatio ? { aspectRatio: `${mediaRatio}` } : undefined}
      onClick={onPress}
    >
      {showVideo ? (
        <>
          {/* 소리는 AudioSink가 담당 — 비디오는 항상 muted (모바일 자동재생 정책: unmuted면 play 거부) */}
          <video ref={ref} autoPlay playsInline muted />
          {stalled && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,.45)',
                color: '#fff',
                fontSize: '.8rem',
              }}
            >
              화면 수신 대기 중…
            </div>
          )}
        </>
      ) : (
        <div className="video-placeholder">
          {/* 프로필 아바타만 — "카메라 꺼짐" 텍스트는 이름표 아이콘과 중복이라 뺌 (3사 관례) */}
          <Avatar value={avatar} className="video-avatar" />
        </div>
      )}
      <span className="video-name">
        {isScreen && (
          <span className="tile-screen-ic" title="화면 공유" aria-hidden>
            <ScreenIcon size={11} />
          </span>
        )}
        {username}
        {isLocal && ' (나)'}
        {micMuted && !isScreen && (
          <span className="tile-off-ic" title="마이크 꺼짐">
            <MicIcon size={11} />
            <SlashIcon size={11} />
          </span>
        )}
        {paused && !isScreen && (
          <span className="tile-off-ic" title="카메라 꺼짐">
            <CamIcon size={11} />
            <SlashIcon size={11} />
          </span>
        )}
      </span>
      {/* 핀 힌트 — 마우스 hover에서만 (클릭=확대 가능함을 알림) */}
      {onPress && !isScreen && (
        <span className="tile-pin-hint" aria-hidden>
          <PinIcon size={13} />
        </span>
      )}
      {onKick && (
        <button
          className="kick-btn"
          title="강퇴"
          onClick={(e) => {
            e.stopPropagation(); // 타일 탭(핀)과 분리
            onKick();
          }}
        >
          내보내기
        </button>
      )}
    </div>
  );
}

function AudioSink({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    // 모바일에서 오디오 자동재생이 거부되면 다음 터치에서 1회 재시도
    const retry = () => void el.play().catch(() => {});
    void el.play().catch(() => {
      window.addEventListener('pointerdown', retry, { once: true, capture: true });
    });
    return () => window.removeEventListener('pointerdown', retry, true);
  }, [track]);
  return <audio ref={ref} autoPlay />;
}

interface MeetingViewProps {
  code: string;
  /** 대시보드 탭 안에 임베드된 모드 (확대/축소 버튼 표시, 로고 숨김) */
  embedded?: boolean;
  /** 오버레이 전체화면 상태 (연결 유지한 채 확대) */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 나가기/강퇴 시 호출 — embedded면 탭 닫기, 전체화면이면 대시보드 이동 */
  onLeave: (message?: string) => void;
  /** 프리뷰에서 '입장하기'로 통화 시작 시 호출 */
  onJoined?: () => void;
  /** 현재 통화 중인 사람 이름 (프리뷰에 표시) */
  onlinePeers?: string[];
  /** username → 아바타 — 프리뷰 접속자 스택용 (허브가 참가자 명단에서 내려줌) */
  peerAvatars?: Record<string, string | null>;
  /** 채팅 @멘션 후보 — 허브가 회의 전체 명단을 내려줌 (없으면 통화 피어로 폴백) */
  mentionCandidates?: MentionCandidate[];
}

export default function MeetingView({
  code,
  embedded = false,
  expanded = false,
  onToggleExpand,
  onLeave,
  onJoined,
  onlinePeers = [],
  peerAvatars,
  mentionCandidates,
}: MeetingViewProps) {
  const rtcSupported = (typeof RTCPeerConnection !== 'undefined' && navigator.mediaDevices);

  const user = useAuthStore((s) => s.user);
  const dn = useDisplayName();

  const [status, setStatus] = useState('연결 중…');
  const [title, setTitle] = useState('');
  const [localTrack, setLocalTrack] = useState<MediaStreamTrack>();
  const [localScreen, setLocalScreen] = useState<MediaStreamTrack>();
  const [remotePeers, setRemotePeers] = useState<Map<string, RemotePeer>>(new Map());
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  // 입력 장치 선택 — 마이크·카메라가 여러 개일 때. ''는 브라우저 기본 장치
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(() => localStorage.getItem('exist:mic-device') ?? '');
  const [camId, setCamId] = useState(() => localStorage.getItem('exist:cam-device') ?? '');
  const [devMenu, setDevMenu] = useState<'mic' | 'cam' | 'opts' | 'people' | null>(null); // 장치 선택 + 통화 설정 + 참가자 패널
  const [pplQ, setPplQ] = useState(''); // 참가자 패널 검색 (인원 많을 때)
  // hover로도 패널 열림 — 패널로 마우스를 옮기는 사이 닫히지 않게 200ms 유예
  const [pplHover, setPplHover] = useState(false);
  const pplHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    devMenuOpenRef.current = devMenu != null;
  }, [devMenu]);
  const micIdRef = useRef(micId);
  micIdRef.current = micId;
  const camIdRef = useRef(camId);
  camIdRef.current = camId;
  const [phase, setPhase] = useState<'preview' | 'live'>('preview');
  const [previewTrack, setPreviewTrack] = useState<MediaStreamTrack>();
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  // @AI 답변 준비 중 표시 (통화 채팅) — AI 메시지 도착·타임아웃 시 해제
  const [aiThinking, setAiThinking] = useState(false);
  const aiThinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chatInput, setChatInput] = useState('');
  const [unread, setUnread] = useState(0);
  const [isHost, setIsHost] = useState(false);
  const [locked, setLocked] = useState(false);
  // 음성 전사(STT) — 내 발화를 브라우저가 전사해 서버로 (recap·결정 원장·AI 총무 근거)
  const [sttOn, setSttOn] = useState(true);
  // 발화자별 자막 — 여러 명이 동시에 말하면 줄로 쌓아서 함께 표시 (최근 발화 순)
  const [captions, setCaptions] = useState<
    Record<string, { text: string; interim?: boolean; ts: number }>
  >({});
  // 발화자 하이라이트 — 자막(voice:caption) 신호 재활용, 마지막 발화 후 2.2초 유지
  const [speaking, setSpeaking] = useState<Record<string, true>>({});
  const speakingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const markSpeaking = (username: string) => {
    if (!username) return;
    setSpeaking((prev) => (prev[username] ? prev : { ...prev, [username]: true }));
    const old = speakingTimers.current.get(username);
    if (old) clearTimeout(old);
    speakingTimers.current.set(
      username,
      setTimeout(
        () =>
          setSpeaking((prev) => {
            const next = { ...prev };
            delete next[username];
            return next;
          }),
        2200,
      ),
    );
  };
  // 탭 핀 — 타일을 누르면 그 사람을 무대에 크게 (화면공유 중엔 비활성)
  const [pinned, setPinned] = useState<string | null>(null);
  // ── 페이지네이션(줌 방식) — 1000명이어도 화면엔 한 페이지만 렌더, 오디오는 전원 유지 ──
  const [vw, setVw] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [page, setPage] = useState(0);

  // ── 계산 배치(768px+) — 3사 방식: 인원·컨테이너 크기로 타일 폭을 계산해 잘림 없이 배치 ──
  const [gridSize, setGridSize] = useState({ w: 0, h: 0 });
  const gridRoRef = useRef<ResizeObserver | null>(null);
  // 콜백 ref — 페이지 전환 애니메이션이 key 리마운트를 쓰므로 새 노드마다 observer 재부착
  const gridRefCb = useCallback((el: HTMLDivElement | null) => {
    gridRoRef.current?.disconnect();
    gridRoRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setGridSize((prev) =>
        Math.abs(prev.w - r.width) > 2 || Math.abs(prev.h - r.height) > 2
          ? { w: r.width, h: r.height }
          : prev,
      );
    });
    ro.observe(el);
    gridRoRef.current = ro;
  }, []);
  // 페이지 전환 방향 — 리마운트 시 이 방향으로 슬라이드 인
  const [slideDir, setSlideDir] = useState<'next' | 'prev'>('next');

  /** 미트식 동적 페이지 상한 — 가용 크기에 "최소 타일(160×120)"이 몇 개 들어가는가. 안전핀 49 */
  const MIN_TILE_W = 160;
  const MIN_TILE_H = 120;
  const pageCap = gridSize.w
    ? Math.max(
        2,
        Math.min(
          49,
          Math.max(1, Math.floor(gridSize.w / MIN_TILE_W)) *
            Math.max(1, Math.floor(gridSize.h / MIN_TILE_H)),
        ),
      )
    : 12;

  /** 미트식 채움형 배치 — n명을 꽉 채울 때 타일 비율이 16:9에 가장 가까워지는 열×행 */
  function computeGridShape(W: number, H: number, n: number): { cols: number; rows: number } {
    if (!W || !H || n <= 1) return { cols: 1, rows: 1 };
    let best = { cols: 1, rows: n };
    let bestScore = Infinity;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const ratio = W / cols / (H / rows);
      const score = Math.abs(Math.log(ratio / (16 / 9)));
      if (score < bestScore) {
        bestScore = score;
        best = { cols, rows };
      }
    }
    return best;
  }
  // 발화자 자동 무대 — 최근 원격 발화자를 자동 핀 (수동 핀하면 꺼짐, 줌 스피커 뷰)
  const [autoStage, setAutoStage] = useState(false);
  const [lastRemoteSpeaker, setLastRemoteSpeaker] = useState<string | null>(null);
  // 모바일 컨트롤 자동 숨김 — 탭으로 표시/숨김, 표시 후 4초 뒤 자동 숨김 (3사 공통 문법)
  const [ctlHidden, setCtlHidden] = useState(false);
  const ctlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobileView = () => window.matchMedia('(max-width: 767px)').matches;
  const devMenuOpenRef = useRef(false); // 메뉴 열림 중엔 자동 숨김 보류
  const ctlJustShown = useRef(false); // 터치로 방금 표시됨 — 이어지는 click이 도로 숨기지 않게
  const areaTouchY = useRef<number | null>(null); // 아래 스와이프 = 툴바 숨김 감지용
  const areaTouchX = useRef<number | null>(null); // 좌우 스와이프 = 페이지 넘김 (모바일)
  // 컨트롤 항상 표시(자동 숨김 끔) — ⚙ 설정, 기기별 저장
  const [ctlAlways, setCtlAlways] = useState(() => localStorage.getItem('call:ctlAlways') === '1');
  const ctlAlwaysRef = useRef(ctlAlways);
  ctlAlwaysRef.current = ctlAlways;
  /** 자동 숨김 대상인가 — 모바일 전부 + 데스크톱은 전체화면일 때만. "항상 표시" 설정이 우선 */
  const shouldAutoHide = () => !ctlAlwaysRef.current && (isMobileView() || !!expanded);
  const bumpControls = () => {
    setCtlHidden(false);
    if (ctlTimer.current) clearTimeout(ctlTimer.current);
    if (shouldAutoHide())
      ctlTimer.current = setTimeout(function hide() {
        if (devMenuOpenRef.current) {
          ctlTimer.current = setTimeout(hide, 2000);
          return;
        }
        setCtlHidden(true);
      }, 4000);
  };
  const lastMouseBump = useRef(0);

  const producersRef = useRef<{
    audio?: Producer;
    video?: Producer;
    screen?: Producer;
  }>({});
  const sendTransportRef = useRef<Transport | null>(null);
  const consumerMapRef = useRef<Map<string, { peerId: string; kind: string; source: string }>>(
    new Map(),
  );
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;
  const callChannelRef = useRef<number | null>(null); // 통화 패널이 고정될 통화 전용 채널
  const [callChannelName, setCallChannelName] = useState('통화'); // 표시용 — 허브에서 이름 바꿀 수 있음

  // 통화 채팅 패널 열람 presence — 열려 있는 동안 이 그룹 채팅 알림 생략 (허브 채팅 탭과 동일 규약)
  useEffect(() => {
    if (!chatOpen) return;
    const socket = getSocket();
    socket.emit('chat:viewing', { code });
    return () => {
      socket.emit('chat:viewing', { code: null });
    };
  }, [chatOpen, code]);

  // 채팅 패널을 열 때마다 채널 이름 재조회 — 통화 중에 허브 채팅 탭에서 이름을 바꿔도 반영
  useEffect(() => {
    if (!chatOpen) return;
    void api<{ id: number; name: string }>(`/api/meetings/${code}/channels/call`)
      .then((ch) => {
        callChannelRef.current = ch.id;
        setCallChannelName(ch.name);
      })
      .catch(() => {});
  }, [chatOpen, code]);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  // SpeechRecognition 인스턴스 — 크롬 계열만 지원, 없으면 STT 기능 숨김
  const sttRef = useRef<{ stop(): void; start(): void } | null>(null);
  const sttWantedRef = useRef(true); // onend 자동 재시작 여부 (침묵으로 자주 끊기므로)
  const captionTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 소켓이 순간 끊겼다 붙으면 서버는 이미 이 피어의 transport를 전부 파괴한 뒤다
  // — 재입장 외에 복구 방법이 없으므로, 재연결 시 이 값을 올려 통화 이펙트를 처음부터 다시 돈다
  const [rejoinTick, setRejoinTick] = useState(0);
  const sttSupported =
    typeof window !== 'undefined' &&
    !!(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatOpen, aiThinking]);

  // 장치 목록 — 권한 허용 후에야 label이 채워지므로 프리뷰 스트림을 잡은 뒤 다시 조회
  const refreshDevices = useCallback(() => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((ds) => {
        setMics(ds.filter((d) => d.kind === 'audioinput'));
        setCams(ds.filter((d) => d.kind === 'videoinput'));
      })
      .catch(() => {});
  }, []);
  if(rtcSupported)
    useEffect(() => {
      refreshDevices();
      navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);
      return () => navigator.mediaDevices.removeEventListener?.('devicechange', refreshDevices);
    }, [refreshDevices]);

  // 입장 전 디바이스 프리뷰 — 로컬 미리보기만(서버로 송출하지 않음). 장치를 바꾸면 다시 잡는다
  useEffect(() => {
    if (phase !== 'preview') return;
    let stream: MediaStream | null = null;
    let closed = false;
    getUserMediaPreferred(camId, micId)
      .then((s) => {
        if (closed) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setPreviewTrack(s.getVideoTracks()[0]);
        refreshDevices();
      })
      .catch(() => setPreviewTrack(undefined));
    return () => {
      closed = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [phase, camId, micId, refreshDevices]);

  useEffect(() => {
    if (!code || phase !== 'live') return;
    const socket = getSocket();
    let recvTransport: Transport | null = null;
    let localStream: MediaStream | null = null;
    let closed = false;

    const onReconnect = () => {
      if (closed) return;
      setStatus('연결이 끊겨 다시 연결 중…');
      setRejoinTick((t) => t + 1);
    };
    socket.io.on('reconnect', onReconnect);

    function upsertPeer(
      peerId: string,
      username: string,
      patch?: Partial<
        Pick<RemotePeer, 'videoTrack' | 'audioTrack' | 'screenTrack' | 'videoPaused' | 'audioMuted'>
      >,
    ) {
      setRemotePeers((prev) => {
        const next = new Map(prev);
        const p = next.get(peerId) ?? { peerId, username };
        next.set(peerId, { ...p, username, ...patch });
        return next;
      });
    }

    async function consume(device: Device, info: ProducerInfo) {
      if (!recvTransport) return;
      if (consumerMapRef.current.has(info.producerId)) return; // 중복 consume 방지 (큐 드레인과 실시간 이벤트 경합)
      const params = await request<{
        id: string;
        producerId: string;
        kind: 'audio' | 'video';
        rtpParameters: import('mediasoup-client/types').RtpParameters;
      }>(socket, 'consume', {
        transportId: recvTransport.id,
        producerId: info.producerId,
        rtpCapabilities: device.rtpCapabilities,
      });
      const consumer = await recvTransport.consume(params);
      await request(socket, 'consumer:resume', { consumerId: consumer.id });
      const source = info.source ?? 'camera';
      consumerMapRef.current.set(info.producerId, {
        peerId: info.peerId,
        kind: info.kind,
        source,
      });
      if (info.kind === 'audio') {
        upsertPeer(info.peerId, info.username, {
          audioTrack: consumer.track,
          audioMuted: !!info.paused,
        });
      } else if (source === 'screen') {
        upsertPeer(info.peerId, info.username, { screenTrack: consumer.track });
      } else {
        upsertPeer(info.peerId, info.username, {
          videoTrack: consumer.track,
          videoPaused: !!info.paused,
        });
      }
    }

    async function run() {
      // 재입장(재연결) 대비 — 이전 세션의 원격 트랙·컨슈머 맵을 비우고 시작
      setRemotePeers(new Map());
      consumerMapRef.current.clear();

      // 0. 회의 참여 등록 (코드 = 입장 권한) + 제목 표시
      const meeting = await api<{ title: string }>('/api/meetings/join', {
        method: 'POST',
        body: { code },
      });
      setTitle(meeting.title);

      // 채팅: 통화 전용 채널("화상회의") 확보 → 그 채널 히스토리 로드 + 채팅 룸 구독
      // 통화 중 패널은 통화 채널에 고정 — 기본 채널과 안 섞이고, 허브 채팅 탭의 화상회의 채널과 연동
      void api<{ id: number; name: string }>(`/api/meetings/${code}/channels/call`)
        .then((ch) => {
          if (closed) return;
          callChannelRef.current = ch.id;
          setCallChannelName(ch.name);
          return api<ChatMessage[]>(`/api/meetings/${code}/messages?channel=${ch.id}`).then(
            (history) => {
              if (!closed) setMessages(history);
            },
          );
        })
        .catch(() => {});
      void request(socket, 'chat:join', { code }).catch(() => {});

      // 1. SFU 방 입장
      const joined = await request<{
        rtpCapabilities: import('mediasoup-client/types').RtpCapabilities;
        producers: ProducerInfo[];
        peers: { peerId: string; username: string }[];
        isHost: boolean;
        locked: boolean;
      }>(socket, 'room:join', { code });
      setIsHost(joined.isHost);
      setLocked(joined.locked);

      // producer:new는 방에 든 직후부터 수신 — 준비(transport·초기 consume) 전에 도착한 것은
      // 큐에 모았다가 나중에 소비 (기존엔 초기 consume 루프 뒤에 등록해서, getUserMedia 대기
      // ~수 초 동안 생긴 producer를 영영 놓쳐 상대 화면이 안 붙었음)
      let dev: Device | null = null;
      let consumeReady = false;
      const pendingProducers: ProducerInfo[] = [];
      socket.on('producer:new', (info: ProducerInfo) => {
        if (!consumeReady || !dev) pendingProducers.push(info);
        else void consume(dev, info).catch(() => {});
      });

      // 2. Device 로드
      const device = new Device();
      await device.load({ routerRtpCapabilities: joined.rtpCapabilities });
      dev = device;

      // 3. 송신 transport
      const sendParams = await request<{
        id: string;
        iceParameters: import('mediasoup-client/types').IceParameters;
        iceCandidates: import('mediasoup-client/types').IceCandidate[];
        dtlsParameters: import('mediasoup-client/types').DtlsParameters;
      }>(socket, 'transport:create', {});
      const sendTransport = device.createSendTransport(sendParams);
      sendTransportRef.current = sendTransport;
      sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        request(socket, 'transport:connect', { transportId: sendTransport.id, dtlsParameters })
          .then(() => cb())
          .catch(eb);
      });
      sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb, eb) => {
        request<{ id: string }>(socket, 'produce', {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
          .then(({ id }) => cb({ id }))
          .catch(eb);
      });

      // 4. 수신 transport
      const recvParams = await request<typeof sendParams>(socket, 'transport:create', {});
      recvTransport = device.createRecvTransport(recvParams);
      recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
        request(socket, 'transport:connect', { transportId: recvTransport!.id, dtlsParameters })
          .then(() => cb())
          .catch(eb);
      });

      // 5. 로컬 미디어 (거부/부재/5초 무응답 시 캔버스 폴백)
      try {
        localStream = await Promise.race([
          getUserMediaPreferred(camIdRef.current, micIdRef.current),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('getUserMedia timeout')), 5000),
          ),
        ]);
      } catch {
        localStream = makeFallbackStream(displayNameOf(user?.username ?? 'me'));
        setStatus('카메라·마이크를 잡지 못했어요 — 데모 화면 송출 중 (다른 프로그램 점유 확인)');
      }
      if (closed) return;

      const videoTrack = localStream.getVideoTracks()[0];
      const audioTrack = localStream.getAudioTracks()[0];
      if (videoTrack) {
        setLocalTrack(videoTrack);
        const vp = await sendTransport.produce({
          track: videoTrack,
          appData: { source: 'camera' },
        });
        producersRef.current.video = vp;
        // 프리뷰에서 카메라를 끈 채 입장하면 즉시 일시정지(송출 안 함)
        if (!camOn) {
          vp.pause();
          void request(socket, 'producer:pause', { producerId: vp.id }).catch(() => {});
        }
      }
      if (audioTrack) {
        const ap = await sendTransport.produce({
          track: audioTrack,
          appData: { source: 'camera' },
        });
        producersRef.current.audio = ap;
        if (!micOn) {
          ap.pause();
          void request(socket, 'producer:pause', { producerId: ap.id }).catch(() => {});
        }
      }

      // 6. 기존 참가자 + producer consume — 한 명의 실패가 나머지 전체를 막지 않게 개별 격리
      for (const p of joined.peers) {
        if (p.peerId !== socket.id) upsertPeer(p.peerId, p.username);
      }
      for (const info of joined.producers) {
        try {
          await consume(device, info);
        } catch {
          /* 개별 consume 실패 무시 — 나머지 피어는 정상 표시 */
        }
      }
      // 준비되기 전에 도착해 큐에 쌓인 producer 소비
      consumeReady = true;
      for (const info of pendingProducers.splice(0)) {
        try {
          await consume(device, info);
        } catch {
          /* 개별 실패 무시 */
        }
      }

      // 7. 실시간 이벤트
      socket.on('peer:joined', ({ peerId, username }) => upsertPeer(peerId, username));
      socket.on('peer:left', ({ peerId }) => {
        // 이 피어의 컨슈머 매핑도 정리 — 같은 유저가 새 socket.id로 재참가할 때 옛 매핑 잔존 방지
        for (const [pid, meta] of consumerMapRef.current) {
          if (meta.peerId === peerId) consumerMapRef.current.delete(pid);
        }
        setRemotePeers((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      });
      socket.on('producer:closed', ({ producerId }: { producerId: string }) => {
        const meta = consumerMapRef.current.get(producerId);
        if (!meta) return;
        consumerMapRef.current.delete(producerId);
        setRemotePeers((prev) => {
          const next = new Map(prev);
          const p = next.get(meta.peerId);
          if (!p) return prev;
          if (meta.kind === 'audio') next.set(meta.peerId, { ...p, audioTrack: undefined });
          else if (meta.source === 'screen')
            next.set(meta.peerId, { ...p, screenTrack: undefined });
          else next.set(meta.peerId, { ...p, videoTrack: undefined });
          return next;
        });
      });
      // 상대 pause/resume — 비디오는 placeholder 전환, 오디오는 이름표 옆 음소거 아이콘
      const setPeerPaused = (producerId: string, paused: boolean) => {
        const meta = consumerMapRef.current.get(producerId);
        if (!meta) return;
        const patch: Partial<RemotePeer> | null =
          meta.kind === 'video' && meta.source === 'camera'
            ? { videoPaused: paused }
            : meta.kind === 'audio'
              ? { audioMuted: paused }
              : null;
        if (!patch) return;
        setRemotePeers((prev) => {
          const next = new Map(prev);
          const p = next.get(meta.peerId);
          if (p) next.set(meta.peerId, { ...p, ...patch });
          return next;
        });
      };
      socket.on('producer:paused', ({ producerId }: { producerId: string }) =>
        setPeerPaused(producerId, true),
      );
      socket.on('producer:resumed', ({ producerId }: { producerId: string }) =>
        setPeerPaused(producerId, false),
      );
      socket.on('chat:message', (msg: ChatMessage) => {
        if (msg.code && msg.code !== code.toUpperCase()) return; // 다른 회의 채팅 무시
        // 통화 패널은 통화 채널("화상회의") 고정 — 다른 채널 메시지는 허브 채팅 탭에서
        if (callChannelRef.current == null || msg.channelId !== callChannelRef.current) return;
        if (msg.from === 'exist AI') {
          setAiThinking(false);
          if (aiThinkingTimer.current) clearTimeout(aiThinkingTimer.current);
        }
        setMessages((prev) => [...prev, msg]);
        if (!chatOpenRef.current) setUnread((n) => n + 1);
      });
      socket.on('chat:ai-thinking', (p: { code?: string; channelId?: number | null } | undefined) => {
        if (p?.code && p.code !== code.toUpperCase()) return;
        if (callChannelRef.current == null || p?.channelId !== callChannelRef.current) return;
        setAiThinking(true);
        if (aiThinkingTimer.current) clearTimeout(aiThinkingTimer.current);
        aiThinkingTimer.current = setTimeout(() => setAiThinking(false), 45_000);
      });
      // 라이브 자막 — 발화자별로 쌓아서 동시 발화도 전부 표시. 만료 타이머는 발화자 단위
      socket.on(
        'voice:caption',
        ({ username, text, interim }: { username: string; text: string; interim?: boolean }) => {
          markSpeaking(username);
          if (username && username !== useAuthStore.getState().user?.username)
            setLastRemoteSpeaker(username);
          setCaptions((prev) => ({ ...prev, [username]: { text, interim, ts: Date.now() } }));
          const old = captionTimers.current.get(username);
          if (old) clearTimeout(old);
          // 미확정은 짧게(다음 갱신이 금방 옴), 확정은 읽을 시간 확보
          captionTimers.current.set(
            username,
            setTimeout(
              () =>
                setCaptions((prev) => {
                  const next = { ...prev };
                  delete next[username];
                  return next;
                }),
              interim ? 2500 : 4000,
            ),
          );
        },
      );
      // 자막 소급 수정 — 서버가 LLM 교정을 마치면 같은 줄이 아직 떠 있을 때만 교체 (미트식)
      socket.on(
        'voice:caption-fix',
        ({ username, orig, text }: { username: string; orig: string; text: string }) => {
          setCaptions((prev) => {
            const cur = prev[username];
            if (!cur || cur.interim || cur.text !== orig) return prev; // 이미 다음 발화로 넘어감
            return { ...prev, [username]: { ...cur, text } };
          });
        },
      );
      socket.on('room:locked', ({ locked }: { locked: boolean }) => setLocked(locked));
      socket.on('room:kicked', () => {
        onLeaveRef.current('호스트가 회의에서 내보냈습니다');
      });
      // 호스트 전체 음소거 — 내 마이크를 끄기만 함 (다시 켜는 건 자유, 3사 문법)
      socket.on('room:muted-by-host', ({ by }: { by: string }) => {
        const p = producersRef.current.audio;
        if (p && !p.paused) {
          p.pause();
          void request(socket, 'producer:pause', { producerId: p.id }).catch(() => {});
        }
        setMicOn(false);
        window.dispatchEvent(
          new CustomEvent('app:error', { detail: `호스트가 전체 음소거를 실행했어요 (${by})` }),
        );
      });

      setStatus('');
    }

    run().catch((err) => setStatus(`연결 실패: ${err.message}`));

    // 탭 닫기·모바일 백그라운드 이탈 — 소켓 타임아웃(수십 초)을 기다리지 않고 즉시 퇴장 신고.
    // pagehide는 모바일 사파리·PWA 백그라운드 전환에서도 발화한다
    const onPageHide = (e: PageTransitionEvent) => {
      // persisted=true는 bfcache 진입(뒤로가기 등으로 복귀 가능) — 통화를 끊지 않는다.
      // 진짜 닫기/이탈만 즉시 퇴장 신고
      if (e.persisted) return;
      try {
        socket.emit('room:leave');
      } catch {
        /* 이미 끊겼으면 무시 */
      }
    };
    window.addEventListener('pagehide', onPageHide);

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      closed = true;
      socket.io.off('reconnect', onReconnect);
      socket.off('peer:joined');
      socket.off('peer:left');
      socket.off('producer:new');
      socket.off('producer:closed');
      socket.off('producer:paused');
      socket.off('producer:resumed');
      socket.off('chat:message');
      socket.off('chat:ai-thinking');
      if (aiThinkingTimer.current) clearTimeout(aiThinkingTimer.current);
      socket.off('voice:caption');
      socket.off('voice:caption-fix');
      captionTimers.current.forEach((t) => clearTimeout(t));
      captionTimers.current.clear();
      speakingTimers.current.forEach((t) => clearTimeout(t));
      speakingTimers.current.clear();
      socket.off('room:locked');
      socket.off('room:kicked');
      socket.off('room:muted-by-host');
      sendTransportRef.current?.close();
      recvTransport?.close();
      localStream?.getTracks().forEach((t) => t.stop());
      // 통화 중 장치 교체(replaceTrack)로 갈아탄 트랙은 localStream 밖에 있다 — 같이 꺼야 캠 불이 꺼짐
      producersRef.current.audio?.track?.stop();
      producersRef.current.video?.track?.stop();
      producersRef.current = {}; // 재입장 시 죽은 producer 참조 잔존 방지
      // 공유 소켓을 disconnect하면 "내 퇴장" call:presence 방송을 나만 못 받아
      // 내 화면 갱신이 폴링(10초)으로 밀린다 — 방만 나가고 소켓은 유지 (채팅·알림도 계속 써야 함)
      try {
        socket.emit('room:leave');
      } catch {
        /* 이미 끊겼으면 무시 */
      }
    };
  }, [code, user?.username, phase, rejoinTick]);

  // ── 원음 녹음 — 회의 후 분석(recap·결정 추출)용. 자막(Web Speech)과 별개 트랙.
  // sttOn && micOn 동안 30초 청크로 잘라 서버에 올리면, 통화가 끝날 때 서버가
  // OpenAI로 재전사해 Web Speech보다 정확한 기록을 만든다 (stt.ts) ──
  useEffect(() => {
    if (phase !== 'live' || !micOn || !sttOn) return;
    const track = producersRef.current.audio?.track;
    if (!track || track.readyState !== 'live' || typeof MediaRecorder === 'undefined') return;
    const mime = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported?.(mime)) return;
    const token = useAuthStore.getState().token;
    let stopped = false;
    let rec: MediaRecorder | null = null;
    let timer: number | undefined;
    const stream = new MediaStream([track]);
    // 타임슬라이스 대신 30초마다 레코더를 새로 시작 — 청크마다 컨테이너 헤더가 붙어
    // 각 파일이 독립적으로 디코딩 가능해야 서버가 청크 단위로 전사할 수 있다
    const startOne = () => {
      if (stopped) return;
      const startTs = Date.now();
      let r: MediaRecorder;
      try {
        r = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 });
      } catch {
        return;
      }
      rec = r;
      r.ondataavailable = (e) => {
        if (e.data && e.data.size > 2000) {
          void fetch(`/api/meetings/${code}/stt/audio?ts=${startTs}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/webm' },
            body: e.data,
          }).catch(() => {
            /* 청크 하나 유실은 치명적이지 않음 */
          });
        }
      };
      r.onstop = () => {
        if (!stopped) startOne();
      };
      try {
        r.start();
      } catch {
        return;
      }
      timer = window.setTimeout(() => {
        try {
          r.stop();
        } catch {
          /* 이미 종료 */
        }
      }, 30_000);
    };
    startOne();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      try {
        rec?.stop(); // 마지막 조각 flush → ondataavailable에서 업로드 시도
      } catch {
        /* 이미 종료 */
      }
    };
  }, [phase, micOn, sttOn, code]);

  // ── 음성 전사(STT) — 통화 중 + 마이크 켜짐 + 자막 켜짐일 때 내 발화를 전사해 서버로 ──
  useEffect(() => {
    if (!sttSupported || phase !== 'live' || !micOn || !sttOn) {
      sttWantedRef.current = false;
      try {
        sttRef.current?.stop();
      } catch {
        /* 이미 종료 */
      }
      sttRef.current = null;
      return;
    }
    sttWantedRef.current = true;
    interface SttEvent {
      resultIndex: number;
      results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } };
    }
    interface Stt {
      lang: string;
      continuous: boolean;
      interimResults: boolean;
      onresult: ((e: SttEvent) => void) | null;
      onend: (() => void) | null;
      onerror: (() => void) | null;
      start(): void;
      stop(): void;
    }
    const W = window as unknown as { webkitSpeechRecognition: new () => Stt };
    const rec = new W.webkitSpeechRecognition();
    rec.lang = 'ko-KR';
    rec.continuous = true;
    // 중간 결과도 받아서 말하는 도중에 자막이 따라오게 (확정 대기 딜레이 제거)
    rec.interimResults = true;
    let lastInterim = 0;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) getSocket().emit('voice:transcript', { text }); // 확정본만 저장·기록
        } else {
          interim += r[0].transcript;
        }
      }
      interim = interim.trim();
      // 중간 자막은 저장 없이 브로드캐스트만 — 과호출 방지로 250ms 스로틀
      const nowMs = Date.now();
      if (interim && nowMs - lastInterim > 250) {
        lastInterim = nowMs;
        getSocket().emit('voice:interim', { text: interim });
      }
    };
    // 침묵·일시 오류로 자주 끊기므로 원할 때까지 자동 재시작
    rec.onend = () => {
      if (sttWantedRef.current) {
        try {
          rec.start();
        } catch {
          /* 연속 start 예외 무시 */
        }
      }
    };
    rec.onerror = () => {
      /* no-speech 등 — onend에서 재시작 */
    };
    try {
      rec.start();
    } catch {
      /* 미지원/권한 문제 — 조용히 포기 */
    }
    sttRef.current = rec;
    return () => {
      sttWantedRef.current = false;
      try {
        rec.stop();
      } catch {
        /* 이미 종료 */
      }
      sttRef.current = null;
    };
  }, [phase, micOn, sttOn, sttSupported]);

  function toggleMic() {
    const p = producersRef.current.audio;
    if (!p) {
      // 입장 시 장치를 못 잡아 폴백(데모 화면)으로 도는 상태 — 조용히 무시하지 않고 알림
      window.dispatchEvent(
        new CustomEvent('app:error', {
          detail: '마이크를 잡지 못했어요 — 다른 프로그램이 카메라·마이크를 쓰고 있는지 확인하고 다시 입장해주세요',
        }),
      );
      return;
    }
    const socket = getSocket();
    if (micOn) {
      p.pause();
      void request(socket, 'producer:pause', { producerId: p.id }).catch(() => {});
    } else {
      p.resume();
      void request(socket, 'producer:resume', { producerId: p.id }).catch(() => {});
    }
    setMicOn(!micOn);
  }

  function toggleCam() {
    const p = producersRef.current.video;
    if (!p) {
      window.dispatchEvent(
        new CustomEvent('app:error', {
          detail: '카메라를 잡지 못했어요 — 다른 프로그램이 카메라를 쓰고 있는지 확인하고 다시 입장해주세요',
        }),
      );
      return;
    }
    const socket = getSocket();
    if (camOn) {
      p.pause();
      void request(socket, 'producer:pause', { producerId: p.id }).catch(() => {});
    } else {
      p.resume();
      void request(socket, 'producer:resume', { producerId: p.id }).catch(() => {});
    }
    setCamOn(!camOn);
  }

  /** 장치 선택 — 프리뷰는 effect가 다시 잡고, 통화 중엔 producer 트랙을 교체(replaceTrack) */
  async function pickDevice(kind: 'mic' | 'cam', id: string) {
    if (kind === 'mic') {
      setMicId(id);
      localStorage.setItem('exist:mic-device', id);
    } else {
      setCamId(id);
      localStorage.setItem('exist:cam-device', id);
    }
    if (phase !== 'live') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'mic'
          ? { audio: id ? { deviceId: { exact: id }, ...MIC_PROCESSING } : { ...MIC_PROCESSING } }
          : { video: id ? { deviceId: { exact: id } } : true },
      );
      const track = kind === 'mic' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      const p = kind === 'mic' ? producersRef.current.audio : producersRef.current.video;
      if (!p || !track) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const old = p.track;
      await p.replaceTrack({ track });
      old?.stop();
      if (kind === 'cam') setLocalTrack(track);
    } catch {
      window.dispatchEvent(
        new CustomEvent('app:error', { detail: '장치를 바꾸지 못했어요 — 연결 상태를 확인해주세요' }),
      );
    }
  }

  const stopScreenShare = useCallback(() => {
    const p = producersRef.current.screen;
    if (!p) return;
    const socket = getSocket();
    void request(socket, 'producer:close', { producerId: p.id }).catch(() => {});
    p.close();
    producersRef.current.screen = undefined;
    setLocalScreen(undefined);
  }, []);

  async function toggleScreenShare() {
    if (producersRef.current.screen) {
      stopScreenShare();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = stream.getVideoTracks()[0];
      const producer = await sendTransportRef.current!.produce({
        track,
        appData: { source: 'screen' },
      });
      producersRef.current.screen = producer;
      setLocalScreen(track);
      // 브라우저 UI의 "공유 중지"로 끝났을 때도 정리
      track.addEventListener('ended', stopScreenShare);
    } catch {
      /* 사용자가 화면 선택 취소 — 무시 */
    }
  }

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    // 통화 채널이 아직 안 잡혔으면(입장 직후 찰나) 보류 — 기본 채널로 새는 것 방지
    if (callChannelRef.current == null) return;
    getSocket().emit('chat:send', { code, text: chatInput, channelId: callChannelRef.current });
    setChatInput('');
  }

  const peers = [...remotePeers.values()];

  // 장치 선택 메뉴 — 알약의 ˄가 연다. 현재 장치에 체크 표시.
  // align 'right'는 프리뷰처럼 앵커가 오른쪽 끝일 때 (화면 밖 삐져나감 방지)
  const renderDevMenu = (kind: 'mic' | 'cam', align: 'center' | 'right' = 'center') => {
    const list = kind === 'mic' ? mics : cams;
    const current = kind === 'mic' ? micId : camId;
    const noun = kind === 'mic' ? '마이크' : '카메라';
    return (
      <>
        <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={() => setDevMenu(null)} />
        <div className={`dev-menu${align === 'right' ? ' align-right' : ''}`}>
          <div className="dev-menu-title">{noun} 선택</div>
          {[{ deviceId: '', label: `기본 ${noun}` }, ...list].map((d, i) => {
            const active = current === d.deviceId;
            return (
              <button
                key={d.deviceId || `d${i}`}
                className={`dev-menu-item${active ? ' active' : ''}`}
                onClick={() => {
                  setDevMenu(null);
                  if (!active) void pickDevice(kind, d.deviceId);
                }}
              >
                <span className="dev-menu-check">{active && <CheckMarkIcon size={13} />}</span>
                <span className="dev-menu-label">{d.label || `${noun} ${i}`}</span>
              </button>
            );
          })}
        </div>
      </>
    );
  };

  // 입장 전 프리뷰용 알약 — 통화 중 컨트롤 바와 같은 형태 (토글 + ˄ 장치 메뉴)
  // 프리뷰 알약 — 테마 추종은 CSS(.pv-pill)가 담당 (다크=어두운 알약, 라이트=흰 알약, 꺼짐=빨강)
  const previewPill = (kind: 'mic' | 'cam') => {
    const on = kind === 'mic' ? micOn : camOn;
    const toggle = () => (kind === 'mic' ? setMicOn((v) => !v) : setCamOn((v) => !v));
    const noun = kind === 'mic' ? '마이크' : '카메라';
    const Icon = kind === 'mic' ? MicIcon : CamIcon;
    return (
      <div className={`pv-pill${on ? '' : ' off'}`}>
        <button className="pv-main" onClick={toggle} title={on ? `${noun} 끄기` : `${noun} 켜기`}>
          {/* 슬래시는 버튼이 아니라 아이콘 박스에 겹침 — 버튼 패딩과 무관하게 항상 아이콘 정중앙 */}
          <span className="pv-icon">
            <Icon size={20} />
            {!on && (
              <span className="pv-slash">
                <SlashIcon size={20} />
              </span>
            )}
          </span>
        </button>
        <button
          className="pv-arrow"
          onClick={() => setDevMenu((v) => (v === kind ? null : kind))}
          title={`${noun} 선택`}
        >
          <span className="pv-chev">
            <ChevronIcon size={12} />
          </span>
        </button>
        {devMenu === kind && renderDevMenu(kind, 'right')}
      </div>
    );
  };

  // 공유 중인 화면 전부 (로컬 + 원격 여러 명 동시 지원)
  const screens: { key: string; track: MediaStreamTrack; username: string; isLocal?: boolean }[] =
    [
      ...(localScreen
        ? [{ key: 'local', track: localScreen, username: user?.username ?? '나', isLocal: true }]
        : []),
      ...peers
        .filter((p) => p.screenTrack)
        .map((p) => ({ key: p.peerId, track: p.screenTrack!, username: p.username })),
    ];
  const hasScreen = screens.length > 0;

  // 페이지 슬라이스 — 0페이지 = 나 + (cap-1)명, 이후 페이지 = cap명씩
  const totalPages = Math.max(1, Math.ceil((peers.length + 1) / pageCap));
  const pageNow = Math.min(page, totalPages - 1);
  const pagedPeers =
    pageNow === 0
      ? peers.slice(0, pageCap - 1)
      : peers.slice(pageCap - 1 + (pageNow - 1) * pageCap, pageCap - 1 + pageNow * pageCap);
  const visibleCount = (pageNow === 0 ? 1 : 0) + pagedPeers.length;
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);

  // 필름스트립(핀·공유 무대) 페이지 — 스트립 폭에 들어가는 만큼씩 넘겨서 전원 확인 가능.
  // 핀 대상은 무대에 이미 크게 있으니 스트립에서 제외 (내가 핀이면 내 타일도 빠짐 — 3사 문법)
  const stripSelfShown = !pinned || pinned !== (user?.username ?? '');
  const stripPool = pinned ? peers.filter((p) => p.username !== pinned) : peers;
  const stripTileW = vw < 768 ? 160 : 220;
  const stripCap = Math.max(2, Math.floor((gridSize.w - 90) / (stripTileW + 10)));
  const stripTotal = Math.max(
    1,
    Math.ceil((stripPool.length + (stripSelfShown ? 1 : 0)) / stripCap),
  );
  const [stripPage, setStripPage] = useState(0);
  const stripNow = Math.min(stripPage, stripTotal - 1);
  const stripOff = stripSelfShown ? 1 : 0;
  const stripPeers =
    stripNow === 0
      ? stripPool.slice(0, stripCap - stripOff)
      : stripPool.slice(
          stripCap - stripOff + (stripNow - 1) * stripCap,
          stripCap - stripOff + stripNow * stripCap,
        );
  useEffect(() => {
    if (stripPage > stripTotal - 1) setStripPage(stripTotal - 1);
  }, [stripPage, stripTotal]);
  // 스트립 접기 — 무대에만 집중. 무대 모드를 벗어나면 원복
  const [stripHidden, setStripHidden] = useState(false);
  useEffect(() => {
    if (!hasScreen && !pinned) setStripHidden(false);
  }, [hasScreen, pinned]);

  // 핀 정리 — 화면공유가 시작되면 해제, 핀한 사람이 나가도 해제
  useEffect(() => {
    if (hasScreen) setPinned(null);
  }, [hasScreen]);
  useEffect(() => {
    if (!pinned) return;
    if (peers.length === 0) {
      setPinned(null); // 혼자 남으면 무대 해제 (자기 핀만 남는 상태 방지)
      return;
    }
    if (pinned !== (user?.username ?? '') && !peers.some((p) => p.username === pinned))
      setPinned(null);
  }, [peers, pinned, user]);

  // 발화자 자동 무대 — 켜져 있으면 최근 원격 발화자를 따라 핀 이동
  useEffect(() => {
    if (!autoStage || hasScreen || !lastRemoteSpeaker) return;
    if (peers.some((p) => p.username === lastRemoteSpeaker)) setPinned(lastRemoteSpeaker);
  }, [autoStage, lastRemoteSpeaker, hasScreen, peers]);


  // 입장·전체화면 전환 시 컨트롤 자동 숨김 타이머 (재)시작
  useEffect(() => {
    if (phase !== 'preview') bumpControls();
    return () => {
      if (ctlTimer.current) clearTimeout(ctlTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, expanded]);

  // 통화 경과 시간 — 내 입장 시점 기준 (헤더 표시)
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (phase === 'preview') return;
    const t0 = Date.now();
    setElapsed(0);
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [phase]);
  const fmtElapsed = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  // 안드로이드 셸(Capacitor): 통화 중이면 홈 이동 시 화면째 OS PiP — 네이티브에 상태 전달
  useEffect(() => {
    const pip = (
      window as unknown as {
        Capacitor?: { Plugins?: { CallPip?: { setCallActive: (o: { active: boolean }) => void } } };
      }
    ).Capacitor?.Plugins?.CallPip;
    if (!pip) return; // 일반 브라우저 — 해당 없음
    const active = phase !== 'preview';
    try {
      pip.setCallActive({ active });
    } catch {
      /* 브릿지 오류 무시 */
    }
    return () => {
      try {
        pip.setCallActive({ active: false });
      } catch {
        /* ignore */
      }
    };
  }, [phase]);

  // 입장 전 디바이스 프리뷰 게이트 (카메라/마이크 미리 확인 후 입장)
  if (phase === 'preview') {
    if(!rtcSupported)
      return (
        <div
          className={`meeting-room${embedded ? ' embedded' : ''}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            /* 배경은 .meeting-room 공통 규칙 — 라이트 테마 얕은 회색 포함 */
          }}
        >
          <div
            style={{
              background: 'var(--surface)',
              borderRadius: 16,
              padding: 24,
              width: 440,
              maxWidth: '92%',
              textAlign: 'center',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
            }}
          >
            <h2 style={{ margin: '0 0 4px', fontSize: 18, color: 'var(--text)' }}>
              {title || '회의'}에 입장
            </h2>
            <div style={{ fontSize: 12, color: 'var(--text-sub)', marginBottom: 6 }}>사용 중인 브라우저에서 WebRTC가 비활성화되어있거나 지원되지 않습니다.</div>
            <button
              onClick={() => onLeave?.('')}
              style={{
                width: '100%',
                padding: '12px 0',
                background: '#00000010',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontSize: 15,
                cursor: 'pointer',
              }}
            >
              취소
            </button>
          </div>
        </div>
      );

    return (
      <div
        className={`meeting-room${embedded ? ' embedded' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          /* 배경은 .meeting-room 공통 규칙 — 라이트 테마 얕은 회색 포함 */
        }}
      >
        <div
          style={{
            background: 'var(--surface)',
            borderRadius: 16,
            padding: 24,
            width: 440,
            maxWidth: '92%',
            textAlign: 'center',
            boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          }}
        >
          <h2 style={{ margin: '0 0 4px', fontSize: 18, color: 'var(--text)' }}>
            {title || '회의'}에 입장
          </h2>
          <div style={{ fontSize: 12, color: 'var(--text-sub)', marginBottom: 6 }}>코드 {code}</div>
          {onlinePeers.length > 0 ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                fontSize: 13,
                color: '#21C818',
                fontWeight: 700,
                marginBottom: 16,
              }}
            >
              <span>● {onlinePeers.length}명 통화 중</span>
              {/* 겹친 아바타 스택 + hover 전체 프로필 리스트 (공동편집 접속자와 동일 톤, 이름 우선) */}
              <span className="cf-presence">
                {onlinePeers.slice(0, 4).map((name) => (
                  <Avatar
                    key={name}
                    value={peerAvatars?.[name] ?? null}
                    className="cf-presence-avatar"
                  />
                ))}
                {onlinePeers.length > 4 && (
                  <span className="cf-presence-more">+{onlinePeers.length - 4}</span>
                )}
                <span className="hub-assign-tip cf-presence-tip" aria-hidden>
                  {onlinePeers.map((name) => (
                    <span key={name} className="hub-assign-tip-row">
                      <Avatar value={peerAvatars?.[name] ?? null} className="hub-assign-avatar" />
                      <span>{dn(name)}</span>
                    </span>
                  ))}
                </span>
              </span>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-sub)', marginBottom: 16 }}>
              아직 통화에 아무도 없어요 · 먼저 시작해보세요
            </div>
          )}
          <div
            style={{
              position: 'relative',
              width: '100%',
              aspectRatio: '16 / 9',
              marginBottom: 18,
            }}
          >
            {/* 라운드 클리핑은 비디오만 — 알약·장치 메뉴는 바깥이라 위로 열려도 안 잘림.
                radius는 안의 .video-tile(14px)과 일치 + 배경 투명 — 어긋나면 모서리에 검은 테 비침 */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 14,
                overflow: 'hidden',
              }}
            >
              <VideoTile
                track={previewTrack}
                username={dn(user?.username ?? '나')}
                avatar={peerAvatars?.[user?.username ?? ''] ?? user?.avatar ?? null}
                isLocal
                paused={!camOn}
                micMuted={!micOn}
              />
            </div>
            {/* 미리보기 위 통합 컨트롤 — 원형 토글 */}
            <div
              style={{
                position: 'absolute',
                bottom: 12,
                left: 0,
                right: 14,
                display: 'flex',
                gap: 12,
                justifyContent: 'flex-end',
                zIndex: 2,
              }}
            >
              {previewPill('mic')}
              {previewPill('cam')}
            </div>
          </div>
          <button
            onClick={() => {
              setPhase('live');
              onJoined?.();
            }}
            style={{
              width: '100%',
              padding: '12px 0',
              background: '#21C818',
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            입장하기
          </button>
          <button
            onClick={() => onLeave?.('')}
            style={{
              width: '100%',
              padding: '10px 0',
              marginTop: 8,
              background: 'transparent',
              color: 'var(--text-sub)',
              border: 'none',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            취소
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`meeting-room${embedded ? ' embedded' : ''}${ctlHidden ? ' ctl-hidden' : ''}`}
      onMouseMove={() => {
        // 데스크톱 전체화면: 마우스가 움직이면 표시, 4초 idle이면 숨김 (3사 문법)
        const n = Date.now();
        if (n - lastMouseBump.current < 400) return;
        lastMouseBump.current = n;
        if (shouldAutoHide()) bumpControls();
      }}
    >
      <header className="meeting-header">
        {!embedded && <Logo />}
        <div className="meeting-info">
          <span className="meeting-title">{title || '회의'}</span>
          <span className="meeting-code">
            코드 <b>{code}</b> ·{' '}
            <span
              className="ppl-wrap"
              onMouseEnter={() => {
                if (pplHoverTimer.current) clearTimeout(pplHoverTimer.current);
                setPplHover(true);
              }}
              onMouseLeave={() => {
                if (pplHoverTimer.current) clearTimeout(pplHoverTimer.current);
                pplHoverTimer.current = setTimeout(() => setPplHover(false), 200);
              }}
            >
              {/* hover = 미리보기, 클릭 = 고정 — 명단·마이크/카메라 상태·1:1 채팅·강퇴 */}
              <button
                className="mv-peers-btn"
                onClick={() => {
                  setPplQ('');
                  setDevMenu((v) => (v === 'people' ? null : 'people'));
                }}
                title="참가자 목록 열기"
              >
                참가자 {peers.length + 1}명
              </button>
              {(devMenu === 'people' || pplHover) && (
                <>
                  {devMenu === 'people' && (
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 39 }}
                      onClick={() => setDevMenu(null)}
                    />
                  )}
                  <div className="dev-menu ppl-menu">
                    <div className="dev-menu-title">참가자 {peers.length + 1}명</div>
                    {peers.length >= 8 && (
                      <input
                        className="ppl-search"
                        value={pplQ}
                        onChange={(e) => setPplQ(e.target.value)}
                        placeholder="이름 검색"
                        autoFocus
                      />
                    )}
                    <div className="ppl-list">
                      <div className="ppl-row">
                        <Avatar
                          value={peerAvatars?.[user?.username ?? ''] ?? user?.avatar ?? null}
                          className="hub-assign-avatar"
                        />
                        <span className="ppl-name">{dn(user?.username ?? '나')} (나)</span>
                        <span
                          className={`ppl-mic${micOn ? '' : ' off'}`}
                          title={micOn ? '마이크 켜짐' : '마이크 꺼짐'}
                        >
                          <MicIcon size={13} />
                          {!micOn && <SlashIcon size={13} />}
                        </span>
                        <span
                          className={`ppl-mic${camOn ? '' : ' off'}`}
                          title={camOn ? '카메라 켜짐' : '카메라 꺼짐'}
                        >
                          <CamIcon size={13} />
                          {!camOn && <SlashIcon size={13} />}
                        </span>
                      </div>
                      {peers
                        .filter((p) => {
                          const t = pplQ.trim().toLowerCase();
                          if (!t) return true;
                          return (
                            dn(p.username).toLowerCase().includes(t) ||
                            p.username.toLowerCase().includes(t)
                          );
                        })
                        .map((p) => (
                          <div key={p.peerId} className="ppl-row">
                            <Avatar
                              value={peerAvatars?.[p.username] ?? null}
                              className="hub-assign-avatar"
                            />
                            <span className="ppl-name">{dn(p.username)}</span>
                            <span
                              className={`ppl-mic${p.audioMuted ? ' off' : ''}`}
                              title={p.audioMuted ? '마이크 꺼짐' : '마이크 켜짐'}
                            >
                              <MicIcon size={13} />
                              {p.audioMuted && <SlashIcon size={13} />}
                            </span>
                            <span
                              className={`ppl-mic${p.videoPaused ? ' off' : ''}`}
                              title={p.videoPaused ? '카메라 꺼짐' : '카메라 켜짐'}
                            >
                              <CamIcon size={13} />
                              {p.videoPaused && <SlashIcon size={13} />}
                            </span>
                            {/* 액션 알약 — [채팅|내보내기] 캡슐 (헤더 hdr-pill과 같은 문법) */}
                            <span className="ppl-pill">
                              <button
                                className="ppl-act"
                                title="1:1 채팅"
                                onClick={() => {
                                  setDevMenu(null);
                                  window.dispatchEvent(
                                    new CustomEvent('exist:call-dm', {
                                      detail: { username: p.username },
                                    }),
                                  );
                                }}
                              >
                                <ChatIcon size={13} />
                              </button>
                              {isHost && (
                                <>
                                  <i className="ppl-pill-sep" />
                                  <button
                                    className="ppl-act danger"
                                    title="내보내기"
                                    onClick={() =>
                                      void request(getSocket(), 'room:kick', { peerId: p.peerId })
                                    }
                                  >
                                    <UserXIcon size={13} />
                                  </button>
                                </>
                              )}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                </>
              )}
            </span>
            {' · '}
            <span className="meeting-elapsed" title="통화 경과 시간">
              {fmtElapsed(elapsed)}
            </span>
            {!hasScreen && !pinned && totalPages > 1 && (
              <span className="page-ind-inline" title="페이지 — 좌우로 쓸어 넘기세요">
                {' · '}
                {pageNow + 1}/{totalPages}쪽
              </span>
            )}
            {locked && (
              <span className="meeting-locked">
                · <LockIcon size={12} /> 잠김
              </span>
            )}
          </span>
        </div>
        {status && <span className="meeting-status">{status}</span>}
        {/* 헤더 알약 — [⚙ 통화 설정 | ⛶ 전체화면] 캡슐 (일정 헤더 알약과 같은 문법) */}
        <div className="hdr-pill">
        <div className="ctl-gear">
          <button
            className="expand-btn"
            onClick={() => setDevMenu((v) => (v === 'opts' ? null : 'opts'))}
            title="통화 설정"
          >
            <GearIcon size={18} />
          </button>
          {devMenu === 'opts' && (
            <>
              <div style={{ position: 'fixed', inset: 0, zIndex: 39 }} onClick={() => setDevMenu(null)} />
              <div className="dev-menu align-right ctl-opts">
                <div className="dev-menu-title">통화 설정</div>
                {sttSupported && (
                  <button
                    className="dev-menu-item"
                    onClick={() => setSttOn((v) => !v)}
                    title="발화를 자막으로 띄우고 AI 총무가 기록·정리해요"
                  >
                    <span className="dev-menu-label">음성 기록·자막 (CC)</span>
                    <span className={`msched-sw${sttOn ? ' on' : ''}`}>
                      <i />
                    </span>
                  </button>
                )}
                <button
                  className="dev-menu-item"
                  onClick={() => {
                    setAutoStage((v) => {
                      const next = !v;
                      if (!next) setPinned(null); // 끄면 그리드로 복귀
                      return next;
                    });
                  }}
                  title="말하는 사람을 자동으로 크게 보여줘요"
                >
                  <span className="dev-menu-label">발화자 자동 확대</span>
                  <span className={`msched-sw${autoStage ? ' on' : ''}`}>
                    <i />
                  </span>
                </button>
                <button
                  className="dev-menu-item"
                  onClick={() => {
                    setCtlAlways((v) => {
                      const next = !v;
                      localStorage.setItem('call:ctlAlways', next ? '1' : '0');
                      if (next) {
                        if (ctlTimer.current) clearTimeout(ctlTimer.current);
                        setCtlHidden(false);
                      } else {
                        bumpControls(); // 다시 자동 숨김 모드 — 타이머 재시작
                      }
                      return next;
                    });
                  }}
                  title="켜면 컨트롤 바가 자동으로 숨지 않아요"
                >
                  <span className="dev-menu-label">컨트롤 항상 표시</span>
                  <span className={`msched-sw${ctlAlways ? ' on' : ''}`}>
                    <i />
                  </span>
                </button>
                {isHost && (
                  <button
                    className="dev-menu-item"
                    onClick={() => {
                      void request(getSocket(), 'room:lock', { locked: !locked });
                    }}
                    title="새 참가자 입장 차단"
                  >
                    <span className="dev-menu-label">
                      {locked ? <LockIcon size={12} /> : <UnlockIcon size={12} />} 회의 잠금
                    </span>
                    <span className={`msched-sw${locked ? ' on' : ''}`}>
                      <i />
                    </span>
                  </button>
                )}
                {isHost && peers.length > 0 && (
                  <button
                    className="dev-menu-item"
                    onClick={() => {
                      setDevMenu(null);
                      void request(getSocket(), 'room:mute-all', {})
                        .then(() =>
                          window.dispatchEvent(
                            new CustomEvent('app:error', {
                              detail: '전체 음소거를 실행했어요 — 참가자는 다시 켤 수 있어요',
                            }),
                          ),
                        )
                        .catch(() => {});
                    }}
                    title="나를 제외한 전원의 마이크를 꺼요 (참가자는 다시 켤 수 있음)"
                  >
                    <span className="dev-menu-label">
                      <MicIcon size={12} /> 전체 음소거
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        {embedded && onToggleExpand && (
          <>
            <i className="hdr-pill-sep" />
            <button
              className="expand-btn"
              title={expanded ? '탭으로 축소' : '전체화면으로 확대'}
              onClick={onToggleExpand}
            >
              {expanded ? <ShrinkIcon size={17} /> : <ExpandIcon size={17} />}
            </button>
          </>
        )}
        </div>
      </header>

      <div className="meeting-body">
        <div
          className={`video-area${hasScreen || pinned ? ' with-screen' : ''}`}
          onTouchStart={(e) => {
            areaTouchY.current = e.touches[0].clientY;
            areaTouchX.current = e.touches[0].clientX;
            // 숨김 상태에선 어떤 터치(탭·스와이프·스크롤)든 일단 컨트롤 표시
            if (ctlHidden) {
              bumpControls();
              ctlJustShown.current = true;
              // 탭이면 click 핸들러가 정리하지만, 스와이프면 click이 없으니 자동 해제
              setTimeout(() => {
                ctlJustShown.current = false;
              }, 500);
            }
          }}
          onTouchMove={(e) => {
            // 스와이프가 스크롤로 전환되면 touchend가 안 오는 기기(iOS)가 있어 move에서 즉시 판정
            const y0 = areaTouchY.current;
            const x0 = areaTouchX.current;
            if (y0 == null || x0 == null || !isMobileView()) return;
            const dy = e.touches[0].clientY - y0;
            const dx = e.touches[0].clientX - x0;
            // 좌우 스와이프 = 페이지 넘김 (모바일은 화살표 대신 — 타일 위 오버레이 겹침 방지)
            if (
              !hasScreen &&
              !pinned &&
              totalPages > 1 &&
              Math.abs(dx) > 70 &&
              Math.abs(dx) > Math.abs(dy) * 1.5
            ) {
              areaTouchX.current = null; // 제스처당 1회
              areaTouchY.current = null;
              setSlideDir(dx < 0 ? 'next' : 'prev');
              setPage((v) =>
                dx < 0 ? Math.min(totalPages - 1, v + 1) : Math.max(0, v - 1),
              );
              return;
            }
            // 아래 스와이프 = 툴바 숨김 (세로 우세 제스처만)
            if (ctlJustShown.current || ctlHidden) return;
            if (dy > 60 && Math.abs(dy) > Math.abs(dx)) {
              areaTouchY.current = null; // 제스처당 1회
              if (ctlTimer.current) clearTimeout(ctlTimer.current);
              setCtlHidden(true);
            }
          }}
          onTouchEnd={() => {
            areaTouchY.current = null;
            areaTouchX.current = null;
          }}
          onTouchCancel={() => {
            areaTouchY.current = null;
            areaTouchX.current = null;
          }}
          onClick={(e) => {
            const justShown = ctlJustShown.current;
            ctlJustShown.current = false;
            // 타일 탭은 핀이 처리 — 컨트롤은 표시 유지만. 혼자일 땐 핀이 없으니 빈 영역 탭과 동일 취급
            if (peers.length > 0 && (e.target as HTMLElement).closest('.video-tile')) {
              bumpControls();
              return;
            }
            if (justShown) return; // 방금 터치로 표시됨 — 같은 탭이 도로 숨기지 않게
            // 빈 영역 탭·클릭 = 컨트롤 토글 (자동 숨김 대상 화면에서만)
            if (ctlHidden) bumpControls();
            else if (shouldAutoHide()) {
              if (ctlTimer.current) clearTimeout(ctlTimer.current);
              setCtlHidden(true);
            }
          }}
        >
          {hasScreen && (
            <div className={`screen-stage screens-${screens.length}`}>
              {screens.map((s) => (
                <VideoTile
                  key={s.key}
                  track={s.track}
                  username={dn(s.username)}
                  avatar={peerAvatars?.[s.username]}
                  isLocal={s.isLocal}
                  isScreen
                />
              ))}
            </div>
          )}
          {/* 탭 핀 무대 — 화면공유가 없을 때만. 무대 탭 = 핀 해제 */}
          {!hasScreen &&
            pinned &&
            (() => {
              const me = user?.username ?? '';
              const pp = pinned === me ? null : peers.find((p) => p.username === pinned);
              if (pinned !== me && !pp) return null;
              return (
                <div className="screen-stage pin-stage screens-1">
                  {pinned === me ? (
                    <VideoTile
                      track={localTrack}
                      username={dn(me)}
                      avatar={peerAvatars?.[me] ?? user?.avatar ?? null}
                      isLocal
                      paused={!camOn}
                      micMuted={!micOn}
                      speaking={!!speaking[me]}
                      onPress={() => {
                        setAutoStage(false);
                        setPinned(null);
                      }}
                    />
                  ) : (
                    <VideoTile
                      track={pp!.videoTrack}
                      username={dn(pp!.username)}
                      avatar={peerAvatars ? (peerAvatars[pp!.username] ?? null) : null}
                      paused={pp!.videoPaused}
                      micMuted={pp!.audioMuted}
                      speaking={!!speaking[pp!.username]}
                      onPress={() => {
                        setAutoStage(false);
                        setPinned(null);
                      }}
                    />
                  )}
                </div>
              );
            })()}
          {/* 오디오는 페이지·필름스트립과 무관하게 전원 유지 — 안 보여도 들려야 함 */}
          {peers.map((p) => (p.audioTrack ? <AudioSink key={p.peerId} track={p.audioTrack} /> : null))}
          {/* 스트립 접기 — 무대(핀·공유) 모드에서 아래 참가자 줄을 통째로 숨겨 무대에 집중 */}
          {(hasScreen || pinned) && (
            <button
              className="strip-toggle"
              onClick={(e) => {
                e.stopPropagation();
                setStripHidden((v) => !v);
              }}
              title={stripHidden ? '참가자 스트립 표시' : '참가자 스트립 숨기기'}
            >
              {stripHidden ? <ChevronUpIcon size={14} /> : <ChevronIcon size={14} />}
            </button>
          )}
          <div
            ref={gridRefCb}
            key={`pg-${pageNow}-${stripNow}`}
            className={`video-grid${
              hasScreen || pinned
                ? ' filmstrip'
                : visibleCount >= 3 // 1~2인은 기존 특수 레이아웃(모바일 PiP 등) 유지
                  ? ' computed'
                  : ''
            }${(hasScreen || pinned) && stripHidden ? ' strip-collapsed' : ''} count-${visibleCount} slide-${slideDir}`}
            style={
              hasScreen || pinned || visibleCount < 3
                ? undefined
                : (() => {
                    const s = computeGridShape(gridSize.w, gridSize.h, visibleCount);
                    return { '--cols': s.cols, '--rows': s.rows } as CSSProperties;
                  })()
            }
          >
            {(hasScreen || pinned ? stripNow === 0 && stripSelfShown : pageNow === 0) && (
              <VideoTile
                track={localTrack}
                username={dn(user?.username ?? '나')}
                avatar={peerAvatars?.[user?.username ?? ''] ?? user?.avatar ?? null}
                isLocal
                paused={!camOn}
                micMuted={!micOn}
                speaking={!!speaking[user?.username ?? '']}
                onPress={
                  hasScreen || peers.length === 0 // 혼자일 땐 핀 무의미 — 전체 화면 탭이 자기 핀으로 새는 것 방지
                    ? undefined
                    : () => {
                        setAutoStage(false); // 수동 핀 = 자동 무대 해제 (줌과 동일)
                        setPinned((v) =>
                          v === (user?.username ?? '') ? null : (user?.username ?? ''),
                        );
                      }
                }
              />
            )}
            {(hasScreen || pinned ? stripPeers : pagedPeers).map((p) => (
              <div key={p.peerId} className="peer-cell">
                <VideoTile
                  track={p.videoTrack}
                  username={dn(p.username)}
                  avatar={peerAvatars ? (peerAvatars[p.username] ?? null) : null}
                  paused={p.videoPaused}
                  micMuted={p.audioMuted}
                  speaking={!!speaking[p.username]}
                  onPress={
                    hasScreen
                      ? undefined
                      : () => {
                          setAutoStage(false);
                          setPinned((v) => (v === p.username ? null : p.username));
                        }
                  }
                  onKick={
                    isHost
                      ? () => void request(getSocket(), 'room:kick', { peerId: p.peerId })
                      : undefined
                  }
                />
              </div>
            ))}
            {/* 필름스트립 페이지 넘김 — 무대 아래에서도 전원 확인 가능 */}
            {(hasScreen || pinned) && stripTotal > 1 && (
              <>
                <button
                  className="strip-page-btn prev"
                  disabled={stripNow === 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSlideDir('prev');
                    setStripPage((v) => Math.max(0, v - 1));
                  }}
                  title="이전"
                >
                  <ChevronLeftIcon size={16} />
                </button>
                <button
                  className="strip-page-btn next"
                  disabled={stripNow >= stripTotal - 1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSlideDir('next');
                    setStripPage((v) => Math.min(stripTotal - 1, v + 1));
                  }}
                  title="다음"
                >
                  <ChevronRightIcon size={16} />
                </button>
              </>
            )}
          </div>
          {/* 페이지 넘김 — 그리드 모드에서 인원이 페이지 상한을 넘을 때만 */}
          {!hasScreen && !pinned && totalPages > 1 && (
            <>
              <button
                className="grid-page-btn prev"
                disabled={pageNow === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  setSlideDir('prev');
                  setPage((v) => Math.max(0, v - 1));
                }}
                title="이전 페이지"
              >
                <ChevronLeftIcon size={16} />
              </button>
              <button
                className="grid-page-btn next"
                disabled={pageNow >= totalPages - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  setSlideDir('next');
                  setPage((v) => Math.min(totalPages - 1, v + 1));
                }}
                title="다음 페이지"
              >
                <ChevronRightIcon size={16} />
              </button>
              <span className="grid-page-ind">
                {pageNow + 1} / {totalPages}
              </span>
            </>
          )}
        </div>

        {/* 라이브 자막 — 발화자별로 쌓임(동시 발화 지원, 먼저 말한 순 위→아래, 최대 3명) */}
        {Object.keys(captions).length > 0 && (
          <div className="call-captions">
            {Object.entries(captions)
              .sort((a, b) => a[1].ts - b[1].ts)
              .slice(-3)
              .map(([username, c]) => (
                <div key={username} className={`call-caption${c.interim ? ' interim' : ''}`}>
                  <b>{dn(username)}</b> {c.text}
                  {c.interim && '…'}
                </div>
              ))}
          </div>
        )}

        {chatOpen && (
          <aside className="chat-panel">
            <div className="chat-head">
              <span className="chat-head-title">
                <ChatIcon size={16} /> 채팅 <span className="chat-head-channel"># {callChannelName}</span>
              </span>
              <button onClick={() => setChatOpen(false)}><CloseIcon size={14} /></button>
            </div>
            <div className="chat-messages">
              {messages.length === 0 && <div className="chat-empty">아직 메시지가 없어요</div>}
              {messages.map((m, i) => (
                <div key={i} className={`chat-msg${m.from === user?.username ? ' mine' : ''}`}>
                  <span className="chat-from">{dn(m.from)}</span>
                  <div className="chat-bubble">{m.text}</div>
                </div>
              ))}
              {aiThinking && (
                <div className="chat-msg">
                  <span className="chat-from">exist AI</span>
                  <div className="chat-bubble chat-typing">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-input" onSubmit={sendChat}>
              <MentionInput
                value={chatInput}
                onChange={setChatInput}
                candidates={
                  mentionCandidates ?? [
                    { username: 'AI', avatar: '✦', sub: 'AI 총무' },
                    ...peers.map((p) => ({ username: p.username, avatar: null })),
                  ]
                }
                placeholder="메시지 입력"
              />
              <button type="submit">전송</button>
            </form>
          </aside>
        )}
      </div>

      <footer
        className="meeting-controls"
        onClick={bumpControls}
        onTouchStart={(e) => {
          areaTouchY.current = e.touches[0].clientY;
        }}
        onTouchMove={(e) => {
          // 툴바 자체를 쓸어내려도 숨김 (버튼 탭은 60px 임계에 안 걸림)
          const y0 = areaTouchY.current;
          if (y0 == null || ctlHidden || !isMobileView()) return;
          const dy = e.touches[0].clientY - y0;
          if (dy > 60) {
            areaTouchY.current = null;
            if (ctlTimer.current) clearTimeout(ctlTimer.current);
            setDevMenu(null); // 메뉴 열려 있으면 같이 정리
            setCtlHidden(true);
          }
        }}
        onTouchEnd={() => {
          areaTouchY.current = null;
        }}
      >
        <div className="ctl-split">
          <button className={`main${micOn ? '' : ' off'}`} onClick={toggleMic} title="마이크">
            <MicIcon size={21} />
            {!micOn && (
              <span className="slash">
                <SlashIcon size={21} />
              </span>
            )}
          </button>
          <button
            className={`dev-arrow${devMenu === 'mic' ? ' active' : ''}`}
            onClick={() => setDevMenu((v) => (v === 'mic' ? null : 'mic'))}
            title="마이크 선택"
          >
            <span className="dev-arrow-chev">
              <ChevronIcon size={12} />
            </span>
          </button>
          {devMenu === 'mic' && renderDevMenu('mic')}
        </div>
        <div className="ctl-split">
          <button className={`main${camOn ? '' : ' off'}`} onClick={toggleCam} title="카메라">
            <CamIcon size={21} />
            {!camOn && (
              <span className="slash">
                <SlashIcon size={21} />
              </span>
            )}
          </button>
          <button
            className={`dev-arrow${devMenu === 'cam' ? ' active' : ''}`}
            onClick={() => setDevMenu((v) => (v === 'cam' ? null : 'cam'))}
            title="카메라 선택"
          >
            <span className="dev-arrow-chev">
              <ChevronIcon size={12} />
            </span>
          </button>
          {devMenu === 'cam' && renderDevMenu('cam')}
        </div>
        <button
          className={localScreen ? 'active' : ''}
          onClick={toggleScreenShare}
          title="화면 공유"
        >
          <ScreenIcon size={21} />
        </button>
        <button
          className={`chat-toggle${chatOpen ? ' active' : ''}`}
          onClick={() => {
            setChatOpen((v) => !v);
            setUnread(0);
          }}
          title="채팅"
        >
          <ChatIcon size={20} />
          {unread > 0 && <span className="badge">{unread}</span>}
        </button>
        <button className="leave" onClick={() => onLeave()} title="나가기">
          나가기
        </button>
      </footer>
    </div>
  );
}
