import React, { useState, useEffect } from 'react';
import { Typography, Tag, Button, Select, Modal, message, InputNumber, Checkbox, Divider, Space, List, Empty, Spin } from 'antd';
import { EyeOutlined, DownloadOutlined, CheckCircleOutlined, CopyOutlined, DeleteOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import FlexTable from '../../components/FlexTable';
import api from '../../services/api';

const { Title, Paragraph, Text } = Typography;

const AVAILABLE_SOURCES = [
  // 人民日报系列
  { id: 'people', name: '人民日报·评论', desc: '人民网观点频道评论文章' },
  { id: 'people_politics', name: '人民日报·时政', desc: '人民网时政频道新闻' },
  { id: 'people_economy', name: '人民网·经济', desc: '人民网经济频道新闻' },
  { id: 'people_society', name: '人民网·社会', desc: '人民网社会频道新闻' },
  { id: 'people_legality', name: '人民网·法治', desc: '人民网法治频道新闻' },
  // 新华社系列
  { id: 'xinhua', name: '新华社·时政', desc: '新华网时政频道新闻' },
  { id: 'xinhua_world', name: '新华社·国际', desc: '新华网国际频道新闻' },
  { id: 'xinhua_education', name: '新华社·教育', desc: '新华网教育频道新闻' },
  { id: 'xinhua_military', name: '新华社·军事', desc: '新华网军事频道新闻' },
];

export default function Articles() {
  const [loading, setLoading] = useState(true);
  const [articles, setArticles] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [previewArticle, setPreviewArticle] = useState(null);
  const [sortField, setSortField] = useState('created_at');
  const [sortOrder, setSortOrder] = useState('desc');

  // Fetch flow states
  const [fetchModalOpen, setFetchModalOpen] = useState(false);
  const [totalCount, setTotalCount] = useState(10);
  const [enabledSources, setEnabledSources] = useState(['people', 'xinhua']);
  const [previewStep, setPreviewStep] = useState(false);
  const [candidateList, setCandidateList] = useState([]);
  const [selectedCandidates, setSelectedCandidates] = useState([]);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [newArticleCategory, setNewArticleCategory] = useState('both');

  useEffect(() => { loadSources(); }, []);
  useEffect(() => { loadArticles(); }, [page, selectedSource, selectedCategory, sortField, sortOrder]);

  async function loadSources() {
    try { const r = await api.get('/articles/sources'); setSources(r.data.sources); } catch (_) {}
  }

  async function loadArticles() {
    setLoading(true);
    try {
      const params = { page, pageSize: 15, sortField, sortOrder };
      if (selectedSource) params.source = selectedSource;
      if (selectedCategory) params.category = selectedCategory;
      const r = await api.get('/articles', { params });
      setArticles(r.data.articles);
      setTotal(r.data.total);
    } catch (err) { message.error('加载失败'); }
    finally { setLoading(false); }
  }

  async function previewContent(id) {
    try { const r = await api.get(`/articles/${id}`); setPreviewArticle(r.data.article); }
    catch (err) { message.error('加载文章失败'); }
  }

  function copyLink(url) {
    if (!url) { message.warning('链接为空'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        message.success('链接已复制');
      }).catch(() => {
        fallbackCopy(url);
      });
    } else {
      fallbackCopy(url);
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      message.success('链接已复制');
    } catch {
      message.error('复制失败，请手动复制');
    }
    document.body.removeChild(textarea);
  }

  async function deleteArticle(id, title) {
    Modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除文章「${title}」吗？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      async onOk() {
        try {
          await api.delete(`/articles/${id}`);
          message.success('删除成功');
          loadArticles();
          loadSources();
        } catch (err) {
          message.error('删除失败');
        }
      },
    });
  }

  function openFetchModal() {
    setPreviewStep(false);
    setCandidateList([]);
    setSelectedCandidates([]);
    setFetchModalOpen(true);
  }

  async function handlePreview() {
    if (enabledSources.length === 0) { message.warning('请至少选择一个来源'); return; }
    setFetchLoading(true);
    try {
      const payload = { sources: enabledSources, totalCount };
      const r = await api.post('/articles/preview', payload);
      if (r.data.total === 0) {
        message.info('没有可采集的新文章（所有文章可能已存在数据库中）');
        return;
      }
      setCandidateList(r.data.candidates);
      setSelectedCandidates(r.data.candidates.map((_, i) => i));
      setPreviewStep(true);
    } catch (err) { message.error('获取候选文章失败'); }
    finally { setFetchLoading(false); }
  }

  async function handleConfirm() {
    if (selectedCandidates.length === 0) { message.warning('请选择要添加的文章'); return; }
    setConfirmLoading(true);
    try {
      const toInsert = selectedCandidates.map(i => candidateList[i]);
      const r = await api.post('/articles/confirm', { articles: toInsert, category: newArticleCategory });
      const msg = r.data.skipped > 0
        ? `成功添加 ${r.data.inserted} 篇，${r.data.skipped} 篇因内容为空被跳过`
        : `成功添加 ${r.data.inserted} 篇文章`;
      r.data.skipped > 0 ? message.warning(msg) : message.success(msg);
      setFetchModalOpen(false);
      setPreviewStep(false);
      loadArticles();
      loadSources();
    } catch (err) { message.error('添加失败'); }
    finally { setConfirmLoading(false); }
  }

  function toggleCandidate(index, checked) {
    setSelectedCandidates(prev => checked ? [...prev, index] : prev.filter(i => i !== index));
  }

  function selectAllCandidates(checked) {
    setSelectedCandidates(checked ? candidateList.map((_, i) => i) : []);
  }

  function backToConfig() {
    setPreviewStep(false);
    setCandidateList([]);
    setSelectedCandidates([]);
  }

  function SortableHeader({ field, label, center = false }) {
    const isActive = sortField === field;
    return (
      <span style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: center ? 'center' : 'flex-start' }}
        onClick={() => { setSortOrder(isActive && sortOrder === 'desc' ? 'asc' : 'desc'); setSortField(field); setPage(1); }}>
        {label}
        {isActive && (sortOrder === 'desc' ? '↓' : '↑')}
      </span>
    );
  }

  const headerCellStyle = { textAlign: 'center', fontWeight: 600, background: '#fafafa', borderRight: '1px solid #e8e8e8' };
  const cellStyle = { borderRight: '1px solid #e8e8e8' };

  const columns = [
    { title: <div style={headerCellStyle}>序号</div>, dataIndex: '_index', key: 'index', width: 70, sortable: false, align: 'center', onHeaderCell: () => headerCellStyle, onCell: () => cellStyle },
    { title: <div style={headerCellStyle}><SortableHeader field="source" label="来源" center /></div>, dataIndex: 'source', key: 'source', width: 130, sortable: false, align: 'center', onHeaderCell: () => headerCellStyle, onCell: () => cellStyle, render: v => <Tag color="blue" style={{ margin: 0 }}>{v}</Tag> },
    { title: <div style={{...headerCellStyle, textAlign: 'left'}}><SortableHeader field="title" label="标题" /></div>, dataIndex: 'title', key: 'title', ellipsis: true, sortable: false, onHeaderCell: () => ({...headerCellStyle, textAlign: 'left'}), onCell: () => cellStyle },
    {
      title: <div style={headerCellStyle}>分类</div>, key: 'category', width: 100, sortable: false, align: 'center', onHeaderCell: () => headerCellStyle, onCell: () => cellStyle,
      render: (_, record) => {
        const categoryMap = { verbal: '言语', politics: '政治', both: '通用' };
        const colorMap = { verbal: 'blue', politics: 'red', both: 'green' };
        return (
          <Select
            size="small"
            value={record.category || 'both'}
            style={{ width: 80 }}
            onChange={async (value) => {
              try {
                await api.put(`/articles/${record.id}/category`, { category: value });
                message.success('分类已更新');
                loadArticles();
              } catch (err) {
                message.error('更新失败');
              }
            }}
            options={[
              { label: '言语', value: 'verbal' },
              { label: '政治', value: 'politics' },
              { label: '通用', value: 'both' }
            ]}
          />
        );
      }
    },
    { title: <div style={headerCellStyle}><SortableHeader field="author" label="作者" center /></div>, dataIndex: 'author', key: 'author', width: 90, sortable: false, align: 'center', onHeaderCell: () => headerCellStyle, onCell: () => cellStyle },
    { title: <div style={headerCellStyle}><SortableHeader field="publish_time" label="发布时间" center /></div>, dataIndex: 'publish_time', key: 'publish_time', width: 170, sortable: false, align: 'center', onHeaderCell: () => headerCellStyle, onCell: () => cellStyle, render: v => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    { title: <div style={headerCellStyle}><SortableHeader field="created_at" label="添加时间" center /></div>, dataIndex: 'created_at', key: 'created_at', width: 170, sortable: false, align: 'center', onHeaderCell: () => headerCellStyle, onCell: () => cellStyle, render: v => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    {
      title: <div style={{...headerCellStyle, borderRight: 'none'}}>操作</div>, key: 'action', width: 280, fixed: 'right', sortable: false, align: 'center', onHeaderCell: () => ({...headerCellStyle, borderRight: 'none'}),
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<EyeOutlined />} onClick={() => previewContent(record.id)}>预览</Button>
          <Button size="small" icon={<CopyOutlined />} onClick={() => copyLink(record.url)}>复制链接</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => deleteArticle(record.id, record.title)}>删除</Button>
        </Space>
      )
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 16 }}>文章来源管理</Title>
      <FlexTable
        columns={columns}
        dataSource={articles}
        rowKey="id"
        loading={loading}
        searchable
        searchPlaceholder="搜索标题/来源/作者"
        searchFields={['title', 'source', 'author']}
        pagination={{ current: page, total, pageSize: 15 }}
        onPageChange={setPage}
        extraToolbar={
          <Space>
            <Select allowClear placeholder="全部分类" style={{ width: 120 }} value={selectedCategory}
              onChange={v => { setSelectedCategory(v); setPage(1); }}
              options={[
                { label: '言语', value: 'verbal' },
                { label: '政治', value: 'politics' },
                { label: '通用', value: 'both' }
              ]} />
            <Select allowClear placeholder="全部来源" style={{ width: 160 }} value={selectedSource}
              onChange={v => { setSelectedSource(v); setPage(1); }}
              options={sources.map(s => ({ label: `${s.source} (${s.count})`, value: s.source }))} />
            <Button type="primary" icon={<DownloadOutlined />} onClick={openFetchModal}>采集文章</Button>
          </Space>
        }
      />

      {/* Article content preview */}
      <Modal title={previewArticle?.title || '文章预览'} open={!!previewArticle} onCancel={() => setPreviewArticle(null)}
        footer={[
          <Button key="close" onClick={() => setPreviewArticle(null)}>关闭</Button>,
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={() => copyLink(previewArticle?.url)}>复制链接</Button>
        ]} width={720}>
        {previewArticle && (
          <div>
            <Space style={{ marginBottom: 16 }}>
              <Tag color="blue">{previewArticle.source}</Tag>
              <Text type="secondary">{previewArticle.author}</Text>
            </Space>
            <Paragraph style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{previewArticle.clean_text}</Paragraph>
          </div>
        )}
      </Modal>

      {/* Fetch modal */}
      <Modal
        title={previewStep ? '确认添加文章' : '采集文章'}
        open={fetchModalOpen}
        onCancel={() => { setFetchModalOpen(false); setPreviewStep(false); }}
        width={640}
        footer={previewStep ? [
          <Button key="back" onClick={backToConfig}>返回</Button>,
          <Button key="cancel" onClick={() => { setFetchModalOpen(false); setPreviewStep(false); }}>取消</Button>,
          <Button key="confirm" type="primary" icon={<CheckCircleOutlined />} loading={confirmLoading} onClick={handleConfirm}
            disabled={selectedCandidates.length === 0}>
            确认添加 ({selectedCandidates.length})
          </Button>
        ] : [
          <Button key="cancel" onClick={() => setFetchModalOpen(false)}>取消</Button>,
          <Button key="preview" type="primary" icon={<EyeOutlined />} loading={fetchLoading} onClick={handlePreview}>
            预览候选文章
          </Button>
        ]}
      >
        {!previewStep ? (
          <div>
            <Paragraph type="secondary">选择文章来源和数量，系统将从真实网站抓取候选文章供你确认后再添加。</Paragraph>
            <Divider style={{ margin: '16px 0' }} />

            <div style={{ marginBottom: 16 }}>
              <Text strong>采集总数：</Text>
              <InputNumber min={1} max={50} value={totalCount} onChange={setTotalCount} style={{ width: 80, marginLeft: 8 }} />
              <Text type="secondary" style={{ marginLeft: 8 }}>篇</Text>
            </div>

            <div style={{ marginBottom: 16 }}>
              <Text strong>文章分类：</Text>
              <Select
                value={newArticleCategory}
                onChange={setNewArticleCategory}
                style={{ width: 120, marginLeft: 8 }}
                options={[
                  { label: '通用', value: 'both' },
                  { label: '言语', value: 'verbal' },
                  { label: '政治', value: 'politics' }
                ]}
              />
              <Text type="secondary" style={{ marginLeft: 8 }}>（采集后的文章默认分类）</Text>
            </div>

            <Divider style={{ margin: '12px 0' }} />
            <Text strong style={{ marginBottom: 12, display: 'block' }}>选择来源渠道：</Text>

            {AVAILABLE_SOURCES.map(src => (
              <div key={src.id} style={{ padding: '8px 0' }}>
                <Checkbox checked={enabledSources.includes(src.id)} onChange={e => setEnabledSources(prev => e.target.checked ? [...prev, src.id] : prev.filter(s => s !== src.id))}>
                  <Text strong>{src.name}</Text>
                </Checkbox>
                <div style={{ color: '#999', fontSize: 12, marginLeft: 24 }}>{src.desc}</div>
              </div>
            ))}
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text>共 {candidateList.length} 篇候选文章</Text>
              <Checkbox checked={selectedCandidates.length === candidateList.length} onChange={e => selectAllCandidates(e.target.checked)}>全选</Checkbox>
            </div>
            {candidateList.length === 0 ? (
              <Empty description="没有新文章可添加" />
            ) : (
              <div style={{ maxHeight: 400, overflow: 'auto' }}>
                <List
                  dataSource={candidateList}
                  renderItem={(item, idx) => (
                    <List.Item style={{ padding: '8px 0' }}>
                      <Checkbox checked={selectedCandidates.includes(idx)} onChange={e => toggleCandidate(idx, e.target.checked)} style={{ marginRight: 12 }} />
                      <div style={{ flex: 1 }}>
                        <div>
                          <Tag color="blue" style={{ marginRight: 8 }}>{item.source}</Tag>
                          <Text strong>{item.title}</Text>
                        </div>
                        <Text type="secondary" style={{ fontSize: 12 }}>{item.text}</Text>
                      </div>
                    </List.Item>
                  )}
                />
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
