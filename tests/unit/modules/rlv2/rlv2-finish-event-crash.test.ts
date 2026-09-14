import { describe, it, expect, vi } from "vitest";
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

/**
 * toJSON 输出的 gridZone 视图
 *
 * `json` 是 `JSON.parse(JSON.stringify(rlv2.toJSON()))` 产物（静态类型未建模），
 * 本用例只读 zones / needConfirmStepZero；节点只读 show / content.kind / state
 * （键格式与布尔性即断言对象）。
 */
interface GridZoneJson {
  needConfirmStepZero?: boolean | number;
  zones?: {
    [key: string]: {
      nodes?: {
        [key: string]: {
          show?: boolean | number;
          content?: { kind?: number };
          state?: number;
        };
      };
    };
  };
}


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
        rogue_6: {
          init: [{ modeGrade: 15, predefinedId: null, modeId: "NORMAL", initialBandRelic: ["rogue_6_band_1"], initialRecruitGroup: ["recruit_group_1"] }],
          stages: {
            ro6_n_1_1: { id: "ro6_n_1_1" }, ro6_n_1_2: { id: "ro6_n_1_2" },
            ro6_e_1_1: { id: "ro6_e_1_1" },
          },
          recruitTickets: {
            rogue_6_recruit_ticket_pioneer: { id: "rogue_6_recruit_ticket_pioneer", professionList: ["PIONEER"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_sniper: { id: "rogue_6_recruit_ticket_sniper", professionList: ["SNIPER"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
            rogue_6_recruit_ticket_special: { id: "rogue_6_recruit_ticket_special", professionList: ["SPECIAL"], rarityList: ["TIER_3","TIER_4","TIER_5","TIER_6"] },
          },
          recruitGrps: { recruit_group_1: { id: "recruit_group_1", name: "x", desc: "y" } },
          items: {
            rogue_6_gold: { id: "rogue_6_gold", type: "GOLD" },
            rogue_6_band_1: { id: "rogue_6_band_1", type: "BAND" },
          },
          relics: { rogue_6_band_1: { id: "rogue_6_band_1", buffs: [] } },
          bandRef: { rogue_6_band_1: { itemID: "rogue_6_band_1", bandLevel: 0, normalBandId: "rogue_6_band_1" } },
          choices: { choice_x: { id: "choice_x", nextSceneId: null } },
          detailConst: { playerLevelTable: { 2: { exp: 10 } } },
        },
      },
      modules: { rogue_6: { moduleTypes: ["GRID_ZONE", "WEATHER", "SCRAP"], scrap: { scrapItemToType: {} } } },
      consts: {},
    },
    CharacterTable: {
      char_1012_skadi: { charId: "char_1012_skadi", rarity: "TIER_6", profession: "PIONEER" },
    } as Record<string, ExcelCharRowMock>,
    GameDataConst: { maxLevel: [[], [], [], [], [], []] },
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import type { RoguelikeV2Manager } from "@game/modules/roguelike/logic";
import { asModel, mockPlayerData } from "../../../helpers";

/** 开局 game 夹具类型（真实模型 `CurrentData.Game`） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: { outer: { rogue_6: {} }, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
    troop: { chars: { 1: { charId: "char_1012_skadi" } } },
  });
  const player = new PlayerDataManager(pd._playerdata);
  player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefined: null });
  return player;
}

describe("finishEvent 崩溃排查", () => {
  it("完整 init 流程后 finishEvent 生成的响应结构应完整（gridZone/map/weather 键格式）", async () => {
    const player = makePlayer();
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    const rlv2 = player.rlv2;
    const pending = rlv2._status.pending;
    // 走完整 init：RELIC → GIFT → SUPPORT → RECRUIT_SET → RECRUIT
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent(); // GIFT
    await rlv2.selectChoice({ choice: "choice_x" }); // SUPPORT（若无则跳过）
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    // 逐张招募（若候选为空则放弃）
    const recruitEvt = pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    if (recruitEvt?.content?.initRecruit?.tickets?.length) {
      for (const t of [...recruitEvt.content.initRecruit.tickets]) {
        await rlv2.activeRecruitTicket({ id: t });
        const ticket = rlv2.inventory!.recruit[t];
        if (ticket?.list?.length) {
          await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
        }
      }
    }
    await rlv2.finishEvent(); // 消费 GAME_INIT_RECRUIT → 生成第一层地图
    // 模拟响应序列化（JSON.stringify 触发各 manager toJSON）
    const json = JSON.parse(JSON.stringify(rlv2.toJSON()));
    // 客户端崩溃排查：各结构键格式（官服线格式对齐）
    expect(rlv2._status.state).toBe("WAIT_MOVE");
    const gz = json.current.module.gridZone as GridZoneJson;
    const gzKeys = Object.keys(gz?.zones || {});
    for (const k of gzKeys) expect(k).toMatch(/^zone_\d+$/);
    // gridZone 节点：show 为布尔、content 无 kind（官方仅 savage/shop）
    for (const z of Object.values(gz?.zones || {})) {
      for (const n of Object.values(z.nodes || {})) {
        expect(typeof n.show).toBe("boolean");
        expect(n.content).not.toHaveProperty("kind");
      }
    }
    // scrap activeVehicle.isWalk 为布尔
    expect(typeof json.current.module.scrap.activeVehicle.isWalk).toBe("boolean");
    // map.zones 键为区域索引 1000+
    for (const k of Object.keys(json.current.map?.zones || {})) expect(k).toMatch(/^\d+$/);
    // needConfirmStepZero 为布尔
    expect(typeof gz.needConfirmStepZero).toBe("boolean");
  });

  it("进层后自动完成起点走一步：needConfirmStepZero=false、起点节点已访问、trace 含起点、weather 为空（官服对齐 R-1786531228496.9993-3674）", async () => {
    const player = makePlayer();
    await player.rlv2.createGame({ theme: "rogue_6", mode: "NORMAL", modeGrade: 15, predefinedId: null });
    const rlv2 = player.rlv2;
    const pending = rlv2._status.pending;
    await rlv2.chooseInitialRelic({ select: "0" });
    await rlv2.finishEvent(); // GIFT
    await rlv2.selectChoice({ choice: "choice_x" }); // SUPPORT
    await rlv2.chooseInitialRecruitSet({ select: "recruit_group_1" });
    const recruitEvt = pending.find((e) => e.type === "GAME_INIT_RECRUIT");
    if (recruitEvt?.content?.initRecruit?.tickets?.length) {
      for (const t of [...recruitEvt.content.initRecruit.tickets]) {
        await rlv2.activeRecruitTicket({ id: t });
        const ticket = rlv2.inventory!.recruit[t];
        if (ticket?.list?.length) {
          await rlv2.recruitChar({ ticketIndex: t, optionId: String(ticket.list[0].instId) });
        }
      }
    }
    await rlv2.finishEvent(); // 消费 GAME_INIT_RECRUIT → 生成第一层地图（进层）
    const json = JSON.parse(JSON.stringify(rlv2.toJSON()));
    const gz = json.current.module.gridZone as GridZoneJson;
    // 1) 进层后无条件确认初始位置
    expect(gz.needConfirmStepZero).toBe(false);
    // 2) trace 已含起点（进层自动走一步）
    expect(rlv2._status.trace.length).toBe(1);
    // 3) 起点节点已访问（state=2），且与 trace 位置一致
    const t0 = rlv2._status.trace[0];
    const startId = String(t0.position!.x * 100 + t0.position!.y);
    const zoneKey = currentZoneKeyOf(rlv2, t0.zone);
    const startNode = gz.zones![zoneKey]?.nodes?.[startId];
    expect(startNode).toBeTruthy();
    expect(startNode!.state).toBe(2);
    // 4) weather 保持为空（彻底移除随机天气）
    expect(json.current.module.weather.currentMain).toBe("");
    expect(json.current.module.weather.currentSub).toBe("");
    expect(json.current.module.weather.weatherStep).toBe(0);
  });
});

/** 取 gridZone 当前 zone 键（与控制器 currentZoneKey 等价） */
function currentZoneKeyOf(rlv2: RoguelikeV2Manager, zone: number): string {
  const gz = rlv2._module.gridZone;
  return gz?.currentZoneKey ? gz.currentZoneKey() : `zone_${zone}`;
}
