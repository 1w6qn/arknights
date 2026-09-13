import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  routes,
  crisisV2Rewrite,
  sandboxPermRewrite,
} from "../../../app/game/routes";

/**
 * 集中路由注册表（RE-4）
 *
 * 断言声明式路由表把每个客户端关键前缀解析到意图 router 模块、根级 rootRouter 挂载、
 * 以及内联 URL 重写函数（crisisV2 / sandboxPerm）的重写行为。
 */

/** URL 重写函数的请求窄视图（只读取/重写 url） */
interface RewriteReq {
  url: string;
}

/** 以窄视图调用内联 URL 重写函数（真实 Request 可赋给该视图；重写函数不读 res） */
function runRewrite(
  rewrite: (req: Request, res: Response, next: NextFunction) => void,
  req: RewriteReq,
  next: () => void,
): void {
  rewrite(req as Request, {} as Response, next);
}

/** 客户端关键单前缀 → 意图 router 模块（默认导出） */
const expectedPrefixes: Array<[string, string]> = [
  ["/businessCard", "./modules/businessCard/routes"],
  ["/account", "./modules/account/routes"],
  ["/charBuild", "./modules/character/routes"],
  ["/building", "./modules/building/handler"],
  ["/quest", "./modules/quest/routes"],
  ["/user", "./modules/user/routes"],
  ["/activity", "./modules/activities"],
  ["/storyreview", "./modules/storyreview/routes"],
  ["/mission", "./modules/mission/handler"],
  ["/shop", "./modules/shop/handler"],
  ["/rlv2", "./modules/roguelike/handler"],
  ["/gacha", "./modules/gacha/handler"],
  ["/mail", "./modules/mail/routes"],
  ["/social", "./modules/social/routes"],
  ["/retro", "./modules/retro/routes"],
  ["/aprilFool", "./modules/aprilFool/routes"],
  ["/crisis", "./modules/crisis/routes"],
  ["/deepsea", "./modules/deepsea/routes"],
  ["/siracusaMap", "./modules/siracusaMap/routes"],
  ["/explore", "./modules/explore/routes"],
  ["/tower", "./modules/tower/routes"],
  ["/charm", "./modules/charm/routes"],
  ["/charRotation", "./modules/character/charRotation.routes"],
  ["/depot", "./modules/depot/routes"],
  ["/sandbox", "./modules/sandbox/routes"],
  ["/templateShop", "./modules/templateShop/routes"],
  ["/mailCollection", "./modules/mail/mailCollection.routes"],
  ["/multiplayer", "./modules/multiplayer/routes"],
  ["/roguelike", "./modules/roguelike/routes"],
  ["/campaignV2", "./modules/campaignV2/routes"],
  ["/vecbreak", "./modules/vecbreak/routes"],
  ["/interlock", "./modules/interlock/routes"],
  ["/autochess", "./modules/autochess/routes"],
  ["/pay", "./modules/pay/routes"],
  ["/plugin", "./modules/system/plugin-heartbeat"],
  ["/rune", "./modules/rune/routes"],
  ["/audit", "./modules/system/routes"],
  ["/arkodc", "./modules/arkodc/routes"],
  ["/", "./modules/home/routes"],
  // 由 home/routes.ts 按 URL 域拆出的独立模块（客户端调用不带模块前缀，故根挂载）
  ["/", "./modules/char/routes"],
  ["/", "./modules/troop/routes"],
  ["/", "./modules/story/routes"],
  ["/", "./modules/batchEvent/routes"],
  ["/", "./modules/firework/routes"],
  ["/", "./modules/car/routes"],
  ["/", "./modules/templateTrap/routes"],
  ["/", "./modules/misc-alignment/routes"],
];

describe("集中路由注册表 routes", () => {
  it("每个客户端关键前缀解析到意图 router 模块", () => {
    for (const [prefix, module] of expectedPrefixes) {
      expect(
        routes.some((r) => r.prefix === prefix && r.module === module),
        `${prefix} 应注册到 ${module}`,
      ).toBe(true);
    }
  });

  it("user/activity 根级路由通过 rootRouter 挂载到根路径", () => {
    expect(
      routes.some(
        (r) => r.prefix === "/" && r.module === "./modules/user/routes" && r.exportName === "rootRouter",
      ),
    ).toBe(true);
    expect(
      routes.some(
        (r) =>
          r.prefix === "/" && r.module === "./modules/activities" && r.exportName === "rootRouter",
      ),
    ).toBe(true);
  });

  it("/activity 前缀别名覆盖 roguelike/interlock/vecbreak/multiplayer", () => {
    for (const module of [
      "./modules/roguelike/routes",
      "./modules/interlock/routes",
      "./modules/vecbreak/routes",
      "./modules/multiplayer/routes",
    ]) {
      expect(
        routes.some((r) => r.prefix === "/activity" && r.module === module),
        `/activity 别名应包含 ${module}`,
      ).toBe(true);
    }
  });

  it("根挂载别名（multiplayer/campaignV2/retro/vecbreak）对齐客户端单前缀", () => {
    for (const module of [
      "./modules/multiplayer/routes",
      "./modules/campaignV2/routes",
      "./modules/retro/routes",
      "./modules/vecbreak/routes",
    ]) {
      expect(
        routes.some((r) => r.prefix === "/" && r.module === module),
        `根路径应包含 ${module}`,
      ).toBe(true);
    }
  });

  it("crisisV2 挂载带重写函数且指向 crisis router", () => {
    expect(
      routes.some(
        (r) =>
          r.prefix === "/crisisV2" &&
          r.module === "./modules/crisis/routes" &&
          r.rewrite === crisisV2Rewrite,
      ),
    ).toBe(true);
  });

  it("sandboxPerm 挂载带重写函数且指向 sandbox router", () => {
    expect(
      routes.some(
        (r) =>
          r.prefix === "/sandboxPerm" &&
          r.module === "./modules/sandbox/routes" &&
          r.rewrite === sandboxPermRewrite,
      ),
    ).toBe(true);
  });

  it("crisisV2Rewrite 将去前缀后的 url 前补 /v2", () => {
    const req: RewriteReq = { url: "/battleStart" };
    const next = vi.fn();
    runRewrite(crisisV2Rewrite, req, next);
    expect(req.url).toBe("/v2/battleStart");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("sandboxPermRewrite 映射 /sandboxV2|V3 段并保留其余路径", () => {
    const v2: RewriteReq = { url: "/sandboxV2/foo/bar" };
    const n2 = vi.fn();
    runRewrite(sandboxPermRewrite, v2, n2);
    expect(v2.url).toBe("/v2/foo/bar");
    expect(n2).toHaveBeenCalledTimes(1);

    const v3: RewriteReq = { url: "/sandboxV3/baz" };
    const n3 = vi.fn();
    runRewrite(sandboxPermRewrite, v3, n3);
    expect(v3.url).toBe("/v3/baz");
    expect(n3).toHaveBeenCalledTimes(1);

    const other: RewriteReq = { url: "/changeTopic" };
    const no = vi.fn();
    runRewrite(sandboxPermRewrite, other, no);
    expect(other.url).toBe("/changeTopic");
    expect(no).toHaveBeenCalledTimes(1);
  });

  it("路由表顺序保持：根级挂载与别名别名的匹配优先级（misc-alignment 根级对齐位于末尾）", () => {
    const rootEntries = routes
      .map((r, i) => ({ ...r, index: i }))
      .filter((r) => r.prefix === "/");
    // 首个根级挂载为 home 兜底
    expect(rootEntries[0].module).toBe("./modules/home/routes");
    // 末个根级挂载为 misc-alignment 全量对齐
    expect(rootEntries[rootEntries.length - 1].module).toBe("./modules/misc-alignment/routes");
  });
});