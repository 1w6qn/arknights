/**
 * 肉鸽V2模块事件订阅登记
 *
 * rlv2 的事件订阅分散在各子管理器构造期（rlv2-composition.ts 按固定顺序构造，
 * 构造顺序即订阅顺序，不得改动）；主管理器构造器仅派发 rlv2:continue / rlv2:init
 * （hasRunning 恢复链，见 logic.ts 构造器）。本文件按模块文件组织约定（见 AGENTS.md「文件命名」）占位。
 */
export function registerRlv2Triggers(): void {
  // 订阅在各子管理器构造期登记（rlv2-composition.ts），占位
}
