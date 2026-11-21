// 授权路径安全：规范化→realpath→授权根内校验。软链与越界一律失败，错误不回显绝对路径。
import { realpath } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { join, resolve, sep, isAbsolute, win32 } from 'node:path';

/** Native picker output only. Preserve drive/UNC roots; never trim user directory names. */
export function canonicalDirectory(input: unknown): string {
  if (typeof input !== 'string' || !input || input.length > 16384 || input.includes('\0') || !isAbsolute(input)) throw new PathDenied('目录无效');
  // Windows rooted paths such as \\foo depend on the current drive and are not fully qualified.
  if (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(input)) throw new PathDenied('目录无效');
  const canonical = realpathSync(input);
  if (!isAbsolute(canonical) || !statSync(canonical).isDirectory()) throw new PathDenied('目录无效');
  return canonical;
}

export class PathDenied extends Error {}

/** 规范化相对路径：拒绝绝对路径、`..`与空段；返回以/分隔的安全相对路径。 */
export function normalizeRelative(input: string): string {
  if (!input || input.includes('\0')) throw new PathDenied('路径无效');
  if (isAbsolute(input) || win32.isAbsolute(input) || input.includes(':')) throw new PathDenied('路径无效');
  const parts = input.split(/[\\/]+/).filter(p => p !== '' && p !== '.');
  if (parts.length === 0) throw new PathDenied('路径无效');
  for (const part of parts) {
    if (part === '..') throw new PathDenied('路径无效');
  }
  return parts.join('/');
}

/** 是否位于root相对范围内（lexicographic，用于excludes等可信内部比较；空串=根，包含一切）。 */
export function isInside(rootRelative: string, candidate: string): boolean {
  if (rootRelative === '') return true;
  if (candidate === rootRelative) return true;
  return candidate.startsWith(`${rootRelative}/`);
}

/**
 * 授权内实路径校验：以realpath(root)为基准拼出"无软链期望路径"，再与目标realpath比较——
 * 两者不一致即路径中存在软链（无论是否越界），一律拒绝；realpath越出根外同样拒绝。
 * 这样macOS的/var等系统级软链不会误伤（根本身先归一化）。
 */
export async function resolveWithinGrant(canonicalRoot: string, relativePath: string): Promise<string> {
  const rootReal = await realpath(canonicalRoot);
  const expected = resolve(join(rootReal, relativePath === '.' ? '' : relativePath));
  let targetReal: string;
  try {
    targetReal = await realpath(expected);
  } catch {
    throw new PathDenied('对象不存在或越界');
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep)) {
    throw new PathDenied('对象不存在或越界');
  }
  if (expected !== targetReal) {
    // 期望路径与解析结果不同：根内存在软链，授权内也不经软链读写
    throw new PathDenied('对象不存在或越界');
  }
  return targetReal;
}
