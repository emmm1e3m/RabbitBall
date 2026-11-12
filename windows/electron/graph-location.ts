import { cp, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

async function directoryExists(directory: string): Promise<boolean> {
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error(`知识图谱路径不是文件夹：${directory}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 先完整复制再切换目录；旧库只作为备份保留，不合并或覆盖已经存在的新库。 */
export async function resolveGraphDirectory(userData: string, documents: string): Promise<string> {
  const destination = path.resolve(documents, 'RabbitBall', '知识图谱');
  if (await directoryExists(destination)) return destination;
  const legacy = path.resolve(userData, 'knowledge');
  const hasLegacy = await directoryExists(legacy);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  if (!hasLegacy) {
    await mkdir(destination);
    return destination;
  }

  const staging = await mkdtemp(path.join(parent, '.knowledge-migration-'));
  const copied = path.join(staging, 'knowledge');
  try {
    await cp(legacy, copied, { recursive: true, force: false, errorOnExist: true });
    // 迁移期间若用户建立了新库，也以新库为准，不覆盖它。
    if (!(await directoryExists(destination))) await rename(copied, destination);
    return destination;
  } catch (error) {
    throw new Error(`无法迁移知识图谱，原文件仍保存在 ${legacy}。${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
