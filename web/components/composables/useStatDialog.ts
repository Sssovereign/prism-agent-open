import { nextTick, onBeforeUnmount, ref, watch, type Ref } from 'vue';

/** Portaled, non-modal DSH stat surface; no perpetual document listeners. */
export function useStatDialog(trigger: Ref<HTMLElement | null>, panel: Ref<HTMLElement | null>) {
  const open = ref(false);
  const position = ref({ left: '12px', top: '12px', visibility: 'hidden' as 'hidden' | 'visible' });
  let observer: ResizeObserver | undefined;
  let disposed = false;
  const place = () => {
    if (!trigger.value || !panel.value) return;
    const a = trigger.value.getBoundingClientRect(), b = panel.value.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight;
    const above = a.top - b.height - 8;
    const top = above >= 12 ? above : Math.min(a.bottom + 8, h - b.height - 12);
    position.value = { left: `${Math.max(12, Math.min(a.left, w - b.width - 12))}px`, top: `${Math.max(12, top)}px`, visibility: 'visible' };
  };
  const close = (restore = false) => { open.value = false; if (restore) trigger.value?.querySelector<HTMLButtonElement>('button')?.focus(); };
  const outside = (event: Event) => {
    const target = event.target;
    if (target instanceof Node && !trigger.value?.contains(target) && !panel.value?.contains(target)) close();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    // This is a non-modal popover: leaving it with Tab returns to the trigger,
    // then native Tab proceeds through the dock, instead of trapping focus.
    if (event.key === 'Tab' && panel.value) {
      const buttons = [...panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,summary,[tabindex="0"]')].filter(el => el.getClientRects().length > 0);
      const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
      if (document.activeElement === panel.value && !event.shiftKey && buttons[0]) { event.preventDefault(); buttons[0].focus(); }
      else if (document.activeElement === edge || document.activeElement === panel.value) { close(true); }
    }
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', outside, true); document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', key); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
    observer?.disconnect(); observer = undefined;
  };
  watch(open, async value => {
    cleanup();
    if (!value) return;
    position.value.visibility = 'hidden';
    await nextTick(); if (!open.value || disposed) return;
    place(); panel.value?.focus({ preventScroll: true });
    document.addEventListener('pointerdown', outside, true); document.addEventListener('click', outside, true);
    document.addEventListener('keydown', key); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    observer = new ResizeObserver(place); if (panel.value) observer.observe(panel.value); if (trigger.value) observer.observe(trigger.value);
  });
  onBeforeUnmount(() => { disposed = true; cleanup(); });
  return { open, position, close };
}
