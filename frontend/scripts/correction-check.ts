/**
 * 档案更正端到端逻辑验证（Node + fake-indexeddb）：
 * 1. v3 旧库（含「已录错」数据）升级到 v4：历史样张 / 缺损必须按【原登记值】回填快照；
 * 2. 预演只读、不落库；
 * 3. 提交更正：字盘格位跟随改、rev+1、历史样张保留旧字面并能标出差异；
 * 4. 两个标签页改同一枚：后提交方拿旧 rev 必须被拦（不覆盖第一次结果）。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import Dexie from 'dexie';

async function main() {
  // ---------- 1) 造一个 v3 时代的旧库 ----------
  const dbName = 'gbmovabletype-db';
  const old = new Dexie(dbName);
  old.version(1).stores({ matrices: 'id, code, character, font, sizeName, material, availability' });
  old.version(2).stores({
    matrices: 'id, code, character, font, sizeName, material, availability',
    cases: 'id, code, kind, workStation, *matrixId',
  });
  old.version(3).stores({
    matrices: 'id, code, character, font, sizeName, material, availability',
    cases: 'id, code, kind, workStation, *matrixId',
    defects: 'id, matrixId, defectType, severity, availability, foundDate',
    proofs: 'id, matrixId, sampleNo, clarity, proofDate',
  });

  // 字模实物是「墨」，但样张 / 缺损登记时档案写成了「默」（编号也录错过）
  await old.table('matrices').bulkPut([
    {
      id: 'm-1', code: 'ZM-1988-011', character: '墨', font: '宋体', sizeName: '五号', sizePt: 10.5,
      material: '铅合金', faceWidthMm: 3.6, bodyHeightMm: 5.5, madeYear: 1988, engraver: '陈之安',
      availability: '可用', note: '', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z',
    },
  ]);
  await old.table('cases').bulkPut([
    {
      id: 'case-1', code: 'ZP-A-01', kind: '常用字盘', rows: 4, cols: 4, workStation: '一号工位',
      slots: [{ row: 0, col: 0, character: '墨', matrixId: 'm-1', placedAt: '2025-01-02T00:00:00Z' }],
      matrixId: ['m-1'], createdAt: '2025-01-02T00:00:00Z', updatedAt: '2025-01-02T00:00:00Z',
    },
  ]);
  await old.table('defects').bulkPut([
    {
      id: 'd-1', matrixId: 'm-1', character: '默', matrixCode: 'ZM-1988-099',
      defectType: '缺笔', severity: '重', foundDate: '2025-04-02', handling: '当时按「默」登记',
      availability: '可用', operator: '李墨林', note: '', createdAt: '2025-04-02T00:00:00Z',
    },
  ]);
  await old.table('proofs').bulkPut([
    {
      id: 'p-1', targetKind: '字符', targetRef: '默', matrixId: 'm-1', pressureKg: 14,
      ink: '油烟墨 101', impressions: 25, sampleNo: 'YZ-20250513-01', clarity: '糊版',
      proofDate: '2025-05-13', note: '', createdAt: '2025-05-13T00:00:00Z',
    },
  ]);
  await old.close();

  // ---------- 2) 以当前代码打开（触发 v3 → v4 升级） ----------
  const { db } = await import('../src/db/index');
  const m1 = await db.matrices.get('m-1');
  assert.equal(m1.rev, 1, 'v4 升级后字模补 rev=1');

  const d1 = await db.defects.get('d-1');
  assert.deepEqual(
    d1.snapshot,
    { character: '默', matrixCode: 'ZM-1988-099' },
    '缺损快照必须按记录自身的原登记值回填，不能用现行值「墨 / ZM-1988-011」顶替',
  );
  const p1 = await db.proofs.get('p-1');
  assert.deepEqual(
    p1.snapshot,
    { character: '默', matrixCode: '', font: '' },
    '样张快照字符按当时 targetRef 回填；编号/字体旧版未登记则留空，不得用现行值补',
  );

  // ---------- 3) 纯函数预演（不写库） ----------
  const { previewCorrection } = await import('../src/utils/correction');
  const cases = await db.cases.toArray();
  const defects = await db.defects.toArray();
  const proofs = await db.proofs.toArray();
  const input = { code: 'ZM-1988-011', character: '墨', font: '宋体' as const, reason: '核对实物', operator: '王馆员' };
  const preview = previewCorrection(m1, input, cases, defects, proofs);
  assert.equal(preview.noop, true, '现行档案已为「墨/ZM-1988-011/宋体」，预演应判定无字段变化');
  assert.deepEqual(preview.changes.map((c) => c.field), [], '相对现行值无字段变化（旧差异只体现在历史记录）');
  assert.equal(preview.history.proofs[0].snapshotCharacter, '默');
  assert.ok(preview.history.proofs[0].differs, '样张保留旧字面「默」，相对现行「墨」应标出差异');
  assert.deepEqual(preview.history.proofs[0].diffFields, ['character']);
  assert.ok(preview.history.defects[0].differs, '缺损旧编号/旧字符应标出差异');

  // 真正要改的场景：实物核对发现编号应为 ZM-1988-900，字体应为楷体
  const input2 = { code: 'ZM-1988-900', character: '墨', font: '楷体' as const, reason: '实物核对', operator: '王馆员' };
  const preview2 = previewCorrection(m1, input2, cases, defects, proofs);
  assert.deepEqual(preview2.changes.map((c) => c.field), ['code', 'font']);
  const slot = preview2.slots[0];
  assert.equal(slot.before, '墨');
  assert.equal(slot.after, '墨');
  assert.equal(slot.caseCode, 'ZP-A-01');
  assert.equal(slot.stale, false);

  // 预演不得写库
  const untouched = await db.matrices.get('m-1');
  assert.equal(untouched.code, 'ZM-1988-011');

  // ---------- 4) 初始化 zustand store 并提交更正 ----------
  const { useMatrixStore } = await import('../src/stores/matrixStore');
  const { useCaseStore } = await import('../src/stores/caseStore');
  await useMatrixStore.getState().load();
  await useCaseStore.getState().load();

  // 字符更正：墨 → 嘿（模拟实物实为「嘿」的更正），格位应跟随
  const input3 = { code: 'ZM-1988-900', character: '嘿', font: '楷体' as const, reason: '实物核对为嘿', operator: '王馆员' };
  await useMatrixStore.getState().applyCorrection({
    matrixId: 'm-1',
    baseRev: 1,
    base: { code: 'ZM-1988-011', character: '墨', font: '宋体' },
    input: input3,
  });

  const after = await db.matrices.get('m-1');
  assert.equal(after.character, '嘿');
  assert.equal(after.rev, 2, '更正后 rev +1');
  const caseAfter = await db.cases.get('case-1');
  assert.equal(caseAfter.slots[0].character, '嘿', '当前格位必须跟随更新为新字符');
  assert.deepEqual(caseAfter.matrixId, ['m-1']);

  // 历史样张不动：targetRef 与 snapshot 都保留旧字面
  const p1After = await db.proofs.get('p-1');
  assert.equal(p1After.targetRef, '默');
  assert.equal(p1After.snapshot.character, '默', '旧样张保留当时字面，不被现行值顶替');
  const d1After = await db.defects.get('d-1');
  assert.equal(d1After.snapshot.character, '默');
  assert.equal(d1After.character, '默', '缺损记录正文冗余值也保留登记时旧值');

  const corr = await db.corrections.toArray();
  assert.equal(corr.length, 1);
  assert.equal(corr[0].affectedSlots.length, 1);
  assert.equal(corr[0].nextRev, 2);

  // store 同步：caseStore 格位也是新字符
  const inStore = useCaseStore.getState().cases.find((c) => c.id === 'case-1');
  assert.equal(inStore?.slots[0].character, '嘿');

  // ---------- 5) 并发：另一标签页基于旧 rev 提交，必须被拦 ----------
  await assert.rejects(
    useMatrixStore.getState().applyCorrection({
      matrixId: 'm-1',
      baseRev: 1, // 旧版本
      base: { code: 'ZM-1988-011', character: '墨', font: '宋体' },
      input: { code: 'ZM-1988-777', character: '墨', font: '宋体', reason: '他页晚提交', operator: '另一人' },
    }),
    (err: unknown) => {
      const e = err as import('../src/types/correction').CorrectionConflictError;
      assert.equal(e.name, 'CorrectionConflictError');
      assert.equal(e.currentRev, 2);
      assert.ok(e.conflicts.length > 0);
      return true;
    },
    '后提交方必须收到并发冲突错误，第一次更正结果不得被覆盖',
  );

  // 被拦后库里仍是第一次的结果
  const guarded = await db.matrices.get('m-1');
  assert.equal(guarded.character, '嘿');
  assert.equal(guarded.rev, 2, '冲突回滚：rev 不得增长');
  const corrCount = await db.corrections.count();
  assert.equal(corrCount, 1, '冲突回滚：不得留下更正台账');

  // 基于最新 rev 重新提交则成功
  await useMatrixStore.getState().applyCorrection({
    matrixId: 'm-1',
    baseRev: 2,
    base: { code: 'ZM-1988-900', character: '嘿', font: '楷体' },
    input: { code: 'ZM-1988-900', character: '嘿', font: '仿宋', reason: '核对差异后改字体', operator: '另一人' },
  });
  assert.equal((await db.matrices.get('m-1')).rev, 3);
  assert.equal((await db.matrices.get('m-1')).font, '仿宋');

  // 新登记的缺损 / 样张必须固化当时快照
  await useMatrixStore.getState().addDefect({
    matrixId: 'm-1', defectType: '磨损', severity: '轻', foundDate: '2026-09-30',
    handling: '例行检查', availability: '可用', operator: '王馆员', note: '',
  });
  const dNew = (await db.defects.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
  assert.deepEqual(dNew.snapshot, { character: '嘿', matrixCode: 'ZM-1988-900' });

  await useMatrixStore.getState().addProof({
    targetKind: '字符', targetRef: '嘿', matrixId: 'm-1', pressureKg: 12, ink: '松烟墨 08',
    impressions: 20, sampleNo: 'YZ-20260930-01', clarity: '清晰', proofDate: '2026-09-30', note: '',
  });
  const pNew = (await db.proofs.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)!;
  assert.deepEqual(pNew.snapshot, { character: '嘿', matrixCode: 'ZM-1988-900', font: '仿宋' });

  console.log('全部更正逻辑验证通过 ✔');
  await db.close();
}

main().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});
