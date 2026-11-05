import React, { useState, useEffect } from 'react';
import { Typography, Row, Col, Button, Space, Spin, message, List, Tag, Empty } from 'antd';
import { EditOutlined, HistoryOutlined, TrophyOutlined, ClockCircleOutlined, CheckCircleOutlined, PlayCircleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { DonutChart } from '../components/ui/charts';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, SectionLabel, StatTile } from '../components/FenbiUI';

const { Text } = Typography;

/**
 * 仪表盘（粉笔式学习数据面板）。
 * 数据全部来自 /practice/stats 与 /practice/trend，不做任何虚构。
 * 图表在页面内自行实现橙/绿/红色，避免改动被其他页面共用的 charts.jsx。
 */

function FbBars({ items = [] }) {
  if (items.length === 0) return <div style={{ color: F.textWeak, fontSize: 13 }}>暂无模块数据</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {items.map((m, i) => {
        const total = Number(m.questions) || 0;
        const correct = Number(m.correct) || 0;
        const rate = total > 0 ? Math.round((correct / total) * 100) : 0;
        const color = rate >= 80 ? F.success : rate >= 60 ? F.primary : F.error;
        return (
          <div key={m.slug || m.name || i}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
              <span style={{ color: F.text }}>{m.name || '未分类'}</span>
              <span style={{ color: F.textSub }}>
                {rate}% <span style={{ color: F.textWeak }}>({correct}/{total})</span>
              </span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: '#F2F3F5', overflow: 'hidden' }}>
              <div style={{ width: `${rate}%`, height: '100%', borderRadius: 999, background: color, transition: 'width .8s ease' }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FbTrend({ points = [], height = 190, passLine = 60 }) {
  const { isMobile } = useResponsive();
  const data = points.map((p) => Number(p.score) || 0);
  if (data.length === 0) return null;
  const w = 100, h = 100, pad = 8;
  const max = Math.max(100, ...data);
  const x = (i) => (data.length === 1 ? 50 : (i / (data.length - 1)) * (w - pad * 2) + pad);
  const y = (v) => h - pad - (v / (max || 1)) * (h - pad * 2);
  const line = data.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(2)},${(h - pad).toFixed(2)} L${x(0).toFixed(2)},${(h - pad).toFixed(2)} Z`;
  const last = data[data.length - 1];
  return (
    <div style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height }}>
        <defs>
          <linearGradient id="fb-trend-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={F.primary} stopOpacity="0.20" />
            <stop offset="100%" stopColor={F.primary} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={pad} y1={y(passLine)} x2={w - pad} y2={y(passLine)} stroke={F.error} strokeWidth="0.5" strokeDasharray="3 3" opacity="0.45" />
        <path d={area} fill="url(#fb-trend-area)" />
        <path d={line} fill="none" stroke={F.primary} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {data.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r="1.4" fill={v >= passLine ? F.success : F.error} />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: F.textWeak }}>
        <span>{points[0]?.started_at ? new Date(points[0].started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</span>
        <span style={{ color: F.textSub, fontWeight: 600 }}>最近一次 {last} 分</span>
        <span>{points[points.length - 1]?.started_at ? new Date(points[points.length - 1].started_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : ''}</span>
      </div>
      {isMobile && <div style={{ fontSize: 11, color: F.textWeak, marginTop: 2 }}>虚线为 60 分及格线</div>}
    </div>
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

  const overall = stats?.overall || {};
  const recent = stats?.recent || [];
  const bySubject = stats?.bySubject || [];
  const totalQ = overall.total_questions || 0;
  const totalC = overall.total_correct || 0;
  const accuracy = totalQ > 0 ? Math.round((totalC / totalQ) * 100) : 0;

  return (
    <FenbiScope>
      <PageHead
        title={`欢迎回来，${user?.nickname || '同学'}`}
        desc="从今天的练习开始，稳步提升每一个知识模块。"
        extra={
          <>
            <Button icon={<HistoryOutlined />} onClick={() => navigate('/history')}>练习记录</Button>
            <Button type="primary" icon={<EditOutlined />} onClick={() => navigate('/practice')}>开始练习</Button>
          </>
        }
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: isMobile ? 64 : 100 }}><Spin size="large" tip="正在加载学习数据..." /></div>
      ) : (
        <>
          <SectionLabel title="学习概览" />
          <Row gutter={[isMobile ? 8 : 16, isMobile ? 8 : 16]}>
            <Col xs={12} md={6}><StatTile icon={<EditOutlined />} label="累计答题" value={overall.total_questions || 0} unit="题" /></Col>
            <Col xs={12} md={6}><StatTile icon={<TrophyOutlined />} label="正确率" value={accuracy} unit="%" tone="success" /></Col>
            <Col xs={12} md={6}><StatTile icon={<CheckCircleOutlined />} label="平均分" value={overall.avg_score || 0} /></Col>
            <Col xs={12} md={6}><StatTile icon={<ClockCircleOutlined />} label="练习次数" value={overall.total_sessions || 0} unit="次" tone="neutral" /></Col>
          </Row>

          <div style={{ height: isMobile ? 16 : 24 }} />
          <SectionLabel title="最近练习" extra={<Button type="link" size="small" onClick={() => navigate('/history')}>全部记录 <ArrowRightOutlined /></Button>} />
          <Panel bodyStyle={{ padding: isMobile ? '4px 14px' : '4px 20px' }}>
            {recent.length === 0 ? (
              <Empty description="还没有练习记录，快去答题吧！" />
            ) : (
              <List
                dataSource={recent}
                renderItem={item => (
                  <List.Item style={{ alignItems: isMobile ? 'flex-start' : 'center' }}>
                    <div style={{ display: 'flex', width: '100%', alignItems: isMobile ? 'flex-start' : 'center', justifyContent: 'space-between', flexDirection: isMobile ? 'column' : 'row', gap: 10 }}>
                      <Space size={[6, 6]} wrap>
                        <Tag color="orange">{item.subject_name || '综合练习'}</Tag>
                        {item.status === 'in_progress' ? <Tag color="warning">答题中</Tag> : <Tag color={item.score >= 60 ? 'green' : 'red'}>{item.score} 分</Tag>}
                        <Text type="secondary">{item.total} 题{item.status !== 'in_progress' && ` · 答对 ${item.correct} 题`}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{new Date(item.started_at).toLocaleString('zh-CN')}</Text>
                      </Space>
                      {item.status === 'in_progress' && (
                        <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => navigate('/practice/do?session=' + item.id)}>继续答题</Button>
                      )}
                    </div>
                  </List.Item>
                )}
              />
            )}
          </Panel>

          <div style={{ height: isMobile ? 16 : 24 }} />
          <SectionLabel title="数据分析" />
          <Row gutter={[isMobile ? 12 : 16, isMobile ? 12 : 16]}>
            <Col xs={24} md={9}>
              <Panel title="总体正确率" style={{ height: '100%' }} bodyStyle={{ padding: isMobile ? 18 : 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 16 : 24, flexWrap: 'wrap', justifyContent: isMobile ? 'center' : 'flex-start' }}>
                  <DonutChart percent={accuracy} size={isMobile ? 116 : 132} color={accuracy >= 60 ? F.success : F.error} track={F.primaryLight}>
                    <div style={{ fontSize: isMobile ? 24 : 28, fontWeight: 700, color: F.text, lineHeight: 1.1 }}>
                      {accuracy}<span style={{ fontSize: 14, fontWeight: 500 }}>%</span>
                    </div>
                    <div style={{ fontSize: 11, color: F.textWeak }}>正确率</div>
                  </DonutChart>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 108 }}>
                    <div><Text type="secondary" style={{ fontSize: 12 }}>答对</Text><div style={{ fontSize: 18, fontWeight: 600, color: F.success }}>{totalC} 题</div></div>
                    <div><Text type="secondary" style={{ fontSize: 12 }}>总题</Text><div style={{ fontSize: 18, fontWeight: 600, color: F.text }}>{totalQ} 题</div></div>
                    <div><Text type="secondary" style={{ fontSize: 12 }}>平均用时</Text><div style={{ fontSize: 18, fontWeight: 600, color: F.text }}>{overall.avg_duration || 0} 秒</div></div>
                  </div>
                </div>
              </Panel>
            </Col>
            <Col xs={24} md={15}>
              <Panel title="科目掌握情况" style={{ height: '100%' }} bodyStyle={{ padding: isMobile ? 18 : 22 }}>
                <FbBars items={bySubject} />
              </Panel>
            </Col>
          </Row>

          {trend.length > 0 && (
            <Panel
              title="成绩趋势"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>近 {trend.length} 次练习</Text>}
              style={{ marginTop: isMobile ? 12 : 16 }}
              bodyStyle={{ padding: isMobile ? 18 : 22 }}
            >
              <FbTrend points={trend} height={isMobile ? 160 : 190} />
            </Panel>
          )}
        </>
      )}
    </FenbiScope>
  );
}
