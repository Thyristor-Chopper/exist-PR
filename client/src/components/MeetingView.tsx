import { useCallback, useEffect, useRef, useState } from 'react';
import { Device } from 'mediasoup-client';
import type { Transport, Producer } from 'mediasoup-client/types';
import { getSocket, request } from '../lib/socket';
import { api } from '../api';
import { useAuthStore } from '../store';
import Logo from './Logo';
import MentionInput, { type MentionCandidate } from './MentionInput';
import { MicIcon, CamIcon, ScreenIcon, ChatIcon, SlashIcon, ExpandIcon, ShrinkIcon, LockIcon, UnlockIcon, ChevronIcon, CheckMarkIcon } from './Icons';

interface RemotePeer {
  peerId: string;
  username: string;
  videoTrack?: MediaStreamTrack;
  audioTrack?: MediaStreamTrack;
  screenTrack?: MediaStreamTrack;
  videoPaused?: boolean;
}

interface ProducerInfo {
  producerId: string;
  peerId: string;
  username: string;
  kind: 'audio' | 'video';
  source?: string;
}

export interface ChatFile {
  name: string;
  url: string;
  size: number;
}
export interface ChatMessage {
  code?: string;
  from: string;
  avatar?: string | null;
  text: string;
  file?: ChatFile;
  /** 소속 채팅 채널 (없으면 기본 채널) */
  channelId?: number | null;
  ts: number;
}

/** 선택한 장치 우선 getUserMedia — 선택 장치가 뽑혔거나 못 잡으면 기본 장치로 재시도 */
async function getUserMediaPreferred(camId: string, micId: string): Promise<MediaStream> {
  const prefer: MediaStreamConstraints = {
    video: camId ? { deviceId: { exact: camId } } : true,
    audio: micId ? { deviceId: { exact: micId } } : true,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(prefer);
  } catch (err) {
    if (!camId && !micId) throw err;
    return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }
}

/** 카메라가 없을 때 쓰는 캔버스 기반 가짜 비디오 (개발·데모용) */
function makeFallbackStream(label: string): MediaStream {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d')!;
  setInterval(() => {
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
  return canvas.captureStream(2);
}

function VideoTile({
  track,
  username,
  muted,
  isLocal,
  isScreen,
  paused,
  onKick,
}: {
  track?: MediaStreamTrack;
  username: string;
  muted?: boolean;
  isLocal?: boolean;
  isScreen?: boolean;
  paused?: boolean;
  onKick?: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const showVideo = !!track && !paused;
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
    if (ref.current && track && showVideo) {
      ref.current.srcObject = new MediaStream([track]);
      void ref.current.play().catch(() => {}); // autoplay 거부 시 폴백 (실패해도 autoPlay 속성이 재시도)
    }
  }, [track, showVideo]);
  return (
    <div className={`video-tile${isScreen ? ' screen' : ''}`}>
      {showVideo ? (
        <>
          <video ref={ref} autoPlay playsInline muted={muted} />
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
          <div className="avatar-circle">{username.slice(0, 1).toUpperCase()}</div>
          <span className="cam-off-label">카메라 꺼짐</span>
        </div>
      )}
      <span className="video-name">
        {isScreen && '🖥️ '}
        {username}
        {isLocal && ' (나)'}
      </span>
      {onKick && (
        <button className="kick-btn" title="강퇴" onClick={onKick}>
          내보내기
        </button>
      )}
    </div>
  );
}

function AudioSink({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
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
  mentionCandidates,
}: MeetingViewProps) {
  const user = useAuthStore((s) => s.user);

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
  const [devMenu, setDevMenu] = useState<'mic' | 'cam' | null>(null); // 통화 중 장치 선택 메뉴 (스플릿 버튼 ˄)
  const micIdRef = useRef(micId);
  micIdRef.current = micId;
  const camIdRef = useRef(camId);
  camIdRef.current = camId;
  const [phase, setPhase] = useState<'preview' | 'live'>('preview');
  const [previewTrack, setPreviewTrack] = useState<MediaStreamTrack>();
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [unread, setUnread] = useState(0);
  const [isHost, setIsHost] = useState(false);
  const [locked, setLocked] = useState(false);
  // 음성 전사(STT) — 내 발화를 브라우저가 전사해 서버로 (recap·결정 원장·AI 총무 근거)
  const [sttOn, setSttOn] = useState(true);
  const [caption, setCaption] = useState<{
    username: string;
    text: string;
    interim?: boolean;
  } | null>(null);

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
  const defaultChannelRef = useRef<number | null>(null); // 통화 패널이 고정될 기본 채널
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  // SpeechRecognition 인스턴스 — 크롬 계열만 지원, 없으면 STT 기능 숨김
  const sttRef = useRef<{ stop(): void; start(): void } | null>(null);
  const sttWantedRef = useRef(true); // onend 자동 재시작 여부 (침묵으로 자주 끊기므로)
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 소켓이 순간 끊겼다 붙으면 서버는 이미 이 피어의 transport를 전부 파괴한 뒤다
  // — 재입장 외에 복구 방법이 없으므로, 재연결 시 이 값을 올려 통화 이펙트를 처음부터 다시 돈다
  const [rejoinTick, setRejoinTick] = useState(0);
  const sttSupported =
    typeof window !== 'undefined' &&
    !!(window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatOpen]);

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
      patch?: Partial<Pick<RemotePeer, 'videoTrack' | 'audioTrack' | 'screenTrack' | 'videoPaused'>>,
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
        upsertPeer(info.peerId, info.username, { audioTrack: consumer.track });
      } else if (source === 'screen') {
        upsertPeer(info.peerId, info.username, { screenTrack: consumer.track });
      } else {
        upsertPeer(info.peerId, info.username, { videoTrack: consumer.track });
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

      // 채팅: 히스토리 로드 + 채팅 룸 구독 (허브와 공용 스트림)
      // 통화 중 패널은 기본 채널("일반")에 고정 — 다른 채널은 허브 채팅 탭에서
      void api<{ id: number; isDefault: boolean }[]>(`/api/meetings/${code}/channels`)
        .then((chs) => {
          if (!closed) defaultChannelRef.current = chs.find((c) => c.isDefault)?.id ?? null;
        })
        .catch(() => {});
      void api<ChatMessage[]>(`/api/meetings/${code}/messages`).then((history) => {
        if (!closed) setMessages(history);
      });
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
        localStream = makeFallbackStream(user?.username ?? 'me');
        setStatus('카메라 없음 — 데모 화면 송출 중');
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
      socket.on('producer:paused', ({ producerId }: { producerId: string }) => {
        const meta = consumerMapRef.current.get(producerId);
        if (meta?.kind === 'video' && meta.source === 'camera') {
          setRemotePeers((prev) => {
            const next = new Map(prev);
            const p = next.get(meta.peerId);
            if (p) next.set(meta.peerId, { ...p, videoPaused: true });
            return next;
          });
        }
      });
      socket.on('producer:resumed', ({ producerId }: { producerId: string }) => {
        const meta = consumerMapRef.current.get(producerId);
        if (meta?.kind === 'video' && meta.source === 'camera') {
          setRemotePeers((prev) => {
            const next = new Map(prev);
            const p = next.get(meta.peerId);
            if (p) next.set(meta.peerId, { ...p, videoPaused: false });
            return next;
          });
        }
      });
      socket.on('chat:message', (msg: ChatMessage) => {
        if (msg.code && msg.code !== code.toUpperCase()) return; // 다른 회의 채팅 무시
        // 통화 패널은 기본 채널 고정 — 다른 채널 메시지는 허브 채팅 탭에서
        if (
          msg.channelId != null &&
          defaultChannelRef.current != null &&
          msg.channelId !== defaultChannelRef.current
        )
          return;
        setMessages((prev) => [...prev, msg]);
        if (!chatOpenRef.current) setUnread((n) => n + 1);
      });
      // 라이브 자막 — 누군가의 발화가 전사되면 하단에 잠깐 표시
      socket.on(
        'voice:caption',
        ({ username, text, interim }: { username: string; text: string; interim?: boolean }) => {
          setCaption({ username, text, interim });
          if (captionTimer.current) clearTimeout(captionTimer.current);
          // 미확정은 짧게(다음 갱신이 금방 옴), 확정은 읽을 시간 확보
          captionTimer.current = setTimeout(() => setCaption(null), interim ? 2500 : 4000);
        },
      );
      socket.on('room:locked', ({ locked }: { locked: boolean }) => setLocked(locked));
      socket.on('room:kicked', () => {
        onLeaveRef.current('호스트가 회의에서 내보냈습니다');
      });

      setStatus('');
    }

    run().catch((err) => setStatus(`연결 실패: ${err.message}`));

    return () => {
      closed = true;
      socket.io.off('reconnect', onReconnect);
      socket.off('peer:joined');
      socket.off('peer:left');
      socket.off('producer:new');
      socket.off('producer:closed');
      socket.off('producer:paused');
      socket.off('producer:resumed');
      socket.off('chat:message');
      socket.off('voice:caption');
      socket.off('room:locked');
      socket.off('room:kicked');
      sendTransportRef.current?.close();
      recvTransport?.close();
      localStream?.getTracks().forEach((t) => t.stop());
      // 통화 중 장치 교체(replaceTrack)로 갈아탄 트랙은 localStream 밖에 있다 — 같이 꺼야 캠 불이 꺼짐
      producersRef.current.audio?.track?.stop();
      producersRef.current.video?.track?.stop();
      producersRef.current = {}; // 재입장 시 죽은 producer 참조 잔존 방지
      socket.disconnect();
    };
  }, [code, user?.username, phase, rejoinTick]);

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
    if (!p) return;
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
    if (!p) return;
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
          ? { audio: id ? { deviceId: { exact: id } } : true }
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
    getSocket().emit('chat:send', { code, text: chatInput });
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
  const previewPill = (kind: 'mic' | 'cam') => {
    const on = kind === 'mic' ? micOn : camOn;
    const toggle = () => (kind === 'mic' ? setMicOn((v) => !v) : setCamOn((v) => !v));
    const noun = kind === 'mic' ? '마이크' : '카메라';
    const Icon = kind === 'mic' ? MicIcon : CamIcon;
    const segBtn: React.CSSProperties = {
      border: 'none',
      cursor: 'pointer',
      background: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
    };
    return (
      <div
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: 999,
          background: on ? 'rgba(255,255,255,0.92)' : '#e5484d',
          boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        }}
      >
        <button
          onClick={toggle}
          title={on ? `${noun} 끄기` : `${noun} 켜기`}
          style={{
            ...segBtn,
            position: 'relative',
            width: 42,
            height: 46,
            color: on ? '#222' : '#fff',
            paddingLeft: 4,
          }}
        >
          {/* 슬래시는 버튼이 아니라 아이콘 박스에 겹침 — 버튼 패딩과 무관하게 항상 아이콘 정중앙 */}
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Icon size={20} />
            {!on && (
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <SlashIcon size={20} />
              </span>
            )}
          </span>
        </button>
        <button
          onClick={() => setDevMenu((v) => (v === kind ? null : kind))}
          title={`${noun} 선택`}
          style={{
            ...segBtn,
            width: 24,
            height: 46,
            color: on ? '#666' : '#ffd7d7',
            paddingRight: 6,
          }}
        >
          <span style={{ display: 'grid', placeItems: 'center', transform: 'rotate(180deg)' }}>
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

  // 입장 전 디바이스 프리뷰 게이트 (카메라/마이크 미리 확인 후 입장)
  if (phase === 'preview') {
    return (
      <div
        className={`meeting-room${embedded ? ' embedded' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg)',
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
            <div style={{ fontSize: 13, color: '#21C818', fontWeight: 700, marginBottom: 16 }}>
              ● 지금 통화 중 · {onlinePeers.join(', ')}
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
            {/* 라운드 클리핑은 비디오만 — 알약·장치 메뉴는 바깥이라 위로 열려도 안 잘림 */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                background: '#111',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              <VideoTile
                track={previewTrack}
                username={user?.username ?? '나'}
                muted
                isLocal
                paused={!camOn}
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
    <div className={`meeting-room${embedded ? ' embedded' : ''}`}>
      <header className="meeting-header">
        {!embedded && <Logo light />}
        <div className="meeting-info">
          <span className="meeting-title">{title || '회의'}</span>
          <span className="meeting-code">
            코드 <b>{code}</b> · 참가자 {peers.length + 1}명
            {locked && (
              <span className="meeting-locked">
                · <LockIcon size={12} /> 잠김
              </span>
            )}
          </span>
        </div>
        {isHost && (
          <button
            className="lock-btn"
            title={locked ? '회의 잠금 해제' : '회의 잠금 (새 참가자 차단)'}
            onClick={() => {
              void request(getSocket(), 'room:lock', { locked: !locked });
            }}
          >
            {locked ? <LockIcon size={13} /> : <UnlockIcon size={13} />} {locked ? '잠김' : '열림'}
          </button>
        )}
        {status && <span className="meeting-status">{status}</span>}
        {embedded && onToggleExpand && (
          <button
            className="expand-btn"
            title={expanded ? '탭으로 축소' : '전체화면으로 확대'}
            onClick={onToggleExpand}
          >
            {expanded ? <ShrinkIcon size={17} /> : <ExpandIcon size={17} />}
          </button>
        )}
      </header>

      <div className="meeting-body">
        <div className={`video-area${hasScreen ? ' with-screen' : ''}`}>
          {hasScreen && (
            <div className={`screen-stage screens-${screens.length}`}>
              {screens.map((s) => (
                <VideoTile
                  key={s.key}
                  track={s.track}
                  username={s.username}
                  muted={s.isLocal}
                  isLocal={s.isLocal}
                  isScreen
                />
              ))}
            </div>
          )}
          <div
            className={`video-grid${hasScreen ? ' filmstrip' : ''} count-${peers.length + 1}`}
          >
            <VideoTile
              track={localTrack}
              username={user?.username ?? '나'}
              muted
              isLocal
              paused={!camOn}
            />
            {peers.map((p) => (
              <div key={p.peerId} className="peer-cell">
                <VideoTile
                  track={p.videoTrack}
                  username={p.username}
                  paused={p.videoPaused}
                  onKick={
                    isHost
                      ? () => void request(getSocket(), 'room:kick', { peerId: p.peerId })
                      : undefined
                  }
                />
                {p.audioTrack && <AudioSink track={p.audioTrack} />}
              </div>
            ))}
          </div>
        </div>

        {/* 라이브 자막 — 발화가 전사되는 순간 표시 (recap·결정 원장의 근거가 됨) */}
        {caption && (
          <div className={`call-caption${caption.interim ? ' interim' : ''}`}>
            <b>{caption.username}</b> {caption.text}
            {caption.interim && '…'}
          </div>
        )}

        {chatOpen && (
          <aside className="chat-panel">
            <div className="chat-head">
              <span className="chat-head-title">
                <ChatIcon size={16} /> 채팅
              </span>
              <button onClick={() => setChatOpen(false)}>×</button>
            </div>
            <div className="chat-messages">
              {messages.length === 0 && <div className="chat-empty">아직 메시지가 없어요</div>}
              {messages.map((m, i) => (
                <div key={i} className={`chat-msg${m.from === user?.username ? ' mine' : ''}`}>
                  <span className="chat-from">{m.from}</span>
                  <div className="chat-bubble">{m.text}</div>
                </div>
              ))}
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

      <footer className="meeting-controls">
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
        {sttSupported && (
          <button
            className={`stt-toggle${sttOn ? ' active' : ''}`}
            onClick={() => setSttOn((v) => !v)}
            title={sttOn ? '음성 기록 끄기' : '음성 기록 켜기 — 발화를 AI 총무가 기록·정리해요'}
          >
            CC
          </button>
        )}
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
