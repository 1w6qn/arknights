import type { Mock } from "vitest";
import type { Draft } from "mutative";
import type { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerDataModel } from "@game/kernel/playerdata";
import type { PlayerDeltaResponse, RoguelikePushMessage } from "@game/kernel/http/common";
import type { TypedEventEmitter } from "@game/kernel/events/runtime";
import type { EventMap } from "@game/kernel/events";
import type { GainItemPipeline, PipelineItem } from "@game/kernel/inventory-pipeline";
import type { BattleManager } from "@game/modules/battle/battle";
import type { ItemBundle } from "@excel/excel";
import { mockExcel, type MockExcel } from "./mockExcel";

/**
 * 事件触发器替身（窄接口）
 *
 * `PlayerDataManager._trigger` 的真实类型是 {@link TypedEventEmitter}（继承 Emittery 的类，
 * 带私有实现），无法用 `Mock<T>` 表达；而未赋值的默认桩又是手搓 `vi.fn()`（用例依赖
 * `player._trigger.emit.mock.calls` 读调用记录）。故 `MockPlayerDataManager._trigger`
 * 声明为 `TypedEventEmitter`（可直接传入以 `TypedEventEmitter` 为形参的构造器），
 * 默认值由 {@link mockTriggerStub} 提供：运行期仍是 vi.fn 桩，仅按类型面收口。
 *
 * 公开入口沿用 Emittery 的方法类型，`emit` 用其双参重载的等价单签名表达。
 */
export interface MockTrigger {
  /** 注册监听（与 TypedEventEmitter.on 签名一致） */
  on: TypedEventEmitter["on"];
  /** 移除监听（与 TypedEventEmitter.off 签名一致） */
  off: TypedEventEmitter["off"];
  /** 触发事件（与 TypedEventEmitter.emit 的双参重载等价） */
  emit: <Name extends keyof EventMap>(
    eventName: Name,
    eventData: EventMap[Name],
  ) => Promise<void>;
}

/**
 * 创建一个默认触发器桩（vi.fn 语义：on/off 不注册、emit 只记录调用）
 *
 * 断言口径要求 `emit` 是 vi.fn（`player._trigger.emit.mock.calls`），故运行期保留桩对象；
 * 返回值按 {@link TypedEventEmitter} 的类型面收口（结构可比，供直接传入构造器），
 * 用例可用 `mockTypedEventEmitter()` / `mockEventBus()` 整体覆写。
 * @returns 默认触发器替身（类型视作真实 TypedEventEmitter，运行期为 vi.fn 桩）
 */
function mockTriggerStub(): TypedEventEmitter {
  const trigger: MockTrigger = {
    on: vi.fn<TypedEventEmitter["on"]>(),
    off: vi.fn<TypedEventEmitter["off"]>(),
    emit: vi.fn<MockTrigger["emit"]>(),
  };
  return trigger as TypedEventEmitter;
}

/**
 * mock 版 update recipe
 *
 * 真实 `PlayerDataManager.update` 只接受返回 Promise 的 recipe；此替身同步/异步通吃
 * （mock 实现 `await` 后接住返回值），返回类型按 TS 的 void 协变规则放宽为 `void`。
 */
export type MockUpdateRecipe = (draft: Draft<PlayerDataModel>) => void;

/**
 * 物品管道 mock（GainItemPipeline 的结构替身）
 *
 * 物品增减已从「直发 items:get/items:use 事件」收敛到 `player.gainItem` 管道，
 * 断言口径随之从 `trigger.emit` 换成本 mock 的 add/setTarget/use/handle 调用记录。
 * 手搓 mockPlayer 的测试用例统一挂 `gainItem: mockGainItem()`。
 */
export interface MockGainItemPipeline {
  /** 追加一个已组装的物品（签名对齐 GainItemPipeline.add，返回自身以支持链式） */
  add: Mock<(bundle: ItemBundle) => MockGainItemPipeline>;
  /** 追加一个发放/消耗目标（签名对齐 GainItemPipeline.setTarget，返回自身以支持链式） */
  setTarget: Mock<
    (
      itemId: string,
      itemType?: string,
      itemCount?: number,
      itemInstId?: number,
    ) => MockGainItemPipeline
  >;
  /** 执行消耗（对齐 GainItemPipeline.use） */
  use: Mock<() => Promise<void>>;
  /** 执行发放（对齐 GainItemPipeline.handle） */
  handle: Mock<() => Promise<void>>;
  /** 清空队列（对齐 GainItemPipeline.clear，返回自身以支持链式） */
  clear: Mock<() => MockGainItemPipeline>;
  /** 队列长度（mock 恒为 0） */
  readonly size: number;
  /** 已入队目标（mock 恒为空） */
  readonly targets: readonly PipelineItem[];
}

/**
 * 战斗管理器替身（窄接口）
 *
 * 真实 `BattleManager`（`app/game/modules/battle/battle.ts`）的 start/finish 返回完整结算
 * 负载（首通奖励/掉落/家具等多字段）且类含私有实现，替身只做「调用即通过」的桩；故方法
 * 参数按真实签名取用，返回类型按替身实际返回值收窄（用例只读 battleId/result/rewards）。
 */
export interface MockBattleManager {
  /** 开始战斗（参数对齐真实 BattleManager.start） */
  start: Mock<(args: Parameters<BattleManager["start"]>[0]) => Promise<MockBattleStartResult>>;
  /** 结束战斗（参数对齐真实 BattleManager.finish） */
  finish: Mock<(args: Parameters<BattleManager["finish"]>[0]) => Promise<MockBattleFinishResult>>;
}

/** 战斗开始替身返回值（窄视图：用例读到的字段子集） */
export interface MockBattleStartResult {
  /** 战斗会话 id */
  battleId: string;
  /** 结算结果码（0=成功） */
  result: number;
}

/** 战斗结束替身返回值（窄视图：用例读到的字段子集） */
export interface MockBattleFinishResult {
  /** 结算结果码（0=成功） */
  result: number;
  /** 奖励物品（替身默认空数组） */
  rewards: ItemBundle[];
}

/**
 * 签到管理器替身（窄接口，只覆盖 mock 暴露的四个刷新入口）
 *
 * 真实 `CheckInManager` 的方法返回业务结构体且类含私有实现，mock 只作为
 * 「被调用即通过」的桩，故按调用面声明为 Promise<void>。
 */
export interface MockCheckInManager {
  /** 校正展示次数 */
  ensureShowCount: Mock<() => Promise<void>>;
  /** 执行签到 */
  checkIn: Mock<() => Promise<void>>;
  /** 每日刷新 */
  dailyRefresh: Mock<() => Promise<void>>;
  /** 每月刷新 */
  monthlyRefresh: Mock<() => Promise<void>>;
}

/**
 * 状态管理器替身（窄接口）
 *
 * 方法与真实 `StatusManager` 的同名入口签名对齐（参数形状、返回类型），
 * 类级私有实现与其余入口不在本替身覆盖范围。
 */
export interface MockStatusManager {
  /** 购买理智（返回是否成功） */
  buyAp: Mock<() => Promise<boolean>>;
  /** 绑定昵称 */
  bindNickName: Mock<(args: { nickname: string }) => Promise<void>>;
  /** 更换助理 */
  changeSecretary: Mock<(args: { charInstId: number; skinId: string }) => Promise<void>>;
  /** 更换头像 */
  changeAvatar: Mock<(args: PlayerDataModel["avatar"]) => Promise<void>>;
  /** 更新签名 */
  changeResume: Mock<(args: { resume: string }) => Promise<void>>;
  /** 领取团队收集奖励 */
  receiveTeamCollectionReward: Mock<(args: { rewardId: string }) => Promise<void>>;
  /** 兑换源石碎片 */
  exchangeDiamondShard: Mock<(args: { count: number }) => Promise<void>>;
}

/**
 * 测试夹具的深可选视图
 *
 * 真实存档子树（{@link PlayerDataModel} 的嵌套对象/数组）由客户端闭包生成，绝大多数
 * 字段在类型上是**必填**；而测试夹具只声明被测分支会读到的字段，其余字段依赖被测实现
 * 的缺省分支（旧存档惰性初始化）。这不是「夹具不完整」：往夹具里补真实默认值会改变
 * 运行时数据、进而改变被测行为（规则禁止）。
 *
 * 故夹具子树按深可选表达 —— 键名与**字段类型**仍受真实模型约束（枚举字面量联合、
 * `ItemBundle` 等原样保留），仅把「必填」放宽为可选。仅用于 mock 种子，不用于生产代码。
 *
 * 注意种子参数**不需要**可赋值给 `PlayerDataModel`：`mockPlayerData` 内部本就把
 * 「status 缺省 + 种子」整体 `as PlayerDataModel`（`_playerdata` 是替身数据，字段缺省
 * 由被测实现的惰性分支承受），故根部全部子树统一走本类型。
 */
export type MockSeed<T> = T extends readonly (infer U)[]
  ? MockSeed<U>[]
  : T extends string | number | boolean | null | undefined
    ? T
    : { [K in keyof T]?: MockSeed<T[K]> };

/**
 * mock 存档种子（窄接口）
 *
 * 根部字段与 {@link PlayerDataModel} 同形（全部可选），仅 `status` 放宽两键：
 * 真实模型里 `uid` 是 string、`nickNumber` 是 string，而 mock 占位与用例惯用数字
 * （`uid: 10000`、`nickNumber: 0`，用例按数字断言）——这与真实模型不符，
 * 故显式声明为 mock 专用标量；各子树用例惯用部分夹具，故统一用 {@link MockSeed}
 * 深可选表达（含 `building`，其局部视图另有 `logic/ext-types.ts` 承载服务端自建字段）。
 */
export type MockPlayerDataSeed = MockSeed<Omit<PlayerDataModel, "status">> & {
  status?: MockSeed<Omit<PlayerDataModel["status"], "uid" | "nickNumber">> & {
    /** mock 用数字 uid 占位（真实 PlayerStatus.uid 为 string，两者并存） */
    uid?: number | string;
    /** mock 用例惯用数字占位（真实声明为 string） */
    nickNumber?: number | string;
  };
};

/**
 * 夹具深可选视图 → 真实模型类型（写入 `_playerdata` 等真实类型位置时使用）
 *
 * 用例常在构造 mock 之后**增量写入**局部房间/干员夹具（只写被测分支读到的字段），
 * 而目标位置（如 `_playerdata.building.rooms.TRADING.slot_6`）是必填的真实模型类型。
 * 本函数把 {@link MockSeed} 视图断言回真实类型：缺省字段由被测实现的惰性分支承受，
 * 语义与 `mockPlayerData(seed)` 完全一致（种子本就被断言语义地视作完整存档）。
 *
 * 之所以不是 `as any`：断言两侧仍受真实模型约束 —— 参数必须满足深可选视图（字段名与
 * 字段类型都参与检查），只有「必填」被放宽；写错字段名或类型仍会报错。
 * @param seed - 夹具的深可选视图
 * @returns 同一对象，类型视作真实模型类型
 */
export function asModel<T>(seed: MockSeed<T>): T {
  return seed as T;
}

/**
 * mock 玩家数据管理器（{@link PlayerDataManager} 的结构替身）
 *
 * 仅覆盖测试使用的组合根面：状态更新、序列化、物品管道、事件触发、excel 端口。
 * 子管理器（checkIn/status）只提供用例断言到的那部分入口。
 */
export interface MockPlayerDataManager {
  /** 状态更新（mock：JSON 深拷贝 draft 执行 recipe 后回写） */
  update: Mock<(recipe: MockUpdateRecipe) => Promise<void>>;
  /** 读取原始玩家数据（mock 内部数据，等价于实体的 _playerdata） */
  get: Mock<() => PlayerDataModel>;
  /** 序列化（对齐 PlayerDataManager.toJSON 的返回类型） */
  toJSON: Mock<() => PlayerDataModel>;
  /** 标记脏数据 */
  markDirty: Mock<() => void>;
  /** 强制补丁（payload 类型对齐 PlayerDataManager.forcePatch） */
  forcePatch: Mock<(path: (string | number)[], value: RoguelikePushMessage["payload"]) => void>;
  /** 压入随下一响应下发的推送（payload 类型对齐 PlayerDataManager.pushMessage） */
  pushMessage: Mock<(path: string, payload: RoguelikePushMessage["payload"]) => void>;
  /** 已压入的推送队列（对齐 PlayerDataManager._pushMessages） */
  _pushMessages: RoguelikePushMessage[];
  /**
   * 物品变更管道
   *
   * 读：替身面 {@link MockGainItemPipeline}（add/setTarget/use/handle/clear 均为 `Mock`，
   * 供调用记录断言）；写：可整体换成真实 {@link GainItemPipeline}——gacha 用例需真实管道
   * 才能发出 `items:use` 事件（替身面不发射事件）。
   */
  get gainItem(): MockGainItemPipeline;
  set gainItem(pipeline: MockGainItemPipeline | GainItemPipeline);
  /**
   * 增量响应
   *
   * 形状对齐 `PlayerDataManager.delta`；注意 mock 恒返回 `{ playerDataDelta: {} }`
   * （**不含**真实 delta 的 `modified` / `deleted`），用例据此后者做 `toEqual` 断言。
   */
  get delta(): PlayerDeltaResponse;
  /**
   * 玩家 uid
   *
   * 真实管理器返回 string（`PlayerStatus.uid` 声明为 string）；mock 的 status 占位
   * 与用例断言都是数字（如 `expect(pd.uid).toBe(10000)`），故声明为
   * `string | number` 以如实反映替身行为。
   */
  get uid(): string | number;
  /** 原始玩家数据模型（对齐 PlayerDataManager._playerdata getter） */
  _playerdata: PlayerDataModel;
  /**
   * 事件触发器（可直接传入以 TypedEventEmitter 为形参的构造器）
   *
   * 默认值为 {@link mockTriggerStub}（vi.fn 桩）；用例可用 `mockTypedEventEmitter()`
   * 整体覆写。
   */
  _trigger: TypedEventEmitter;
  /**
   * 战斗管理器替身（可选）
   *
   * 真实 `PlayerDataManager.battle` 来自私有 `modules` 组合根 getter，结构替身无法覆盖；
   * 需要训练战斗链路（battle.start/finish）的用例直接挂 {@link MockBattleManager}。
   */
  battle?: MockBattleManager;
  /**
   * excel 数据端口替身（管理器的 `player.excel` 依赖）
   *
   * 默认 `mockExcel()`（空表 + 门面方法）；用例需要具体表时直接覆写本字段，
   * 替代此前 "vi.mock('@excel/excel') 模块级打桩" 的做法。
   */
  excel: MockExcel;
  /** 签到管理器替身 */
  checkIn: MockCheckInManager;
  /** 状态管理器替身 */
  status: MockStatusManager;
}

/**
 * 把 mock 组合根适配为真实 `PlayerDataManager`（管理器构造的唯一边界）
 *
 * `MockPlayerDataManager` 是结构替身（`vi.fn` 桩 + getter），与真实
 * `PlayerDataManager` **不可结构兼容**：真实类含私有字段 `_gainItemPipeline`，
 * TypeScript 的私有成员只允许**同类实例**赋值，任何鸭子对象（含再精确的接口）
 * 都无法赋值，`as PlayerDataManager` 也会被 TS2352 拒绝。这不是「桩不够精确」，
 * 而是私有成员语义的硬边界，故在 helpers 内保留**唯一一处**适配：
 * 实现体一次 `@ts-expect-error`，调用点一律写 `asPlayerManager(mockPlayer)`。
 *
 * 返回值与入参是同一对象引用（零运行时开销、保持 `manager._player === mockPlayer` 断言）。
 * @param mock - `mockPlayerData()` 产出的组合根替身
 * @returns 同一对象，类型视作真实 `PlayerDataManager`（仅供构造/传参）
 */
export function asPlayerManager(mock: MockPlayerDataManager): PlayerDataManager {
  // @ts-expect-error 见上：私有字段使替身与真实类不可结构兼容，此处是全仓唯一适配点
  return mock;
}

/**
 * 创建物品管道替身（GainItemPipeline 的结构替身）
 *
 * add/setTarget/clear 返回 mock 自身以复刻管道的链式语义；
 * size/targets 为只读空值（getter，保持与真实管道同形）。
 * @returns 可直接挂到 mockPlayer 上的管道替身
 */
export function mockGainItem(): MockGainItemPipeline {
  const gainItem: MockGainItemPipeline = {
    add: vi.fn(function (this: MockGainItemPipeline) {
      return this;
    }),
    setTarget: vi.fn(function (this: MockGainItemPipeline) {
      return this;
    }),
    use: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    handle: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clear: vi.fn(function (this: MockGainItemPipeline) {
      return this;
    }),
    size: 0,
    targets: [],
  };
  Object.defineProperty(gainItem, "size", { get: () => 0 });
  Object.defineProperty(gainItem, "targets", { get: () => [] });
  return gainItem;
}

/**
 * 创建一个 mock 的 PlayerDataManager
 * 使用 vitest 的 vi.fn() 模拟方法，避免在测试中依赖 Immer/管理器实例
 * @param initialData - 初始玩家数据（与默认 status 浅合并）
 * @returns 组合根替身（见 MockPlayerDataManager）
 */
export function mockPlayerData(
  initialData: MockPlayerDataSeed = {}
): MockPlayerDataManager {
  const statusSeed: NonNullable<MockPlayerDataSeed["status"]> = {
    uid: 10000,
    nickName: "TestUser",
    nickNumber: 0,
    level: 1,
    exp: 0,
  };
  const _playerdata = {
    status: statusSeed,
    ...initialData,
  } as PlayerDataModel;

  const update = vi
    .fn<(recipe: MockUpdateRecipe) => Promise<void>>()
    .mockImplementation(
      async (recipe) => {
        const draft = JSON.parse(JSON.stringify(_playerdata)) as Draft<PlayerDataModel>;
        const result = await recipe(draft);
        Object.assign(_playerdata, draft);
        return result;
      }
    );

  const get = vi.fn<() => PlayerDataModel>().mockImplementation(() => _playerdata);

  const toJSON = vi.fn<() => PlayerDataModel>().mockImplementation(() => _playerdata);

  return {
    update,
    get,
    toJSON,
    markDirty: vi.fn<() => void>(),
    forcePatch: vi.fn<(path: (string | number)[], value: RoguelikePushMessage["payload"]) => void>(),
    _pushMessages: [],
    pushMessage: vi.fn(function (
      this: MockPlayerDataManager,
      path: string,
      payload: RoguelikePushMessage["payload"],
    ) {
      this._pushMessages.push({ path, payload });
    }),
    gainItem: mockGainItem(),
    checkIn: {
      ensureShowCount: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      checkIn: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      dailyRefresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      monthlyRefresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    },
    status: {
      buyAp: vi.fn<() => Promise<boolean>>(async () => {
        // 保留 ?. 以兼容 initialData 显式传 status: undefined 的历史行为
        const remain = _playerdata.status?.buyApRemainTimes ?? 0;
        if (remain <= 0) return false;
        _playerdata.status.buyApRemainTimes = remain - 1;
        return true;
      }),
      bindNickName: vi.fn<(args: { nickname: string }) => Promise<void>>().mockResolvedValue(undefined),
      changeSecretary: vi
        .fn<(args: { charInstId: number; skinId: string }) => Promise<void>>()
        .mockResolvedValue(undefined),
      changeAvatar: vi
        .fn<(args: PlayerDataModel["avatar"]) => Promise<void>>()
        .mockResolvedValue(undefined),
      changeResume: vi.fn<(args: { resume: string }) => Promise<void>>().mockResolvedValue(undefined),
      receiveTeamCollectionReward: vi
        .fn<(args: { rewardId: string }) => Promise<void>>()
        .mockResolvedValue(undefined),
      exchangeDiamondShard: vi
        .fn<(args: { count: number }) => Promise<void>>()
        .mockResolvedValue(undefined),
    },
    _playerdata,
    _trigger: mockTriggerStub(),
    get delta() {
      return { playerDataDelta: {} } as PlayerDeltaResponse;
    },
    get uid() {
      // mock 占位 uid 是数字（真实 PlayerStatus.uid 为 string），缺省回落到默认值
      // （保留 ?. 以兼容 initialData 显式传 status: undefined 的历史行为）
      return _playerdata.status?.uid ?? 10000;
    },
    excel: mockExcel(),
  };
}
