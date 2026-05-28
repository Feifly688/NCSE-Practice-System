import React, { useState, useEffect } from 'react';
import { Typography, Card, Button, Select, Modal, message, InputNumber, Checkbox, Divider, Space, List, Empty, Spin, Tag, Table, Radio } from 'antd';
import { ThunderboltOutlined, EyeOutlined, CheckCircleOutlined, ExperimentOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Title, Paragraph, Text } = Typography;

export default function Generate() {
  const [articles, setArticles] = useState([]);
  const [selectedArticles, setSelectedArticles] = useState([]);
  const [questionsPerArticle, setQuestionsPerArticle] = useState(2);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [previewQuestions, setPreviewQuestions] = useState([]);
  const [selectedQuestions, setSelectedQuestions] = useState([]);
  const [previewStep, setPreviewStep] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [showGenerated, setShowGenerated] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const pageSize = 10;

  useEffect(() => { loadArticles(); }, [showGenerated]);

  async function loadArticles() {
    setLoading(true);
    try {
      const params = { pageSize: 200 };
      if (showGenerated) {
        params.filterGenerated = 'true';
      }
      const r = await api.get('/articles', { params });
      setArticles(r.data.articles);
    } catch (err) {
      message.error('加载文章失败');
    } finally {
      setLoading(false);
    }
  }

  async function testConnection() {
    setTestStatus('testing');
    try {
      const r = await api.post('/generate/test');
      if (r.data.success) {
        setTestStatus('success');
        message.success('AI连接成功');
      } else {
        setTestStatus('failed');
        message.error('AI连接失败: ' + r.data.error);
      }
    } catch (err) {
      setTestStatus('failed');
      message.error('AI连接失败: ' + (err.response?.data?.error || err.message));
    }
  }

  function getCurrentPageArticleIds() {
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    return articles.slice(start, end)
      .filter(a => a.question_count === 0)
      .map(a => a.id);
  }

  function selectCurrentPage(checked) {
    const currentPageIds = getCurrentPageArticleIds();
    if (checked) {
      setSelectedArticles(prev => {
        const newSelected = [...prev];
        currentPageIds.forEach(id => {
          if (!newSelected.includes(id)) {
            newSelected.push(id);
          }
        });
        return newSelected;
      });
    } else {
      setSelectedArticles(prev => prev.filter(id => !currentPageIds.includes(id)));
    }
  }

  function isCurrentPageAllSelected() {
    const currentPageIds = getCurrentPageArticleIds();
    return currentPageIds.length > 0 && currentPageIds.every(id => selectedArticles.includes(id));
  }

  function openGenerateModal() {
    if (selectedArticles.length === 0) {
      message.warning('请先选择要生成题目的文章');
      return;
    }
    setPreviewStep(false);
    setPreviewQuestions([]);
    setSelectedQuestions([]);
    setModalOpen(true);
  }

  async function handleGenerate() {
    setGenerating(true);
    try {
      const r = await api.post('/generate/preview', {
        articleIds: selectedArticles,
        questionsPerArticle
      });
      
      if (r.data.total === 0) {
        message.info('未能生成任何题目，请检查文章内容或重试');
        return;
      }
      
      setPreviewQuestions(r.data.questions);
      setSelectedQuestions(r.data.questions.map((_, i) => i));
      setPreviewStep(true);
      message.success(`成功生成 ${r.data.total} 道题目`);
    } catch (err) {
      message.error('生成题目失败: ' + (err.response?.data?.error || err.message));
    } finally {
      setGenerating(false);
    }
  }

  async function handleConfirm() {
    if (selectedQuestions.length === 0) {
      message.warning('请选择要保存的题目');
      return;
    }
    setConfirmLoading(true);
    try {
      const toSave = selectedQuestions.map(i => previewQuestions[i]);
      const r = await api.post('/generate/confirm', { questions: toSave });
      message.success(`成功保存 ${r.data.inserted} 道题目`);
      setModalOpen(false);
      setPreviewStep(false);
      setSelectedArticles([]);
      loadArticles();
    } catch (err) {
      message.error('保存失败: ' + (err.response?.data?.error || err.message));
    } finally {
      setConfirmLoading(false);
    }
  }

  function toggleQuestion(index, checked) {
    setSelectedQuestions(prev => checked ? [...prev, index] : prev.filter(i => i !== index));
  }

  function selectAllQuestions(checked) {
    setSelectedQuestions(checked ? previewQuestions.map((_, i) => i) : []);
  }

  function showQuestionDetail(record) {
    setCurrentQuestion(record);
    setDetailModalOpen(true);
  }

  const columns = [
    {
      title: () => (
        <Checkbox
          checked={isCurrentPageAllSelected()}
          indeterminate={selectedArticles.length > 0 && !isCurrentPageAllSelected() && getCurrentPageArticleIds().some(id => selectedArticles.includes(id))}
          onChange={e => selectCurrentPage(e.target.checked)}
        />
      ),
      width: 50,
      render: (_, record) => {
        const hasGenerated = record.question_count > 0;
        return (
          <Checkbox
            checked={selectedArticles.includes(record.id)}
            disabled={hasGenerated}
            onChange={e => {
              setSelectedArticles(prev =>
                e.target.checked ? [...prev, record.id] : prev.filter(id => id !== record.id)
              );
            }}
          />
        );
      }
    },
    { title: '来源', dataIndex: 'source', width: 120, render: v => <Tag color="blue">{v}</Tag> },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    { 
      title: '状态', 
      width: 100,
      render: (_, record) => record.question_count > 0 ? (
        <Tag color="green">已出题 ({record.question_count})</Tag>
      ) : (
        <Tag color="default">未出题</Tag>
      )
    },
    { title: '发布时间', dataIndex: 'publish_time', width: 120, render: v => v ? new Date(v).toLocaleString('zh-CN') : '-' },
  ];

  const questionColumns = [
    {
      title: '选择',
      width: 50,
      render: (_, __, idx) => (
        <Checkbox
          checked={selectedQuestions.includes(idx)}
          onChange={e => toggleQuestion(idx, e.target.checked)}
        />
      )
    },
    { title: '题型', dataIndex: 'qtype', width: 100, render: v => <Tag color="purple">{v}</Tag> },
    { title: '难度', dataIndex: 'difficulty', width: 80, render: v => <Tag color={v <= 2 ? 'green' : v <= 4 ? 'orange' : 'red'}>{v <= 2 ? '简单' : v <= 4 ? '中等' : '困难'}</Tag> },
    { title: '题干', dataIndex: 'stem', ellipsis: true },
    { title: '答案', dataIndex: 'answer', width: 60 },
    { title: '来源文章', dataIndex: 'source_article_title', width: 150, ellipsis: true },
    {
      title: '操作',
      width: 70,
      render: (_, record) => (
        <Button type="link" size="small" icon={<EyeOutlined />} onClick={() => showQuestionDetail(record)}>
          查看
        </Button>
      )
    },
  ];

  const nonGeneratedCount = articles.filter(a => a.question_count === 0).length;

  return (
    <div>
      <Title level={3} style={{ marginBottom: 16 }}>题目生成</Title>
      
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Space>
            <Text strong>AI状态：</Text>
            {testStatus === 'success' ? (
              <Tag color="green">已连接</Tag>
            ) : testStatus === 'failed' ? (
              <Tag color="red">连接失败</Tag>
            ) : (
              <Tag color="default">未测试</Tag>
            )}
            <Button icon={<ExperimentOutlined />} onClick={testConnection} size="small">
              测试连接
            </Button>
          </Space>
          <Space>
            <Text>每篇文章生成题数：</Text>
            <InputNumber min={1} max={5} value={questionsPerArticle} onChange={setQuestionsPerArticle} style={{ width: 70 }} />
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={openGenerateModal}
              disabled={selectedArticles.length === 0}
            >
              生成题目 ({selectedArticles.length}篇)
            </Button>
          </Space>
        </div>
        
        <Divider style={{ margin: '12px 0' }} />
        
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space>
            <Text type="secondary">
              未出题文章：{nonGeneratedCount} 篇 | 已选：{selectedArticles.length} 篇
            </Text>
            <Checkbox checked={showGenerated} onChange={e => setShowGenerated(e.target.checked)}>
              显示已出题文章
            </Checkbox>
          </Space>
          <Space>
            <Button size="small" onClick={() => {
              const ids = articles.filter(a => a.question_count === 0).map(a => a.id);
              setSelectedArticles(ids);
            }}>全选未出题</Button>
            <Button size="small" onClick={() => setSelectedArticles([])}>取消全选</Button>
          </Space>
        </div>
        
        <Table
          columns={columns}
          dataSource={articles}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{
            pageSize,
            current: currentPage,
            onChange: (page) => setCurrentPage(page)
          }}
          scroll={{ y: 400 }}
          rowClassName={record => record.question_count > 0 ? 'generated-row' : ''}
        />
      </Card>

      {/* Generate Modal */}
      <Modal
        title={previewStep ? '预览生成的题目' : '确认生成'}
        open={modalOpen}
        onCancel={() => { setModalOpen(false); setPreviewStep(false); }}
        width={900}
        footer={previewStep ? [
          <Button key="back" onClick={() => setPreviewStep(false)}>返回</Button>,
          <Button key="cancel" onClick={() => { setModalOpen(false); setPreviewStep(false); }}>取消</Button>,
          <Button key="confirm" type="primary" icon={<CheckCircleOutlined />} loading={confirmLoading} onClick={handleConfirm}
            disabled={selectedQuestions.length === 0}>
            保存选中题目 ({selectedQuestions.length})
          </Button>
        ] : [
          <Button key="cancel" onClick={() => setModalOpen(false)}>取消</Button>,
          <Button key="generate" type="primary" icon={<ThunderboltOutlined />} loading={generating} onClick={handleGenerate}>
            开始生成
          </Button>
        ]}
      >
        {!previewStep ? (
          <div>
            <Paragraph>
              将为选中的 <Text strong>{selectedArticles.length}</Text> 篇文章生成题目，
              每篇文章生成 <Text strong>{questionsPerArticle}</Text> 道题。
            </Paragraph>
            <Paragraph type="secondary">
              提示：生成过程需要调用AI接口，每篇文章大约需要30-60秒，请耐心等待。
            </Paragraph>
          </div>
        ) : (
          <div>
            <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text>共生成 {previewQuestions.length} 道题目</Text>
              <Checkbox
                checked={selectedQuestions.length === previewQuestions.length}
                onChange={e => selectAllQuestions(e.target.checked)}
              >
                全选
              </Checkbox>
            </div>
            
            {previewQuestions.length === 0 ? (
              <Empty description="没有生成任何题目" />
            ) : (
              <Table
                columns={questionColumns}
                dataSource={previewQuestions.map((q, i) => ({ ...q, key: i }))}
                size="small"
                pagination={false}
                scroll={{ y: 400 }}
              />
            )}
          </div>
        )}
      </Modal>

      {/* Question Detail Modal */}
      <Modal
        title="题目详情"
        open={detailModalOpen}
        onCancel={() => setDetailModalOpen(false)}
        footer={<Button onClick={() => setDetailModalOpen(false)}>关闭</Button>}
        width={700}
      >
        {currentQuestion && (
          <div>
            <div style={{ marginBottom: 16 }}>
              <Space>
                <Tag color="purple">{currentQuestion.qtype}</Tag>
                <Tag color={currentQuestion.difficulty <= 2 ? 'green' : currentQuestion.difficulty <= 4 ? 'orange' : 'red'}>
                  {currentQuestion.difficulty <= 2 ? '简单' : currentQuestion.difficulty <= 4 ? '中等' : '困难'}
                </Tag>
                <Text type="secondary">答案：{currentQuestion.answer}</Text>
              </Space>
            </div>

            <Card size="small" style={{ marginBottom: 16, background: '#f6f6f6' }}>
              <Paragraph style={{ margin: 0 }}>
                <Text strong>题干：</Text>{currentQuestion.stem}
              </Paragraph>
            </Card>

            {currentQuestion.passage && (
              <Card size="small" style={{ marginBottom: 16 }}>
                <Paragraph style={{ margin: 0 }}>
                  <Text strong>材料：</Text>{currentQuestion.passage}
                </Paragraph>
              </Card>
            )}

            <div style={{ marginBottom: 16 }}>
              <Text strong>选项：</Text>
              <div style={{ marginTop: 8 }}>
                {currentQuestion.options?.map((opt, i) => (
                  <div key={i} style={{ 
                    marginBottom: 8, 
                    padding: '8px 12px',
                    borderRadius: 4,
                    background: String.fromCharCode(65 + i) === currentQuestion.answer ? '#f6ffed' : '#fff',
                    border: String.fromCharCode(65 + i) === currentQuestion.answer ? '1px solid #b7eb8f' : '1px solid #f0f0f0'
                  }}>
                    <Text type={String.fromCharCode(65 + i) === currentQuestion.answer ? 'success' : undefined}>
                      <Text strong>{String.fromCharCode(65 + i)}.</Text> {opt}
                      {String.fromCharCode(65 + i) === currentQuestion.answer && ' ✓'}
                    </Text>
                  </div>
                ))}
              </div>
            </div>

            <Card size="small" style={{ background: '#fffbe6', border: '1px solid #ffe58f' }}>
              <Paragraph style={{ margin: 0 }}>
                <Text strong>解析：</Text>{currentQuestion.explanation}
              </Paragraph>
            </Card>
          </div>
        )}
      </Modal>

      <style>{`
        .generated-row {
          background-color: #f6ffed;
        }
      `}</style>
    </div>
  );
}