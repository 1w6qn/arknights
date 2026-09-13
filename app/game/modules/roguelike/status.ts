import { PlayerRoguelikeV2 } from "./rlv2";

import { RoguelikeV2Manager } from "./logic";
import excel from "@excel/excel";
import { RoguelikeEventManager, RoguelikePendingEvent } from "./events";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import { random } from "@utils/random";

export class RoguelikePlayerStatusManager
  implements PlayerRoguelikeV2.CurrentData.PlayerStatus
{
  state!: string;
  property!: PlayerRoguelikeV2.CurrentData.PlayerStatus.Properties;
  cursor!: PlayerRoguelikeV2.CurrentData.PlayerStatus.NodePosition;
  trace!: PlayerRoguelikeV2.CurrentData.PlayerStatus.NodePosition[];
  status!: PlayerRoguelikeV2.CurrentData.PlayerStatus.Status;
  toEnding!: string;
  chgEnding!: boolean;
  /** 本局结果（"success"=通关到最终层终点 / "giveup"=放弃，供 gameSettle 判定成功） */
  runResult!: string;
  innerMission?: PlayerRoguelikeV2.CurrentData.PlayerStatus.InnerMission[];
  nodeMission?: PlayerRoguelikeV2.CurrentData.PlayerStatus.NodeMission;
  zoneReward?: { [key: string]: PlayerRoguelikeV2.CurrentData.PlayerStatus.ZoneRewardItem };
  traderReturn?: { [key: string]: PlayerRoguelikeV2.CurrentData.PlayerStatus.ZoneRewardItem };
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._player = player;
    this.init();
    this._pending = new RoguelikeEventManager(this._player, _trigger);
    this._trigger = _trigger;
    this._trigger.on("rlv2:init", this.init.bind(this));
    this._trigger.on("rlv2:create", this.create.bind(this));
  }

  _pending: RoguelikeEventManager;

  get pending(): RoguelikePendingEvent[] {
    return this._pending._pending;
  }

  init() {
    const _status = {
      state: "NONE",
      property: {
        exp: 0,
        level: 1,
        maxLevel: 0,
        hp: { current: 0, max: 0 },
        gold: 0,
        shield: 0,
        capacity: 0,
        population: { cost: 0, max: 0 },
        conPerfectBattle: 0,
        hpShowState: "NORMAL",
      },
      cursor: { zone: 0, position: null },
      trace: [],
      pending: [],
      status: { bankPut: 0 },
      toEnding: "",
      chgEnding: false,
      runResult: "",
    };
    this.state = _status.state;
    this.property = _status.property;
    this.cursor = _status.cursor;
    this.trace = _status.trace;
    this.chgEnding = _status.chgEnding;
    this.toEnding = _status.toEnding;
    this.runResult = _status.runResult;
    this.status = _status.status;
    this.innerMission = undefined;
    this.nodeMission = undefined;
    this.zoneReward = undefined;
    this.traderReturn = undefined;
  }

  /**
   * 重登"继续探索"恢复：从存档 current.player（status toJSON 快照）恢复
   * 状态/属性/游标/轨迹/结局标记——构造器对进行中游戏调用（不再 init 重置）。
   */
  async continue() {
    const p = this._player.current.player as
      | PlayerRoguelikeV2.CurrentData.PlayerStatus
      | undefined;
    if (!p || !p.state || p.state === "NONE") {
      this.init();
      return;
    }
    this.state = p.state;
    this.property = p.property;
    this.cursor = p.cursor;
    this.trace = p.trace || [];
    this.status = p.status || { bankPut: 0 };
    this.toEnding = p.toEnding || "";
    this.chgEnding = p.chgEnding ?? false;
    this.runResult = (p as { runResult?: string }).runResult ?? "";
    this.innerMission = p.innerMission;
    this.nodeMission = p.nodeMission;
    this.zoneReward = p.zoneReward;
    this.traderReturn = p.traderReturn;
    // 结算终态归一：若存档已带 GAME_SETTLE（放弃/结算已生成）而 state 仍是 PENDING——
    // 放弃结算中途被中断留下的"僵尸态"（存档2222 复现），客户端会把该对局当"进行中"
    // 继续探索，却因无任何可推进事件而冻结（点继续卡死、且不再提供放弃）。健康已结算态
    // 应为 state=END + pending=GAME_SETTLE（gameSettle 收尾态），故恢复时把 PENDING 对齐 END。
    // 需同时回写持久态（_playerdata 的 current.player），否则登录响应序列化的是持久态
    // （仍是 PENDING），客户端依旧把对局当进行中。
    const settled =
      Array.isArray(p.pending) && p.pending.some((e) => e?.type === "GAME_SETTLE");
    if (settled && this.state !== "END") {
      this.state = "END";
      (p as { state: string }).state = "END";
      // 标记变更使存档落盘（控制器 _player 为 PlayerDataManager；normalization 直接改
      // 持久节点，登录即可见 END；markDirty 保证后续 delta 触发 save 写盘）
      this._player._player?.markDirty?.();
    }
  }

  async create() {
    const game = this._player.current.game!;
    const theme = game.theme;
    const init = excel.RoguelikeTopicTable.details[theme].init.find(
      (i) =>
        (i.modeGrade ?? 0) == (game.modeGrade ?? 0) &&
        i.predefinedId == game.predefined &&
        i.modeId == game.mode,
    )!;
    this.state = "INIT";
    // 新对局重置游标/轨迹（上一局 finishEvent 推进过 zone；不重置会导致下一局 init 阶段判定失效）
    this.cursor = { zone: 0, position: null };
    this.trace = [];
    // FBO 对默认值 0 的 int 字段编码为缺省 → undefined，按 0 处理
    this.property.hp.current = init.initialHp ?? 0;
    this.property.hp.max = init.initialHp ?? 0;
    this.property.gold = init.initialGold ?? 0;
    this.property.capacity = init.initialSquadCapacity ?? 0;
    this.property.population.max = init.initialPopulation ?? 0;
    this.property.population.cost = 0;
    this.property.conPerfectBattle = 0;
    this.property.shield = init.initialShield ?? 0;
    this.property.maxLevel = 10;
    this.toEnding = `ro${game.theme.slice(-1)}_ending_1`;
  }

  async bankPut() {
    const theme = this._player.current.game!.theme;
    const succeed = random() <= 0.5;
    if (succeed && this._player.outer[theme].bank.current <= 999) {
      this.status.bankPut += 1;
      // outer 为 _playerdata.rlv2 引用（update() 后冻结），写入须放入配方
      await this._player.update(async (draft) => {
        draft.outer[theme].bank.current += 1;
      });
      await this._trigger.emit("rlv2:bankPut", [succeed]);
    }
  }

  toJSON(): PlayerRoguelikeV2.CurrentData.PlayerStatus {
    return {
      state: this.state,
      property: this.property,
      cursor: this.cursor,
      trace: this.trace,
      pending: this.pending,
      status: this.status,
      toEnding: this.toEnding,
      chgEnding: this.chgEnding,
    };
  }
}
