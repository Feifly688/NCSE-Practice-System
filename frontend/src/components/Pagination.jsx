import React, { useState } from 'react';
import { Button, Input, Space, Typography } from 'antd';
import { useResponsive } from '../hooks/useResponsive';

const { Text } = Typography;

export default function Pagination({ current, total, pageSize, onChange }) {
  const [jumpPage, setJumpPage] = useState('');
  const { isMobile } = useResponsive();
  const totalPages = Math.ceil(total / pageSize);

  if (total <= pageSize) return null;

  // 移动端页码显示更少，避免换行
  const getPageNumbers = () => {
    const maxVisible = isMobile ? 3 : 7;
    if (totalPages <= maxVisible) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = [];
    if (current <= 4) {
      pages.push(1, 2, 3, 4, 5, '...', totalPages);
    } else if (current >= totalPages - 3) {
      pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', current - 1, current, current + 1, '...', totalPages);
    }
    if (isMobile) {
      // 移动端只保留首尾和当前附近
      return [pages[0], '...', current, '...', pages[pages.length - 1]].filter(
        (v, i, arr) => v === '...' || arr.indexOf(v) === i
      );
    }
    return pages;
  };

  return (
    <div style={{
      marginTop: 12, padding: isMobile ? '10px 12px' : '12px 16px',
      background: '#fafafa', borderRadius: 8,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      flexWrap: 'wrap', gap: 8,
    }}>
      <Text type="secondary" style={{ fontSize: isMobile ? 12 : 14 }}>共 {total} 条</Text>
      <Space size={4} align="center" wrap>
        <Button size="small" disabled={current <= 1} onClick={() => onChange(current - 1)}>上一页</Button>
        {getPageNumbers().map((p, i) =>
          p === '...' ? (
            <span key={'d' + i} style={{ padding: '0 4px', color: '#999' }}>...</span>
          ) : (
            <Button key={p} size="small" type={p === current ? 'primary' : 'default'}
              onClick={() => onChange(p)}>{p}</Button>
          )
        )}
        <Button size="small" disabled={current >= totalPages} onClick={() => onChange(current + 1)}>下一页</Button>
        {!isMobile && (
          <span style={{ marginLeft: 8, fontSize: 13 }}>
            跳至 <Input size="small" style={{ width: 50, textAlign: 'center' }} value={jumpPage}
              onChange={e => setJumpPage(e.target.value.replace(/\D/g, ''))}
              onPressEnter={() => { const p = parseInt(jumpPage); if (p >= 1 && p <= totalPages) { onChange(p); setJumpPage(''); } }} />
            页
          </span>
        )}
      </Space>
    </div>
  );
}
