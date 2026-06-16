import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Button, Space, Skeleton } from 'antd';
import {
  EditOutlined, TrophyOutlined, UserOutlined, BookOutlined,
  EyeOutlined, FireOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { FeatureCard } from '../components/ui/grid-feature-cards';
import { BookOpen, Sparkles, History, Shield } from 'lucide-react';

const { Title, Paragraph, Text } = Typography;

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
    <Card hoverable style={{ height: '100%', borderRadius: 12 }}>
      <Skeleton loading={loading} paragraph={{ rows: 1 }} active>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 32, color: color || '#1D4ED8' }}>{icon}</div>
          <div>
            <div style={{ fontSize: 13, color: '#999' }}>{title}</div>
            <div style={{ fontSize: 28, fontWeight: 600, color: '#333' }}>{value}</div>
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

function WeekTrend({ data, loading }: { data?: TrendItem[]; loading?: boolean }) {
  if (loading) return <Card style={{ borderRadius: 12, marginTop: 16 }}><Skeleton active paragraph={{ rows: 3 }} /></Card>;
  if (!data || data.length === 0) return null;

  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <Card title="📈 近7天答题趋势" style={{ borderRadius: 12, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 120, padding: '0 8px' }}>
        {data.map((item, index) => (
          <div key={index} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: 11, color: '#666' }}>{item.count}</div>
            <div
              style={{
                width: '60%',
                maxWidth: 40,
                height: `${Math.max((item.count / maxCount) * 80, 4)}px`,
                background: 'linear-gradient(180deg, #1D4ED8 0%, #3B82F6 100%)',
                borderRadius: '4px 4px 0 0',
                transition: 'height 0.3s ease'
              }}
            />
            <div style={{ fontSize: 11, color: '#999' }}>{item.date}</div>
          </div>
        ))}
      </div>
    </Card>
  );
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

  const features = [
    {
      title: '权威来源',
      icon: BookOpen,
      description: '题目基于人民日报、新华社等权威内容生成，确保内容质量与时效性。',
    },
    {
      title: '智能练习',
      icon: Sparkles,
      description: '支持言语理解与政治模块，AI随机出题，自适应练习。',
    },
    {
      title: '答题历史',
      icon: History,
      description: '记录每次答题数据，分析薄弱环节，针对性提高。',
    },
    {
      title: '数据安全',
      icon: Shield,
      description: '个人数据隔离存储，答题记录仅自己可见，隐私无忧。',
    },
  ];

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '0 16px' }}>
      {/* Hero section */}
      <div style={{ textAlign: 'center', padding: '48px 0 32px' }}>
        <Title level={2} style={{ marginBottom: 8 }}>
          公务员考试刷题系统
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 16 }}>
          基于权威素材的智能命题与练习平台
        </Paragraph>
        <Space size="middle" style={{ marginTop: 24 }}>
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

      {/* Data cards grid (keep Ant Design cards for data display) */}
      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
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

      {/* Trend chart */}
      <WeekTrend data={stats?.weekTrend} loading={loading} />

      {/* Feature cards with new template style */}
      <div style={{ marginTop: 40, marginBottom: 40 }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <Title level={3}>为什么选择我们</Title>
          <Paragraph type="secondary" style={{ fontSize: 14 }}>
            智能命题、权威素材、安全可靠
          </Paragraph>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            border: '1px dashed #e5e7eb',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {features.map((f, i) => (
            <div
              key={i}
              style={{
                borderRight: i % 2 === 0 ? '1px dashed #e5e7eb' : 'none',
                borderBottom: i < 2 ? '1px dashed #e5e7eb' : 'none',
              }}
            >
              <FeatureCard feature={f} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
