import React, { useState, useEffect } from 'react';
import { Typography, Card, Row, Col, Statistic, Spin, Space, Button, message } from 'antd';
import { FileTextOutlined, UserOutlined, ReadOutlined, CheckCircleOutlined, ClockCircleOutlined, EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';

export default function AdminHome() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);

  useEffect(() => { loadStats(); }, []);

  async function loadStats() {
    try {
      const r = await api.get('/admin/stats');
      setStats(r.data);
    } catch (err) {
      message.error('加载管理统计失败');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 100 }}><Spin size="large" /></div>;

  const q = stats?.questions || {};
  const u = stats?.users || {};
  const a = stats?.articles || {};
  const s = stats?.sessions || {};

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>管理后台</Typography.Title>
        <Space>
          <Button onClick={() => navigate('/admin/generate')}>生成题目</Button>
          <Button onClick={() => navigate('/admin/articles')}>文章管理</Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6}>
          <Card hoverable onClick={() => navigate('/admin/questions')}><Statistic title="题目总数" value={q.total || 0} prefix={<FileTextOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card><Statistic title="已审核" value={q.approved || 0} prefix={<CheckCircleOutlined />} valueStyle={{ color: '#52c41a' }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card><Statistic title="待审核" value={q.pending || 0} prefix={<ClockCircleOutlined />} valueStyle={{ color: '#faad14' }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card hoverable onClick={() => navigate('/admin/articles')}><Statistic title="文章数" value={a.total || 0} prefix={<ReadOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card hoverable onClick={() => navigate('/admin/users')}><Statistic title="用户数" value={u.total || 0} prefix={<UserOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card hoverable onClick={() => navigate("/admin/users")}><Statistic title="管理员" value={u.admins || 0} prefix={<UserOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <Card hoverable onClick={() => navigate('/history')}><Statistic title="练习次数" value={s.total || 0} prefix={<EditOutlined />} /></Card>
        </Col>
      </Row>
    </div>
  );
}
