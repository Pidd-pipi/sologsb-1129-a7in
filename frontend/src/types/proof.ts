/** 试印记录（ProofRecord）：单字或整盘试印的压力、用墨与样张评价 */

/** 试印对象类型：单字试印 / 整盘试印 */
export const PROOF_TARGET_KINDS = ['字符', '字盘'] as const;
export type ProofTargetKind = (typeof PROOF_TARGET_KINDS)[number];

/**
 * 试印时字模的字面快照（字符 / 编号 / 字体）。
 * 历史样张保留试印当时的字面，档案更正后据此标出差异，不随档案改写。
 */
export interface ProofSnapshot {
  /** 试印时字模上的字符（当时字面） */
  character: string;
  /** 试印时字模编号 */
  code: string;
  /** 试印时字体 */
  font: string;
}

/** 清晰度评价 */
export const CLARITY_LEVELS = ['清晰', '偏淡', '糊版'] as const;
export type ClarityLevel = (typeof CLARITY_LEVELS)[number];

/** 压力 / 印次合法区间 */
export const PRESSURE_RANGE = { min: 0.5, max: 60 } as const;
export const IMPRESSION_RANGE = { min: 1, max: 999 } as const;

export interface ProofRecord {
  id: string;
  /** 字符或字盘 */
  targetKind: ProofTargetKind;
  /** 字符内容或字盘编号 */
  targetRef: string;
  /** 关联字模 id（整盘试印时可为空） */
  matrixId: string;
  /**
   * 试印当时的字模字面快照。
   * 档案更正后历史样张保留当时字面，并据此与现行档案标出差异；不随更正改写。
   */
  snapshot?: ProofSnapshot;
  /** 压力 kg */
  pressureKg: number;
  /** 用墨 */
  ink: string;
  /** 印次 */
  impressions: number;
  /** 样张编号，用于回溯试印批次 */
  sampleNo: string;
  clarity: ClarityLevel;
  /** 试印日期 YYYY-MM-DD */
  proofDate: string;
  note: string;
  createdAt: string;
}

export interface ProofInput {
  targetKind: ProofTargetKind;
  targetRef: string;
  matrixId: string;
  pressureKg: number;
  ink: string;
  impressions: number;
  sampleNo: string;
  clarity: ClarityLevel;
  proofDate: string;
  note?: string;
}

export function validateProofInput(input: Partial<ProofInput>): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.targetKind) errors.targetKind = '请选择试印对象';
  if (!(input.targetRef || '').trim()) errors.targetRef = '请填写字符或字盘编号';
  const p = Number(input.pressureKg);
  if (!Number.isFinite(p) || p < PRESSURE_RANGE.min || p > PRESSURE_RANGE.max) {
    errors.pressureKg = `压力需在 ${PRESSURE_RANGE.min}–${PRESSURE_RANGE.max} kg 之间`;
  }
  const n = Number(input.impressions);
  if (!Number.isInteger(n) || n < IMPRESSION_RANGE.min || n > IMPRESSION_RANGE.max) {
    errors.impressions = `印次需在 ${IMPRESSION_RANGE.min}–${IMPRESSION_RANGE.max} 之间`;
  }
  if (!(input.ink || '').trim()) errors.ink = '请填写用墨';
  if (!(input.sampleNo || '').trim()) errors.sampleNo = '样张编号不能为空';
  if (!input.clarity) errors.clarity = '请选择清晰度评价';
  const d = (input.proofDate || '').trim();
  if (!d) errors.proofDate = '请填写试印日期';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) errors.proofDate = '日期格式需为 YYYY-MM-DD';
  return errors;
}
