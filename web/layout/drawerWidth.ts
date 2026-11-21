export const DEFAULT_DRAWER_WIDTH = 480;
// 输出卡片占列324px，扣除两侧留白后可见宽度300px。
export const DEFAULT_OUTPUT_WIDTH = 324;
export function drawerWidthBounds(viewport: number, sidebar = 0): { min: number; max: number } {
    const available = viewport >= 1280 ? Math.min(960, viewport - sidebar - 440) : Math.floor(viewport * .92);
    const min = viewport >= 1280 ? 320 : Math.min(320, Math.max(0, available));
    return { min, max: Math.max(min, available) };
}
export function clampDrawerWidth(value: number, viewport: number, sidebar = 0): number {
    const { min, max } = drawerWidthBounds(viewport, sidebar);
    return Math.round(Math.max(min, Math.min(Number.isFinite(value) ? value : DEFAULT_DRAWER_WIDTH, max)));
}
