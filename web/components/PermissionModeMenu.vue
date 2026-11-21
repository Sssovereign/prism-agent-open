<script setup lang="ts">
// Adapted from fixed-source display.tsx / V4ComposerModeControls: ghost 28px trigger,
// warning foreground only, 256px menu, 52px rich rows and 18px leading icons.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { ApprovalMode } from '../../contracts/permissions';
import ComposerSelect, { type ComposerSelectOption } from './ComposerSelect.vue';
import ConfirmationDialog from './ConfirmationDialog.vue';
const props = withDefaults(defineProps<{
  value: ApprovalMode;
  disabled?: boolean;
  busy?: boolean;
  disabledReason?: string;
  compact?: boolean;
}>(), { disabled: false, busy: false, compact: false });
const emit = defineEmits<{
  (e: 'change', mode: ApprovalMode): void;
  (e: 'modal-change', active: boolean): void;
}>();
const choices: readonly (ComposerSelectOption & { value: ApprovalMode })[] = [
  { value: 'ask', label: '请求批准', description: '修改文件、执行命令前始终询问', icon: 'hand' },
  { value: 'auto', label: '智能批准', description: '常规操作自动批准', icon: 'shield-check' },
  { value: 'full', label: '完全授权', description: '文件修改、删除和命令直接执行', icon: 'shield-alert' },
];
const current = computed(() => choices.find(choice => choice.value === props.value) ?? choices[1]!);
const picker = ref<InstanceType<typeof ComposerSelect>>();
const confirmFull = ref(false);
watch(confirmFull, active => emit('modal-change', active), { flush: 'sync' });
// A late confirmation must not change permissions after this control becomes locked.
watch(() => [props.disabled, props.busy, props.value] as const, () => {
  if (confirmFull.value) dismissConfirmation();
});
function select(value: string) {
  if (props.disabled || props.busy || value === props.value) return;
  const choice = choices.find(item => item.value === value);
  if (!choice) return;
  if (choice.value === 'full') { confirmFull.value = true; return; }
  emit('change', choice.value);
}
function dismissConfirmation() {
  confirmFull.value = false;
  void nextTick(() => picker.value?.focusTrigger());
}
function confirm() {
  if (props.disabled || props.busy) { dismissConfirmation(); return; }
  dismissConfirmation();
  emit('change', 'full');
}
onBeforeUnmount(() => emit('modal-change', false));
</script>

<template>
  <ComposerSelect
    ref="picker" :value="value" :options="choices" label="授权模式" :trigger-label="busy ? '更新授权…' : current.label"
    :icon="current.icon" :warning="value === 'full'" :disabled="disabled || busy" :title="disabledReason || current.description"
    :compact="compact" :width="256" note="可访问本机账户有权限的全部文件；联网仍受限制。" @change="select"
  />
  <ConfirmationDialog
    v-if="confirmFull" title="启用完全授权？"
    description="Agent可读写本机账户有权限的全部文件。启用后，文件修改、删除和命令执行将无需再次询问。"
    confirm-label="启用完全授权" danger @close="dismissConfirmation" @confirm="confirm"
  />
</template>
