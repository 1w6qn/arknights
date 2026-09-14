/**
 * rlv2 业务响应构造（由 domain/rlv2/handler 迁出，建议「业务逻辑归 domain」）
 *
 * 官方抓包确认的响应节过滤规则与黑流树海 zone 索引映射集中于此；
 * handler 只保留路由注册（薄壳）。
 */
import type { PlayerDataManager } from "../../kernel/player-data-manager";
import type { PlayerRoguelikeV2 } from "./rlv2";
import type { RoguelikePushMessage } from "../../kernel/http/common";
import { isBlackstream } from "./theme-rules";
import * as ReqSchema from "./rlv2.schema";
import { logger } from "@utils/logger";

/** 响应运行时校验开关（环境变量 RLV2_RESPONSE_SCHEMA，默认开启；设 "0"/"false" 关闭） */
const RESPONSE_SCHEMA_ENABLED = (
  process.env.RLV2_RESPONSE_SCHEMA ?? "1"
).toLowerCase() !== "0" && (process.env.RLV2_RESPONSE_SCHEMA ?? "1").toLowerCase() !== "false";



/**
 * 官方各路由响应包含的 current 节（抓包 2026-08-11/08-18 统计）。
 * 核心节 player/inventory/record/buff 几乎总是出现；map/module 仅在生成/变化时出现；
 * game/troop 仅 createGame/gameSettle/recruitChar 等变更时出现。
 * 2026-08-18 按官服抓包逐路由校准（finishEvent/selectChoice/recruitSet/ticket/recruitChar/giveUpGame）：
 *   chooseInitialRelic/finishEvent(INIT)/selectChoice/battleFinish = CORE
 *   finishEvent(进层)/gridZone 移动 = CORE_MAP_MODULE
 *   chooseInitialRecruitSet = player/inventory/record（无 buff）
 *   activeRecruitTicket = player/inventory（无 record/buff）
 *   recruitChar = player/inventory/record/buff/troop/module（无 map/game）
 *   giveUpGame = player/record（极少）
 */
export const SEC = {
  ALL: undefined, // 全量（createGame/gameSettle）
  CORE: ["player", "inventory", "record", "buff"],
  CORE_MAP: ["player", "inventory", "record", "buff", "map"],
  CORE_MODULE: ["player", "inventory", "record", "buff", "module"],
  CORE_MAP_MODULE: ["player", "inventory", "record", "buff", "map", "module"],
  RECRUIT: ["player", "inventory", "record", "troop"],
  PLAYER: ["player"],
  // 官服增量节（2026-08-18 校准）
  RECRUIT_SET: ["player", "inventory", "record"],
  TICKET: ["player", "inventory"],
  RECRUIT_CHAR: ["player", "inventory", "record", "buff", "troop", "module"],
  GIVEUP: ["player", "record"],
} as const;

/**
 * 响应构造期的 current.player 视图
 *
 * 快照 current 各节写入的是**管理器实例**（非纯数据），故此处按状态模型 + 管理器自带的
 * toJSON（线格式输出）联合声明；其余节仅作字典透传。
 */
type Rlv2PlayerSection = PlayerRoguelikeV2.CurrentData.PlayerStatus & {
  toJSON: () => PlayerRoguelikeV2.CurrentData.PlayerStatus;
};

/** current 节字典（快照期各节值为管理器实例/纯数据，故按不信任输入边界收窄） */
type Rlv2CurrentSections = Record<string, unknown>;

/** 响应内 rlv2 节点（current 节字典 + 可选取样 outer） */
interface Rlv2ResponseNode {
  current: Rlv2CurrentSections;
  outer?: {
    [theme: string]: Record<
      string,
      PlayerRoguelikeV2.OuterData[keyof PlayerRoguelikeV2.OuterData]
    >;
  };
}

/**
 * rlv2 统一响应：并入控制器 toJSON 的 rlv2 子树。
 * 官方抓包确认：客户端按 modified.rlv2 合并状态，但每路由只发送"发生变化"的
 * current 节（createGame/gameSettle 全量；其余为增量节）——多发的 game/troop 等
 * 节会破坏客户端状态合并导致崩溃。rlv2Response 按 sections 过滤 current。
 *
 * 2026-08-18 对齐官服抓包修正：
 * 1. pinned 不输出（官服所有 rlv2 响应均无 pinned——置顶主题由其他接口下发）
 * 2. outer 仅显式要求（outerKeys 非空，createGame/gameSettle/gridZone moveAndBattleStart）
 *    时输出当前主题指定键（官服各路由 outer 内容不同：createGame={record,monthTeam}、
 *    gameSettle=7 键全量、moveAndBattleStart={record}）；其余路由不带
 *    （原实现 theme 存在即输出，且 {...full} 泄漏全量 6 主题 outer → 255KB 冗余）
 * 3. sections=undefined 全量时也只取 current 自身，不再展开 full.outer/full.pinned
 */
export function rlv2Response<T extends object>(
  player: PlayerDataManager,
  extra?: T,
  sections?: readonly string[],
  outerKeys?: readonly string[],
  pushMessages?: RoguelikePushMessage[],
) {
  // 内存态写回存档 + 单次快照（原 persistCurrent + toJSON 双构建）——
  // 供重登"继续探索"（controller 重建走 rlv2:continue 恢复）使用；否则 current.player 等为空
  const full = player.modules.rlv2.snapshotCurrent();
  const base = player.delta;
  const current = full.current;
  const currentOut: Rlv2CurrentSections = {};
  if (sections) {
    for (const s of sections) {
      if (s in current) {
        currentOut[s] = current[s as keyof PlayerRoguelikeV2.CurrentData];
      }
    }
  } else {
    Object.assign(currentOut, current);
  }
  // 修复：黑流树海（rogue_6）地图 zone 以「区域索引」为 map.zones 键（1000+层号-1，如层 1 → "1000"），
  // 而游标/轨迹内部按「层号」存储（1,2,3…）。若不把输出到客户端的 cursor.zone 与 trace[].zone 映射回
  // 区域索引，客户端按 cursor.zone 去 map.zones 里找不到对应区域（"zone 在 map 中不存在"），导致地图
  // 渲染/推进异常（官方抓包：cursor.zone=1000、trace[].zone=1000 与 map.zones 键 "1000" 对齐）。
  // 仍按层号存储可保持内部逻辑（checkZoneEnd/maxZone/zoneKey/结算）与重登"继续探索"不变。
  // 注意：先经 toJSON() 取干净的可序列化副本再改写 zone——若用 {...p} 直接展平，会丢掉 toJSON()，
  // 使 res.send 序列化整个状态管理器（_player 自指控制器 → map/inventory/troop 冗余全量泄漏，
  // 响应体积暴涨，如 giveUpGame）。仅在响应副本上改写，不触碰控制器内存态。
  const respTheme = current?.game?.theme;
  const playerSection = currentOut.player as Rlv2PlayerSection | undefined;
  // 缺省视为层号 0（原 `undefined > 0` 同判 false）
  if (isBlackstream(respTheme) && playerSection && (playerSection.cursor?.zone ?? 0) > 0) {
    const toZoneIndex = (zone: number) => zone + 999;
    const clean =
      typeof playerSection.toJSON === "function"
        ? playerSection.toJSON()
        : playerSection;
    currentOut.player = {
      ...clean,
      cursor: { ...clean.cursor, zone: toZoneIndex(clean.cursor.zone) },
      trace: Array.isArray(clean.trace)
        ? clean.trace.map((t) => ({ ...t, zone: toZoneIndex(t.zone) }))
        : clean.trace,
    };
  }
  const rlv2: Rlv2ResponseNode = { current: currentOut };
  if (outerKeys && outerKeys.length > 0) {
    const theme = current?.game?.theme;
    const fullOuter = full.outer;
    if (theme && fullOuter?.[theme]) {
      const o = fullOuter[theme];
      const picked: Record<
        string,
        PlayerRoguelikeV2.OuterData[keyof PlayerRoguelikeV2.OuterData]
      > = {};
      for (const k of outerKeys) {
        if (k in o) picked[k] = o[k as keyof PlayerRoguelikeV2.OuterData];
      }
      rlv2.outer = { [theme]: picked };
    }
  }
  const resp = {
    ...(extra ?? ({} as T)),
    ...(pushMessages && pushMessages.length > 0 ? { pushMessage: pushMessages } : {}),
    playerDataDelta: {
      modified: {
        ...base.playerDataDelta.modified,
        rlv2,
      },
      deleted: base.playerDataDelta.deleted,
    },
  };
  // 响应骨架运行时校验：仅验证结构（playerDataDelta/rlv2.current 对象），失败记录
  // 告警但不阻断响应（避免破坏已对齐的客户端协议）；开关经 RLV2_RESPONSE_SCHEMA 控制。
  if (RESPONSE_SCHEMA_ENABLED) {
    const check = ReqSchema.playerDeltaResponseSchema.safeParse(resp);
    if (!check.success) {
      const first = check.error.issues[0];
      const where = first.path.length > 0 ? ` at "${first.path.join(".")}"` : "";
      logger.warn("rlv2-resp-schema", `响应骨架校验失败：${first.message}${where}`);
    }
  }
  return resp;
}

