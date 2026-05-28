import React from 'react';
import { Typography, Card, Row, Col, Button, Space } from 'antd';
import { EditOutlined, HistoryOutlined, ReadOutlined, SafetyOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Home() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();

  const features = [
    { icon: <ReadOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '权威来源', desc: '题目基于人民日报、新华社等权威内容生成' },
    { icon: <EditOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '智能练习', desc: '支持言语理解等模块，随机出题自主练习' },
    { icon: <HistoryOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '答题历史', desc: '记录每次答题数据，分析薄弱环节' },
    { icon: <SafetyOutlined style={{ fontSize: 36, color: '#1D4ED8' }} />, title: '数据安全', desc: '个人数据隔离存储，答题记录仅自己可见' },
  ];

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ textAlign: 'center', padding: '48px 0 32px' }}>
        <Typography.Title level={2} style={{ marginBottom: 8 }}>
          公务员考试刷题系统
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ fontSize: 16 }}>
          基于权威素材的智能命题与练习平台
        </Typography.Paragraph>
        <Space size="middle" style={{ marginTop: 24 }}>
          {isAuthenticated ? (
            <Button type="primary" size="large" onClick={() => navigate('/practice')}>开始练习</Button>
          ) : (
            <>
              <Button type="primary" size="large" onClick={() => navigate('/register')}>免费注册</Button>
              <Button size="large" onClick={() => navigate('/login')}>登录</Button>
            </>
          )}
        </Space>
      </div>
      <Row gutter={[24, 24]} style={{ marginTop: 24 }}>
        {features.map((f) => (
          <Col xs={24} sm={12} key={f.title}>
            <Card hoverable style={{ height: '100%' }}>
              <Space align="start" size="middle">
                {f.icon}
                <div>
                  <Typography.Title level={4} style={{ marginBottom: 4 }}>{f.title}</Typography.Title>
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>{f.desc}</Typography.Paragraph>
                </div>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}