import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { collectFiles, readSource } from "../../helpers/fs-scan";

/**
 * GM 面板（归档服务端 GM 契约）单元测试
 *
 * 覆盖三块：
 * 1. `/admin/<op>` 请求体契约（面板 gm.js 实际发送的形状必须被 schema 接受）
 * 2. 自走棋 GM 11 条指令（真实 AutoChessManager + 替身 excel/玩家存档）
 * 3. GmService 若干域操作（gateway/excel 替身；导入/写盘路径不进单测）
 */

/* ---------- 替身 ---------- */

const excelMock = vi.hoisted(() => {
  const autochessAct = {
    modeDataDict: {
      mode_single_normal: {
        modeId: "mode_single_normal",
        preposedMode: null,
        modeType: "SINGLE",
        modeDifficulty: "NORMAL",
        specialPhaseTime: 150,
      },
    },
    baseRewardDataList: [
      { round: 1, item: { id: "act2autochess_token_chess", count: 10 }, dailyMissionPoint: 10 },
    ],
    charShopChessDatas: {
      chess_char_1_01_a: { chessId: "chess_char_1_01_a", charId: "char_001", chessLevel: 1 },
    },
    trapShopChessDatas: {
      chess_item_1_01_e_a: {
        itemId: "chess_item_1_01_e_a",
        itemLevel: 1,
        itemType: "MAGIC",
        trapId: "trap_1",
      },
    },
    bossInfoDict: {
      boss_1: { bossId: "boss_1", weight: 1 },
      boss_2: { bossId: "boss_2", weight: 1 },
    },
    stageDatasDict: { scene_1: { stageId: "scene_1" } },
    constData: { dailyMissionParam: 200, trainingModeId: "mode_training_1" },
  };
  return {
    ActivityTable: {
      activity: { autochessSeason: { act2autochess: autochessAct } },
      basicInfo: {
        act2autochess: { id: "act2autochess", type: "AUTOCHESS_SEASON", name: "卫戍协议" },
      },
    },
    ItemTable: { items: {} },
    SkinTable: { charSkins: {} },
    CharacterTable: {},
    BuildingData: { customData: { furnitures: {} } },
    ClimbTowerTable: { seasonInfos: {} },
    SandboxPermTable: { basicInfo: {}, detail: {} },
    RoguelikeTopicTable: { topics: {} },
    UniequipTable: { equipDict: {}, charEquip: {} },
    charData() {
      return undefined;
    },
    getItem() {
      return undefined;
    },
    makeItem(id: string, count: number, type?: string) {
      return type ? { id, count, type } : { id, count };
    },
  };
});

vi.mock("@excel/excel", () => ({ default: excelMock }));

const accountManagerMock = vi.hoisted(() => ({
  data: {} as Record<string, never>,
  configs: { "1": {}, "2222": {} } as Record<string, Record<string, never>>,
  getPlayerData: vi.fn(),
  flushSave: vi.fn().mockResolvedValue(undefined),
  getPlayerUidList: vi.fn().mockReturnValue([]),
  readPlayerData: vi.fn().mockResolvedValue(null),
}));

const adminServiceMock = vi.hoisted(() => ({
  maxAllChars: vi.fn().mockResolvedValue({ chars: 3 }),
  unlockAllStages: vi.fn().mockResolvedValue({ stages: 5, total: 10 }),
  sendMail: vi.fn().mockResolvedValue({ mailId: 1 }),
  switchActivity: vi.fn().mockResolvedValue({
    ok: true,
    timestamp: -1,
    effectiveTs: 1,
    openCount: 0,
    forceOpen: [],
    crisisV1: "cc1",
    crisisV2: "cc1",
    backfillTasks: [],
  }),
  rogueModifyState: vi.fn().mockResolvedValue({ ok: true, state: null }),
  importUser: vi.fn().mockResolvedValue({ uid: "1" }),
  grantChar: vi.fn().mockResolvedValue({ isNew: 1, name: "x" }),
}));

vi.mock("@ops/admin/AdminService", () => ({
  AdminService: class {
    maxAllChars = adminServiceMock.maxAllChars;
    unlockAllStages = adminServiceMock.unlockAllStages;
    sendMail = adminServiceMock.sendMail;
    switchActivity = adminServiceMock.switchActivity;
    rogueModifyState = adminServiceMock.rogueModifyState;
    importUser = adminServiceMock.importUser;
    grantChar = adminServiceMock.grantChar;
  },
  adminService: adminServiceMock,
}));

vi.mock("@ops/admin/game-gateway", () => ({
  adminGame: {
    accountManager: accountManagerMock,
    autoChessGmCatalog: vi.fn().mockReturnValue({ chars: [], items: [] }),
    listCrisisSeasons: vi.fn().mockResolvedValue({ v1: ["cc1"], v2: ["cc2"] }),
    buildFreshPlayerData: vi.fn().mockReturnValue({ status: { level: 1 }, inventory: {} }),
    buildMaxedSkills: vi.fn().mockReturnValue([]),
    buildMaxedEquip: vi.fn().mockReturnValue({ ids: [], equip: {} }),
    unlockActivity: vi.fn(),
    forcedActivityIds: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("@ops/assets/asset", () => ({ reloadMods: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@ops/admin/admin-config", () => ({
  getAdminConfig: () => ({ enable: true, token: "t" }),
}));

vi.mock("@utils/file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/file")>();
  return {
    ...actual,
    writeJson: vi.fn().mockResolvedValue(undefined),
    readJson: vi.fn().mockResolvedValue({
      pools: {
        pool_relic: { members: ["rogue_6_relic_b", "rogue_6_relic_a", "rogue_6_item_x"] },
      },
    }),
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, mkdir: vi.fn().mockResolvedValue(undefined), rm: vi.fn().mockResolvedValue(undefined) };
});

import { AutoChessManager } from "@game/modules/autochess/autochess";
import { asPlayerManager, mockPlayerData } from "../../helpers";
import { gmService } from "@ops/admin/gm/gm-service";
import gmRouter from "@ops/admin/gm/gm-router";
import gmOpsRouter from "@ops/admin/gm/gm-ops-router";
import { GmOpError } from "@ops/admin/gm/gm-types";
import {
  gmActivityClockSchema,
  gmAutochessGmSchema,
  gmCharSchema,
  gmItemClearSchema,
  gmMailGrantSchema,
  gmSandboxEnemyRushSchema,
} from "@ops/admin/gm/gm-schemas";
import { buildGmData } from "@ops/admin/gm/gm-data";

/* ---------- 契约 ---------- */

describe("GM 请求体契约（与归档面板 gm.js 逐字对齐）", () => {
  it("活动/自走棋/干员/物品/邮件/沙盒 面板实体应被 schema 接受", () => {
    expect(gmActivityClockSchema.safeParse({ activity_id: "act2autochess" }).success).toBe(true);
    expect(gmActivityClockSchema.safeParse({}).success).toBe(true); // null body 被 validateBody 规整为 {}
    expect(
      gmAutochessGmSchema.safeParse({ uid: "1", code: "add_coin", params: [10] }).success,
    ).toBe(true);
    expect(gmAutochessGmSchema.safeParse({ code: "state" }).success).toBe(true);
    expect(
      gmCharSchema.safeParse({
        player_id: "1",
        char_id: "char_002_amiya",
        level: 90,
        evolve_phase: 2,
        potential_rank: 5,
        main_skill_lvl: 7,
        skill_idx_lst: [1],
        specialize_level: 3,
        equip_id_lst: ["uniequip_002_amiya"],
        equip_level: 3,
        tmpl_id: "",
        favor_point: 25570,
      }).success,
    ).toBe(true);
    expect(gmItemClearSchema.safeParse({ player_id: "1" }).success).toBe(true);
    expect(
      gmMailGrantSchema.safeParse({
        player_id: "1",
        items: [{ id: "3001", count: 5 }],
        subject: "补给",
        content: "正文",
      }).success,
    ).toBe(true);
    expect(
      gmSandboxEnemyRushSchema.safeParse({
        player_id: "1",
        topic_id: "sandbox_1",
        enemy_id: "e1",
        node_id: "n1",
      }).success,
    ).toBe(true);
  });

  it("缺必填字段应拒绝", () => {
    expect(gmCharSchema.safeParse({ char_id: "char_002_amiya" }).success).toBe(false);
    expect(gmMailGrantSchema.safeParse({ player_id: "1" }).success).toBe(false);
    expect(gmAutochessGmSchema.safeParse({ uid: "1" }).success).toBe(false);
  });
});

/* ---------- 自走棋 GM ---------- */

function makePlayer() {
  const pd = mockPlayerData({
    activity: {},
    status: { uid: "1", nickName: "博士", nickNumber: 0, level: 1, exp: 0 },
  });
  pd.battle = {
    start: vi.fn().mockResolvedValue({ battleId: "battle-train-1", result: 0 }),
    finish: vi.fn().mockResolvedValue({ result: 0, rewards: [] }),
  };
  return pd;
}

type TestPlayer = ReturnType<typeof makePlayer>;

function makeManager(player: TestPlayer) {
  return new AutoChessManager(asPlayerManager(player), player._trigger);
}

/** 开一局多人对战（创建会话） */
async function startBattle(mgr: AutoChessManager) {
  mgr.startMatch({ activityId: "act2autochess", option: { mode: "mode_single_normal" } });
  const res = await mgr.multiBattleStart({ activityId: "act2autochess", sceneId: "scene_1" });
  expect(res.ok).toBe(true);
}

describe("自走棋 GM 指令（/admin/autochess_gm）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("state：无对局返回 active=false（非错误）", async () => {
    const mgr = makeManager(makePlayer());
    const res = await mgr.executeGm("state", []);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.active).toBe(false);
  });

  it("未知指令 400、无对局的变更指令 409", async () => {
    const mgr = makeManager(makePlayer());
    const bad = await mgr.executeGm("nope", []);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(400);
      expect(bad.reason).toContain("nope");
    }
    const noSession = await mgr.executeGm("add_coin", [5]);
    expect(noSession).toEqual({ ok: false, reason: "no-active-battle", status: 409 });
  });

  it("经济/桌面/回合指令写入本局态并可查询", async () => {
    const mgr = makeManager(makePlayer());
    await startBattle(mgr);
    await mgr.executeGm("add_coin", [5]);
    await mgr.executeGm("set_hp", [77]);
    await mgr.executeGm("set_shop_lv", [4]);
    await mgr.executeGm("skip_round", []);
    await mgr.executeGm("grant_char", ["chess_char_1_01_a"]);
    await mgr.executeGm("grant_item", ["chess_item_1_01_e_a"]);
    await mgr.executeGm("reroll_boss", []);
    const state = await mgr.executeGm("state", []);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    const view = state.data.state;
    expect(view?.coin).toBe(15);
    expect(view?.hp).toBe(77);
    expect(view?.shopLv).toBe(4);
    expect(view?.curRound).toBe(2);
    expect(view?.table.chars).toEqual(["chess_char_1_01_a"]);
    expect(view?.table.items).toEqual(["chess_item_1_01_e_a"]);
    expect(["boss_1", "boss_2"]).toContain(view?.bossId);
  });

  it("pause/resume：冻结期间 endTs 不变，恢复后顺延冻结时长", async () => {
    const mgr = makeManager(makePlayer());
    await startBattle(mgr);
    const before = await mgr.executeGm("state", []);
    const endTs = before.ok ? (before.data.state?.endTs ?? 0) : 0;
    const paused = await mgr.executeGm("pause", []);
    expect(paused.ok).toBe(true);
    expect(await mgr.executeGm("pause", [])).toEqual({
      ok: false,
      reason: "already-paused",
      status: 409,
    });
    const mid = await mgr.executeGm("state", []);
    expect(mid.ok && mid.data.state?.endTs).toBe(endTs);
    const resumed = await mgr.executeGm("resume", []);
    expect(resumed.ok).toBe(true);
    expect(await mgr.executeGm("resume", [])).toEqual({
      ok: false,
      reason: "not-paused",
      status: 409,
    });
  });

  it("force_settle win 走官方结算（模式完成计数 +1）且会话结束；lose 仅清场", async () => {
    const player = makePlayer();
    const mgr = makeManager(player);
    await startBattle(mgr);
    const win = await mgr.executeGm("force_settle", ["win"]);
    expect(win.ok).toBe(true);
    const user = player._playerdata.activity.AUTOCHESS_SEASON?.act2autochess;
    expect(user?.mode.mode_single_normal?.completeCnt).toBe(1);
    const afterWin = await mgr.executeGm("state", []);
    expect(afterWin.ok).toBe(true);
    if (afterWin.ok) expect(afterWin.data.active).toBe(false);
    // 第二局：强制失败不发奖、仅清场
    await startBattle(mgr);
    const lose = await mgr.executeGm("force_settle", ["lose"]);
    expect(lose.ok).toBe(true);
    if (lose.ok) expect(lose.data.settle).toBeNull();
  });
});

/* ---------- GmService 域操作 ---------- */

function attachPlayer(pd: TestPlayer): void {
  // 替身玩家没有组合根模块 getter：自走棋 GM 用例需要真实 manager
  const player = pd as TestPlayer & { autoChess?: AutoChessManager };
  player.autoChess = player.autoChess ?? new AutoChessManager(asPlayerManager(pd), pd._trigger);
  (accountManagerMock.data as Record<string, TestPlayer>)["1"] = pd;
  accountManagerMock.getPlayerData.mockResolvedValue(pd);
}

describe("GmService 域操作", () => {
  it("doctor_level 越界拒绝、合法值写入 status.level", async () => {
    const pd = makePlayer();
    attachPlayer(pd);
    await expect(gmService.doctorLevel({ player_id: "1", level: 0 })).rejects.toBeInstanceOf(GmOpError);
    const res = await gmService.doctorLevel({ player_id: "1", level: 88 });
    expect(res.data.level).toBe(88);
    expect(pd._playerdata.status.level).toBe(88);
  });

  it("item_clear 单项删除与整仓清空（保留 consumable 之外的分区）", async () => {
    const pd = makePlayer();
    pd._playerdata.inventory = { "3001": 5, "3002": 7 };
    pd._playerdata.consumable = { "2001": { "0": { ts: -1, count: 3 } } };
    attachPlayer(pd);
    const one = await gmService.itemClear({ player_id: "1", item_id: "3001" });
    expect(one.data.cleared).toBe(1);
    expect(pd._playerdata.inventory["3001"]).toBeUndefined();
    const all = await gmService.itemClear({ player_id: "1" });
    expect(pd._playerdata.inventory["3002"]).toBe(0);
    expect(Object.keys(pd._playerdata.consumable)).toEqual([]);
    await expect(gmService.itemClear({ player_id: "1", item_id: "nope" })).rejects.toBeInstanceOf(
      GmOpError,
    );
  });

  it("reset_key 白名单外的键报 400", async () => {
    attachPlayer(makePlayer());
    await expect(gmService.resetKey({ player_id: "1", key: "nope" })).rejects.toBeInstanceOf(
      GmOpError,
    );
  });

  it("autochess_gm 透传 code/params 并把失败 reason 映射为 GmOpError(409)", async () => {
    const pd = makePlayer();
    attachPlayer(pd);
    const state = await gmService.autochessGm({ uid: "1", code: "state" });
    expect(state.data.active).toBe(false);
    await expect(gmService.autochessGm({ uid: "1", code: "add_coin", params: [1] })).rejects.toMatchObject(
      { status: 409 },
    );
  });

  it("服务间接口：battle_active 登记后 player_card 回填 sceneId/curRound", async () => {
    const pd = makePlayer();
    pd._playerdata.status.nickName = "测试博士";
    attachPlayer(pd);
    await gmService.autochessBattleActive({ uid: "1", sceneId: "scene_9", curRound: 3 });
    const card = await gmService.autochessPlayerCard({ uid: "1" });
    expect(card.data.sceneId).toBe("scene_9");
    expect(card.data.curRound).toBe(3);
    expect(card.data.nickname).toBe("测试博士");
  });

  it("char_max_all / stage_unlock_all 委托 AdminService", async () => {
    attachPlayer(makePlayer());
    const chars = await gmService.charMaxAll({ player_id: "1" });
    expect(chars.data.chars).toBe(3);
    const stages = await gmService.stageUnlockAll({ player_id: "1" });
    expect(stages.data.stages).toBe(5);
  });
});

/* ---------- 引导数据 ---------- */

describe("buildGmData", () => {
  it("返回面板所需的全部字段", async () => {
    const data = await buildGmData();
    for (const key of [
      "activities",
      "full_activities",
      "crisis_seasons",
      "tower_seasons",
      "items",
      "chars",
      "autochess",
      "sandbox",
      "rlv",
      "reset_keys",
      "gm_state",
      "limits",
    ] as const) {
      expect(data).toHaveProperty(key);
    }
    expect(data.limits.doctor_level).toEqual({ min: 1, max: 120 });
    expect(data.reset_keys.length).toBeGreaterThan(0);
    expect(data.crisis_seasons.map((s) => s.id)).toEqual(["cc2"]);
  });
});

/* ---------- 干员可选参数 ---------- */

describe("GmService.charOptions", () => {
  it("返回阶段/技能槽/模组选项；未知干员报 404", () => {
    type MockCharData = {
      profession?: string;
      phases?: { maxLevel?: number }[];
      skills?: { skillId?: string }[];
    };
    type MockEquipData = { uniEquipId?: string; uniEquipName?: string; typeName1?: string };
    const catalog = excelMock as {
      charData: (id: string) => MockCharData | undefined;
      UniequipTable: { equipDict: Record<string, MockEquipData>; charEquip: Record<string, string[]> };
    };
    const originalCharData = catalog.charData;
    catalog.charData = (id: string) =>
      id === "char_002_amiya"
        ? {
            profession: "CASTER",
            phases: [{ maxLevel: 50 }, { maxLevel: 70 }, { maxLevel: 80 }],
            skills: [{ skillId: "skchr_amiya_2" }, { skillId: "skchr_amiya_3" }],
          }
        : undefined;
    catalog.UniequipTable.charEquip = { char_002_amiya: ["uniequip_002_amiya"] };
    catalog.UniequipTable.equipDict = {
      uniequip_002_amiya: { uniEquipId: "uniequip_002_amiya", uniEquipName: "DWDB-221E", typeName1: "CCR" },
    };
    try {
      const options = gmService.charOptions("char_002_amiya");
      expect(options.phases.map((p) => p.maxLevel)).toEqual([50, 70, 80]);
      expect(options.skills.map((s) => s.index)).toEqual([0, 1]);
      expect(options.equips).toEqual([
        { id: "uniequip_002_amiya", name: "DWDB-221E", typeName: "CCR", maxLevel: 3 },
      ]);
      expect(() => gmService.charOptions("char_nope")).toThrow(GmOpError);
    } finally {
      catalog.charData = originalCharData as typeof catalog.charData;
    }
  });
});

/* ---------- UI 契约完整性 ---------- */

describe("GM 面板 UI 契约完整性", () => {
  const PANEL_DIR = path.join(__dirname, "../../../app/ops/admin/gm/panel");
  /** 面板负责调用的 25 个操作（其余 3 个为会话服 → 主服的服务间接口，不由面板调用） */
  const PANEL_OPS = [
    "activity_clock", "activity_switch", "crisis_season", "tower_season", "asset_patch",
    "doctor_level", "char", "char_max", "char_max_all", "char_grant_all", "skin_grant_all",
    "furni_grant_all", "shop_currency_grant", "stage_unlock_all", "item_clear", "mail_grant",
    "rlv2/difficulty", "rlv2/relic_layer", "rlv2/char_buff", "sandbox/season", "sandbox/enemy_rush",
    "reset_key", "reset_all", "reset_db", "autochess_gm",
  ];
  /** 服务间接口（面板不得直接调用） */
  const SERVER_TO_SERVER = ["autochess_battle_active", "autochess_battle_settled", "autochess_player_card"];
  /** 面板页面（与 index.html 的 data-page 对齐） */
  const PAGES = ["char", "growth", "item", "rlv2", "sandbox", "season", "reset", "autochess"];

  const sources = () =>
    collectFiles(PANEL_DIR)
      .map((file) => readSource(file))
      .join("\n");

  it("面板脚本覆盖全部 25 个操作端点", () => {
    const source = sources();
    const missing = PANEL_OPS.filter((op) => !source.includes(`"${op}"`));
    expect(missing).toEqual([]);
  });

  it("面板不直接调用服务间接口", () => {
    const source = sources();
    const leaked = SERVER_TO_SERVER.filter((op) => source.includes(`"${op}"`));
    expect(leaked).toEqual([]);
  });

  it("index.html 的 8 个分区与页面控制器一一对应", () => {
    const html = readSource(path.join(PANEL_DIR, "index.html"));
    const pagesJs = readSource(path.join(PANEL_DIR, "js", "pages.js"));
    for (const page of PAGES) {
      expect(html).toContain(`data-page="${page}"`);
      expect(pagesJs).toMatch(new RegExp(`(?:\\b${page}:\\s*|const\\s+${page}\\s*=\\s*)\\{`));
    }
  });

  it("index.html 按顺序加载全部面板脚本", () => {
    const html = readSource(path.join(PANEL_DIR, "index.html"));
    for (const script of ["js/core.js", "js/components.js", "js/pages.js", "js/app.js"]) {
      expect(html).toContain(`src="${script}"`);
    }
  });
});

/* ---------- 路由级（最小 express 夹具，不依赖主数据层） ---------- */

describe("GM 路由（/gm 静态与引导 + /admin 操作）", () => {
  /** 起一个只挂 GM 路由的临时 express 服务 */
  async function withServer(run: (base: string) => Promise<void>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use("/gm", gmRouter);
    app.use("/admin", gmOpsRouter);
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("面板首页与静态脚本可访问", async () => {
    await withServer(async (base) => {
      const page = await fetch(`${base}/gm/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      const html = await page.text();
      expect(html).toContain('data-page="autochess"');
      expect(html).toContain('src="js/app.js"');

      for (const asset of ["gm.css", "js/core.js", "js/components.js", "js/pages.js", "js/app.js"]) {
        const res = await fetch(`${base}/gm/${asset}`);
        expect(res.status, asset).toBe(200);
      }
    });
  });

  it("/gm/state 返回全局状态与账号列表；/gm/char 返回干员选项且未知干员 404", async () => {
    const catalog = excelMock as {
      charData: (id: string) => { profession?: string; phases?: { maxLevel?: number }[]; skills?: { skillId?: string }[] } | undefined;
    };
    const original = catalog.charData;
    catalog.charData = (id) => (id === "char_002_amiya" ? { profession: "CASTER", phases: [{ maxLevel: 50 }], skills: [] } : undefined);
    try {
      await withServer(async (base) => {
        const state = await fetch(`${base}/gm/state`);
        expect(state.status).toBe(200);
        const stateBody = (await state.json()) as { players: string[]; current: string; gm_state: { asset_patch: boolean } };
        expect(stateBody.players).toEqual(["1", "2222"]);
        expect(typeof stateBody.gm_state.asset_patch).toBe("boolean");

        const ok = await fetch(`${base}/gm/char?id=char_002_amiya`);
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { name: string; phases: { maxLevel: number }[] };
        expect(body.name).toBe("char_002_amiya");
        expect(body.phases[0].maxLevel).toBe(50);

        const missing = await fetch(`${base}/gm/char?id=char_nope`);
        expect(missing.status).toBe(404);
      });
    } finally {
      catalog.charData = original as typeof catalog.charData;
    }
  });

  it("操作端点：无令牌 401、令牌有效但参数非法 400", async () => {
    await withServer(async (base) => {
      const unauthorized = await fetch(`${base}/admin/doctor_level`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_id: "1", level: 10 }),
      });
      expect(unauthorized.status).toBe(401);

      const invalid = await fetch(`${base}/admin/doctor_level`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Admin-Token": "t" },
        body: JSON.stringify({ player_id: "1", level: 999 }),
      });
      expect(invalid.status).toBe(400);
      const invalidBody = (await invalid.json()) as { ok: boolean; detail: string };
      expect(invalidBody.ok).toBe(false);
      expect(invalidBody.detail).toContain("1..120");
    });
  });
});
