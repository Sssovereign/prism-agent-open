<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { v1, setCsrfToken } from './api';
import PrismLogo from './components/PrismLogo.vue';
import PrismMeaning from './components/PrismMeaning.vue';
import { PRISM_PROMISE } from './brand';
import { newPasswordError } from '../contracts/password';

const emit = defineEmits<{ (e: 'authenticated', user: { username: string }): void }>();
const username = ref(''), password = ref(''), confirmation = ref(''), error = ref(''), busy = ref(false);
const creating = ref(false), checking = ref(true), remember = ref(true);
const passwordVisible = ref(false), usernameInput = ref<HTMLInputElement>();
const canSubmit = computed(() => !!username.value.trim() && !!password.value && (!creating.value || !!confirmation.value));
onMounted(async () => {
  try { const status = await v1<{hasAccounts: boolean}>('/api/v1/auth/status'); creating.value = !status.hasAccounts; }
  catch { /* Registration remains accessible if the initial status request fails. */ }
  finally { checking.value = false; await nextTick(); usernameInput.value?.focus({preventScroll:true}); }
});
async function changeMode() {
  if (busy.value) return;
  creating.value = !creating.value; password.value = ''; confirmation.value = ''; error.value = ''; passwordVisible.value = false;
  await nextTick(); usernameInput.value?.focus({preventScroll:true});
}
async function submit() {
  if (busy.value || checking.value || !canSubmit.value) return;
  if (creating.value) { const message = newPasswordError(password.value); if (message) { error.value = message; return; } }
  if (creating.value && password.value !== confirmation.value) { error.value = '两次密码不一致'; return; }
  busy.value = true; error.value = '';
  try {
    const data = await v1<{ user: { id: string; username: string }; csrfToken: string }>(`/api/v1/auth/${creating.value ? 'register' : 'login'}`, {
      method: 'POST',
      body: JSON.stringify({ username: username.value.trim(), password: password.value, remember: remember.value, ...(creating.value ? {confirmation:confirmation.value} : {}) }),
    });
    password.value = ''; confirmation.value = '';
    setCsrfToken(data.csrfToken);
    emit('authenticated', data.user);
  } catch (e) { error.value = e instanceof Error ? e.message : creating.value ? '创建账号失败' : '登录失败'; }
  finally { busy.value = false; }
}
</script>

<template>
  <main class="login-screen">
    <header class="login-brand"><PrismLogo class="logo" /><span>棱镜 <span class="login-brand-en">Prism</span></span></header>
    <section class="login-entry" aria-labelledby="login-title">
      <PrismLogo class="login-welcome-logo" />
      <h1 id="login-title">{{ checking ? '正在读取本机账号' : creating ? '创建本机账号' : '欢迎回到棱镜' }}</h1>
      <p class="login-intro">{{ creating ? '账号只保存在这台电脑上，无需邮箱。' : '登录，继续你的思考与探索。' }}</p>
      <form class="login-form" :aria-busy="busy" @submit.prevent="submit">
        <fieldset :disabled="busy || checking">
          <div class="login-field"><label for="login-username">用户名</label><input id="login-username" ref="usernameInput" v-model="username" name="username" autocomplete="username" autocapitalize="none" :spellcheck="false" placeholder="输入用户名" :maxlength="creating ? 32 : 64" :pattern="creating ? '[a-zA-Z0-9_-]{2,32}' : undefined" :aria-describedby="creating ? 'username-help' : undefined" required><p v-if="creating" id="username-help" class="login-field-help">2–32 位字母、数字、下划线或连字符</p></div>
          <div class="login-field"><label for="login-password">密码</label><div class="login-password"><input id="login-password" v-model="password" name="password" :type="passwordVisible ? 'text' : 'password'" :autocomplete="creating ? 'new-password' : 'current-password'" :placeholder="creating ? '设置密码，不含汉字即可' : '输入密码'" maxlength="128" required :aria-describedby="error ? 'login-error' : undefined"><button class="login-password-toggle" type="button" :aria-label="passwordVisible ? '隐藏密码' : '显示密码'" :aria-pressed="passwordVisible" @click="passwordVisible = !passwordVisible"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path v-if="passwordVisible" d="m3 3 18 18"/></svg></button></div></div>
          <div v-if="creating" class="login-field"><label for="login-confirmation">确认密码</label><input id="login-confirmation" v-model="confirmation" name="confirmation" type="password" autocomplete="new-password" placeholder="再次输入密码" maxlength="128" required></div>
          <label class="login-remember"><input v-model="remember" type="checkbox" name="remember"><span><strong>记住登录</strong><small>30 天内保持登录，退出后立即失效。</small></span></label>
          <p v-if="error" id="login-error" class="login-error" role="alert">{{ error }}</p>
          <button class="login-submit" type="submit" :disabled="busy || checking || !canSubmit"><svg v-if="busy" class="login-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9"/></svg>{{ busy ? (creating ? '正在创建…' : '正在登录…') : creating ? '创建账号并进入' : '进入棱镜' }}<svg v-if="!busy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button>
        </fieldset>
      </form>
      <p class="login-mode"><span>{{ creating ? '已有本机账号？' : '第一次使用？' }}</span><button type="button" :disabled="busy || checking" @click="changeMode">{{ creating ? '返回登录' : '创建本机账号' }}</button></p>
      <p class="login-local-note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>账号与配置仅保存在这台电脑上</p>
    </section>
    <footer class="login-concept"><PrismMeaning /><p>{{ PRISM_PROMISE }}</p></footer>
  </main>
</template>
