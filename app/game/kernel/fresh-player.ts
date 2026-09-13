/**
 * 全新玩家存档构造器
 *
 * 参考 LocalArknight 的「注册建空账号、首次登录用 DefaultSyncData 初始化新玩家」语义，
 * 为 real 模式新注册账号生成一份「从零开始的合法新玩家存档」，而不是复制 1.json（满配管理号）。
 *
 * 实现原则：
 * - 以模板为结构脚手架（保证 PlayerDataManager 可构造、结构合法），仅重置「进度/内容」字段。
 * - 只重置有把握的分区（身份/财富/拥有干员/背包/皮肤/勋章/抽卡计数/基建动态进度/肉鸽/任务等），
 *   其余分区保留模板结构，避免重置不当导致客户端崩溃。
 * - 可由各管理器在加载时自播种的分区（medal 由 unlockActivity 播种、mission 由 refresh 播种、
 *   rlv2.current 由控制器默认初始化）置为全新默认。
 */

import type { JsonValue } from "@excel/json-value";

/** 基建状态服务端视图（仅加工队列 labor 为动态进度，其余字段原样保留） */
interface BuildingStatusView {
  labor?: { processPoint: number; value: number; lastUpdateTime: number };
}

/** 1 级新玩家最大体力（阿米娅初始体型；实际随等级增长，功能影响可忽略） */
const FRESH_MAX_AP = 135;

/** 新玩家初始体力值 */
const FRESH_AP = 135;

/**
 * 重置状态分区为全新新玩家（身份/财富/进度/时间戳）
 *
 * 保留模板 status 的键集（结构完整），仅覆盖为全新默认值；去除满配版本标记
 * （maxAccountResVersion），避免新号被 generateMaxedAccount 按版本再次刷成满配。
 *
 * @param src - 模板 status 对象（可为空，容忍）
 * @param opts - 新号身份信息（uid/昵称/编号/注册时间戳）
 * @returns 全新状态的 status 对象
 */
export function buildFreshStatus(
  src: Record<string, unknown> | undefined,
  opts: {
    uid: string;
    nickName: string;
    nickNumber: string;
    registerTs: number;
  },
): Record<string, unknown> {
  const s: Record<string, unknown> = src ? JSON.parse(JSON.stringify(src)) : {};
  s.uid = opts.uid;
  s.nickName = opts.nickName;
  s.nickNumber = opts.nickNumber;
  // 等级/经验：从 1 级开始
  s.level = 1;
  s.exp = 0;
  // 货币/券：全新清零
  s.gold = 0;
  s.androidDiamond = 0;
  s.iosDiamond = 0;
  s.diamondShard = 0;
  s.gachaTicket = 0;
  s.tenGachaTicket = 0;
  s.instantFinishTicket = 0;
  s.hggShard = 0;
  s.lggShard = 0;
  s.recruitLicense = 0;
  s.practiceTicket = 0;
  s.classicShard = 0;
  s.classicGachaTicket = 0;
  s.classicTenGachaTicket = 0;
  // 体力：满体力起手，恢复锚点=注册时间
  s.maxAp = FRESH_MAX_AP;
  s.ap = FRESH_AP;
  s.lastApAddTime = opts.registerTs;
  s.lastRefreshTs = opts.registerTs;
  s.lastOnlineTs = 0;
  s.registerTs = opts.registerTs;
  // 进度/剧情/引导历史：全新清空
  s.mainStageProgress = 0;
  s.progress = {};
  s.campaigns = {};
  // 助手/月卡/签名：全新默认
  s.secretary = "";
  s.secretarySkinId = "";
  s.tipMonthlyCardExpireTs = 0;
  s.monthlySubscriptionStartTime = 0;
  s.monthlySubscriptionEndTime = 0;
  s.buyApRemainTimes = 0;
  s.apLimitUpFlag = 0;
  s.resume = "";
  // flags 保持模板键集（刷新标记——缺省安全）
  s.flags = s.flags ?? {};
  // 头像：仅保留「initial」来源的默认头像（丢弃活动/限时头像）
  s.avatar = freshAvatar(s.avatar as Record<string, unknown> | undefined);
  // 去除满配版本标记（新号不应随版本被刷成满配）
  delete s.maxAccountResVersion;
  return s;
}

/**
 * 构造全新默认头像集（仅保留 src=initial 的默认头像，保持结构有效）
 * @param src - 模板 avatar 对象（{ avatar_icon: {...} }）
 * @returns 仅含默认头像的新 avatar 对象
 */
function freshAvatar(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!src) return {};
  const icons = (src.avatar_icon ?? {}) as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const [id, v] of Object.entries(icons)) {
    const rec = v as { src?: string };
    if (rec?.src === "initial") kept[id] = v;
  }
  return { avatar_icon: kept };
}

/**
 * 重置背包为全新（保留键集、全部计数清零）
 *
 * 保留 inventory 的所有键（结构安全），值归零——新玩家不持有任何道具。
 *
 * @param src - 模板 inventory 对象
 * @returns 全零计数的背包对象
 */
export function freshInventory(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const inv: Record<string, unknown> = src ? JSON.parse(JSON.stringify(src)) : {};
  for (const k of Object.keys(inv)) inv[k] = 0;
  return inv;
}

/**
 * 重置干员为全新（保留队伍骨架、清空持有干员）
 *
 * - chars/addon/charGroup/charMission：清空（新玩家未持有干员）
 * - squads：保留编队骨架（槽位清空）——客户端进战前需存在默认编队结构
 *
 * @param src - 模板 troop 对象
 * @returns 全新干员数据的 troop 对象
 */
export function freshTroop(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const tr: Record<string, unknown> = src ? JSON.parse(JSON.stringify(src)) : {};
  tr.chars = {};
  tr.addon = {};
  tr.charGroup = {};
  tr.charMission = {};
  // 干员 instId 计数器从 1 起（null/0 会让首个新干员写入 chars["null"/"0"] 并破坏递增）
  tr.curCharInstId = 1;
  const srcSquads = (tr.squads ?? {}) as Record<string, { slots?: JsonValue[] }>;
  const squads: Record<string, unknown> = {};
  for (const [sid, q] of Object.entries(srcSquads)) {
    const len = Array.isArray(q?.slots) ? q.slots.length : 12;
    // 全新为未命名默认编队，槽位全部为空等待编入
    squads[sid] = {
      squadId: sid,
      name: String(Number(sid) + 1),
      slots: new Array(len).fill(null),
    };
  }
  tr.squads = squads;
  tr.curSquadCount = Object.keys(squads).length > 0 ? Object.keys(squads).length : 1;
  return tr;
}

/**
 * 重置抽卡计数为全新（保留各卡池 poolId、清零进度/开池标志）
 * @param src - 模板 gacha 对象
 * @returns 全新计数的 gacha 对象
 */
export function freshGacha(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const g: Record<string, unknown> = src ? JSON.parse(JSON.stringify(src)) : {};
  for (const [type, v] of Object.entries(g)) {
    const pool = (v as { poolId?: string }) ?? {};
    g[type] = { openFlag: 0, cnt: 0, poolId: pool.poolId ?? "" };
  }
  return g;
}

/**
 * 重置勋章为全新（空勋章组——由 unlockActivity 在加载时重新播种初始勋章）
 * @param src - 模板 medal 对象（可为空）
 * @returns 全新空的 medal 对象
 */
export function freshMedal(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  void src; // 结构冗余，直接返回全新空勋章
  return { medals: {}, custom: {} };
}

/**
 * 重置任务为全新（空任务——由 refresh/unlockActivity/openServer 在加载时重新播种）
 * @param src - 模板 mission 对象（可为空）
 * @returns 全新空的任务对象
 */
export function freshMission(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  void src;
  return { missions: {}, missionRewards: {}, missionGroups: {} };
}

/**
 * 重置基建动态进度为全新（保留房间结构、清空干员分配与生产/心情动态）
 *
 * 仅清空有明显「持续时间」字段的动态项（基建干员分配、labor 加工进度、订单），
 * 保留 roomSlots/rooms/furniture 的结构骨架，避免客户端基建入口异常。
 *
 * @param src - 模板 building 对象（可为空）
 * @returns 动态进度清零的 building 对象
 */
export function freshBuilding(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const b: Record<string, unknown> = src ? JSON.parse(JSON.stringify(src)) : {};
  // 基建内干员分配清空
  b.chars = {};
  // 加工/生产动态清零（labor value=0、order writer 由客户端据此显示为空闲）
  const status = (b.status ?? {}) as BuildingStatusView;
  if (status.labor) {
    status.labor.processPoint = 0;
    status.labor.value = 0;
    status.labor.lastUpdateTime = 0;
  }
  b.status = status;
  return b;
}

/**
 * 重置首页主题为全新（仅默认主题 tm_rhodes_day）
 * @param src - 模板 homeTheme 对象
 * @param registerTs - 注册时间戳（默认主题解锁时间）
 * @returns 全新主题对象
 */
export function freshHomeTheme(
  src: Record<string, unknown> | undefined,
  registerTs: number,
): Record<string, unknown> {
  void src;
  return {
    selected: "tm_rhodes_day",
    themes: { tm_rhodes_day: { unlock: registerTs } },
  };
}

/**
 * 重置肉鸽V2为全新（空 outer、空 current、未锁定主题——控制器会默认初始化）
 * @param src - 模板 rlv2 对象（可为空）
 * @returns 全新肉鸽V2对象
 */
export function freshRlv2(
  src: Record<string, unknown> | undefined,
): Record<string, unknown> {
  void src;
  return { outer: {}, current: {}, pinned: "" };
}

/**
 * 重置推送标记为全新
 * @param src - 模板 pushFlags 对象（可为空）
 * @param ts - 当前时间戳（战斗加密锚点，保持与响应一致）
 * @returns 全新推送标记对象
 */
export function freshPushFlags(
  src: Record<string, unknown> | undefined,
  ts: number,
): Record<string, unknown> {
  void src;
  return {
    hasGifts: 0,
    hasFriendRequest: 0,
    hasClues: 0,
    hasFreeLevelGP: 0,
    status: ts,
  };
}

/**
 * 构造全新玩家存档（参考 LocalArknight 新玩家 DefaultSyncData 语义）
 *
 * 仅重置有把握的「进度/内容」分区，其余顶部分区保留模板结构——
 * 避免重置不当导致新号客户端崩溃，同时保证新号不从满配模板继承财富/干员/进度。
 *
 * @param template - 结构合法的模板存档（1.json / player_data.json 基底）
 * @param opts - 新号身份信息
 * @returns 全新玩家存档对象（已深拷贝，未与模板共享引用）
 */
export function buildFreshPlayerData(
  template: Record<string, unknown>,
  opts: {
    uid: string;
    nickName: string;
    nickNumber: string;
    registerTs: number;
  },
): Record<string, unknown> {
  const data: Record<string, unknown> = JSON.parse(JSON.stringify(template));
  data.status = buildFreshStatus(data.status as Record<string, unknown> | undefined, opts);
  data.troop = freshTroop(data.troop as Record<string, unknown> | undefined);
  data.inventory = freshInventory(data.inventory as Record<string, unknown> | undefined);
  data.consumable = {};
  data.gacha = freshGacha(data.gacha as Record<string, unknown> | undefined);
  data.medal = freshMedal(data.medal as Record<string, unknown> | undefined);
  data.mission = freshMission(data.mission as Record<string, unknown> | undefined);
  data.building = freshBuilding(data.building as Record<string, unknown> | undefined);
  data.homeTheme = freshHomeTheme(
    data.homeTheme as Record<string, unknown> | undefined,
    opts.registerTs,
  );
  data.rlv2 = freshRlv2(data.rlv2 as Record<string, unknown> | undefined);
  data.pushFlags = freshPushFlags(
    data.pushFlags as Record<string, unknown> | undefined,
    opts.registerTs,
  );
  // 皮肤：全新无持有皮肤（持有系统会按需创建键）
  data.skin = {};
  // 图鉴/索引：全新清空（干员/敌人条目在解锁后再收集，避免继承满配图鉴）
  data.dexNav = {};
  // 阵营收集奖励进度：全新清空（随玩家收集重新累计）
  data.collectionReward = {};
  // 活动状态：全新清空（unlockActivity 在加载时按当前活动重新播种）
  data.activity = {};
  // 名片样式：仅保留默认底色（nc_rhodes_default）
  data.nameCardStyle = freshNameCardStyle();
  // 角色轮换（主界面预设）：全新无自定义预设
  data.charRotation = { current: "", preset: {} };
  return data;
}

/**
 * 构造全新名片样式（仅默认底色，无已解锁活动名片）
 * @returns 全新名片样式对象
 */
export function freshNameCardStyle(): Record<string, unknown> {
  return {
    componentOrder: ["module_medal", "module_sign"],
    skin: {
      selected: "nc_rhodes_default",
      state: {},
    },
    misc: { showDetail: false, showBirthday: false },
  };
}