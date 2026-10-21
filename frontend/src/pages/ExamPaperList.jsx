import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, List, Tag, Button, Empty, Spin, Typography, message } from 'antd';
import { FileTextOutlined, RightOutlined } from '@ant-design/icons';
import api from '../services/api';
import { useResponsive } from '../hooks/useResponsive';

const { Title, Text } = Typography;

/** 用户端：可作答的整卷列表 */
export default function ExamPaperList() {
  const navigate = useNavigate();
  const { isMobile } = useResponsive();
  const [loading, setLoading] = useState(true);
  const [papers, setPapers] = useState([]);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/exam-papers', { params: { page: 1, pageSize: 50 } });
      setPapers(r.data.papers || []);
    } catch (err) {
      message.error('加载真题列表失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>整卷真题</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        按完整试卷形态在线作答，交卷后查看分数、答案与解析
      </Text>

      <Card style={{ borderRadius: 12 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}><Spin /></div>
        ) : papers.length === 0 ? (
          <Empty description="暂无可作答的整卷真题" />
        ) : (
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
                      width: 40, height: 40, borderRadius: 10, background: '#eff6ff',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1D4ED8',
                    }}>
                      <FileTextOutlined />
                    </div>
                  }
                  title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 600 }}>{p.title}</span>
                      {p.year && <Tag>{p.year}</Tag>}
                      <Tag color={p.origin === 'crawl' ? 'cyan' : 'purple'}>
                        {p.origin === 'crawl' ? '爬取' : 'PDF上传'}
                      </Tag>
                      {p.parse_status === 'partial' && <Tag color="warning">部分拆分</Tag>}
                    </div>
                  }
                  description={
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      共 {p.parsed_count} 题{isMobile ? '' : ` · 来源：${p.source || '—'}`}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
