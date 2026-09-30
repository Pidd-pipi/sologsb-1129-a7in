/**
 * 档案更正：预演受影响的盘位与历史记录，并判定历史记录与现行档案的差异。
 *
 * 原则：
 * - 当前格位（CaseSlot.character）随档案更正一起更新，使实物与盘位一致；
 * - 历史缺损 / 试印记录保留登记当时的内容，只标注差异，不拿现行值顶替。
 */

import type { TypeCase } from '../types/case';
import type { DefectLog } from '../types/defect';
import type { MatrixFont, TypeMatrix } from '../types/matrix';
import type { ProofRecord, ProofSnapshot } from '../types/proof';

/** 允许更正的档案身份字段：字模编号、字符、字体 */
export interface IdentityPatch {
  code?: string;
  character?: string;
  font?: MatrixFont;
}

export type IdentityField = 'code' | 'character' | 'font';

/** 将要随更正更新的盘位（当前格位） */
export interface SlotChange {
  caseId: string;
  caseCode: string;
  caseKind: string;
  workStation: string;
  row: number;
  col: number;
  /** 格位上的原字符 */
  before: string;
  /** 更正后格位字符 */
  after: string;
}

/** 历史记录的受影响情况：保留当时内容，仅标注差异 */
export interface RecordChange<T> {
  record: T;
  /** 登记当时留存的字符 / 编号 */
  before: { character: string; code: string };
  /** 更正后的现行字符 / 编号（用于对照，不写回记录） */
  after: { character: string; code: string };
  /** 与现行档案是否存在差异 */
  diff: boolean;
}

export interface CorrectionPreview {
  matrixId: string;
  before: { code: string; character: string; font: string };
  after: { code: string; character: string; font: string };
  changedFields: IdentityField[];
  /** 受影响的当前格位（会被更新） */
  slots: SlotChange[];
  /** 受影响的缺损记录（保留当时内容，仅标注差异） */
  defects: Array<RecordChange<DefectLog>>;
  /** 受影响的试印样张（保留当时字面，仅标注差异） */
  proofs: Array<RecordChange<ProofRecord>>;
  hasChanges: boolean;
}

/** 格位号，例：A3 */
export function slotLabel(row: number, col: number): string {
  return `${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[row] ?? row + 1}${col + 1}`;
}

/** 取试印记录的字面快照；历史数据无快照时回退到记录自身登记的字符（不读字模现行值） */
export function proofSnapshotOf(p: ProofRecord): ProofSnapshot {
  if (p.snapshot) return p.snapshot;
  return {
    character: p.targetKind === '字符' ? (p.targetRef ?? '') : '',
    code: '',
    font: '',
  };
}

/** 试印样张留存的字面与现行字模是否不同（无快照编号时只比对字符） */
export function isProofDiff(p: ProofRecord, matrix: TypeMatrix | undefined): boolean {
  if (!matrix) return false;
  const snap = proofSnapshotOf(p);
  if (!snap.character) return false;
  if (snap.character !== matrix.character) return true;
  return Boolean(snap.code) && snap.code !== matrix.code;
}

/** 缺损记录留存的字符 / 编号与现行字模是否不同 */
export function isDefectDiff(d: DefectLog, matrix: TypeMatrix | undefined): boolean {
  if (!matrix) return false;
  return d.character !== matrix.character || d.matrixCode !== matrix.code;
}

/**
 * 预演一次档案更正：只计算受影响范围，不写入任何数据。
 */
export function buildCorrectionPreview(
  matrix: TypeMatrix,
  cases: TypeCase[],
  defects: DefectLog[],
  proofs: ProofRecord[],
  patch: IdentityPatch,
): CorrectionPreview {
  const before = { code: matrix.code, character: matrix.character, font: matrix.font };
  const after = {
    code: (patch.code ?? matrix.code).trim(),
    character: (patch.character ?? matrix.character).trim(),
    font: patch.font ?? matrix.font,
  };
  const changedFields = (['code', 'character', 'font'] as IdentityField[]).filter(
    (f) => after[f] !== before[f],
  );

  const slots: SlotChange[] = [];
  for (const c of cases) {
    for (const s of c.slots) {
      if (s.matrixId !== matrix.id) continue;
      slots.push({
        caseId: c.id,
        caseCode: c.code,
        caseKind: c.kind,
        workStation: c.workStation,
        row: s.row,
        col: s.col,
        before: s.character,
        after: after.character,
      });
    }
  }

  const toRecordChange = <T extends { character?: string; matrixCode?: string }>(
    rec: T,
    bCharacter: string,
    bCode: string,
  ): RecordChange<T> => ({
    record: rec,
    before: { character: bCharacter, code: bCode },
    after: { character: after.character, code: after.code },
    diff: bCharacter !== after.character || bCode !== after.code,
  });

  const defectChanges = defects
    .filter((d) => d.matrixId === matrix.id)
    .map((d) => toRecordChange(d, d.character, d.matrixCode));

  const proofChanges = proofs
    .filter((p) => p.matrixId === matrix.id)
    .map((p) => {
      const snap = proofSnapshotOf(p);
      const diff =
        Boolean(snap.character) &&
        (snap.character !== after.character ||
          (Boolean(snap.code) && snap.code !== after.code));
      return {
        record: p,
        before: { character: snap.character, code: snap.code },
        after: { character: after.character, code: after.code },
        diff,
      };
    });

  return {
    matrixId: matrix.id,
    before,
    after,
    changedFields,
    slots,
    defects: defectChanges,
    proofs: proofChanges,
    hasChanges: changedFields.length > 0,
  };
}
