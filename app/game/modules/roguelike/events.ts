import { PlayerRoguelikePendingEvent } from "./rlv2";
import { RoguelikeV2Manager } from "./logic";
import { TypedEventEmitter } from "../../kernel/events/runtime";
import excel from "@excel/excel";
import { random } from "@utils/random";

/** GAME_INIT_RELIC / GAME_INIT_GIFT / GAME_INIT_RECRUIT_SET / GAME_INIT_RECRUIT 事件载荷 */
interface StepEventArgs {
  step: [number, number];
}

/** GAME_INIT_SUPPORT 事件载荷（id 为官方保留字段，本实现未消费） */
interface InitSupportEventArgs {
  step: [number, number];
  id: string;
}

/** RECRUIT 事件载荷 */
interface RecruitEventArgs {
  tickets: string;
}

/** SCENE 事件载荷 */
interface SceneEventArgs {
  scene: {
    id: string;
    choices: { [key: string]: number };
    choiceAdditional: { [key: string]: PlayerRoguelikePendingEvent.ChoiceAddition };
  };
  done: boolean;
  popReport: boolean;
}

/** DICE 事件载荷 */
interface DiceEventArgs {
  result: PlayerRoguelikePendingEvent.Dice.Result;
  rerollCount: number;
}

/** END_RESULT 事件载荷 */
interface EndResultEventArgs {
  result: PlayerRoguelikePendingEvent.EndingResult;
}

/** GAME_SETTLE 事件载荷（官方 giveUpGame/gameSettle 用：success + result + detailStr + popReport） */
interface GameSettleEventArgs {
  success: number;
  result: PlayerRoguelikePendingEvent.EndingResult;
  detailStr?: string;
  popReport?: boolean;
}

export class RoguelikeEventManager {
  _index: number;
  _player: RoguelikeV2Manager;
  _pending: RoguelikePendingEvent[] = [];
  _trigger: TypedEventEmitter;

  constructor(_player: RoguelikeV2Manager, _trigger: TypedEventEmitter) {
    this._index = 0;
    this._player = _player;
    this._pending = [];
    this._trigger = _trigger;
    this._trigger.on("rlv2:init", this.init.bind(this));
    this._trigger.on("rlv2:continue", this.continue.bind(this));
    this._trigger.on("rlv2:create", this.create.bind(this));
    this._trigger.on("rlv2:event:create", this.createEvent.bind(this));
  }

  init(): void {
    this._index = 0;
    this._pending = [];
  }

  continue(): void {
    // 重登"继续探索"：从存档 current.player.pending 恢复事件队列
    // （进行中游戏的重登恢复——否则 pending 为空，客户端无法继续；
    // 存档元素为线格式 {type, content}，运行时按字段消费兼容）
    const pend = this._player.current.player?.pending;
    if (Array.isArray(pend)) {
      this._pending = pend as RoguelikePendingEvent[];
      this._index = pend.length;
    }
  }

  createEvent([type, args]: [string, object]): void {
    this._pending.push(
      new RoguelikePendingEvent(
        this._player,
        this._trigger,
        type,
        this._index,
        args,
      ),
    );
    this._index++;
  }

  create(): void {
    this._index = 0;
    this._pending = [];
    const game = this._player.current.game!;
    const theme = this._player.current.game!.theme;
    const initConfig = this._player.initConfig;

    const supportEnabled = game.outer.support || false;
    // GAME_INIT_GIFT 开局礼物：由上一把遗留襁褓的 init_gift buff 数据驱动——
    // 仅当持有襁褓猫（金）/狗（希望）等带 init_gift 的 legacy 藏品才出现，
    // 内容 = 全部 init_gift buff（id/count）累加（非固定金+10/人口+1）。
    const legacyBuffs = (this._player.outer?.[theme]?.record?.legacy || [])
      .flatMap((id: string) => {
        const def = excel.RoguelikeTopicTable.details[theme]?.relics?.[id];
        return def?.buffs || [];
      });
    const giftEnabled = legacyBuffs.some((b) => b.key === "init_gift");
    const totalStep = (supportEnabled ? 4 : 3) + (giftEnabled ? 1 : 0);

    this._trigger.emit("rlv2:event:create", [
      "GAME_INIT_RELIC",
      { step: [1, totalStep] },
    ]);

    if (giftEnabled) {
      this._trigger.emit("rlv2:event:create", [
        "GAME_INIT_GIFT",
        { step: [2, totalStep] },
      ]);
    }

    if (supportEnabled) {
      this._trigger.emit("rlv2:event:create", [
        "GAME_INIT_SUPPORT",
        {
          step: [giftEnabled ? 3 : 2, totalStep],
          id: "",
        },
      ]);
    }

    this._trigger.emit("rlv2:event:create", [
      "GAME_INIT_RECRUIT_SET",
      {
        step: [
          supportEnabled ? (giftEnabled ? 4 : 3) : giftEnabled ? 3 : 2,
          totalStep,
        ],
      },
    ]);

    // 行动奖励（GAME_INIT_SUPPORT）襁褓加成（数据驱动，官方 buff）：
    // - init_support_multi_chance（襁褓三头犬）→ 选择次数 +1（追加一个 SUPPORT 事件）
    // - force_add_choice（襁褓羽蛇 legacy_04..09）→ 强制追加指定选项（startbuff_7..12）
    // 仅当本局有行动奖励阶段——上一把到 3 层 supportEnabled——时生效。
    const detailLg = excel.RoguelikeTopicTable.details[theme];
    const legacyBuffs2 = (this._player.outer?.[theme]?.record?.legacy || [])
      .flatMap((id: string) => detailLg?.relics?.[id]?.buffs || []);
    const extraSupport =
      supportEnabled &&
      legacyBuffs2.some((b) => b.key === "init_support_multi_chance");
    if (extraSupport) {
      this._trigger.emit("rlv2:event:create", [
        "GAME_INIT_SUPPORT",
        { step: [giftEnabled ? 3 : 2, totalStep], id: "" },
      ]);
    }

    this._trigger.emit("rlv2:event:create", [
      "GAME_INIT_RECRUIT",
      {
        step: [totalStep, totalStep],
      },
    ]);
  }

  toJSON(): PlayerRoguelikePendingEvent[] {
    return this._pending.map((e) => e.toJSON());
  }
}
export class RoguelikePendingEvent implements PlayerRoguelikePendingEvent {
  type: string;
  content: PlayerRoguelikePendingEvent.Content;
  _player: RoguelikeV2Manager;
  _trigger: TypedEventEmitter;

  constructor(
    _player: RoguelikeV2Manager,
    _trigger: TypedEventEmitter,
    type: string,
    index: number,
    args: {},
  ) {
    this._player = _player;
    this._trigger = _trigger;
    this.type = type;
    this._index = index;
    const build = PENDING_EVENT_BUILDERS[type];
    if (!build) {
      // 未登记类型：与原 `this[type](args)` 一致（方法不存在 → TypeError）
      throw new TypeError(`this[type] is not a function: ${type}`);
    }
    this.content = build(this, args);
  }

  _index: number;

  get index(): string {
    return `e_${this._index}`;
  }

  GAME_INIT_RELIC(args: StepEventArgs): PlayerRoguelikePendingEvent.Content {
    const initConfig = this._player.initConfig;
    // 分队可选列表：按 collect.band 解锁状态过滤（state 1 = 已解锁可开局选择）。
    // 官服 createGame 只给已解锁分队（升级变体解锁后旧分队隐藏——如 band_2 解锁则 band_1 不出现）。
    const theme = this._player.current.game!.theme;
    const bandStates = this._player.outer?.[theme]?.collect?.band || {};
    const bands = (initConfig.initialBandRelic || []).filter((id: string) => {
      const st = bandStates[id]?.state;
      // 未初始化（首玩）时全给；否则只给 state 1
      return st === undefined ? true : st === 1;
    });
    return {
      initRelic: {
        step: args.step,
        items: bands.reduce<PlayerRoguelikePendingEvent.InitRelicContent["items"]>(
          (acc, cur, idx) => {
            return { ...acc, [idx.toString()]: { id: cur, count: 1 } };
          },
          {},
        ),
      },
    };
  }

  /**
   * 开局礼物：由上一把遗留襁褓的 init_gift buff 数据驱动（衬于 legacy 藏品：
   * 襁褓中的猫→金+5、襁褓中的狗→希望+1），无衬于则本事件不生成。
   */
  GAME_INIT_GIFT(args: StepEventArgs): PlayerRoguelikePendingEvent.Content {
    const theme = this._player.current.game!.theme;
    const legacy = this._player.outer?.[theme]?.record?.legacy || [];
    const detail = excel.RoguelikeTopicTable.details[theme];
    // 全部 init_gift buff 按物品 id 合并 count（官服 8-11 抓包：2 猫 1 狗 →
    // items=[{gold,10},{population,1}]，同类累加而非逐条下发）
    const items = legacy
      .flatMap((id) => detail?.relics?.[id]?.buffs || [])
      .filter((b) => b.key === "init_gift")
      .map((b) => ({
        id: b.blackboard[0]?.valueStr,
        count: b.blackboard[1]?.value ?? 1,
      }))
      .filter((it) => it.id)
      .reduce<PlayerRoguelikePendingEvent.InitGiftContent["items"]>((acc, it) => {
        const found = acc.find((x) => x.id === it.id);
        if (found) found.count += it.count;
        else acc.push({ ...it });
        return acc;
      }, []);
    return {
      initGift: {
        step: args.step,
        items,
      },
    };
  }

  GAME_INIT_SUPPORT(
    args: InitSupportEventArgs,
  ): PlayerRoguelikePendingEvent.Content {
    const game = this._player.current.game!;
    const theme = game.theme;
    const roNum = theme.slice(-1);
    // 按主题动态取开局 buff（行动奖励）场景与选项：
    // rogue_1 无 ro 前缀（scene_startbuff_enter / choice_startbuff_N），其余为 scene_roX_startbuff_enter / choice_roX_startbuff_N
    const sceneId =
      roNum === "1" ? "scene_startbuff_enter" : `scene_ro${roNum}_startbuff_enter`;
    const allChoiceKeys = Object.keys(
      excel.RoguelikeTopicTable.details[theme]?.choices || {},
    ).filter((k) =>
      roNum === "1"
        ? k.startsWith("choice_startbuff_")
        : k.startsWith(`choice_ro${roNum}_startbuff_`),
    );
    // 基础行动奖励 6 选 3（官方：6 个基础选项随机出 3 个；襁褓生灵可额外增加选项）。
    // 黑流树海基础选项为 startbuff_1..6，襁褓类（7..12，选择后获得襁褓宠物 start_1..6）
    // 仅当持有对应襁褓时追加。
    const baseKeys =
      roNum === "6"
        ? allChoiceKeys.filter((k) => {
            const n = parseInt(k.replace(/^.*startbuff_/, ""), 10);
            return n >= 1 && n <= 6;
          })
        : allChoiceKeys;
    const shuffled = [...(baseKeys.length > 0 ? baseKeys : allChoiceKeys)].sort(
      () => random() - 0.5,
    );
    const picked = shuffled.slice(0, 3);
    // 襁褓生灵加成（数据驱动，官方 force_add_choice buff——襁褓羽蛇 legacy_04..09：
    // 通过≥2 区 → 下次行动奖励强制追加指定襁褓选项 startbuff_7..12）
    const detailLg2 = excel.RoguelikeTopicTable.details[theme];
    const forceChoices = (this._player.outer?.[theme]?.record?.legacy || [])
      .flatMap((id: string) => detailLg2?.relics?.[id]?.buffs || [])
      .filter((b) => b.key === "force_add_choice")
      .map((b) => b.blackboard[0]?.valueStr)
      .filter((cid) => cid && allChoiceKeys.includes(cid));
    for (const cid of forceChoices) {
      if (!picked.includes(cid)) picked.push(cid);
    }
    const choices = picked.reduce((acc, key) => ({ ...acc, [key]: 1 }), {});
    return {
      initSupport: {
        step: args.step,
        scene: {
          id: sceneId,
          choices,
        },
      },
    };
  }

  GAME_INIT_RECRUIT_SET(args: StepEventArgs): PlayerRoguelikePendingEvent.Content {
    const initConfig = this._player.initConfig;
    return {
      initRecruitSet: {
        step: args.step,
        option: initConfig.initialRecruitGroup || [],
      },
    };
  }

  GAME_INIT_RECRUIT(args: StepEventArgs): PlayerRoguelikePendingEvent.Content {
    this._trigger.on(
      "rlv2:choose_init_recruit_set",
      ([tickets]: [string[]]) => {
        this.content.initRecruit!.tickets = tickets;
      },
    );
    return {
      initRecruit: {
        step: args.step,
        tickets: [],
        showChar: [],
        team: null,
      },
    };
  }

  RECRUIT(args: RecruitEventArgs): PlayerRoguelikePendingEvent.Content {
    return {
      recruit: {
        ticket: args.tickets,
      },
    };
  }

  /**
   * 商店（官方 pending BATTLE_SHOP：content.battleShop = { bank, id, goods,
   * canBattle, hasBoss, refreshCnt, showRefresh, withdrawMethod, refreshMethod,
   * recycleGoods?, recycleCount? }，内容由控制器 buildShopContent 构建）
   */
  BATTLE_SHOP(
    args: PlayerRoguelikePendingEvent.ShopContent,
  ): PlayerRoguelikePendingEvent.Content {
    return { battleShop: args };
  }

  BATTLE(
    args: PlayerRoguelikePendingEvent.BattleContent,
  ): PlayerRoguelikePendingEvent.Content {
    return {
      battle: args,
    };
  }

  BATTLE_REWARD(
    args: PlayerRoguelikePendingEvent.BattleRewardContent,
  ): PlayerRoguelikePendingEvent.Content {
    return {
      battleReward: args,
    };
  }

  DICE(args: DiceEventArgs): PlayerRoguelikePendingEvent.Content {
    return {
      dice: {
        result: args.result,
        rerollCount: args.rerollCount,
      },
    };
  }

  SCENE(args: SceneEventArgs): PlayerRoguelikePendingEvent.Content {
    return {
      scene: {
        id: args.scene.id,
        choices: args.scene.choices,
        choiceAdditional: args.scene.choiceAdditional,
      },
      done: args.done,
      popReport: args.popReport,
    };
  }

  END_RESULT(args: EndResultEventArgs): PlayerRoguelikePendingEvent.Content {
    return {
      result: args.result,
    };
  }

  /** 游戏结算（官方 giveUpGame/gameSettle 用 GAME_SETTLE：success + result + detailStr + popReport） */
  GAME_SETTLE(args: GameSettleEventArgs): PlayerRoguelikePendingEvent.Content {
    return {
      success: args.success,
      result: args.result,
      detailStr: args.detailStr,
      popReport: args.popReport,
    };
  }

  toJSON(): PlayerRoguelikePendingEvent {
    return {
      index: this.index,
      type: this.type,
      content: this.content,
    };
  }
}

/** 事件内容构造器：事件类型 → 类内同名方法（构造期单点分发的签名） */
type PendingEventBuilder = (
  event: RoguelikePendingEvent,
  args: {},
) => PlayerRoguelikePendingEvent.Content;

/**
 * 事件类型 → 内容构造器（键集合 = 本类实现的事件幕）。
 *
 * 线格式事件载荷为 `[type, object]`（见 kernel/events/rlv2.ts 契约），
 * 各幕具体形状不参与编译期校验，故在单点分发处按幕收窄：
 * 与原 `this[type](args)` 动态调用等价，未登记类型抛 TypeError（medal.ts 同款显式表）。
 */
const PENDING_EVENT_BUILDERS: {
  [type: string]: PendingEventBuilder | undefined;
} = {
  GAME_INIT_RELIC: (e, args) => e.GAME_INIT_RELIC(args as StepEventArgs),
  GAME_INIT_GIFT: (e, args) => e.GAME_INIT_GIFT(args as StepEventArgs),
  GAME_INIT_SUPPORT: (e, args) =>
    e.GAME_INIT_SUPPORT(args as InitSupportEventArgs),
  GAME_INIT_RECRUIT_SET: (e, args) =>
    e.GAME_INIT_RECRUIT_SET(args as StepEventArgs),
  GAME_INIT_RECRUIT: (e, args) => e.GAME_INIT_RECRUIT(args as StepEventArgs),
  RECRUIT: (e, args) => e.RECRUIT(args as RecruitEventArgs),
  BATTLE_SHOP: (e, args) =>
    e.BATTLE_SHOP(args as PlayerRoguelikePendingEvent.ShopContent),
  BATTLE: (e, args) =>
    e.BATTLE(args as PlayerRoguelikePendingEvent.BattleContent),
  BATTLE_REWARD: (e, args) =>
    e.BATTLE_REWARD(args as PlayerRoguelikePendingEvent.BattleRewardContent),
  DICE: (e, args) => e.DICE(args as DiceEventArgs),
  SCENE: (e, args) => e.SCENE(args as SceneEventArgs),
  END_RESULT: (e, args) => e.END_RESULT(args as EndResultEventArgs),
  GAME_SETTLE: (e, args) => e.GAME_SETTLE(args as GameSettleEventArgs),
};
