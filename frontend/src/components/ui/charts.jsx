import React from 'react';
import { useResponsive } from '../../hooks/useResponsive';

/**
 * 轻量 SVG 图表（无第三方依赖，避免引入 echarts 等大包）。
 * 风格与仪表盘浅色卡片一致：主色 #1D4ED8，正向 #059669，警示 #DC2626。
 */

/** 环形进度：正确率等单一百分比指标 */
export function DonutChart({ percent = 0, size = 132, stroke = 14, color = '#1D4ED8', track = '#eef2ff', children }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const offset = c * (1 - pct / 100);
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset .8s ease' }}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 2,
      }}>
        {children}
      </div>
    </div>
  );
}

/** 折线趋势图：成绩变化 + 面积渐变 + 及格参考线 */
export function TrendLine({ points = [], height = 190, passLine = 60 }) {
  const { isMobile } = useResponsive();
  const data = points.map((p) => Number(p.score) || 0);
  if (data.length === 0) return null;

  const w = 100; // 使用 viewBox 百分比坐标系，自适应容器宽度
  const h = 100;
  const pad = 8;
  const max = Math.max(100, ...data);
  const min = 0;
  const x = (i) => (data.length === 1 ? 50 : (i / (data.length - 1)) * (w - pad * 2) + pad);
  const y = (v) => h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);

  const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(2)},${(h - pad).toFixed(2)} L${x(0).toFixed(2)},${(h - pad).toFixed(2)} Z`;
  const last = data[data.length - 1];

  return (
    <div style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        <defs>
          <linearGradient id="trend-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1D4ED8" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#1D4ED8" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* 及格参考线 */}
        <line x1={pad} y1={y(passLine)} x2={w - pad} y2={y(passLine)} stroke="#DC2626" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.5" />
        <path d={area} fill="url(#trend-area)" />
        <path d={line} fill="none" stroke="#1D4ED8" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {data.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r="1.4" fill={v >= passLine ? '#059669' : '#DC2626'} />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: '#94a3b8' }}>
        <span>{points[0]?.started_at ? new Date(points[0].started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</span>
        <span style={{ color: '#475569', fontWeight: 600 }}>最近一次 {last} 分</span>
        <span>{points[points.length - 1]?.started_at ? new Date(points[points.length - 1].started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</span>
      </div>
      {isMobile && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>虚线为 60 分及格线</div>}
    </div>
  );
}

/** 模块（科目）表现条形图 */
export function ModuleBars({ items = [] }) {
  if (items.length === 0) return <div style={{ color: '#94a3b8', fontSize: 13 }}>暂无模块数据</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {items.map((m, i) => {
        const total = Number(m.questions) || 0;
        const correct = Number(m.correct) || 0;
        const rate = total > 0 ? Math.round((correct / total) * 100) : 0;
        const color = rate >= 80 ? '#059669' : rate >= 60 ? '#1D4ED8' : '#DC2626';
        return (
          <div key={m.slug || m.name || i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
              <span style={{ color: '#334155' }}>{m.name || '未分类'}</span>
              <span style={{ color: '#64748b' }}>
                {rate}% <span style={{ color: '#94a3b8' }}>({correct}/{total})</span>
              </span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: '#f1f5f9', overflow: 'hidden' }}>
              <div style={{
                width: `${rate}%`, height: '100%', borderRadius: 999, background: color,
                transition: 'width .8s ease',
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
