/**
 * 玩家状态引擎类
 *
 * 承载玩家数据的 mutative 状态管理：draft 生命周期、patch 聚合、增量序列化。
 * 从 PlayerDataManager 拆分而来，使状态引擎可独立构造与测试，
 * PlayerDataManager 退化为组合根持有子管理器。
 */
import {
  create as mutCreate,
  Draft,
  Patch,
} from "mutative";
import { PlayerDataModel } from "./playerdata";
import { patchesToObject } from "@utils/delta";

/**
 * 玩家状态引擎类
 *
 * 负责玩家数据的增量更新、patch 记录与序列化，不依赖任何游戏子管理器。
 */
export class PlayerStatus {
  /** 玩家原始数据模型 */
  _playerdata: PlayerDataModel;
  /** 变更补丁列表（enablePatches 用 pathAsArray=true，补丁 path 为数组） */
  _changes: Patch<true>[][];
  /** 逆变更补丁列表（用于撤销） */
  _inverseChanges: Patch<true>[][];
  /** 直接变更脏标记（绕过 update() 的原地修改，如 medal/dungeon/rlv2 构造期初始化） */
  _dirty: boolean;
  /**
   * 当前激活的 Immer draft（供嵌套 update() 复用）
   *
   * 事件处理器在 recipe 内 await emit（如 items:get → gainItem → update）时，
   * 若不复用则内层 createDraft 基于旧 base、finishDraft 先替换 _playerdata，
   * 外层 finishDraft 再按旧 base 整体覆盖 → 嵌套变更从存档丢失（delta 却含补丁，
   * 客户端"看到"奖励后下次同步消失）。复用同一 draft 后嵌套变更随外层一并提交。
   */
  private _activeDraft: Draft<PlayerDataModel> | null = null;
  /** 状态版本号（update() 递增，用于 toJSONString 缓存失效） */
  _stateVersion = 0;
  /** toJSONString 序列化缓存 */
  private _toJsonStringCache: { version: number; value: string } | null = null;

  /**
   * 构造函数
   * @param playerdata - 玩家数据模型
   */
  constructor(playerdata: PlayerDataModel) {
    this._playerdata = playerdata;
    this._changes = [];
    this._inverseChanges = [];
    this._dirty = false;
  }

  /**
   * 获取增量更新数据
   *
   * 将所有变更补丁转换为对象形式，并清空变更记录。
   * note：save 事件的触发由组合根（PlayerDataManager）负责，本方法仅计算与清空。
   * @returns 增量数据与是否有变更
   */
  get delta(): { playerDataDelta: { modified: {}; deleted: {} }; changed: boolean } {
    // 补丁按发生顺序正序展开（同一路径多次变更时倒序会让最旧值
    // 后写覆盖，客户端收到旧值、与服务器状态脱节，如十连后 cnt 收到 1 而非 10）。
    // flat 一次性展平（原 reduce+concat 为 O(n²)，批次多时放大常数）。
    const delta = patchesToObject(this._changes.flat(), this._playerdata);
    // 条件落盘：仅当存在变更（Immer 补丁或 markDirty 的直接变更）才触发保存，
    // 纯读请求（syncStatus/syncPushMessage 等）不再触发全量落盘
    const changed = this._changes.length > 0 || this._dirty;
    this._changes = [];
    this._dirty = false;
    return {
      playerDataDelta: delta,
      changed,
    };
  }

  /**
   * 获取用户ID
   * @returns 用户ID
   */
  get uid(): string {
    return this._playerdata.status.uid;
  }

  /**
   * 会话时间戳（syncData 每次同步刷新为 now()）
   *
   * 用作战斗数据加解密（decryptBattleData/encryptBattleData）的密钥种子——
   * 客户端以会话锚点时间戳加密战斗数据，服务端用同一时间戳解密。
   * @returns 会话锚点时间戳
   */
  get loginTime(): number {
    return this._playerdata.pushFlags.status;
  }

  /**
   * 标记直接变更（绕过 update() 的原地修改）
   *
   * 这类修改不产生 Immer 补丁，需显式标记脏，保证条件落盘仍会持久化。
   */
  markDirty(): void {
    this._dirty = true;
  }

  /**
   * 追加一个强制补丁（供 update() recipe 内主动注入增量）
   *
   * Immer 对未变化的值不产生补丁，但业务有时需强制某字段进入 delta（如
   * building.event 用于客户端调度下一次 sync）。recipe 内调用本方法直接把补丁
   * 写入 _changes，与 finishDraft 收集的补丁一并随 delta 下发。
   * @param path - 补丁路径（如 ["event", "building"]）
   * @param value - 补丁值
   */
  forcePatch(path: (string | number)[], value: unknown): void {
    this._changes.push([{ op: "replace", path: path as string[], value }]);
  }

  /**
   * 更新玩家数据（使用 mutative）
   *
   * 通过传入的 recipe 函数修改数据，自动记录变更补丁（嵌套 update 复用当前 draft）。
   * @param recipe - 数据修改函数
   * @returns recipe 函数的返回值
   */
  async update<T>(
    recipe: (draft: Draft<PlayerDataModel>) => Promise<T>,
  ): Promise<T> {
    // 已在 recipe 内（事件处理器嵌套调用）：直接复用当前 draft
    if (this._activeDraft) {
      return await recipe(this._activeDraft);
    }
    // mutative 两阶段：create(base, {enablePatches}) → [draft, finish()]
    // draft 为可继续 mutate 的引用（支持嵌套复用），finish() 一次性提交并返回补丁。
    const [draft, finish] = mutCreate(this._playerdata, { enablePatches: true });
    this._activeDraft = draft;
    try {
      const result = await recipe(draft);
      const [next, patches, inversePatches] = finish();
      this._playerdata = next;
      this._changes.push(patches);
      this._inverseChanges.push(inversePatches);
      this._stateVersion++; // 使 toJSONString 缓存失效
      // mutative enableAutoFreeze 默认关闭：next 不被冻结，rlv2 保持可写，
      // _ensureMutableRlv2 为 no-op（Object.isFrozen(rlv2) 为 false 直接返回）。
      this._ensureMutableRlv2();
      return result;
    } finally {
      this._activeDraft = null;
    }
  }

  /**
   * 确保 rlv2 子树可写（autoFreeze 兼容）
   *
   * autoFreeze=false（当前）下 rlv2 未被冻结，Object.isFrozen 为 false，直接返回，零开销。
   * 保留深拷贝解冻逻辑仅作防御：若未来重新开启 autoFreeze，finishDraft 会冻结整个
   * _playerdata（含 rlv2 的 current/outer），JS 无法解冻已冻结对象 → 以深可变副本替换
   * _playerdata.rlv2 并重建顶层 _playerdata（与 AccountManager.deepFreezeExcept 排除 rlv2
   * 的约定一致；RoguelikeV2Manager 的 this.outer/current 与 _playerdata.rlv2 保持引用
   * 别名且可原地写）。
   */
  private _ensureMutableRlv2(): void {
    const rlv2 = this._playerdata.rlv2;
    if (!rlv2 || !Object.isFrozen(rlv2)) return;
    const mutableRlv2 = JSON.parse(JSON.stringify(rlv2)) as typeof rlv2;
    this._playerdata = { ...this._playerdata, rlv2: mutableRlv2 };
  }

  /**
   * 序列化为JSON
   * @returns 玩家数据模型对象
   */
  toJSON(): PlayerDataModel {
    return this._playerdata;
  }

  /**
   * 预序列化 JSON 字符串（B4 响应缓存）：update() 后失效，重连/重复 syncData 复用，
   * 避免每次全量 JSON.stringify（1.3MB 级）重复计算。
   */
  toJSONString(): string {
    if (!this._toJsonStringCache || this._toJsonStringCache.version !== this._stateVersion) {
      this._toJsonStringCache = { version: this._stateVersion, value: JSON.stringify(this._playerdata) };
    }
    return this._toJsonStringCache.value;
  }
}