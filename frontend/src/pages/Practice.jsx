import React, { useState, useEffect, useRef } from 'react';
import { Typography, Card, Button, Radio, Space, Select, InputNumber, Progress, message, Spin, Divider, Tag, Modal } from 'antd';
import { CheckCircleOutlined, CloseCircleOutlined, ArrowRightOutlined, ArrowLeftOutlined, ReloadOutlined, ClockCircleOutlined, FileTextOutlined, PauseCircleOutlined, PlayCircleOutlined, StarOutlined, StarFilled, FlagOutlined, FlagFilled } from '@ant-design/icons';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../services/api';
import { parseOptions, cleanOption, formatTime } from '../utils';
import { useResponsive } from '../hooks/useResponsive';
import { useTheme } from '../contexts/ThemeContext';
import ThemeToggle from '../components/ThemeToggle';

const { Title, Text, Paragraph } = Typography;

/** 粉笔式错因标签，与后端 wrong_book.reason_tag 取值一致 */
const REASON_OPTIONS = [
  { value: 'unset', label: '未标注' },
  { value: 'concept', label: '概念不清' },
  { value: 'calculation', label: '计算失误' },
  { value: 'reading', label: '审题不清' },
  { value: 'time', label: '时间不够' },
  { value: 'other', label: '其他' },
];

/** 从 answerDetails 构建 { question_id: time_spent_sec }；缺失 / 非法 / 0 一律记 0。 */
function timingsFromDetails(details) {
  const m = {};
  for (const d of details || []) m[d.question_id] = Number(d.time_spent_sec) || 0;
  return m;
}

/** 逐题用时展示：老数据 time_spent_sec 为 0 时给简短文案，不铺陈说明。 */
function fmtQTime(sec) {
  const n = Number(sec) || 0;
  return n > 0 ? formatTime(n) : '未记录';
}

/** 兼容数组 / 对象 / 缺失三种形态，把进度里的 marked 恢复成 Set。 */
function normalizeMarked(v) {
  if (Array.isArray(v)) return new Set(v.map(Number).filter(Number.isFinite));
  if (v && typeof v === 'object') {
    return new Set(Object.keys(v).filter((k) => v[k]).map(Number).filter(Number.isFinite));
  }
  return new Set();
}

/** 从历史会话响应里挑出报告字段（可能在 data 顶层或 session 内），缺失返回 null。 */
function extractReportFields(data, session) {
  const d = data || {};
  const s = session || {};
  return {
    bySection: d.bySection ?? s.bySection ?? null,
    unanswered: d.unanswered ?? s.unanswered ?? null,
    completion: d.completion ?? s.completion ?? null,
  };
}

/**
 * 结果页分模块报告：
 *  ① 后端 bySection（本次 submit 响应 / 历史接口带回）优先；
 *  ② 缺失时基于 answerDetails + questions 前端兜底按模块名聚合。
 * 完全算不出（题目无模块归属）返回空数组，调用方据此隐藏区块，不报错、不铺说明文字。
 */
function computeReportSections(result, answerDetails, questions, answers, timings) {
  const raw = result?.bySection;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((s) => ({
      name: s.name,
      total: Number(s.total) || 0,
      correct: Number(s.correct) || 0,
      timeSec: Number(s.timeSec ?? s.time_sec) || 0,
    })).filter((s) => s.name != null && s.name !== '');
  }
  const detailById = new Map((answerDetails || []).map((d) => [Number(d.question_id), d]));
  const byName = new Map();
  let hasModule = false;
  for (const q of (questions || [])) {
    const name = q.module_name || q.category_name || q.source;
    if (!name) continue;
    hasModule = true;
    const d = detailById.get(Number(q.id)) || {};
    const correctAns = d.correct_answer ?? q.answer;
    if (correctAns == null || correctAns === '') continue;
    const userAns = d.user_answer ?? answers[q.id];
    const sec = Number(d.time_spent_sec ?? timings[q.id]) || 0;
    const bucket = byName.get(name) || { name, total: 0, correct: 0, timeSec: 0 };
    bucket.total += 1;
    if (userAns && userAns === correctAns) bucket.correct += 1;
    bucket.timeSec += sec;
    byName.set(name, bucket);
  }
  return hasModule ? [...byName.values()] : [];
}

export default function Practice() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const { tokens, isDark, setAnswerScope } = useTheme();
  const resumeSessionId = searchParams.get('session');
  const viewMode = searchParams.get('view');
  const wrongRedo = searchParams.get('wrongredo') === 'true';

  // 专项练习传进来的刷题参数（分类 / 题型 / 难度 / 题量）
  const poolParam = searchParams.get('pool') || '';
  const catParam = searchParams.get('categories') || '';
  const qtypeParam = searchParams.get('qtypes') || '';
  const diffParam = searchParams.get('difficulty') || '';
  const countParam = Number(searchParams.get('count')) || 0;
  const subjectParam = Number(searchParams.get('subject')) || 0; // AI 生成题：科目 id
  const yearModeParam = searchParams.get('yearMode') || '';
  const sourceTypeParam = searchParams.get('sourceType') || '';
  const preferUndoneParam = searchParams.get('preferUndone') === '1';
  const categoryName = searchParams.get('categoryName') || '';
  // 专项限时（分钟）：只允许 0/10/20/30，非法值按 0（不计时）
  const durationMinParam = (() => {
    const n = Number(searchParams.get('durationMin'));
    return [10, 20, 30].includes(n) ? n : 0;
  })();
  const focusWeak = searchParams.get('focusWeak') === '1';
  // 带这些参数进来 = 从专项练习页发起，直接开始出题
  const fromTaxonomy = Boolean(poolParam && (catParam || countParam || qtypeParam || diffParam || subjectParam || focusWeak));
  // 分类名（用于顶部提示当前在刷什么）
  const catLabel = categoryName || (catParam ? `分类 ${catParam}` : '')
    || (poolParam === 'generated' ? 'AI 生成题' : '');

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
  const [favSet, setFavSet] = useState(new Set());
  const [reasonMap, setReasonMap] = useState({});
  // 单题标记集合（题目 id）
  const [marked, setMarked] = useState(new Set());
  const markedRef = useRef(new Set());
  markedRef.current = marked;
  // 交卷防重：提交中 / 已交卷（结果态）都不再触发 doSubmit
  const submittingRef = useRef(false);
  // 计时器与自动交卷 effect 通过 ref 调用最新闭包的 doSubmit
  const doSubmitRef = useRef(null);
  const timerRef = useRef(null);
  const autoSaveRef = useRef(null);
  // 供「从专项练习页带参数进来直接开练」的 effect 调用
  const startPracticeRef = useRef(null);
  const autoStartedRef = useRef(false);
  const answersRef = useRef(answers);
  const elapsedRef = useRef(elapsed);
  // 逐题用时：timingsRef 是同步读写的权威副本，timings 是渲染 / 交卷镜像
  const [timings, setTimings] = useState({});
  const timingsRef = useRef({});
  const currentQidRef = useRef(null);   // 当前正在计时的题目 id
  const dwellStartRef = useRef(null);   // 该次停留的开始时间戳（ms）
  answersRef.current = answers;
  elapsedRef.current = elapsed;

  // 限时：URL 的 durationMin 优先，否则沿用 setup 里的模拟考试
  const timedByUrl = durationMinParam > 0;
  const isTimed = timedByUrl || examMode;
  const limitSec = timedByUrl ? durationMinParam * 60 : (examMode ? examMinutes * 60 : 0);

  // 主题只在答题界面生效；离开答题页自动恢复日间
  useEffect(() => {
    setAnswerScope(true);
    return () => setAnswerScope(false);
  }, [setAnswerScope]);

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

  // 从专项练习页带参数进来 → 直接开练（不显示设置界面）
  useEffect(() => {
    if (!fromTaxonomy || autoStartedRef.current) return;
    autoStartedRef.current = true;
    startPracticeRef.current();
  }, [fromTaxonomy]);

  // 计时器：限时模式记剩余秒数，非限时记累计用时
  useEffect(() => {
    if (step === 'doing' && !paused) {
      timerRef.current = setInterval(() => {
        const elapsedNow = pausedElapsed + Math.floor((Date.now() - startTime) / 1000);
        if (isTimed) {
          setElapsed(Math.max(0, limitSec - elapsedNow));
        } else {
          setElapsed(elapsedNow);
        }
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [step, paused, startTime, pausedElapsed, isTimed, limitSec]);

  // 限时到点自动交卷：复用 doSubmit（内部防重、结算 timings），不弹确认框
  useEffect(() => {
    if (isTimed && step === 'doing' && !paused && limitSec > 0 && elapsed <= 0) {
      if (doSubmitRef.current) doSubmitRef.current().catch(() => message.error('自动交卷失败'));
    }
  }, [elapsed, isTimed, step, paused, limitSec]);

  /** 把一段停留秒数累加到某题的用时里。 */
  function addTiming(qid, dt) {
    if (qid == null || dt <= 0) return;
    const next = { ...timingsRef.current, [qid]: (Number(timingsRef.current[qid]) || 0) + dt };
    timingsRef.current = next;
    setTimings(next);
  }

  /** 结算当前题已停留的时长（切题 / 暂停 / 离开答题态 / 交卷时调用）。 */
  function settleDwell() {
    const now = Date.now();
    if (dwellStartRef.current != null && currentQidRef.current != null) {
      addTiming(currentQidRef.current, Math.floor((now - dwellStartRef.current) / 1000));
    }
    dwellStartRef.current = null;
    currentQidRef.current = null;
  }

  // 逐题用时：进入某题记开始时间，切题 / 暂停 / 离开答题态时结算上一段停留。
  // 以墙钟时间戳为准，暂停期间不计入；只在答题态且未暂停时开始新的停留。
  useEffect(() => {
    settleDwell();
    if (step !== 'doing' || paused) return;
    const qid = questions[currentIndex]?.id;
    if (qid == null) return;
    currentQidRef.current = qid;
    dwellStartRef.current = Date.now();
  }, [step, currentIndex, paused, questions]);

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
          elapsed_sec: elapsedRef.current,
          marked: Array.from(markedRef.current)
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
    submittingRef.current = false;
    setMarked(new Set());
    // 重新载入会话时清掉上一段答题的停留计时，避免串场
    currentQidRef.current = null;
    dwellStartRef.current = null;
    try {
      const r = await api.get('/practice/session/' + sid);
      const { session, questions: qs, answers: ans, elapsed_sec, answerDetails: details } = r.data;
      // 会话接口返回的完整题目带来源/模块/二级分类，结果页按 id 补齐到每题
      const metaById = new Map((qs || []).map(q => [Number(q.id), q]));

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
        setQuestions(source.map(d => {
          const meta = metaById.get(Number(d.question_id)) || {};
          return {
            id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
            answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty,
            source: meta.source || '', module_name: meta.module_name || '', category_name: meta.category_name || '',
          };
        }));
        // 从 answerDetails 构建 answers
        const ansMap = {};
        for (const d of source) { if (d.user_answer) ansMap[d.question_id] = d.user_answer; }
        setAnswers(ansMap);
        setResult({ session_id: session.id, total: session.total, correct: session.correct, score: session.score, duration_sec: session.duration_sec, ...extractReportFields(r.data, session) });
        setAnswerDetails(details);
        // 历史详情的逐题用时来自 practice_answer.time_spent_sec（老数据为 0）
        const tm = timingsFromDetails(source);
        timingsRef.current = tm;
        setTimings(tm);
        setStep('result');
      } else if (session.status === 'in_progress') {
        // 恢复答题。
        // 服务端 /session/:id 已按 meta 顺序返回完整题目（questions）。
        // 新会话（例如「重做错题」刚由 /practice/start 创建）尚未产生
        // practice_answer，answerDetails 为空；旧实现只认 details，会误判
        // 「该答题记录数据不完整」，导致重做错题永远打不开。
        // 答案/解析不进入答题态 state，判分与结果页一律以 /submit 下发为准。
        setSessionId(session.id);
        // 恢复答题时逐题用时从零重新累计（进度里未持久化 timings）
        timingsRef.current = {};
        setTimings({});
        currentQidRef.current = null;
        dwellStartRef.current = null;
        let restoreQuestions = (qs || []).map(q => ({
          id: q.id, stem: q.stem, passage: q.passage, options_json: q.options_json,
          qtype: q.qtype, difficulty: q.difficulty, subject_id: q.subject_id,
        }));
        if (restoreQuestions.length === 0) {
          restoreQuestions = details.map(d => ({
            id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
            qtype: d.qtype, difficulty: d.difficulty,
          }));
        }
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
        setMarked(normalizeMarked(r.data.marked ?? session?.marked));
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
          setQuestions(details.map(d => {
            const meta = metaById.get(Number(d.question_id)) || {};
            return {
              id: d.question_id, stem: d.stem, passage: d.passage, options_json: d.options_json,
              answer: d.correct_answer, explanation: d.explanation, qtype: d.qtype, difficulty: d.difficulty,
              source: meta.source || '', module_name: meta.module_name || '', category_name: meta.category_name || '',
            };
          }));
          const ansMap = {};
          for (const d of details) { ansMap[d.question_id] = d.user_answer; }
          setAnswers(ansMap);
          setResult({ session_id: session.id, total: session.total, correct: session.correct, score: session.score, duration_sec: session.duration_sec, ...extractReportFields(r.data, session) });
          setAnswerDetails(details);
          const tm = timingsFromDetails(details);
          timingsRef.current = tm;
          setTimings(tm);
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
        elapsed_sec: elapsed,
        marked: Array.from(markedRef.current)
      });
    } catch (err) { /* auto-save silent fail */ }
  }

  // 用 ref 读取最新值，供 interval 和 beforeunload 使用
  function saveProgressRef() {
    if (!sessionId || !answersRef.current) return;
    api.post('/practice/save-progress', {
      session_id: sessionId,
      answers: answersRef.current,
      elapsed_sec: elapsedRef.current,
      marked: Array.from(markedRef.current)
    }).catch(() => {});
  }

  /** 单题标记：标记本题 / 取消标记两态切换 */
  function toggleMark(qid) {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(qid)) next.delete(qid); else next.add(qid);
      return next;
    });
  }

  /** 答题中收藏：两态切换，结果与练习页共用 */
  async function toggleFav(qid) {
    const had = favSet.has(qid);
    try {
      if (had) await api.delete('/practice/favorites/' + qid);
      else await api.post('/practice/favorites', { question_id: qid });
      setFavSet((prev) => {
        const next = new Set(prev);
        if (had) next.delete(qid); else next.add(qid);
        return next;
      });
      message.success(had ? '已取消收藏' : '已收藏');
    } catch (_) { message.error('收藏操作失败'); }
  }

  /** 交卷后给答错的题打错因标签，写进错题本 */
  async function setReason(qid, value) {
    try {
      await api.put('/practice/wrong-book/by-question/' + qid + '/reason', {
        reason: value === 'unset' ? null : value,
      });
      setReasonMap((prev) => ({ ...prev, [qid]: value }));
      message.success('已记录错因');
    } catch (_) { message.error('错因标记失败'); }
  }

  async function startPractice() {
    setStep('loading');
    try {
      let qs = [];
      let subjectIdForSession = selectedSubject;

      if (fromTaxonomy) {
        // 专项练习：按分类/题型/难度抽题（走 taxonomy 池）
        const diff = diffParam ? diffParam.split(',').map(Number).filter(Number.isFinite) : null;
        const r = await api.post('/taxonomy/pick', {
          pool: poolParam,
          categoryIds: catParam ? catParam.split(',').map(Number).filter(Boolean) : [],
          qtypes: qtypeParam ? qtypeParam.split(',').filter(Boolean) : [],
          difficultyRange: diff && diff.length === 2 ? diff : null,
          subjectIds: subjectParam ? [subjectParam] : [],
          yearMode: yearModeParam || null,
          sourceType: sourceTypeParam || null,
          excludeAnswered: preferUndoneParam,
          count: countParam || count,
          ...(focusWeak ? { focusWeak: true } : {}),
        });
        if (!r.data.questions.length) {
          message.error('该条件下没有可练习的题目');
          setStep('setup');
          return;
        }
        qs = r.data.questions.map((q) => ({
          id: q.id,
          stem: q.stem,
          passage: q.passage,
          options_json: JSON.stringify(q.options || []),
          qtype: q.qtype,
          difficulty: q.difficulty,
          subject_id: q.subjectId,
        }));
        // 分类练习的题不一定属于某个 subject，会话用第一个可用 subject
        subjectIdForSession = qs[0].subject_id || selectedSubject || 1;
        if (r.data.questions.length < (countParam || count)) {
          message.info('已按当前条件为你抽取练习题目');
        }
      } else {
        if (!selectedSubject) { message.warning('请选择科目'); setStep('setup'); return; }
        const subject = subjects.find(s => s.id === selectedSubject);
        const r = await api.get('/questions/random', { params: { count, subject: subject.slug, qtype: filterQtype } });
        if (r.data.questions.length === 0) { message.error('该科目暂无题目'); setStep('setup'); return; }
        if (r.data.questions.length < count) {
          message.warning('该科目可练习的题目较少，将全部练习');
        }
        qs = r.data.questions;
      }

      setQuestions(qs);
      setAnswers({});
      setCurrentIndex(0);
      setMarked(new Set());
      setAnswerDetails([]);
      submittingRef.current = false;
      timingsRef.current = {};
      setTimings({});
      currentQidRef.current = null;
      dwellStartRef.current = null;
      // 答题中即可收藏：先取回这批题的收藏状态
      try {
        const ids = qs.map((x) => x.id).filter(Boolean).slice(0, 200);
        if (ids.length) {
          const fr = await api.get('/practice/favorites/check', { params: { ids: ids.join(',') } });
          setFavSet(new Set((fr.data.favorited || []).map(Number)));
        } else setFavSet(new Set());
      } catch (_) { setFavSet(new Set()); }

      // 创建答题会话
      const startRes = await api.post('/practice/start', { subject_id: subjectIdForSession, questions: qs });
      setSessionId(startRes.data.session_id);

      setStartTime(Date.now());
      setElapsed(isTimed ? limitSec : 0);
      setPausedElapsed(0);
      setPaused(false);
      setStep('doing');
    } catch (err) {
      const detail = err?.response?.data?.error;
      if (poolParam === 'generated' && (detail || '').includes('没有可练习的题目')) {
        message.warning('暂无可练习的 AI 生成题，请先在管理后台生成并审核题目');
      } else {
        message.error(detail || '获取题目失败，请稍后重试');
      }
      // 自动出题（快速练习/智能组卷/AI生成题）失败时回题库页，别停在空白设置页
      if (fromTaxonomy) {
        setStep('setup');
        navigate('/practice', { replace: true });
      } else {
        setStep('setup');
      }
    }
  }
  startPracticeRef.current = startPractice;

  function selectAnswer(questionId, value) {
    setAnswers(prev => ({ ...prev, [questionId]: value }));
  }

  function togglePause() {
    if (!paused) {
      if (timerRef.current) clearInterval(timerRef.current);
      // 无论练习还是限时模式，都记录已用时间
      const usedTime = isTimed ? (limitSec - elapsed) : elapsed;
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
    if (submittingRef.current) return;   // 提交中 / 已交卷（结果态）防重
    submittingRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoSaveRef.current) clearInterval(autoSaveRef.current);
    settleDwell();                       // 交卷前同步结算当前题停留时间
    const finalTimings = timingsRef.current;
    setStep('loading');
    try {
      const durationSec = isTimed ? (limitSec - elapsed) : (elapsed || Math.floor((Date.now() - startTime) / 1000));
      const r = await api.post('/practice/submit', {
        session_id: sessionId,
        answers,
        elapsed_sec: durationSec,
        timings: finalTimings
      });
      setResult({ ...r.data, duration_sec: durationSec });

      // 正确答案与解析由服务端在交卷后下发（答题阶段接口不下发，防提前看答案）。
      // 结果页的判定与高亮一律用这份权威数据，不用本地 questions。
      const graded = Array.isArray(r.data.questions) ? r.data.questions : [];
      if (graded.length > 0) {
        setQuestions(graded);
        // 用服务端回显的逐题用时（已规范化）作为结果页数据源
        const tm = {};
        for (const g of graded) tm[g.id] = Number(g.time_spent_sec) || 0;
        timingsRef.current = tm;
        setTimings(tm);
      }

      // 错题练习模式：答对的题目自动移出错题本
      // 默认开启「答对自动移出」：只有在错题本里显式关闭（存 'false'）才不生效，
      // 避免用户没打开过错题本时 localStorage 无值导致功能静默失效。
      if (wrongRedo && localStorage.getItem('wrongbook_auto_remove') !== 'false') {
        const correctIds = graded.filter(q => answers[q.id] === q.answer).map(q => q.id);
        if (correctIds.length > 0) {
          await Promise.allSettled(correctIds.map(qid => api.delete('/practice/wrong-book/by-question/' + qid)));
          message.info('已将答对的题目自动移出错题本');
        }
      }

      setCurrentIndex(0);
      setStep('result');
    } catch (err) {
      submittingRef.current = false;   // 失败允许重试
      message.error('提交失败');
      setStep('doing');
      // 重启计时器
      setStartTime(Date.now());
      setPaused(false);
    }
  }

  doSubmitRef.current = doSubmit;

  if (step === 'loading') return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" tip="加载中..." /></div>;

  // Setup
  if (step === 'setup') {
    return (
      <div style={{ maxWidth: 560, margin: isMobile ? '8px auto' : '32px auto', padding: '0 4px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <ThemeToggle />
        </div>
        <Card style={{
          borderRadius: 16, border: `1px solid ${tokens.cardBorder}`,
          background: tokens.cardBg, boxShadow: tokens.shadow,
        }} styles={{ body: { padding: isMobile ? 20 : 28 } }}>
          <div style={{ textAlign: 'center', marginBottom: 28 }}>
            <div style={{ width: 58, height: 58, margin: '0 auto 14px', display: 'grid', placeItems: 'center', borderRadius: 16, color: tokens.primary, background: tokens.selectedBg }}>
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
    // 分模块报告：优先后端 bySection，缺失时前端兜底；算不出则隐藏该区块
    const reportSections = computeReportSections(result, answerDetails, questions, answers, timings);
    const totalQ = Number(result?.total) || questions.length || 0;
    const unansweredVal = (result?.unanswered != null && Number.isFinite(Number(result.unanswered)))
      ? Number(result.unanswered)
      : questions.filter((q) => !answers[q.id]).length;
    const completionRaw = (result?.completion != null && Number.isFinite(Number(result.completion)))
      ? Number(result.completion) : null;
    const completionRatio = completionRaw != null
      ? (completionRaw > 1 ? completionRaw / 100 : completionRaw)
      : (totalQ ? Math.min(1, Math.max(0, (totalQ - unansweredVal) / totalQ)) : 0);
    const completionPct = Math.round(completionRatio * 100);
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <ThemeToggle />
        </div>
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
            <div><Text type="secondary">正确率</Text><br /><Text strong style={{ fontSize: 20 }}>{result.total ? Math.round((result.correct / result.total) * 100) : 0}%</Text></div>
            <div><Text type="secondary">用时</Text><br /><Text strong style={{ fontSize: 20 }}>{formatTime(result.duration_sec)}</Text></div>
            <div><Text type="secondary">未答</Text><br /><Text strong style={{ fontSize: 20 }}>{unansweredVal}</Text></div>
            <div><Text type="secondary">完成度</Text><br /><Text strong style={{ fontSize: 20 }}>{completionPct}%</Text></div>
          </div>
          <div style={{ marginTop: 24 }}>
            <Space>
              {wrongRedo ? (
                <>
                  <Button type="primary" icon={<ReloadOutlined />} onClick={() => navigate('/wrong-book')}>返回错题本</Button>
                  <Button onClick={() => { setStep('setup'); navigate('/practice/do'); }}>普通练习</Button>
                </>
              ) : (
                <>
                  <Button type="primary" icon={<ReloadOutlined />} onClick={() => { setStep('setup'); navigate('/practice/do'); }}>再来一次</Button>
                  <Button onClick={() => navigate('/history')}>返回历史</Button>
                </>
              )}
            </Space>
          </div>
        </Card>

        {reportSections.length > 0 && (
          <Card title={<span style={{ fontSize: 15, fontWeight: 600 }}>分模块报告</span>} style={{ marginBottom: 16 }}>
            {reportSections.map((s, i) => {
              const acc = s.total ? Math.round((s.correct / s.total) * 100) : 0;
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                  <Text strong style={{ minWidth: 90, color: tokens.text }}>{s.name}</Text>
                  <Tag style={{ marginInlineEnd: 0 }}>{s.correct}/{s.total}</Tag>
                  <Progress percent={acc} size="small" showInfo={false} strokeColor={acc >= 60 ? tokens.success : tokens.error} trailColor={tokens.divider} style={{ flex: 1, minWidth: 120, margin: 0 }} />
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{acc}% · {formatTime(s.timeSec)}</Text>
                </div>
              );
            })}
          </Card>
        )}

        {questions.map((q, idx) => {
          const userAns = answers[q.id];
          const isCorrect = userAns === q.answer;
          return (
            <Card key={q.id} style={{ marginBottom: 12, borderLeft: '4px solid ' + (isCorrect ? '#52c41a' : '#ff4d4f') }}>
              <div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? '正确' : '错误'}</Tag><Text type="secondary"> 第 {idx + 1} 题</Text></div><Button size="small" icon={favSet.has(q.id) ? <StarFilled /> : <StarOutlined />} onClick={() => toggleFav(q.id)}>{favSet.has(q.id) ? '已收藏' : '收藏'}</Button></div>
              {/* 题目元信息只在结果页展示，答题过程中不下发也不渲染 */}
              {(q.source || q.module_name || q.category_name) && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {q.source && <Tag title={q.source} style={{ marginInlineEnd: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>来源：{q.source}</Tag>}
                  {q.module_name && <Tag color="blue" style={{ marginInlineEnd: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>模块：{q.module_name}</Tag>}
                  {q.category_name && <Tag color="purple" style={{ marginInlineEnd: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>二级分类：{q.category_name}</Tag>}
                </div>
              )}
              {q.passage && <div style={{ marginBottom: 12, padding: 12, background: tokens.cardBgAlt, borderRadius: 6, lineHeight: 1.8 }}>{q.passage}</div>}
              <Text strong>{q.stem}</Text>
              <div style={{ marginTop: 12 }}>
                {parseOptions(q.options_json).map((opt, i) => {
                  const letter = String.fromCharCode(65 + i);
                  let bg = tokens.cardBg, border = `1px solid ${tokens.border}`;
                  if (letter === q.answer) { bg = '#f6ffed'; border = '1px solid #b7eb8f'; }
                  if (letter === userAns && !isCorrect) { bg = isDark ? 'rgba(245,34,45,0.16)' : '#fff2f0'; border = isDark ? '1px solid rgba(245,34,45,0.4)' : '1px solid #ffccc7'; }
                  return (
                    <div key={i} style={{ padding: '8px 12px', marginBottom: 4, borderRadius: 6, background: bg, border }}>
                      <Text type={letter === q.answer ? 'success' : (letter === userAns && !isCorrect ? 'danger' : undefined)}>
                        {letter}. {cleanOption(opt)}{letter === q.answer && ' ✓'}
                      </Text>
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 8 }}><Text type="secondary">你的答案：{userAns || '未答'} | 正确答案：{q.answer} | 本题用时：{fmtQTime(timings[q.id])}</Text></div>
              {!isCorrect && (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Text type="secondary">错因归类</Text>
                  <Select size="small" style={{ width: 140 }}
                    value={reasonMap[q.id] || 'unset'}
                    onChange={(v) => setReason(q.id, v)}
                    options={REASON_OPTIONS} />
                </div>
              )}
              {q.explanation && <div style={{ marginTop: 8, padding: '8px 12px', background: isDark ? 'rgba(91,140,255,0.12)' : '#e6f7ff', borderRadius: 6 }}><Text type="secondary">解析：{q.explanation}</Text></div>}
              {/* AI 解析入口：入口文案与配色对全部题目保持一致，
                  后端再按答题对错生成不同侧重点的讲解内容 */}
              <div style={{ marginTop: 8 }}>
                {aiAnalysis[q.id] ? (
                  <div style={{ padding: '8px 12px', background: isDark ? 'rgba(250,173,20,0.12)' : '#fff7e6', borderRadius: 6, border: isDark ? '1px solid rgba(250,173,20,0.4)' : '1px solid #ffd591' }}>
                    <Text strong style={{ color: '#fa8c16' }}>AI 解析：</Text>
                    <Text style={{ display: 'block', marginTop: 4 }}>{aiAnalysis[q.id]}</Text>
                  </div>
                ) : (
                  <Button size="small" loading={aiLoading[q.id]} onClick={() => requestAiAnalysis(q.id, userAns)}>
                    AI 解析
                  </Button>
                )}
              </div>
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <ThemeToggle />
      </div>
      {/* 分类练习提示：当前在刷哪个分类 */}
      {catLabel && (
        <div style={{
          marginBottom: 12, padding: '8px 14px', borderRadius: 8,
          background: tokens.selectedBg, color: tokens.primary, fontSize: 13,
          border: `1px solid ${tokens.selectedBorder}`,
        }}>
          正在练习：{catLabel}
        </div>
      )}

      {/* Top bar */}
      <Card size="small" style={{
        marginBottom: 16, position: 'sticky', top: 72, zIndex: 10, borderRadius: 12,
        borderColor: tokens.cardBorder, background: tokens.cardBg,
        boxShadow: isDark ? '0 6px 18px rgba(0,0,0,0.36)' : '0 6px 18px rgba(15, 23, 42, 0.08)',
      }} styles={{ body: { padding: isMobile ? '10px 12px' : '12px 16px' } }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexWrap: isMobile ? 'wrap' : 'nowrap', gap: isMobile ? 8 : 0,
        }}>
          <Space size={isMobile ? 6 : 8}>
            {!wrongRedo && (isTimed ? (
              <>
                <ClockCircleOutlined />
                <Text strong style={{ fontSize: 16, fontFamily: 'monospace', color: elapsed < 60 ? '#ff4d4f' : tokens.primary }}>
                  剩余 {formatTime(elapsed)}
                </Text>
              </>
            ) : (
              <>
                <ClockCircleOutlined />
                <Text strong style={{ fontSize: 16, fontFamily: 'monospace' }}>{formatTime(elapsed)}</Text>
                <Button size="small" type={paused ? 'primary' : 'default'} icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
                  onClick={togglePause}>{paused ? '继续' : '暂停'}</Button>
              </>
            ))}
            {wrongRedo && <Text type="secondary">错题练习</Text>}
          </Space>
          <Progress percent={progress} size="small" showInfo={!isMobile} strokeColor={tokens.primaryLight} trailColor={tokens.divider} style={{ flex: 1, margin: isMobile ? '0' : '0 16px', minWidth: isMobile ? 80 : undefined }} />
          <Space size={isMobile ? 6 : 8}>
            <Text type="secondary">{answeredCount}/{questions.length}</Text>
            <Button size="small" onClick={() => setShowAnswerCard(true)}>答题卡</Button>
          </Space>
        </div>
      </Card>

      {/* Pause overlay */}
      {paused && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: tokens.mask, zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
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
      <Card style={{ borderRadius: 16, border: `1px solid ${tokens.cardBorder}`, background: tokens.cardBg }}
        styles={{ body: { padding: isMobile ? 18 : 28 } }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>
            <Tag color="blue">第 {currentIndex + 1} 题</Tag>
            {q.qtype && <Tag>{q.qtype}</Tag>}
          </span>
          <Space size={4}>
            <Button size="small" type="text"
              icon={marked.has(q.id) ? <FlagFilled style={{ color: '#faad14' }} /> : <FlagOutlined />}
              onClick={() => toggleMark(q.id)}>
              {marked.has(q.id) ? '取消标记' : '标记本题'}
            </Button>
            <Button size="small" type="text"
              icon={favSet.has(q.id) ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
              onClick={() => toggleFav(q.id)}>
              {favSet.has(q.id) ? '已收藏' : '收藏'}
            </Button>
          </Space>
        </div>

        {q.passage && (
          <div style={{
            marginBottom: 20, padding: isMobile ? 14 : 16,
            background: tokens.cardBgAlt, border: `1px solid ${tokens.border}`,
            borderRadius: 10, lineHeight: 1.9, fontSize: 15, color: tokens.text,
          }}>{q.passage}</div>
        )}

        <Text strong style={{ fontSize: isMobile ? 16 : 17, lineHeight: 1.7, display: 'block', marginBottom: 20, color: tokens.text }}>{q.stem}</Text>

        <Radio.Group value={answers[q.id]} onChange={e => selectAnswer(q.id, e.target.value)} style={{ width: '100%' }}>
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            {parseOptions(q.options_json).map((opt, i) => {
              const letter = String.fromCharCode(65 + i);
              const isSelected = answers[q.id] === letter;
              return (
                <Radio key={i} value={letter} style={{
                  width: '100%', padding: isMobile ? '13px 14px' : '15px 16px',
                  border: '1px solid ' + (isSelected ? tokens.primaryLight : tokens.border),
                  borderRadius: 10, margin: 0,
                  background: isSelected ? tokens.selectedBg : tokens.cardBg,
                  display: 'flex', alignItems: 'center',
                  transition: 'all 0.18s ease',
                  boxShadow: isSelected ? `0 0 0 3px ${isDark ? 'rgba(91,140,255,0.18)' : 'rgba(37, 99, 235, 0.1)'}` : 'none',
                }}>
                  <Text style={{ fontSize: 15, lineHeight: 1.65, color: tokens.text }}>
                    <strong style={{ color: isSelected ? tokens.primary : tokens.text }}>{letter}.</strong> {cleanOption(opt)}
                  </Text>
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
            const isMarked = marked.has(q.id);
            return (
              <Button key={idx} size="small" type={isCurrent ? 'primary' : 'default'} style={{
                width: 40, height: 40, position: 'relative',
                background: isCurrent ? '#1890ff' : isAnswered ? '#52c41a' : tokens.cardBg,
                color: isCurrent || isAnswered ? '#fff' : tokens.text,
                border: isCurrent || isAnswered ? 'none' : '1px solid #d9d9d9',
                boxShadow: isMarked ? '0 0 0 2px #faad14' : undefined,
              }}
                role="button" tabIndex={0}
                aria-label={`第 ${idx + 1} 题，${isAnswered ? '已答' : '未答'}${isCurrent ? '，当前题' : ''}${isMarked ? '，已标记' : ''}`}
                onClick={() => goToQuestion(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();   // 抑制原生 button 的合成 click，避免重复触发
                    goToQuestion(idx);
                  }
                }}
              >
                {idx + 1}
                {isMarked && <FlagFilled style={{ position: 'absolute', top: 1, right: 1, fontSize: 9, color: '#faad14' }} />}
              </Button>
            );
          })}
        </div>
        <Divider />
        <Space>
          <div><div style={{ width: 16, height: 16, background: '#52c41a', borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 已答</div>
          <div><div style={{ width: 16, height: 16, background: tokens.cardBg, border: `1px solid ${tokens.border}`, borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 未答</div>
          <div><div style={{ width: 16, height: 16, background: '#1890ff', borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 当前</div>
          <div><div style={{ width: 16, height: 16, background: tokens.cardBg, border: '2px solid #faad14', borderRadius: 3, display: 'inline-block', marginRight: 4 }} /> 标记</div>
        </Space>
      </Modal>
    </div>
  );
}
