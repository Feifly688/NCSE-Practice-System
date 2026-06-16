import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Button, Space, Skeleton } from 'antd';
import {
  EditOutlined, TrophyOutlined, UserOutlined, BookOutlined,
  EyeOutlined, FireOutlined, ReadOutlined, SafetyOutlined, HistoryOutlined, StarOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { CardStack, CardStackItem } from '../components/ui/card-stack';
import { SpiralAnimation } from '../components/ui/spiral-animation';
import { GlowCard } from '../components/ui/spotlight-card';
import { FeatureCard } from '../components/ui/grid-feature-cards';

const { Title, Paragraph } = Typography;

// ─── CardStack images (matching each card's theme) ───
const CARD_IMAGES = [
  'https://images.unsplash.com/photo-1504711434969-e33886168d8c?w=640&h=420&fit=crop', // 权威来源 - newspaper
  'https://images.unsplash.com/photo-1513258496099-48168024aec0?w=640&h=420&fit=crop', // 智能练习 - studying
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=640&h=420&fit=crop', // 答题历史 - analytics
  'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=640&h=420&fit=crop', // 错题本 - notebook
  'https://images.unsplash.com/photo-1555949963-aa79dcee981c?w=640&h=420&fit=crop', // 数据安全 - security
];

const stackItems: CardStackItem[] = [
  {
    id: 1,
    title: '权威来源',
    description: '题目基于人民日报、新华社等权威内容生成，确保内容质量与时事同步。',
    imageSrc: CARD_IMAGES[0],
  },
  {
    id: 2,
    title: '智能练习',
    description: 'AI 自适应出题，覆盖言语理解与政治模块，难度智能匹配。',
    imageSrc: CARD_IMAGES[1],
  },
  {
    id: 3,
    title: '答题历史',
    description: '记录每次答题数据，多维分析薄弱环节，针对性提高。',
    imageSrc: CARD_IMAGES[2],
  },
  {
    id: 4,
    title: '错题本 & 收藏',
    description: '自动收集错题，支持收藏好题，循环巩固知识点。',
    imageSrc: CARD_IMAGES[3],
  },
  {
    id: 5,
    title: '数据安全',
    description: '个人数据隔离存储，答题记录仅自己可见，隐私无忧。',
    imageSrc: CARD_IMAGES[4],
  },
];

// ─── GlowCard color map ───
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
    return (
      <div style={{ backdropFilter: 'blur(5px)', borderRadius: 14, border: '3px solid rgba(255,255,255,0.08)', padding: 20, background: 'hsl(0 0% 60% / 0.12)' }}>
        <Skeleton active paragraph={{ rows: 1 }} />
      </div>
    );
  }
  return (
    <GlowCard glowColor={glow || 'blue'} customSize className="!h-auto !w-full !p-5 !grid !grid-rows-none">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 30, color: color || '#1D4ED8', flexShrink: 0 }}>{icon}</div>
        <div>
          <div style={{ fontSize: 13, color: 'rgba(0,0,0,0.5)', marginBottom: 2 }}>{title}</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#1a1a1a', lineHeight: 1.2 }}>{value}</div>
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
  if (loading) return <Card title="📈 近7天答题趋势" style={{ borderRadius: 12 }}><Skeleton active paragraph={{ rows: 3 }} /></Card>;
  if (!data || data.length === 0) return null;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  return (
    <Card title="📈 近7天答题趋势" style={{ borderRadius: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 140, padding: '0 12px' }}>
        {data.map((item, idx) => (
          <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 12, color: '#666', fontWeight: 500 }}>{item.count}</div>
            <div style={{ width: '65%', maxWidth: 48, height: `${Math.max((item.count / maxCount) * 100, 6)}px`, background: 'linear-gradient(180deg, #1D4ED8 0%, #3B82F6 100%)', borderRadius: '6px 6px 0 0', transition: 'height 0.3s ease', minHeight: 6 }} />
            <div style={{ fontSize: 11, color: '#999' }}>{item.date}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [heroVisible, setHeroVisible] = useState(false);

  useEffect(() => {
    fetchStats();
    recordVisit();
    const timer = setTimeout(() => setHeroVisible(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  async function fetchStats() {
    try { const res = await api.get('/stats/public'); setStats(res.data); }
    catch (err) { console.error('Failed to load stats:', err); }
    finally { setLoading(false); }
  }

  async function recordVisit() {
    try {
      const lastVisit = sessionStorage.getItem('lastVisitTime');
      const now = Date.now();
      if (lastVisit && now - Number(lastVisit) < 3 * 60 * 60 * 1000) return;
      await api.post('/stats/visit');
      sessionStorage.setItem('lastVisitTime', String(now));
    } catch { /* silent */ }
  }

  const features = [
    { title: '权威来源', icon: ReadOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '题目基于人民日报、新华社等权威内容生成' },
    { title: '智能练习', icon: EditOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '支持言语理解等模块，随机出题自主练习' },
    { title: '答题历史', icon: HistoryOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '记录每次答题数据，分析薄弱环节' },
    { title: '数据安全', icon: SafetyOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '个人数据隔离存储，答题记录仅自己可见' },
  ];

  return (
    <div>
      {/* ═══════════ HERO ═══════════ */}
      <section style={{ position: 'relative', height: '100vh', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
        <SpiralAnimation />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.7) 100%)', zIndex: 1 }} />
        <div style={{ position: 'relative', zIndex: 2, textAlign: 'center', color: '#fff', padding: '0 24px', maxWidth: 800, opacity: heroVisible ? 1 : 0, transform: heroVisible ? 'translateY(0)' : 'translateY(20px)', transition: 'opacity 1.5s ease-out, transform 1.5s ease-out' }}>
          <h1 style={{ fontSize: 48, fontWeight: 700, marginBottom: 16, letterSpacing: '0.05em', color: '#fff' }}>公务员考试刷题系统</h1>
          <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.7)', marginBottom: 40, letterSpacing: '0.1em', fontWeight: 300 }}>基于权威素材的智能命题与练习平台</p>
          <Space size="middle">
            {isAuthenticated ? (
              <Button type="primary" size="large" onClick={() => navigate('/practice')} style={{ height: 48, padding: '0 36px', fontSize: 16, borderRadius: 24, background: '#fff', color: '#000', border: 'none', fontWeight: 600 }}>开始练习</Button>
            ) : (
              <>
                <Button type="primary" size="large" onClick={() => navigate('/register')} style={{ height: 48, padding: '0 36px', fontSize: 16, borderRadius: 24, background: '#fff', color: '#000', border: 'none', fontWeight: 600 }}>免费注册</Button>
                <Button size="large" onClick={() => navigate('/login')} style={{ height: 48, padding: '0 36px', fontSize: 16, borderRadius: 24, background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,0.4)' }}>登录</Button>
              </>
            )}
          </Space>
        </div>
        {/* Scroll indicator */}
        <div style={{ position: 'absolute', bottom: 32, left: '50%', transform: 'translateX(-50%)', zIndex: 2, opacity: heroVisible ? 1 : 0, transition: 'opacity 2s ease-out 1.5s', animation: 'bounce 2s infinite', color: 'rgba(255,255,255,0.5)', fontSize: 12, letterSpacing: '0.2em', textTransform: 'uppercase' }}>
          <div style={{ marginBottom: 8 }}>Scroll</div>
          <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.3)', margin: '0 auto' }} />
        </div>
      </section>

      {/* ═══════════ CONTENT ═══════════ */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '48px 20px' }}>

        {/* ─── 1. Stats Cards (GlowCard) ─── */}
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={8} md={4}><StatCard icon={<EditOutlined />} title="今日答题" value={stats?.todayAnswers ?? '-'} {...colorMap.todayAnswers} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<TrophyOutlined />} title="今日正确率" value={stats?.todayCorrectRate ? `${stats.todayCorrectRate}%` : '-'} {...colorMap.todayCorrectRate} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<UserOutlined />} title="注册用户" value={stats?.totalUsers ?? '-'} {...colorMap.totalUsers} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<BookOutlined />} title="题库总数" value={stats?.totalQuestions ?? '-'} {...colorMap.totalQuestions} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<EyeOutlined />} title="总访问量" value={stats?.totalVisits ?? '-'} {...colorMap.totalVisits} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<FireOutlined />} title="今日访问" value={stats?.todayVisits ?? '-'} {...colorMap.todayVisits} loading={loading} /></Col>
        </Row>

        {/* ─── 2. Feature Cards (grid-feature-cards) ─── */}
        <div style={{ marginTop: 56, marginBottom: 16 }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <Title level={3}>功能介绍</Title>
            <Paragraph type="secondary" style={{ fontSize: 14 }}>四大核心能力，助你高效备考</Paragraph>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', border: '1px dashed #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            {features.map((f, i) => (
              <div key={i} style={{ borderRight: i % 2 === 0 ? '1px dashed #e5e7eb' : 'none', borderBottom: '1px dashed #e5e7eb' }}>
                <FeatureCard feature={f} />
              </div>
            ))}
          </div>
        </div>

        {/* ─── 3. CardStack (3D fan) ─── */}
        <div style={{ marginTop: 56, marginBottom: 16 }}>
          <div style={{ textAlign: 'center', marginBottom: 32 }}>
            <Title level={3}>平台亮点</Title>
            <Paragraph type="secondary" style={{ fontSize: 14 }}>滑动卡片浏览，点击查看详情</Paragraph>
          </div>
          <CardStack items={stackItems} initialIndex={2} autoAdvance intervalMs={3000} pauseOnHover showDots loop />
        </div>

        {/* ─── 4. Week Trend ─── */}
        <div style={{ marginTop: 40 }}>
          <WeekTrend data={stats?.weekTrend} loading={loading} />
        </div>

        <div style={{ height: 48 }} />
      </div>

      <style>{`@keyframes bounce {0%,100%{transform:translateX(-50%) translateY(0)} 50%{transform:translateX(-50%) translateY(8px)}}`}</style>
    </div>
  );
}
