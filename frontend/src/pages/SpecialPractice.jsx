import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Typography, Card, Button, Space, Select, InputNumber, Tag, Spin, Empty, message, Segmented, Modal, Radio } from 'antd';
import {
  FileTextOutlined, ThunderboltOutlined, SettingOutlined,
  RightOutlined, DownOutlined, CheckCircleFilled, FireOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';
import { F, FenbiScope, PageHead } from '../components/FenbiUI';
import { formatTime } from '../utils';

const { Text } = Typography;

/**
 * 专项练习（参照粉笔题库目录页）。
 *
 * 三栏结构：
 *   左侧  一级模块分类导航（选中浅橙底）
 *   中间  题库概览（名称/介绍/总量/开始练习）+ 选中模块的考点树 + 自定义刷题
 *   右侧  练习历史 + 学习统计
 * 顶部四个入口卡（快速练习 / 历年试卷 / AI 生成题 / 智能组卷）保持不变。
 *
 * 「去练习」沿用原有 goPractice 跳转逻辑；移动端把左栏改为横向分类条。
 */

const ENTRY_CARDS = [
  { key: 'quick', name: '快速练习', desc: '从题库随机抽题，立即开练', color: '#f47735', icon: <ThunderboltOutlined />, to: '/practice/do?pool=question&count=10' },
  { key: 'paper', name: '历年试卷', desc: '完整真题卷，按分类筛选', color: '#35b879', icon: <FileTextOutlined />, to: '/exam-papers' },
  { key: 'generated', name: 'AI 生成题', desc: '选科目与参数后开始刷题', color: '#7c6af0', icon: <ThunderboltOutlined />, action: 'ai' },
  { key: 'smart', name: '智能组卷', desc: '按出题年份自动生成试卷', color: '#2e9bd6', icon: <SettingOutlined />, action: 'smart' },
];

/** 难度档位（与本库 question.difficulty 1-5 对应） */
const DIFFICULTY_OPTIONS = [
  { value: 'all', label: '全部难度' },
  { value: '1,2', label: '简单' },
  { value: '3', label: '中等' },
  { value: '4,5', label: '困难' },
];

export default function SpecialPractice() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  // 粉笔配色仅作用于本页：不改动全局 ThemeContext，其余页面保持原貌
  const tokens = F;

  const [pool, setPool] = useState('question');
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState([]);
  // 左侧分类导航当前选中的一级模块（null 时回退到第一个模块）
  const [activeTop, setActiveTop] = useState(null);

  // 自定义刷题参数
  const [configOpen, setConfigOpen] = useState(false);
  const [cfgCategoryIds, setCfgCategoryIds] = useState([]);
  const [cfgQtypes, setCfgQtypes] = useState([]);
  const [cfgDifficulty, setCfgDifficulty] = useState('all');
  const [cfgCount, setCfgCount] = useState(20);
  const [cfgAvailable, setCfgAvailable] = useState(null);

  // 智能组卷：先选出题年份，再由系统自动抽题生成试卷
  const [smartOpen, setSmartOpen] = useState(false);
  const [smartYear, setSmartYear] = useState('all');

  // AI 生成题：先选科目，再配置题量/难度
  const [aiOpen, setAiOpen] = useState(false);
  const [aiSubjects, setAiSubjects] = useState([]);
  const [aiTotal, setAiTotal] = useState(0);
  const [aiSubject, setAiSubject] = useState(null);
  const [aiCount, setAiCount] = useState(10);
  const [aiDifficulty, setAiDifficulty] = useState('all');

  // 统计
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);

  // 加载分类树
  const loadTree = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/taxonomy/categories', { params: { pool } });
      setTree(r.data.tree || []);
      // 默认展开第一个模块
      if (r.data.tree && r.data.tree.length && expanded.length === 0) {
        setExpanded([r.data.tree[0].id]);
      }
    } catch (err) {
      message.error('加载分类失败');
    } finally {
      setLoading(false);
    }
  }, [pool, expanded.length]);

  useEffect(() => { loadTree(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pool]);

  // 加载学习数据与历史。
  // 三个指标分别取自各自的真实接口：/practice/stats 的 overall.total_questions（累计答题）、
  // /practice/wrong-book 的 stats.total（错题本条目）、/practice/favorites 的 total（收藏）。
  // 旧代码读的是 stats.total_answered / wrong_count / favorite_count 这些不存在的顶层字段，
  // 结果永远 fallback 到 0；这里改为并行取数，任一失败时显示 '—' 而不是伪造 0。
  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get('/practice/stats'),
      api.get('/practice/wrong-book', { params: { page: 1, pageSize: 1 } }),
      api.get('/practice/favorites', { params: { page: 1, pageSize: 1 } }),
    ]).then(([s, w, f]) => {
      if (!alive) return;
      setStats({
        answered: Number(s.data?.overall?.total_questions) || 0,
        wrong: Number(w.data?.stats?.total ?? w.data?.total) || 0,
        favorite: Number(f.data?.total) || 0,
      });
    }).catch(() => { /* 未登录或接口异常：保留 null，界面显示 '—' */ });
    api.get('/practice/history', { params: { limit: 5 } })
      .then((r) => setHistory((r.data.sessions || r.data.history || []).slice(0, 3)))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  /** 展开/收起考点分组 */
  const toggle = (id) => {
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /** 去练习：带上分类与参数跳到答题页（原有跳转逻辑不变） */
  const goPractice = (node, opts = {}) => {
    const params = new URLSearchParams();
    params.set('pool', pool);
    params.set('categories', node.id);
    params.set('categoryName', node.name);
    if (opts.count) params.set('count', String(opts.count));
    if (opts.qtypes && opts.qtypes.length) params.set('qtypes', opts.qtypes.join(','));
    if (opts.difficulty && opts.difficulty !== 'all') params.set('difficulty', opts.difficulty);
    navigate(`/practice/do?${params.toString()}`);
  };

  /** 计算某配置下可用题数 */
  const checkAvailable = useCallback(async () => {
    try {
      const diff = DIFFICULTY_OPTIONS.find((d) => d.value === cfgDifficulty);
      const range = diff && diff.value !== 'all' ? diff.value.split(',').map(Number) : null;
      const r = await api.post('/taxonomy/pick', {
        pool,
        categoryIds: cfgCategoryIds,
        qtypes: cfgQtypes,
        difficultyRange: range,
        count: 1,
      });
      setCfgAvailable(r.data.available);
    } catch (err) {
      setCfgAvailable(0);
    }
  }, [pool, cfgCategoryIds, cfgQtypes, cfgDifficulty]);

  useEffect(() => {
    if (configOpen) checkAvailable();
  }, [configOpen, checkAvailable]);

  useEffect(() => {
    if (!aiOpen) return;
    api.get('/taxonomy/generated-subjects')
      .then((r) => {
        const list = r.data.subjects || [];
        setAiSubjects(list);
        setAiTotal(r.data.total || 0);
        const first = list.find((x) => Number(x.count) > 0);
        if (first && !aiSubject) setAiSubject(first.id);
      })
      .catch(() => message.error('加载生成题科目失败'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiOpen]);

  /** 分类树选择器（自定义刷题用） */
  const categoryOptions = useMemo(() => {
    const out = [];
    const walk = (nodes, depth) => {
      nodes.forEach((n) => {
        out.push({ value: n.id, label: `${'　'.repeat(depth)}${n.name}`, total: n.totalCount });
        if (n.children && n.children.length) walk(n.children, depth + 1);
      });
    };
    walk(tree, 0);
    return out;
  }, [tree]);

  // 当前选中的一级模块；切换题库导致 tree 变化时自动回退到第一个模块
  const activeTopNode = tree.find((n) => n.id === activeTop) || tree[0] || null;

  const renderNode = (node, depth) => {
    const isOpen = expanded.includes(node.id);
    const hasChildren = node.children && node.children.length > 0;

    return (
      <div key={node.id}>
        <div
          onClick={() => (hasChildren ? toggle(node.id) : goPractice(node))}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 12px', borderRadius: 6,
            cursor: 'pointer',
            color: depth === 1 ? tokens.text : tokens.textSub,
            fontWeight: depth === 1 ? 600 : 400,
            fontSize: 14,
            background: depth === 1 ? tokens.cardBgAlt : 'transparent',
          }}
        >
          <span style={{ width: 14, display: 'inline-flex', color: tokens.textWeak }}>
            {hasChildren ? (isOpen ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />) : null}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.name}
          </span>
          {!hasChildren && (
            <Button
              type="link"
              size="small"
              onClick={(e) => { e.stopPropagation(); goPractice(node); }}
              style={{ fontSize: 12, padding: 0, flexShrink: 0, color: tokens.primary }}
            >
              去练习
            </Button>
          )}
        </div>
        {hasChildren && isOpen && (
          <div style={{ paddingLeft: 18 }}>
            {node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  /** 左侧一级分类导航（移动端为横向分类条） */
  const categoryNav = isMobile ? (
    <div className="hide-scrollbar" style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 12, paddingBottom: 2 }}>
      {tree.map((n) => {
        const on = n.id === activeTopNode?.id;
        return (
          <button
            key={n.id}
            type="button"
            onClick={() => setActiveTop(n.id)}
            style={{
              flexShrink: 0, cursor: 'pointer', padding: '7px 14px', borderRadius: 6, fontSize: 13,
              border: `1px solid ${on ? tokens.primary : tokens.border}`,
              background: on ? tokens.selectedBg : tokens.cardBg,
              color: on ? tokens.primary : tokens.textSub,
              fontWeight: on ? 600 : 400,
            }}
          >
            {n.name}
          </button>
        );
      })}
    </div>
  ) : (
    <Card
      title={<span style={{ color: tokens.text, fontSize: 14 }}>题库分类</span>}
      style={{ borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
      styles={{ body: { padding: '8px 10px' } }}
    >
      {tree.map((n) => {
        const on = n.id === activeTopNode?.id;
        return (
          <div
            key={n.id}
            onClick={() => setActiveTop(n.id)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
              padding: '10px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 14,
              color: on ? tokens.primary : tokens.textSub,
              background: on ? tokens.selectedBg : 'transparent',
              borderLeft: on ? `3px solid ${tokens.primary}` : '3px solid transparent',
              fontWeight: on ? 600 : 400,
              marginBottom: 2,
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={(e) => { if (!on) e.currentTarget.style.background = tokens.cardBgAlt; }}
            onMouseLeave={(e) => { if (!on) e.currentTarget.style.background = 'transparent'; }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.name}</span>
          </div>
        );
      })}
    </Card>
  );

  return (
    <FenbiScope>
      <PageHead title="题库" desc="按模块与考点选择练习内容，系统自动记录每一次练习结果。" />
    <div>
      {/* 顶部入口卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        {ENTRY_CARDS.map((c) => (
          <Card
            key={c.key}
            hoverable
            onClick={() => {
              if (c.to) navigate(c.to);
              else if (c.action === 'smart') setSmartOpen(true);
              else if (c.action === 'ai') setAiOpen(true);
            }}
            style={{ borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
            styles={{ body: { padding: 18 } }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 42, height: 42, borderRadius: 10, flexShrink: 0,
                display: 'grid', placeItems: 'center',
                background: `${c.color}18`, color: c.color, fontSize: 20,
              }}>
                {c.icon}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: tokens.text }}>{c.name}</div>
                <div style={{ fontSize: 12, color: tokens.textWeak }}>{c.desc}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {isMobile && categoryNav}

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {/* 左栏：一级分类导航 */}
        {!isMobile && <div style={{ width: 210, flexShrink: 0 }}>{categoryNav}</div>}

        {/* 中间：题库概览 + 考点树 + 自定义刷题 */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* 题库概览：名称 / 介绍 / 练习入口 */}
          <Card
            style={{ marginBottom: 16, borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
            styles={{ body: { padding: isMobile ? 16 : 20 } }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: tokens.text }}>
                  {pool === 'question' ? 'NCSE 公务员考试题库' : '历年真题库'}
                </div>
                <div style={{ fontSize: 13, color: tokens.textWeak, marginTop: 6, lineHeight: 1.7 }}>
                  按模块与考点逐级练习，覆盖单选、多选、判断等题型，答题进度自动保存
                </div>
              </div>
              <Button
                type="primary"
                onClick={() => navigate(`/practice/do?pool=${pool}&count=20`)}
                style={{ height: 38, padding: '0 22px', borderRadius: 8, fontWeight: 600 }}
              >
                开始练习
              </Button>
            </div>
          </Card>

          {/* 当前模块的考点分类树 */}
          <Card
            title={<span style={{ color: tokens.text }}>{activeTopNode?.name || '专项练习'}</span>}
            extra={
              <Space size={8}>
                <Tag style={{ marginInlineEnd: 0, borderRadius: 4, fontSize: 12 }}>
                  题库：{pool === 'question' ? '全部' : '真题'}
                </Tag>
                <Button size="small" icon={<SettingOutlined />} onClick={() => setConfigOpen(true)}>
                  自定义刷题
                </Button>
              </Space>
            }
            style={{ borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
            styles={{ body: { padding: '8px 6px' } }}
          >
            {loading ? (
              <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
            ) : tree.length === 0 ? (
              <Empty description="暂无分类数据" style={{ padding: 24 }} />
            ) : activeTopNode?.children?.length ? (
              activeTopNode.children.map((c) => renderNode(c, 1))
            ) : activeTopNode ? (
              <div style={{ padding: 12 }}>
                <Text type="secondary">该模块暂无下级考点，</Text>
                <Button type="link" size="small" style={{ padding: 0 }} onClick={() => goPractice(activeTopNode)}>直接练习</Button>
              </div>
            ) : null}
          </Card>

          {/* 自定义刷题参数 */}
          {configOpen && (
            <Card
              title={<span style={{ color: tokens.text }}>自定义刷题</span>}
              extra={<Button size="small" type="text" onClick={() => setConfigOpen(false)}>收起</Button>}
              style={{ marginTop: 16, borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
            >
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <div>
                  <Text strong style={{ color: tokens.text }}>刷题范围</Text>
                  <Select
                    mode="multiple"
                    allowClear
                    placeholder="不选 = 全部模块"
                    value={cfgCategoryIds}
                    onChange={setCfgCategoryIds}
                    options={categoryOptions}
                    optionFilterProp="label"
                    style={{ width: '100%', marginTop: 6 }}
                    maxTagCount="responsive"
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
                  <div>
                    <Text strong style={{ color: tokens.text }}>题型</Text>
                    <Select
                      mode="multiple"
                      allowClear
                      placeholder="全部题型"
                      value={cfgQtypes}
                      onChange={setCfgQtypes}
                      options={['单选题', '多选题', '判断题'].map((t) => ({ label: t, value: t }))}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                  </div>
                  <div>
                    <Text strong style={{ color: tokens.text }}>难度</Text>
                    <Select
                      value={cfgDifficulty}
                      onChange={setCfgDifficulty}
                      options={DIFFICULTY_OPTIONS}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                  </div>
                  <div>
                    <Text strong style={{ color: tokens.text }}>题量</Text>
                    <InputNumber
                      min={1} max={200} value={cfgCount}
                      onChange={(v) => setCfgCount(v || 20)}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                  </div>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                  padding: '10px 14px', borderRadius: 8, background: tokens.cardBgAlt,
                }}>
                  <span style={{ fontSize: 13, color: tokens.textSub }}>
                    {cfgAvailable ? '已按当前条件准备好练习题目' : '当前条件下暂无可练习的题目'}
                  </span>
                  <Button
                    type="primary"
                    disabled={!cfgAvailable || cfgAvailable === 0}
                    onClick={() => {
                      const diff = DIFFICULTY_OPTIONS.find((d) => d.value === cfgDifficulty);
                      const params = new URLSearchParams();
                      params.set('pool', pool);
                      if (cfgCategoryIds.length) params.set('categories', cfgCategoryIds.join(','));
                      if (cfgQtypes.length) params.set('qtypes', cfgQtypes.join(','));
                      if (diff && diff.value !== 'all') params.set('difficulty', diff.value);
                      params.set('count', String(Math.min(cfgCount, cfgAvailable || cfgCount)));
                      params.set('custom', '1');
                      navigate(`/practice/do?${params.toString()}`);
                    }}
                  >
                    开始练习
                  </Button>
                </div>
              </Space>
            </Card>
          )}
        </div>

        {/* 右栏：练习历史与统计 */}
        {!isMobile && (
          <div style={{ width: 260, flexShrink: 0 }}>
            <Card
              title={<span style={{ color: tokens.text, fontSize: 14 }}>练习历史</span>}
              extra={<Button type="link" size="small" style={{ fontSize: 12, padding: 0 }} onClick={() => navigate('/history')}>查看全部</Button>}
              style={{ marginBottom: 12, borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
              styles={{ body: { padding: 14 } }}
            >
              {history.length === 0 ? (
                <Text type="secondary" style={{ fontSize: 13 }}>暂无练习记录</Text>
              ) : history.map((h) => (
                <div
                  key={h.id}
                  onClick={() => navigate(`/practice/do?session=${h.id}&view=result`)}
                  style={{
                    padding: '8px 0', cursor: 'pointer',
                    borderBottom: `1px solid ${tokens.divider}`,
                  }}
                >
                  <div style={{ fontSize: 13, color: tokens.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.title || `练习 #${h.id}`}
                  </div>
                  <div style={{ fontSize: 12, color: tokens.textWeak, marginTop: 2 }}>
                    {h.score != null ? `${h.score} 分` : '查看结果'}
                    {h.duration_sec != null ? ` · ${formatTime(h.duration_sec)}` : ''}
                  </div>
                </div>
              ))}
            </Card>

            <Card
              title={<span style={{ color: tokens.text, fontSize: 14 }}>学习数据</span>}
              style={{ borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
              styles={{ body: { padding: 14 } }}
            >
              {[
                { icon: <ThunderboltOutlined />, label: '已练题数', value: stats?.answered, to: '/history', color: tokens.primary },
                { icon: <CheckCircleFilled />, label: '错题', value: stats?.wrong, to: '/wrong-book', color: tokens.error },
                { icon: <FireOutlined />, label: '收藏', value: stats?.favorite, to: '/favorites', color: tokens.accent },
              ].map((it) => (
                <div key={it.label} onClick={() => navigate(it.to)} title={`查看${it.label}`} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '9px 0', cursor: 'pointer',
                  borderBottom: `1px solid ${tokens.divider}`, color: tokens.textSub, fontSize: 13,
                }}>
                  <span style={{ color: it.color }}>{it.icon}</span>
                  <span style={{ flex: 1 }}>{it.label}</span>
                  <span style={{ fontSize: 15, fontWeight: 600, color: tokens.text }}>{it.value ?? '—'}</span>
                  <RightOutlined style={{ fontSize: 10, color: tokens.textWeak }} />
                </div>
              ))}
            </Card>
          </div>
        )}
      </div>

      {/* 智能组卷：先选出题年份，再由系统自动抽题生成试卷（与自定义刷题分开） */}
      <Modal
        className="fenbi-portal"
        title="智能组卷"
        open={smartOpen}
        onCancel={() => setSmartOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <div style={{ marginBottom: 18 }}>
          <Text strong style={{ color: tokens.text, display: 'block', marginBottom: 10 }}>设置出题年份</Text>
          <Segmented
            block
            value={smartYear}
            onChange={setSmartYear}
            options={[
              { label: '不限', value: 'all' },
              { label: '近5年', value: 'near5' },
              { label: '近10年', value: 'near10' },
            ]}
          />
        </div>
        <div style={{ marginBottom: 18 }}>
          <Text strong style={{ color: tokens.text, display: 'block', marginBottom: 10 }}>试卷结构（国考行测）</Text>
          <div style={{ padding: '10px 14px', borderRadius: 8, background: tokens.cardBgAlt, fontSize: 13, lineHeight: 2, color: tokens.textSub }}>
            政治理论 · 常识判断 · 言语理解与表达<br />
            数量关系 · 判断推理 · 资料分析
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => setSmartOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => {
            const params = new URLSearchParams();
            params.set('smart', '1');
            if (smartYear !== 'all') params.set('years', smartYear);
            setSmartOpen(false);
            navigate(`/practice/do?${params.toString()}`);
          }}>生成试卷</Button>
        </div>
      </Modal>

      {/* AI 生成题：先按科目进入，再配置练习参数 */}
      <Modal
        className="fenbi-portal"
        title="AI 生成题"
        open={aiOpen}
        onCancel={() => setAiOpen(false)}
        footer={null}
        destroyOnHidden
        width={isMobile ? '100%' : 560}
      >
        {aiTotal === 0 ? (
          <Empty description="暂无已上架的 AI 生成题，请先在管理后台生成并审核题目" />
        ) : (
          <>
            <Text strong style={{ color: tokens.text, display: 'block', marginBottom: 10 }}>选择题目的科目</Text>
            <Radio.Group
              value={aiSubject}
              onChange={(e) => setAiSubject(e.target.value)}
              style={{ width: '100%', marginBottom: 18 }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: 8 }}>
                {aiSubjects.filter((x) => Number(x.count) > 0).map((x) => (
                  <Radio.Button
                    key={x.id}
                    value={x.id}
                    style={{ height: 'auto', lineHeight: '22px', padding: '8px 12px', borderRadius: 8, borderLeft: '1px solid #d9d9d9' }}
                  >
                    {x.name}
                  </Radio.Button>
                ))}
              </div>
            </Radio.Group>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
              <div>
                <Text strong style={{ color: tokens.text, display: 'block', marginBottom: 8 }}>题量</Text>
                <InputNumber min={1} max={200} value={aiCount} onChange={(v) => setAiCount(v || 10)} style={{ width: '100%' }} />
              </div>
              <div>
                <Text strong style={{ color: tokens.text, display: 'block', marginBottom: 8 }}>难度</Text>
                <Select value={aiDifficulty} onChange={setAiDifficulty} options={DIFFICULTY_OPTIONS} style={{ width: '100%' }} />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <Button onClick={() => setAiOpen(false)}>取消</Button>
              <Button type="primary" disabled={!aiSubject} onClick={() => {
                const params = new URLSearchParams();
                params.set('pool', 'generated');
                params.set('count', String(aiCount));
                params.set('subject', String(aiSubject));
                if (aiDifficulty !== 'all') params.set('difficulty', aiDifficulty);
                setAiOpen(false);
                navigate(`/practice/do?${params.toString()}`);
              }}>开始刷题</Button>
            </div>
          </>
        )}
      </Modal>
    </div>
    </FenbiScope>
  );
}
