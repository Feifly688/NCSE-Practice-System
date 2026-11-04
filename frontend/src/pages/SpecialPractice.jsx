import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Typography, Card, Button, Space, Select, InputNumber, Progress, Tag, Spin, Empty, Input, Collapse, message, Tooltip, Segmented } from 'antd';
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
  { key: 'quick', name: '快速练习', desc: '按模块随机抽题，立即开练', color: '#385dca', icon: <ThunderboltOutlined />, to: '/practice' },
  { key: 'paper', name: '历年试卷', desc: '完整真题卷，按分类筛选', color: '#0f9d58', icon: <FileTextOutlined />, to: '/exam-papers' },
  { key: 'generated', name: 'AI 生成题', desc: 'AI 生成的专项题目，独立题池', color: '#8b5cf6', icon: <ThunderboltOutlined />, to: '/practice/do?pool=generated&count=10' },
  { key: 'custom', name: '智能组卷', desc: '自定义范围与题量', color: '#d98324', icon: <SettingOutlined /> },
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
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
          {ENTRY_CARDS.map((c) => (
            <Card
              key={c.key}
              hoverable
              onClick={() => {
                if (c.to) navigate(c.to);
                else setConfigOpen(true);
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
