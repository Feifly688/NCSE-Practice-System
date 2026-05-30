import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Space, Button, Select, Input, Empty, Typography, Tooltip } from 'antd';
import { ReloadOutlined, ColumnWidthOutlined, CaretUpOutlined, CaretDownOutlined } from '@ant-design/icons';

const { Text } = Typography;

const HEIGHT_PRESETS = {
  compact: { padding: '6px 12px' },
  default: { padding: '12px 16px' },
  loose: { padding: '16px 16px' },
};

export default function FlexTable({
  columns: columnDefs,
  dataSource,
  rowKey = 'id',
  loading = false,
  searchable = false,
  searchPlaceholder = '搜索...',
  searchFields = [],
  pagination = null,
  onPageChange,
  onSort,
  sortKey: controlledSortKey,
  sortOrder: controlledSortOrder,
  extraToolbar = null,
  defaultHeight = 'default',
  defaultSortKey = null,
  defaultSortOrder = 'asc',
}) {
  const [colWidths, setColWidths] = useState(() => {
    const w = {};
    columnDefs.forEach(c => { w[c.key] = c.width || c.defaultWidth || 120; });
    return w;
  });
  const [rowHeight, setRowHeight] = useState(defaultHeight);
  const [searchText, setSearchText] = useState('');
  const [resized, setResized] = useState(false);
  const [internalSortKey, setInternalSortKey] = useState(defaultSortKey);
  const [internalSortOrder, setInternalSortOrder] = useState(defaultSortOrder);
  const [jumpPage, setJumpPage] = useState('');

  // 有 onSort 时用父组件的排序状态，否则用内部状态
  const sortKey = onSort ? controlledSortKey : internalSortKey;
  const sortOrder = onSort ? controlledSortOrder : internalSortOrder;

  useEffect(() => {
    if (!resized) {
      const w = {};
      columnDefs.forEach(c => { w[c.key] = c.width || c.defaultWidth || 120; });
      setColWidths(w);
    }
  }, [columnDefs]);

  const handleResize = useCallback((key, startX, startWidth) => {
    const onMouseMove = (e) => {
      setColWidths(prev => ({ ...prev, [key]: Math.max(40, startWidth + e.clientX - startX) }));
      setResized(true);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  function resetWidths() {
    const w = {};
    columnDefs.forEach(c => { w[c.key] = c.width || c.defaultWidth || 120; });
    setColWidths(w);
    setResized(false);
  }

  function autoFit() {
    const w = {};
    columnDefs.forEach(c => {
      if (c.key === 'index') w[c.key] = 50;
      else if (c.key === 'action' || c.key === 'actions') w[c.key] = 140;
      else if (c.key === 'title' || c.key === 'stem') w[c.key] = 400;
      else w[c.key] = c.width || c.defaultWidth || 110;
    });
    setColWidths(w);
    setResized(true);
  }

  function handleSort(key) {
    const col = columnDefs.find(c => c.key === key);
    if (!col || col.sortable === false) return;
    const newOrder = sortKey === key ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'asc';
    if (onSort) {
      onSort(col.dataIndex || key, newOrder);
    } else {
      setInternalSortKey(key);
      setInternalSortOrder(newOrder);
    }
  }

  const filtered = searchText && searchFields.length > 0
    ? dataSource.filter(row => searchFields.some(f => {
        const val = row[f];
        return val && String(val).toLowerCase().includes(searchText.toLowerCase());
      }))
    : dataSource;

  const sorted = useMemo(() => {
    if (onSort) return filtered;
    if (!sortKey) return filtered;
    const col = columnDefs.find(c => c.key === sortKey);
    if (!col || col.sortable === false) return filtered;

    return [...filtered].sort((a, b) => {
      let va = col.sortValue ? col.sortValue(a[col.dataIndex], a) : a[col.dataIndex];
      let vb = col.sortValue ? col.sortValue(b[col.dataIndex], b) : b[col.dataIndex];
      if (va == null && vb == null) return 0;
      if (va == null) return sortOrder === 'asc' ? 1 : -1;
      if (vb == null) return sortOrder === 'asc' ? -1 : 1;
      let cmp = (typeof va === 'number' && typeof vb === 'number') ? va - vb : String(va).localeCompare(String(vb), 'zh-CN');
      return sortOrder === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortOrder, columnDefs, onSort]);

  const pageOffset = pagination ? (pagination.current - 1) * pagination.pageSize : 0;
  const totalW = columnDefs.reduce((s, c) => s + (colWidths[c.key] || 120), 0);
  const cellStyle = HEIGHT_PRESETS[rowHeight] || HEIGHT_PRESETS.default;
  const totalPages = pagination ? Math.ceil(pagination.total / pagination.pageSize) : 0;

  // 生成页码数组（最多显示7个页码）
  function getPageNumbers() {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = [];
    const cur = pagination.current;
    if (cur <= 4) {
      pages.push(1, 2, 3, 4, 5, '...', totalPages);
    } else if (cur >= totalPages - 3) {
      pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', cur - 1, cur, cur + 1, '...', totalPages);
    }
    return pages;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {searchable && searchFields.length > 0 && (
            <Input.Search placeholder={searchPlaceholder} allowClear style={{ width: 200 }}
              onSearch={v => setSearchText(v)} onChange={e => { if (!e.target.value) setSearchText(''); }} />
          )}
          {extraToolbar}
        </div>
        <Space size="small">
          <Select value={rowHeight} onChange={setRowHeight} style={{ width: 90 }} size="small"
            options={[{ label: '紧凑', value: 'compact' }, { label: '默认', value: 'default' }, { label: '宽松', value: 'loose' }]} />
          <Tooltip title="自动调整列宽"><Button size="small" icon={<ColumnWidthOutlined />} onClick={autoFit} /></Tooltip>
          <Tooltip title="重置列宽"><Button size="small" icon={<ReloadOutlined />} onClick={resetWidths} /></Tooltip>
        </Space>
      </div>

      <Text type="secondary" style={{ fontSize: 11, marginBottom: 8, display: 'block' }}>点击列头排序 · 拖动列头边缘调整列宽</Text>

      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: totalW }}>
            <div style={{ display: 'flex', background: '#fafafa', borderBottom: '2px solid #f0f0f0' }}>
              {columnDefs.map(col => {
                const isSorted = sortKey === col.key;
                const sortable = col.sortable !== false;
                const headerStyle = col.onHeaderCell ? col.onHeaderCell() : {};
                return (
                  <div key={col.key}
                    style={{ width: colWidths[col.key], minWidth: colWidths[col.key], padding: '12px 16px', position: 'relative', userSelect: 'none', flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: sortable ? 'pointer' : 'default', background: isSorted ? '#e6f4ff' : undefined, display: 'flex', alignItems: 'center', justifyContent: col.align === 'center' ? 'center' : 'flex-start', gap: 4, ...headerStyle }}
                    onClick={() => sortable && handleSort(col.key)}>
                    <span>{col.title}</span>
                    {sortable && (
                      <span style={{ display: 'inline-flex', flexDirection: 'column', fontSize: 10, lineHeight: 1, opacity: isSorted ? 1 : 0.3 }}>
                        <CaretUpOutlined style={{ color: isSorted && sortOrder === 'asc' ? '#1D4ED8' : '#999', marginBottom: -2 }} />
                        <CaretDownOutlined style={{ color: isSorted && sortOrder === 'desc' ? '#1D4ED8' : '#999' }} />
                      </span>
                    )}
                    <div style={{ position: 'absolute', right: -4, top: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 2 }}
                      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); handleResize(col.key, e.clientX, colWidths[col.key]); }} />
                  </div>
                );
              })}
            </div>

            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>加载中...</div>
            ) : sorted.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center' }}><Empty description="暂无数据" /></div>
            ) : (
              sorted.map((row, idx) => {
                const rowCellStyle = idx % 2 === 0 ? {} : { background: '#fafafa' };
                return (
                  <div key={row[rowKey] || idx} style={{ display: 'flex', background: '#fff', borderBottom: '1px solid #e8e8e8', ...rowCellStyle }}>
                    {columnDefs.map(col => {
                      const extraCellStyle = col.onCell ? col.onCell() : {};
                      return (
                        <div key={col.key} style={{ width: colWidths[col.key], minWidth: colWidths[col.key], flexShrink: 0, overflow: 'hidden', textOverflow: col.ellipsis ? 'ellipsis' : undefined, whiteSpace: col.ellipsis ? 'nowrap' : undefined, display: 'flex', alignItems: 'center', justifyContent: col.align === 'center' ? 'center' : 'flex-start', padding: '12px 16px', ...extraCellStyle }}>
                          {col.render ? col.render(row[col.dataIndex], row, pageOffset + idx + 1) : (col.dataIndex === '_index' ? pageOffset + idx + 1 : row[col.dataIndex])}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {pagination && pagination.total > 0 && (
          <div style={{ padding: '12px 16px', borderTop: '1px solid #f0f0f0', background: '#fafafa', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>共 {pagination.total} 条</Text>
            {totalPages > 1 && (
              <Space size={4} align="center">
                <Button size="small" disabled={pagination.current <= 1} onClick={() => onPageChange(pagination.current - 1)}>上一页</Button>
                {getPageNumbers().map((p, i) =>
                  p === '...' ? (
                    <span key={'d' + i} style={{ padding: '0 4px', color: '#999' }}>...</span>
                  ) : (
                    <Button key={p} size="small" type={p === pagination.current ? 'primary' : 'default'}
                      onClick={() => onPageChange(p)}>{p}</Button>
                  )
                )}
                <Button size="small" disabled={pagination.current >= totalPages} onClick={() => onPageChange(pagination.current + 1)}>下一页</Button>
                <span style={{ marginLeft: 8, fontSize: 13 }}>
                  跳至 <Input size="small" style={{ width: 50, textAlign: 'center' }} value={jumpPage}
                    onChange={e => setJumpPage(e.target.value.replace(/\D/g, ''))}
                    onPressEnter={() => { const p = parseInt(jumpPage); if (p >= 1 && p <= totalPages) { onPageChange(p); setJumpPage(''); } }} />
                  页
                </span>
              </Space>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
