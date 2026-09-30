/** 档案更正（Correction）：字模编号 / 字符 / 字体录错后的可预演更正留痕 */
import type { MatrixFont } from './matrix';

/** 允许更正的字段：字模编号、字符、字体（其余字段仍走普通编辑） */
export const CORRECTABLE_FIELDS = ['code', 'character', 'font'] as const;
export type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

export const CORRECTION_FIELD_LABELS: Record<CorrectableField, string> = {
  code: '字模编号',
  character: '字符',
  font: '字体',
};

/** 一次更正中某个字段的前值 → 后值 */
export interface FieldChange {
  field: CorrectableField;
  label: string;
  before: string;
  after: string;
}

/** 更正人在提交前填写的更正内容 */
export interface CorrectionInput {
  code: string;
  character: string;
  font: MatrixFont;
  /** 更正原因 */
  reason: string;
  /** 经办人 */
  operator: string;
}

/** 更正台账：每次档案更正都留一条，便于回溯「谁在什么时候把什么改成了什么」 */
export interface CorrectionLog {
  id: string;
  /** 关联字模 id（字模删除时一并删除） */
  matrixId: string;
  /** 变更明细 */
  changes: FieldChange[];
  reason: string;
  operator: string;
  /** 提交所基于的档案版本号 */
  baseRev: number;
  /** 提交后的档案版本号 */
  nextRev: number;
  /** 受影响的字盘格位（仅记录定位信息，字符以现行档案为准） */
  affectedSlots: Array<{
    caseId: string;
    caseCode: string;
    row: number;
    col: number;
    before: string;
    after: string;
  }>;
  /** 当时保留旧字面、未被改动的历史样张编号 */
  proofSampleNos: string[];
  /** 当时保留旧登记值、未被改动的缺损记录编号（内部 id） */
  defectIds: string[];
  createdAt: string;
}

/** 预演结果中的受影响格位 */
export interface ImpactedSlot {
  caseId: string;
  caseCode: string;
  kind: string;
  workStation: string;
  row: number;
  col: number;
  /** 格位上当前登记的字符 */
  before: string;
  /** 更正后将显示的字符 */
  after: string;
  /** 格位字符与现行档案是否已经不一致（历史脏数据） */
  stale: boolean;
}

/** 预演结果中的历史记录（缺损 / 样张） */
export interface ImpactedHistory {
  defects: Array<{
    id: string;
    /** 登记时的字符快照（没有快照时取该记录自身冗余值，即原登记值） */
    snapshotCharacter: string;
    snapshotCode: string;
    foundDate: string;
    summary: string;
    /** 旧登记值与本次更正后的现行值是否存在差异 */
    differs: boolean;
    diffFields: CorrectableField[];
  }>;
  proofs: Array<{
    id: string;
    sampleNo: string;
    proofDate: string;
    targetKind: string;
    /** 样张保留的当时字面 */
    snapshotCharacter: string;
    snapshotCode: string;
    snapshotFont: string;
    /** 旧字面与本次更正后的现行值是否存在差异 */
    differs: boolean;
    diffFields: CorrectableField[];
  }>;
}

/** 一次更正预演的完整结果（只读，不落库） */
export interface CorrectionPreview {
  matrixId: string;
  baseRev: number;
  changes: FieldChange[];
  slots: ImpactedSlot[];
  history: ImpactedHistory;
  /** 与现行档案完全一致、没有任何字段要改 */
  noop: boolean;
}

/**
 * 并发冲突：后提交一方打开页面后，该字模已被另一标签页更正过（rev 变大）。
 * 携带三方值，供页面提示核对差异后再决定是否按新版本重新提交。
 */
export interface FieldConflict {
  field: CorrectableField;
  label: string;
  /** 本方打开时看到的值（旧版档案） */
  base: string;
  /** 本方这次提交想要改成的值 */
  theirs: string;
  /** 他方已经落库的最新值 */
  current: string;
  /** 本方拟改值与他方最新值是否仍不同（不同则需要再核对） */
  needReview: boolean;
}

export class CorrectionConflictError extends Error {
  matrixId: string;
  baseRev: number;
  currentRev: number;
  conflicts: FieldConflict[];

  constructor(matrixId: string, baseRev: number, currentRev: number, conflicts: FieldConflict[]) {
    super('该字模档案刚被另一处更正（版本已更新），请先核对差异再提交');
    this.name = 'CorrectionConflictError';
    this.matrixId = matrixId;
    this.baseRev = baseRev;
    this.currentRev = currentRev;
    this.conflicts = conflicts;
  }
}

/** 更正表单校验：只校验可更正三字段与经办人 / 原因 */
export function validateCorrectionInput(input: Partial<CorrectionInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  const ch = (input.character || '').trim();
  if (!ch) errors.character = '请填写或从字符选择器中选取一个字符';
  else if (Array.from(ch).length > 1) errors.character = '一次只能登记一个字符';
  if (!(input.code || '').trim()) errors.code = '字模编号不能为空';
  if (!input.font) errors.font = '请选择字体';
  if (!(input.reason || '').trim()) errors.reason = '请填写更正原因，留痕备查';
  if (!(input.operator || '').trim()) errors.operator = '请填写经办人';
  return errors;
}
