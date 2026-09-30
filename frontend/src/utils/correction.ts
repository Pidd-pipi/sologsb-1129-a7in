/** 档案更正：快照差异比对与预演（纯函数，不碰数据库，便于审阅） */
import type { TypeCase } from '../types/case';
import type { CorrectionInput, CorrectionPreview, FieldChange, ImpactedHistory, ImpactedSlot } from '../types/correction';
import { CORRECTABLE_FIELDS, CORRECTION_FIELD_LABELS, type CorrectableField } from '../types/correction';
import type { DefectLog } from '../types/defect';
import type { TypeMatrix } from '../types/matrix';
import type { ProofRecord } from '../types/proof';

/** 行号显示：0 基行号 → A、B、C… */
export function rowLabelOf(row: number): string {
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[row] ?? String(row + 1);
}

/** 格位定位文字，例：A1 */
export function slotLabel(row: number, col: number): string {
  return `${rowLabelOf(row)}${col + 1}`;
}

/** 计算本次更正实际发生变化的字段（与旧档案逐字段比较） */
export function diffCorrection(matrix: TypeMatrix, input: CorrectionInput): FieldChange[] {
  const next = {
    code: input.code.trim(),
    character: input.character.trim(),
    font: input.font,
  };
  const changes: FieldChange[] = [];
  for (const field of CORRECTABLE_FIELDS) {
    const before = String(matrix[field] ?? '');
    const after = String(next[field] ?? '');
    if (before !== after) {
      changes.push({ field, label: CORRECTION_FIELD_LABELS[field], before, after });
    }
  }
  return changes;
}

function changedFields(before: Partial<Record<CorrectableField, string>>, after: Record<CorrectableField, string>): CorrectableField[] {
  const out: CorrectableField[] = [];
  for (const field of CORRECTABLE_FIELDS) {
    const b = before[field];
    // 旧版本未登记的快照字段（如样张字体）留空，不视为差异，绝不拿现行值补
    if (b === undefined || b === '') continue;
    if (b !== after[field]) out.push(field);
  }
  return out;
}

/**
 * 预演一次档案更正：
 * - 字符变化时，所有存放该字模的字盘格位都要跟随改字符；
 * - 缺损记录与试印样张保留登记时的旧值，只标出与现行档案的差异。
 */
export function previewCorrection(
  matrix: TypeMatrix,
  input: CorrectionInput,
  cases: TypeCase[],
  defects: DefectLog[],
  proofs: ProofRecord[],
): CorrectionPreview {
  const changes = diffCorrection(matrix, input);
  const next: Record<CorrectableField, string> = {
    code: input.code.trim(),
    character: input.character.trim(),
    font: input.font,
  };

  const slots: ImpactedSlot[] = [];
  for (const c of cases) {
    for (const s of c.slots) {
      if (s.matrixId !== matrix.id) continue;
      const stale = s.character !== matrix.character;
      slots.push({
        caseId: c.id,
        caseCode: c.code,
        kind: c.kind,
        workStation: c.workStation,
        row: s.row,
        col: s.col,
        before: s.character,
        after: next.character,
        stale,
      });
    }
  }

  const history: ImpactedHistory = {
    defects: defects
      .filter((d) => d.matrixId === matrix.id)
      .map((d) => {
        // 快照优先；v4 之前的历史记录由升级迁移按其自身冗余值（原登记值）回填
        const snapshotCharacter = d.snapshot?.character ?? d.character ?? '';
        const snapshotCode = d.snapshot?.matrixCode ?? d.matrixCode ?? '';
        const diffFields = changedFields(
          { character: snapshotCharacter, code: snapshotCode },
          next,
        );
        return {
          id: d.id,
          snapshotCharacter,
          snapshotCode,
          foundDate: d.foundDate,
          summary: `${d.defectType}·${d.severity} · ${d.handling}`,
          differs: diffFields.length > 0,
          diffFields,
        };
      })
      .sort((a, b) => (a.foundDate < b.foundDate ? 1 : -1)),
    proofs: proofs
      .filter((p) => p.matrixId === matrix.id)
      .map((p) => {
        const snapshotCharacter = p.snapshot?.character ?? (p.targetKind === '字符' ? p.targetRef : '') ?? '';
        const snapshotCode = p.snapshot?.matrixCode ?? '';
        const snapshotFont = p.snapshot?.font ?? '';
        const diffFields = changedFields(
          { character: snapshotCharacter, code: snapshotCode, font: snapshotFont },
          next,
        );
        return {
          id: p.id,
          sampleNo: p.sampleNo,
          proofDate: p.proofDate,
          targetKind: p.targetKind,
          snapshotCharacter,
          snapshotCode,
          snapshotFont,
          differs: diffFields.length > 0,
          diffFields,
        };
      })
      .sort((a, b) => (a.proofDate < b.proofDate ? 1 : -1)),
  };

  return {
    matrixId: matrix.id,
    baseRev: matrix.rev,
    changes,
    slots,
    history,
    noop: changes.length === 0,
  };
}

/** 现行档案相对某条缺损登记快照的差异字段（用于列表 / 详情直接标差异） */
export function defectDiffFields(d: DefectLog, matrix: TypeMatrix | undefined): CorrectableField[] {
  if (!matrix) return [];
  const snapshotCharacter = d.snapshot?.character ?? d.character ?? '';
  const snapshotCode = d.snapshot?.matrixCode ?? d.matrixCode ?? '';
  return changedFields(
    { character: snapshotCharacter, code: snapshotCode },
    { code: matrix.code, character: matrix.character, font: matrix.font },
  );
}

/** 现行档案相对某张样张快照的差异字段 */
export function proofDiffFields(p: ProofRecord, matrix: TypeMatrix | undefined): CorrectableField[] {
  if (!matrix || !p.matrixId) return [];
  const snapshotCharacter = p.snapshot?.character ?? (p.targetKind === '字符' ? p.targetRef : '') ?? '';
  const snapshotCode = p.snapshot?.matrixCode ?? '';
  const snapshotFont = p.snapshot?.font ?? '';
  return changedFields(
    { character: snapshotCharacter, code: snapshotCode, font: snapshotFont },
    { code: matrix.code, character: matrix.character, font: matrix.font },
  );
}

/** 差异字段的中文标签拼接，例：「字符、编号」 */
export function diffLabel(fields: CorrectableField[]): string {
  return fields.map((f) => CORRECTION_FIELD_LABELS[f]).join('、');
}
