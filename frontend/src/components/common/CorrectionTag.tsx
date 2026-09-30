/**
 * 档案更正差异标记：历史记录保留登记当时的内容，
 * 当留存的字符 / 编号与现行档案不同时，用此标签标出「原 → 现」差异。
 */
export default function CorrectionTag({
  before,
  after,
  testId,
}: {
  before: string;
  after: string;
  testId?: string;
}) {
  if (!before || before === after) return null;
  return (
    <span
      className="mt-chip border-brass/40 text-brass"
      title={`档案已更正：历史记录保留当时内容「${before}」，现行档案为「${after}」`}
      data-testid={testId}
    >
      档案已更正 · 原「{before}」→ 现「{after}」
    </span>
  );
}
