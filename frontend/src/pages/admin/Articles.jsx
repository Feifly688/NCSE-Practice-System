import React, { useState, useEffect } from 'react';
import { Typography, Tag, Button, Select, Modal, message, InputNumber, Checkbox, Divider, Space, List, Empty, Spin } from 'antd';
import { EyeOutlined, DownloadOutlined, CheckCircleOutlined, CopyOutlined, DeleteOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import FlexTable from '../../components/FlexTable';
import api from '../../services/api';

const { Title, Paragraph, Text } = Typography;

const AVAILABLE_SOURCES = [
  { id: 'people', name: '人民日报·评论', desc: '人民网观点频道评论文章' },
  { id: 'xinhua', name: '新华社·时政', desc: '新华网时政频道新闻' },
  { id: 'people_economy', name: '人民网·经济', desc: '人民网经济频道新闻' },
  { id: 'xinhua_world', name: '新华社·国际', desc: '新华网国际频道新闻' },
];

export default function Articles() {
  const [loading, setLoading] = useState(true);
  const [articles, setArticles] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
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

  useEffect(() => { loadSources(); }, []);
  useEffect(() => { loadArticles(); }, [page, selectedSource, sortField, sortOrder]);

  async function loadSources() {
    try { const r = await api.get('/articles/sources'); setSources(r.data.sources); } catch (_) {}
  }

  async function loadArticles() {
    setLoading(true);
    try {
      const params = { page, pageSize: 15, sortField, sortOrder };
      if (selectedSource) params.source = selectedSource;
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
      const r = await api.post('/articles/confirm', { articles: toInsert });
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

  function SortableHeader({ field, label, width }) {
    const isActive = sortField === field;
    return (
      <span style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => { setSortOrder(isActive && sortOrder === 'desc' ? 'asc' : 'desc'); setSortField(field); setPage(1); }}>
        {label} {isActive && (sortOrder === 'desc' ? '↓' : '↑')}
      </span>
    );
  }

  const columns = [
    { title: '序号', dataIndex: '_index', key: 'index', width: 60, sortable: false, align: 'center' },
    { title: <SortableHeader field="source" label="来源" />, dataIndex: 'source', key: 'source', width: 120, sortable: false, align: 'center', render: v => <Tag color="blue">{v}</Tag> },
    { title: <SortableHeader field="title" label="标题" />, dataIndex: 'title', key: 'title', ellipsis: true, sortable: false },
    { title: <SortableHeader field="author" label="作者" />, dataIndex: 'author', key: 'author', width: 80, sortable: false, align: 'center' },
    { title: <SortableHeader field="publish_time" label="发布时间" />, dataIndex: 'publish_time', key: 'publish_time', width: 160, sortable: false, align: 'center', render: v => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    { title: <SortableHeader field="created_at" label="添加时间" />, dataIndex: 'created_at', key: 'created_at', width: 160, sortable: false, align: 'center', render: v => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    {
      title: '操作', key: 'action', width: 240, fixed: 'right', sortable: false, align: 'center',
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
