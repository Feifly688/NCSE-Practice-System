import React, { useState, useEffect } from 'react';
import { Row, Col, Spin, message, Button } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, EditOutlined, TrophyOutlined, EyeOutlined, PlayCircleOutlined, HistoryOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import Pagination from '../components/Pagination';
import { useResponsive } from '../hooks/useResponsive';
import { useTheme } from '../contexts/ThemeContext';
import { F, FenbiScope, PageHead, Panel, SectionLabel, StatTile, MetaTag } from '../components/FenbiUI';

/** 练习历史（粉笔式记录列表）。数据与跳转逻辑保持原样。 */
export default function History() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [trend, setTrend] = useState([]);
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const { isDark } = useTheme();

  useEffect(() => { loadData(); }, [page]);
  // 趋势只在挂载时取一次最近记录：与分页列表解耦，翻页不改变「近几次」的口径
  useEffect(() => { loadTrend(); }, []);

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

  // 近 7 次已完成记录的正确率：复用现有 /practice/history（不新增接口）。
  // sessions 已带 total/correct/finished_at/status，按 id DESC 返回，取前 7 条 completed 后按时间正序。
  async function loadTrend() {
    try {
      const r = await api.get('/practice/history', { params: { page: 1, pageSize: 30 } });
      const rows = (r.data.sessions || [])
        .filter((s) => s.status === 'completed' && Number(s.total) > 0)
        .slice(0, 7)
        .map((s) => ({
          id: s.id,
          acc: Math.round((Number(s.correct) / Number(s.total)) * 100),
          finished_at: s.finished_at,
          started_at: s.started_at,
        }))
        .sort((a, b) => {
          const ta = new Date(a.finished_at || a.started_at).getTime() || a.id;
          const tb = new Date(b.finished_at || b.started_at).getTime() || b.id;
          return ta - tb;
        });
      setTrend(rows);
    } catch (e) { /* 趋势加载失败不影响主列表 */ }
  }

  // 趋势图配色：由页面 F token 派生，深/浅两套（参照整卷答题页 FB 的派生方式）
  const TC = isDark
    ? { cardBg: '#23252f', border: '#383b49', track: '#2b2e3a', bar: '#5b8cff',
        text: '#e8e9ed', sub: '#9a9eab', up: '#5ec46a', down: '#f06a6a' }
    : { cardBg: F.cardBg, border: F.border, track: F.cardBgAlt, bar: F.primary,
        text: F.text, sub: F.textWeak, up: F.success, down: F.error };

  function formatDuration(sec) {
    if (!sec) return '0秒';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? m + '分' + s + '秒' : s + '秒';
  }

  const overall = stats?.overall || {};
  const accuracy = overall.total_questions > 0 ? Math.round((overall.total_correct / overall.total_questions) * 100) : 0;

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
        <Col xs={12} md={6}><StatTile icon={<TrophyOutlined />} label="正确率" value={accuracy} unit="%" tone="success" /></Col>
        <Col xs={12} md={6}><StatTile icon={<CheckCircleOutlined />} label="平均分" value={overall.avg_score || 0} /></Col>
        <Col xs={12} md={6}><StatTile icon={<ClockCircleOutlined />} label="平均用时" value={overall.avg_duration || 0} unit="秒" /></Col>
        <Col xs={12} md={6}><StatTile icon={<EditOutlined />} label="练习次数" value={overall.total_sessions || 0} unit="次" tone="neutral" /></Col>
      </Row>

      {/* 近几次正确率趋势：原生 CSS 条形，按时间正序，标注每次正确率与较上次差值 */}
      {trend.length > 0 && (
        <>
          <div style={{ height: isMobile ? 16 : 24 }} />
          <SectionLabel title={`近 ${trend.length} 次正确率趋势`} />
          <div style={{
            background: TC.cardBg, border: `1px solid ${TC.border}`, borderRadius: 8,
            padding: isMobile ? 12 : 16,
          }}>
            <div style={{ display: 'flex', gap: isMobile ? 6 : 10, alignItems: 'flex-end' }}>
              {trend.map((d, i) => {
                const delta = i > 0 ? d.acc - trend[i - 1].acc : null;
                return (
                  <div key={d.id} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: TC.text, lineHeight: 1.2 }}>{d.acc}%</span>
                    <div style={{
                      width: '100%', height: 64, borderRadius: 4,
                      background: TC.track, display: 'flex', alignItems: 'flex-end', overflow: 'hidden',
                    }}>
                      <div style={{
                        width: '100%', height: `${d.acc}%`,
                        background: TC.bar, borderRadius: '4px 4px 0 0',
                        transition: 'height .3s',
                      }} />
                    </div>
                    <span style={{
                      fontSize: 11, lineHeight: 1.2, whiteSpace: 'nowrap',
                      color: delta == null ? TC.sub : delta > 0 ? TC.up : delta < 0 ? TC.down : TC.sub,
                    }}>
                      {delta == null ? '—' : delta > 0 ? `+${delta}%` : delta < 0 ? `${delta}%` : '0%'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div style={{ height: isMobile ? 16 : 24 }} />
      <SectionLabel title="全部记录" />
      <Panel bodyStyle={{ padding: isMobile ? 12 : 16 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 48 }}><Spin size="large" /></div>
        ) : sessions.length === 0 ? (
          <div className="fb-empty">暂无练习记录</div>
        ) : (
          sessions.map((s) => {
            const isInProgress = s.status === 'in_progress';
            // 整卷真题的作答也统一记录在练习历史里；名称由 /practice/history 统一下发
            const isExam = s.mode === 'exam_paper';
            // 逐题用时：交卷后写入 meta_json.timings（question_id → 秒）。
            // 老数据没有该字段或全为 0 时 timingEntries 为空，下面不渲染，布局不变。
            let timingEntries = [];
            if (s.meta_json) {
              try {
                const meta = typeof s.meta_json === 'string' ? JSON.parse(s.meta_json) : s.meta_json;
                const tm = meta && meta.timings;
                if (tm && typeof tm === 'object' && !Array.isArray(tm)) {
                  timingEntries = Object.entries(tm)
                    .filter(([, v]) => Number(v) > 0)
                    .map(([qid, v]) => ({ qid, sec: Math.floor(Number(v)) }));
                }
              } catch (e) { /* 解析失败按「无逐题用时」降级 */ }
            }
            return (
              <div key={s.id} className="fb-row">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                      <MetaTag tone="primary">{isExam ? '整卷真题' : (s.subject_name || '综合练习')}</MetaTag>
                      <span className="fb-row-title" style={{ fontWeight: 600 }}>{s.title}</span>
                      <MetaTag tone={isInProgress ? 'warning' : 'success'}>{isInProgress ? '答题中' : '已完成'}</MetaTag>
                    </div>
                    <div style={{ display: 'flex', gap: isMobile ? 14 : 28, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span className="fb-meta">得分 <b style={{ color: isInProgress ? F.text : (s.score >= 60 ? F.success : F.error), fontSize: 14 }}>{isInProgress ? '进行中' : s.score}</b></span>
                      <span className="fb-meta">用时 <b style={{ color: F.text, fontSize: 14 }}>{formatDuration(s.duration_sec)}</b></span>
                      <span className="fb-meta">{new Date(s.started_at).toLocaleString('zh-CN')}</span>
                      {timingEntries.length > 0 && (
                        <span className="fb-meta" title={timingEntries.map(t => `第${t.qid}题 ${t.sec}秒`).join('、')}>
                          逐题用时：{timingEntries.slice(0, 4).map(t => `${t.sec}秒`).join(' · ')}{timingEntries.length > 4 ? ` 等 ${timingEntries.length} 题` : ''}
                        </span>
                      )}
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
