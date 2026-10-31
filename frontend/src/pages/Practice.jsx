import React, { useState, useEffect, useRef } from 'react';
import { Typography, Card, Button, Radio, Space, Select, InputNumber, Progress, message, Spin, Divider, Tag, Modal } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ArrowRightOutlined, ArrowLeftOutlined, ReloadOutlined, ClockCircleOutlined, FileTextOutlined, PauseCircleOutlined, PlayCircleOutlined, StarOutlined } from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption, formatTime } from '../utils';
import { useResponsive } from '../hooks/useResponsive';
import QuestionFeedback from '../components/QuestionFeedback';

const { Title, Text, Paragraph } = Typography;

export default function Practice() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
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
  // 结果页评分：key 为 question_id，value 为 { rating, feedback, updated_at }
  const [feedbacks, setFeedbacks] = useState({});
  const [ratedCount, setRatedCount] = useState(0);
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

  // 页面离开保护 — 确保答题进度能在页面关闭/刷新前发出去
  useEffect(() => {
    function handleBeforeUnload(e) {
      if (step === 'doing' && sessionId) {
        const payload = JSON.stringify({
          session_id: sessionId,
          answers: answersRef.current,
          elapsed_sec: elapsedRef.current
        });
        // 为什么不用 navigator.sendBeacon：
        //   beacon 走的是 no-cors 简单请求，跨域时浏览器**不会带上凭据**，
        //   前后端不同域部署时进度根本存不进去（后端会收到未登录的 401）。
        //   fetch + keepalive 能带 credentials，且浏览器保证在页面卸载时把请求发完。
        const url = `${api.defaults.baseURL || '/api'}/practice/save-progress`;
        try {
          fetch(url, {
            method: 'POST',
            body: payload,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            keepalive: true,
          }).catch(() => { /* 页面正在卸载，失败无法处理 */ });
        } catch (_) {
          // keepalive 不被支持时退回 beacon（同源场景仍可用）
          const blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon('/api/practice/save-progress', blob);
        }
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
        // 查看结果模式。
        // 注意：meta.questions 仅保存 {id, answer}（start 时写入），缺少
        // stem/options_json/explanation 等展示字段；answerDetails 才是
        // 题目完整数据的权威来源。若优先用 meta.questions 会导致结果页
        // 题干、选项、解析全部空白。因此这里统一以 answerDetails 为准，
        // meta.questions 仅在其缺失时作为兜底。
        const source = details.length > 0
          ? details
          : (qs || []).map(q => ({ question_id: q.id, user_answer: (ans || {})[q.id], correct_answer: q.answer }));
        setQuestions(source.map(d => ({
          id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
          answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty
        })));
        // 从 answerDetails 构建 answers
        const ansMap = {};
        for (const d of source) { if (d.user_answer) ansMap[d.question_id] = d.user_answer; }
        setAnswers(ansMap);
        setResult({ session_id: session.id, total: session.total, correct: session.correct, score: session.score, duration_sec: session.duration_sec });
        setAnswerDetails(details);
        setStep('result');
        loadFeedbacks(source.map(d => d.question_id));
      } else if (session.status === 'in_progress') {
        // 恢复答题。
        // 与结果模式同理：meta.questions 只有 {id, answer}，必须改用
        // answerDetails 的完整题目数据，否则恢复后题干/选项/解析全空白。
        setSessionId(session.id);
        let restoreQuestions = details.map(d => ({
          id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
          answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty
        }));
        // 作答优先取 meta.answers（含未提交的进度），缺失时回退 answerDetails
        let restoreAnswers = (ans && Object.keys(ans).length > 0) ? ans : (() => {
          const m = {};
          for (const d of details) { if (d.user_answer) m[d.question_id] = d.user_answer; }
          return m;
        })();
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
          loadFeedbacks(details.map(d => d.question_id));
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

      // 正确答案与解析由服务端在交卷后下发（答题阶段接口不下发，防提前看答案）。
      // 结果页的判定与高亮一律用这份权威数据，不用本地 questions。
      const graded = Array.isArray(r.data.questions) ? r.data.questions : [];
      if (graded.length > 0) setQuestions(graded);

      // 错题练习模式：答对的题目自动移出错题本
      if (wrongRedo && localStorage.getItem('wrongbook_auto_remove') === 'true') {
        const correctIds = graded.filter(q => answers[q.id] === q.answer).map(q => q.id);
        if (correctIds.length > 0) {
          await Promise.allSettled(correctIds.map(qid => api.delete('/practice/wrong-book/by-question/' + qid)));
          message.info('已自动移出 ' + correctIds.length + ' 道已掌握的题目');
        }
      }

      setCurrentIndex(0);
      setStep('result');
      loadFeedbacks((graded.length > 0 ? graded : questions).map(q => q.id));
    } catch (err) {
      message.error('提交失败');
      setStep('doing');
      // 重启计时器
      setStartTime(Date.now());
      setPaused(false);
    }
  }

  /** 结果页加载当前用户对这些题目的已有评分（支持提交后查看/修改） */
  async function loadFeedbacks(questionIds) {
    if (!questionIds || questionIds.length === 0) return;
    try {
      const r = await api.get('/practice/feedback', { params: { ids: questionIds.join(',') } });
      const map = r.data.feedbacks || {};
      setFeedbacks(map);
      setRatedCount(Object.keys(map).length);
    } catch {
      // 评分加载失败不阻塞结果展示，用户仍可重新评分
    }
  }

  if (step === 'loading') return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" tip="加载中..." /></div>;

  // Setup
  if (step === 'setup') {
    return (
      <div style={{ maxWidth: 560, margin: isMobile ? '8px auto' : '32px auto', padding: '0 4px' }}>
        <Card style={{ borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 12px 30px rgba(15, 23, 42, 0.06)' }} bodyStyle={{ padding: isMobile ? 20 : 28 }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ width: 58, height: 58, margin: '0 auto 14px', display: 'grid', placeItems: 'center', borderRadius: 16, color: '#1d4ed8', background: '#eff6ff' }}>
              <FileTextOutlined style={{ fontSize: 28 }} />
            </div>
            <Title level={3} style={{ margin: '0 0 6px', fontSize: isMobile ? 21 : 24 }}>开始练习</Title>
            <Text type="secondary">设置本次练习内容，进度将自动保存</Text>
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
              <Button type="primary" size="large" block onClick={startPractice} style={{ height: 46, borderRadius: 8, fontWeight: 600 }}>{examMode ? '开始考试' : '开始答题'}</Button>
          </Space>
        </Card>
      </div>
    );
  }

  async function requestAiAnalysis(questionId, userAnswer) {
    setAiLoading(prev => ({ ...prev, [questionId]: true }));
    try {
      // AI 生成较慢，单独放宽到 60 秒
      const r = await api.post('/practice/ai-analysis', { question_id: questionId, user_answer: userAnswer }, { timeout: 60000 });
      setAiAnalysis(prev => ({ ...prev, [questionId]: r.data?.analysis }));
    } catch (err) {
      // 后端可能返回业务错误（如 AI 未配置），也可能返回非 JSON（上游异常），
      // 后者取 err.message 会暴露原始响应片段，统一收敛为友好文案
      const msg = err.response?.data?.error;
      message.error(msg || 'AI 解析失败，请稍后重试');
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
            {result.score >= 80 ? <CheckCircleOutlined style={{ fontSize: isMobile ? 48 : 64, color: '#52c41a' }} /> :
             result.score >= 60 ? <CheckCircleOutlined style={{ fontSize: isMobile ? 48 : 64, color: '#faad14' }} /> :
             <CloseCircleOutlined style={{ fontSize: isMobile ? 48 : 64, color: '#ff4d4f' }} />}
          </div>
          <Title level={2} style={{ margin: 0, color: result.score >= 80 ? '#52c41a' : result.score >= 60 ? '#faad14' : '#ff4d4f' }}>{result.score} 分</Title>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))',
            gap: 12, marginTop: 16,
          }}>
            <div><Text type="secondary">答对</Text><br /><Text strong style={{ fontSize: 20 }}>{result.correct}</Text></div>
            <div><Text type="secondary">答错</Text><br /><Text strong style={{ fontSize: 20 }}>{result.total - result.correct}</Text></div>
            <div><Text type="secondary">总题数</Text><br /><Text strong style={{ fontSize: 20 }}>{result.total}</Text></div>
            <div><Text type="secondary">用时</Text><br /><Text strong style={{ fontSize: 20 }}>{formatTime(result.duration_sec)}</Text></div>
          </div>
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
          {/* 评分进度：让用户清楚还需评价几题 */}
          <div style={{ marginTop: 16 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>
              已评价 <Text strong style={{ color: '#faad14' }}>{ratedCount}</Text> / {questions.length} 题
              {ratedCount === questions.length && questions.length > 0 ? '，感谢你的反馈！' : '，下拉为每题评分'}
            </Text>
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
              {/* AI 解析入口：入口文案与配色对全部题目保持一致，
                  后端再按答题对错生成不同侧重点的讲解内容 */}
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
              {/* 评分与反馈：随结果一并展示，提交后可随时修改 */}
              <QuestionFeedback
                questionId={q.id}
                sessionId={result?.session_id}
                initial={feedbacks[q.id] || null}
                onSubmitted={(qid, rating, fb) => {
                  setFeedbacks(prev => ({ ...prev, [qid]: { rating, feedback: fb, updated_at: new Date().toISOString() } }));
                  setRatedCount(prev => (feedbacks[qid] ? prev : prev + 1));
                }}
              />
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
    <div style={{ maxWidth: 900, margin: '0 auto', padding: isMobile ? '0 2px' : '0 16px' }}>
      {/* Top bar */}
      <Card size="small" style={{ marginBottom: 16, position: 'sticky', top: 72, zIndex: 10, borderRadius: 12, boxShadow: '0 6px 18px rgba(15, 23, 42, 0.08)' }} bodyStyle={{ padding: isMobile ? '10px 12px' : '12px 16px' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexWrap: isMobile ? 'wrap' : 'nowrap', gap: isMobile ? 8 : 0,
        }}>
          <Space size={isMobile ? 6 : 8}>
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
          <Progress percent={progress} size="small" showInfo={!isMobile} strokeColor="#2563eb" trailColor="#e2e8f0" style={{ flex: 1, margin: isMobile ? '0' : '0 16px', minWidth: isMobile ? 80 : undefined }} />
          <Space size={isMobile ? 6 : 8}>
            <Text type="secondary">{answeredCount}/{questions.length}</Text>
            <Button size="small" onClick={() => setShowAnswerCard(true)}>答题卡</Button>
          </Space>
        </div>
      </Card>

      {/* Pause overlay */}
      {paused && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.75)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Card style={{ textAlign: 'center', width: '100%', maxWidth: 420 }}>
            <PauseCircleOutlined style={{ fontSize: isMobile ? 48 : 64, color: '#1890ff', marginBottom: 16 }} />
            <Title level={3} style={{ margin: 0 }}>练习已暂停</Title>
            <Text type="secondary" style={{ display: 'block', margin: '12px 0 24px' }}>计时已暂停，点击继续恢复答题</Text>
            <Space direction={isMobile ? 'vertical' : 'horizontal'} style={{ width: '100%' }}>
              <Button type="primary" size="large" icon={<PlayCircleOutlined />} onClick={togglePause} style={{ width: isMobile ? '100%' : undefined }}>继续答题</Button>
              <Button size="large" danger onClick={() => { saveProgress(); if (timerRef.current) clearInterval(timerRef.current); if (autoSaveRef.current) clearInterval(autoSaveRef.current); setStep('setup'); navigate('/practice'); }} style={{ width: isMobile ? '100%' : undefined }}>退出并保存</Button>
            </Space>
          </Card>
        </div>
      )}

      {/* Question card */}
      <Card style={{ borderRadius: 16, border: '1px solid #e2e8f0' }} bodyStyle={{ padding: isMobile ? 18 : 28 }}>
        <div style={{ marginBottom: 16 }}>
          <Tag color="blue">第 {currentIndex + 1} 题</Tag>
          {q.qtype && <Tag>{q.qtype}</Tag>}
        </div>

        {q.passage && (
          <div style={{ marginBottom: 20, padding: isMobile ? 14 : 16, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, lineHeight: 1.9, fontSize: 15 }}>{q.passage}</div>
        )}

        <Text strong style={{ fontSize: isMobile ? 16 : 17, lineHeight: 1.7, display: 'block', marginBottom: 20 }}>{q.stem}</Text>

        <Radio.Group value={answers[q.id]} onChange={e => selectAnswer(q.id, e.target.value)} style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {parseOptions(q.options_json).map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              const isSelected = answers[q.id] === letter;
              return (
                <Radio key={i} value={letter} style={{
                  width: '100%', padding: isMobile ? '13px 14px' : '15px 16px',
                  border: '1px solid ' + (isSelected ? '#2563eb' : '#e2e8f0'),
                  borderRadius: 10, margin: 0,
                  background: isSelected ? '#eff6ff' : '#fff',
                  display: 'flex', alignItems: 'center',
                  transition: 'all 0.18s ease',
                  boxShadow: isSelected ? '0 0 0 3px rgba(37, 99, 235, 0.1)' : 'none',
                }}>
                  <Text style={{ fontSize: 15, lineHeight: 1.65 }}><strong style={{ color: isSelected ? '#1d4ed8' : undefined }}>{letter}.</strong> {cleanOption(opt)}</Text>
                </Radio>
              );
            })}
          </Space>
        </Radio.Group>

        <div style={{ marginTop: 28, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
          <Button size={isMobile ? 'middle' : 'large'} icon={<ArrowLeftOutlined />} onClick={() => { if (currentIndex > 0) setCurrentIndex(currentIndex - 1); }} disabled={currentIndex === 0}>上一题</Button>
          {currentIndex === questions.length - 1 ? (
            <Button size={isMobile ? 'middle' : 'large'} type="primary" danger onClick={submitPractice}>交卷</Button>
          ) : (
            <Button size={isMobile ? 'middle' : 'large'} type="primary" onClick={() => { setCurrentIndex(currentIndex + 1); saveProgress(); }}>下一题 <ArrowRightOutlined /></Button>
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
