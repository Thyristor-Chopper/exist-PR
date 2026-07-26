import * as mediasoup from 'mediasoup';
import type { Server, Socket } from 'socket.io';
import type {
  Worker,
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  RtpCodecCapability,
  DtlsParameters,
  RtpParameters,
  MediaKind,
  RtpCapabilities,
  TransportListenInfo,
} from 'mediasoup/types';
import db from './db.js';
import { scheduleRecap, cancelScheduledRecap } from './recap.js';
import { invalidateBriefForMeeting } from './agent.js';
import { canManageMeeting } from './perm.js';
import { audit as orgAudit } from './orgs.js';
import { resolveChannel } from './channels.js';
import { AGENT_MENTION, handleAgentQuery, maybeSuggestDecision } from './steward.js';

/*
 * exist SFU — mediasoup 기반 직접 구현.
 * Room(회의 코드) 단위로 Router를 만들고, Peer(소켓)별 transport/producer/consumer를 관리한다.
 *
 * 시그널링 프로토콜 (Socket.IO ack 기반):
 *   room:join      {code}                                → {rtpCapabilities, producers[], peers[]}
 *   transport:create {direction}                         → WebRtcTransport 파라미터
 *   transport:connect {transportId, dtlsParameters}      → {ok}
 *   produce        {transportId, kind, rtpParameters}    → {id}
 *   consume        {transportId, producerId, rtpCapabilities} → consumer 파라미터
 *   consumer:resume {consumerId}                         → {ok}
 *   브로드캐스트: peer:joined / peer:left / producer:new / producer:closed
 */

const mediaCodecs: RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    preferredPayloadType: 111,
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    preferredPayloadType: 96,
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

interface Peer {
  socketId: string;
  userId: number;
  username: string;
  transports: Map<string, WebRtcTransport>;
  producers: Map<string, Producer>;
  consumers: Map<string, Consumer>;
}

interface Room {
  code: string;
  router: Router;
  peers: Map<string, Peer>;
  hostUserId: number | null;
  locked: boolean;
  /** 이번 통화 세션에 들어왔던 모든 userId — 종료 후 recap의 참석/불참 구분에 사용 */
  sessionUserIds: Set<number>;
  /** 이번 세션에서 강퇴된 userId — 방이 살아 있는 동안 재입장 차단 (방 닫히면 초기화) */
  kickedUserIds: Set<number>;
}

let worker: Worker;
const rooms = new Map<string, Room>();

export async function startMediasoup() {
  worker = await mediasoup.createWorker({
    rtcMinPort: Number(process.env.RTC_MIN_PORT ?? 40000),
    rtcMaxPort: Number(process.env.RTC_MAX_PORT ?? 40100),
  });
  worker.on('died', () => {
    console.error('[sfu] mediasoup worker died — exiting');
    process.exit(1);
  });
  console.log('[sfu] mediasoup worker started');
}

async function getOrCreateRoom(code: string): Promise<Room> {
  let room = rooms.get(code);
  if (!room) {
    const router = await worker.createRouter({ mediaCodecs });
    const meeting = db.prepare('SELECT host_id FROM meetings WHERE code = ?').get(code) as
      | { host_id: number }
      | undefined;
    room = {
      code,
      router,
      peers: new Map(),
      hostUserId: meeting?.host_id ?? null,
      locked: false,
      sessionUserIds: new Set(),
      kickedUserIds: new Set(),
    };
    rooms.set(code, room);
    cancelScheduledRecap(code); // 유예 중 재입장이면 같은 세션으로 이어붙임
    console.log(`[sfu] room created: ${code}`);
  }
  return room;
}

function closeRoomIfEmpty(room: Room) {
  if (room.peers.size === 0) {
    room.router.close();
    rooms.delete(room.code);
    console.log(`[sfu] room closed: ${room.code}`);
    // P1: 통화 종료 훅 — 유예 후 이번 세션 채팅을 요약해 참석/불참자에게 배달
    scheduleRecap(room.code, [...room.sessionUserIds]);
  }
}

/**
 * ICE 후보로 알릴 주소들을 만든다.
 * - LOCAL_IP: 같은 공유기(LAN) 안에서 접속할 때 쓰는 사설 IP (예: 192.168.0.82).
 *   → 헤어핀 NAT 미지원 공유기에서도 LAN끼리는 직접 연결됨.
 * - ANNOUNCED_IP: 외부망(인터넷)에서 접속할 때 쓰는 공인 IP.
 * 둘 다 후보로 주면 클라가 ICE 연결성 검사로 되는 쪽을 자동 선택한다.
 * 개발 환경(둘 다 미설정)에서는 127.0.0.1로 폴백.
 */
function buildListenInfos(): TransportListenInfo[] {
  const announced = [process.env.LOCAL_IP, process.env.ANNOUNCED_IP].filter(
    (v): v is string => !!v,
  );
  if (announced.length === 0) {
    return [
      { protocol: 'udp', ip: '127.0.0.1' },
      { protocol: 'tcp', ip: '127.0.0.1' },
    ];
  }
  const infos: TransportListenInfo[] = [];
  for (const addr of announced) {
    infos.push({ protocol: 'udp', ip: '0.0.0.0', announcedAddress: addr });
    infos.push({ protocol: 'tcp', ip: '0.0.0.0', announcedAddress: addr });
  }
  return infos;
}

// Colima/Docker처럼 UDP 포워딩이 막힌 환경에선 TCP 우선(MEDIA_PREFER_TCP=1).
// UDP 후보는 그대로 두되 ICE 우선순위만 TCP로 → 빠르게 TCP로 붙는다.
const PREFER_TCP =
  process.env.MEDIA_PREFER_TCP === '1' || process.env.MEDIA_PREFER_TCP === 'true';

async function createWebRtcTransport(router: Router): Promise<WebRtcTransport> {
  return router.createWebRtcTransport({
    listenInfos: buildListenInfos(),
    enableUdp: true,
    enableTcp: true,
    preferUdp: !PREFER_TCP,
    preferTcp: PREFER_TCP,
    initialAvailableOutgoingBitrate: 1_000_000,
  });
}

/** 회의 허브용 — 현재 통화 참여 인원 */
export function getRoomSize(code: string): number {
  return rooms.get(code)?.peers.size ?? 0;
}

/** 회의 허브용 — 현재 통화 참여자 이름 목록 (프리뷰에 표시) */
export function getRoomPeers(code: string): string[] {
  const room = rooms.get(code);
  if (!room) return [];
  return [...room.peers.values()].map((p) => p.username);
}

export function attachSfu(io: Server) {
  io.on('connection', (socket: Socket) => {
    let room: Room | null = null;
    let peer: Peer | null = null;

    socket.on('room:join', async ({ code }: { code: string }, ack) => {
      try {
        room = await getOrCreateRoom(code);
        const userId = socket.data.userId as number;
        if (room.locked && userId !== room.hostUserId) {
          room = null;
          return ack({ error: '호스트가 회의를 잠갔습니다' });
        }
        if (room.kickedUserIds.has(userId) && userId !== room.hostUserId) {
          room = null;
          return ack({ error: '호스트가 내보낸 통화입니다 — 이번 통화에는 다시 들어올 수 없어요' });
        }
        peer = {
          socketId: socket.id,
          userId,
          username: socket.data.username as string,
          transports: new Map(),
          producers: new Map(),
          consumers: new Map(),
        };
        room.peers.set(socket.id, peer);
        room.sessionUserIds.add(userId);
        await socket.join(`room:${code}`);

        // 기존 참가자의 producer 목록 (신규 입장자가 consume)
        const producers: {
          producerId: string;
          peerId: string;
          username: string;
          kind: MediaKind;
          source: string;
        }[] = [];
        for (const p of room.peers.values()) {
          if (p.socketId === socket.id) continue;
          for (const producer of p.producers.values()) {
            producers.push({
              producerId: producer.id,
              peerId: p.socketId,
              username: p.username,
              kind: producer.kind,
              source: (producer.appData as { source?: string })?.source ?? 'camera',
            });
          }
        }
        socket.to(`room:${code}`).emit('peer:joined', {
          peerId: socket.id,
          username: peer.username,
        });
        ack({
          rtpCapabilities: room.router.rtpCapabilities,
          producers,
          peers: [...room.peers.values()].map((p) => ({ peerId: p.socketId, username: p.username })),
          isHost: userId === room.hostUserId,
          locked: room.locked,
        });
      } catch (err) {
        console.error('[sfu] room:join error', err);
        ack({ error: '회의 입장 실패' });
      }
    });

    socket.on('transport:create', async (_data, ack) => {
      if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
      try {
        const transport = await createWebRtcTransport(room.router);
        peer.transports.set(transport.id, transport);
        ack({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        });
      } catch (err) {
        console.error('[sfu] transport:create error', err);
        ack({ error: 'transport 생성 실패' });
      }
    });

    socket.on(
      'transport:connect',
      async (
        { transportId, dtlsParameters }: { transportId: string; dtlsParameters: DtlsParameters },
        ack,
      ) => {
        const transport = peer?.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        await transport.connect({ dtlsParameters });
        ack({ ok: true });
      },
    );

    socket.on(
      'produce',
      async (
        {
          transportId,
          kind,
          rtpParameters,
          appData,
        }: {
          transportId: string;
          kind: MediaKind;
          rtpParameters: RtpParameters;
          appData?: { source?: string };
        },
        ack,
      ) => {
        if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
        const transport = peer.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        const producer = await transport.produce({ kind, rtpParameters, appData });
        peer.producers.set(producer.id, producer);
        socket.to(`room:${room.code}`).emit('producer:new', {
          producerId: producer.id,
          peerId: socket.id,
          username: peer.username,
          kind,
          source: appData?.source ?? 'camera',
        });
        ack({ id: producer.id });
      },
    );

    /** producer 일시정지/재개 — 서버 측 pause로 consumer들에게 producerpause 전파 */
    socket.on('producer:pause', async ({ producerId }: { producerId: string }, ack) => {
      const producer = peer?.producers.get(producerId);
      if (!producer) return ack?.({ error: 'producer 없음' });
      await producer.pause();
      ack?.({ ok: true });
    });

    socket.on('producer:resume', async ({ producerId }: { producerId: string }, ack) => {
      const producer = peer?.producers.get(producerId);
      if (!producer) return ack?.({ error: 'producer 없음' });
      await producer.resume();
      ack?.({ ok: true });
    });

    /** producer 종료 (화면공유 중단 등) — consumer들에게 producer:closed 전파 */
    socket.on('producer:close', ({ producerId }: { producerId: string }, ack) => {
      const producer = peer?.producers.get(producerId);
      if (!producer) return ack?.({ error: 'producer 없음' });
      producer.close(); // consumer.on('producerclose')가 각 수신자에게 전파
      peer!.producers.delete(producerId);
      ack?.({ ok: true });
    });

    /** 통화 중 회의 잠금/해제 — 호스트·조직 관리자·group:lock 권한자 */
    socket.on('room:lock', ({ locked }: { locked: boolean }, ack) => {
      if (!room || !peer) return ack?.({ error: '방에 입장하지 않았습니다' });
      const meetingRef = db
        .prepare('SELECT host_id, org_id, title FROM meetings WHERE code = ?')
        .get(room.code) as { host_id: number; org_id: number | null; title: string } | undefined;
      if (!meetingRef || !canManageMeeting(meetingRef, peer.userId, 'group:lock')) {
        return ack?.({ error: '잠금 권한이 없습니다' });
      }
      if (meetingRef.org_id && room.locked !== !!locked)
        orgAudit(meetingRef.org_id, peer.userId, 'group.lock', null, `그룹 "${meetingRef.title}" 통화 중 잠금 ${locked ? '설정' : '해제'}`);
      room.locked = !!locked;
      io.to(`room:${room.code}`).emit('room:locked', { locked: room.locked });
      ack?.({ ok: true });
    });

    /** 통화 중 참가자 강퇴 — 호스트·조직 관리자·group:kick 권한자 */
    socket.on('room:kick', ({ peerId }: { peerId: string }, ack) => {
      if (!room || !peer) return ack?.({ error: '방에 입장하지 않았습니다' });
      const kickRef = db
        .prepare('SELECT host_id, org_id FROM meetings WHERE code = ?')
        .get(room.code) as { host_id: number; org_id: number | null } | undefined;
      if (!kickRef || !canManageMeeting(kickRef, peer.userId, 'group:kick')) {
        return ack?.({ error: '강퇴 권한이 없습니다' });
      }
      const target = io.sockets.sockets.get(peerId);
      const targetPeer = room.peers.get(peerId);
      if (!target || !targetPeer) return ack?.({ error: '대상이 없습니다' });
      if (kickRef.org_id)
        orgAudit(kickRef.org_id, peer.userId, 'group.kick', targetPeer.userId, `통화에서 ${targetPeer.username}님 강퇴`);
      room.kickedUserIds.add(targetPeer.userId); // 방이 닫힐 때까지 재입장 차단
      target.emit('room:kicked');
      // 알림 패킷 플러시 후 끊기 — disconnect 핸들러가 transport 정리 + peer:left 전파
      setTimeout(() => target.disconnect(true), 200);
      ack?.({ ok: true });
    });

    /** 통화 음성 전사 — 각자 브라우저 STT 결과를 저장 + 방에 자막 브로드캐스트.
     *  recap·결정 원장·AI 총무가 채팅과 함께 근거로 쓴다. */
    socket.on('voice:transcript', ({ text }: { text: string }) => {
      if (!room || !peer) return; // 통화 중인 사람만
      const trimmed = String(text ?? '').trim().slice(0, 500);
      if (!trimmed) return;
      const meeting = db.prepare('SELECT id FROM meetings WHERE code = ?').get(room.code) as
        | { id: number }
        | undefined;
      if (!meeting) return;
      db.prepare('INSERT INTO call_transcripts (meeting_id, user_id, text) VALUES (?, ?, ?)').run(
        meeting.id,
        peer.userId,
        trimmed,
      );
      // 라이브 자막 (본인 포함 전원에게)
      io.to(`room:${room.code}`).emit('voice:caption', {
        peerId: socket.id,
        username: peer.username,
        text: trimmed,
        ts: Date.now(),
      });
    });

    /** 중간 전사 — 말하는 도중의 미확정 텍스트. 저장 없이 자막 브로드캐스트만
     *  (확정 대기 딜레이 없이 자막이 실시간으로 따라오게) */
    socket.on('voice:interim', ({ text }: { text: string }) => {
      if (!room || !peer) return;
      const trimmed = String(text ?? '').trim().slice(0, 500);
      if (!trimmed) return;
      io.to(`room:${room.code}`).emit('voice:caption', {
        peerId: socket.id,
        username: peer.username,
        text: trimmed,
        interim: true,
        ts: Date.now(),
      });
    });

    /** 채팅 구독 — 통화 없이도 허브에서 채팅 가능 (chat:CODE 룸) */
    socket.on('chat:join', ({ code }: { code: string }, ack) => {
      const meeting = db
        .prepare('SELECT id FROM meetings WHERE code = ?')
        .get((code ?? '').toUpperCase()) as { id: number } | undefined;
      if (!meeting) return ack?.({ error: '존재하지 않는 회의입니다' });
      void socket.join(`chat:${code.toUpperCase()}`);
      ack?.({ ok: true });
    });

    /** 회의 채팅 — DB 저장 + 채팅 룸 브로드캐스트 (허브/통화 공용). channelId 없으면 기본 채널 */
    socket.on(
      'chat:send',
      ({
        code,
        text,
        file,
        channelId,
      }: {
        code: string;
        text: string;
        file?: { name: string; url: string; size: number };
        channelId?: number;
      }) => {
        if (!code) return;
        if (!text?.trim() && !file) return;
        const upper = code.toUpperCase();
        const meeting = db.prepare('SELECT id FROM meetings WHERE code = ?').get(upper) as
          | { id: number }
          | undefined;
        if (!meeting) return;
        const channel = resolveChannel(meeting.id, channelId, socket.data.userId as number);
        if (channel == null) return; // 이 회의 소속이 아닌 채널이면 무시
        const trimmed = (text ?? '').slice(0, 2000);
        // 파일 정보 정제 (서버 업로드 URL만 허용)
        let fileJson: string | null = null;
        if (file && typeof file.url === 'string' && file.url.startsWith('/')) {
          fileJson = JSON.stringify({
            name: String(file.name ?? '파일').slice(0, 200),
            url: file.url,
            size: Number(file.size) || 0,
          });
        }
        db.prepare(
          'INSERT INTO messages (meeting_id, user_id, text, file, channel_id) VALUES (?, ?, ?, ?, ?)',
        ).run(meeting.id, socket.data.userId, trimmed, fileJson, channel);
        invalidateBriefForMeeting(meeting.id); // 안읽음 수가 바뀜 — 참가자 브리핑 갱신
        const u = db.prepare('SELECT avatar FROM users WHERE id = ?').get(socket.data.userId) as
          | { avatar: string | null }
          | undefined;
        io.to(`chat:${upper}`).emit('chat:message', {
          code: upper,
          from: socket.data.username,
          avatar: u?.avatar ?? null,
          text: trimmed,
          file: fileJson ? JSON.parse(fileJson) : undefined,
          channelId: channel,
          ts: Date.now(),
        });

        // @AI/@총무 멘션 — AI 총무가 그룹 기록을 근거로 답변 (비동기, 실패해도 채팅엔 영향 없음)
        if (AGENT_MENTION.test(trimmed)) {
          void handleAgentQuery(io, {
            meetingId: meeting.id,
            code: upper,
            channelId: channel,
            asker: socket.data.username as string,
            text: trimmed,
          }).catch((err) => console.error('[steward] 답변 실패:', err));
        } else {
          // 결정성 발언 감지 — 총무가 원장 기록을 제안 (사람이 버튼으로 확정, 2분 쿨다운)
          try {
            maybeSuggestDecision(io, {
              meetingId: meeting.id,
              code: upper,
              channelId: channel,
              from: socket.data.username as string,
              text: trimmed,
            });
          } catch (err) {
            console.error('[steward] 결정 제안 실패:', err);
          }
        }
      },
    );

    socket.on(
      'consume',
      async (
        {
          transportId,
          producerId,
          rtpCapabilities,
        }: { transportId: string; producerId: string; rtpCapabilities: RtpCapabilities },
        ack,
      ) => {
        if (!room || !peer) return ack({ error: '방에 입장하지 않았습니다' });
        if (!room.router.canConsume({ producerId, rtpCapabilities })) {
          return ack({ error: 'consume 불가 (코덱 불일치)' });
        }
        const transport = peer.transports.get(transportId);
        if (!transport) return ack({ error: 'transport 없음' });
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: true, // 클라이언트 준비 후 resume
        });
        peer.consumers.set(consumer.id, consumer);
        consumer.on('producerclose', () => {
          peer?.consumers.delete(consumer.id);
          socket.emit('producer:closed', { producerId, consumerId: consumer.id });
        });
        // 상대가 카메라/마이크를 일시정지하면 검은 화면 대신 플레이스홀더 표시용
        consumer.on('producerpause', () => socket.emit('producer:paused', { producerId }));
        consumer.on('producerresume', () => socket.emit('producer:resumed', { producerId }));
        ack({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        });
      },
    );

    socket.on('consumer:resume', async ({ consumerId }: { consumerId: string }, ack) => {
      const consumer = peer?.consumers.get(consumerId);
      if (!consumer) return ack({ error: 'consumer 없음' });
      await consumer.resume();
      ack({ ok: true });
    });

    /** 명시적 퇴장 — 대면 기록 모드처럼 소켓은 유지한 채 방만 나갈 때
     *  (마지막 사람이 나가면 disconnect와 동일하게 recap 스케줄) */
    socket.on('room:leave', () => {
      if (!room || !peer) return;
      for (const t of peer.transports.values()) t.close();
      room.peers.delete(socket.id);
      void socket.leave(`room:${room.code}`);
      socket.to(`room:${room.code}`).emit('peer:left', { peerId: socket.id });
      closeRoomIfEmpty(room);
      room = null;
      peer = null;
    });

    socket.on('disconnect', () => {
      if (!room || !peer) return;
      for (const t of peer.transports.values()) t.close();
      room.peers.delete(socket.id);
      socket.to(`room:${room.code}`).emit('peer:left', { peerId: socket.id });
      closeRoomIfEmpty(room);
    });
  });
}
