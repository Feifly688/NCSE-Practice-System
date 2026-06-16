import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Statistic, Button, Space, Spin, message, List, Tag, Empty } from 'antd';
import { EditOutlined, HistoryOutlined, TrophyOutlined, ClockCircleOutlined, CheckCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { GlowCard } from '../components/ui/spotlight-card';

const { Text } = Typography;

function DashStat({ icon, title, value, prefix, suffix, glowColor }) {
  return (
    <GlowCard glowColor={glowColor} customSize className="!h-auto !w-full !p-6 !grid !grid-rows-none">
      <Statistic
        title={<span style={{ fontSize: 13, color: 'rgba(0,0,0,0.5)' }}>{title}</span>}
        value={value}
        prefix={icon}
        suffix={suffix}
        valueStyle={{ fontSize: 26, fontWeight: 600, color: '#1a1a1a' }}
      />
    </GlowCard>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [trend, setTrend] = useState([]);

  useEffect(() => { loadStats(); loadTrend(); }, []);

  async function loadStats() {
    try {
      const r = await api.get('/practice/stats');
      setStats(r.data);
    } catch (err) { message.error('加载统计数据失败'); }
    finally { setLoading(false); }
  }

  async function loadTrend() {
    try {
      const r = await api.get('/practice/trend');
      setTrend(r.data.trend || []);
    } catch (err) { /* trend is non-critical */ }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>;

  const overall = stats?.overall || {};
  const recent = stats?.recent || [];

  return (
    <div>
      <Typography.Title level={3} style={{ marginBottom: 8 }}>欢迎回来，{user?.nickname}</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>这里是你学习数据的概览</Typography.Paragraph>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<EditOutlined style={{ color: '#1D4ED8' }} />} title="总答题数" value={overall.total_questions || 0} glowColor="blue" />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<TrophyOutlined style={{ color: '#059669' }} />} title="正确率" value={overall.total_questions > 0 ? Math.round((overall.total_correct / overall.total_questions) * 100) : 0} suffix="%" glowColor="green" />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<CheckCircleOutlined style={{ color: '#7C3AED' }} />} title="平均分" value={overall.avg_score || 0} glowColor="purple" />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<ClockCircleOutlined style={{ color: '#0891B2' }} />} title="练习次数" value={overall.total_sessions || 0} glowColor="orange" />
        </Col>
      </Row>

      <Card style={{ marginTop: 24, borderRadius: 12, border: '1px solid #e8e8e8' }} bodyStyle={{ padding: 20 }}>
        <Space size="middle">
          <Button type="primary" size="large" onClick={() => navigate('/practice')} style={{ borderRadius: 8, height: 40, padding: '0 24px', fontWeight: 600 }}>开始练习</Button>
          <Button size="large" onClick={() => navigate('/history')} style={{ borderRadius: 8, height: 40, padding: '0 24px' }}>查看历史</Button>
        </Space>
      </Card>

      {recent.length > 0 && (
        <Card title={<span style={{ fontSize: 16 }}>最近练习</span>} style={{ marginTop: 24, borderRadius: 12 }}>
          <List
            dataSource={recent}
            renderItem={item => (
              <List.Item>
                <Space>
                  <Tag color="blue">{item.subject_name}</Tag>
                  {item.status === 'in_progress' ? (
                    <>
                      <Tag color="orange">答题中</Tag>
                      <span>{item.total} 题</span>
                      <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => navigate('/practice?session=' + item.id)}>继续答题</Button>
                    </>
                  ) : (
                    <>
                      <span>{item.total} 题</span>
                      <span style={{ color: '#52c41a' }}>答对 {item.correct} 题</span>
                      <Tag color={item.score >= 60 ? 'green' : 'red'}>{item.score} 分</Tag>
                    </>
                  )}
                  <span style={{ color: '#999', fontSize: 13 }}>{new Date(item.started_at).toLocaleString('zh-CN')}</span>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}

      {recent.length === 0 && (
        <Card style={{ marginTop: 24, borderRadius: 12 }}>
          <Empty description="还没有练习记录，快去答题吧！" />
        </Card>
      )}

      {trend.length > 0 && (
        <Card title={<span style={{ fontSize: 16 }}>成绩趋势</span>} style={{ marginTop: 24, borderRadius: 12 }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', height: 200, gap: 4, padding: '0 8px' }}>
            {trend.map((t, i) => {
              const h = Math.max(4, (t.score / 100) * 180);
              return (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <Text style={{ fontSize: 11, marginBottom: 4 }}>{t.score}</Text>
                  <div style={{ width: '100%', maxWidth: 40, height: h, background: t.score >= 60 ? 'linear-gradient(180deg, #059669 0%, #34D399 100%)' : 'linear-gradient(180deg, #DC2626 0%, #F87171 100%)', borderRadius: '4px 4px 0 0' }} />
                  <Text style={{ fontSize: 10, marginTop: 4, color: '#999' }}>{new Date(t.started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</Text>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
