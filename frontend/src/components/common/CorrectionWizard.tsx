import { useMemo, useState, type FormEvent } from 'react';
import { StaleMatrixError, useMatrixStore } from '../../stores/matrixStore';
import { useCaseStore } from '../../stores/caseStore';
import { useUiStore } from '../../stores/uiStore';
import { MATRIX_FONTS, type MatrixFont, type TypeMatrix } from '../../types/matrix';
import {
  buildCorrectionPreview,
  slotLabel,
  type CorrectionPreview,
  type IdentityPatch,
} from '../../utils/correction';
import { formatDate } from '../../utils/format';
import CorrectionTag from './CorrectionTag';

interface Props {
  matrix: TypeMatrix;
  onClose: () => void;
  onCorrected: () => void;
}

type Phase = 'edit' | 'preview';

/**
 * 档案更正向导：先预演受影响的盘位与历史记录，再提交。
 * - 当前格位随档案一起更新；
 * - 历史缺损 / 试印记录保留当时内容，仅标注差异；
 * - 两个标签页同时改同一枚时，后提交一方先核对差异再决定是否覆盖。
 */
export default function CorrectionWizard({ matrix, onClose, onCorrected }: Props) {
  const defects = useMatrixStore((s) => s.defects);
  const proofs = useMatrixStore((s) => s.proofs);
  const applyCorrection = useMatrixStore((s) => s.applyCorrection);
  const cases = useCaseStore((s) => s.cases);
  const pushToast = useUiStore((s) => s.pushToast);

  const [phase, setPhase] = useState<Phase>('edit');
  const [code, setCode] = useState(matrix.code);
  const [character, setCharacter] = useState(matrix.character);
  const [font, setFont] = useState<MatrixFont>(matrix.font);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<CorrectionPreview | null>(null);
  const [applying, setApplying] = useState(false);
  const [conflict, setConflict] = useState<TypeMatrix | null>(null);

  const patch: IdentityPatch = useMemo(() => {
    const p: IdentityPatch = {};
    if (code.trim() !== matrix.code) p.code = code;
    if (character.trim() !== matrix.character) p.character = character;
    if (font !== matrix.font) p.font = font;
    return p;
  }, [code, character, font, matrix]);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!code.trim()) next.code = '字模编号不能为空';
    const ch = character.trim();
    if (!ch) next.character = '字符不能为空';
    else if (Array.from(ch).length > 1) next.character = '一次只更正一个字符';
    if (!font) next.font = '请选择字体';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handlePreview = (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) {
      pushToast('档案更正未通过校验，请按提示修正', 'warn');
      return;
    }
    const pv = buildCorrectionPreview(matrix, cases, defects, proofs, patch);
    if (!pv.hasChanges) {
      pushToast('档案内容未改动，无需更正', 'warn');
      return;
    }
    setPreview(pv);
    setPhase('preview');
  };

  const handleApply = async (force: boolean) => {
    if (!preview) return;
    setApplying(true);
    try {
      await applyCorrection(matrix.id, patch, { baseUpdatedAt: matrix.updatedAt, force });
      pushToast(
        `档案已更正：${preview.before.character} → ${preview.after.character}，同步更新 ${preview.slots.length} 处格位`,
      );
      onCorrected();
    } catch (err) {
      if (err instanceof StaleMatrixError) {
        setConflict(err.current);
        setApplying(false);
        return;
      }
      pushToast(err instanceof Error ? err.message : '档案更正失败', 'error');
      setApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4"
      data-testid="correction-wizard"
      role="dialog"
      aria-modal="true"
    >
      <div className="mt-panel w-full max-w-2xl">
        <div className="mt-panel-head">
          <div>
            <h3 className="font-song text-base font-semibold text-ink">档案更正 · 预演</h3>
            <p className="mt-sub">
              更正字模编号 / 字符 / 字体；当前格位随档案更新，历史记录保留当时内容并标注差异。
            </p>
          </div>
          <button type="button" className="mt-btn" data-testid="correction-close" onClick={onClose}>
            关闭
          </button>
        </div>

        {conflict ? (
          <div className="space-y-3 px-4 py-4" data-testid="correction-conflict">
            <div className="rounded border border-seal/40 bg-seal-pale px-3 py-2 text-sm text-seal">
              该字模档案已被其他标签页修改，请先核对差异，别覆盖第一次的结果。
            </div>
            <div className="overflow-hidden rounded border border-paper-line">
              <table className="min-w-full text-xs">
                <thead className="bg-paper/60">
                  <tr>
                    <th className="mt-th">字段</th>
                    <th className="mt-th">先提交一方（库里现行值）</th>
                    <th className="mt-th">你的更正（尚未提交）</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-paper-line">
                  <ConflictRow label="字模编号" a={conflict.code} b={preview?.after.code ?? ''} />
                  <ConflictRow label="字符" a={conflict.character} b={preview?.after.character ?? ''} />
                  <ConflictRow label="字体" a={conflict.font} b={preview?.after.font ?? ''} />
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-ink-mute">
              「仍要覆盖」会以你的更正覆盖先提交一方；「返回核对」可改回更正内容后重新预演。
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="mt-btn mt-btn-primary"
                data-testid="correction-force-btn"
                disabled={applying}
                onClick={() => handleApply(true)}
              >
                {applying ? '提交中…' : '仍要覆盖'}
              </button>
              <button
                type="button"
                className="mt-btn"
                data-testid="correction-back-btn"
                onClick={() => {
                  setConflict(null);
                  setPhase('edit');
                }}
              >
                返回核对
              </button>
              <button type="button" className="mt-btn" onClick={onClose}>
                取消
              </button>
            </div>
          </div>
        ) : phase === 'edit' || !preview ? (
          <form className="space-y-4 px-4 py-4" onSubmit={handlePreview}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className="mt-label" htmlFor="correction-code">
                  字模编号
                </label>
                <input
                  id="correction-code"
                  data-testid="correction-code-input"
                  className="mt-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                {errors.code ? <p className="mt-error">{errors.code}</p> : null}
              </div>
              <div>
                <label className="mt-label" htmlFor="correction-character">
                  字符
                </label>
                <input
                  id="correction-character"
                  data-testid="correction-character-input"
                  className="mt-input"
                  value={character}
                  onChange={(e) => setCharacter(e.target.value)}
                />
                {errors.character ? <p className="mt-error">{errors.character}</p> : null}
              </div>
              <div>
                <label className="mt-label" htmlFor="correction-font">
                  字体
                </label>
                <select
                  id="correction-font"
                  data-testid="correction-font-select"
                  className="mt-input"
                  value={font}
                  onChange={(e) => setFont(e.target.value as MatrixFont)}
                >
                  {MATRIX_FONTS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                {errors.font ? <p className="mt-error">{errors.font}</p> : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className="mt-btn mt-btn-primary" data-testid="correction-preview-btn">
                预演受影响范围
              </button>
              <button type="button" className="mt-btn" onClick={onClose}>
                取消
              </button>
              <span className="mt-hint">预演不写入数据，确认后才提交更正</span>
            </div>
          </form>
        ) : (
          <div className="space-y-4 px-4 py-4">
            <div className="rounded border border-paper-line bg-paper/50 px-3 py-2 text-xs text-ink-soft">
              档案身份：
              <span className="text-ink-mute">
                {preview.before.code} · {preview.before.character} · {preview.before.font}
              </span>
              <span className="mx-1">→</span>
              <span className="font-song text-sm text-ink">
                {preview.after.code} · {preview.after.character} · {preview.after.font}
              </span>
            </div>

            <section className="space-y-2">
              <h4 className="font-song text-sm font-semibold text-ink">
                受影响的字盘格位（{preview.slots.length} 处，将随档案更新）
              </h4>
              {preview.slots.length === 0 ? (
                <p className="text-xs text-ink-mute">该字模当前未落在任何字盘格位。</p>
              ) : (
                <ul className="space-y-1" data-testid="correction-slot-list">
                  {preview.slots.map((s, i) => (
                    <li
                      key={`${s.caseId}-${s.row}-${s.col}`}
                      className="rounded border border-paper-line bg-white/60 px-3 py-1.5 text-xs"
                      data-testid={`correction-slot-${i}`}
                    >
                      <span className="text-ink-soft">
                        {s.caseCode}（{s.caseKind} · {s.workStation}）
                      </span>
                      <span className="mx-1 text-ink-mute">·</span>
                      <span className="text-ink-mute">
                        {slotLabel(s.row, s.col)} 格
                      </span>
                      <span className="mx-1 text-ink-mute">：</span>
                      <span className="text-ink-mute">{s.before}</span>
                      <span className="mx-1">→</span>
                      <span className="font-song text-sm text-seal">{s.after}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="font-song text-sm font-semibold text-ink">
                缺损记录（{preview.defects.length} 条，保留当时内容，仅标注差异）
              </h4>
              {preview.defects.length === 0 ? (
                <p className="text-xs text-ink-mute">无关联缺损记录。</p>
              ) : (
                <ul className="space-y-1" data-testid="correction-defect-list">
                  {preview.defects.map((d) => (
                    <li
                      key={d.record.id}
                      className="rounded border border-paper-line bg-white/60 px-3 py-1.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-ink-soft">
                          {formatDate(d.record.foundDate)} · {d.record.defectType}/{d.record.severity}
                        </span>
                        {d.diff ? (
                          <CorrectionTag before={d.before.character} after={d.after.character} />
                        ) : (
                          <span className="text-[11px] text-ink-mute">与现行档案一致</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-mute">
                        留存：{d.before.character} · {d.before.code || '—'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="font-song text-sm font-semibold text-ink">
                试印样张（{preview.proofs.length} 条，保留当时字面，仅标注差异）
              </h4>
              {preview.proofs.length === 0 ? (
                <p className="text-xs text-ink-mute">无关联试印样张。</p>
              ) : (
                <ul className="space-y-1" data-testid="correction-proof-list">
                  {preview.proofs.map((p) => (
                    <li
                      key={p.record.id}
                      className="rounded border border-paper-line bg-white/60 px-3 py-1.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-song text-ink">{p.record.sampleNo}</span>
                        <span className="text-ink-mute">{formatDate(p.record.proofDate)}</span>
                        {p.diff ? (
                          <CorrectionTag before={p.before.character} after={p.after.character} />
                        ) : (
                          <span className="text-[11px] text-ink-mute">与现行档案一致</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-ink-mute">
                        当时字面：
                        <span className="font-song text-ink-soft">{p.before.character || '—'}</span>
                        {p.before.code ? ` · ${p.before.code}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <div className="flex flex-wrap items-center gap-2 border-t border-paper-line pt-3">
              <button
                type="button"
                className="mt-btn mt-btn-primary"
                data-testid="correction-apply-btn"
                disabled={applying}
                onClick={() => handleApply(false)}
              >
                {applying ? '提交中…' : '确认更正（格位随档案更新）'}
              </button>
              <button
                type="button"
                className="mt-btn"
                data-testid="correction-reedit-btn"
                onClick={() => setPhase('edit')}
              >
                返回修改
              </button>
              <button type="button" className="mt-btn" onClick={onClose}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictRow({ label, a, b }: { label: string; a: string; b: string }) {
  const diff = a !== b;
  return (
    <tr>
      <td className="mt-th">{label}</td>
      <td className="mt-td">
        <span className="font-song text-ink">{a}</span>
      </td>
      <td className="mt-td">
        {diff ? <span className="font-song text-seal">{b}</span> : <span className="text-ink-mute">同左</span>}
      </td>
    </tr>
  );
}
