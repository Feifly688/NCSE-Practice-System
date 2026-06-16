import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Button, Space, Skeleton } from 'antd';
import {
  EditOutlined, TrophyOutlined, UserOutlined, BookOutlined,
  EyeOutlined, FireOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { CardStack, CardStackItem } from '../components/ui/card-stack';

const { Title, Paragraph } = Typography;

const CARD_IMAGES = [
  'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1503676260728-1c00da094a0b?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=640&h=420&fit=crop',
  'https://images.unsplash.com/photo-1522202176988-66273c2fd55f?w=640&h=420&fit=crop',
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

function StatCard({
  icon, title, value, color, loading
}: {
  icon: React.ReactNode;
  title: string;
  value: string | number;
  color?: string;
  loading?: boolean;
}) {
  return (
    <Card hoverable styles={{ body: { height: '100%' } }} style={{ borderRadius: 12, height: '100%' }}>
      <Skeleton loading={loading} paragraph={{ rows: 1 }} active>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 32, color: color || '#1D4ED8', flexShrink: 0 }}>{icon}</div>
          <div>
            <div style={{ fontSize: 13, color: '#999', marginBottom: 2 }}>{title}</div>
            <div style={{ fontSize: 28, fontWeight: 600, color: '#1a1a1a', lineHeight: 1.2 }}>{value}</div>
          </div>
        </div>
      </Skeleton>
    </Card>
  );
}

interface TrendItem {
  date: string;
  count: number;
}

interface Stats {
  todayAnswers?: number;
  todayCorrectRate?: number;
  totalUsers?: number;
  totalQuestions?: number;
  totalVisits?: number;
  todayVisits?: number;
  weekTrend?: TrendItem[];
}

function WeekTrend({ data, loading }: { data?: TrendItem[]; loading?: boolean }) {
  if (loading) {
    return (
      <Card title="📈 近7天答题趋势" style={{ borderRadius: 12, marginTop: 32 }}>
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    );
  }
  if (!data || data.length === 0) return null;

  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <Card title="📈 近7天答题趋势" style={{ borderRadius: 12, marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 140, padding: '0 12px' }}>
        {data.map((item, index) => (
          <div key={index} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 12, color: '#666', fontWeight: 500 }}>{item.count}</div>
            <div
              style={{
                width: '65%',
                maxWidth: 48,
                height: `${Math.max((item.count / maxCount) * 100, 6)}px`,
                background: 'linear-gradient(180deg, #1D4ED8 0%, #3B82F6 100%)',
                borderRadius: '6px 6px 0 0',
                transition: 'height 0.3s ease',
                minHeight: 6,
              }}
            />
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

  useEffect(() => {
    fetchStats();
    recordVisit();
  }, []);

  async function fetchStats() {
    try {
      const res = await api.get('/stats/public');
      setStats(res.data);
    } catch (err) {
      console.error('Failed to load stats:', err);
    } finally {
      setLoading(false);
    }
  }

  async function recordVisit() {
    try {
      const lastVisit = sessionStorage.getItem('lastVisitTime');
      const now = Date.now();
      const THREE_HOURS = 3 * 60 * 60 * 1000;
      if (lastVisit && now - Number(lastVisit) < THREE_HOURS) return;
      await api.post('/stats/visit');
      sessionStorage.setItem('lastVisitTime', String(now));
    } catch {
      // silent
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 20px' }}>
      {/* ─── Hero ─── */}
      <div style={{ textAlign: 'center', padding: '56px 0 36px' }}>
        <Title level={2} style={{ marginBottom: 8, fontSize: 32 }}>
          公务员考试刷题系统
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 16, marginBottom: 28 }}>
          基于权威素材的智能命题与练习平台
        </Paragraph>
        <Space size="middle">
          {isAuthenticated ? (
            <Button type="primary" size="large" onClick={() => navigate('/practice')}>开始练习</Button>
          ) : (
            <>
              <Button type="primary" size="large" onClick={() => navigate('/register')}>免费注册</Button>
              <Button size="large" onClick={() => navigate('/login')}>登录</Button>
            </>
          )}
        </Space>
      </div>

      {/* ─── Stats Cards ─── */}
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={4}>
          <StatCard icon={<EditOutlined />} title="今日答题" value={stats?.todayAnswers ?? '-'} color="#1D4ED8" loading={loading} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard icon={<TrophyOutlined />} title="今日正确率" value={stats?.todayCorrectRate ? `${stats.todayCorrectRate}%` : '-'} color="#059669" loading={loading} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard icon={<UserOutlined />} title="注册用户" value={stats?.totalUsers ?? '-'} color="#7C3AED" loading={loading} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard icon={<BookOutlined />} title="题库总数" value={stats?.totalQuestions ?? '-'} color="#DC2626" loading={loading} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard icon={<EyeOutlined />} title="总访问量" value={stats?.totalVisits ?? '-'} color="#0891B2" loading={loading} />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard icon={<FireOutlined />} title="今日访问" value={stats?.todayVisits ?? '-'} color="#EA580C" loading={loading} />
        </Col>
      </Row>

      {/* ─── CardStack Features ─── */}
      <div style={{ marginTop: 48, marginBottom: 8 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Title level={3} style={{ marginBottom: 8 }}>平台亮点</Title>
          <Paragraph type="secondary" style={{ fontSize: 14, marginBottom: 0 }}>
            滑动卡片浏览，点击查看详情
          </Paragraph>
        </div>
        <CardStack
          items={stackItems}
          initialIndex={2}
          autoAdvance
          intervalMs={3000}
          pauseOnHover
          showDots
          loop
        />
      </div>

      {/* ─── Trend ─── */}
      <WeekTrend data={stats?.weekTrend} loading={loading} />

      {/* bottom spacing */}
      <div style={{ height: 48 }} />
    </div>
  );
}
