import React from 'react';
import { Button, Typography } from 'antd';
import { HomeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';

const { Title, Text } = Typography;

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div style={{ textAlign: 'center', padding: '80px 0' }}>
      <Title style={{ fontSize: 72, color: '#ccc', margin: 0 }}>404</Title>
      <Text type="secondary" style={{ fontSize: 16 }}>页面不存在</Text>
      <div style={{ marginTop: 24 }}>
        <Button type="primary" icon={<HomeOutlined />} onClick={() => navigate('/')}>返回首页</Button>
      </div>
    </div>
  );
}
