import React, { useState, useEffect } from 'react';
import { Row, Col, Button, Segmented, Spin, Progress, Tag } from 'antd';
import { BarChartOutlined, EditOutlined, CheckCircleOutlined, ClockCircleOutlined, CalendarOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, SectionLabel, StatTile } from '../components/FenbiUI';

const RANGES = [
  { label: '近7天', value: '7d' },
  { label: '近30天', value: '30d' },
  { label: '本月', value: 'month' },
];

function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '分' + (s % 60 ? (s % 60) + '秒' : '');
  return Math.floor(m / 60) + '小时' + (m % 60 ? (m % 60) + '分' : '');
}
function Delta({ value, unit = '', isPercent = false }) {
  if (value == null) return <span style={{ fontSize: 12, color: F.textWeak }}>暂无上期数据</span>;
  if (value === 0) return <span style={{ fontSize: 12, color: F.textWeak }}>与上期持平</span>;
  const up = value > 0;
  const text = isPercent ? Math.abs(Math.round(value * 100)) + '个百分点' : Math.abs(value) + unit;
  return <span style={{ fontSize: 12, color: up ? F.success : F.error }}>{up ? '↑' : '↓'} {text}</span>;
}

/** 六模块能力雷达：纯 SVG，无第三方图表库；无作答的模块显示为空轴 */
function Radar({ modules = [] }) {
  const cx = 150, cy = 140, R = 92, size = 300;
  const n = Math.max(3, modules.length);
  const angle = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i, r) => [cx + Math.cos(angle(i)) * r, cy + Math.sin(angle(i)) * r];
  const poly = (r) => Array.from({ length: n }, (_, i) => pt(i, r).map(v => v.toFixed(1)).join(',')).join(' ');
  const val = (m) => m.accuracy == null ? 0 : Math.max(0, Math.min(1, m.accuracy));
  const dataPoly = modules.map((m, i) => pt(i, R * val(m)).map(v => v.toFixed(1)).join(',')).join(' ');
  return (
    <svg viewBox={`0 0 ${size} 280`} style={{ width: '100%', maxWidth: 360, display: 'block', margin: '0 auto' }} role="img" aria-label="六模块能力雷达图">
      {[0.25, 0.5, 0.75, 1].map(k => (
        <polygon key={k} points={poly(R * k)} fill="none" stroke={F.border} strokeWidth="1" />
      ))}
      {modules.map((m, i) => {
        const [x, y] = pt(i, R);
        return <line key={`axis-${m.categoryId}`} x1={cx} y1={cy} x2={x} y2={y} stroke={F.border} strokeWidth="1" />;
      })}
      <polygon points={dataPoly} fill={F.primary} fillOpacity="0.18" stroke={F.primary} strokeWidth="2" />
      {modules.map((m, i) => {
        const [x, y] = pt(i, R * val(m));
        const [lx, ly] = pt(i, R + 28);
        const anchor = lx > cx + 8 ? 'start' : lx < cx - 8 ? 'end' : 'middle';
        return (
          <g key={m.categoryId}>
            <circle cx={x} cy={y} r="2.8" fill={F.primary} />
            <text x={lx} y={ly} textAnchor={anchor} dominantBaseline="middle" fontSize="11" fill={F.textWeak}>
              {m.name} {m.accuracy == null ? '—' : Math.round(m.accuracy * 100) + '%'}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 按日：柱=做题量，折线=正确率，无数据日不画 0% 折点 */
function DailyChart({ daily = [] }) {
  if (!daily.length) return null;
  const w = 700, h = 200, padL = 28, padR = 14, padT = 14, padB = 30;
  const innerW = w - padL - padR, innerH = h - padT - padB;
  const maxQ = Math.max(1, ...daily.map(d => d.questions));
  const bw = innerW / daily.length;
  const barW = Math.max(2, Math.min(26, bw * 0.55));
  const x = (i) => padL + i * bw + bw / 2;
  const yQ = (v) => padT + innerH - (v / maxQ) * innerH;
  const yA = (v) => padT + innerH - (v == null ? 0 : v) * innerH;
  const withAcc = daily.map((d, i) => ({ ...d, i })).filter(d => d.accuracy != null);
  const line = withAcc.map((d, k) => `${k === 0 ? 'M' : 'L'}${x(d.i).toFixed(1)},${yA(d.accuracy).toFixed(1)}`).join(' ');
  const every = Math.ceil(daily.length / 8);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%' }} role="img" aria-label="按日做题量与正确率趋势">
      <line x1={padL} y1={padT + innerH} x2={w - padR} y2={padT + innerH} stroke={F.border} strokeWidth="1" />
      {daily.map((d, i) => (
        <rect key={d.date} x={x(i) - barW / 2} y={yQ(d.questions)} width={barW}
          height={Math.max(0, padT + innerH - yQ(d.questions))} rx="2" fill={F.primaryLight || F.primary} opacity="0.55" />
      ))}
      {line && <path d={line} fill="none" stroke={F.error} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {withAcc.map((d) => <circle key={`p-${d.date}`} cx={x(d.i)} cy={yA(d.accuracy)} r="2.6" fill={F.error} />)}
      {daily.map((d, i) => (i % every === 0 || i === daily.length - 1) ? (
        <text key={`t-${d.date}`} x={x(i)} y={h - 8} textAnchor="middle" fontSize="10" fill={F.textWeak}>
          {d.date.slice(5)}
        </text>
      ) : null)}
    </svg>
  );
}

export default function Report() {
  const [range, setRange] = useState('7d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { isMobile } = useResponsive();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get('/practice/report', { params: { range } })
      .then((r) => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [range]);

  const cur = data?.current || {};
  const delta = data?.delta || {};
  const hasData = Number(cur.questions) > 0;

  return (
    <FenbiScope>
      <PageHead
        title="学习报告"
        icon={<BarChartOutlined />}
        desc="按时间窗查看做题量、正确率与模块能力"
        extra={<Button type="primary" icon={<EditOutlined />} onClick={() => navigate('/practice')}>去练习</Button>}
      />

      <div style={{ marginBottom: 16 }}>
        <Segmented value={range} options={RANGES} onChange={setRange} />
        {data && <span style={{ marginLeft: 12, fontSize: 12, color: F.textWeak }}>{data.from} ~ {data.to}</span>}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 64 }}><Spin size="large" /></div>
      ) : !data ? (
        <Panel bodyStyle={{ padding: 32, textAlign: 'center' }}><div className="fb-empty">报告加载失败</div></Panel>
      ) : (
        <>
          <SectionLabel title="本期概览" />
          <Row gutter={[isMobile ? 8 : 16, isMobile ? 8 : 16]}>
            <Col xs={12} md={6}><StatTile icon={<EditOutlined />} label="答题量" value={cur.questions || 0} unit="题" /><div style={{ textAlign: 'center', marginTop: 4 }}><Delta value={delta.questions} unit="题" /></div></Col>
            <Col xs={12} md={6}><StatTile icon={<CheckCircleOutlined />} label="正确率" value={cur.accuracy == null ? '—' : Math.round(cur.accuracy * 100)} unit={cur.accuracy == null ? '' : '%'} tone="success" /><div style={{ textAlign: 'center', marginTop: 4 }}><Delta value={delta.accuracy} isPercent /></div></Col>
            <Col xs={12} md={6}><StatTile icon={<ClockCircleOutlined />} label="学习时长" value={fmtDuration(cur.durationSec)} /><div style={{ textAlign: 'center', marginTop: 4 }}><Delta value={delta.durationSec == null ? null : Math.round(delta.durationSec / 60)} unit="分" /></div></Col>
            <Col xs={12} md={6}><StatTile icon={<CalendarOutlined />} label="练习天数" value={cur.activeDays || 0} unit={`/ ${data.days} 天`} tone="neutral" /><div style={{ textAlign: 'center', marginTop: 4 }}><Delta value={delta.sessions} unit="次" /></div></Col>
          </Row>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tag color="blue">全站平均正确率 {pct(data.site?.accuracy)}</Tag>
            <Tag>本期练习 {cur.sessions || 0} 次</Tag>
            <Tag>全站参与 {data.site?.users || 0} 人</Tag>
          </div>

          <div style={{ height: isMobile ? 16 : 24 }} />
          <SectionLabel title="按日趋势" />
          <Panel bodyStyle={{ padding: isMobile ? 12 : 16 }}>
            <div style={{ display: 'flex', gap: 14, marginBottom: 8, fontSize: 12, color: F.textWeak }}>
              <span>柱：做题量（峰值 {Math.max(1, ...(data.daily || []).map(d => d.questions))} 题）</span>
              <span>线：正确率</span>
            </div>
            <DailyChart daily={data.daily || []} />
          </Panel>

          <div style={{ height: isMobile ? 16 : 24 }} />
          <SectionLabel title="六模块能力" />
          <Row gutter={[16, 16]}>
            <Col xs={24} md={10}>
              <Panel bodyStyle={{ padding: isMobile ? 12 : 16 }}><Radar modules={data.modules || []} /></Panel>
            </Col>
            <Col xs={24} md={14}>
              <Panel bodyStyle={{ padding: isMobile ? 12 : 16 }}>
                {(data.modules || []).map((m) => (
                  <div key={m.categoryId} style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0',
                    borderBottom: `1px solid ${F.border}`, flexWrap: 'wrap',
                  }}>
                    <div style={{ width: isMobile ? 88 : 108, flexShrink: 0, fontSize: 13, color: F.text }}>
                      {m.name}{m.lowSample && m.attempts > 0 && <Tag style={{ marginLeft: 4 }}>样本少</Tag>}
                    </div>
                    <div style={{ flex: 1, minWidth: 60 }}>
                      <Progress percent={m.accuracy == null ? 0 : Math.round(m.accuracy * 100)} showInfo={false} size="small"
                        strokeColor={m.accuracy == null ? F.border : m.accuracy >= 0.8 ? F.success : m.accuracy >= 0.6 ? F.primary : F.error} />
                    </div>
                    <div style={{ width: 48, textAlign: 'right', fontSize: 13, color: m.accuracy == null ? F.textWeak : F.text }}>{pct(m.accuracy)}</div>
                    {!isMobile && <div style={{ width: 86, textAlign: 'right', fontSize: 12, color: F.textWeak }}>全站 {pct(m.siteAccuracy)}</div>}
                    <div style={{ width: 62, textAlign: 'right', fontSize: 12, color: F.textWeak }}>{m.attempts} 题</div>
                    {!isMobile && <div style={{ width: 74, textAlign: 'right', fontSize: 12, color: F.textWeak }}>{m.avgTimeSec == null ? '—' : m.avgTimeSec + '秒/题'}</div>}
                  </div>
                ))}
              </Panel>
            </Col>
          </Row>

          {!hasData && (
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <Button type="primary" onClick={() => navigate('/practice/do?pool=question&count=10')}>开始练习</Button>
            </div>
          )}
        </>
      )}
    </FenbiScope>
  );
}
