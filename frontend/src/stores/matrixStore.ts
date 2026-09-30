import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { CorrectionInput, CorrectionLog } from '../types/correction';
import {
  CorrectionConflictError,
  CORRECTION_FIELD_LABELS,
  CORRECTABLE_FIELDS,
  type CorrectableField,
  type FieldConflict,
} from '../types/correction';
import type { DefectInput, DefectLog } from '../types/defect';
import { shouldDisableMatrix } from '../types/defect';
import type { MatrixInput, TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type { ProofInput, ProofRecord } from '../types/proof';
import { useCaseStore } from './caseStore';
import { matrixIdsOf } from '../utils/layout';
import { notifyArchiveChanged } from '../utils/crossTab';
import { makeId, toPlain, todayStr } from '../utils/format';

/** 提交更正时携带的三方信息：打开时看到的值 + 版本号 + 拟改内容 */
export interface ApplyCorrectionArgs {
  matrixId: string;
  baseRev: number;
  base: Record<CorrectableField, string>;
  input: CorrectionInput;
}

interface MatrixState {
  matrices: TypeMatrix[];
  defects: DefectLog[];
  proofs: ProofRecord[];
  corrections: CorrectionLog[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  /** 冲突后从本机库重新读回最新档案（不改 loading 标记） */
  refreshArchive: () => Promise<void>;
  createMatrix: (input: MatrixInput) => Promise<TypeMatrix>;
  updateMatrix: (id: string, patch: Partial<TypeMatrix>) => Promise<void>;
  removeMatrix: (id: string) => Promise<void>;
  addDefect: (input: DefectInput) => Promise<DefectLog>;
  repairMatrix: (matrixId: string, operator: string) => Promise<void>;
  addProof: (input: ProofInput) => Promise<ProofRecord>;
  /** 档案更正：字模编号 / 字符 / 字体录错后的带留痕更正（当前格位跟随改、历史记录保留旧值） */
  applyCorrection: (args: ApplyCorrectionArgs) => Promise<CorrectionLog>;
}

const byUpdatedDesc = (a: TypeMatrix, b: TypeMatrix) => (a.updatedAt < b.updatedAt ? 1 : -1);

export const useMatrixStore = create<MatrixState>((set, get) => ({
  matrices: [],
  defects: [],
  proofs: [],
  corrections: [],
  loaded: false,
  loading: false,
  error: '',

  /** 首次进入时写入示例档案并读回全部数据 */
  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [matrices, defects, proofs, corrections] = await Promise.all([
        db.matrices.toArray(),
        db.defects.toArray(),
        db.proofs.toArray(),
        db.corrections.toArray(),
      ]);
      set({
        matrices: matrices.sort(byUpdatedDesc),
        defects,
        proofs,
        corrections,
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '本地档案读取失败' });
    }
  },

  /** 从本机库重新读回字模 / 缺损 / 样张 / 更正台账，并同步字盘 store 的格位 */
  refreshArchive: async () => {
    const [matrices, defects, proofs, corrections, cases] = await Promise.all([
      db.matrices.toArray(),
      db.defects.toArray(),
      db.proofs.toArray(),
      db.corrections.toArray(),
      db.cases.toArray(),
    ]);
    set({
      matrices: matrices.sort(byUpdatedDesc),
      defects,
      proofs,
      corrections,
      loaded: true,
    });
    useCaseStore.setState({
      cases: cases.sort((a, b) => (a.code < b.code ? -1 : 1)),
    });
  },

  createMatrix: async (input) => {
    const now = new Date().toISOString();
    const row: TypeMatrix = toPlain({
      id: makeId('mtx'),
      code: input.code.trim(),
      character: input.character.trim(),
      font: input.font,
      sizeName: input.sizeName,
      sizePt: ptOfSize(input.sizeName),
      material: input.material,
      faceWidthMm: Number(input.faceWidthMm),
      bodyHeightMm: Number(input.bodyHeightMm),
      madeYear: Number(input.madeYear),
      engraver: input.engraver.trim(),
      availability: '可用' as const,
      note: (input.note ?? '').trim(),
      rev: 1,
      createdAt: now,
      updatedAt: now,
    });
    await db.matrices.add(row);
    set((s) => ({ matrices: [row, ...s.matrices] }));
    return row;
  },

  updateMatrix: async (id, patch) => {
    const plain = toPlain(patch);
    const next: Partial<TypeMatrix> = { ...plain, updatedAt: new Date().toISOString() };
    if (plain.sizeName) next.sizePt = ptOfSize(plain.sizeName);
    await db.matrices.update(id, next);
    set((s) => ({
      matrices: s.matrices
        .map((m) => (m.id === id ? { ...m, ...next } : m))
        .sort(byUpdatedDesc),
    }));
  },

  removeMatrix: async (id) => {
    await db.transaction(
      'rw',
      db.matrices,
      db.defects,
      db.proofs,
      db.corrections,
      async () => {
        await db.matrices.delete(id);
        const defectIds = (await db.defects.where('matrixId').equals(id).toArray()).map((d) => d.id);
        const proofIds = (await db.proofs.where('matrixId').equals(id).toArray()).map((p) => p.id);
        await db.defects.bulkDelete(defectIds);
        await db.proofs.bulkDelete(proofIds);
        await db.corrections.where('matrixId').equals(id).delete();
      },
    );
    set((s) => ({
      matrices: s.matrices.filter((m) => m.id !== id),
      defects: s.defects.filter((d) => d.matrixId !== id),
      proofs: s.proofs.filter((p) => p.matrixId !== id),
      corrections: s.corrections.filter((c) => c.matrixId !== id),
    }));
  },

  /** 登记缺损：写入缺损记录（含登记时快照），并按结论自动停用字模 */
  addDefect: async (input) => {
    const matrix = get().matrices.find((m) => m.id === input.matrixId);
    if (!matrix) throw new Error('未找到对应字模，无法登记缺损');
    const row: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId: input.matrixId,
      character: matrix.character,
      matrixCode: matrix.code,
      defectType: input.defectType,
      severity: input.severity,
      foundDate: input.foundDate || todayStr(),
      handling: input.handling.trim(),
      availability: input.availability,
      operator: input.operator.trim(),
      note: (input.note ?? '').trim(),
      snapshot: {
        character: matrix.character,
        matrixCode: matrix.code,
      },
      createdAt: new Date().toISOString(),
    });
    await db.defects.add(row);
    set((s) => ({ defects: [row, ...s.defects] }));
    if (shouldDisableMatrix(input.availability)) {
      await get().updateMatrix(input.matrixId, { availability: input.availability });
    }
    return row;
  },

  /** 补刻完成：恢复可用，并留下一条收尾记录 */
  repairMatrix: async (matrixId, operator) => {
    const matrix = get().matrices.find((m) => m.id === matrixId);
    if (!matrix) throw new Error('未找到对应字模，无法补刻');
    const history = get()
      .defects.filter((d) => d.matrixId === matrixId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const last = history[0];
    const row: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId,
      character: matrix.character,
      matrixCode: matrix.code,
      defectType: last?.defectType ?? '磨损',
      severity: last?.severity ?? '轻',
      foundDate: todayStr(),
      handling: `补刻完成，字面复测合格（原处理：${last?.handling ?? '未记录'}）`,
      availability: '可用' as const,
      operator: operator.trim() || '补刻工',
      note: '补刻收尾记录',
      snapshot: {
        character: matrix.character,
        matrixCode: matrix.code,
      },
      createdAt: new Date().toISOString(),
    });
    await db.defects.add(row);
    set((s) => ({ defects: [row, ...s.defects] }));
    await get().updateMatrix(matrixId, { availability: '可用' });
  },

  addProof: async (input) => {
    const matrix = input.matrixId ? get().matrices.find((m) => m.id === input.matrixId) : undefined;
    const targetRef = input.targetRef.trim();
    const row: ProofRecord = toPlain({
      id: makeId('pfr'),
      targetKind: input.targetKind,
      targetRef,
      matrixId: input.matrixId,
      pressureKg: Number(input.pressureKg),
      ink: input.ink.trim(),
      impressions: Number(input.impressions),
      sampleNo: input.sampleNo.trim(),
      clarity: input.clarity,
      proofDate: input.proofDate || todayStr(),
      note: (input.note ?? '').trim(),
      // 样张留档的是「当时字面」：登记瞬间固化字模编号 / 字符 / 字体快照
      snapshot:
        matrix && input.targetKind === '字符'
          ? {
              character: targetRef || matrix.character,
              matrixCode: matrix.code,
              font: matrix.font,
            }
          : { character: '', matrixCode: '', font: '' },
      createdAt: new Date().toISOString(),
    });
    await db.proofs.add(row);
    set((s) => ({ proofs: [row, ...s.proofs] }));
    return row;
  },

  applyCorrection: async ({ matrixId, baseRev, base, input }) => {
    const desired: Record<CorrectableField, string> = {
      code: input.code.trim(),
      character: input.character.trim(),
      font: input.font,
    };

    let log: CorrectionLog | null = null;
    await db.transaction(
      'rw',
      db.matrices,
      db.cases,
      db.defects,
      db.proofs,
      db.corrections,
      async () => {
        // 事务内重读，保证拿到的是他标签页提交后的最新版本
        const current = await db.matrices.get(matrixId);
        if (!current) throw new Error('未找到对应字模，无法更正');

        if (current.rev !== baseRev) {
          const currentValues: Record<CorrectableField, string> = {
            code: current.code,
            character: current.character,
            font: current.font,
          };
          const conflicts: FieldConflict[] = CORRECTABLE_FIELDS.map((field) => ({
            field,
            label: CORRECTION_FIELD_LABELS[field],
            base: base[field] ?? '',
            theirs: desired[field],
            current: currentValues[field],
            needReview: desired[field] !== currentValues[field],
          })).filter((c) => c.base !== c.current || c.theirs !== c.current);
          throw new CorrectionConflictError(matrixId, baseRev, current.rev, conflicts);
        }

        const changes = CORRECTABLE_FIELDS.filter(
          (field) => String(current[field] ?? '') !== desired[field],
        ).map((field) => ({
          field,
          label: CORRECTION_FIELD_LABELS[field],
          before: String(current[field] ?? ''),
          after: desired[field],
        }));
        if (changes.length === 0) throw new Error('档案与现行内容一致，没有需要更正的字段');

        const now = new Date().toISOString();
        const nextRev = current.rev + 1;
        await db.matrices.update(matrixId, {
          code: desired.code,
          character: desired.character,
          font: desired.font as TypeMatrix['font'],
          rev: nextRev,
          updatedAt: now,
        });

        // 当前格位跟着改：同一事务内同步所有字盘上该字模格位的字符
        const affectedSlots: CorrectionLog['affectedSlots'] = [];
        const allCases = await db.cases.toArray();
        for (const c of allCases) {
          let touched = false;
          const nextSlots = c.slots.map((s) => {
            if (s.matrixId !== matrixId) return s;
            touched = true;
            affectedSlots.push({
              caseId: c.id,
              caseCode: c.code,
              row: s.row,
              col: s.col,
              before: s.character,
              after: desired.character,
            });
            return { ...s, character: desired.character };
          });
          if (touched) {
            await db.cases.update(c.id, {
              slots: toPlain(nextSlots),
              matrixId: matrixIdsOf(nextSlots),
              updatedAt: now,
            });
          }
        }

        // 缺损记录与试印样张刻意不改：保留登记时的旧字面 / 旧编号，差异在界面标注
        const relatedDefects = await db.defects.where('matrixId').equals(matrixId).toArray();
        const relatedProofs = await db.proofs.where('matrixId').equals(matrixId).toArray();

        log = toPlain({
          id: makeId('cor'),
          matrixId,
          changes,
          reason: input.reason.trim(),
          operator: input.operator.trim(),
          baseRev,
          nextRev,
          affectedSlots,
          proofSampleNos: relatedProofs.map((p) => p.sampleNo),
          defectIds: relatedDefects.map((d) => d.id),
          createdAt: now,
        } satisfies CorrectionLog);
        await db.corrections.add(log);
      },
    );

    if (!log) throw new Error('更正未完成');
    // 提交成功后全量同步两个 store，保证当前标签页格位立刻显示新字符
    await get().refreshArchive();
    // 通知其他标签页重读（数据仍以 IndexedDB 现行值为准）
    notifyArchiveChanged(matrixId);
    return log;
  },
}));

/** 单条字模（组件内使用，避免整表订阅） */
export function selectMatrix(id: string) {
  return (s: MatrixState) => s.matrices.find((m) => m.id === id);
}
