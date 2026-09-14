/**
 * arkhub 会话服启动绑定（server.ts 内联回调收归模块）
 *
 * 原 `app/server.ts` 里 247 行 `startArkhubSessionServer({...})` 回调闭包集中于此
 * （2026-09-13 重构：对齐 enemyDuel 的「模块自持绑定，server.ts 只启动」形态）。
 * server.ts 只注入一个玩家端口（取存档/判存在/懒加载），不再直连 accountManager。
 *
 * 用户注入口经 {@link ArkhubSessionPlayerPort} 抽象——避免 game 模块依赖 account 单例。
 */
import { logger } from "@utils/logger";
import config from "@core/config/index";
import type { PlayerDataManager } from "../../../../kernel/player-data-manager";
import { ARKHUB_ACT_ID, ARKHUB_ERR } from "../domain/state";
import {
  arkhubOnDuelSettle,
  arkhubOnDailySupply,
  arkhubResolveGuideFlags,
  arkhubAdvanceGuide,
  arkhubSetStateMask,
  arkhubRecordSettledDuel,
  arkhubReadGatewayState,
  arkhubIsRewardClaimed,
  arkhubMarkRewardClaimed,
} from "../domain/state";
import {
  ARKDEX_PROPS,
  arkhubStartEncounter,
  arkhubEndScan,
  arkhubBuyProp,
  arkhubUseProp,
  arkhubPheromoneScan,
  arkhubSetTrade,
  arkhubDoTrade,
  arkhubPersistShopToday,
  arkhubShopTodayIds,
  arkhubDailyShopIds,
} from "../domain/dex";
import type { ArkhubSessionServerOptions } from "./contract";

/** 会话服启动绑定所需的玩家端口（server.ts 注入 accountManager 适配） */
export interface ArkhubSessionPlayerPort {
  /** 取内存中已加载的玩家存档（未加载返回 undefined） */
  get(uid: string): PlayerDataManager | undefined;
  /** 账号是否存在（未知账号不创建/不加载） */
  has(uid: string): boolean;
  /** 确保存档已加载到内存（含 ARK_HUB 播种；懒加载链外的网关登录路径用） */
  ensureLoaded(uid: string): Promise<void> | void;
}

/**
 * 构建 arkhub 会话服启动绑定（除 port 外的全部回调）
 *
 * @param port - 玩家存档访问端口（server.ts 注入）
 * @returns `ArkhubSessionServerOptions` 的回调子集，直接展开进 startArkhubSessionServer
 */
export function createArkhubSessionBindings(
  port: ArkhubSessionPlayerPort,
): Omit<ArkhubSessionServerOptions, "port"> {
  /** 取玩家（未加载返回 undefined）；后续回调统一经此 */
  const player = (uid: string): PlayerDataManager | undefined => port.get(uid);

  return {
    // 场景 self 条目用玩家真实昵称/秘书干员（存档已加载则直读，否则回退默认）
    resolveNickname: (uid: string) => {
      const p = player(uid);
      return p?._playerdata?.status?.nickName ?? `博士${uid || "1"}`;
    },
    resolvePlayerProfile: (uid: string) => {
      const status = player(uid)?._playerdata?.status;
      if (!status) return {};
      return {
        nickname: status.nickName,
        level: status.level,
        // 广场玩家模型 = 主界面秘书干员（与官服网关 PlayerBrief.charId/skinId 一致）
        charId: status.secretary ?? "",
        skinId: status.secretarySkinId ?? "",
        avatarId: status.avatar?.id,
      };
    },
    // 场景帧构建前确保存档在内存（含 ARK_HUB 播种）：网关登录不走 HTTP 懒加载链，
    // 未加载时户籍/扣券回调读不到玩家 → 捕捉区功能不解锁（实机 bug，2026-08-27）。
    // 未知账号（无 configs 条目）保持现状不创建。
    ensurePlayerLoaded: (uid: string) => {
      if (!uid || !port.has(uid)) return;
      return port.ensureLoaded(uid);
    },
    // ARKDUEL 结算 → 按回合上报胜负发 15/7 券 + 对战计数 + 任务事件（arkhubOnDuelSettle；
    // 同一局已按 battle_id 去重，BO3 多回合上报不重复发券）
    onDuelSettle: (uid: string, win: boolean) => {
      const p = player(uid);
      if (!p) return;
      void arkhubOnDuelSettle(p, win).catch((e: Error) =>
        logger.warn("arkhub-session", `ARKDUEL 结算处理失败: ${e.message}`),
      );
    },
    // 每日物资 → 记录领取天数 + 发 100 券 + 任务事件（arkhubOnDailySupply）
    onDailySupplyClaimed: (uid: string) => {
      const p = player(uid);
      if (!p) return;
      void arkhubOnDailySupply(p).catch((e: Error) =>
        logger.warn("arkhub-session", `每日物资处理失败: ${e.message}`),
      );
    },
    // 渐进引导（剧情推进）：resolveGuideFlags 按 uid 读持久化 GuideFlags（config
    // arkhub.guideProgressive=true 时首次给未开始态触发引导对话，随交互逐步推进）；
    // onGuideAdvance 在交互帧命中引导 actor 时落持久化 + 出展指引任务 1-3 进度。
    resolveGuideFlags: (uid: string) => {
      if (!config.arkhub?.guideProgressive) return undefined; // 完成态（网关默认，零风险）
      const p = player(uid);
      if (!p) return undefined;
      return Promise.resolve(arkhubResolveGuideFlags(p, true));
    },
    onGuideAdvance: (uid: string, actorId: string) => {
      if (!config.arkhub?.guideProgressive) return;
      const p = player(uid);
      if (!p) return;
      void arkhubAdvanceGuide(p, actorId).catch((e: Error) =>
        logger.warn("arkhub-session", `引导推进处理失败: ${e.message}`),
      );
    },
    // 引导推进广播（38b36462）的 f2.f1 需携带玩家当前奇象兑换券数（官服实锤 f2={1:155,...}）
    resolveArkDexGold: (uid: string) => {
      const p = player(uid);
      return p?._playerdata?.activity?.ARK_HUB?.act1arkhub?.coin ?? 0;
    },
    // 户籍裁剪：场景帧 PlayerSyncData f5-f9（生物图鉴/道具/像素/状态/功能位）数据源——
    // 从 ARK_HUB.act1arkhub 读 dex(图鉴收录)/scanBag(持有个体)/coin(券)/props(道具箱)。
    // 客户端没有这些字段时"数据库等功能"显示未解锁。返回 undefined 则维持现状。
    resolveArkdexDocs: (uid: string) => {
      const p = player(uid);
      const hub = p?._playerdata?.activity?.ARK_HUB?.act1arkhub;
      if (!hub) return undefined;
      // dex：{ [numId字符串]: {...} } → 收录种类集（key=numId，value 计 1 → CreatureCollection）
      const dex: Record<string, number> = {};
      for (const key of Object.keys(hub.dex ?? {})) dex[String(key)] = 1;
      // scanBag：持有个体 → Creature（id→unique_id，numId→template_id，isAlter→persona，
      // sourceUid→source）
      const scanBag = (hub.scanBag ?? []).map((b) => ({
        id: b.id,
        numId: b.numId,
        ...(b.isAlter ? { persona: 1 } : {}),
        source: b.sourceUid,
      }));
      // props：{ [itemNumId字符串]: {count, uses} } → itemData.items
      const items = Object.entries(hub.props ?? {})
        .filter(([, v]) => (v?.count ?? 0) > 0)
        .map(([k, v]) => ({ itemId: Number(k), count: v?.count ?? 0 }));
      return { dex, scanBag, coin: hub.coin ?? 0, items };
    },
    // 草丛遭遇闭环（StartCaptureReq b7c267d7，捕获区）：**同步**返回本轮遭遇——读上一轮
    // 已落盘的 ARK_HUB.arkdexState.activeEncounter（错开一帧避免 async 竞态），并异步触发
    // 新一轮遭遇生成供下轮使用；返回 undefined 时网关回落兜底集（私服降级）。
    // activeEncounter 的清除由 EndCapture 结算（arkhubEndScan）负责，此处不直改存档。
    onScanStart: (uid: string, areaId: number | string) => {
      const p = player(uid);
      if (!p) return undefined;
      const hub = p._playerdata?.activity?.ARK_HUB?.[ARKHUB_ACT_ID];
      const enc = hub?.arkdexState?.activeEncounter;
      const current =
        enc && Array.isArray(enc.creatures) && enc.creatures.length > 0
          ? {
              creatures: enc.creatures
                .map((c) => Number(c?.numId))
                .filter((n) => Number.isFinite(n) && n > 0),
              ...(enc.lureNumId != null ? { lureNumId: Number(enc.lureNumId) } : {}),
            }
          : undefined;
      void arkhubStartEncounter(p, areaId).catch((e: Error) =>
        logger.warn("arkhub-session", `草丛遭遇生成失败: ${e.message}`),
      );
      return current && current.creatures.length > 0 ? current : undefined;
    },
    // 草丛扫描结算（EndCaptureReq b7c204e8 捕获成功）→ 发 15 券 + 数据库收录 +
    // 扫描仪入袋 + 任务/勋章事件（arkhubEndScan 接遭遇引擎；捕获子集由网关按客户端上报槽位解析）
    onScanSettle: (uid: string, capturedNumIds: number[]) => {
      const p = player(uid);
      if (!p) return;
      void arkhubEndScan(p, capturedNumIds).catch((e: Error) =>
        logger.warn("arkhub-session", `草丛扫描结算失败: ${e.message}`),
      );
    },
    // 巡展道具购买（购买帧 28f56f2c）→ 扣券 + 道具箱 + 生效次数 + 每日库存限购；
    // 返回 false 时网关回错误码（先业务后响应的时序由网关 await 保证）
    onBuyProp: (uid: string, itemNumId: number, count: number) => {
      const p = player(uid);
      if (!p) return undefined;
      return arkhubBuyProp(p, itemNumId, count).catch((e: Error) => {
        logger.warn("arkhub-session", `巡展道具购买失败: ${e.message}`);
        return { ok: false, code: ARKHUB_ERR.ITEM_NOT_ENOUGH };
      });
    },
    // 巡展道具使用（使用帧 28f5b1ab）：诱引剂写 activeLure 定向遭遇池；
    // 信息素扣生效次数 + 发射任务 15 事件（arkhubPheromoneScan）
    onUseProp: (uid: string, itemNumId: number, _count: number) => {
      const p = player(uid);
      if (!p) return undefined;
      const def = ARKDEX_PROPS[itemNumId];
      if (!def) return { ok: false, code: ARKHUB_ERR.ITEM_ID_INVALID };
      return arkhubUseProp(p, itemNumId)
        .then(async (r) => {
          if (r.ok && def.type === "pheromone") await arkhubPheromoneScan(p);
          return r;
        })
        .catch((e: Error) => {
          logger.warn("arkhub-session", `巡展道具使用失败: ${e.message}`);
          return { ok: false, code: ARKHUB_ERR.ITEM_CAN_NOT_USE };
        });
    },
    // 交换预设（PresetCreatureExchangeReq b7c2369e）→ 落 ARK_HUB.trade（arkhubSetTrade）
    onTradePreset: (uid: string, wantNumId: number, givingUniqueId: number) => {
      const p = player(uid);
      if (!p) return;
      void arkhubSetTrade(p, wantNumId, [givingUniqueId]).catch((e: Error) =>
        logger.warn("arkhub-session", `交换预设处理失败: ${e.message}`),
      );
    },
    // 发起交换（CreateCreatureExchangeReq b7c2394d）→ 任务 16 计数（arkhubDoTrade）
    onTradeCreate: (uid: string) => {
      const p = player(uid);
      if (!p) return;
      void arkhubDoTrade(p).catch((e: Error) =>
        logger.warn("arkhub-session", `交换计数处理失败: ${e.message}`),
      );
    },
    // 交换挂单回读（GetAllCreatureExchangeInfoResp 的 requests 回填，单机回显自己挂单）
    resolveTrade: (uid: string) => {
      const p = player(uid);
      if (!p) return undefined;
      const hub = p._playerdata?.activity?.ARK_HUB?.[ARKHUB_ACT_ID];
      const trade = hub?.trade;
      if (trade?.wantSpecies == null) return undefined;
      return {
        wantSpecies: Number(trade.wantSpecies),
        offeringUniqueId: Number(trade.offerNumIds?.[0] ?? 0),
        ts: Number(trade.ts ?? Date.now()),
      };
    },
    // 当日货架：hub.shopToday 落盘值优先（日期匹配），缺省回落确定性生成（同算法）
    resolveShopIds: (uid: string) => {
      const p = player(uid);
      if (!p) return undefined;
      return arkhubShopTodayIds(p) ?? arkhubDailyShopIds();
    },
    // 货架落盘（商店打开时触发；保证价格表与购买校验读同一份货架）
    onShopResolved: (uid: string, ids: number[]) => {
      const p = player(uid);
      if (!p) return;
      void arkhubPersistShopToday(p, ids).catch((e: Error) =>
        logger.warn("arkhub-session", `货架落盘失败: ${e.message}`),
      );
    },
    // 玩家当前奇象兑换券数（购买响应 f6 剩余券数；与 resolveArkDexGold 同源）
    resolveCoin: (uid: string) => {
      const p = player(uid);
      return p?._playerdata?.activity?.ARK_HUB?.act1arkhub?.coin ?? 0;
    },
    // 网关状态恢复（登录/重连）：存档 ARK_HUB 的 stateMask/settledDuels/activeEncounter
    // → 连接状态（重连与重启后掩码/对局去重/捕捉会话不丢）
    resolveGatewayState: (uid: string) => {
      const p = player(uid);
      if (!p) return undefined;
      try {
        return arkhubReadGatewayState(p);
      } catch (e) {
        logger.warn("arkhub-session", `网关状态读取失败: ${(e as Error).message}`);
        return undefined;
      }
    },
    // 状态掩码变更 → 落盘（hub.stateMask）
    onStateMaskChanged: (uid: string, mask: number) => {
      const p = player(uid);
      if (!p) return;
      void arkhubSetStateMask(p, mask).catch((e: Error) =>
        logger.warn("arkhub-session", `状态掩码落盘失败: ${e.message}`),
      );
    },
    // 对局结算去重键 → 落盘（hub.settledDuels，环形 64 条）
    onDuelSettled: (uid: string, battleId: string) => {
      const p = player(uid);
      if (!p) return;
      void arkhubRecordSettledDuel(p, battleId).catch((e: Error) =>
        logger.warn("arkhub-session", `对局去重键落盘失败: ${e.message}`),
      );
    },
    // 交互领奖一次性闸门（修复“每次进入都提示/重复领奖”）：
    // 同步判重 + 内存标记（防同一秒内连击），异步落盘；首次返回 true，已领返回 false。
    claimActorReward: (uid: string, claimKey: string) => {
      const p = player(uid);
      if (!p) return true;
      if (arkhubIsRewardClaimed(p, claimKey)) return false;
      const hub = p._playerdata?.activity?.ARK_HUB?.[ARKHUB_ACT_ID];
      if (hub) {
        hub.claimedRewards = hub.claimedRewards ?? {};
        hub.claimedRewards[claimKey] = Date.now(); // 同步内存标记，防并发重领
      }
      void arkhubMarkRewardClaimed(p, claimKey).catch((e: Error) =>
        logger.warn("arkhub-session", `领奖记录落盘失败: ${e.message}`),
      );
      return true;
    },
    // 每日物资今日是否已领（交互广播券数修正用）
    resolveDailyClaimed: (uid: string) => {
      const p = player(uid);
      const hub = p?._playerdata?.activity?.ARK_HUB?.[ARKHUB_ACT_ID];
      return hub?.dailySupplyLastDay === new Date().toDateString();
    },
  };
}
