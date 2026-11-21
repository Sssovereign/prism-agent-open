import { t } from './ui/i18n/index.js';

export type WorkMode = 'ordinary' | 'debate' | 'jury';

// Each mode uses the real runner; research inputs are frozen by the coordinator.
// 结构性数据只保留 id，文案（label/description/placeholder）经 modeInfo 从 i18n 字典取（mode.<id>.*）。
export const WORK_MODES: ReadonlyArray<{ id: WorkMode }> = [
  { id: 'ordinary' },
  { id: 'debate' },
  { id: 'jury' },
];

export function modeInfo(mode: WorkMode) {
  const found = WORK_MODES.find(item => item.id === mode)!;
  return {
    id: found.id,
    label: t(`mode.${mode}.label`),
    description: t(`mode.${mode}.description`),
    placeholder: t(`mode.${mode}.placeholder`),
  };
}
