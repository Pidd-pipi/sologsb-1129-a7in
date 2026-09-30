import { diffLabel } from '../../utils/correction';
import type { CorrectableField } from '../../types/correction';

export interface SnapshotDiffBadgeProps {
  /** 与现行档案不一致的字段 */
  fields: CorrectableField[];
  /** 悬浮时展开的详情文字（旧值 → 新值） */
  title?: string;
  testId?: string;
}

/**
 * 历史记录差异角标：缺损记录 / 试印样张保留登记时旧值，
 * 与现行档案不一致时在记录旁标出差异字段，提醒「查实物对得上的是旧字面」。
 */
export default function SnapshotDiffBadge({ fields, title, testId = 'snapshot-diff' }: SnapshotDiffBadgeProps) {
  if (fields.length === 0) return null;
  return (
    <span
      className="mt-1 inline-flex items-center gap-1 rounded-full border border-brass/50 bg-brass-pale px-2 py-0.5 text-[11px] font-medium text-brass"
      title={title || `该记录保留登记时的${diffLabel(fields)}，与现行档案不同`}
      data-testid={testId}
      data-diff-fields={fields.join(',')}
    >
      <span aria-hidden>⚠</span>
      <span>旧档{diffLabel(fields)}与现行不同</span>
    </span>
  );
}
