import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decryptBattleData, decryptBattleReplay } from "@utils/crypt";

// 默认 mock：解密返回完整战报（含 stats.totalDamage/checkKilledCnt 与 isCheat），
// 回放（battleLog）解析返回对象。
vi.mock("@utils/crypt", () => ({
  decryptBattleData: vi.fn().mockResolvedValue({
    completeState: 2,
    finalHp: 10,
    isPerfect: 0,
    battleData: {
      isCheat: "cheat-token",
      stats: { totalDamage: 1200, checkKilledCnt: 45 },
    },
  }),
  decryptBattleReplay: vi.fn().mockResolvedValue({
    actions: ["attack"],
    rounds: 3,
  }),
}));

vi.mock("@game/modules/account/account-manager", () => ({
  accountManager: {
    getBattleInfo: vi.fn().mockResolvedValue({ stageId: "ro1_n_1_1" }),
  },
}));
/** excel mock 行形状（本文件用到的字段即可） */
interface ExcelRowMock { name?: string }
/** excel mock 干员行形状（本文件用到的字段即可） */
interface ExcelCharRowMock {
  name?: string;
  charId?: string;
  rarity?: string;
  profession?: string;
  subProfessionId?: string;
}

// 官方 excel mock：rogue_1 items 含 RELIC（收藏品池）+ fragment
vi.mock("@excel/excel", () => ({
  default: {
    // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
    getItem(id: string): ExcelRowMock | undefined { return this.ItemTable?.items?.[id]; },
    itemName(id: string): string { return this.getItem(id)?.name ?? id; },
    makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
    charData(charId: string) { return this.CharacterTable?.[charId]; },
    stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
    ItemTable: undefined as { items?: Record<string, ExcelRowMock> } | undefined,
    StageTable: undefined as { stages?: Record<string, ExcelRowMock> } | undefined,

    RoguelikeTopicTable: {
      details: {
        rogue_1: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL" }],
          items: {
            rogue_1_relic_a01: { id: "rogue_1_relic_a01", type: "RELIC", rarity: "NORMAL", canSacrifice: true, value: 8 },
            rogue_1_fragment_I_1: { id: "rogue_1_fragment_I_1", type: "FRAGMENT", rarity: "NONE" },
            rogue_1_gold: { id: "rogue_1_gold", type: "GOLD", rarity: "NONE" },
          },
          relics: {},
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      modules: { rogue_1: { fragment: { fragmentData: {} } } },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
    RoguelikeConsts: {},
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { MockInstance } from "vitest";
import type { BattleData } from "@game/kernel/battle-model";
import type { BattleRecord } from "@game/kernel/battle-info-store";
import type {
  PlayerRoguelikeV2,
  PlayerRoguelikeV2Zone,
  RoguelikeStageEarn,
} from "@game/modules/roguelike/rlv2-model";
import type { RoguelikePendingEvent } from "@game/modules/roguelike/events";

/**
 * earn 伤害字段读取视图
 *
 * 服务端结算恒写 `earn.damage = 0`（见 app/game/modules/roguelike/battle.ts 的 earn 组装），
 * 而模型 `RoguelikeStageEarn` 未声明该键；用例沿官服口径断言其为 0，
 * 故仅就地补一个可选键的读取视图（其余字段沿用真实模型）。
 */
type EarnWithDamage = RoguelikeStageEarn & { damage?: number };

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer() {
  const pd = mockPlayerData({
    pushFlags: { status: 123456 },
    rlv2: { outer: {}, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_1", mode: "NORMAL", modeGrade: 0, predefined: null, start: 1 });
  return player;
}

describe("rlv2 battleFinish 战报字段消费（data/battleData/battleLog）", () => {
  let player: PlayerDataManager;
  let saveSpy: MockInstance<(record: BattleRecord) => Promise<void>>;
  let randomSpy: MockInstance<() => number>;

  beforeEach(async () => {
    player = makePlayer();
    // 构造期 emit 的 rlv2:init 是异步（Emittery），等待其 listener 完成后再 create
    await new Promise((r) => setTimeout(r, 0));
    // 初始化收藏品池（battle 依赖 _pool）
    await player.rlv2._pool.create();
    // BATTLE pending 事件（finish 会 shift）
    player.rlv2._status._pending._pending.push(asModel<RoguelikePendingEvent>({ type: "BATTLE", content: {} }));
    player.rlv2._status.property.hp = { current: 10, max: 10 };
    player.rlv2._status.property.level = 1;
    // 标准主题地图节点（层号键）
    player.rlv2._map.zones[1] = asModel<PlayerRoguelikeV2Zone>({
      nodes: { "100": { pos: { x: 1, y: 0 }, next: [], type: 1, stage: "ro1_n_1_1" } },
    });
    player.rlv2._status.cursor.zone = 1;
    player.rlv2._status.cursor.position = { x: 1, y: 0 };
    // 捕获留存记录内容（不落库）——controller._player 即同一 PlayerDataManager 实例
    saveSpy = vi.spyOn(player, "saveBattleRecord").mockResolvedValue(undefined);
    // Math.random 固定 0.1：命中 40% 收藏品概率、金币区间低位
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.1);
  });

  afterEach(() => {
    randomSpy.mockRestore();
    saveSpy?.mockRestore();
  });

  it("battleId 优先取战报回传值（无会话记录时也能解析上下文）", async () => {
    // 不经过 start（会话 Map 无记录）——战报 battleId 提供上下文
    await player.rlv2._battle.finish([
      { battleLog: "", data: "encrypted", battleData: asModel<BattleData>({ battleId: "report-battle-1" }) },
    ]);
    expect(saveSpy).toHaveBeenCalled();
    const record = saveSpy.mock.calls[0][0];
    expect(record.battleId).toBe("report-battle-1");
  });

  it("battleLog 解析结果与 isCheat 写入战斗记录", async () => {
    await player.rlv2._battle.finish([
      { battleLog: "BASE64ZIP", data: "encrypted", battleData: asModel<BattleData>({ completeState: 2 }) },
    ]);
    expect(decryptBattleReplay).toHaveBeenCalledWith("BASE64ZIP");
    const record = saveSpy.mock.calls[0][0];
    expect(record.battleLog).toEqual({ actions: ["attack"], rounds: 3 });
    expect(record.isCheat).toBe("cheat-token");
  });

  it("解密失败时请求明文 battleData 兜底判胜（仍生成 BATTLE_REWARD）", async () => {
    vi.mocked(decryptBattleData).mockRejectedValueOnce(new Error("bad data"));
    // finalHp 为生产侧合并视图字段（Rlv2BattleReport），模型 BattleData 未声明；
    // 经变量传入避免字面量多余属性检查，值原样保留。
    const plainBattleData = { completeState: 2, finalHp: 5 };
    await player.rlv2._battle.finish([
      { battleLog: "", data: "bad", battleData: asModel<BattleData>(plainBattleData) },
    ]);
    const rewardEvent = player.rlv2._status.pending.find(
      (e) => e.type === "BATTLE_REWARD",
    );
    expect(rewardEvent).toBeDefined();
  });

  it("无效 battleLog 不阻断结算（仅告警，仍判胜）", async () => {
    vi.mocked(decryptBattleReplay).mockRejectedValueOnce(new Error("bad base64"));
    await player.rlv2._battle.finish([
      { battleLog: "garbage", data: "encrypted", battleData: asModel<BattleData>({ completeState: 2 }) },
    ]);
    const rewardEvent = player.rlv2._status.pending.find(
      (e) => e.type === "BATTLE_REWARD",
    );
    expect(rewardEvent).toBeDefined();
  });

  it("earn.damage/hp/shield 恒 0（官服 battleFinish 口径；战报伤害仅存记录不入 earn）", async () => {
    await player.rlv2._battle.finish([
      { battleLog: "", data: "encrypted", battleData: asModel<BattleData>({ completeState: 2 }) },
    ]);
    const rewardEvent = player.rlv2._status.pending.find(
      (e) => e.type === "BATTLE_REWARD",
    );
    const earn: EarnWithDamage = rewardEvent!.content.battleReward!.earn;
    expect(earn.damage).toBe(0);
    expect(earn.hp).toBe(0);
    expect(earn.shield).toBe(0);
  });
});
