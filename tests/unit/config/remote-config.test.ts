import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { Request, Response } from "express";

import {
  buildNetworkConfig,
  buildNetworkConfigContent,
  buildRemoteConfig,
  remoteConfigRouter,
} from "@core/config/remote-config";

/** 路由测试响应视图：只声明本文件读到的四个方法 */
interface MockRes {
  send: Response["send"];
  status: Response["status"];
  sendStatus: Response["sendStatus"];
  json: Response["json"];
}

/** 路由测试请求视图：remote-config 只读 method/url/params */
interface MockReq {
  method: Request["method"];
  url: Request["url"];
  params: Request["params"];
}

function mockRes(): MockRes {
  return {
    send: vi.fn<Response["send"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
    sendStatus: vi.fn<Response["sendStatus"]>(),
    json: vi.fn<Response["json"]>(),
  };
}

async function call(url: string, res: MockRes) {
  const req: MockReq = {
    method: "GET",
    url,
    params: { version: "1", platform: "Windows" },
  };
  remoteConfigRouter(req as Request, res as Response, () => {});
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

describe("buildNetworkConfigContent", () => {
  it("应替换 {server} 占位符为 Host:PORT", () => {
    const content = buildNetworkConfigContent();
    const parsed = JSON.parse(content);
    // funcVer 不再随意跟随官服：它必须等于客户端 Lua 的 CUR_FUNC_VER（见下一个用例的守卫）
    const funcVer = parsed.funcVer;
    expect(parsed.configs[funcVer]).toBeDefined();
    expect(parsed.configs[funcVer].network.gs).toMatch(/^http/);
    expect(parsed.configs[funcVer].network.gs).not.toContain("{server}");
  });
});

describe("funcVer 与客户端 Lua 版本一致性（守卫）", () => {
  /**
   * `entry.lua` 顶层做 `CS.Torappu.VersionCompat.CUR_FUNC_VER ~= GlobalConfig.CUR_FUNC_VER` 判断，
   * 不等则 `EntryTable.Init` 变空实现并 `return`（chunk 提前结束）——整套 Lua 初始化（含
   * `HotfixProcesser.Do` 插件加载）失效。客户端从 `/official/network_config` 的 `funcVer` 取值，
   * 故私服下发的 funcVer 必须与客户端 Lua 的 `CUR_FUNC_VER` 逐字符相同。
   *
   * 实测 2026-09-14：官服**未签名**请求返回 V070，而 2.7.71 客户端 Lua 要 V077（该请求下的旧档位）。
   */
  it("network_config 下发的 funcVer 必须等于客户端 GlobalConfig.CUR_FUNC_VER", () => {
    const cfgPath = join(__dirname, "..", "..", "..", "data", "[uc]lua", "GlobalConfig.lua");
    if (!existsSync(cfgPath)) {
      // 明文参考目录为 gitignore（由提取/重打包流程生成），缺失时无法比对
      console.warn(`[skip] 客户端 Lua 明文参考缺失，跳过 funcVer 守卫: ${cfgPath}`);
      return;
    }
    const expected = /CUR_FUNC_VER\s*=\s*"([^"]+)"/.exec(readFileSync(cfgPath, "utf8"))?.[1];
    expect(expected, `${cfgPath} 未解析出 CUR_FUNC_VER`).toBeTruthy();
    if (expected === undefined) return; // 显式收窄（TS 不认 expect 的断言）
    const parsed = JSON.parse(buildNetworkConfigContent());
    expect(parsed.funcVer).toBe(expected);
    // 档位键必须同步改名，否则客户端按 configs[funcVer] 取不到网络档
    expect(parsed.configs[expected]).toBeDefined();
  });
});

describe("buildNetworkConfig（官方格式）", () => {
  it("应返回官方扁平格式网络端点（an/as/gs/hu/u8 等）", () => {
    const cfg = buildNetworkConfig();
    expect(cfg.configVer).toBeDefined();
    expect(cfg.gs).toMatch(/^http/);
    // auth 路由已挂根路径：as 域保持原路径（裸服务器地址，无 /auth 前缀）
    expect(cfg.as).toMatch(/^http/);
    expect(cfg.as).not.toContain("/auth");
    expect(cfg.hu).toContain("/assetbundle");
    // 内部字段不暴露
    expect(cfg.secure).toBeUndefined();
  });

  it("hv 应保留 {0} 占位符（客户端自行替换为版本/平台）", () => {
    const cfg = buildNetworkConfig();
    expect(String(cfg.hv)).toContain("{0}");
    expect(String(cfg.hv)).toContain("/config/prod/official/");
    expect(String(cfg.hv)).toMatch(/^http/);
  });
});

describe("buildRemoteConfig（功能配置）", () => {
  it("应返回官方默认功能开关", () => {
    const cfg = buildRemoteConfig();
    expect(cfg.fapv2).toBe(1);
    expect(cfg.HGDownload_1).toBe(10000);
    expect(cfg.HGDownload_2).toBe(10000);
    expect(cfg.enableGameBI).toBe(true);
    expect(cfg.enableNativeLicense).toBe(true);
  });
});

describe("remoteConfigRouter", () => {
  it("network_config 应返回官方格式网络配置", async () => {
    const res = mockRes();
    await call("/1/prod/default/Windows/network_config", res);
    const arg = vi.mocked(res.send).mock.calls[0][0];
    expect(arg.gs).toMatch(/^http/);
    expect(arg.configVer).toBeDefined();
  });

  it("remote_config 应返回空对象（2026-08-08 起路由固定返回 {}，buildRemoteConfig 函数保留）", async () => {
    const res = mockRes();
    await call("/1/prod/default/Windows/remote_config", res);
    const arg = vi.mocked(res.send).mock.calls[0][0];
    expect(arg).toEqual({});
    // 否定旧行为：不再返回默认功能开关（防回归）
    expect(arg.fapv2).toBeUndefined();
  });
});
