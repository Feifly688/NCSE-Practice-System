import React, { useState, useEffect, useRef } from 'react';
import { Typography, Card, Button, Radio, Space, Select, InputNumber, Progress, message, Spin, Divider, Tag, Modal } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ArrowRightOutlined, ArrowLeftOutlined, ReloadOutlined, ClockCircleOutlined, FileTextOutlined, PauseCircleOutlined, PlayCircleOutlined, StarOutlined } from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption, formatTime } from '../utils';

const { Title, Text, Paragraph } = Typography;

export default function Practice() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const resumeSessionId = searchParams.get('session');
  const viewMode = searchParams.get('view');
  const wrongRedo = searchParams.get('wrongredo') === 'true';

  const [step, setStep] = useState('setup');
  const [subjects, setSubjects] = useState([]);
  const [selectedSubject, setSelectedSubject] = useState(null);
  const [count, setCount] = useState(10);
  const [filterQtype, setFilterQtype] = useState(null);
  const [examMode, setExamMode] = useState(false);
  const [examMinutes, setExamMinutes] = useState(30);
  const [aiAnalysis, setAiAnalysis] = useState({});
  const [aiLoading, setAiLoading] = useState({});
  const [questions, setQuestions] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState({});
  const [startTime, setStartTime] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [pausedElapsed, setPausedElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [showAnswerCard, setShowAnswerCard] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  const [answerDetails, setAnswerDetails] = useState([]);
  const timerRef = useRef(null);
  const autoSaveRef = useRef(null);
  const answersRef = useRef(answers);
  const elapsedRef = useRef(elapsed);
  answersRef.current = answers;
  elapsedRef.current = elapsed;

  // 加载科目列表
  useEffect(() => {
    api.get('/questions/subjects').then(r => {
      setSubjects(r.data.subjects);
      if (r.data.subjects.length > 0) setSelectedSubject(r.data.subjects[0].id);
    });
  }, []);

  // 恢复答题或查看结果
  useEffect(() => {
    if (resumeSessionId) {
      loadSession(resumeSessionId);
    }
  }, [resumeSessionId]);

  // 计时器
  useEffect(() => {
    if (step === 'doing' && !paused) {
      timerRef.current = setInterval(() => {
        const elapsedNow = pausedElapsed + Math.floor((Date.now() - startTime) / 1000);
        if (examMode) {
          const remaining = examMinutes * 60 - elapsedNow;
          if (remaining <= 0) {
            setElapsed(examMinutes * 60);
            clearInterval(timerRef.current);
            doSubmit().catch(() => message.error('自动交卷失败'));
            return;
          }
          setElapsed(remaining);
        } else {
          setElapsed(elapsedNow);
        }
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [step, paused, startTime, pausedElapsed]);

  // 自动保存进度（每30秒）— 使用 ref 读取最新状态，避免频繁重建 interval
  useEffect(() => {
    if (step === 'doing' && sessionId) {
      autoSaveRef.current = setInterval(() => {
        saveProgressRef();
      }, 30000);
    }
    return () => { if (autoSaveRef.current) clearInterval(autoSaveRef.current); };
  }, [step, sessionId]);

  // 页面离开保护 — 使用 sendBeacon 确保请求能发出
  useEffect(() => {
    function handleBeforeUnload(e) {
      if (step === 'doing' && sessionId) {
        const blob = new Blob([JSON.stringify({
          session_id: sessionId,
          answers: answersRef.current,
          elapsed_sec: elapsedRef.current
        })], { type: 'application/json' });
        navigator.sendBeacon('/api/practice/save-progress', blob);
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [step, sessionId]);

  useEffect(() => {
    if (step === 'doing') {
      window.history.pushState(null, '', window.location.href);
      function handlePopState() {
        window.history.pushState(null, '', window.location.href);
        Modal.confirm({
          title: '提示', content: '正在答题中，确认要退出吗？进度将自动保存。',
          okText: '确认退出', cancelText: '继续答题',
          onOk: () => { saveProgress(); setStep('setup'); if (timerRef.current) clearInterval(timerRef.current); if (wrongRedo) navigate('/wrong-book'); }
        });
      }
      window.addEventListener('popstate', handlePopState);
      return () => window.removeEventListener('popstate', handlePopState);
    }
  }, [step, answers, elapsed]);

  async function loadSession(sid) {
    setStep('loading');
    try {
      const r = await api.get('/practice/session/' + sid);
      const { session, questions: qs, answers: ans, elapsed_sec, answerDetails: details } = r.data;

      if (viewMode === 'result' && session.status === 'completed') {
        // 查看结果模式
        setQuestions(qs.length > 0 ? qs : details.map(d => ({
          id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
          answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty
        })));
        // 从 answerDetails 构建 answers
        const ansMap = {};
        for (const d of details) { ansMap[d.question_id] = d.user_answer; }
        setAnswers(ansMap);
        setResult({ session_id: session.id, total: session.total, correct: session.correct, score: session.score, duration_sec: session.duration_sec });
        setAnswerDetails(details);
        setStep('result');
      } else if (session.status === 'in_progress') {
        // 恢复答题
        setSessionId(session.id);
        let restoreQuestions = qs;
        let restoreAnswers = ans || {};
        // 如果 meta_json 里没有 questions，尝试从 answerDetails 恢复
        if (restoreQuestions.length === 0 && details.length > 0) {
          restoreQuestions = details.map(d => ({
            id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
            answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty
          }));
          const ansMap = {};
          for (const d of details) { ansMap[d.question_id] = d.user_answer; }
          restoreAnswers = ansMap;
        }
        if (restoreQuestions.length === 0) {
          message.warning('该答题记录数据不完整，建议重新开始');
          setStep('setup');
          return;
        }
        setQuestions(restoreQuestions);
        setAnswers(restoreAnswers);
        setCurrentIndex(0);
        const savedElapsed = elapsed_sec || 0;
        setElapsed(savedElapsed);
        setPausedElapsed(savedElapsed);
        setStartTime(Date.now());
        setPaused(false);
        setStep('doing');
        message.success('已恢复答题进度');
      } else if (session.status === 'completed') {
        // 已完成但没有 questions（旧数据），用 answerDetails
        if (details.length > 0) {
          setQuestions(details.map(d => ({
            id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
            answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty
          })));
          const ansMap = {};
          for (const d of details) { ansMap[d.question_id] = d.user_answer; }
          setAnswers(ansMap);
          setResult({ session_id: session.id, total: session.total, correct: session.correct, score: session.score, duration_sec: session.duration_sec });
          setStep('result');
        } else {
          message.error('答题数据不完整');
          setStep('setup');
        }
      } else {
        message.error('无法恢复此答题');
        setStep('setup');
      }
    } catch (err) {
      message.error('加载答题记录失败');
      setStep('setup');
    }
  }

  async function saveProgress() {
    if (!sessionId || !answers) return;
    try {
      await api.post('/practice/save-progress', {
        session_id: sessionId,
        answers,
        elapsed_sec: elapsed
      });
    } catch (err) { /* auto-save silent fail */ }
  }

  // 用 ref 读取最新值，供 interval 和 beforeunload 使用
  function saveProgressRef() {
    if (!sessionId || !answersRef.current) return;
    api.post('/practice/save-progress', {
      session_id: sessionId,
      answers: answersRef.current,
      elapsed_sec: elapsedRef.current
    }).catch(() => {});
  }

  async function startPractice() {
    if (!selectedSubject) { message.warning('请选择科目'); return; }
    setStep('loading');
    try {
      const subject = subjects.find(s => s.id === selectedSubject);
      const r = await api.get('/questions/random', { params: { count, subject: subject.slug, qtype: filterQtype } });
      if (r.data.questions.length === 0) { message.error('该科目暂无题目'); setStep('setup'); return; }

      // 如果实际题目数少于请求数，提示用户
      if (r.data.questions.length < count) {
        message.warning(`该科目只有 ${r.data.questions.length} 道题，将全部练习`);
      }

      const qs = r.data.questions;
      setQuestions(qs);
      setAnswers({});
      setCurrentIndex(0);

      // 创建答题会话
      const startRes = await api.post('/practice/start', { subject_id: selectedSubject, questions: qs });
      setSessionId(startRes.data.session_id);

      setStartTime(Date.now());
      setElapsed(examMode ? examMinutes * 60 : 0);
      setPausedElapsed(0);
      setPaused(false);
      setStep('doing');
    } catch (err) { message.error('获取题目失败'); setStep('setup'); }
  }

  function selectAnswer(questionId, value) {
    setAnswers(prev => ({ ...prev, [questionId]: value }));
  }

  function togglePause() {
    if (!paused) {
      if (timerRef.current) clearInterval(timerRef.current);
      // 无论练习还是考试模式，都记录已用时间
      const usedTime = examMode ? (examMinutes * 60 - elapsed) : elapsed;
      setPausedElapsed(usedTime);
      saveProgress();
      setPaused(true);
    } else {
      setStartTime(Date.now());
      setPaused(false);
    }
  }

  function goToQuestion(idx) {
    setCurrentIndex(idx);
    setShowAnswerCard(false);
  }

  async function submitPractice() {
    const unanswered = questions.filter(q => !answers[q.id]);
    if (unanswered.length > 0) {
      Modal.confirm({
        title: '提示', content: '还有 ' + unanswered.length + ' 题未作答，确定要交卷吗？',
        onOk: () => doSubmit()
      });
      return;
    }
    doSubmit();
  }

  async function doSubmit() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    setStep('loading');
    try {
      const durationSec = examMode ? (examMinutes * 60 - elapsed) : (elapsed || Math.floor((Date.now() - startTime) / 1000));
      const r = await api.post('/practice/submit', {
        session_id: sessionId,
        answers,
        elapsed_sec: durationSec
      });
      setResult({ ...r.data, duration_sec: durationSec });

      // 错题练习模式：答对的题目自动移出错题本
      if (wrongRedo && localStorage.getItem('wrongbook_auto_remove') === 'true') {
        const correctIds = questions.filter(q => answers[q.id] === q.answer).map(q => q.id);
        if (correctIds.length > 0) {
          await Promise.allSettled(correctIds.map(qid => api.delete('/practice/wrong-book/by-question/' + qid)));
          message.info('已自动移出 ' + correctIds.length + ' 道已掌握的题目');
        }
      }

      setCurrentIndex(0);
      setStep('result');
    } catch (err) {
      message.error('提交失败');
      setStep('doing');
      // 重启计时器
      setStartTime(Date.now());
      setPaused(false);
    }
  }

  if (step === 'loading') return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" tip="加载中..." /></div>;

  // Setup
  if (step === 'setup') {
    return (
      <div style={{ maxWidth: 500, margin: '40px auto' }}>
        <Card>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <FileTextOutlined style={{ fontSize: 48, color: '#1890ff', marginBottom: 16 }} />
            <Title level={4} style={{ margin: 0 }}>开始练习</Title>
          </div>
          <Space direction="vertical" style={{ width: '100%' }} size="large">
            <div>
              <Text strong>选择科目</Text>
              <Select style={{ width: '100%', marginTop: 8 }} placeholder="请选择科目" value={selectedSubject}
                onChange={setSelectedSubject} options={subjects.map(s => ({ label: s.name, value: s.id }))} />
            </div>
            <div>
              <Text strong>题目数量</Text>
              <InputNumber style={{ width: '100%', marginTop: 8 }} min={1} max={50} value={count} onChange={setCount} />
            </div>
            <div>
              <Text strong>题型筛选</Text>
              <Select style={{ width: '100%', marginTop: 8 }} allowClear placeholder="全部题型" value={filterQtype}
                onChange={setFilterQtype}
                options={
                  subjects.find(s => s.id === selectedSubject)?.slug === 'politics'
                    ? ['单选题', '多选题', '判断题'].map(t => ({ label: t, value: t }))
                    : ['意图判断', '主旨概括', '细节理解', '标题填入', '下文推断'].map(t => ({ label: t, value: t }))
                } />
            </div>
            <div>
              <Space>
                <Text strong>考试模式</Text>
                <Radio.Group value={examMode} onChange={e => setExamMode(e.target.value)}>
                  <Radio.Button value={false}>练习</Radio.Button>
                  <Radio.Button value={true}>模拟考试</Radio.Button>
                </Radio.Group>
              </Space>
              {examMode && (
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">考试时长（分钟）：</Text>
                  <InputNumber style={{ width: 80, marginLeft: 8 }} min={10} max={180} value={examMinutes} onChange={setExamMinutes} />
                  <Text type="secondary" style={{ marginLeft: 8 }}>不可暂停，时间到自动交卷</Text>
                </div>
              )}
            </div>
            <Button type="primary" size="large" block onClick={startPractice}>{examMode ? '开始考试' : '开始答题'}</Button>
          </Space>
        </Card>
      </div>
    );
  }

  async function requestAiAnalysis(questionId, userAnswer) {
    setAiLoading(prev => ({ ...prev, [questionId]: true }));
    try {
      const r = await api.post('/practice/ai-analysis', { question_id: questionId, user_answer: userAnswer });
      setAiAnalysis(prev => ({ ...prev, [questionId]: r.data.analysis }));
    } catch (err) {
      message.error(err.response?.data?.error || 'AI 解析失败');
    } finally {
      setAiLoading(prev => ({ ...prev, [questionId]: false }));
    }
  }

  // Result
  if (step === 'result') {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 16px' }}>
        <Card style={{ marginBottom: 16, textAlign: 'center' }}>
          <div style={{ marginBottom: 16 }}>
            {result.score >= 80 ? <CheckCircleOutlined style={{ fontSize: 64, color: '#52c41a' }} /> :
             result.score >= 60 ? <CheckCircleOutlined style={{ fontSize: 64, color: '#faad14' }} /> :
             <CloseCircleOutlined style={{ fontSize: 64, color: '#ff4d4f' }} />}
          </div>
          <Title level={2} style={{ margin: 0, color: result.score >= 80 ? '#52c41a' : result.score >= 60 ? '#faad14' : '#ff4d4f' }}>{result.score} 分</Title>
          <Space size="large" style={{ marginTop: 16 }}>
            <div><Text type="secondary">答对</Text><br /><Text strong style={{ fontSize: 20 }}>{result.correct}</Text></div>
            <div><Text type="secondary">答错</Text><br /><Text strong style={{ fontSize: 20 }}>{result.total - result.correct}</Text></div>
            <div><Text type="secondary">总题数</Text><br /><Text strong style={{ fontSize: 20 }}>{result.total}</Text></div>
            <div><Text type="secondary">用时</Text><br /><Text strong style={{ fontSize: 20 }}>{formatTime(result.duration_sec)}</Text></div>
          </Space>
          <div style={{ marginTop: 24 }}>
            <Space>
              {wrongRedo ? (
                <>
                  <Button type="primary" icon={<ReloadOutlined />} onClick={() => navigate('/wrong-book')}>返回错题本</Button>
                  <Button onClick={() => { setStep('setup'); navigate('/practice'); }}>普通练习</Button>
                </>
              ) : (
                <>
                  <Button type="primary" icon={<ReloadOutlined />} onClick={() => { setStep('setup'); navigate('/practice'); }}>再来一次</Button>
                  <Button onClick={() => navigate('/history')}>返回历史</Button>
                </>
              )}
            </Space>
          </div>
        </Card>

        {questions.map((q, idx) => {
          const userAns = answers[q.id];
          const isCorrect = userAns === q.answer;
          return (
            <Card key={q.id} style={{ marginBottom: 12, borderLeft: '4px solid ' + (isCorrect ? '#52c41a' : '#ff4d4f') }}>
              <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? '正确' : '错误'}</Tag><Text type="secondary"> 第 {idx + 1} 题</Text></div><Button size="small" icon={<StarOutlined />} onClick={async () => { try { await api.post('/practice/favorites', { question_id: q.id }); message.success('已收藏'); } catch(e) { message.error('收藏失败'); } }}>收藏</Button></div>
              {q.passage && <div style={{ marginBottom: 12, padding: 12, background: '#fafafa', borderRadius: 6, lineHeight: 1.8 }}>{q.passage}</div>}
              <Text strong>{q.stem}</Text>
              <div style={{ marginTop: 12 }}>
                {parseOptions(q.options_json).map((opt, i) => {
                  const letter = String.fromCharCode(65 + i);
                  let bg = '#fff', border = '1px solid #f0f0f0';
                  if (letter === q.answer) { bg = '#f6ffed'; border = '1px solid #b7eb8f'; }
                  if (letter === userAns && !isCorrect) { bg = '#fff2f0'; border = '1px solid #ffccc7'; }
                  return (
                    <div key={i} style={{ padding: '8px 12px', marginBottom: 4, borderRadius: 6, background: bg, border }}>
                      <Text type={letter === q.answer ? 'success' : (letter === userAns && !isCorrect ? 'danger' : undefined)}>
                        {letter}. {cleanOption(opt)}{letter === q.answer && ' ✓'}
                      </Text>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8 }}><Text type="secondary">你的答案：{userAns || '未答'} | 正确答案：{q.answer}</Text></div>
              {q.explanation && <div style={{ marginTop: 8, padding: '8px 12px', background: '#e6f7ff', borderRadius: 6 }}><Text type="secondary">解析：{q.explanation}</Text></div>}
              {!isCorrect && (
                <div style={{ marginTop: 8 }}>
                  {aiAnalysis[q.id] ? (
                    <div style={{ padding: '8px 12px', background: '#fff7e6', borderRadius: 6, border: '1px solid #ffd591' }}>
                      <Text strong style={{ color: '#fa8c16' }}>AI 解析：</Text>
                      <Text style={{ display: 'block', marginTop: 4 }}>{aiAnalysis[q.id]}</Text>
                    </div>
                  ) : (
                    <Button size="small" loading={aiLoading[q.id]} onClick={() => requestAiAnalysis(q.id, userAns)}>
                      AI 解析
                    </Button>
                  )}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    );
  }

  // Doing
  const q = questions[currentIndex];
  const answeredCount = Object.keys(answers).length;
  const progress = Math.round((answeredCount / questions.length) * 100);

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 16px' }}>
      {/* Top bar */}
      <Card size="small" style={{ marginBottom: 12, position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            {!wrongRedo && (
              <>
                <ClockCircleOutlined />
                <Text strong style={{ fontSize: 16, fontFamily: 'monospace', color: examMode && elapsed < 60 ? '#ff4d4f' : undefined }}>{examMode ? '-' : ''}{formatTime(elapsed)}</Text>
                {!examMode && (
                  <Button size="small" type={paused ? 'primary' : 'default'} icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                    onClick={togglePause}>{paused ? '继续' : '暂停'}</Button>
                )}
              </>
            )}
            {wrongRedo && <Text type="secondary">错题练习</Text>}
          </Space>
          <Progress percent={progress} size="small" style={{ flex: 1, margin: '0 16px' }} />
          <Space>
            <Text type="secondary">{answeredCount}/{questions.length}</Text>
            <Button size="small" onClick={() => setShowAnswerCard(true)}>答题卡</Button>
          </Space>
        </div>
      </Card>

      {/* Pause overlay */}
      {paused && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Card style={{ textAlign: 'center', minWidth: 300 }}>
            <PauseCircleOutlined style={{ fontSize: 64, color: '#1890ff', marginBottom: 16 }} />
            <Title level={3} style={{ margin: 0 }}>练习已暂停</Title>
            <Text type="secondary" style={{ display: 'block', margin: '12px 0 24px' }}>计时已暂停，点击继续恢复答题</Text>
            <Button type="primary" size="large" icon={<PlayCircleOutlined />} onClick={togglePause} style={{ marginRight: 12 }}>继续答题</Button>
            <Button size="large" danger onClick={() => { saveProgress(); if (timerRef.current) clearInterval(timerRef.current); if (autoSaveRef.current) clearInterval(autoSaveRef.current); setStep('setup'); navigate('/practice'); }}>退出并保存</Button>
          </Card>
        </div>
      )}

      {/* Question card */}
      <Card>
        <div style={{ marginBottom: 16 }}>
          <Tag color="blue">第 {currentIndex + 1} 题</Tag>
          {q.qtype && <Tag>{q.qtype}</Tag>}
        </div>

        {q.passage && (
          <div style={{ marginBottom: 20, padding: 16, background: '#fafafa', borderRadius: 8, lineHeight: 2, fontSize: 15 }}>{q.passage}</div>
        )}

        <Text strong style={{ fontSize: 16, display: 'block', marginBottom: 20 }}>{q.stem}</Text>

        <Radio.Group value={answers[q.id]} onChange={e => selectAnswer(q.id, e.target.value)} style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {parseOptions(q.options_json).map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              const isSelected = answers[q.id] === letter;
              return (
                <Radio key={i} value={letter} style={{
                  width: '100%', padding: '14px 16px',
                  border: '1px solid ' + (isSelected ? '#1890ff' : '#f0f0f0'),
                  borderRadius: 8, margin: 0,
                  background: isSelected ? '#e6f7ff' : '#fff',
                  display: 'flex', alignItems: 'center'
                }}>
                  <Text style={{ fontSize: 15 }}>{letter}. {cleanOption(opt)}</Text>
                </Radio>
              );
            })}
          </Space>
        </Radio.Group>

        <div style={{ marginTop: 32, display: 'flex', justifyContent: 'space-between' }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => { if (currentIndex > 0) setCurrentIndex(currentIndex - 1); }} disabled={currentIndex === 0}>上一题</Button>
          {currentIndex === questions.length - 1 ? (
            <Button type="primary" danger onClick={submitPractice}>交卷</Button>
          ) : (
            <Button type="primary" onClick={() => { setCurrentIndex(currentIndex + 1); saveProgress(); }}>下一题 <ArrowRightOutlined /></Button>
          )}
        </div>
      </Card>

      {/* Answer card modal */}
      <Modal title="答题卡" open={showAnswerCard} onCancel={() => setShowAnswerCard(false)} footer={null} width={400}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {questions.map((q, idx) => {
            const isAnswered = !!answers[q.id];
            const isCurrent = idx === currentIndex;
            return (
              <Button key={idx} size="small" type={isCurrent ? 'primary' : 'default'} style={{
                width: 40, height: 40,
                background: isCurrent ? '#1890ff' : isAnswered ? '#52c41a' : '#fff',
                color: isCurrent || isAnswered ? '#fff' : '#000',
                border: isCurrent || isAnswered ? 'none' : '1px solid #d9d9d9'
              }} onClick={() => goToQuestion(idx)}>{idx + 1}</Button>
            );
          })}
        </div>
        <Divider />
        <Space>
          <div><div style={{ width: 16, height: 16, background: '#52c41a', borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 已答</div>
          <div><div style={{ width: 16, height: 16, background: '#fff', border: '1px solid #d9d9d9', borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 未答</div>
          <div><div style={{ width: 16, height: 16, background: '#1890ff', borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 当前</div>
        </Space>
      </Modal>
    </div>
  );
}