<script setup lang="ts">
import { t } from '../ui/i18n/index';

const text = defineModel<string>({ required: true });
defineProps<{ target: 'claim' | 'conclusion'; running: boolean; busy: boolean; error?: string }>();
const emit = defineEmits<{ submit: []; cancel: [] }>();
</script>

<template>
  <form class="objection-composer" data-testid="objection-composer" @submit.prevent="emit('submit')">
    <label class="objection-target">
      {{ t(target === 'claim' ? 'research.objection.targetClaim' : 'research.objection.targetConclusion') }}
      <textarea v-model="text" maxlength="2000" :disabled="busy" :placeholder="t('research.objection.placeholder')" />
    </label>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="objection-actions">
      <button type="submit" class="btn btn-solid" :disabled="busy || !text.trim()">
        {{ t(running ? 'research.objection.submit' : 'research.objection.submitReview') }}
      </button>
      <button type="button" class="btn" :disabled="busy" @click="emit('cancel')">{{ t('research.objection.cancel') }}</button>
    </div>
  </form>
</template>

<style scoped>
.objection-composer { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--bg-card); }
.objection-target { display: grid; gap: 6px; color: var(--fg-subtle); font-size: var(--text-ui-sm); }
.objection-composer textarea { width: 100%; min-width: 0; min-height: 64px; resize: vertical; border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--bg-input); color: var(--fg); padding: 8px 10px; font: inherit; line-height: 1.5; }
.objection-composer textarea:focus-visible { outline: 2px solid var(--color-icon-blue, #508de0); outline-offset: 1px; }
.objection-composer textarea::placeholder { color: var(--fg-subtlest); }
.objection-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
