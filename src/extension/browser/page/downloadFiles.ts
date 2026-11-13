// Moving a finished download out of the staging folder. Node only (no vscode), so it is unit-tested.
import { constants } from 'node:fs';
import { copyFile, link, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { candidateNames } from './downloadLogic';

/**
 * Moves a file into `folder` as `name`, or "name (1)", "name (2)" ... when taken. Never replaces an
 * existing file: a hard link fails if the name exists; across file systems an exclusive copy does.
 */
export async function moveUnique(source: string, folder: string, name: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  for (const candidate of candidateNames(name)) {
    const dest = join(folder, candidate);
    try {
      await link(source, dest);
    } catch (err: any) {
      if (err?.code === 'EEXIST') continue;
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EACCES'].includes(err?.code)) throw err;
      try {
        await copyFile(source, dest, constants.COPYFILE_EXCL);
      } catch (copyErr: any) {
        if (copyErr?.code === 'EEXIST') continue;
        throw copyErr;
      }
    }
    await unlink(source).catch(() => undefined);
    return dest;
  }
  throw new Error(`too many files named like ${name} in ${folder}`);
}
