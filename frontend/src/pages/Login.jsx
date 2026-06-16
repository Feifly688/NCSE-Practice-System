import React from 'react';
import { Form, Input, Button, Typography, message, Space } from 'antd';
import { MailOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { GlowCard } from '../components/ui/spotlight-card';

export default function Login() {
  const navigate = useNavigate();
  const { login, loading } = useAuth();
  const [form] = Form.useForm();

  async function onFinish(values) {
    try {
      await login(values.email, values.password);
      message.success('登录成功');
      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || '登录失败';
      message.error(msg);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <div style={{ width: 420 }}>
        <GlowCard glowColor="blue" customSize className="!h-auto !w-full !p-8 !grid !grid-rows-none">
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>登录</Typography.Title>
            <Typography.Text type="secondary">欢迎回来，请登录你的账号</Typography.Text>
          </div>
          <Form form={form} layout="vertical" onFinish={onFinish} autoComplete="off" size="large">
            <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]} style={{ marginBottom: 20 }}>
              <Input prefix={<MailOutlined />} placeholder="邮箱" style={{ borderRadius: 8 }} />
            </Form.Item>
            <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]} style={{ marginBottom: 24 }}>
              <Input.Password prefix={<LockOutlined />} placeholder="密码" style={{ borderRadius: 8 }} />
            </Form.Item>
            <Form.Item style={{ marginBottom: 16 }}>
              <Button type="primary" htmlType="submit" loading={loading} block size="large" style={{ borderRadius: 8, height: 44, fontWeight: 600 }}>登录</Button>
            </Form.Item>
          </Form>
          <div style={{ textAlign: 'center' }}>
            <Typography.Text type="secondary">还没有账号？</Typography.Text>
            <Link to="/register" style={{ fontWeight: 600 }}>立即注册</Link>
          </div>
        </GlowCard>
      </div>
    </div>
  );
}
