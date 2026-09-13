/**
 * 基建分区逻辑：会客室与线索（每日线索/收发/面板/线索箱/信息共享/访问）
 *
 * 由 BuildingManager 拆分而来：函数首参 mgr 为管理器实例，
 * 类侧保留同名薄委派（见 logic.ts）。
 */
import { BuildingManager } from "../logic";
import { ItemBundle } from "@excel/excel";
import { now } from "@utils/time";
import { logger } from "@utils/logger";
import { Draft } from "mutative";
import { PlayerDataModel } from "../../../kernel/playerdata";
import { PlayerBuildingMeetingClue, PlayerPushFlags } from "../../../kernel/playerdata";
import { accountManager } from "../../account/public";
import { getManufactFormula, getWorkshopFormula, getBuildingConstant, getRoomPhase, getGoldRate, getManufactPhase, getDormPhase, getFurnitureInfo, getRoomMaxLevel, getManufactFormulaType, getRoomElectricity, getMeetingPhase, getHirePhase, getClueExpiredDays, getMessageLeaveBoardConst, getClueConstant, getClueReceiveBonus } from "@excel/building_excel";
import {
  CharBuffSource,
  roomSpeedBonus,
  controlGlobalBonus,
  charMoodCost,
  getActiveCharBuffs,
  parseVupValue,
  phaseRank,
} from "../buff";
import { random } from "@utils/random";
import { OWN_CLUE_LIMIT } from "../clue-speed";
import type { GetDailyClueRequest, PutClueToTheBoardAutoRequest, SendClueAutoRequest } from "../models";
import type { MeetingRoom } from "./ext-types";

  /** 获取首个会客室房间 */
export function _meetingRoom(mgr: BuildingManager) {
    const rooms = mgr._player._playerdata.building.rooms.MEETING;
    return Object.values(rooms)[0];
}

  /**
   * 会客室线索阵营加权选择（特殊技能适配）
   *
   * meet_spd_notOwned（晓歌）：更容易获得线索板上尚未拥有的线索 → 未上板阵营权重 ×2；
   * meet_spd_Owned（U-Official）：更容易获得已拥有的线索 → 已上板阵营权重 ×2。
   * 私服无真实访客线索交换，getDailyClue 是唯一线索来源——按进驻会客室干员的
   * 技能修正各阵营抽取权重，使"未拥有线索"技能实际生效。
   * @param draft - mutative 可写草稿
   * @param room - 会客室房间对象
   * @returns 加权选出的阵营
   */
export function _clueFactionWeighted(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    room: MeetingRoom,) : string {
    const factions = BuildingManager._CLUE_FACTIONS;
    const slot = Object.values(draft.building.roomSlots).find(
      (s) => s.roomId === "MEETING",
    );
    const chars = mgr._roomCharSources(draft, slot ?? null);
    const hasSkill = (re: RegExp) =>
      chars.some((c) =>
        getActiveCharBuffs(c, "MEETING").some((b) => re.test(b?.buffId ?? "")),
      );
    const preferNew = hasSkill(/^meet_spd_notOwned/);
    const preferOwned = hasSkill(/^meet_spd_Owned/);
    const onBoard = new Set(Object.keys(room?.board ?? {}));
    // 加权随机：未上板阵营在 preferNew 时 ×2；已上板阵营在 preferOwned 时 ×2
    const weights = factions.map((f) => {
      let w = 1;
      const isOnBoard = onBoard.has(f);
      if (preferNew && !isOnBoard) w *= 2;
      if (preferOwned && isOnBoard) w *= 2;
      return w;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    let r = random() * total;
    for (let i = 0; i < factions.length; i++) {
      r -= weights[i];
      if (r <= 0) return factions[i];
    }
    return factions[factions.length - 1];
}

  /**
   * 获取每日线索
   * 每日一条免费线索（dailyReward 已领则不重复发放）
   * 真实格式：type=阵营、id={uid}#{随机}#{时间戳}
   * @param args - 请求体参数
   */
export async function getDailyClue(mgr: BuildingManager, args: GetDailyClueRequest) {
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room || room.dailyReward) return;
      // PRTS《罗德岛基建/会客室》：「仅在有干员进驻时，每日 4:00 可发放 1 份会客室
      // 线索」——空会客室不发放（修复 2026-09-09，B11：原实现无进驻校验）。
      const meetingSlot = Object.values(draft.building.roomSlots).find(
        (s) => (s as { roomId?: string })?.roomId === "MEETING",
      );
      if (mgr._roomCharSources(draft, meetingSlot ?? null).length === 0) return;
      // 自有库上限 10：「最多存储 10 份，达到上限时无法继续入库」——每日发放的线索
      // 不适用干员搜集的「滞留」规则，满库时不入库（腾空后当日仍可领取，dailyReward
      // 不置位，故不会永久损失）。
      if ((room.ownStock?.length ?? 0) >= OWN_CLUE_LIMIT) return;
      const status = draft.status;
      // 特殊技能适配：进驻会客室干员的线索概率技能影响阵营抽取权重
      const clue: PlayerBuildingMeetingClue = {
        id: `${status.uid}#${Math.floor(random() * 9000 + 1000)}#${now()}`,
        type: mgr._clueFactionWeighted(draft, room),
        number: 1 + Math.floor(random() * 3),
        uid: String(status.uid),
        name: status.nickName,
        nickNum: String(status.nickNumber),
        chars: [],
        inUse: 0,
        // 修复（2026-08-25）：ownStock 线索写入绝对过期时间戳（now + expiredDays×86400，
        // 与 sendClue/receiveClueToStock 一致）。原实现不写 ts → 客户端不显示剩余时间、
        // 服务端过期清理（_purgeExpiredClues）只认 ts → 自己的线索永不过期、永不销毁。
        ts: now() + getClueExpiredDays() * 86400,
      };
      room.ownStock.push(clue);
      room.dailyReward = clue;
      // 线索生成信用（PRTS：每张线索 +20；数值取 clue_data.outputBasicBonus，勿写死）
      draft.status.socialPoint =
        (draft.status.socialPoint ?? 0) +
        (getClueConstant("outputBasicBonus") ?? 20);
      // 推送：新线索可处理 → 客户端会客室红点
      draft.pushFlags.hasClues = 1;
    });
}

  /**
   * 发送线索（ownStock → receiveStock，私服简化在同一玩家库存间流转）
   *
   * 修复：CS BuildingMeetingClueSendClueRequest 字段为 clueId/friendId——
   * 原实现读 id（客户端发 clueId）→ 空 delta；现兼容两种形态。
   *
   * @param args - 包含 id（或 clueId）和 friendId 的参数对象
   */
export async function sendClue(mgr: BuildingManager, args: { id?: string; clueId?: string; friendId: string }) {
    const id = args.id ?? args.clueId;
    const { friendId } = args;
    if (!id) return;
    let sent = false;
    await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      const idx = room.ownStock.findIndex((c) => c.id === id);
      if (idx === -1) return;
      const clue = room.ownStock.splice(idx, 1)[0];
      clue.uid = String(friendId);
      // 好友赠送的线索进入线索盒（receiveStock）后限时保留：
      // 写入绝对过期时间戳（now + expiredDays×86400），到期由自动清理移除。
      clue.ts = now() + getClueExpiredDays() * 86400;
      room.receiveStock.push(clue);
      sent = true;
      // 传递线索信用（PRTS：向好友传递线索每张 +20；数值取 clue_data.transferBonus）
      draft.status.socialPoint =
        (draft.status.socialPoint ?? 0) +
        (getClueConstant("transferBonus") ?? 20);
      // 推送：同步会客室红点（存在未上板线索 → 1）
      mgr._refreshClueFlag(draft, room);
    });
    // 修复：SendClue 任务事件从未 emit → 发送线索类任务永不推进
    if (sent) {
      await mgr._trigger.emit("SendClue", []);
    }
}

  /**
   * 自动发送线索（发送第一条可发线索）
   * @param args - 请求体参数
   */
export async function sendClueAuto(mgr: BuildingManager, args: SendClueAutoRequest) {
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room || room.ownStock.length === 0) return;
      const clue = room.ownStock.shift()!;
      // 好友赠送的线索进入线索盒（receiveStock）后限时保留（同 sendClue）
      clue.ts = now() + getClueExpiredDays() * 86400;
      room.receiveStock.push(clue);
      // 传递线索信用（与 sendClue 一致，取 clue_data.transferBonus）
      draft.status.socialPoint =
        (draft.status.socialPoint ?? 0) +
        (getClueConstant("transferBonus") ?? 20);
      // 修复：自动发送后同步红点（与 sendClue 一致）
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 接收线索到库存（receiveStock → ownStock）
   *
   * 修复：CS BuildingMeetingClueReceiveClueToStockRequest 字段为 clues（列表）——
   * 原实现读 id（客户端发 clues）→ 空 delta；现兼容两种形态。
   *
   * @param args - 包含 id（或 clues 列表）的参数对象
   */
export async function receiveClueToStock(mgr: BuildingManager, args: { id?: string; clues?: string[] }) {
    const ids = args.clues?.length ? args.clues : args.id ? [args.id] : [];
    if (ids.length === 0) return;
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0] as MeetingRoom;
      if (!room) return;
      for (const id of ids) {
        const idx = room.receiveStock.findIndex((c) => c.id === id);
        if (idx === -1) continue;
        const clue = room.receiveStock.splice(idx, 1)[0];
        room.ownStock.push(clue);
        // 接收好友线索信用（PRTS：每张依次 15/10/5，第 4 张起不获信用，每日刷新计次）
        // 数值取 clue_data.receiveTimeBonus（第 n 张 → receiveBonus）
        const receiveIdx = room.clueReceiveCount ?? 0;
        const receivePt = getClueReceiveBonus(receiveIdx);
        if (receivePt > 0) {
          draft.status.socialPoint = (draft.status.socialPoint ?? 0) + receivePt;
          room.clueReceiveCount = receiveIdx + 1;
        }
      }
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 放置线索到留言板
   *
   * 修复（2026-08-14，官方存档格式校准）：
   * 1. CS BuildingMeetingCluePutClueToTheBoardRequest 字段为 clueId——
   *    原实现读 id（客户端发 clueId）→ 空 delta；现兼容两种形态；
   * 2. **官方 board 格式为 {[阵营type]: clueId}**（key=阵营、value=线索 id，
   *    见真实存档 2222：{"RHINE":"100566259#3490#...",...}）——原实现写成
   *    {[clueId]: clueId}，客户端按阵营槽位读板 → 上板线索不可见；
   * 3. **线索保留在 ownStock 中，以 inUse=1 标记上板**（官方存档中板线索
   *    仍在库存）——原实现 splice 移除，取下时线索数据丢失。
   *
   * @param args - 包含 id（或 clueId）的参数对象
   */
export async function putClueToTheBoard(mgr: BuildingManager, args: { id?: string; clueId?: string }) {
    const id = args.id ?? args.clueId;
    if (!id) return;
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      const idx = room.ownStock.findIndex((c) => c.id === id);
      if (idx === -1) return;
      const clue = room.ownStock[idx];
      // 官方模型：board = {[阵营type]: clueId}；线索保留库存，inUse=1 标记上板
      room.board[clue.type] = clue.id;
      clue.inUse = 1;
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 自动放置线索到留言板（放置全部可放线索）
   *
   * 修复：同 putClueToTheBoard——board 按阵营索引、线索保留在 ownStock（inUse=1）。
   *
   * @param args - 请求体参数
   */
export async function putClueToTheBoardAuto(mgr: BuildingManager, args: PutClueToTheBoardAutoRequest) {
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      for (const clue of room.ownStock) {
        room.board[clue.type] = clue.id;
        clue.inUse = 1;
      }
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 从留言板取回线索（CS BuildingMeetingClueTakeClueFromBoardRequest { type }，
   * 客户端 UnequipClue 调用——按阵营取下该槽位线索回库存）
   *
   * 新增（2026-08-14 协议审计补齐）：此前无此端点，上板线索无法取下。
   * 官方模型：board[type] = clueId，线索在库存中以 inUse=1 标记——取回即
   * 删除 board 条目并复位 inUse=0。
   *
   * @param args - 包含 type（阵营，如 RHINE）的参数对象
   */
export async function takeClueFromBoard(mgr: BuildingManager, args: { type?: string }) {
    const type = args?.type;
    if (!type) return;
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room?.board) return;
      const clueId = room.board[type];
      if (!clueId) return;
      delete room.board[type];
      // 线索在库存中（inUse=1）→ 复位为未上板
      const clue = [...(room.ownStock ?? []), ...(room.receiveStock ?? [])].find(
        (c) => c.id === clueId,
      );
      if (clue) clue.inUse = 0;
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 删除自己持有的线索
   *
   * 修复：CS BuildingMeetingClueDeleteOwnClueRequest 字段为 clueId——
   * 原实现读 id（客户端发 clueId）→ 空 delta；现兼容两种形态；
   * 同时清理指向该线索的留言板条目（上板线索被删除时不留孤儿索引）。
   *
   * @param args - 包含 id（或 clueId）的参数对象
   */
export async function deleteOwnClue(mgr: BuildingManager, args: { id?: string; clueId?: string }) {
    const id = args.id ?? args.clueId;
    if (!id) return;
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      const before = room.ownStock.length;
      room.ownStock = room.ownStock.filter((c) => c.id !== id);
      // 回收自有库线索信用（PRTS：每张 +5；数值取 clue_data.recycleBonus）——确实删除了一条才发放
      if (room.ownStock.length < before) {
        draft.status.socialPoint =
          (draft.status.socialPoint ?? 0) +
          (getClueConstant("recycleBonus") ?? 5);
      }
      mgr._clearBoardEntry(draft, room, id);
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 删除接收到的线索
   *
   * 修复：CS BuildingMeetingClueDeleteReceiveClueRequest 字段为 clueId——
   * 原实现读 id（客户端发 clueId）→ 空 delta；现兼容两种形态；
   * 同时清理指向该线索的留言板条目。
   *
   * @param args - 包含 id（或 clueId）的参数对象
   */
export async function deleteReceiveClue(mgr: BuildingManager, args: { id?: string; clueId?: string }) {
    const id = args.id ?? args.clueId;
    if (!id) return;
    return await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      room.receiveStock = room.receiveStock.filter((c) => c.id !== id);
      mgr._clearBoardEntry(draft, room, id);
      mgr._refreshClueFlag(draft, room);
    });
}

  /**
   * 内部方法：清理留言板中指向指定线索 id 的条目（board = {[type]: clueId}）
   */
export function _clearBoardEntry(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    room: MeetingRoom,
    clueId: string,) : void {
    if (!room?.board) return;
    for (const [type, id] of Object.entries(room.board)) {
      if (id === clueId) delete room.board[type];
    }
}

  /**
   * 内部方法：刷新会客室红点（hasClues）——存在未上板（inUse=0）的线索 → 1
   * 官方模型：上板线索保留在库存（inUse=1），不计入"待处理"红点
   */
export function _refreshClueFlag(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    room: MeetingRoom,) : void {
    const pending = [
      ...(room?.ownStock ?? []),
      ...(room?.receiveStock ?? []),
    ].some((c) => (c?.inUse ?? 0) === 0);
    if (!draft.pushFlags) {
      // 旧存档缺 pushFlags：按既有行为先建空对象再写 hasClues
      // （生成模型声明为全字段必填，此处仅建将写入的键，故断言）
      draft.pushFlags = {} as PlayerPushFlags;
    }
    draft.pushFlags.hasClues = pending ? 1 : 0;
}

  /**
   * 内部方法：自动移除会客室库存（ownStock + receiveStock）中已过期的线索
   *
   * 官方模型：线索（无论自己获得还是好友赠送）携带绝对过期时间戳
   * （PlayerBuildingMeetingClue.ts，客户端 MeetingClueRestTimeLabel 按 ts 显示剩余
   * 时间），过期后服务端同步时自动移除，避免库存堆积过期线索。
   *
   * 私服实现：getDailyClue/sendClue/sendClueAuto/receiveClueToStock 均写入
   * ts = now + expiredDays×86400。
   * 修复（2026-08-25）：
   * - 旧存档/修复前生成的线索无 ts（抓包证实 inUse=1 上板线索 ts=undefined）→
   *   客户端无剩余时长可显示（剩余时长不更新）、清理"无 ts 不删"→ 永不过期。
   *   此处给无 ts 线索补写 ts = now + expiredDays×86400（从现在起算），使其进入
   *   过期机制且客户端剩余时长正常显示。
   * - 过期线索若为上板（inUse=1），同步清理留言板索引（board = {[type]: clueId}），
   *   不留孤儿槽位。
   * - 清理后统一清除 board 中指向已不存在线索的孤儿索引（历史残留防御）。
   *
   * @param draft - mutative 可写草稿
   * @param room - 会客室房间对象
   * @param ts - 当前时间基准（秒）
   * @returns 移除的线索数量
   */
export function _purgeExpiredClues(mgr: BuildingManager, draft: Draft<PlayerDataModel>,
    room: MeetingRoom,
    ts: number,) : number {
    let removed = 0;
    for (const key of ["ownStock", "receiveStock"] as const) {
      const stock = room?.[key];
      if (!Array.isArray(stock) || stock.length === 0) continue;
      const kept: PlayerBuildingMeetingClue[] = [];
      for (const c of stock) {
        // 旧存档线索无 ts：补写过期时间戳（从现在起算），保留并进入过期机制
        if (typeof c?.ts !== "number") {
          c.ts = ts + getClueExpiredDays() * 86400;
          kept.push(c);
          continue;
        }
        if (c.ts > ts) {
          kept.push(c);
          continue;
        }
        // 已过期：上板线索（inUse=1）同步清理留言板索引，不留孤儿槽位
        if (c.inUse === 1) mgr._clearBoardEntry(draft, room, c.id);
        removed++;
      }
      room[key] = kept;
    }
    // 防御：清除 board 中指向已不存在线索的孤儿索引（含历史残留）
    if (room?.board) {
      const alive = new Set<string>([
        ...(room.ownStock ?? []).map((c) => c?.id),
        ...(room.receiveStock ?? []).map((c) => c?.id),
      ]);
      for (const [type, id] of Object.entries(room.board)) {
        if (!alive.has(id)) delete room.board[type];
      }
    }
    if (removed > 0) {
      // 过期线索被移除 → 红点按剩余未上板线索重算
      mgr._refreshClueFlag(draft, room);
    }
    return removed;
}

  /**
   * 内部方法：清理会客室全部房间中已过期的线索
   *
   * 遍历所有 MEETING 房间（兼容多会客室存档），委托 _purgeExpiredClues。
   * @param draft - mutative 可写草稿
   * @param ts - 当前时间基准（秒）
   * @returns 移除的线索总数
   */
export function _purgeAllExpiredClues(mgr: BuildingManager, draft: Draft<PlayerDataModel>, ts: number) : number {
    let total = 0;
    for (const roomRaw of Object.values(draft.building.rooms.MEETING ?? {})) {
      total += mgr._purgeExpiredClues(draft, roomRaw, ts);
    }
    return total;
}

  /**
   * 获取线索盒（ownStock + receiveStock）
   *
   * 读取前自动清理已过期的好友赠送线索（_purgeAllExpiredClues），
   * 确保返回给客户端的线索盒不含过期条目（变更经 update 落盘进 delta）。
   * @returns 包含 box 字段的对象
   */
export async function getClueBox(mgr: BuildingManager) {
    return await mgr._player.update(async (draft) => {
      const ts = now();
      mgr._purgeAllExpiredClues(draft, ts);
      const room = Object.values(draft.building.rooms.MEETING)[0];
      // 深拷贝后再返回：draft 为 mutative 代理，update 结束后被 revoke，
      // 直接返回代理元素会让 router 在 JSON.stringify 时报
      // "Cannot perform 'get' on a proxy that has been revoked"。
      return {
        box: JSON.parse(
          JSON.stringify([
            ...(room?.ownStock ?? []),
            ...(room?.receiveStock ?? []),
          ]),
        ),
      };
    });
}

  /**
   * 获取线索好友列表（基于好友关系数据）
   * @returns 包含 result 字段的对象
   */
export async function getClueFriendList(mgr: BuildingManager) {
    const uid = String(mgr._player._playerdata.status.uid);
    const social = await accountManager.getSocial(uid);
    const result = await Promise.all(
      social.friends.map(async (f) => {
        // 修复：好友账号存档缺失/加载失败时跳过（原实现 Promise.all 整体 500）
        try {
          const info = await accountManager.getPlayerFriendInfo(f.uid);
          return {
            uid: f.uid,
            nickName: info.nickName,
            nickNumber: info.nickNumber,
            level: info.level,
          };
        } catch (e) {
          logger.warn(
            "building",
            `getClueFriendList 好友 ${f.uid} 数据加载失败: ${(e as Error).message}`,
          );
          return null;
        }
      }),
    );
    return {
      result: result.filter(
        (r): r is { uid: string; nickName: string; nickNumber: string; level: number } =>
          r !== null,
      ),
    };
}

  /**
   * 获取会客室情报分享奖励（访客列表——友方访问 + 可领取的信用）
   *
   * CS: BuildingMeetingClueReceiveInfoShareRewardResponse { list: [VisitorInfo] }，
   * VisitorInfo = { uid, nickName, nickNumber, level, avatar, ts, alias, secretary, secretarySkinId }。
   * 私服：访客 = 好友列表（无真实访问记录，ts 用最近在线时间）。
   *
   * 修复：官方响应 delta 必含会客室干员体力累积（building.chars[].ap/lastApAddTime，
   * 见抓包 building_getInfoShareReward_res_1074）——客户端会客室会话按该增量推进
   * 情报分享状态；原实现不推进 → delta 为空 → 客户端死循环重拉。
   *
   * 再修复：同时推进 infoShare 字段（infoShare.ts = now）——官方该响应 delta 含
   * MEETING 房间完整状态（含 infoShare/socialPoint 信用发放）；不推进则同一批访客
   * 每次都被视为"新访客" → 重复计信用 → 无限重复获取。
   *
   * 信用经济（2026-08-14 补全）：主动信用（socialReward.search）按本次有效访客数 ×
   * friendSlotInc 累积（封顶 creditInitiativeLimit=100，领取后清零重新累积）——
   * 原实现只推进会话从不计信用，模板 search=40 领一次后信用经济枯竭。
   *
   * @returns 访客列表
   */
export async function getInfoShareReward(mgr: BuildingManager) {
    const uid = String(mgr._player._playerdata.status.uid);
    const social = await accountManager.getSocial(uid);
    const list = await Promise.all(
      social.friends.map(async (f) => {
        // 修复：好友账号存档缺失/加载失败时跳过（原实现整体 500）
        try {
          const info = await accountManager.getPlayerFriendInfo(f.uid);
          return {
            uid: f.uid,
            nickName: info.nickName,
            nickNumber: info.nickNumber,
            level: info.level,
            alias: null,
            ts: info.registerTs ?? 0,
            avatar: { type: "ASSISTANT", id: `${info.secretary ?? ""}#1` },
            secretary: info.secretary ?? "",
            secretarySkinId: info.secretarySkinId ?? "",
          };
        } catch (e) {
          logger.warn(
            "building",
            `getInfoShareReward 好友 ${f.uid} 数据加载失败: ${(e as Error).message}`,
          );
          return null;
        }
      }),
    );
    const validList = list.filter((x): x is NonNullable<typeof x> => x !== null);
    // 会客室干员体力（AP）随时间累积（changeScale>0 恢复；上限 8640000）+ 会话推进
    // + 主动信用累积（按有效访客数封顶）
    await mgr._player.update(async (draft) => {
      mgr._accrueCharAp(draft);
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (room) {
        // 惰性初始化 infoShare（旧存档缺失）；ts 推进（会话划分）+ reward 待领取指示
        const is = (room.infoShare ??= { ts: 0, reward: 0 });
        is.ts = now();
        // 修复：主动信用（search）按访客累积（封顶 creditInitiativeLimit）
        mgr._accumulateSearchCredit(draft, room, validList.length);
        is.reward = mgr._infoShareReward(room.socialReward);
      }
    });
    return { list: validList };
}

  /**
   * 获取会议室奖励（信用点）
   *
   * 对齐官方（抓包 res_1044）：响应 rewards 为 ItemBundle 数组
   * `[{id:"SOCIAL_PT", type:"SOCIAL_PT", count:N}]`，且**服务端发放后清零**——
   * status.socialPoint += daily+search、socialReward 归零（一次性领取）。
   * 修复：原实现只透传 socialReward.daily（格式错误且不发放/不清零）→
   * 客户端每次领取同一份信用 → 无限信用点 + 会客室死循环。
   * @returns 领取的信用点（SOCIAL_PT ItemBundle；无可领返回空数组）
   */
export async function getMeetingroomReward(mgr: BuildingManager) {
    let granted = 0;
    await mgr._player.update(async (draft) => {
      const room = Object.values(draft.building.rooms.MEETING)[0];
      if (!room) return;
      const sr = room.socialReward;
      granted = (sr?.daily ?? 0) + (sr?.search ?? 0);
      if (granted <= 0) return;
      draft.status.socialPoint = (draft.status.socialPoint ?? 0) + granted;
      // 领取后清零（一次性，避免重复领取）+ infoShare.reward 归 0（待领取指示）
      room.socialReward = { daily: 0, search: 0 };
      mgr._refreshInfoShare(draft);
    });
    return {
      rewards:
        granted > 0
          ? [{ id: "SOCIAL_PT", type: "SOCIAL_PT", count: granted }]
          : [],
    };
}
