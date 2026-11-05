import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Card, Button, Tag, Progress, Space, Typography, Spin, Empty, message,
  Drawer, Modal, Statistic, Row, Col, Divider,
} from 'antd';
import {
  ArrowLeftOutlined, CheckCircleOutlined, CloseCircleOutlined,
  FlagOutlined, FlagFilled, DashboardOutlined, ClockCircleOutlined,
} from '@ant-design/icons';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';
import { useTheme } from '../contexts/ThemeContext';
import ThemeToggle from '../components/ThemeToggle';

const { Title, Text, Paragraph } = Typography;

const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * 题目截图地址。
 *
 * <img> 标签带不了 Authorization 头，但 httpOnly Cookie 浏览器会自动带上，
 * 因此这里不需要（也不应该）再拼 ?t=<token> —— token 出现在 URL 里会进
 * 服务端访问日志、浏览器历史和 Referer 头，等于把凭据泄漏出去。
 *
 * 注意 baseURL 的两种形态：
 *   同源部署   → '/api'                      → '/api/exam-papers/images/...'
 *   跨域部署   → 'https://api.你的域名'        → 需要补上 '/api'，否则 404
 * 后端返回的图片路径本身不含 /api 前缀，这里按 base 是否已含 /api 决定补不补。
 */
function paperImageUrl(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  const base = api.defaults.baseURL || '/api';
  const prefix = /\/api(\/|$)/.test(base) ? base : `${base.replace(/\/+$/, '')}/api`;
  return `${prefix}${src}`;
}

/**
 * 把一个分区的题目按「材料组」归拢。
 *
 * 资料分析一篇材料带一串题：同组的题共享 materialGroup（= 组首题号），
 * 组首题带材料正文与材料图。渲染时把整组并成「左材料 / 右题目列表」两栏。
 * 不属于任何材料组的题（言语、图形推理等）保持原来的单列列表。
 */
function groupSectionQuestions(questions) {
  const out = [];
  for (const q of questions || []) {
    const gid = q.materialGroup;
    if (gid == null) {
      // 单题（不属于任何材料组）：结构与材料组保持一致，
      // 否则调用方读 grp.images / grp.passage 时会拿到 undefined
      out.push({ id: `single-${q.seq}`, materialGroup: null, passage: '', images: [], questions: [q] });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.materialGroup === gid) {
      last.questions.push(q);
      continue;
    }
    // 组首题带 passage 与材料图；续题通过 materialRef 引用组首
    const head = q;
    out.push({
      id: `grp-${gid}`,
      materialGroup: gid,
      passage: head.passage || (head.materialRef && head.materialRef.passage) || '',
      images: (head.images || []).filter((x) => /-m(-\d+)?\./.test(x)),
      questions: [q],
    });
  }
  // 组首题若被上游误挂导致没有材料图，从续题的 materialRef 里补
  for (const g of out) {
    if (!g.materialGroup || g.images.length) continue;
    for (const q of g.questions) {
      const imgs = (q.materialRef && q.materialRef.images) || [];
      if (imgs.length) { g.images = imgs; break; }
    }
  }
  return out;
}

/** 秒 → mm:ss */
function fmtTime(sec) {  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 粉笔题库（spa.fenbi.com/ti）的设计 token。
 *
 * 取自粉笔线上样式表 styles-*.css 的实际取值：
 *   主色 #385dca / 亮蓝 #3c7cfc、选中底 #edf6ff、选中描边 #cbdfff、
 *   页面底 #f7f9fc、正文 #292a2d、次要文字 #3c464f、弱文字 #868ea8、
 *   分隔线 #e8ecf3、强调黄 #ffbc22
 * 目的是让整卷答题页的观感与粉笔一致，而不是 antd 默认蓝 + 默认圆角卡片。
 */
/**
 * 粉笔设计 token —— 取自粉笔线上样式表与真实页面计算样式。
 *
 * 日间/夜间两套值由 ThemeContext 提供（contexts/ThemeContext.jsx），
 * 这里按当前主题派生一份 FB 别名，保持本文件原有的 FB.xxx 写法不变。
 */
const FB_FONT = '"Noto Sans SC", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/** 由主题 token 派生粉笔式别名 */
function makeFB(t) {
  return {
    primary: t.primary,
    primaryLight: t.primaryLight,
    // 题型标签实测色：文字 rgb(71,117,254) = #4775fe，底 rgba(60,124,252,.04)
    tagText: t.isDark ? '#7aa2ff' : '#4775fe',
    tagBg: t.isDark ? 'rgba(91,140,255,0.14)' : 'rgba(60,124,252,0.04)',
    selectedBg: t.selectedBg,
    selectedBorder: t.selectedBorder,
    pageBg: t.pageBg,
    text: t.text,
    textSub: t.textSub,
    textWeak: t.textWeak,
    border: t.border,
    cardBorder: t.cardBorder,
    accent: t.accent,
    cardBg: t.cardBg,
    cardBgAlt: t.cardBgAlt,
    divider: t.divider,
    isDark: t.isDark,
  };
}

/** 答题状态配色：与粉笔答题卡一致（未答浅底灰边 / 已答蓝底 / 标记黄底） */
function makeCardStatusColor(FB) {
  return {
    answered: { bg: FB.primaryLight, color: '#fff', border: FB.primaryLight },
    marked: FB.isDark
      ? { bg: 'rgba(250,173,20,0.16)', color: '#e8b339', border: 'rgba(250,173,20,0.42)' }
      : { bg: '#fff8e6', color: '#d48806', border: '#ffe08a' },
    unanswered: { bg: FB.cardBg, color: FB.textWeak, border: FB.border },
    correct: { bg: '#52c41a', color: '#fff', border: '#52c41a' },
    wrong: { bg: '#f5222d', color: '#fff', border: '#f5222d' },
  };
}

/**
 * 材料题（资料分析 / 一拖五）两栏布局的尺寸常量。
 *
 * 【为什么等高要用确定高度，而不是让右栏去「贴合」左栏】
 * flex 行里 align-items: stretch 只能把**矮的**那一栏拉高到高的那一栏，
 * 无法反过来让高的一栏（5 道题的列表）压低。真要靠 JS 测量左栏高度再设
 * maxHeight，就得在图片懒加载完成、窗口缩放、字号变化时反复重算，
 * 极易出现两栏高低不齐的抖动。
 * 这里改成整行给一个确定高度、左右两栏各占 100% —— 等高由 DOM 结构保证，
 * 不依赖测量时机。两栏内容超出各自栏高时在栏内滚动，不会往外撑、不会重叠。
 */
// 整行高度：至少看得到一段材料 + 两道小题；最多不超过一屏（留出顶部信息栏与分区标题）
const MATERIAL_ROW_H = 'clamp(380px, calc(100vh - 190px), 880px)';
// 左栏宽度：随可用宽度自适应；窄屏不低于 300px，宽屏不超过 460px
const MATERIAL_LEFT_W = 'clamp(300px, 42%, 460px)';
// 低于此宽度时右侧题目区会被挤到 400px 以下（题干与选项换行后极难读），
// 因此退回上下堆叠布局，而不是硬撑两栏导致内容截断
const MATERIAL_SPLIT_MIN_W = 1024;

/**
 * 整卷在线阅览与答题（参考粉笔网页版交互）：
 * 分区导航 + 答题卡 + 选项作答 + 交卷后答案与解析 + 进度与结果反馈，PC/移动响应式。
 */
export default function ExamPaperTake() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isMobile, width } = useResponsive();
  // 主题 token → 粉笔式配色（FB / 答题卡状态色），日夜切换时整页跟随
  const { tokens, setAnswerScope } = useTheme();
  const FB = makeFB(tokens);
  // 主题只在答题界面生效；离开自动恢复日间
  useEffect(() => {
    setAnswerScope(true);
    return () => setAnswerScope(false);
  }, [setAnswerScope]);
  const CARD_STATUS_COLOR = makeCardStatusColor(FB);
  // 窗口够宽才做「左材料 / 右小题」分栏，否则材料单独成卡堆在题目上方
  const materialSplit = width >= MATERIAL_SPLIT_MIN_W;

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
  // 截图大图：在当前页面内放大查看。不另开标签页、也不跳转 —— 跳走会丢掉作答进度
  const [previewImg, setPreviewImg] = useState(null);
  // 共享材料的折叠引用（同上资料的第 2 题起，默认收起不占版面）
  const [matOpen, setMatOpen] = useState({});

  const qRefs = useRef({});
  // 顶部吸附信息栏（定位时要用它的高度让开位置）
  const headerRef = useRef(null);

  useEffect(() => { loadPaper(); }, [id]);

  // 计时（交卷后停止）
  useEffect(() => {
    if (result) return undefined;
    const t = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [result]);

  // 大图预览：ESC 关闭
  useEffect(() => {
    if (!previewImg) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPreviewImg(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewImg]);

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
  const unansweredCount = Math.max(0, total - answeredCount);
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
    if (!el) {
      setSheetOpen(false);
      return;
    }
    // 顶部吸附的信息栏高度：小题要落在它下面，不能被压住
    const headerH = headerRef.current ? headerRef.current.offsetHeight : 90;
    const want = headerH + 8;

    // ① 先用原生滚动。它能正确处理两件靠算式很难算准的事：
    //    · 题目在独立滚动容器里（材料组右栏）时，容器与窗口两级滚动
    //    · 图片懒加载导致文档高度变化（整卷有上百张图，滚动中会漂移几千元）
    //    原生滚动有滚动锚定兜底，手工算绝对落点会因为漂移而失准。
    el.scrollIntoView({ block: 'start' });

    // ② 原生滚动只保证「可见」，不保证对齐 —— 目标题可能被压在顶部信息栏下面，
    //    题号行看不见。这里在滚动完成后按实测位置补一次精确校正。
    const delta = el.getBoundingClientRect().top - want;
    if (Math.abs(delta) > 1) {
      window.scrollBy({ top: delta, behavior: 'smooth' });
    }
    setSheetOpen(false);
  }

  async function submit() {
    const unanswered = total - answeredCount;
    Modal.confirm({
      title: '确认交卷？',
      content: unanswered > 0 ? '还有题目未作答，确定要交卷吗？' : '确定要交卷吗？',
      okText: '交卷', cancelText: '继续答题',
      onOk: async () => {
        setSubmitting(true);
        try {
          const r = await api.post(`/exam-papers/${id}/submit`, { answers, duration_sec: elapsed });
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
              width: 30, height: 30,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 4, border: `1px solid ${c.border}`, background: c.bg, color: c.color,
              fontSize: 12, cursor: 'pointer', fontWeight: st === 'unanswered' ? 400 : 600,
              transition: 'background .15s',
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
      {sections.length > 0 ? (
        sections.map((s) => (
          <div key={s.name} style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 16, color: FB.text, fontWeight: 600 }}>{s.name}</span>
              <span style={{ fontSize: 14, color: FB.textWeak }}>（{s.questions.length}题）</span>
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

  /**
   * 材料区内容：资料正文 + 图表。
   *
   * 左右分栏时放进左栏内部的滚动容器；窄屏堆叠时单独成卡。
   * wordBreak 是必要的：资料分析常见一长串数字或连续单位，
   * 不断词会把容器撑宽导致横向溢出。
   *
   * 【为什么左栏的图不能懒加载】
   * 左栏是「固定高度 + 内部滚动」的容器，图在容器内、容器在页面很下方：
   * 浏览器按「元素是否进入视口」决定是否加载 → 图不加载 → 没有高度 →
   * 容器不溢出 → 用户没有可滚动的空间 → 永远滚不到图 → 永远不加载。
   * 资料分析的统计图表就卡在这个死循环里显示不出来。
   * 所以左栏的图主动加载（整卷材料图只有十来张，代价可接受）；
   * 窄屏堆叠时图在正常文档流里，懒加载没问题。
   */
  const renderMaterialBody = (grp, { fontSize, eager }) => (
    <>
      {grp.passage && (
        <Paragraph
          style={{
            fontSize,
            lineHeight: fontSize >= 16 ? 2 : 1.9,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: 12,
          }}
        >
          {grp.passage}
        </Paragraph>
      )}
      {(grp.images || []).map((src) => {
        const url = paperImageUrl(src);
        return (
          <img
            key={src}
            src={url}
            alt="资料图表"
            loading={eager ? 'eager' : 'lazy'}
            onClick={() => setPreviewImg(url)}
            style={{
              width: '100%', border: '1px solid #f0f0f0', borderRadius: 8,
              background: FB.cardBg, cursor: 'zoom-in', display: 'block', marginBottom: 8,
            }}
          />
        );
      })}
    </>
  );

  /** 单题卡片（资料分析的两栏布局里会复用）
   *  opts.hidePassage：材料已在左栏展示时，题干区不再重复渲染一遍
   *  opts.hideMaterialImages：材料图已在左栏展示时，卡片里不再重复渲染一遍
   *    （材料图文件名带 -m 后缀；重复渲染既冗余，又会因为图片懒加载
   *      撑高文档、放大滚动漂移） */
  const renderQuestionCard = (q, opts = {}) => {
    const myAnswer = answers[q.seq];
    const res = resultMap[q.seq];
    const isWrong = res && !res.correct;
    // 材料图（文件名带 -m 后缀）已在左栏展示时，卡片里不再重复渲染
    const cardImages = (q.images || []).filter(
      (src) => !(opts.hideMaterialImages && /-m(-\d+)?\./.test(src))
    );
    return (
      <Card
        key={q.seq}
        ref={(el) => { qRefs.current[q.seq] = el; }}
        size="small"
        style={{
          marginBottom: 14, borderRadius: 8,
          borderColor: isWrong ? (FB.isDark ? '#7a2f2a' : '#ffccc7') : FB.cardBorder,
          background: FB.cardBg,
        }}
        styles={{ body: { padding: isMobile ? '12px 14px 16px' : '12px 20px 16px' } }}
      >
        {/* 标题行：粉笔式 —— 题号是纯黑的「N.」，题型是淡蓝底的文字标签 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 15, lineHeight: 1.57, color: FB.text, fontWeight: 500 }}>
            {q.seq}.
          </span>
          <span style={{
            fontSize: 12, lineHeight: '12px', color: FB.tagText,
            background: FB.tagBg, borderRadius: 4, padding: '5px 10px',
          }}>
            {q.qtype || '单选题'}
          </span>
          {res && (
            res.correct
              ? <Tag icon={<CheckCircleOutlined />} color="success" style={{ marginInlineEnd: 0, borderRadius: 4, fontSize: 12 }}>答对</Tag>
              : <Tag icon={<CloseCircleOutlined />} color="error" style={{ marginInlineEnd: 0, borderRadius: 4, fontSize: 12 }}>答错</Tag>
          )}
          <span
            onClick={() => toggleMark(q.seq)}
            style={{ marginLeft: 'auto', cursor: 'pointer', color: marked[q.seq] ? FB.accent : (FB.isDark ? '#5a5f6e' : '#c8cdd6') }}
            title="标记此题"
          >
            {marked[q.seq] ? <FlagFilled /> : <FlagOutlined />}
          </span>
        </div>

        {q.passage && !opts.hidePassage && (
          <Paragraph style={{
            background: FB.cardBgAlt, border: `1px solid ${FB.border}`, borderRadius: 8,
            padding: 12, marginBottom: 12, fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap',
          }}>
            {q.passage}
          </Paragraph>
        )}

        {/* 同一材料的后续题：材料正文与图表已在本组第一题展示过，这里默认不重复渲染，
            只在需要时折叠展开（用答题卡跳到组内第 3 题时也查得到原资料） */}
        {q.materialRef && (q.materialRef.passage || (q.materialRef.images || []).length > 0) && (
          <div style={{ marginBottom: 12 }}>
            <a
              onClick={() => setMatOpen((s) => ({ ...s, [q.seq]: !s[q.seq] }))}
              style={{ fontSize: 13, color: '#1D4ED8', cursor: 'pointer', userSelect: 'none' }}
            >
              {matOpen[q.seq] ? '收起' : '查看'}本篇资料（见第 {q.materialRef.seq} 题）
            </a>
            {matOpen[q.seq] && (
              <div style={{ marginTop: 8 }}>
                {q.materialRef.passage && (
                  <Paragraph style={{
                    background: FB.cardBgAlt, border: `1px solid ${FB.border}`, borderRadius: 8,
                    padding: 12, marginBottom: 8, fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap',
                  }}>
                    {q.materialRef.passage}
                  </Paragraph>
                )}
                {(q.materialRef.images || []).map((src) => {
                  const url = paperImageUrl(src);
                  return (
                    <img
                      key={src}
                      src={url}
                      alt="资料图表"
                      loading="lazy"
                      onClick={() => setPreviewImg(url)}
                      style={{
                        width: '100%', maxWidth: '100%', border: '1px solid #f0f0f0',
                        borderRadius: 8, background: FB.cardBg, cursor: 'zoom-in', display: 'block',
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 原卷区域截图：图形推理/几何图/统计图表在文本层里没有，只能看图。
            纯文本题的区域截图只是把题干重拍一遍，与上面的文字重复，
            默认折叠，需要核对原卷时再展开（懒加载）。 */}
        {cardImages.length > 0 && q.imageNeeded !== false && (
          <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {cardImages.map((src) => {
              const url = paperImageUrl(src);
              return (
                <img
                  key={src}
                  src={url}
                  alt="原卷题目截图"
                  loading="lazy"
                  onClick={() => setPreviewImg(url)}
                  style={{
                    width: '100%', maxWidth: '100%', border: '1px solid #f0f0f0',
                    borderRadius: 8, background: FB.cardBg, cursor: 'zoom-in', display: 'block',
                  }}
                />
              );
            })}
          </div>
        )}

        {cardImages.length > 0 && q.imageNeeded === false && (
          <div style={{ marginBottom: 12 }}>
            <a
              onClick={() => setShotOpen((s) => ({ ...s, [q.seq]: !s[q.seq] }))}
              style={{ fontSize: 13, color: '#8c8c8c', cursor: 'pointer', userSelect: 'none' }}
            >
              {shotOpen[q.seq] ? '收起' : '查看'}原卷截图
            </a>
            {shotOpen[q.seq] && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cardImages.map((src) => {
                  const url = paperImageUrl(src);
                  return (
                    <img
                      key={src}
                      src={url}
                      alt="原卷题目截图"
                      loading="lazy"
                      onClick={() => setPreviewImg(url)}
                      style={{
                        width: '100%', maxWidth: '100%', border: '1px solid #f0f0f0',
                        borderRadius: 8, background: FB.cardBg, cursor: 'zoom-in', display: 'block',
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div style={{ fontSize: isMobile ? 15 : 16, lineHeight: 1.85, marginBottom: 14, whiteSpace: 'pre-wrap', color: FB.text }}>
          {q.stem}
        </div>

        {/* 选项：粉笔式「行」布局 —— 无边框、选中浅蓝底、hover 淡灰底 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {(q.options || []).map((opt, i) => {
            const label = OPTION_LABELS[i] || String(i);
            const selected = myAnswer === label;
            const isRight = res && String(res.answer || '').includes(label);
            const isMyWrong = res && !res.correct && selected;
            // 选项在原 PDF 中是图片（图形推理/几何图/统计图），文本层只有占位符。
            // 这类选项只显示原卷的标号（A/B/C/D），不写「该选项在原试卷中为图片」这种废话。
            const isImageOption = typeof opt === 'string' && /图片选项|^[A-D]$/.test(opt.trim());
            const optText = isImageOption
              ? (/^[A-Da-d]$/.test(opt.trim()) ? opt.trim() : label)
              : opt;

            // 粉笔式：未选透明底（靠 hover 提示），选中浅蓝底
            let bg = 'transparent';
            let markColor = 'transparent';
            let markBorder = '#c5ccd8';
            let markText = FB.textSub;
            if (res) {
              if (isRight) {
                bg = FB.isDark ? 'rgba(82,196,26,0.14)' : '#f6ffed';
                markColor = '#52c41a'; markBorder = '#52c41a'; markText = '#fff';
              }
              if (isMyWrong) {
                bg = FB.isDark ? 'rgba(245,34,45,0.16)' : '#fff2f0';
                markColor = '#f5222d'; markBorder = '#f5222d'; markText = '#fff';
              }
            } else if (selected) {
              bg = FB.selectedBg; markColor = FB.primaryLight; markBorder = FB.primaryLight; markText = '#fff';
            }

            return (
              <div
                key={label}
                onClick={() => selectOption(q.seq, label)}
                style={{
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                  cursor: result ? 'default' : 'pointer',
                  padding: '9px 12px', borderRadius: 6, background: bg,
                  fontSize: isMobile ? 14 : 15, lineHeight: 1.75, color: FB.text,
                  transition: 'background .15s',
                }}
                onMouseEnter={(e) => {
                  if (!result && !selected) e.currentTarget.style.background = FB.pageBg;
                }}
                onMouseLeave={(e) => {
                  if (!result && !selected) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{
                  flexShrink: 0, width: 22, height: 22, borderRadius: '50%',
                  border: `1px solid ${markBorder}`, background: markColor, color: markText,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 600,
                }}>{label}</span>
                <span style={{ flex: 1 }}>
                  {optText}
                </span>
                {res && isRight && <CheckCircleOutlined style={{ color: '#52c41a', marginTop: 4 }} />}
                {isMyWrong && <CloseCircleOutlined style={{ color: '#f5222d', marginTop: 4 }} />}
              </div>
            );
          })}
        </div>

        {res && (
          <>
            {/* 粉笔式四栏统计条：底 #f7f9fc、圆角 16px、padding 14px */}
            <div style={{
              marginTop: 10, padding: 14, borderRadius: 16,
              background: FB.pageBg,
              display: 'flex', alignItems: 'stretch', gap: 8,
            }}>
              {[
                { label: '正确答案', value: res.answer || '-', color: '#52c41a' },
                { label: '你的答案', value: res.yourAnswer || '未作答', color: res.yourAnswer ? (res.correct ? '#52c41a' : '#f5222d') : FB.textWeak },
                { label: '你的得分', value: res.correct ? '1.0' : '0.0', color: FB.primaryLight },
                { label: '题目难度', value: `${q.difficulty || 3} / 5`, color: FB.textWeak },
              ].map((it) => (
                <div key={it.label} style={{
                  flex: 1, textAlign: 'center', minWidth: 0,
                }}>
                  <div style={{ fontSize: 16, fontWeight: 600, color: it.color, lineHeight: 1.4 }}>
                    {it.value}
                  </div>
                  <div style={{ fontSize: 12, color: FB.textWeak, marginTop: 2 }}>{it.label}</div>
                </div>
              ))}
            </div>

            {/* 解析：粉笔是独立的白底卡（描边 #f0f3fa、圆角 8、padding 20） */}
            {res.explanation && (
              <div style={{
                marginTop: 20, padding: 20, borderRadius: 8,
                background: FB.cardBg, border: `1px solid ${FB.cardBorder}`,
                fontSize: 14, lineHeight: 1.8, color: FB.text,
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                <div style={{
                  fontSize: 14, fontWeight: 600, color: FB.text,
                  marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: FB.primaryLight, display: 'inline-block',
                  }} />
                  解析
                </div>
                {res.explanation}
              </div>
            )}
          </>
        )}
      </Card>
    );
  };

  return (
    <div style={{
      // 底部固定操作条的高度，避免最后一道题被压住
      paddingBottom: 92,
      background: FB.pageBg,
      minHeight: '100%',
      fontFamily: FB_FONT,
      color: FB.text,
    }}>
      {/* 顶部工具条：粉笔式
          实测规格 —— fixed / 高 60px / 白底 / 无阴影 / 标题居中 */}
      <div
        ref={headerRef}
        style={{
          position: 'sticky', top: 0, zIndex: 20,
          background: FB.cardBg, borderBottom: `1px solid ${FB.cardBorder}`,
          marginBottom: 16,
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: isMobile ? '10px 12px' : '0 16px',
          height: isMobile ? 48 : 60,
        }}>
          <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={() => navigate('/exam-papers')}
            style={{ color: FB.textSub }}>
            {!isMobile && '返回'}
          </Button>
          {/* 标题居中（粉笔是绝对居中，不受左侧按钮影响） */}
          <div style={{
            position: 'absolute', left: 0, right: 0, textAlign: 'center',
            pointerEvents: 'none', padding: '0 120px',
          }}>
            <span style={{
              fontSize: isMobile ? 13 : 15, color: FB.text,
              display: 'inline-block', maxWidth: '100%',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              verticalAlign: 'middle',
            }}>
              {paper.title}
            </span>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* 日夜模式切换：作答中也能随手切（偏好持久化到账号） */}
            <ThemeToggle style={{ color: FB.textSub }} />
            <Tag
              icon={<ClockCircleOutlined />}
              style={{
                marginInlineEnd: 0, borderRadius: 4, fontSize: 12,
                background: FB.cardBgAlt, borderColor: FB.border, color: FB.textSub,
              }}
            >
              {fmtTime(elapsed)}
            </Tag>
          </div>
        </div>
        <Progress
          percent={total ? Math.round((answeredCount / total) * 100) : 0}
          size="small" showInfo={false}
          style={{ margin: 0, lineHeight: 0 }}
          strokeColor={FB.primaryLight} trailColor={FB.divider}
        />
      </div>

      {/* 结果反馈 */}
      {result && (
        <Card style={{ marginBottom: 16, borderRadius: 8, borderColor: FB.border }} styles={{ body: { padding: 16, background: FB.cardBg } }}>
          <Row gutter={16} align="middle">
            <Col flex="auto">
              <Space size={24} wrap>
                <Statistic title="得分" value={result.score} suffix="/ 100" valueStyle={{ color: result.score >= 60 ? '#16a34a' : '#dc2626' }} />
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
                    {name}：{Math.round((v.correct / (v.total || 1)) * 100)}%
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

      {/* 分区导航：粉笔式文字标签（选中为实心蓝底） */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap',
        marginBottom: 16, padding: isMobile ? '8px 10px' : '10px 12px',
        background: FB.cardBg, borderRadius: 8, border: `1px solid ${FB.border}`,
      }}>
        {sections.map((s) => {
          const done = s.questions.filter((q) => answers[q.seq]).length;
          const active = activeSection === s.name;
          return (
            <div
              key={s.name}
              onClick={() => { setActiveSection(s.name); scrollToSeq(s.questions[0].seq); }}
              style={{
                cursor: 'pointer', padding: '4px 12px', borderRadius: 4, fontSize: 13, lineHeight: '20px',
                background: active ? FB.primary : FB.cardBg,
                color: active ? '#fff' : FB.textSub,
                border: `1px solid ${active ? FB.primary : FB.border}`,
                transition: 'all .15s',
              }}
            >
              {s.name}（{done}/{s.count}）
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 题目区（答题卡改为底部抽屉，题目区独占全宽） */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {sections.map((s) => (
            <div key={s.name}>
              <div
                style={{
                  margin: '8px 0 12px', fontSize: isMobile ? 15 : 16,
                  fontWeight: 600, color: FB.text,
                  display: 'flex', alignItems: 'baseline', gap: 8,
                }}
              >
                {s.name}
                <span style={{ fontWeight: 400, fontSize: 14, color: FB.textWeak }}>
                  （{s.count}题）
                </span>
              </div>

              {groupSectionQuestions(s.questions).map((grp) => {
                // 材料组但正文与图表都为空（材料组延伸到后续分区时的边界情况）
                // → 不渲染空的「本篇资料」面板，退回单列列表
                const hasMaterial = Boolean(grp.passage) || (grp.images || []).length > 0;
                if (!grp.materialGroup || !hasMaterial) {
                  return grp.questions.map(renderQuestionCard);
                }
                return materialSplit ? (
                  /* ── 宽屏：左材料 / 右小题，两栏严格等高 ─────────────── */
                  <div
                    key={`grp-${grp.id}`}
                    style={{
                      display: 'flex', gap: 16,
                      // 整行确定高度 → 两栏各 100%，等高由结构保证
                      height: MATERIAL_ROW_H,
                      marginBottom: 14,
                    }}
                  >
                    {/* 左栏：本篇总题干（材料正文 + 图表）。超出栏高时在栏内滚动 */}
                    <div style={{ flex: `0 0 ${MATERIAL_LEFT_W}`, minHeight: 0 }}>
                      <Card
                        size="small"
                        style={{ height: '100%', borderRadius: 8, borderColor: FB.border, display: 'flex', flexDirection: 'column' }}
                        styles={{ body: { padding: 16, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: FB.cardBg } }}
                      >
                        <div style={{ fontSize: 13, color: FB.textWeak, marginBottom: 8, flexShrink: 0 }}>本篇资料</div>
                        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                          {renderMaterialBody(grp, { fontSize: 16, eager: true })}
                        </div>
                      </Card>
                    </div>

                    {/* 右栏：本篇小题列表，在等高容器内独立上下滚动 */}
                    <div
                      data-scroll-port="1"
                      style={{
                        flex: 1, minWidth: 0, minHeight: 0, height: '100%',
                        overflowY: 'auto', overflowX: 'hidden', paddingRight: 4,
                      }}
                    >
                      {grp.questions.map((q) => renderQuestionCard(q, { hidePassage: true, hideMaterialImages: true }))}
                    </div>
                  </div>
                ) : (
                  /* ── 窄屏：两栏会把题目挤到读不了，改为材料卡 + 题目流式堆叠 ── */
                  <div key={`grp-${grp.id}`}>
                    <Card size="small" style={{ borderRadius: 8, marginBottom: 12, borderColor: FB.border }} styles={{ body: { padding: 14, background: FB.cardBg } }}>
                      <div style={{ fontSize: 13, color: FB.textWeak, marginBottom: 6 }}>本篇资料</div>
                      {renderMaterialBody(grp, { fontSize: isMobile ? 15 : 16, eager: false })}
                    </Card>
                    {grp.questions.map((q) => renderQuestionCard(q, { hidePassage: true, hideMaterialImages: true }))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

      </div>

      {/* 答题卡：粉笔式底部抽屉
          实测规格 —— fixed 贴底、白底、右上圆角 12px、描边 rgb(240,243,250) */}
      <Drawer
        title={null}
        placement="bottom"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        height={isMobile ? '62%' : '46%'}
        closable={false}
        styles={{
          body: { padding: '16px 20px 20px', background: FB.cardBg },
          wrapper: { boxShadow: 'none' },
          content: {
            borderTopLeftRadius: 12,
            border: `1px solid ${FB.cardBorder}`,
            borderBottom: 'none',
            overflow: 'hidden',
          },
        }}
      >
        {/* 抽屉顶部的标题行（粉笔是自绘的，不是 antd 标题） */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 14, paddingBottom: 10,
          borderBottom: `1px solid ${FB.cardBorder}`,
        }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: FB.text }}>答题卡</span>
          <span
            onClick={() => setSheetOpen(false)}
            style={{ fontSize: 13, color: FB.textWeak, cursor: 'pointer' }}
          >
            收起
          </span>
        </div>
        {answerSheet}
        <Button
          type="primary" block style={{ marginTop: 14, borderRadius: 4 }} loading={submitting}
          disabled={!!result} onClick={submit}
        >
          {result ? '已交卷' : '交卷并查看解析'}
        </Button>
      </Drawer>

      {/* 底部固定操作条：粉笔式 —— 答题卡入口 + 进度 + 交卷 */}
      <div style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 30,
        background: FB.cardBg, borderTop: `1px solid ${FB.border}`,
        boxShadow: '0 -2px 10px rgba(40,60,120,0.06)',
        padding: '10px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
        paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        fontFamily: FB_FONT,
      }}>
        <Button
          size="small" icon={<DashboardOutlined />} onClick={() => setSheetOpen(true)}
          style={{ borderRadius: 4, color: FB.primary, borderColor: FB.selectedBorder, background: FB.cardBg }}
        >
          答题卡
          {unansweredCount > 0 && (
            <span style={{ marginLeft: 6, width: 6, height: 6, borderRadius: '50%', background: '#f5222d', display: 'inline-block' }} />
          )}
        </Button>
        <Text style={{ fontSize: 13, color: FB.textSub, whiteSpace: 'nowrap' }}>
          答题进度
        </Text>
        <div style={{ flex: 1, minWidth: 60 }}>
          <Progress
            percent={total ? Math.round((answeredCount / total) * 100) : 0}
            size="small" showInfo={false}
            strokeColor={FB.primaryLight} trailColor={FB.divider}
          />
        </div>
        <Button
          type="primary" size="small" loading={submitting} disabled={!!result} onClick={submit}
          style={{ background: FB.primary, borderColor: FB.primary, borderRadius: 4 }}
        >
          {result ? '已交卷' : '交卷'}
        </Button>
      </div>

      {/* 截图大图：在当前页面内放大查看（不另开标签页，避免丢失作答进度） */}
      {previewImg && (
        <div
          onClick={() => setPreviewImg(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16, cursor: 'zoom-out',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, maxHeight: '100%' }}
          >
            <img
              src={previewImg}
              alt="原卷截图大图"
              style={{
                maxWidth: '100%', maxHeight: 'calc(100vh - 110px)', objectFit: 'contain',
                background: FB.cardBg, borderRadius: 8, display: 'block', cursor: 'default',
              }}
            />
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <a
                href={previewImg}
                target="_blank"
                rel="noreferrer"
                style={{ color: '#fff', fontSize: 13, textDecoration: 'underline' }}
              >
                在新标签页打开
              </a>
              <Button size="small" onClick={() => setPreviewImg(null)}>关闭</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
