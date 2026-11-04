import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Typography, Card, Button, Space, Select, InputNumber, Progress, Tag, Spin, Empty, Input, Collapse, message, Tooltip, Segmented, Modal, Radio } from 'antd';
import {
  FileTextOutlined, ThunderboltOutlined, SettingOutlined, HistoryOutlined,
  RightOutlined, DownOutlined, CheckCircleFilled, FireOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';
import { useTheme } from '../contexts/ThemeContext';
import { formatTime } from '../utils';

const { Title, Text } = Typography;

/**
 * 专项练习（参照粉笔题库「专项练习」页）。
 *
 * 结构照搬粉笔：
 *   顶部  入口卡（快速练习 / 历年试卷 / 智能组卷）
 *   主体  分类树（一级模块 → 二级考点/题型 → 三级知识点）
 *         每项显示「已练/总数」，右侧「去练习」
 *   右栏  练习历史 + 统计（预估分 / 错题 / 笔记 / 收藏）
 *
 * 「自定义刷题」按钮进入参数配置：范围、题型、题量、难度。
 */

const ENTRY_CARDS = [
  { key: 'quick', name: '快速练习', desc: '从题库随机抽题，立即开练', color: '#385dca', icon: <ThunderboltOutlined />, to: '/practice/do?pool=question&count=10' },
  { key: 'paper', name: '历年试卷', desc: '完整真题卷，按分类筛选', color: '#0f9d58', icon: <FileTextOutlined />, to: '/exam-papers' },
  { key: 'generated', name: 'AI 生成题', desc: '选科目与参数后开始刷题', color: '#8b5cf6', icon: <ThunderboltOutlined />, action: 'ai' },
  { key: 'smart', name: '智能组卷', desc: '按出题年份自动生成试卷', color: '#d98324', icon: <SettingOutlined />, action: 'smart' },
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
  const { tokens } = useTheme();

  const [pool, setPool] = useState('question');
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState([]);

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
  const [smartCount, setSmartCount] = useState(20);

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

  // 加载统计与历史
  useEffect(() => {
    api.get('/practice/stats').then((r) => setStats(r.data)).catch(() => {});
    api.get('/practice/history', { params: { limit: 5 } })
      .then((r) => setHistory(r.data.sessions || r.data.history || []))
      .catch(() => {});
  }, []);

  /** 展开/收起一级模块 */
  const toggle = (id) => {
    setExpanded((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  /** 去练习：带上分类与参数跳到答题页 */
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

  const renderNode = (node, depth) => {
    const isOpen = expanded.includes(node.id);
    const hasChildren = node.children && node.children.length > 0;
    const isLeaf = !hasChildren;

    return (
      <div key={node.id}>
        <div
          onClick={() => (hasChildren ? toggle(node.id) : goPractice(node))}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 12px', borderRadius: 6,
            cursor: 'pointer',
            color: depth === 0 ? tokens.text : tokens.textSub,
            fontWeight: depth === 0 ? 600 : 400,
            fontSize: depth === 0 ? 15 : 14,
            background: depth === 0 ? tokens.cardBgAlt : 'transparent',
          }}
        >
          <span style={{ width: 14, display: 'inline-flex', color: tokens.textWeak }}>
            {hasChildren ? (isOpen ? <DownOutlined style={{ fontSize: 10 }} /> : <RightOutlined style={{ fontSize: 10 }} />) : null}
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.name}
          </span>
          <span style={{ fontSize: 12, color: tokens.textWeak, flexShrink: 0 }}>
            {node.doneCount}/{node.totalCount}
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

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 入口卡 */}
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

        {/* 专项练习 */}
        <Card
          title={<span style={{ color: tokens.text }}>专项练习</span>}
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
          ) : (
            tree.map((n) => renderNode(n, 0))
          )}
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
                  该条件下共有 <b style={{ color: tokens.primary }}>{cfgAvailable ?? '—'}</b> 道题
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

      {/* 智能组卷：先选出题年份，再由系统自动抽题生成试卷（与自定义刷题分开） */}
      <Modal
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
          <Text strong style={{ color: tokens.text, display: 'block', marginBottom: 10 }}>试卷题量</Text>
          <InputNumber min={5} max={200} value={smartCount} onChange={(v) => setSmartCount(v || 20)} style={{ width: '100%' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button onClick={() => setSmartOpen(false)}>取消</Button>
          <Button type="primary" onClick={() => {
            const params = new URLSearchParams();
            params.set('pool', 'question');
            params.set('count', String(smartCount));
            if (smartYear !== 'all') params.set('years', smartYear);
            params.set('smart', '1');
            setSmartOpen(false);
            navigate(`/practice/do?${params.toString()}`);
          }}>生成试卷</Button>
        </div>
      </Modal>

      {/* AI 生成题：先按科目进入，再配置练习参数 */}
      <Modal
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
                    {x.name}<span style={{ color: tokens.textWeak, marginLeft: 6 }}>{x.count} 题</span>
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

      {/* 右栏：历史与统计 */}
      {!isMobile && (
        <div style={{ width: 260, flexShrink: 0 }}>
          <Card
            title={<span style={{ color: tokens.text, fontSize: 14 }}>练习历史</span>}
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
                  {h.total ? `${h.correct || 0}/${h.total} 题` : ''}
                  {h.score != null ? ` · ${h.score} 分` : ''}
                  {h.duration_sec != null ? ` · ${formatTime(h.duration_sec)}` : ''}
                </div>
              </div>
            ))}
          </Card>

          <Card
            style={{ borderRadius: 10, borderColor: tokens.cardBorder, background: tokens.cardBg }}
            styles={{ body: { padding: 14 } }}
          >
            {[
              { icon: <ThunderboltOutlined />, label: '已练题数', value: stats?.total_answered ?? stats?.totalAnswered ?? 0, color: tokens.primary },
              { icon: <CheckCircleFilled />, label: '错题', value: stats?.wrong_count ?? stats?.wrongCount ?? 0, color: tokens.error },
              { icon: <FireOutlined />, label: '收藏', value: stats?.favorite_count ?? stats?.favoriteCount ?? 0, color: tokens.accent },
            ].map((it) => (
              <div key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <span style={{ color: it.color }}>{it.icon}</span>
                <span style={{ flex: 1, fontSize: 13, color: tokens.textSub }}>{it.label}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: tokens.text }}>{it.value}</span>
              </div>
            ))}
          </Card>
        </div>
      )}
    </div>
  );
}
