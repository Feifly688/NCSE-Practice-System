import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Button, Space, Statistic, Skeleton } from 'antd';
import { EditOutlined, HistoryOutlined, ReadOutlined, SafetyOutlined, TrophyOutlined, UserOutlined, BookOutlined, FileTextOutlined, EyeOutlined, FireOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

function StatCard({ icon, title, value, color, loading }) {
  return (
    <Card hoverable style={{ height: '100%' }}>
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

function WeekTrend({ data, loading }) {
  if (loading) return <Card><Skeleton active paragraph={{ rows: 3 }} /></Card>;
  if (!data || data.length === 0) return null;

  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <Card title="📈 近7天答题趋势" style={{ marginTop: 16 }}>
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

export default function Home() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState(null);
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
      await api.post('/stats/visit');
    } catch (err) {
      // 静默失败，不影响用户体验
    }
  }

  const features = [
    { icon: <ReadOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '权威来源', desc: '题目基于人民日报、新华社等权威内容生成' },
    { icon: <EditOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '智能练习', desc: '支持言语理解等模块，随机出题自主练习' },
    { icon: <HistoryOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '答题历史', desc: '记录每次答题数据，分析薄弱环节' },
    { icon: <SafetyOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '数据安全', desc: '个人数据隔离存储，答题记录仅自己可见' },
  ];

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 16px' }}>
      {/* 标题区域 */}
      <div style={{ textAlign: 'center', padding: '48px 0 32px' }}>
        <Typography.Title level={2} style={{ marginBottom: 8 }}>
          公务员考试刷题系统
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 16 }}>
          基于权威素材的智能命题与练习平台
        </Typography.Paragraph>
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

      {/* 数据统计卡片 */}
      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={12} sm={8} md={4}>
          <StatCard
            icon={<EditOutlined />}
            title="今日答题"
            value={stats?.todayAnswers ?? '-'}
            color="#1D4ED8"
            loading={loading}
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard
            icon={<TrophyOutlined />}
            title="今日正确率"
            value={stats?.todayCorrectRate ? `${stats.todayCorrectRate}%` : '-'}
            color="#059669"
            loading={loading}
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard
            icon={<UserOutlined />}
            title="注册用户"
            value={stats?.totalUsers ?? '-'}
            color="#7C3AED"
            loading={loading}
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard
            icon={<BookOutlined />}
            title="题库总数"
            value={stats?.totalQuestions ?? '-'}
            color="#DC2626"
            loading={loading}
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard
            icon={<EyeOutlined />}
            title="总访问量"
            value={stats?.totalVisits ?? '-'}
            color="#0891B2"
            loading={loading}
          />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <StatCard
            icon={<FireOutlined />}
            title="今日访问"
            value={stats?.todayVisits ?? '-'}
            color="#EA580C"
            loading={loading}
          />
        </Col>
      </Row>

      {/* 近7天答题趋势 */}
      <WeekTrend data={stats?.weekTrend} loading={loading} />

      {/* 功能介绍 */}
      <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
        {features.map((f) => (
          <Col xs={24} sm={12} key={f.title}>
            <Card hoverable style={{ height: '100%' }}>
              <Space align="start" size="middle">
                {f.icon}
                <div>
                  <Typography.Title level={4} style={{ marginBottom: 4 }}>{f.title}</Typography.Title>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{f.desc}</Typography.Paragraph>
                </div>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
