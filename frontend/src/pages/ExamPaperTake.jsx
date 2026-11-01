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
import { useResponsive } from '../hooks/useResponsive';

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

const CARD_STATUS_COLOR = {
  answered: { bg: '#1D4ED8', color: '#fff', border: '#1D4ED8' },
  marked: { bg: '#fff7e6', color: '#d46b08', border: '#ffd591' },
  unanswered: { bg: '#fff', color: '#8c8c8c', border: '#d9d9d9' },
  correct: { bg: '#16a34a', color: '#fff', border: '#16a34a' },
  wrong: { bg: '#dc2626', color: '#fff', border: '#dc2626' },
};

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
              background: '#fff', cursor: 'zoom-in', display: 'block', marginBottom: 8,
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
          marginBottom: 14, borderRadius: 10,
          borderColor: isWrong ? '#ffccc7' : undefined,
        }}
        styles={{ body: { padding: isMobile ? '12px 14px' : '16px 20px' } }}
      >
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

        {q.passage && !opts.hidePassage && (
          <Paragraph style={{
            background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8,
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
                    background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 8,
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
                        borderRadius: 8, background: '#fff', cursor: 'zoom-in', display: 'block',
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
                    borderRadius: 8, background: '#fff', cursor: 'zoom-in', display: 'block',
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
            // 选项在原 PDF 中是图片（图形推理/几何图/统计图），文本层只有占位符。
            // 这类选项只显示原卷的标号（A/B/C/D），不写「该选项在原试卷中为图片」这种废话。
            const isImageOption = typeof opt === 'string' && /图片选项|^[A-D]$/.test(opt.trim());
            const optText = isImageOption
              ? (/^[A-Da-d]$/.test(opt.trim()) ? opt.trim() : label)
              : opt;

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
                  {optText}
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
  };

  return (
    <div style={{ paddingBottom: isMobile ? 80 : 24 }}>
      {/* 顶部信息栏 */}
      <Card
        ref={headerRef}
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
                        style={{ height: '100%', borderRadius: 10, display: 'flex', flexDirection: 'column' }}
                        styles={{ body: { padding: 14, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } }}
                      >
                        <div style={{ fontSize: 13, color: '#8c8c8c', marginBottom: 8, flexShrink: 0 }}>本篇资料</div>
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
                    <Card size="small" style={{ borderRadius: 10, marginBottom: 12 }} styles={{ body: { padding: 12 } }}>
                      <div style={{ fontSize: 13, color: '#8c8c8c', marginBottom: 6 }}>本篇资料</div>
                      {renderMaterialBody(grp, { fontSize: isMobile ? 15 : 16, eager: false })}
                    </Card>
                    {grp.questions.map((q) => renderQuestionCard(q, { hidePassage: true, hideMaterialImages: true }))}
                  </div>
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
                background: '#fff', borderRadius: 8, display: 'block', cursor: 'default',
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
