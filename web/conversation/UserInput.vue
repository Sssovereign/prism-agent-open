<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { USER_INPUT_COLLAPSED_HEIGHT, userInputOverflows, userInputMaxHeight } from './motion';
import ImagePreviewDialog from '../components/ImagePreviewDialog.vue';
import UiIcon from '../components/UiIcon.vue';
import ControlHintTooltip from '../components/ControlHintTooltip.vue';
import MessageTime from './MessageTime.vue';
import { attachmentRawUrl, formatAttachmentSize } from './attachments';
import type { MessageAttachmentMeta } from '../../contracts/conversation';
const props = defineProps<{ text: string; delivery?: 'accepted' | 'applied'; attachments?: MessageAttachmentMeta[]; messageId?: string; editable?: boolean; createdAt?:string }>();
const emit = defineEmits<{ (e: 'edit'): void }>();
const expanded = ref(false), expandable = ref(false), height = ref(USER_INPUT_COLLAPSED_HEIGHT);
const previewOpen = ref(false), previewId = ref('');
const previewAttachment = computed(() => props.attachments?.find(a => a.id === previewId.value) ?? null);
const previewSrc = computed(() => previewId.value ? attachmentRawUrl(previewId.value) : '');
function openPreview(id: string): void { previewId.value = id; previewOpen.value = true; }
// 块E5：用户消息悬停动作（对齐上游 CopyRowAction＋编辑铅笔，悬停显现）
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyText(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.text);
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1800);
  } catch { /* 剪贴板不可用：保持静默，用户可手动选择复制 */ }
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
const body = ref<HTMLElement>();
let observer: ResizeObserver | undefined, frame: number | undefined;
const maxHeight = computed(() => userInputMaxHeight(expanded.value, height.value));
function measure() {
  if (frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    if (!body.value) return;
    height.value = body.value.scrollHeight;
    expandable.value = userInputOverflows(height.value);
  });
}
watch(() => props.text, () => { expanded.value = false; measure(); }, { flush: 'post' });
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(measure); if (body.value) observer.observe(body.value); }
  else window.addEventListener('resize', measure);
});
onBeforeUnmount(() => { observer?.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); window.removeEventListener('resize', measure); });
</script>
<template>
 <div class="user-input" :data-message-id="messageId">
  <div class="user-bubble">
   <div v-if="attachments?.length" class="user-attachments">
    <button v-for="a in attachments" :key="a.id" type="button" class="user-attachment" :title="`${a.name}（${formatAttachmentSize(a.sizeBytes)}）— 点击查看大图`" @click="openPreview(a.id)">
     <img :src="attachmentRawUrl(a.id)" :alt="a.name" loading="lazy" />
    </button>
   </div>
   <div v-if="text" class="user-content">
    <div ref="body" class="user-body" :class="{collapsed: expandable && !expanded}" :style="{maxHeight}">{{text}}</div>
    <div v-if="expandable" class="user-expand" :class="{expanded}"><button type="button" :aria-expanded="expanded" @click="expanded=!expanded">{{expanded?'收起消息':'展开完整消息'}}</button></div>
   </div>
  </div>
  <small v-if="delivery" role="status">{{delivery==='applied'?'已应用到模型上下文':'已接收，等待应用'}}</small>
  <div class="user-footer"><div class="user-actions">
   <ControlHintTooltip :text="copied?'已复制':'复制'" side="bottom" v-slot="{describedby}"><button type="button" class="user-action" :aria-describedby="describedby" :aria-label="copied ? '已复制' : '复制'" @click="copyText"><UiIcon name="copy" :size="14" /></button></ControlHintTooltip>
   <ControlHintTooltip v-if="editable && messageId" text="编辑后从这条消息重新开始" side="bottom" v-slot="{describedby}"><button type="button" class="user-action" aria-label="编辑" :aria-describedby="describedby" @click="emit('edit')"><UiIcon name="pencil" :size="14" /></button></ControlHintTooltip>
  </div><MessageTime :value="createdAt" /></div>
  <ImagePreviewDialog :open="previewOpen" :src="previewSrc" :title="previewAttachment?.name ?? '图片'" @close="previewOpen=false" />
 </div>
</template>
<style scoped>
/* Only message content paints the bubble; status and actions stay in the outer row. */
.user-input{box-sizing:border-box;display:flex;flex-direction:column;align-items:flex-end;align-self:flex-end;width:fit-content;min-width:0;max-width:100%;margin:20px 0 12px auto;gap:6px;color:var(--fg);font-size:var(--text-ui-base);line-height:1.6}
.user-bubble{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;width:fit-content;min-width:0;max-width:100%;padding:10px 16px;border-radius:18px;background:light-dark(#e8f3ff,#213247);color:light-dark(#163354,#e0edff)}
.user-attachments{display:flex;flex-wrap:wrap;gap:6px}
.user-attachment{box-sizing:border-box;padding:0;border:1px solid var(--border);border-radius:8px;background:transparent;overflow:hidden;cursor:zoom-in;line-height:0}
.user-attachment img{display:block;width:96px;height:72px;object-fit:cover}
.user-attachment:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.user-content{position:relative;min-width:0;max-width:100%}
.user-body{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;transition:max-height 300ms cubic-bezier(0,0,.2,1)}
.user-body.collapsed{mask-image:linear-gradient(to bottom,black 0%,black 70%,transparent 100%)}
.user-expand{position:absolute;inset-inline:0;bottom:0;display:flex;justify-content:center}
.user-expand.expanded{position:static;padding-top:8px}
.user-expand button{border:1px solid var(--border);border-radius:999px;background:var(--bg);color:var(--fg);font:inherit;font-size:var(--text-ui-sm);cursor:pointer;padding:4px 10px}
.user-expand button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
small{display:block;color:var(--fg-subtle);font-size:var(--text-ui-sm);overflow-wrap:anywhere}
/* 块E5：悬停动作行（上游 MessageActions mt-1 opacity-0 group-hover/user-row:opacity-100 focus-within:opacity-100） */
.user-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:28px}
.user-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;opacity:0;transition:opacity .15s}
.user-input:hover .user-actions,.user-input:focus-within .user-actions{opacity:1}
.user-action{display:inline-flex;align-items:center;gap:4px;width:28px;height:28px;justify-content:center;padding:0;margin:0;border:none;border-radius:6px;background:transparent;color:var(--fg-subtle);cursor:pointer;transition:background-color .1s,color .1s}
.user-action:hover{color:var(--fg);background:var(--hover)}
.user-action:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:1px}
.user-action-hint{font-size:var(--text-ui-xs);color:var(--fg-subtlest)}
@media(prefers-reduced-motion:reduce){.user-actions{transition:none}}
@container conversation (min-width:624px){.user-input{max-width:min(100%,576px)}}
@media(prefers-reduced-motion:reduce){.user-body{transition:none}}
</style>
