<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { newPasswordError } from '../../contracts/password';
import { setCsrfToken, v1 } from '../api';

const emit = defineEmits<{ changed: [] }>();
const currentPassword = ref(''), newPassword = ref(''), confirmation = ref('');
const busy = ref(false), error = ref(''), changed = ref(false);
function clearPasswords() { currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; }
async function submit() {
  if (busy.value || changed.value) return;
  error.value = !currentPassword.value ? '请输入当前密码' : newPasswordError(newPassword.value) ?? '';
  if (!error.value && newPassword.value !== confirmation.value) error.value = '两次新密码不一致';
  if (error.value) return;
  busy.value = true;
  try {
    await v1('/api/v1/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: currentPassword.value, newPassword: newPassword.value, confirmation: confirmation.value }) });
    changed.value = true;
    clearPasswords();
    setCsrfToken(null);
    emit('changed');
  } catch (e) {
    error.value = e instanceof Error ? e.message : '密码修改失败，请重试';
  } finally { busy.value = false; }
}
onBeforeUnmount(clearPasswords);
</script>

<template>
  <section class="password-change" aria-label="修改密码">
    <p class="settings-description">修改当前本机账号的密码。成功后会退出此账号的所有登录会话，请使用新密码重新登录；项目、历史记录和已保存的 API Key 不受影响。</p>
    <form v-if="!changed" @submit.prevent="submit">
      <fieldset :disabled="busy">
        <label>当前密码<input v-model="currentPassword" type="password" name="current-password" autocomplete="current-password" required /></label>
        <label>新密码<input v-model="newPassword" type="password" name="new-password" autocomplete="new-password" required aria-describedby="password-policy" /></label>
        <label>确认新密码<input v-model="confirmation" type="password" name="confirm-password" autocomplete="new-password" required /></label>
        <p id="password-policy" class="password-hint">密码非空，最多128个字符，不能包含汉字。不限制字母、数字或符号组合，空格按原样保留。</p>
        <p v-if="error" class="password-error" role="alert">{{ error }}</p>
        <button type="submit" class="btn btn-solid" :disabled="busy">{{ busy ? '正在修改…' : '修改密码并重新登录' }}</button>
      </fieldset>
    </form>
    <p v-else role="status">密码已修改，请使用新密码重新登录。</p>
  </section>
</template>

<style scoped>
.password-change{max-width:620px;min-width:0}.password-change fieldset{display:grid;gap:16px;border:0;padding:0;margin:20px 0 0;min-width:0}.password-change label{display:grid;gap:8px}.password-change input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--fg);font:inherit}.password-change input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.password-hint{margin:0;color:var(--fg-subtle);font-size:var(--text-ui-sm);line-height:1.6}.password-error{margin:0;color:var(--danger)}.password-change button{justify-self:start}.password-change fieldset:disabled{opacity:.7}
</style>
