import React, { useState } from 'react';
import { Button, Input, Space, Typography } from 'antd';

const { Text } = Typography;

export default function Pagination({ current, total, pageSize, onChange }) {
  const [jumpPage, setJumpPage] = useState('');
  const totalPages = Math.ceil(total / pageSize);

  if (total <= pageSize) return null;

  function getPageNumbers() {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = [];
    if (current <= 4) {
      pages.push(1, 2, 3, 4, 5, '...', totalPages);
    } else if (current >= totalPages - 3) {
      pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', current - 1, current, current + 1, '...', totalPages);
    }
    return pages;
  }

  return (
    <div style={{ marginTop: 12, padding: '12px 16px', background: '#fafafa', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <Text type="secondary">共 {total} 条</Text>
      <Space size={4} align="center">
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
        <span style={{ marginLeft: 8, fontSize: 13 }}>
          跳至 <Input size="small" style={{ width: 50, textAlign: 'center' }} value={jumpPage}
            onChange={e => setJumpPage(e.target.value.replace(/\D/g, ''))}
            onPressEnter={() => { const p = parseInt(jumpPage); if (p >= 1 && p <= totalPages) { onChange(p); setJumpPage(''); } }} />
          页
        </span>
      </Space>
    </div>
  );
}
