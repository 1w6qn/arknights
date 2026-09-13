/**
 * 基建分区逻辑：杂项（BGM/留言板/表情/信息共享发起/预设队列）
 *
 * 由 BuildingManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import type { BuildingManager } from "../logic";
import { ItemBundle } from "@excel/excel";
import { now } from "@utils/time";
import { logger } from "@utils/logger";
import { Draft } from "mutative";
import { PlayerDataModel } from "../../../kernel/playerdata";
import { PlayerBuildingDIYPreset, PlayerStatus } from "../../../kernel/playerdata";
import { accountManager } from "../../account/public";
import { getMessageLeaveBoardConst } from "@excel/building_excel";
import type {
  ConfirmMessageBoardRewardRequest,
  GetThumbnailUrlRequest,
  SaveDiyPresetSolutionRequest,
  SendEmojiRequest,
  StartInfoShareRequest,
  VisitBuildingRequest,
} from "../models";
import type { BuildingWithExt, MeetingRoom, PresetQueueMetaDict, StatusExt } from "./ext-types";

  /**
   * 切换基建背景音乐
   * @param args - 包含 musicId 的参数对象
   */
export async function changeBGM(mgr: BuildingManager, args: { musicId: string }) {
    const { musicId } = args;
    return await mgr._player.update(async (draft) => {
      const music = draft.building.music;
      music.selected = musicId;
      // 修复：inUse 未同步——客户端按 inUse 判定是否启用 BGM 播放
      music.inUse = !!musicId;
    });
}

  /** 预设队列元数据（名称/锁定——官方线格式 room.presetQueue 仅为干员组数组，无名称） */
export function _presetQueues(mgr: BuildingManager, draft: Draft<PlayerDataModel>) : PresetQueueMetaDict {
    const building = draft.building as BuildingWithExt;
    if (!building.presetQueues) building.presetQueues = {};
    return building.presetQueues;
}

  /**
   * 获取房间的预设队列数组（官方线格式：room.presetQueue = number[][]，按索引）。
   * 含 presetQueue 字段的房间类型：MANUFACTURE/TRADING/POWER/CONTROL/MEETING/HIRE。
   * @returns 房间队列数组（不存在该字段的房间返回 null）
   */
export function _roomPresetQueue(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    slotId: string,) : number[][] | null {
    const slot = draft.building.roomSlots[slotId];
    if (!slot) return null;
    const roomType = slot.roomId as keyof PlayerDataModel["building"]["rooms"];
    const room = draft.building.rooms[roomType]?.[slotId] as {
      presetQueue?: number[][];
    } | undefined;
    if (!room) return null;
    if (!Array.isArray(room.presetQueue)) room.presetQueue = [];
    return room.presetQueue;
}

  /**
   * 添加预设队列
   * 对齐官方：CS BuildingAddPresetQueueRequest 仅 { slotId }——把房间当前排班
   * （charInstIds）追加为新队列；兼容请求体显式携带 charInstIdList。
   * @param args - { slotId }（或 roomSlotId）+ 可选 charInstIdList
   */
export async function addPresetQueue(mgr: BuildingManager, args: {
    slotId?: string;
    roomSlotId?: string;
    charInstIdList?: number[];
    presetName?: string;
  }) {
    const slotId = args.slotId ?? args.roomSlotId;
    if (!slotId) return;
    return await mgr._player.update(async (draft) => {
      const queue = mgr._roomPresetQueue(draft, slotId);
      if (!queue) return;
      const charInstIdList =
        args.charInstIdList ??
        draft.building.roomSlots[slotId]?.charInstIds ??
        [];
      queue.push([...charInstIdList]);
    });
}

  /**
   * 删除预设队列（按索引）
   * 对齐官方：CS BuildingDeletePresetQueueRequest { slotId, index }。
   * @param args - { slotId, index }
   */
export async function deletePresetQueue(mgr: BuildingManager, args: {
    slotId?: string;
    roomSlotId?: string;
    index?: number;
  }) {
    const slotId = args.slotId ?? args.roomSlotId;
    if (!slotId) return;
    return await mgr._player.update(async (draft) => {
      const queue = mgr._roomPresetQueue(draft, slotId);
      if (!queue) return;
      const idx = args.index ?? 0;
      if (idx >= 0 && idx < queue.length) queue.splice(idx, 1);
    });
}

  /**
   * 编辑预设队列（按索引）
   * 对齐官方：CS BuildingEditPresetQueueRequest { slotId, index, queue }。
   * @param args - { slotId, index, queue }
   */
export async function editPresetQueue(mgr: BuildingManager, args: {
    slotId?: string;
    roomSlotId?: string;
    index?: number;
    queue?: number[];
    charInstIdList?: number[];
  }) {
    const slotId = args.slotId ?? args.roomSlotId;
    if (!slotId) return;
    const queueList = args.queue ?? args.charInstIdList;
    if (!Array.isArray(queueList)) return;
    return await mgr._player.update(async (draft) => {
      const queue = mgr._roomPresetQueue(draft, slotId);
      if (!queue) return;
      const idx = args.index ?? 0;
      if (idx >= 0 && idx < queue.length) queue[idx] = [...queueList];
    });
}

  /**
   * 使用预设队列（应用干员到房间，清空其他房间占用）
   * 对齐官方：CS BuildingUsePresetQueueRequest { slotId, index }——应用 room.presetQueue[index]。
   * @param args - { slotId, index }
   */
export async function usePresetQueue(mgr: BuildingManager, args: {
    slotId?: string;
    roomSlotId?: string;
    index?: number;
  }) {
    const slotId = args.slotId ?? args.roomSlotId;
    if (!slotId) return;
    return await mgr._player.update(async (draft) => {
      const queue = mgr._roomPresetQueue(draft, slotId);
      if (!queue || queue.length === 0) return;
      const idx = Math.min(args.index ?? 0, queue.length - 1);
      const charInstIdList = queue[idx];
      if (!Array.isArray(charInstIdList)) return;
      // 清空这些干员在其他房间的占用
      for (const slotKey in draft.building.roomSlots) {
        if (slotKey === slotId) continue;
        const ids = draft.building.roomSlots[slotKey].charInstIds;
        for (let i = 0; i < ids.length; i++) {
          if (charInstIdList.includes(ids[i])) ids[i] = -1;
        }
      }
      draft.building.roomSlots[slotId].charInstIds = [...charInstIdList];
      // 换班后立即按新岗位重算心情档位
      mgr._recomputeCharScales(draft);
    });
}

  /**
   * 使用单个预设队列（单房间版，自动选中心情相对高的预设）
   * @param args - { slotId }（或 roomSlotId）
   */
export async function useOnePresetQueue(mgr: BuildingManager, args: {
    slotId?: string;
    roomSlotId?: string;
  }) {
    const slotId = args.slotId ?? args.roomSlotId;
    if (!slotId) return;
    return await mgr._player.update(async (draft) => {
      // 自动选该房间预设队列中「干员当前心情总和最高」的一组（心情相对高的预设）
      const charInstIdList = mgr._pickHighestApPreset(draft, slotId);
      if (!Array.isArray(charInstIdList)) return;
      // 清空这些干员在其他房间的占用
      for (const slotKey in draft.building.roomSlots) {
        if (slotKey === slotId) continue;
        const ids = draft.building.roomSlots[slotKey].charInstIds;
        for (let i = 0; i < ids.length; i++) {
          if (charInstIdList.includes(ids[i])) ids[i] = -1;
        }
      }
      draft.building.roomSlots[slotId].charInstIds = [...charInstIdList];
      // 换班后立即按新岗位重算心情档位
      mgr._recomputeCharScales(draft);
    });
}

  /**
   * 修改预设名称（私服扩展：名称存 building.presetQueues 元数据，官方线格式无名称）
   * @param args - 包含 slotId/roomSlotId 和 presetName（或 name）的参数对象
   */
export async function changePresetName(mgr: BuildingManager, args: {
    slotId?: string;
    roomSlotId?: string;
    presetName?: string;
    name?: string;
  }) {
    const slotId = args.slotId ?? args.roomSlotId;
    const presetName = args.presetName ?? args.name;
    if (!slotId) return;
    return await mgr._player.update(async (draft) => {
      const queues = mgr._presetQueues(draft);
      const meta = (queues[slotId] ??= {});
      meta.name = presetName ?? "";
    });
}

  /**
   * 保存自定义预设方案（diyPresetSolutions）
   * @param args - 包含 presetName 和 solution 的参数对象
   */
export async function saveDiyPresetSolution(mgr: BuildingManager, args: {
    presetName: string;
    solution: SaveDiyPresetSolutionRequest["solution"];
  }) {
    const { presetName, solution } = args;
    return await mgr._player.update(async (draft) => {
      // 服务端按 CS BuildingDIYSavePresetSolutionRequest.solution（PlayerBuildingDIYSolution）原样写入；
      // 生成模型把该字典值声明为 PlayerBuildingDIYPreset（客户端读取形态）→ 就地按写入侧形状断言
      draft.building.diyPresetSolutions[presetName] = solution as PlayerBuildingDIYPreset;
    });
}

  /**
   * 编辑锁定队列（记录锁定状态到元数据）
   * @param args - 包含 slotId/roomSlotId 和 locked 的参数对象
   */
export async function editLockQueue(mgr: BuildingManager, args: { slotId?: string; roomSlotId?: string; locked: boolean }) {
    const slotId = args.slotId ?? args.roomSlotId;
    if (!slotId) return;
    return await mgr._player.update(async (draft) => {
      const queues = mgr._presetQueues(draft);
      const meta = (queues[slotId] ??= {});
      meta.locked = args.locked;
    });
}

  /**
   * 确认留言板奖励（会客室留言板）
   * 领取 messageLeave.sp.lastWeek 社交点（信用）→ status.socialPoint；累计 lastWeekSum。
   * 参考 CS BuildingPayloadConfirmMessageBoardRewardResponse { reward: List<ItemBundle> }
   * @param args - 请求体参数（无字段）
   * @returns 领取的社交点奖励（SOCIAL_PT 信用 ItemBundle 数组；无可领返回空）
   */
export async function confirmMessageBoardReward(mgr: BuildingManager, args: ConfirmMessageBoardRewardRequest) : Promise<
    { id: string; count: number; type: string }[]
  > {
    let reward = 0;
    await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      const leave = room?.messageLeave;
      if (!leave) return;
      reward = leave.sp?.lastWeek ?? 0;
      if (reward <= 0) return;
      draft.status.socialPoint = (draft.status.socialPoint ?? 0) + reward;
      leave.sp.lastWeekSum = (leave.sp.lastWeekSum ?? 0) + reward;
      leave.sp.lastWeek = 0;
      leave.lastUpdateSpTs = now();
    });
    return reward > 0 ? [{ id: "SOCIAL_PT", count: reward, type: "SOCIAL_PT" }] : [];
}

  /**
   * 获取留言板内容（会客室留言板）
   * 返回 CS BuildingPayloadGetMessageBoardContentResponse 形状：
   * 访客列表（无社交数据返回空）+ 访问统计 + lastWeekSpReward（上周可领取社交点）。
   * 修复：原实现透传请求体（202 空响应，客户端留言板空白）；现按 messageLeave 状态返回。
   * @param args - 请求体参数（无字段）
   * @returns 留言板内容
   */
export async function getMessageBoardContent(mgr: BuildingManager, args: {
    uid?: string;
    friendId?: string;
  }) : Promise<{
    thisWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    lastWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    todayVisit: number;
    weeklyVisit: number;
    lastWeekVisit: number;
    lastWeekSpReward: number;
    lastShowTs: number;
  }> {
    let board = {
      thisWeekVisitors: [] as { uid: string; nickName: string; nickNumber: string }[],
      lastWeekVisitors: [] as { uid: string; nickName: string; nickNumber: string }[],
      todayVisit: 0,
      weeklyVisit: 0,
      lastWeekVisit: 0,
      lastWeekSpReward: 0,
      lastShowTs: now(),
    };
    await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      // 懒初始化 messageLeave（旧存档缺失）
      room.messageLeave = room.messageLeave ?? {
        inUse: false,
        lastVisitTs: 0,
        lastShowTs: 0,
        lastUpdateSpTs: 0,
        sp: { lastWeek: 0, lastWeekSum: 0, thisWeek: 0, thisWeekSum: 0 },
      };
      const leave = room.messageLeave;
      leave.lastShowTs = now();
      board = {
        thisWeekVisitors: [],
        lastWeekVisitors: [],
        todayVisit: 0,
        weeklyVisit: leave.sp?.thisWeek ?? 0,
        lastWeekVisit: leave.sp?.lastWeekSum ?? 0,
        lastWeekSpReward: leave.sp?.lastWeek ?? 0,
        lastShowTs: leave.lastShowTs,
      };
    });
    return board;
}

  /**
   * 获取协助报告
   * 参考实现：返回近 4 天的制造/贸易/信赖报告数据
   * @returns 包含 reports 数组的对象
   */
export async function getAssistReport(mgr: BuildingManager) {
    const ts = now();
    return {
      reports: [
        { ts, manufacture: {}, trading: {}, favor: [] },
        { ts: ts - 86400, manufacture: {}, trading: {}, favor: [] },
        { ts: ts - 172800, manufacture: {}, trading: {}, favor: [] },
        { ts: ts - 345600, manufacture: {}, trading: {}, favor: [] },
      ],
    };
}

  /**
   * 获取信息共享访客数
   *
   * 修复：原实现恒返回 0——客户端会客室"可访问人数"徽标恒空；
   * 现按好友数返回（私服访客 = 好友列表，与 getInfoShareReward 同源）。
   *
   * @returns 包含 num 字段的对象
   */
export async function getInfoShareVisitorsNum(mgr: BuildingManager) {
    const uid = String(mgr._player._playerdata.status.uid);
    let num = 0;
    try {
      const social = await accountManager.getSocial(uid);
      num = social.friends.length;
    } catch (e) {
      logger.warn(
        "building",
        `getInfoShareVisitorsNum 好友数据加载失败: ${(e as Error).message}`,
      );
    }
    return { num };
}

  /**
   * 获取最近访客
   *
   * 修复：原实现恒空——客户端"最近来访"列表空白；私服访客 = 好友列表
   * （无真实访问记录，ts 用注册时间），结构对齐 CS RecentVisitor。
   *
   * @returns 包含 visitors 字段的对象
   */
export async function getRecentVisitors(mgr: BuildingManager) : Promise<{
    visitors: {
      uid: string;
      nickName: string;
      nickNumber: string;
      secretary: string;
      secretarySkinId: string;
      level: number;
      ts: number;
    }[];
  }> {
    const uid = String(mgr._player._playerdata.status.uid);
    let visitors: {
      uid: string;
      nickName: string;
      nickNumber: string;
      secretary: string;
      secretarySkinId: string;
      level: number;
      ts: number;
    }[] = [];
    try {
      const social = await accountManager.getSocial(uid);
      visitors = (
        await Promise.all(
          social.friends.map(async (f) => {
            try {
              const info = await accountManager.getPlayerFriendInfo(f.uid);
              return {
                uid: f.uid,
                nickName: info.nickName,
                nickNumber: info.nickNumber,
                secretary: info.secretary ?? "",
                secretarySkinId: info.secretarySkinId ?? "",
                level: info.level,
                ts: info.registerTs ?? 0,
              };
            } catch (err) {
              logger.warn(
                "building",
                `getRecentVisitors 好友 ${f.uid} 数据加载失败: ${(err as Error).message}`,
              );
              return null;
            }
          }),
        )
      ).filter((v): v is NonNullable<typeof v> => v !== null);
    } catch (e) {
      logger.warn(
        "building",
        `getRecentVisitors 好友列表加载失败: ${(e as Error).message}`,
      );
    }
    return { visitors };
}

  /**
   * 获取他人留言板内容
   *
   * 修复：原实现纯透传（客户端拿到空响应，访问好友基建留言板空白）；
   * 现读取好友存档的会客室 messageLeave 状态返回（只读，不修改对方数据）。
   *
   * @param args - 请求体参数（uid）
   * @returns 对方留言板内容（结构同 getMessageBoardContent）
   */
export async function getOthersMessageBoardContent(mgr: BuildingManager, args: {
    uid?: string;
    friendId?: string;
  }) : Promise<{
    thisWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    lastWeekVisitors: { uid: string; nickName: string; nickNumber: string }[];
    todayVisit: number;
    weeklyVisit: number;
    lastWeekVisit: number;
    lastWeekSpReward: number;
    lastShowTs: number;
  }> {
    const emptyBoard = () => ({
      thisWeekVisitors: [] as { uid: string; nickName: string; nickNumber: string }[],
      lastWeekVisitors: [] as { uid: string; nickName: string; nickNumber: string }[],
      todayVisit: 0,
      weeklyVisit: 0,
      lastWeekVisit: 0,
      lastWeekSpReward: 0,
      lastShowTs: now(),
    });
    const uid = String(args.uid ?? args.friendId ?? "");
    if (!uid || uid === String(mgr._player._playerdata.status.uid)) {
      return emptyBoard();
    }
    try {
      const friend = await accountManager.getPlayerData(uid);
      const room: MeetingRoom | undefined = Object.values(
        friend._playerdata.building?.rooms?.MEETING ?? {},
      )[0];
      const leave = room?.messageLeave;
      return {
        thisWeekVisitors: [],
        lastWeekVisitors: [],
        todayVisit: 0,
        weeklyVisit: leave?.sp?.thisWeek ?? 0,
        lastWeekVisit: leave?.sp?.lastWeekSum ?? 0,
        lastWeekSpReward: leave?.sp?.lastWeek ?? 0,
        lastShowTs: leave?.lastShowTs ?? 0,
      };
    } catch (e) {
      logger.warn(
        "building",
        `getOthersMessageBoardContent 好友 ${uid} 数据加载失败: ${(e as Error).message}`,
      );
      return emptyBoard();
    }
}

  /**
   * 获取缩略图 URL
   * 简化实现：预留接口（私服无云端缩略图），返回空列表
   * @param args - 请求体参数
   */
export async function getThumbnailUrl(mgr: BuildingManager, args: GetThumbnailUrlRequest) {
    return { list: [] };
}

  /**
   * 发送表情
   * 简化实现：参考 Python 实现返回 202，预留接口
   * @param args - 请求体参数
   */
export async function sendEmoji(mgr: BuildingManager, args: SendEmojiRequest) {
    return args;
}

  /**
   * 开始信息共享（会客室情报分享会话）
   * 对齐官方：记录会话开始时间 infoShare.ts = now——访客列表按会话划分，
   * 早于该时间的访客视为"已分享过"（客户端不再重复计信用）。
   * 官方响应 delta 含会客室干员体力累积（抓包 res_1071）→ 同步推进 _accrueCharAp。
   * 修复：原实现透传请求体（202 不落状态）→ 会话永不推进 → 同一批访客
   * 每次都被视为新访客 → 无限信用点。
   * @param args - 请求体参数
   */
export async function startInfoShare(mgr: BuildingManager, args: StartInfoShareRequest) {
    await mgr._player.update(async (draft) => {
      mgr._accrueCharAp(draft);
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      room.infoShare.ts = now();
      room.infoShare.reward = mgr._infoShareReward(room.socialReward);
    });
    // 修复：StartInfoShare 任务事件从未 emit → 开启信息分享类任务永不推进
    await mgr._trigger.emit("StartInfoShare", []);
}

  /**
   * 访问好友基建
   * 修复：原为纯透传 stub——VisitBuilding 是每日任务（26 个），事件从不 emit 任务
   * 永不推进；补事件 + 被访方发放社交点（align S5 社交点来源）
   *
   * 再修复（2026-08-14 信用经济）：被访方社交点改为**被动信用**入账——
   * socialReward.daily += friendSlotInc（封顶 creditPassiveLimit），经
   * getMeetingroomReward 领取；原实现直接 +20 socialPoint（绕过信用循环）。
   *
   * @param args - 请求体参数（friendId）
   */
export async function visitBuilding(mgr: BuildingManager, args: VisitBuildingRequest) {
    const friendId = args?.friendId;
    // 修复：VisitBuilding 任务事件从未 emit → 访问基建任务永不推进
    await mgr._trigger.emit("VisitBuilding", []);
    // 修复（2026-08-24，C 类好友访问信用）：访问开启线索交流的好友基建 → **访问方**获得
    // 30 信用，每场限 1 次、每日上限 10 次（PRTS）。不再给好友(owner)发放 friendSlotInc——
    // 原方向错误（文档为访问方收益），且私服好友多为模板账号无意义。
    if (friendId && String(friendId) !== String(mgr._player.uid)) {
      await mgr._player.update(async (draft) => {
        const st = draft.status as PlayerStatus & StatusExt;
        const dayKey = Math.floor(now() / 86400);
        const sameDay = st.visitCreditDay === dayKey;
        const used = sameDay ? (st.visitCreditCount ?? 0) : 0;
        // 修复（2026-09-09，B6）：补「同一好友每日只计 1 次」——原实现只限每日 10 次，
        // 反复访问同一好友即可连刷 10×30；官服为「每场限 1 次」。
        // 已计次的好友列表按自然日重置（服务端扩展字段，客户端忽略）。
        const credited: string[] = sameDay && Array.isArray(st.visitCreditIds)
          ? st.visitCreditIds.map(String)
          : [];
        const key = String(friendId);
        if (used >= 10 || credited.includes(key)) return;
        // 访客信用数值取 clue_data.messageLeaveBoardConstData.visitorBonus（实测 30）
        const bonus = getMessageLeaveBoardConst().visitorBonus ?? 30;
        draft.status.socialPoint = (draft.status.socialPoint ?? 0) + bonus;
        st.visitCreditDay = dayKey;
        st.visitCreditCount = used + 1;
        st.visitCreditIds = [...credited, key];
      });
    }
    return args;
}
