import React, { useState, useEffect } from 'react';
import { Layout, Menu, Button, Drawer, Space, Typography } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { FileTextOutlined, UserOutlined, ThunderboltOutlined, ArrowLeftOutlined, ReadOutlined, MenuOutlined, TrophyOutlined } from '@ant-design/icons';
import { useResponsive } from '../hooks/useResponsive';

const { Sider, Content } = Layout;

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useResponsive();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  const menuItems = [
    { key: '/admin', icon: <FileTextOutlined />, label: '管理首页' },
    { key: '/admin/questions', icon: <FileTextOutlined />, label: '题目管理' },
    { key: '/admin/articles', icon: <ReadOutlined />, label: '文章来源' },
    { key: '/admin/users', icon: <UserOutlined />, label: '用户管理' },
    { key: '/admin/generate', icon: <ThunderboltOutlined />, label: '题目生成' },
    { key: '/admin/exam-papers', icon: <TrophyOutlined />, label: '真题管理' },
    { type: 'divider' },
    { key: '/dashboard', icon: <ArrowLeftOutlined />, label: '返回前台' },
  ];

  const navMenu = (
    <Menu
      mode="inline"
      selectedKeys={[location.pathname]}
      items={menuItems}
      onClick={({ key }) => navigate(key)}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {isMobile ? (
        <>
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 12px', background: '#fff',
              borderBottom: '1px solid #f0f0f0',
              position: 'sticky', top: 0, zIndex: 100,
              paddingTop: 'calc(10px + env(safe-area-inset-top))',
            }}
          >
            <Button type="text" icon={<MenuOutlined />} onClick={() => setDrawerOpen(true)} aria-label="打开菜单" />
            <Typography.Text strong>管理后台</Typography.Text>
          </div>
          <Drawer
            title="管理后台"
            placement="left"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            width={260}
            styles={{ body: { padding: 0 } }}
          >
            {navMenu}
          </Drawer>
        </>
      ) : (
        <Sider width={220} theme="light" style={{ borderRight: '1px solid #f0f0f0' }}>
          <div style={{ padding: '16px 24px', fontWeight: 700, fontSize: 16 }}>
            管理后台
          </div>
          {navMenu}
        </Sider>
      )}

      <Content style={{ padding: isMobile ? '12px' : 24, background: '#f5f5f5' }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
