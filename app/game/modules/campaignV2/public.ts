/**
 * campaignV2（剿灭作战）模块对外出口
 *
 * 战斗模块在 CAMPAIGN 关卡结算时调用 `accrueCampaignKills` 记录歼灭数并累计每周合成玉
 * （经本出口引用，满足「模块间只允许 import 对方 public.ts」的边界约定）。
 */
export {
  accrueCampaignKills,
  campaignMaxKills,
  campaignWeeklyBudget,
  campaignsV2View,
  claimCampaignBreakRewards,
  claimCampaignMissionReward,
  ensureCampaignsV2State,
  refreshCampaignMissions,
} from "./accrue";
export type {
  BreakLadder,
  CampaignMissionCfg,
  CampaignsV2State,
} from "./accrue";
