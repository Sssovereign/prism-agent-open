import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import './vendor/zcode/tokens.css';
import './readability.css';
import './eye-care.css';
import { toastError } from './ui/toast';
import { t } from './ui/i18n/index';

const app = createApp(App);
// Capability comes from the installed host; an older host/browser keeps its original layout.
if (window.prismPlatform?.integratedTitlebar) {
  document.documentElement.dataset.desktopChrome = window.prismPlatform.platform;
  const initialTheme = document.documentElement.dataset.theme;
  if (initialTheme === 'dark' || initialTheme === 'light') window.prismWindow?.setTheme(initialTheme);
}

// 渲染层全局兜底（ZCode AppErrorBoundary 的 Vue 等价裁剪）：Vue 的 errorHandler 不卸载组件树，
// 根级收敛为 toast + console 即可，无需 React 式双层边界。完整堆栈进 console 供排查，UI 只给摘要。
app.config.errorHandler = (error, _instance, info) => {
  console.error('[prism] 渲染异常:', error, `(钩子: ${info})`);
  toastError(t('app.renderError', { message: error instanceof Error ? error.message : String(error) }), { dedupeKey: 'prism-render-error', durationMs: 8000, dismissible: true });
};

// 未捕获 Promise rejection：AbortError 是正常取消语义（fetch/abort），不弹。
// dedupeKey 使连续失败只保留最新一条，避免错误风暴刷屏。
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason;
  if (reason instanceof DOMException && reason.name === 'AbortError') return;
  console.error('[prism] 未处理的Promise拒绝:', reason);
  toastError(t('app.unhandledRejection', { message: reason instanceof Error ? reason.message : String(reason) }), { dedupeKey: 'prism-uncaught', durationMs: 8000, dismissible: true });
});

// 同步错误兜底。resource 加载失败（图片/脚本）没有 event.error，属噪音，不弹。
window.addEventListener('error', event => {
  if (!event.error) return;
  console.error('[prism] 未捕获错误:', event.error);
  toastError(t('app.renderError', { message: event.error instanceof Error ? event.error.message : String(event.error) }), { dedupeKey: 'prism-render-error', durationMs: 8000, dismissible: true });
});

app.mount('#app');
