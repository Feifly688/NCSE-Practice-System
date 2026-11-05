import React, { useState, useEffect } from 'react';
import { Row, Col, Spin, message, Button } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, EditOutlined, TrophyOutlined, EyeOutlined, PlayCircleOutlined, HistoryOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import Pagination from '../components/Pagination';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead, Panel, SectionLabel, StatTile, MetaTag } from '../components/FenbiUI';

/** 练习历史（粉笔式记录列表）。数据与跳转逻辑保持原样。 */
export default function History() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const { isMobile } = useResponsive();

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

  const overall = stats?.overall || {};

  return (
    <FenbiScope>
      <PageHead
        title="练习记录"
        icon={<HistoryOutlined />}
        desc="查看每一次练习的成绩与用时，未完成的练习可以继续作答。"
        extra={<Button type="primary" icon={<EditOutlined />} onClick={() => navigate('/practice')}>去练习</Button>}
      />

      <SectionLabel title="累计数据" />
      <Row gutter={[isMobile ? 8 : 16, isMobile ? 8 : 16]}>
        <Col xs={12} md={6}><StatTile icon={<EditOutlined />} label="总答题数" value={overall.total_questions || 0} unit="题" /></Col>
        <Col xs={12} md={6}><StatTile icon={<CheckCircleOutlined />} label="总正确" value={overall.total_correct || 0} unit="题" tone="success" /></Col>
        <Col xs={12} md={6}><StatTile icon={<TrophyOutlined />} label="平均分" value={overall.avg_score || 0} /></Col>
        <Col xs={12} md={6}><StatTile icon={<ClockCircleOutlined />} label="练习次数" value={overall.total_sessions || 0} unit="次" tone="neutral" /></Col>
      </Row>

      <div style={{ height: isMobile ? 16 : 24 }} />
      <SectionLabel title="全部记录" extra={<span className="fb-meta">共 {total} 条</span>} />
      <Panel bodyStyle={{ padding: isMobile ? 12 : 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>
        ) : sessions.length === 0 ? (
          <div className="fb-empty">暂无练习记录</div>
        ) : (
          sessions.map((s) => {
            const isInProgress = s.status === 'in_progress';
            // 整卷真题的作答也统一记录在练习历史里（meta 带卷名）
            const isExam = s.mode === 'exam_paper';
            let examMeta = null;
            if (isExam && s.meta_json) {
              try { examMeta = typeof s.meta_json === 'string' ? JSON.parse(s.meta_json) : s.meta_json; } catch (e) { /* 忽略 */ }
            }
            const title = (examMeta && examMeta.paper_title) || null;
            return (
              <div key={s.id} className="fb-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                      {isExam ? (
                        <>
                          <MetaTag tone="primary">整卷真题</MetaTag>
                          <span className="fb-row-title" style={{ fontWeight: 600 }}>{title || `练习 #${s.id}`}</span>
                        </>
                      ) : (
                        <>
                          <MetaTag tone="primary">{s.subject_name || '综合练习'}</MetaTag>
                          <span className="fb-meta">练习 #{s.id}</span>
                        </>
                      )}
                      <MetaTag tone={isInProgress ? 'warning' : 'success'}>{isInProgress ? '答题中' : '已完成'}</MetaTag>
                    </div>
                    <div style={{ display: 'flex', gap: isMobile ? 14 : 28, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="fb-meta">题数 <b style={{ color: F.text, fontSize: 14 }}>{s.total}</b></span>
                      <span className="fb-meta">正确 <b style={{ color: F.success, fontSize: 14 }}>{isInProgress ? '-' : s.correct}</b></span>
                      <span className="fb-meta">得分 <b style={{ color: isInProgress ? F.text : (s.score >= 60 ? F.success : F.error), fontSize: 14 }}>{isInProgress ? '进行中' : s.score}</b></span>
                      <span className="fb-meta">用时 <b style={{ color: F.text, fontSize: 14 }}>{formatDuration(s.duration_sec)}</b></span>
                      <span className="fb-meta">{new Date(s.started_at).toLocaleString('zh-CN')}</span>
                    </div>
                  </div>
                  <div style={{ flexShrink: 0 }}>
                    {isInProgress ? (
                      <Button type="primary" size="small" icon={<PlayCircleOutlined />} onClick={() => navigate('/practice/do?session=' + s.id)}>继续答题</Button>
                    ) : (
                      <Button size="small" icon={<EyeOutlined />} onClick={() => navigate('/practice/do?session=' + s.id + '&view=result')}>查看详情</Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div style={{ marginTop: 12 }}><Pagination current={page} total={total} pageSize={15} onChange={setPage} /></div>
      </Panel>
    </FenbiScope>
  );
}
