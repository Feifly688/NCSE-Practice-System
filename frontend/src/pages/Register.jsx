import React from 'react';
import { Form, Input, Button, Typography, message } from 'antd';
import { MailOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { GlowCard } from '../components/ui/spotlight-card';

export default function Register() {
  const navigate = useNavigate();
  const { register, loading } = useAuth();
  const [form] = Form.useForm();

  async function onFinish(values) {
    try {
      await register(values.email, values.password, values.nickname);
      message.success('注册成功');
      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || '注册失败';
      message.error(msg);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <div style={{ width: 420 }}>
        <GlowCard glowColor="green" customSize className="!h-auto !w-full !p-8 !grid !grid-rows-none">
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>注册</Typography.Title>
            <Typography.Text type="secondary">创建账号，开始练习</Typography.Text>
          </div>
          <Form form={form} layout="vertical" onFinish={onFinish} autoComplete="off" size="large">
            <Form.Item name="nickname" rules={[{ required: true, message: '请输入昵称' }]} style={{ marginBottom: 20 }}>
              <Input prefix={<UserOutlined />} placeholder="昵称" style={{ borderRadius: 8 }} />
            </Form.Item>
            <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]} style={{ marginBottom: 20 }}>
              <Input prefix={<MailOutlined />} placeholder="邮箱" style={{ borderRadius: 8 }} />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少6位' }]} style={{ marginBottom: 24 }}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码（至少6位）" style={{ borderRadius: 8 }} />
            </Form.Item>
            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" loading={loading} block size="large" style={{ borderRadius: 8, height: 44, fontWeight: 600, background: '#059669', border: 'none' }}>注册</Button>
            </Form.Item>
          </Form>
          <div style={{ textAlign: 'center' }}>
            <Typography.Text type="secondary">已有账号？</Typography.Text>
            <Link to="/login" style={{ fontWeight: 600 }}>去登录</Link>
          </div>
        </GlowCard>
      </div>
    </div>
  );
}
