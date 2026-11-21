/** 新密码不限制字符组合；保留非空、输入上限与用户指定的汉字限制。 */
export function newPasswordError(password: string): string | null {
  if (!password.length) return '请输入密码';
  if (Array.from(password).length > 128) return '密码最多128个字符';
  if (/\p{Script=Han}/u.test(password)) return '密码不能包含汉字';
  return null;
}
