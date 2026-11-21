// 密码散列：crypto.scrypt，随机salt16字节，N=16384/r=8/p=1，key64字节；
// 参数随hash保存，比较用 timingSafeEqual（数据与接口.md 身份协议）。
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export interface PasswordParams { N: number; r: number; p: number }
export const DEFAULT_PARAMS: PasswordParams = { N: 16384, r: 8, p: 1 };

export interface PasswordRecord {
  hash: string;       // hex
  salt: string;       // hex
  paramsJson: string; // JSON PasswordParams
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const params = DEFAULT_PARAMS;
  const key = await scryptAsync(password, salt, 64, { ...params, maxmem: 256 * 1024 * 1024 });
  return { hash: key.toString('hex'), salt: salt.toString('hex'), paramsJson: JSON.stringify(params) };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  let params: PasswordParams;
  try { params = JSON.parse(record.paramsJson) as PasswordParams; } catch { return false; }
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
  const key = await scryptAsync(password, Buffer.from(record.salt, 'hex'), 64, { ...params, maxmem: 256 * 1024 * 1024 });
  const expected = Buffer.from(record.hash, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}
