<script setup lang="ts">
import { ref, useId, watch } from 'vue';
import { useDisclosureMotion } from './useDisclosureMotion';
const props = defineProps<{ open: boolean; label: string }>();
const emit = defineEmits<{ (e: 'update:open', open: boolean): void }>();
const contentId = useId();
const trigger = ref<HTMLButtonElement>(), content = ref<HTMLElement>();
const rendered = ref(props.open);
const { enter, leave, cancel } = useDisclosureMotion();
watch(() => props.open, open => {
  if (open) rendered.value = true;
  // Completion must not strand focus inside the now inert/hidden history.
  else if (content.value?.contains(document.activeElement)) trigger.value?.focus({ preventScroll: true });
});
</script>
<template>
 <section class="motion-disclosure" :data-state="open ? 'open' : 'closed'">
  <button ref="trigger" class="disclosure-trigger" type="button" :aria-label="label" :aria-expanded="open" :aria-controls="contentId" @click="emit('update:open', !open)"><slot name="summary"/></button>
  <Transition :css="false" @enter="enter" @leave="leave" @enter-cancelled="cancel" @leave-cancelled="cancel">
   <div v-show="open" :id="contentId" ref="content" class="disclosure-shell" :inert="!open" :aria-hidden="!open">
    <div class="disclosure-inner"><slot v-if="rendered"/></div>
   </div>
  </Transition>
 </section>
</template>
<style scoped>
.motion-disclosure{min-width:0}
.disclosure-trigger{display:flex;align-items:center;gap:8px;max-width:100%;width:fit-content;min-height:28px;padding:0;border:0;background:transparent;color:var(--fg-subtle);font:inherit;text-align:left;cursor:pointer}
.disclosure-trigger:hover{color:var(--fg)}
.disclosure-trigger:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
.disclosure-shell,.disclosure-inner{min-width:0;transition:none}
.disclosure-inner{display:flow-root}
</style>
