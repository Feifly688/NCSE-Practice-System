import React, { useState, useEffect } from 'react';
import { Typography, Card, Tag, Statistic, Row, Col, Spin, message, Space, Button } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, EditOutlined, TrophyOutlined, EyeOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import Pagination from '../components/Pagination';

const { Title, Text } = Typography;

export default function History() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const navigate = useNavigate();

  useEffect(() => { loadData(); }, [page]);

  async function loadData() {
    setLoading(true);
    try {
      const [statsRes, historyRes] = await Promise.all([
        api.get('/practice/stats'),
        api.get('/practice/history', { params: { page, pageSize: 15 } })
      ]);
      setStats(statsRes.data);
      setSessions(historyRes.data.sessions);
      setTotal(historyRes.data.total);
    } catch (err) { message.error('加载数据失败'); }
    finally { setLoading(false); }
  }

  function formatDuration(sec) {
    if (!sec) return '0秒';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? m + '分' + s + '秒' : s + '秒';
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>;

  const overall = stats?.overall || {};

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <Title level={3}>答题历史</Title>
      
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={12} sm={6}><Card><Statistic title="总答题数" value={overall.total_questions || 0} prefix={<EditOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="总正确" value={overall.total_correct || 0} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="平均分" value={overall.avg_score || 0} prefix={<TrophyOutlined />} /></Card></Col>
        <Col xs={12} sm={6}><Card><Statistic title="练习次数" value={overall.total_sessions || 0} prefix={<ClockCircleOutlined />} /></Card></Col>
      </Row>

      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>ID</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>科目</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>状态</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>题数</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>正确</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>得分</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>用时</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>时间</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 40, textAlign: 'center' }}>暂无练习记录</td></tr>
            ) : (
              sessions.map((s, idx) => {
                const isInProgress = s.status === 'in_progress';
                return (
                  <tr key={s.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 16px' }}>{s.id}</td>
                    <td style={{ padding: '10px 16px' }}><Tag color="blue">{s.subject_name}</Tag></td>
                    <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                      {isInProgress ? <Tag color="orange">答题中</Tag> : <Tag color="green">已完成</Tag>}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'center' }}>{s.total}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'center', color: '#52c41a' }}>{isInProgress ? '-' : s.correct}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                      {isInProgress ? <Tag>进行中</Tag> : <Tag color={s.score >= 60 ? 'green' : 'red'}>{s.score}</Tag>}
                    </td>
                    <td style={{ padding: '10px 16px', textAlign: 'center' }}>{formatDuration(s.duration_sec)}</td>
                    <td style={{ padding: '10px 16px' }}>{new Date(s.started_at).toLocaleString('zh-CN')}</td>
                    <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                      {isInProgress ? (
                        <Button type="primary" size="small" icon={<PlayCircleOutlined />}
                          onClick={() => navigate('/practice?session=' + s.id)}>
                          继续答题
                        </Button>
                      ) : (
                        <Button size="small" icon={<EyeOutlined />}
                          onClick={() => navigate('/practice?session=' + s.id + '&view=result')}>
                          查看详情
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Pagination current={page} total={total} pageSize={15} onChange={setPage} />
    </div>
  );
}