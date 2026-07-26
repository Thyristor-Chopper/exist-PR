import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';

/*
 * AI 팀 인사이트 패널 — 조직의 협업 데이터(회의·할 일·통화·채팅)를
 * 서버(/api/insights/:orgId)에서 집계+AI 분석한 결과를 보여준다.
 * 조직도 페이지(OrgChartPage) 상단에 표시.
 */

interface Metrics {
  orgName: string;
  periodDays: number;
  memberCount: number;
  meetingCount: number;
  todos: { total: number; done: number; overdue: number; completionRate: number };
  calls: { count: number; totalMinutes: number };
  activity: { calls: number; messages: number };
  participation: { username: string; messages: number }[];
  quietMembers: string[];
  esg: { replacedCommutes: number; savedKm: number; savedCo2Kg: number; savedHours: number };
}
interface Insights {
  summary: string;
  trend: string;
  burnoutRisk: { level: string; reason: string };
  delayRisk: { level: string; reason: string };
  risks: string[];
  recommendations: string[];
}
interface Resp {
  metrics: Metrics;
  insights: Insights;
  source: string;
}

export default function InsightsPanel({ orgId }: { orgId: number }) {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr(false);
    api<Resp>(`/api/insights/${orgId}`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [orgId]);

  if (err) return null;
  if (!data) return <section style={box}>🧠 AI 팀 인사이트 분석 중…</section>;

  const { metrics: m, insights: ins, source } = data;
  const activeMembers = m.memberCount - m.quietMembers.length;

  return (
    <section style={box}>
      <div style={head}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>🧠 AI 팀 인사이트</span>
        <span style={badge}>
          {source === 'ai' ? 'AI 분석' : '규칙 기반'} · 최근 {m.periodDays}일
        </span>
      </div>

      <p style={{ margin: '10px 0 14px', lineHeight: 1.6, color: 'var(--text)' }}>{ins.summary}</p>

      {ins.trend && <div style={trendBox}>📈 {ins.trend}</div>}

      <div style={predGrid}>
        <RiskCard label="번아웃 위험 예측" data={ins.burnoutRisk} />
        <RiskCard label="일정 지연 위험 예측" data={ins.delayRisk} />
      </div>

      <div style={grid}>
        <Stat
          label="할 일 완료율"
          value={`${m.todos.completionRate}%`}
          sub={`${m.todos.done}/${m.todos.total}`}
        />
        <Stat label="그룹" value={`${m.meetingCount}`} sub="개" />
        <Stat
          label="통화"
          value={`${m.calls.count}회`}
          sub={m.calls.totalMinutes ? `${m.calls.totalMinutes}분` : ''}
        />
        <Stat label="활동 멤버" value={`${activeMembers}/${m.memberCount}`} sub="명" />
      </div>

      {ins.risks.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={sectTitle}>⚠️ 리스크</div>
          {ins.risks.map((r, i) => (
            <div key={i} style={riskItem}>
              {r}
            </div>
          ))}
        </div>
      )}

      {ins.recommendations.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={sectTitle}>💡 추천</div>
          {ins.recommendations.map((r, i) => (
            <div key={i} style={recItem}>
              {r}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div style={sectTitle}>🌱 ESG · 원격근무 사회적 가치 (추정)</div>
        <div style={grid}>
          <Stat value={`${m.esg.savedCo2Kg}kg`} label="CO₂ 절감" />
          <Stat value={`${m.esg.savedKm}km`} label="통근거리 절감" />
          <Stat value={`${m.esg.savedHours}h`} label="통근시간 절감" />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-sub)', marginTop: 8, lineHeight: 1.5 }}>
          * 원격 회의 참여 {m.esg.replacedCommutes}일(person-day) 기준 추정. 왕복 17.3km·73분(2024
          통신3사), 승용차 125.2g CO₂/km(환경부·국립환경과학원 2020). 통근 대체 가정에 따른 추정치.
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={stat}>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#21C818' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 2 }}>
        {label}
        {sub ? ` ${sub}` : ''}
      </div>
    </div>
  );
}

function RiskCard({ label, data }: { label: string; data: { level: string; reason: string } }) {
  const color = data.level === '높음' ? '#e5484d' : data.level === '보통' ? '#f76808' : '#21C818';
  const bg =
    data.level === '높음'
      ? 'rgba(229,72,77,0.07)'
      : data.level === '보통'
        ? 'rgba(247,104,8,0.08)'
        : 'rgba(33,200,24,0.07)';
  return (
    <div style={{ background: bg, borderRadius: 11, padding: '12px 14px' }}>
      <div style={{ fontSize: 12, color: 'var(--text-sub)', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color }}>{data.level}</div>
      <div style={{ fontSize: 12, color: 'var(--text-sub)', marginTop: 3 }}>{data.reason}</div>
    </div>
  );
}

const box: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  margin: 0, // 아래 간격은 부모 컬럼(gap)이 책임 — 자체 마진 주면 이중 간격
  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};
const badge: CSSProperties = {
  fontSize: 12,
  color: '#21C818',
  background: 'rgba(33,200,24,0.1)',
  borderRadius: 8,
  padding: '3px 8px',
  fontWeight: 600,
};
const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))',
  gap: 10,
};
const trendBox: CSSProperties = {
  background: 'var(--bg)',
  borderRadius: 9,
  padding: '9px 13px',
  fontSize: 13,
  color: 'var(--text-sub)',
  marginBottom: 12,
};
const predGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 10,
  marginBottom: 16,
};
const stat: CSSProperties = {
  background: 'var(--bg)',
  borderRadius: 10,
  padding: '12px 14px',
  textAlign: 'center',
};
const sectTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  marginBottom: 6,
  color: 'var(--text-sub)',
};
const riskItem: CSSProperties = {
  fontSize: 13,
  color: '#c0392b',
  background: 'rgba(229,72,77,0.08)',
  borderRadius: 8,
  padding: '7px 10px',
  marginBottom: 6,
};
const recItem: CSSProperties = {
  fontSize: 13,
  color: '#1a7f37',
  background: 'rgba(33,200,24,0.08)',
  borderRadius: 8,
  padding: '7px 10px',
  marginBottom: 6,
};
