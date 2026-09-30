/**
 * 跨标签页档案同步：
 * IndexedDB 的提交本身由「提交时重读 + rev 乐观锁」保证不互相覆盖；
 * 这里只负责让其他已打开的标签页尽快看到最新档案，
 * 通过同源 localStorage 的 storage 事件做一次轻通知（只传信号，不传数据；
 * 数据一律重新从 IndexedDB 读，保证看到的是库里的现行值）。
 */

const CHANNEL_KEY = 'gbmovabletype-archive-changed';

/** 本标签页写库后通知其他标签页重读档案（本页不响应自己的 storage 事件） */
export function notifyArchiveChanged(matrixId: string): void {
  try {
    localStorage.setItem(CHANNEL_KEY, `${matrixId}#${Date.now()}`);
  } catch {
    /* localStorage 不可用时静默：跨页提示降级，提交时的 rev 校验仍然生效 */
  }
}

/** 订阅其他标签页的档案变更通知；返回取消订阅函数 */
export function subscribeArchiveChanged(listener: (matrixId: string) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== CHANNEL_KEY || !e.newValue) return;
    listener(e.newValue.split('#')[0] ?? '');
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
