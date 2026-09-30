import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import CharacterPicker from '../components/common/CharacterPicker';
import EmptyState from '../components/common/EmptyState';
import SnapshotDiffBadge from '../components/common/SnapshotDiffBadge';
import { useCaseStore } from '../stores/caseStore';
import { useMatrixStore } from '../stores/matrixStore';
import { useUiStore } from '../stores/uiStore';
import {
  CorrectionConflictError,
  CORRECTION_FIELD_LABELS,
  CORRECTABLE_FIELDS,
  validateCorrectionInput,
  type CorrectionInput,
  type CorrectionPreview,
  type FieldConflict,
} from '../types/correction';
import { MATRIX_FONTS, type MatrixFont } from '../types/matrix';
import { diffCorrection, previewCorrection, slotLabel } from '../utils/correction';
import { dash, formatDate, formatStamp } from '../utils/format';

interface CorrectionFormState {
  code: string;
  character: string;
  font: MatrixFont;
  reason: string;
  operator: string;
}

/** 预演内容签名：编号 / 字符 / 字体任一变化都要求重新预演 */
function signatureOf(f: CorrectionFormState): string {
  return `${f.code.trim()}|${f.character.trim()}|${f.font}`;
}

/** `/matrices/:id/correct` 档案更正：先预演受影响盘位与历史记录，确认后再提交 */
export default function MatrixCorrection() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pushToast = useUiStore((s) => s.pushToast);

  const matrix = useMatrixStore((s) => s.matrices.find((m) => m.id === id));
  const defects = useMatrixStore((s) => s.defects);
  const proofs = useMatrixStore((s) => s.proofs);
  const cases = useCaseStore((s) => s.cases);
  const applyCorrection = useMatrixStore((s) => s.applyCorrection);
  const refreshArchive = useMatrixStore((s) => s.refreshArchive);
  const loaded = useMatrixStore((s) => s.loaded);

  /** 本次编辑所依据的档案版本；冲突后会更新为最新版本 */
  const [base, setBase] = useState(() => matrix ?? null);
  const [form, setForm] = useState<CorrectionFormState>(() => ({
    code: matrix?.code ?? '',
    character: matrix?.character ?? '',
    font: (matrix?.font ?? '宋体') as MatrixFont,
    reason: '',
    operator: '',
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<(CorrectionPreview & { signature: string }) | null>(null);
  /** 被拦下的并发冲突（含本方打开时 / 本方拟改 / 他方已提交三方值） */
  const [conflictState, setConflictState] = useState<{
    baseRev: number;
    currentRev: number;
    conflicts: FieldConflict[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const latestMatrix = matrix;

  /** 他标签页已把档案改到新版本（本页 base 落后）时给出提醒 */
  const staleByOther = useMemo(
    () => Boolean(base && latestMatrix && latestMatrix.rev > base.rev && !conflictState),
    [base, latestMatrix, conflictState],
  );

  // 直接在该路由硬刷新时档案可能尚未读回：首次出现后初始化基线与表单（只做一次，
  // 之后基线只在冲突 rebase 时更新，避免他标签页的改动悄悄覆盖馆员正在填的内容）
  useEffect(() => {
    if (base || !matrix) return;
    setBase(matrix);
    setForm({
      code: matrix.code,
      character: matrix.character,
      font: matrix.font,
      reason: '',
      operator: '',
    });
  }, [base, matrix]);

  // 预演结果对应的表单内容签名；表单在此之后被改动则旧预演作废，需重新预演
  const previewedSignature = preview?.signature ?? '';
  const currentSignature = signatureOf(form);
  const previewStale = Boolean(preview) && previewedSignature !== currentSignature;

  if (!base || !latestMatrix) {
    return (
      <EmptyState
        title={loaded ? '没有找到这枚字模' : '正在读取字模档案…'}
        description={loaded ? '该字模可能已被删除，或链接中的编号不正确。' : '首次进入会写入示例档案，请稍候。'}
        action={
          <Link className="mt-btn" to="/" data-testid="correction-back">
            返回字模总览
          </Link>
        }
        testId="correction-not-found"
      />
    );
  }

  const buildInput = (): CorrectionInput => ({
    code: form.code,
    character: form.character,
    font: form.font,
    reason: form.reason,
    operator: form.operator,
  });

  const baseValues = {
    code: base.code,
    character: base.character,
    font: base.font,
  };

  const handlePreview = () => {
    const input = buildInput();
    const next = validateCorrectionInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('更正内容未通过校验，请按提示修正', 'warn');
      return;
    }
    // 预演基于他方提交后的最新档案计算，保证「当前格位」展示的是库里现状
    const result = previewCorrection(latestMatrix, input, cases, defects, proofs);
    setPreview({ ...result, signature: currentSignature });
    setConflictState(null);
    if (result.noop) pushToast('档案与现行内容一致，没有需要更正的字段', 'warn');
  };

  const handleSubmit = async () => {
    const input = buildInput();
    const next = validateCorrectionInput(input);
    setErrors(next);
    if (Object.keys(next).length > 0) {
      pushToast('更正内容未通过校验，请按提示修正', 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const log = await applyCorrection({
        matrixId: base.id,
        baseRev: base.rev,
        base: baseValues,
        input,
      });
      pushToast(
        `档案更正完成（第 ${log.nextRev} 版）：${log.changes
          .map((c) => `${c.label} ${c.before || '空'}→${c.after}`)
          .join('、')}；当前格位已同步，旧样张保留原字面`,
      );
      navigate(`/matrices/${base.id}`);
    } catch (err) {
      if (err instanceof CorrectionConflictError) {
        // 先从本机库读回他方已提交的最新档案，再让馆员核对差异
        await refreshArchive();
        setConflictState({
          baseRev: err.baseRev,
          currentRev: err.currentRev,
          conflicts: err.conflicts,
        });
        const fresh = useMatrixStore.getState().matrices.find((m) => m.id === base.id);
        if (fresh) setBase(fresh);
        setPreview(null);
        pushToast('另一标签页已先更正过这枚字模，请核对差异后再提交', 'warn');
      } else {
        pushToast(err instanceof Error ? err.message : '档案更正失败', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** 放弃本方拟改值，以他方最新档案为基准重新预演 */
  const handleRebase = () => {
    setForm((p) => ({
      ...p,
      code: latestMatrix.code,
      character: latestMatrix.character,
      font: latestMatrix.font,
    }));
    setConflictState(null);
    setPreview(null);
    pushToast('已载入最新档案，可在此基础上重新预演更正');
  };

  /** 保留本方拟改值，但把基线换成他方最新版本（覆盖他方结果前再预演一次） */
  const handleRereview = () => {
    const result = previewCorrection(latestMatrix, buildInput(), cases, defects, proofs);
    setPreview({ ...result, signature: signatureOf(form) });
    setConflictState(null);
  };

  const pendingChanges = diffCorrection(base, buildInput());

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="correction-title">
            档案更正 · {base.character}
          </h2>
          <p className="mt-sub">
            更正字模编号、字符或字体：先预演受影响的字盘格位与历史记录，确认后再提交。当前格位跟随更新；缺损记录与试印样张保留当时登记的旧值并标出差异。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="mt-chip" data-testid="correction-rev">
            档案版本 第 {latestMatrix.rev} 版
          </span>
          <Link className="mt-btn" to={`/matrices/${base.id}`} data-testid="correction-cancel">
            返回详情
          </Link>
        </div>
      </section>

      {staleByOther ? (
        <div
          className="rounded border border-brass/50 bg-brass-pale px-4 py-3 text-xs text-brass"
          data-testid="correction-stale"
        >
          该字模在另一标签页已被更正（第 {base.rev} 版 → 第 {latestMatrix.rev} 版）。下方表单仍是旧版内容，
          <button type="button" className="mx-1 underline" onClick={handleRebase}>
            点此载入最新档案
          </button>
          后再预演。
        </div>
      ) : null}

      {conflictState ? (
        <section className="mt-panel border-seal/40" data-testid="correction-conflict">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-seal">
              提交被拦下：档案已被另一标签页先更正（第 {conflictState.baseRev} 版 → 第 {conflictState.currentRev} 版）
            </h3>
            <span className="mt-sub">请逐字段核对，避免覆盖第一次的更正结果</span>
          </div>
          <div className="overflow-x-auto px-2 pb-3">
            <table className="min-w-full" data-testid="conflict-table">
              <thead className="border-b border-paper-line bg-paper/60">
                <tr>
                  <th className="mt-th">字段</th>
                  <th className="mt-th">本方打开时（旧）</th>
                  <th className="mt-th">本方拟改为</th>
                  <th className="mt-th">他方已提交（现行）</th>
                  <th className="mt-th">处理</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-paper-line">
                {CORRECTABLE_FIELDS.map((field) => {
                  // 未出现在冲突列表里的字段说明三方一致，用现行值补齐展示
                  const c: FieldConflict =
                    conflictState.conflicts.find((x) => x.field === field) ?? {
                      field,
                      label: CORRECTION_FIELD_LABELS[field],
                      base: latestMatrix[field],
                      theirs: latestMatrix[field],
                      current: latestMatrix[field],
                      needReview: false,
                    };
                  return (
                    <tr key={field} data-testid={`conflict-row-${field}`}>
                      <td className="mt-td">{c.label}</td>
                      <td className="mt-td text-ink-mute">{dash(c.base)}</td>
                      <td className="mt-td text-ink">{dash(c.theirs)}</td>
                      <td className="mt-td text-seal">{dash(c.current)}</td>
                      <td className="mt-td">
                        {c.needReview ? (
                          <span className="text-[11px] text-brass" data-testid={`conflict-need-${field}`}>
                            本方拟改与现行不同，需再核对
                          </span>
                        ) : (
                          <span className="text-[11px] text-jade" data-testid={`conflict-ok-${field}`}>
                            与现行一致，无冲突
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2 border-t border-paper-line px-4 py-3">
            <button type="button" className="mt-btn mt-btn-primary" data-testid="conflict-rereview" onClick={handleRereview}>
              保留本方拟改，按最新版本重新预演
            </button>
            <button type="button" className="mt-btn" data-testid="conflict-rebase" onClick={handleRebase}>
              以他方最新档案为准，放弃本方改动
            </button>
          </div>
          <p className="px-4 pb-3 text-[11px] text-ink-mute">
            「重新预演」会在预览中如实列出本方内容与现行值的全部差异；确认提交将覆盖他方更正，请务必核对。
          </p>
        </section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_1fr]">
        <section className="mt-panel h-fit">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">更正内容</h3>
            <span className="mt-sub">仅这三项支持留痕更正</span>
          </div>
          <div className="space-y-3 px-4 py-4">
            <div>
              <label className="mt-label" htmlFor="correct-code">
                字模编号
              </label>
              <input
                id="correct-code"
                data-testid="correct-code"
                className="mt-input"
                value={form.code}
                onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
              />
              {errors.code ? (
                <p className="mt-error" data-testid="error-correct-code">
                  {errors.code}
                </p>
              ) : (
                <p className="mt-hint">
                  原登记：<span data-testid="correct-code-old">{base.code}</span>
                </p>
              )}
            </div>

            <div>
              <CharacterPicker
                value={form.character}
                onChange={(ch) => setForm((p) => ({ ...p, character: ch }))}
                label="字符"
                testId="correct-character"
                compact
              />
              <div className="mt-1">
                {errors.character ? (
                  <p className="mt-error" data-testid="error-correct-character">
                    {errors.character}
                  </p>
                ) : (
                  <p className="mt-hint">
                    原登记字符：
                    <span className="font-song text-ink-soft" data-testid="correct-character-old">
                      {base.character}
                    </span>
                  </p>
                )}
              </div>
            </div>

            <div>
              <label className="mt-label" htmlFor="correct-font">
                字体
              </label>
              <select
                id="correct-font"
                data-testid="correct-font"
                className="mt-input"
                value={form.font}
                onChange={(e) => setForm((p) => ({ ...p, font: e.target.value as MatrixFont }))}
              >
                {MATRIX_FONTS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              {errors.font ? (
                <p className="mt-error" data-testid="error-correct-font">
                  {errors.font}
                </p>
              ) : (
                <p className="mt-hint">
                  原登记：<span data-testid="correct-font-old">{base.font}</span>
                </p>
              )}
            </div>

            <div>
              <label className="mt-label" htmlFor="correct-reason">
                更正原因
              </label>
              <input
                id="correct-reason"
                data-testid="correct-reason"
                className="mt-input"
                placeholder="例：核对实物发现编号签与登记不符"
                value={form.reason}
                onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
              />
              {errors.reason ? <p className="mt-error">{errors.reason}</p> : null}
            </div>

            <div>
              <label className="mt-label" htmlFor="correct-operator">
                经办人
              </label>
              <input
                id="correct-operator"
                data-testid="correct-operator"
                className="mt-input"
                placeholder="例：陈之安"
                value={form.operator}
                onChange={(e) => setForm((p) => ({ ...p, operator: e.target.value }))}
              />
              {errors.operator ? <p className="mt-error">{errors.operator}</p> : null}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-paper-line pt-3">
              <button type="button" className="mt-btn" data-testid="correction-preview-btn" onClick={handlePreview}>
                预演更正
              </button>
              <button
                type="button"
                className="mt-btn mt-btn-primary"
                data-testid="correction-submit-btn"
                onClick={handleSubmit}
                disabled={submitting || !preview || preview.noop || previewStale}
                title={!preview ? '请先预演，确认受影响范围后再提交' : previewStale ? '内容已改动，请重新预演' : undefined}
              >
                {submitting ? '提交中…' : '确认提交更正'}
              </button>
            </div>
            {previewStale ? (
              <p className="text-[11px] text-brass" data-testid="preview-stale-hint">
                预演后内容又被改动，请重新点「预演更正」确认受影响范围。
              </p>
            ) : (
              <p className="text-[11px] text-ink-mute" data-testid="correction-hint">
                提交为单事务：字模档案、所在字盘格位一次性改完并留痕；历史缺损与样张不改写。
              </p>
            )}
          </div>
        </section>

        <section className="space-y-4">
          {previewStale ? (
            <div
              className="rounded border border-brass/50 bg-brass-pale px-4 py-2 text-xs text-brass"
              data-testid="preview-stale-banner"
            >
              以下预演基于改动前的内容，请重新点「预演更正」。
            </div>
          ) : null}
          <PreviewPanel preview={preview} hasFormChange={pendingChanges.length > 0} />
        </section>
      </div>
    </div>
  );
}

function PreviewPanel({ preview, hasFormChange }: { preview: CorrectionPreview | null; hasFormChange: boolean }) {
  if (!preview) {
    return (
      <div className="mt-panel px-4 py-6 text-xs text-ink-mute" data-testid="preview-empty">
        {hasFormChange
          ? '表单已有改动，点「预演更正」查看受影响的字盘格位、缺损记录与试印样张。'
          : '先在左侧修改编号 / 字符 / 字体，再点「预演更正」。'}
      </div>
    );
  }

  return (
    <>
      <div className="mt-panel" data-testid="preview-changes">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">本次将更正的字段</h3>
          <span className="mt-sub">
            基于第 {preview.baseRev} 版档案
          </span>
        </div>
        {preview.noop ? (
          <p className="px-4 py-3 text-xs text-ink-mute" data-testid="preview-noop">
            与现行档案完全一致，没有需要更正的字段。
          </p>
        ) : (
          <ul className="divide-y divide-paper-line">
            {preview.changes.map((c) => (
              <li
                key={c.field}
                className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
                data-testid={`preview-change-${c.field}`}
              >
                <span className="mt-chip">{c.label}</span>
                <span className="text-ink-mute line-through">{dash(c.before)}</span>
                <span aria-hidden>→</span>
                <span className="font-song text-sm text-seal">{c.after}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-panel" data-testid="preview-slots">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">受影响字盘格位（当前格位会跟随更新）</h3>
          <span className="mt-sub">{preview.slots.length} 处</span>
        </div>
        {preview.slots.length === 0 ? (
          <p className="px-4 py-3 text-xs text-ink-mute">该字模当前未落在任何字盘上，格位无需联动。</p>
        ) : (
          <ul className="divide-y divide-paper-line">
            {preview.slots.map((s) => (
              <li
                key={`${s.caseId}-${s.row}-${s.col}`}
                className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs"
                data-testid={`preview-slot-${s.caseId}-${s.row}-${s.col}`}
              >
                <span className="font-song text-sm text-ink">{s.caseCode}</span>
                <span className="text-ink-mute">
                  {s.kind} · {s.workStation}
                </span>
                <span className="mt-chip">格位 {slotLabel(s.row, s.col)}</span>
                <span className={s.stale ? 'text-brass' : 'text-ink-mute'}>
                  {s.stale ? '格位旧值' : '现显示'}「{s.before}」
                </span>
                <span aria-hidden>→</span>
                <span className="font-song text-sm text-seal" data-testid={`preview-slot-after-${s.caseId}-${s.row}-${s.col}`}>
                  「{s.after}」
                </span>
                {s.stale ? (
                  <span className="text-[11px] text-brass" data-testid={`preview-slot-stale-${s.caseId}-${s.row}-${s.col}`}>
                    格位本就与档案不符，本次一并对齐
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="mt-panel" data-testid="preview-defects">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">缺损记录（保留当时登记值）</h3>
            <span className="mt-sub">{preview.history.defects.length} 条 · 不改写</span>
          </div>
          {preview.history.defects.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-mute">没有相关缺损记录。</p>
          ) : (
            <ul className="divide-y divide-paper-line">
              {preview.history.defects.map((d) => (
                <li key={d.id} className="space-y-1 px-4 py-2 text-xs" data-testid={`preview-defect-${d.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-song text-sm text-ink">{d.snapshotCharacter || '—'}</span>
                    <span className="text-[11px] text-ink-mute">{dash(d.snapshotCode)}</span>
                    <span className="text-ink-mute">{formatDate(d.foundDate)}</span>
                  </div>
                  <p className="text-ink-mute">{d.summary}</p>
                  {d.differs ? (
                    <SnapshotDiffBadge
                      fields={d.diffFields}
                      testId={`preview-defect-diff-${d.id}`}
                    />
                  ) : (
                    <span className="text-[11px] text-jade" data-testid={`preview-defect-same-${d.id}`}>
                      与现行档案一致
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-panel" data-testid="preview-proofs">
          <div className="mt-panel-head">
            <h3 className="font-song text-sm font-semibold text-ink">试印样张（保留当时字面）</h3>
            <span className="mt-sub">{preview.history.proofs.length} 张 · 不改写</span>
          </div>
          {preview.history.proofs.length === 0 ? (
            <p className="px-4 py-3 text-xs text-ink-mute">没有相关试印样张。</p>
          ) : (
            <ul className="divide-y divide-paper-line">
              {preview.history.proofs.map((p) => (
                <li key={p.id} className="space-y-1 px-4 py-2 text-xs" data-testid={`preview-proof-${p.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-song text-sm text-ink">{p.sampleNo}</span>
                    <span className="text-ink-mute">
                      {p.targetKind} · {formatDate(p.proofDate)}
                    </span>
                    <span className="mt-chip">
                      当时印出：<span className="font-song">{p.snapshotCharacter || '—'}</span>
                    </span>
                  </div>
                  {p.differs ? (
                    <SnapshotDiffBadge
                      fields={p.diffFields}
                      testId={`preview-proof-diff-${p.id}`}
                    />
                  ) : (
                    <span className="text-[11px] text-jade" data-testid={`preview-proof-same-${p.id}`}>
                      与现行档案一致
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="text-[11px] text-ink-mute" data-testid="preview-footnote">
        预演仅读取档案，不会写入任何内容。确认提交后生成一条更正台账（时间 {formatStamp(new Date().toISOString())}）。
      </p>
    </>
  );
}
