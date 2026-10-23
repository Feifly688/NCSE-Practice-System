import React, { useState, useEffect } from 'react';
import { Rate, Input, Button, Space, Typography, message } from 'antd';
import { StarOutlined } from '@ant-design/icons';
import api from '../services/api';

const { Text } = Typography;

const RATING_LABELS = ['', '很差', '较差', '一般', '不错', '很好'];

/**
 * 单题评分与反馈组件。
 *
 * 设计要点：
 * 1. 星级评分与文字反馈在同一个组件内成组提交，避免"评了分却忘了写反馈"的分裂体验；
 * 2. 组件挂载时由外部传入 initial（已有评分），未提交过则 initial 为 null；
 * 3. 提交中锁定交互，防止重复提交；提交成功后保持可编辑（支持随时修改）；
 * 4. 提交状态通过 onSubmitted 回调通知父级，便于父级做汇总展示。
 *
 * @param {{
 *   questionId: number,
 *   sessionId?: number|null,
 *   initial?: { rating: number, feedback: string, updated_at?: string } | null,
 *   onSubmitted?: (questionId: number, rating: number, feedback: string) => void,
 *   compact?: boolean
 * }} props
 */
export default function QuestionFeedback({ questionId, sessionId, initial, onSubmitted, compact = false }) {
  const [rating, setRating] = useState(initial?.rating || 0);
  const [feedback, setFeedback] = useState(initial?.feedback || '');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(!!initial);
  // 已保存的基准值：提交成功后同步为该次提交的内容，
  // 使 hasChange 正确反映"是否有未保存修改"（否则按钮会停留在可提交态）
  const [saved, setSaved] = useState(
    initial ? { rating: initial.rating || 0, feedback: initial.feedback || '' } : null
  );

  // 外部 initial 变化时（如异步加载完成）同步内部状态
  useEffect(() => {
    if (initial) {
      setRating(initial.rating || 0);
      setFeedback(initial.feedback || '');
      setSubmitted(true);
      setSaved({ rating: initial.rating || 0, feedback: initial.feedback || '' });
    }
  }, [initial]);

  const base = saved || { rating: 0, feedback: '' };
  const hasChange = rating !== base.rating || feedback !== base.feedback;

  async function handleSubmit() {
    if (rating < 1) {
      message.warning('请先选择星级评分');
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/practice/feedback', {
        question_id: questionId,
        session_id: sessionId,
        rating,
        feedback: feedback.trim(),
      });
      setSubmitted(true);
      setSaved({ rating, feedback: feedback.trim() });
      message.success('评价已提交');
      onSubmitted?.(questionId, rating, feedback.trim());
    } catch (err) {
      message.error(err.response?.data?.error || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      marginTop: 12,
      padding: compact ? '10px 12px' : '12px 14px',
      background: '#f8fafc',
      border: '1px solid #e2e8f0',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <Space size={8} wrap>
          <StarOutlined style={{ color: '#faad14' }} />
          <Text type="secondary" style={{ fontSize: 13 }}>为这道题评分：</Text>
          <Rate
            value={rating}
            onChange={setRating}
            allowClear
            count={5}
            style={{ fontSize: compact ? 18 : 20 }}
          />
          {rating > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {RATING_LABELS[rating]}
            </Text>
          )}
        </Space>
        {submitted && !hasChange && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {initial?.updated_at ? `已评价 · ${new Date(initial.updated_at).toLocaleString('zh-CN')}` : '已评价'}
          </Text>
        )}
      </div>

      <Input.TextArea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="说说你的看法（可选）：题目是否有歧义、解析是否清楚、难度是否合理…"
        maxLength={1000}
        showCount
        rows={compact ? 2 : 3}
        style={{ marginTop: 10, background: '#fff' }}
      />

      <div style={{ marginTop: 8, textAlign: 'right' }}>
        <Space>
          {submitted && (
            <Button
              size="small"
              onClick={() => {
                setRating(base.rating);
                setFeedback(base.feedback);
              }}
              disabled={!hasChange}
            >
              重置
            </Button>
          )}
          <Button
            type="primary"
            size="small"
            loading={submitting}
            onClick={handleSubmit}
            disabled={rating < 1 || !hasChange}
          >
            {submitted && !hasChange ? '已提交' : submitted ? '更新评价' : '提交评价'}
          </Button>
        </Space>
      </div>
    </div>
  );
}
