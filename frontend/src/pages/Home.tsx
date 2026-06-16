import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Button, Space, Skeleton } from 'antd';
import {
  EditOutlined, TrophyOutlined, UserOutlined, BookOutlined,
  EyeOutlined, FireOutlined, ReadOutlined, SafetyOutlined, HistoryOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { CardStack, CardStackItem } from '../components/ui/card-stack';
import { SpiralAnimation } from '../components/ui/spiral-animation';
import { GlowCard } from '../components/ui/spotlight-card';

const CARD_IMAGES = [
  'https://images.unsplash.com/photo-1504711434969-e33886168d8c?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1513258496099-48168024aec0?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=640&h=420&fit=crop',
];

const stackItems: CardStackItem[] = [
  { id: 1, title: '权威来源', description: '题目基于人民日报、新华社等权威内容生成，确保内容质量与时事同步。', imageSrc: CARD_IMAGES[0] },
  { id: 2, title: '智能练习', description: 'AI 自适应出题，覆盖言语理解与政治模块，难度智能匹配。', imageSrc: CARD_IMAGES[1] },
  { id: 3, title: '答题历史', description: '记录每次答题数据，多维分析薄弱环节，针对性提高。', imageSrc: CARD_IMAGES[2] },
  { id: 4, title: '错题本 & 收藏', description: '自动收集错题，支持收藏好题，循环巩固知识点。', imageSrc: CARD_IMAGES[3] },
  { id: 5, title: '数据安全', description: '个人数据隔离存储，答题记录仅自己可见，隐私无忧。', imageSrc: CARD_IMAGES[4] },
];

const colorMap: Record<string, { color: string; glow: 'blue' | 'purple' | 'green' | 'red' | 'orange' }> = {
  todayAnswers: { color: '#1D4ED8', glow: 'blue' },
  todayCorrectRate: { color: '#059669', glow: 'green' },
  totalUsers: { color: '#7C3AED', glow: 'purple' },
  totalQuestions: { color: '#DC2626', glow: 'red' },
  totalVisits: { color: '#0891B2', glow: 'blue' },
  todayVisits: { color: '#EA580C', glow: 'orange' },
};

function StatCard({ icon, title, value, color, glow, loading }: {
  icon: React.ReactNode; title: string; value: string | number;
  color?: string; glow?: 'blue' | 'purple' | 'green' | 'red' | 'orange'; loading?: boolean;
}) {
  if (loading) {
    return <div style={{ backdropFilter: 'blur(5px)', borderRadius: 14, border: '3px solid rgba(255,255,255,0.08)', padding: 20, background: 'hsl(0 0% 60% / 0.12)' }}><Skeleton active paragraph={{ rows: 1 }} /></div>;
  }
  return (
    <GlowCard glowColor={glow || 'blue'} customSize className="!h-auto !w-full !p-5 !grid !grid-rows-none">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 30, color: color || '#1D4ED8', flexShrink: 0 }}>{icon}</div>
        <div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>{title}</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>{value}</div>
        </div>
      </div>
    </GlowCard>
  );
}

interface TrendItem { date: string; count: number; }
interface Stats {
  todayAnswers?: number; todayCorrectRate?: number; totalUsers?: number;
  totalQuestions?: number; totalVisits?: number; todayVisits?: number; weekTrend?: TrendItem[];
}

function WeekTrend({ data, loading }: { data?: TrendItem[]; loading?: boolean }) {
  if (loading) return <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 24, border: '1px solid rgba(255,255,255,0.08)' }}><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (!data || data.length === 0) return null;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 24, border: '1px solid rgba(255,255,255,0.08)' }}>
      <h3 style={{ color: '#fff', fontSize: 16, marginBottom: 20, margin: 0 }}>📈 近7天答题趋势</h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 140, padding: '0 12px' }}>
        {data.map((item, idx) => (
          <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>{item.count}</div>
            <div style={{ width: '65%', maxWidth: 48, height: `${Math.max((item.count / maxCount) * 100, 6)}px`, background: 'linear-gradient(180deg, #60A5FA 0%, #3B82F6 100%)', borderRadius: '6px 6px 0 0', transition: 'height 0.3s ease', minHeight: 6 }} />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{item.date}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    fetchStats();
    recordVisit();
    setTimeout(() => setVisible(true), 500);
  }, []);

  async function fetchStats() {
    try { const res = await api.get('/stats/public'); setStats(res.data); }
    catch { /* */ }
    finally { setLoading(false); }
  }

  async function recordVisit() {
    try {
      const last = sessionStorage.getItem('lastVisitTime');
      const now = Date.now();
      if (last && now - Number(last) < 3 * 60 * 60 * 1000) return;
      await api.post('/stats/visit');
      sessionStorage.setItem('lastVisitTime', String(now));
    } catch { /* */ }
  }

  const features = [
    { title: '权威来源', icon: ReadOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '题目基于人民日报、新华社等权威内容生成' },
    { title: '智能练习', icon: EditOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '支持言语理解等模块，随机出题自主练习' },
    { title: '答题历史', icon: HistoryOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '记录每次答题数据，分析薄弱环节' },
    { title: '数据安全', icon: SafetyOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '个人数据隔离存储，答题记录仅自己可见' },
  ];

  return (
    <div style={{ position: 'relative', minHeight: '100vh', background: '#0a0a0f', overflow: 'hidden' }}>
      {/* Fixed spiral background */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 0 }}>
        <SpiralAnimation />
      </div>
      {/* Dark overlay - denser at bottom */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 1, background: 'linear-gradient(180deg, rgba(10,10,15,0.3) 0%, rgba(10,10,15,0.92) 100%)', pointerEvents: 'none' }} />

      {/* Scrollable content */}
      <div style={{ position: 'relative', zIndex: 2, maxWidth: 1100, margin: '0 auto', padding: '60px 20px 60px', opacity: visible ? 1 : 0, transition: 'opacity 1s ease-out' }}>

        {/* ─── Hero ─── */}
        <div style={{ textAlign: 'center', padding: '30px 0 50px' }}>
          <h1 style={{ fontSize: 44, fontWeight: 700, marginBottom: 12, letterSpacing: '0.05em', color: '#fff', lineHeight: 1.2 }}>公务员考试刷题系统</h1>
          <p style={{ fontSize: 16, color: 'rgba(255,255,255,0.5)', marginBottom: 36, letterSpacing: '0.1em', fontWeight: 300 }}>基于权威素材的智能命题与练习平台</p>
          <Space size="middle">
            {isAuthenticated ? (
              <Button size="large" onClick={() => navigate('/practice')} style={{ height: 46, padding: '0 36px', fontSize: 15, borderRadius: 23, background: '#fff', color: '#0a0a0f', border: 'none', fontWeight: 600 }}>开始练习</Button>
            ) : (
              <>
                <Button size="large" onClick={() => navigate('/register')} style={{ height: 46, padding: '0 36px', fontSize: 15, borderRadius: 23, background: '#fff', color: '#0a0a0f', border: 'none', fontWeight: 600 }}>免费注册</Button>
                <Button size="large" onClick={() => navigate('/login')} style={{ height: 46, padding: '0 36px', fontSize: 15, borderRadius: 23, background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>登录</Button>
              </>
            )}
          </Space>
        </div>

        {/* ─── Stats ─── */}
        <Row gutter={[14, 14]} style={{ marginBottom: 50 }}>
          <Col xs={12} sm={8} md={4}><StatCard icon={<EditOutlined />} title="今日答题" value={stats?.todayAnswers ?? '-'} {...colorMap.todayAnswers} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<TrophyOutlined />} title="今日正确率" value={stats?.todayCorrectRate ? `${stats.todayCorrectRate}%` : '-'} {...colorMap.todayCorrectRate} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<UserOutlined />} title="注册用户" value={stats?.totalUsers ?? '-'} {...colorMap.totalUsers} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<BookOutlined />} title="题库总数" value={stats?.totalQuestions ?? '-'} {...colorMap.totalQuestions} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<EyeOutlined />} title="总访问量" value={stats?.totalVisits ?? '-'} {...colorMap.totalVisits} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<FireOutlined />} title="今日访问" value={stats?.todayVisits ?? '-'} {...colorMap.todayVisits} loading={loading} /></Col>
        </Row>

        {/* ─── Feature Cards ─── */}
        <div style={{ marginBottom: 50 }}>
          <h2 style={{ textAlign: 'center', fontSize: 26, fontWeight: 700, color: '#fff', marginBottom: 6 }}>功能介绍</h2>
          <p style={{ textAlign: 'center', fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 28, marginTop: 0 }}>四大核心能力，助你高效备考</p>
          <div className="features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden', background: 'rgba(255,255,255,0.02)' }}>
            {features.map((f, i) => (
              <div key={i} style={{ padding: '28px 24px', borderRight: i % 2 === 0 ? '1px solid rgba(255,255,255,0.08)' : 'none', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize: 28, marginBottom: 16, opacity: 0.7 }}>
                  {React.createElement(f.icon, { style: { color: '#fff' } })}</div>
                <h3 style={{ color: '#fff', fontSize: 15, fontWeight: 600, margin: '0 0 8px 0' }}>{f.title}</h3>
                <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, margin: 0, lineHeight: 1.6 }}>{f.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ─── CardStack ─── */}
        <div style={{ marginBottom: 50 }}>
          <h2 style={{ textAlign: 'center', fontSize: 26, fontWeight: 700, color: '#fff', marginBottom: 6 }}>平台亮点</h2>
          <p style={{ textAlign: 'center', fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: 28, marginTop: 0 }}>滑动卡片浏览，点击切换</p>
          <CardStack items={stackItems} initialIndex={2} autoAdvance intervalMs={3000} pauseOnHover showDots loop />
        </div>

        {/* ─── Trend ─── */}
        <WeekTrend data={stats?.weekTrend} loading={loading} />

      </div>
    </div>
  );
}
