import excel from "@excel/excel";
import { ItemBundle, ItemType } from "@excel/excel";
import { checkBetween, now } from "@utils/time";
import { PlayerDataManager } from "../../../kernel/player-data-manager";
import moment from "moment";
import { OpenServerItemData } from "@excel/excel";
import { TypedEventEmitter } from "../../../kernel/events/runtime";
import type { Draft } from "mutative";
import type {
  OpenServerChainLogin,
  OpenServerCheckIn,
  PlayerDataModel,
} from "../../../kernel/playerdata";

/** 连续签到天数（open_server_table.chainLoginData 键 0..6，第 7 档为终奖） */
const CHAIN_DAYS = 7;
/** 累计签到档位（open_server_table.checkInData 键 0..13） */
const CHECKIN_DAYS = 14;
/** 连续签到终奖下标（chainLoginData 第 7 档 order=7；旧数据无该键时回退 -1） */
const CHAIN_FINAL_INDEX = 6;

export class OpenServerManager {
  _player: PlayerDataManager;
  _trigger: TypedEventEmitter;

  constructor(player: PlayerDataManager, _trigger: TypedEventEmitter) {
    this._player = player;
    this._trigger = _trigger;
    this._trigger.on("refresh:daily", this.dailyRefresh.bind(this));
  }

  /**
   * 推进连续签到一天（官方：中断签到重新计算天数）
   *
   * 修复（2026-09-09）：原实现把该写入放在 `openserver:chain:login` 事件处理器里，并由
   * `dailyRefresh` **在自己的 update 内** emit —— mutative 下形成嵌套 update，内层快照不含外层
   * 尚未提交的初始化结果，外层提交时又会把内层写入覆盖回旧值（连签进度丢失）。现直接内联到
   * `dailyRefresh` 的同一次 update，事件仅作对外通知。
   * @param draft - 可写草稿
   * @param ts - 上次登录时间戳（秒）
   * @param chain - chainLogin 状态
   */
  private _advanceChainLogin(
    draft: Draft<PlayerDataModel>,
    ts: number,
    chain: Draft<OpenServerChainLogin>,
  ): void {
    const diff = moment().diff(moment(ts), "days");
    if (diff > 1) {
      chain.nowIndex = -1;
      chain.history = [];
    }
    if (chain.history.length >= CHAIN_DAYS) return; // 已达 7 天，不再推进
    chain.nowIndex += 1;
    chain.history[chain.nowIndex] = 1;
  }

  /** 当前生效的开服活动时间段（无匹配返回 undefined） */
  private _activeSchedule() {
    return excel.OpenServerTable?.schedule?.find((s) =>
      checkBetween(now(), s.startTs, s.endTs),
    );
  }

  /**
   * 兜底初始化 openServer 状态并同步活动开关
   *
   * 修复（2026-09-09）：原实现**从不初始化** `openServer` —— 新存档执行
   * `draft.openServer.chainLogin.nowIndex += 1` 直接 500，且 `chainLogin.isAvailable`
   * / `checkIn.isAvailable` 全仓无人置 true → 每日刷新永不推进签到/连签进度。
   * 现按 `open_server_table.schedule` 的活动窗口设置开关（官服存档中活动结束后两开关均为 false）。
   * @param draft - 可写草稿
   * @returns 活动开启时返回状态引用，否则 undefined
   */
  private _ensureState(
    draft: Draft<PlayerDataModel>,
  ): { chainLogin: Draft<OpenServerChainLogin>; checkIn: Draft<OpenServerCheckIn> } | undefined {
    const schedule = this._activeSchedule();
    if (!draft.openServer) draft.openServer = {};
    const os = draft.openServer;
    if (!os.chainLogin) {
      os.chainLogin = { isAvailable: Boolean(schedule), nowIndex: -1, history: [] };
    }
    const chainLogin = os.chainLogin;
    if (!os.checkIn) os.checkIn = { isAvailable: Boolean(schedule), history: [] };
    const checkIn = os.checkIn;
    if (!os.fullOpen) {
      os.fullOpen = { isAvailable: false, startTs: -1, today: false, remain: 0 };
    }
    if (!Array.isArray(chainLogin.history)) chainLogin.history = [];
    if (!Array.isArray(checkIn.history)) checkIn.history = [];
    if (typeof chainLogin.nowIndex !== "number" || chainLogin.nowIndex < -1) {
      chainLogin.nowIndex = chainLogin.history.length - 1;
    }
    return schedule ? { chainLogin, checkIn } : undefined;
  }

  async dailyRefresh([ts]: [number]) {
    let active = false;
    await this._player.update(async (draft) => {
      const st = this._ensureState(draft);
      if (!st) return;
      active = true;
      if (st.chainLogin.isAvailable) {
        this._advanceChainLogin(draft, ts, st.chainLogin);
      }
      // 累计签到：逐日推进一档（history[i]=1 表示可领取；领后写 0）
      if (st.checkIn.isAvailable && st.checkIn.history.length < CHECKIN_DAYS) {
        st.checkIn.history.push(1);
      }
    });
    // 事件在 update 之外发出（订阅方为任务/勋章等；不再承担状态写入）
    if (active) await this._trigger.emit("openserver:chain:login", [ts]);
  }

  /**
   * 领取连续签到第 index 天奖励（index 0 起，0..5 为日历奖励，6 为终奖）
   *
   * 修复（2026-09-09）：原实现无条件 `history[index] = 0` 并发奖 —— 同一档可**无限重复领取**
   *（schedule 自述「奖励无法重复领取」）。现要求该档已达成且未领取（`history[index] === 1`）。
   * @param args.index - 档位下标
   * @returns 发放的物品（不可领取时空数组）
   */
  async getChainLogInReward(args: { index: number }): Promise<ItemBundle[]> {
    const { index } = args;
    const schedule = this._activeSchedule();
    if (!schedule) return [];
    const item =
      excel.OpenServerTable.dataMap[schedule.id].chainLoginData[index]?.item;
    if (!item) return [];
    let granted = false;
    await this._player.update(async (draft) => {
      const st = this._ensureState(draft);
      if (!st) return;
      if (st.chainLogin.history?.[index] !== 1) return; // 未达成或已领取
      st.chainLogin.history[index] = 0;
      granted = true;
    });
    if (!granted) return [];
    const reward = [excel.makeItem(item.itemId, item.count)];
    for (const it of reward) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return reward;
  }

  /**
   * 领取连续签到终奖（第 7 天）
   *
   * 修复（2026-09-09）：① 原实现读 `chainLoginData[-1]`，而实际键为 `"0".."6"` →
   * `finalReward` 恒 undefined → 终奖**永远拿不到**（第 7 档在 `chainLoginData[6]`，order=7）；
   * ② 无领取次数校验，可无限领取。现按第 7 档发放，并要求已达成且未领取。
   * @returns 发放的物品（不可领取时空数组）
   */
  async getChainLogInFinalRewards(): Promise<ItemBundle[]> {
    const schedule = this._activeSchedule();
    if (!schedule) return [];
    const chainData = excel.OpenServerTable.dataMap[schedule.id];
    const finalReward =
      chainData?.chainLoginData?.[CHAIN_FINAL_INDEX] ?? chainData?.chainLoginData?.[-1];
    if (!finalReward?.item) return [];
    let item!: OpenServerItemData;
    await this._player.update(async (draft) => {
      const st = this._ensureState(draft);
      if (!st) return;
      if (st.chainLogin.history?.[CHAIN_FINAL_INDEX] !== 1) return;
      item = finalReward.item;
      st.chainLogin.history[CHAIN_FINAL_INDEX] = 0;
    });
    if (!item) return [];
    const reward = [excel.makeItem(item.itemId, item.count)];
    for (const it of reward) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return reward;
  }

  /**
   * 领取累计签到第 index 档奖励
   *
   * 修复（2026-09-09）：同连续签到——原实现无条件 `history[index] = 0` 并发奖，可无限重复领取；
   * 现要求该档已达成且未领取（`history[index] === 1`）。
   * @param args.index - 档位下标（0..13）
   * @returns 发放的物品（不可领取时空数组）
   */
  async getCheckInReward(args: { index: number }): Promise<ItemBundle[]> {
    const { index } = args;
    const schedule = this._activeSchedule();
    if (!schedule) return [];
    const item = excel.OpenServerTable.dataMap[schedule.id].checkInData[index]?.item;
    if (!item) return [];
    let granted = false;
    await this._player.update(async (draft) => {
      const st = this._ensureState(draft);
      if (!st) return;
      if (st.checkIn.history?.[index] !== 1) return;
      st.checkIn.history[index] = 0;
      granted = true;
      if (
        st.checkIn.history.length >= CHECKIN_DAYS &&
        !st.checkIn.history.some((n: number) => n === 1)
      ) {
        st.checkIn.isAvailable = false;
      }
    });
    if (!granted) return [];
    const reward = [excel.makeItem(item.itemId, item.count)];
    for (const it of reward) this._player.gainItem.add(it);
    await this._player.gainItem.handle();
    return reward;
  }
}
