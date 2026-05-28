import React, { useState, useCallback } from 'react';
import { Table } from 'antd';
import { Resizable } from 'react-resizable';
import 'react-resizable/css/styles.css';

const ResizableHeaderCell = (props) => {
  const { onResize, width, ...restProps } = props;
  if (!width) {
    return <th {...restProps} />;
  }
  return (
    <Resizable
      width={width}
      height={0}
      handle={
        <span
          className="react-resizable-handle"
          style={{ position: 'absolute', right: -5, bottom: 0, top: 0, width: 10, cursor: 'col-resize', zIndex: 1 }}
          onClick={(e) => e.stopPropagation()}
        />
      }
      onResize={onResize}
      draggableOpts={{ enableUserSelectHack: false }}
    >
      <th {...restProps} />
    </Resizable>
  );
};

export default function ResizableTable({ columns: initialColumns, dataSource, ...restProps }) {
  const [columns, setColumns] = useState(initialColumns);

  const handleResize = useCallback((index) => (e, { size }) => {
    setColumns((prevColumns) => {
      const nextColumns = [...prevColumns];
      nextColumns[index] = { ...nextColumns[index], width: size.width };
      return nextColumns;
    });
  }, []);

  const mergedColumns = columns.map((col, index) => ({
    ...col,
    onHeaderCell: (column) => ({
      width: column.width,
      onResize: handleResize(index),
    }),
  }));

  return (
    <Table
      components={{ header: { cell: ResizableHeaderCell } }}
      columns={mergedColumns}
      dataSource={dataSource}
      {...restProps}
    />
  );
}