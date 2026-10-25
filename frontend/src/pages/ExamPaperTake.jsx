import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card, Button, Tag, Progress, Space, Typography, Spin, Empty, message,
  Drawer, Modal, Statistic, Row, Col, Divider, Affix,
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined, CloseCircleOutlined,
  FlagOutlined, FlagFilled, DashboardOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import api from '../services/api';
import { getToken } from '../services/authStorage';
import { useResponsive } from '../hooks/useResponsive';

const { Title, Text, Paragraph } = Typography;

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * 题目截图地址：<img> 标签带不了 Authorization 头，
 * 后端图片路由额外接受 ?t=<token>（仅用于这类静态资源）。
 */
function paperImageUrl(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  const base = api.defaults.baseURL || '/api';
  const token = getToken() || '';
  const sep = src.includes('?') ? '&' : '?';
  return `${base}${src}${sep}t=${encodeURIComponent(token)}`;
}

/** 秒 → mm:ss */
function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const CARD_STATUS_COLOR = {
  answered: { bg: '#1D4ED8', color: '#fff', border: '#1D4ED8' },
  marked: { bg: '#fff7e6', color: '#d46b08', border: '#ffd591' },
  unanswered: { bg: '#fff', color: '#8c8c8c', border: '#d9d9d9' },
  correct: { bg: '#16a34a', color: '#fff', border: '#16a34a' },
  wrong: { bg: '#dc2626', color: '#fff', border: '#dc2626' },
};

/**
 * 整卷在线阅览与答题（参考粉笔网页版交互）：
 * 分区导航 + 答题卡 + 选项作答 + 交卷后答案与解析 + 进度与结果反馈，PC/移动响应式。
 */
export default function ExamPaperTake() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isMobile } = useResponsive();

  const [loading, setLoading] = useState(true);
  const [paper, setPaper] = useState(null);
  const [sections, setSections] = useState([]);
  const [answers, setAnswers] = useState({});
  const [marked, setMarked] = useState({});
  const [result, setResult] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeSection, setActiveSection] = useState(null);
  // 纯文本题的原卷截图默认折叠：它的内容与题干重复，展开才加载
  const [shotOpen, setShotOpen] = useState({});

  const qRefs = useRef({});

  useEffect(() => { loadPaper(); }, [id]);

  // 计时（交卷后停止）
  useEffect(() => {
    if (result) return undefined;
    const t = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [result]);

  async function loadPaper() {
    setLoading(true);
    try {
      const r = await api.get(`/exam-papers/${id}`);
      setPaper(r.data.paper);
      setSections(r.data.sections || []);
      if ((r.data.sections || []).length > 0) setActiveSection(r.data.sections[0].name);
    } catch (err) {
      message.error(err.response?.data?.error || '加载试卷失败');
    } finally {
      setLoading(false);
    }
  }

  const allQuestions = useMemo(
    () => sections.flatMap((s) => s.questions.map((q) => ({ ...q, section: s.name }))),
    [sections]
  );
  const total = allQuestions.length;
  const answeredCount = Object.keys(answers).length;
  const resultMap = useMemo(() => {
    const m = {};
    (result?.results || []).forEach((r) => { m[r.seq] = r; });
    return m;
  }, [result]);

  function selectOption(seq, label) {
    if (result) return; // 交卷后只读
    setAnswers((prev) => {
      const next = { ...prev };
      if (next[seq] === label) delete next[seq];
      else next[seq] = label;
      return next;
    });
  }

  function toggleMark(seq) {
    setMarked((prev) => {
      const next = { ...prev };
      if (next[seq]) delete next[seq];
      else next[seq] = 1;
      return next;
    });
  }

  function scrollToSeq(seq) {
    const el = qRefs.current[seq];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSheetOpen(false);
  }

  async function submit() {
    const unanswered = total - answeredCount;
    Modal.confirm({
      title: '确认交卷？',
      content: `共 ${total} 题，已作答 ${answeredCount} 题${unanswered > 0 ? `，还有 ${unanswered} 题未作答` : ''}。`,
      okText: '交卷', cancelText: '继续答题',
      onOk: async () => {
        setSubmitting(true);
        try {
          const r = await api.post(`/exam-papers/${id}/submit`, { answers });
          setResult(r.data);
          setSheetOpen(false);
          window.scrollTo({ top: 0, behavior: 'smooth' });
          message.success('交卷成功');
        } catch (err) {
          message.error(err.response?.data?.error || '交卷失败');
        } finally {
          setSubmitting(false);
        }
      },
    });
  }

  function cardStatus(seq) {
    if (resultMap[seq]) return resultMap[seq].correct ? 'correct' : 'wrong';
    if (marked[seq]) return 'marked';
    if (answers[seq]) return 'answered';
    return 'unanswered';
  }

  /** 答题卡：按板块分区显示，便于对应真题的模块结构 */
  const renderCardGrid = (list) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: isMobile ? 6 : 8 }}>
      {list.map((q) => {
        const st = cardStatus(q.seq);
        const c = CARD_STATUS_COLOR[st];
        return (
          <div
            key={q.seq}
            onClick={() => scrollToSeq(q.seq)}
            style={{
              width: isMobile ? 34 : 32, height: isMobile ? 34 : 32,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 6, border: `1px solid ${c.border}`, background: c.bg, color: c.color,
              fontSize: 13, cursor: 'pointer', fontWeight: st === 'unanswered' ? 400 : 600,
            }}
            title={`第 ${q.seq} 题${q.section ? '（' + q.section + '）' : ''}${marked[q.seq] ? '（已标记）' : ''}`}
          >
            {q.seq}
          </div>
        );
      })}
    </div>
  );

  const answerSheet = (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>答题卡</Text>
      {sections.length > 0 ? (
        sections.map((s) => (
          <div key={s.name} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text type="secondary" style={{ fontSize: 12, fontWeight: 600 }}>{s.name}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{s.questions.length} 题</Text>
            </div>
            {renderCardGrid(s.questions.map((q) => ({ ...q, section: s.name })))}
          </div>
        ))
      ) : (
        renderCardGrid(allQuestions)
      )}
      <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 12 }}>
        {[
          { k: 'answered', t: '已答' },
          { k: 'unanswered', t: '未答' },
          { k: 'marked', t: '标记' },
          ...(result ? [{ k: 'correct', t: '正确' }, { k: 'wrong', t: '错误' }] : []),
        ].map(({ k, t }) => (
          <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              width: 12, height: 12, borderRadius: 3, display: 'inline-block',
              background: CARD_STATUS_COLOR[k].bg, border: `1px solid ${CARD_STATUS_COLOR[k].border}`,
            }} />
            {t}
          </span>
        ))}
      </div>
    </div>
  );

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '80px 0' }}><Spin size="large" tip="加载整卷中..." /></div>;
  }

  if (!paper || total === 0) {
    return <Empty description="该试卷暂无可作答的题目" />;
  }

  return (
    <div style={{ paddingBottom: isMobile ? 80 : 24 }}>
      {/* 顶部信息栏 */}
      <Card
        size="small"
        style={{ position: 'sticky', top: 0, zIndex: 20, marginBottom: 16, boxShadow: '0 2px 8px rgba(0,0,0,0.06)' }}
        styles={{ body: { padding: isMobile ? '10px 12px' : '12px 16px' } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate('/exam-papers')}>
            {!isMobile && '返回'}
          </Button>
          <Text strong ellipsis style={{ flex: 1, minWidth: 120, fontSize: isMobile ? 14 : 16 }}>
            {paper.title}
          </Text>
          <Space size={8}>
            <Tag icon={<ClockCircleOutlined />} color="blue">{fmtTime(elapsed)}</Tag>
            <Text type="secondary" style={{ fontSize: 13 }}>
              已答 {answeredCount}/{total}
            </Text>
            {isMobile && (
              <Button size="small" icon={<DashboardOutlined />} onClick={() => setSheetOpen(true)}>答题卡</Button>
            )}
            <Button
              type="primary" size="small" loading={submitting}
              disabled={!!result} onClick={submit}
            >
              {result ? '已交卷' : '交卷'}
            </Button>
          </Space>
        </div>
        <Progress
          percent={total ? Math.round((answeredCount / total) * 100) : 0}
          size="small" showInfo={false} style={{ margin: '6px 0 0' }}
        />
      </Card>

      {/* 结果反馈 */}
      {result && (
        <Card style={{ marginBottom: 16, borderRadius: 12 }} styles={{ body: { padding: 16 } }}>
          <Row gutter={16} align="middle">
            <Col flex="auto">
              <Space size={24} wrap>
                <Statistic title="得分" value={result.score} suffix="/ 100" valueStyle={{ color: result.score >= 60 ? '#16a34a' : '#dc2626' }} />
                <Statistic title="答对" value={result.correct} suffix={`/ ${result.total}`} />
                <Statistic title="正确率" value={result.score} suffix="%" />
                <Statistic title="用时" value={fmtTime(elapsed)} />
              </Space>
            </Col>
          </Row>
          {result.bySection && Object.keys(result.bySection).length > 0 && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <Space size={[8, 6]} wrap>
                {Object.entries(result.bySection).map(([name, v]) => (
                  <Tag key={name} color={v.correct / v.total >= 0.6 ? 'green' : 'red'}>
                    {name}：{v.correct}/{v.total}
                  </Tag>
                ))}
              </Space>
            </>
          )}
          <div style={{ marginTop: 12 }}>
            <Text type="secondary">
              下方已展示每道题的答案与解析，红色为答错、绿色为答对；点击答题卡题号可快速定位。
            </Text>
          </div>
        </Card>
      )}

      {/* 分区导航 */}
      <Card size="small" style={{ marginBottom: 16 }} styles={{ body: { padding: isMobile ? 10 : 12 } }}>
        <Space size={[8, 8]} wrap>
          {sections.map((s) => {
            const done = s.questions.filter((q) => answers[q.seq]).length;
            const active = activeSection === s.name;
            return (
              <Tag
                key={s.name}
                color={active ? 'blue' : undefined}
                style={{ cursor: 'pointer', padding: '3px 10px', fontSize: 13 }}
                onClick={() => { setActiveSection(s.name); scrollToSeq(s.questions[0].seq); }}
              >
                {s.name}（{done}/{s.count}）
              </Tag>
            );
          })}
        </Space>
      </Card>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 题目区 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {sections.map((s) => (
            <div key={s.name}>
              <div
                style={{
                  margin: '8px 0 12px', paddingLeft: 8, borderLeft: '3px solid #1D4ED8',
                  fontSize: isMobile ? 15 : 16, fontWeight: 600,
                }}
              >
                {s.name}
                <Text type="secondary" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>
                  共 {s.count} 题
                </Text>
              </div>

              {s.questions.map((q) => {
                const myAnswer = answers[q.seq];
                const res = resultMap[q.seq];
                const isWrong = res && !res.correct;
                return (
                  <Card
                    key={q.seq}
                    size="small"
                    style={{
                      marginBottom: 14, borderRadius: 10, scrollMarginTop: 90,
                      borderColor: isWrong ? '#ffccc7' : undefined,
                    }}
                    styles={{ body: { padding: isMobile ? '12px 14px' : '16px 20px' } }}
                  >
                    <div ref={(el) => { qRefs.current[q.seq] = el; }} />
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 24, height: 24, borderRadius: '50%', background: '#1D4ED8',
                        color: '#fff', fontSize: 13, fontWeight: 600,
                      }}>{q.seq}</span>
                      <Tag color="purple">{q.qtype || '单选题'}</Tag>
                      <Tag color={q.difficulty <= 2 ? 'green' : q.difficulty <= 4 ? 'orange' : 'red'}>
                        难度 {q.difficulty || 3}
                      </Tag>
                      {res && (
                        res.correct
                          ? <Tag icon={<CheckCircleOutlined />} color="success">答对</Tag>
                          : <Tag icon={<CloseCircleOutlined />} color="error">答错</Tag>
                      )}
                      <span
                        onClick={() => toggleMark(q.seq)}
                        style={{ marginLeft: 'auto', cursor: 'pointer', color: marked[q.seq] ? '#fa8c16' : '#bfbfbf' }}
                        title="标记此题"
                      >
                        {marked[q.seq] ? <FlagFilled /> : <FlagOutlined />}
                      </span>
                    </div>

                    {q.passage && (
                      <Paragraph style={{
                        background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8,
                        padding: 12, marginBottom: 12, fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap',
                      }}>
                        {q.passage}
                      </Paragraph>
                    )}

                    {/* 原卷区域截图：图形推理/几何图/统计图表在文本层里没有，只能看图。
                        纯文本题的区域截图只是把题干重拍一遍，与上面的文字重复，
                        默认折叠，需要核对原卷时再展开（懒加载）。 */}
                    {(q.images || []).length > 0 && q.imageNeeded !== false && (
                      <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {q.images.map((src) => {
                          const url = paperImageUrl(src);
                          return (
                            <img
                              key={src}
                              src={url}
                              alt="原卷题目截图"
                              loading="lazy"
                              onClick={() => window.open(url, '_blank')}
                              style={{
                                width: '100%', maxWidth: '100%', border: '1px solid #f0f0f0',
                                borderRadius: 8, background: '#fff', cursor: 'zoom-in', display: 'block',
                              }}
                            />
                          );
                        })}
                      </div>
                    )}

                    {(q.images || []).length > 0 && q.imageNeeded === false && (
                      <div style={{ marginBottom: 12 }}>
                        <a
                          onClick={() => setShotOpen((s) => ({ ...s, [q.seq]: !s[q.seq] }))}
                          style={{ fontSize: 13, color: '#8c8c8c', cursor: 'pointer', userSelect: 'none' }}
                        >
                          {shotOpen[q.seq] ? '收起' : '查看'}原卷截图
                        </a>
                        {shotOpen[q.seq] && (
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {q.images.map((src) => {
                              const url = paperImageUrl(src);
                              return (
                                <img
                                  key={src}
                                  src={url}
                                  alt="原卷题目截图"
                                  loading="lazy"
                                  onClick={() => window.open(url, '_blank')}
                                  style={{
                                    width: '100%', maxWidth: '100%', border: '1px solid #f0f0f0',
                                    borderRadius: 8, background: '#fff', cursor: 'zoom-in', display: 'block',
                                  }}
                                />
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ fontSize: isMobile ? 14 : 15, lineHeight: 1.8, marginBottom: 12, whiteSpace: 'pre-wrap' }}>
                      {q.stem}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {(q.options || []).map((opt, i) => {
                        const label = OPTION_LABELS[i] || String(i);
                        const selected = myAnswer === label;
                        const isRight = res && String(res.answer || '').includes(label);
                        const isMyWrong = res && !res.correct && selected;
                        // 选项在原 PDF 中是图片（图形推理/几何图/统计图），文本层只有占位符
                        const isImageOption = typeof opt === 'string' && /图片选项|^[A-D]$/.test(opt.trim());

                        let bg = '#fff';
                        let border = '#e5e7eb';
                        if (res) {
                          if (isRight) { bg = '#f6ffed'; border = '#b7eb8f'; }
                          if (isMyWrong) { bg = '#fff2f0'; border = '#ffccc7'; }
                        } else if (selected) { bg = '#eff6ff'; border = '#1D4ED8'; }

                        return (
                          <div
                            key={label}
                            onClick={() => selectOption(q.seq, label)}
                            style={{
                              display: 'flex', gap: 10, alignItems: 'flex-start', cursor: result ? 'default' : 'pointer',
                              padding: '10px 12px', borderRadius: 8, border: `1px solid ${border}`, background: bg,
                              fontSize: isMobile ? 14 : 15, lineHeight: 1.7, transition: 'all .15s',
                            }}
                          >
                            <span style={{
                              flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
                              border: `1px solid ${selected || isRight ? border : '#d9d9d9'}`,
                              background: selected || isRight ? border : '#fff',
                              color: selected || isRight ? '#fff' : '#666',
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 12, fontWeight: 600,
                            }}>{label}</span>
                            <span style={{ flex: 1 }}>
                              {isImageOption ? '（该选项在原试卷中为图片）' : opt}
                            </span>
                            {res && isRight && <CheckCircleOutlined style={{ color: '#52c41a', marginTop: 4 }} />}
                            {isMyWrong && <CloseCircleOutlined style={{ color: '#ff4d4f', marginTop: 4 }} />}
                          </div>
                        );
                      })}
                    </div>

                    {res && (
                      <div style={{
                        marginTop: 12, padding: 12, borderRadius: 8,
                        background: res.correct ? '#f6ffed' : '#fff7e6',
                        border: `1px solid ${res.correct ? '#b7eb8f' : '#ffd591'}`,
                      }}>
                        <Space size={12} wrap>
                          <Text strong>答案：{res.answer}</Text>
                          <Text type="secondary">你的作答：{res.yourAnswer || '未作答'}</Text>
                        </Space>
                        {res.explanation && (
                          <div style={{ marginTop: 6, fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
                            <Text strong>解析：</Text>{res.explanation}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          ))}
        </div>

        {/* PC 端右侧答题卡 */}
        {!isMobile && (
          <div style={{ width: 220, flexShrink: 0 }}>
            <Affix offsetTop={90}>
              <Card size="small" style={{ borderRadius: 10 }} styles={{ body: { padding: 12 } }}>
                {answerSheet}
                <Button
                  type="primary" block style={{ marginTop: 12 }} loading={submitting}
                  disabled={!!result} onClick={submit}
                >
                  {result ? '已交卷' : '交卷并查看解析'}
                </Button>
              </Card>
            </Affix>
          </div>
        )}
      </div>

      {/* 移动端答题卡抽屉 + 底部操作条 */}
      {isMobile && (
        <>
          <Drawer
            title="答题卡" placement="bottom" open={sheetOpen}
            onClose={() => setSheetOpen(false)} height="62%"
            styles={{ body: { padding: 14 } }}
          >
            {answerSheet}
          </Drawer>
          <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
            background: '#fff', borderTop: '1px solid #eee', padding: '8px 12px',
            display: 'flex', alignItems: 'center', gap: 10,
            paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
          }}>
            <Text type="secondary" style={{ fontSize: 13 }}>已答 {answeredCount}/{total}</Text>
            <div style={{ flex: 1 }}>
              <Progress percent={total ? Math.round((answeredCount / total) * 100) : 0} size="small" showInfo={false} />
            </div>
            <Button size="small" icon={<DashboardOutlined />} onClick={() => setSheetOpen(true)}>答题卡</Button>
            <Button type="primary" size="small" loading={submitting} disabled={!!result} onClick={submit}>
              交卷
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
