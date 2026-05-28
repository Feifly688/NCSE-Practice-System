import React from 'react';
import { Button, Typography } from 'antd';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ textAlign: 'center', padding: '80px 24px' }}>
          <Typography.Title style={{ color: '#ff4d4f' }}>出错了</Typography.Title>
          <Typography.Text type="secondary">
            {this.state.error?.message || '页面渲染异常'}
          </Typography.Text>
          <div style={{ marginTop: 24 }}>
            <Button type="primary" onClick={() => { this.setState({ hasError: false, error: null }); window.location.href = '/'; }}>
              返回首页
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
