import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Statistic, Button, Space, Spin, message, List, Tag, Empty } from 'antd';
import { EditOutlined, HistoryOutlined, TrophyOutlined, ClockCircleOutlined, CheckCircleOutlined, PlayCircleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { GlowCard } from '../components/ui/spotlight-card';
import { DonutChart, TrendLine, ModuleBars } from '../components/ui/charts';
import { useResponsive } from '../hooks/useResponsive';

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
  const { isMobile } = useResponsive();
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

  if (loading) return <div style={{ textAlign: 'center', padding: isMobile ? 64 : 100 }}><Spin size="large" tip="正在加载学习数据..." /></div>;

  const overall = stats?.overall || {};
  const recent = stats?.recent || [];
  const bySubject = stats?.bySubject || [];
  const totalQ = overall.total_questions || 0;
  const totalC = overall.total_correct || 0;
  const accuracy = totalQ > 0 ? Math.round((totalC / totalQ) * 100) : 0;

  return (
    <div>
      <div style={{
        marginBottom: isMobile ? 16 : 24,
        padding: isMobile ? '20px 18px' : '28px 32px',
        borderRadius: 16,
        color: '#fff',
        background: 'linear-gradient(118deg, #0f172a 0%, #1d4ed8 58%, #2563eb 100%)',
        boxShadow: '0 14px 32px rgba(29, 78, 216, 0.18)',
      }}>
        <Typography.Title level={3} style={{ color: '#fff', margin: '0 0 6px', fontSize: isMobile ? 21 : 26 }}>
          欢迎回来，{user?.nickname || '同学'}
        </Typography.Title>
        <Typography.Paragraph style={{ color: 'rgba(255,255,255,0.72)', margin: 0, maxWidth: 520 }}>
          从今天的练习开始，稳步提升每一个知识模块。
        </Typography.Paragraph>
      </div>

      <Row gutter={[isMobile ? 8 : 16, isMobile ? 8 : 16]}>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<EditOutlined style={{ color: '#1D4ED8' }} />} title="总答题数" value={overall.total_questions || 0} glowColor="blue" />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<TrophyOutlined style={{ color: '#059669' }} />} title="正确率" value={accuracy} suffix="%" glowColor="green" />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<CheckCircleOutlined style={{ color: '#7C3AED' }} />} title="平均分" value={overall.avg_score || 0} glowColor="purple" />
        </Col>
        <Col xs={24} sm={12} md={6}>
          <DashStat icon={<ClockCircleOutlined style={{ color: '#0891B2' }} />} title="练习次数" value={overall.total_sessions || 0} glowColor="orange" />
        </Col>
      </Row>

      <Card style={{ marginTop: isMobile ? 16 : 24, borderRadius: 14, border: '1px solid #e2e8f0' }} bodyStyle={{ padding: isMobile ? 18 : 22 }}>
        <div style={{ display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'space-between', flexDirection: isMobile ? 'column' : 'row', gap: 14 }}>
          <div>
            <Typography.Text strong style={{ fontSize: 16, display: 'block', marginBottom: 4 }}>准备好继续了吗？</Typography.Text>
            <Typography.Text type="secondary">选择练习模式，系统会自动保存你的答题进度。</Typography.Text>
          </div>
          <Space size="middle" wrap>
            <Button type="primary" size="large" icon={<EditOutlined />} onClick={() => navigate('/practice')} style={{ borderRadius: 8, height: 42, padding: '0 22px', fontWeight: 600 }}>开始练习</Button>
            <Button size="large" icon={<HistoryOutlined />} onClick={() => navigate('/history')} style={{ borderRadius: 8, height: 42 }}>查看历史</Button>
          </Space>
        </div>
      </Card>

      {recent.length > 0 && (
        <Card title={<span style={{ fontSize: 16 }}>最近练习</span>} extra={<Button type="link" size="small" onClick={() => navigate('/history')}>全部记录 <ArrowRightOutlined /></Button>} style={{ marginTop: isMobile ? 16 : 24, borderRadius: 14 }} bodyStyle={{ padding: isMobile ? '4px 16px' : undefined }}>
          <List
            dataSource={recent}
            renderItem={item => (
              <List.Item style={{ alignItems: isMobile ? 'flex-start' : 'center' }}>
                <div style={{ display: 'flex', width: '100%', alignItems: isMobile ? 'flex-start' : 'center', justifyContent: 'space-between', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
                  <Space size={[6, 6]} wrap>
                    <Tag color="blue">{item.subject_name || '综合练习'}</Tag>
                    {item.status === 'in_progress' ? <Tag color="orange">答题中</Tag> : <Tag color={item.score >= 60 ? 'green' : 'red'}>{item.score} 分</Tag>}
                    <Typography.Text type="secondary">{item.total} 题{item.status !== 'in_progress' && ` · 答对 ${item.correct} 题`}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{new Date(item.started_at).toLocaleString('zh-CN')}</Typography.Text>
                  </Space>
                  {item.status === 'in_progress' && <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => navigate('/practice?session=' + item.id)}>继续答题</Button>}
                </div>
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

      {/* ─── 数据可视化区：正确率环形 + 模块表现 ─── */}
      <Row gutter={[isMobile ? 12 : 16, isMobile ? 12 : 16]} style={{ marginTop: isMobile ? 16 : 24 }}>
        <Col xs={24} md={9}>
          <Card
            title={<span style={{ fontSize: 16 }}>总体正确率</span>}
            style={{ borderRadius: 14, border: '1px solid #e2e8f0', height: '100%' }}
            bodyStyle={{ padding: isMobile ? 18 : 22 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 16 : 24, flexWrap: 'wrap', justifyContent: isMobile ? 'center' : 'flex-start' }}>
              <DonutChart
                percent={accuracy}
                size={isMobile ? 116 : 132}
                color={accuracy >= 60 ? '#059669' : '#DC2626'}
              >
                <div style={{ fontSize: isMobile ? 24 : 28, fontWeight: 700, color: '#1a1a1a', lineHeight: 1.1 }}>
                  {accuracy}<span style={{ fontSize: 14, fontWeight: 500 }}>%</span>
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>正确率</div>
              </DonutChart>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 108 }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>答对</Text>
                  <div style={{ fontSize: 18, fontWeight: 600, color: '#059669' }}>{totalC} 题</div>
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>总题</Text>
                  <div style={{ fontSize: 18, fontWeight: 600, color: '#334155' }}>{totalQ} 题</div>
                </div>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>平均用时</Text>
                  <div style={{ fontSize: 18, fontWeight: 600, color: '#334155' }}>{overall.avg_duration || 0} 秒</div>
                </div>
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} md={15}>
          <Card
            title={<span style={{ fontSize: 16 }}>科目掌握情况</span>}
            style={{ borderRadius: 14, border: '1px solid #e2e8f0', height: '100%' }}
            bodyStyle={{ padding: isMobile ? 18 : 22 }}
          >
            <ModuleBars items={bySubject} />
          </Card>
        </Col>
      </Row>

      {trend.length > 0 && (
        <Card
          title={<span style={{ fontSize: 16 }}>成绩趋势</span>}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>近 {trend.length} 次练习</Text>}
          style={{ marginTop: isMobile ? 16 : 24, borderRadius: 14, border: '1px solid #e2e8f0' }}
          bodyStyle={{ padding: isMobile ? 18 : 22 }}
        >
          <TrendLine points={trend} height={isMobile ? 160 : 190} />
        </Card>
      )}
    </div>
  );
}
