import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, List, Tag, Button, Empty, Spin, Typography, message, Input, Pagination } from 'antd';
import { FileTextOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';
import { useTheme } from '../contexts/ThemeContext';
import { useAuth } from '../contexts/AuthContext';

const { Title, Text } = Typography;

/**
 * 用户端：历年试卷列表。
 *
 * 参照粉笔「历年试卷」页（spa.fiku/guide/realTest/xingce/xingce）：
 *   · 顶部标签栏：推荐 / 国考 / 省考模拟题 / 各省份
 *   · 每条试卷：标题 + 难度 + 完成状态
 *
 * 与粉笔的差异（有意为之）：
 *   **不展示来源**（PDF 上传 / 爬取）—— 该属性只对管理员可见。
 */
export default function ExamPaperList() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const { tokens } = useTheme();
  const { isAdmin } = useAuth();

  const [loading, setLoading] = useState(true);
  const [papers, setPapers] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({});
  const [active, setActive] = useState('');        // 选中的粉笔标签（'' = 推荐/全部）
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 20; // 卷子多了以后按页浏览（爬完有 3700+ 套）

  // 加载筛选项（fenbi_label 维度 = 粉笔原版标签栏，含各标签卷数）
  useEffect(() => {
    api.get('/taxonomy/paper-filters')
      .then((r) => setFilters(r.data.filters || {}))
      .catch(() => {});
  }, []);

  // 加载试卷列表（切标签/搜索时回第一页）
  useEffect(() => {
    setPage(1);
    load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, keyword]);

  useEffect(() => {
    if (page > 1) load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  async function load(targetPage) {
    setLoading(true);
    try {
      const params = { page: targetPage || page || 1, pageSize: PAGE_SIZE };
      if (active) params.label = active;   // 粉笔原始标签 id
      if (keyword.trim()) params.keyword = keyword.trim();
      const r = await api.get('/exam-papers', { params });
      setPapers(r.data.papers || []);
      setTotal(r.data.total || 0);
    } catch (err) {
      message.error('加载真题列表失败');
    } finally {
      setLoading(false);
    }
  }

  // 粉笔原版扁平标签栏：推荐 + fenbi_label 字典（原版顺序）
  const labelTabs = useMemo(() => (filters.fenbi_label || []), [filters]);

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4, color: tokens.text }}>历年试卷</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16, color: tokens.textWeak }}>
        按完整试卷形态在线作答，交卷后查看分数、答案与解析
      </Text>

      <Card style={{ borderRadius: 12, borderColor: tokens.cardBorder, background: tokens.cardBg }}>
        {/* 粉笔原版扁平标签栏：推荐 / 国考 / 国考模拟题 / 省考模拟题 / 各省 / 深圳市考 / 广州市考 / 政法干警 / 选调 */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ marginBottom: 10 }}>
            <Input
              size="small"
              allowClear
              prefix={<SearchOutlined style={{ color: tokens.textWeak }} />}
              placeholder="搜索试卷名称"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={{ width: isMobile ? '100%' : 220 }}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <button
              type="button"
              onClick={() => setActive('')}
              style={{
                cursor: 'pointer', padding: '4px 12px', borderRadius: 4, fontSize: 13,
                border: `1px solid ${active === '' ? tokens.primary : 'transparent'}`,
                background: active === '' ? tokens.primary : 'transparent',
                color: active === '' ? '#fff' : tokens.textSub,
              }}
            >
              推荐
            </button>
            {labelTabs.map((v) => {
              const on = active === v.value;
              return (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setActive(on ? '' : v.value)}
                  style={{
                    cursor: 'pointer', padding: '4px 12px', borderRadius: 4, fontSize: 13,
                    border: `1px solid ${on ? tokens.primary : 'transparent'}`,
                    background: on ? tokens.primary : 'transparent',
                    color: on ? '#fff' : tokens.textSub,
                  }}
                >
                  {v.label}
                  {v.count > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 12, opacity: 0.75 }}>{v.count}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}><Spin /></div>
        ) : papers.length === 0 ? (
          <Empty description="暂无可作答的整卷真题" />
        ) : (
          <>
            <Text style={{ fontSize: 13, color: tokens.textWeak, display: 'block', marginBottom: 4 }}>
              共 {total} 套
            </Text>
            <List
              dataSource={papers}
              renderItem={(p) => (
                <List.Item
                  actions={[
                    <Button
                      key="take" type="link" icon={<RightOutlined />}
                      onClick={() => navigate(`/exam-papers/${p.id}`)}
                    >
                      开始作答
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={
                      <div style={{
                        width: 40, height: 40, borderRadius: 10,
                        background: tokens.selectedBg,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: tokens.primary,
                      }}>
                        <FileTextOutlined />
                      </div>
                    }
                    title={
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: tokens.text }}>{p.title}</span>
                        {p.year && <Tag style={{ marginInlineEnd: 0 }}>{p.year}</Tag>}
                        {p.exam_level && (
                          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                            {p.exam_level === 'national' ? '国考'
                              : p.exam_level === 'provincial' ? '省考' : p.exam_level}
                          </Tag>
                        )}
                        {p.region && <Tag style={{ marginInlineEnd: 0 }}>{p.region}</Tag>}
                        {p.paper_type && (
                          <Tag color="purple" style={{ marginInlineEnd: 0 }}>{p.paper_type}</Tag>
                        )}
                        {p.difficulty != null && (
                          <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                            难度 {Number(p.difficulty).toFixed(1)}
                          </Tag>
                        )}
                        {p.parse_status === 'partial' && (
                          <Tag color="warning" style={{ marginInlineEnd: 0 }}>部分拆分</Tag>
                        )}
                      </div>
                    }
                    description={
                      <Text style={{ fontSize: 13, color: tokens.textWeak }}>
                        共 {p.parsed_count} 题
                        {/* 来源属性仅管理员可见 */}
                        {isAdmin && !isMobile ? ` · 来源：${p.source || '—'}` : ''}
                      </Text>
                    }
                  />
                </List.Item>
              )}
            />
            {total > PAGE_SIZE && (
              <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
                <Pagination
                  current={page}
                  pageSize={PAGE_SIZE}
                  total={total}
                  showSizeChanger={false}
                  showQuickJumper={total > 200}
                  onChange={(p) => setPage(p)}
                />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
