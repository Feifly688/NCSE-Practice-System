import React from 'react';
import { Layout, Menu } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { FileTextOutlined, UserOutlined, ThunderboltOutlined, ArrowLeftOutlined, ReadOutlined } from '@ant-design/icons';

const { Sider, Content } = Layout;

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const menuItems = [
    { key: '/admin', icon: <FileTextOutlined />, label: '管理首页' },
    { key: '/admin/questions', icon: <FileTextOutlined />, label: '题目管理' },
    { key: '/admin/articles', icon: <ReadOutlined />, label: '文章来源' },
    { key: '/admin/users', icon: <UserOutlined />, label: '用户管理' },
    { key: '/admin/generate', icon: <ThunderboltOutlined />, label: '题目生成' },
    { type: 'divider' },
    { key: '/dashboard', icon: <ArrowLeftOutlined />, label: '返回前台' },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '16px 24px', fontWeight: 700, fontSize: 16 }}>
          管理后台
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Content style={{ padding: 24, background: '#f5f5f5' }}>
        <Outlet />
      </Content>
    </Layout>
  );
}