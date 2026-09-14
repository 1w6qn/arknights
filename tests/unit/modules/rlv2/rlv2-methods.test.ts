import { describe, it, expect, vi, beforeEach } from "vitest";
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
        rogue_3: {
          init: [{ modeGrade: 0, predefinedId: null, modeId: "NORMAL", initRelic: {}, initRecruit: {} }],
          recruitTickets: {},
        },
      },
      modules: {
        rogue_3: { totemBuff: { totemBuffDatas: {} } },
      },
      consts: {},
    },
    CharacterTable: {} as Record<string, ExcelCharRowMock>,
  },
}));

import { PlayerDataManager } from "@game/kernel/player-data-manager";
import { mockPlayerData, asModel } from "../../../helpers";
import type { PlayerRoguelikeV2 } from "@game/modules/roguelike/rlv2-model";
import type { RoguelikePendingEvent } from "@game/modules/roguelike/events";
import type { Rlv2ThemeModule } from "@game/modules/roguelike/rlv2-module-composition";

/** 开局 game 夹具类型（真实模型 CurrentData.Game） */
type Rlv2Game = NonNullable<PlayerRoguelikeV2["current"]["game"]>;

/** 夹具 pending 事件视图（本文件只构造 SHOP/BATTLE/PREDICT 三类；视图对齐真实 Content.shop） */
interface PendingEventFixture {
  type: string;
  content: {
    shop?: { id?: string; goods?: { index: string; itemId: string }[]; refreshCnt?: number };
  };
}

/** SHOP pending 事件夹具（读侧需要 shop 必填，故此处收紧） */
interface ShopEventFixture {
  type: string;
  content: {
    shop: { id?: string; goods: { index: string; itemId: string }[]; refreshCnt: number };
  };
}

function makePlayer() {
  const pd = mockPlayerData({
    rlv2: { outer: {}, current: {}, pinned: {} as string },
    medal: { medals: {}, custom: { currentIndex: "0", customs: {} } },
    mission: { missions: { DAILY: {}, ACTIVITY: {} }, missionRewards: { dailyPoint: 0, weeklyPoint: 0, rewards: {} } },
  });
  return new PlayerDataManager(pd._playerdata);
}

describe("rlv2 补全接口", () => {
  let player: PlayerDataManager;

  beforeEach(() => {
    player = makePlayer();
  });

  /** 向状态机注入 pending 事件（pending 为只读 getter，经内部数组操作） */
  function pushPending(event: PendingEventFixture) {
    player.rlv2._status._pending._pending.push(event as RoguelikePendingEvent);
  }

  describe("refreshShop", () => {
    it("应重生成商品并扣刷新次数", async () => {
      player.rlv2.current.game = asModel<Rlv2Game>({ theme: "rogue_3", mode: "NORMAL" });
      const shopEvent: ShopEventFixture = {
        type: "SHOP",
        content: {
          shop: { id: "shop_1", goods: [{ index: "0", itemId: "x" }], refreshCnt: 2 },
        },
      };
      pushPending(shopEvent);
      player.rlv2.generateShopGoods = vi.fn().mockReturnValue([
        { index: "0", itemId: "relic_a" },
      ]);
      await player.rlv2.refreshShop();
      expect(shopEvent.content.shop.refreshCnt).toBe(1);
      expect(shopEvent.content.shop.goods).toEqual([{ index: "0", itemId: "relic_a" }]);
    });

    it("非 SHOP pending 不应刷新", async () => {
      pushPending({ type: "BATTLE", content: {} });
      const shopSpy = vi.fn();
      player.rlv2.generateShopGoods = shopSpy;
      await player.rlv2.refreshShop();
      expect(shopSpy).not.toHaveBeenCalled();
    });
  });

  describe("leaveShop", () => {
    it("应清空 pending 并回到 WAIT_MOVE", async () => {
      pushPending({ type: "SHOP", content: { shop: { goods: [] } } });
      player.rlv2._status.state = "IN_SHOP";
      await player.rlv2.leaveShop();
      expect(player.rlv2._status.pending).toHaveLength(0);
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });
  });

  describe("confirmPredict", () => {
    it("应清空 pending 并回到 WAIT_MOVE", async () => {
      pushPending({ type: "PREDICT", content: {} });
      player.rlv2._status.state = "IN_PREDICT";
      await player.rlv2.confirmPredict();
      expect(player.rlv2._status.pending).toHaveLength(0);
      expect(player.rlv2._status.state).toBe("WAIT_MOVE");
    });
  });

  describe("useTotem", () => {
    it("应调用图腾管理器 use 并标记已用", async () => {
      const totemUse = vi.fn();
      player.rlv2._module._modules["TOTEM"] = asModel<Rlv2ThemeModule>({ use: totemUse });
      await player.rlv2.useTotem({ totemIndex: ["t_0", "t_1"], nodeIndex: ["1"] });
      expect(totemUse).toHaveBeenCalledWith(["t_0", "t_1"], ["1"]);
    });
  });

  describe("closeRecruitTicket", () => {
    it("应关闭指定招募票（state=3 并清空列表）", async () => {
      player.rlv2.inventory!.recruit["t_1"] = asModel<PlayerRoguelikeV2.CurrentData.Recruit>({
        index: "t_1",
        id: "ticket_1",
        state: 1,
        list: [{ instId: 0 }],
        result: null,
        ts: 0,
        from: "shop",
        mustExtra: 0,
        needAssist: false,
      });
      await player.rlv2.closeRecruitTicket({ id: "t_1" });
      // 放弃票保留（state=3 终态）；inventory.recruit 由 finishEvent 初始阶段统一清空
      expect(player.rlv2.inventory!.recruit["t_1"].state).toBe(3);
      expect(player.rlv2.inventory!.recruit["t_1"].list).toHaveLength(0);
    });

    it("不存在的票应静默返回", async () => {
      await player.rlv2.closeRecruitTicket({ id: "t_999" });
    });
  });
});
