import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "path";
import { crc32 } from "crc";
import { writeFile } from "fs/promises";
import type { Request, Response } from "express";

/** 下发清单条目的测试视图（只声明断言用到的字段，避免 `unknown` 逃逸） */
interface ServedAbInfo {
  name: string;
  hash: string;
  md5: string;
  totalSize: number;
  abSize: number;
  cid?: number;
  cat?: number;
  meta?: number;
}

/** excel 行夹具视图（本文件不提供的表也要显式占位，否则门面方法的 `this.XxxTable` 报 TS2339/TS7023） */
interface ExcelRowMock { name?: string }

/** 配置替身视图：excel 门面方法 + 本文件读取的配置字段 */
interface ExcelMockConfig {
  // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
  getItem(id: string): ExcelRowMock | undefined;
  itemName(id: string): string;
  makeItem(id: string, count: number, type?: string): { id: string; count: number; type?: string };
  charData(charId: string): ExcelRowMock | undefined;
  stageData(stageId: string): ExcelRowMock | undefined;
  ItemTable: { items?: Record<string, ExcelRowMock> } | undefined;
  CharacterTable: Record<string, ExcelRowMock> | undefined;
  StageTable: { stages?: Record<string, ExcelRowMock> } | undefined;
  Host: string;
  PORT: number;
  version: {
    resVersion: string;
    clientVersion: string;
  };
  assets: {
    enableMods: boolean;
    downloadLocally: boolean;
    autoUpdate: boolean;
    downloadPeoxy: boolean;
  };
  NetworkConfig: Record<string, string>;
}

const mockConfig = vi.hoisted((): ExcelMockConfig => ({
  // —— excel 门面方法（与 excel.ts 实现一致，操作 mock 数据）——
  getItem(id: string) { return this.ItemTable?.items?.[id]; },
  itemName(id: string): string { return this.getItem(id)?.name ?? id; },
  makeItem(id: string, count: number, type?: string) { return type ? { id, count, type } : { id, count }; },
  charData(charId: string) { return this.CharacterTable?.[charId]; },
  stageData(stageId: string) { return this.StageTable?.stages?.[stageId]; },
  ItemTable: undefined,
  CharacterTable: undefined,
  StageTable: undefined,
  Host: "http://127.0.0.1",
  PORT: 8443,
  version: {
    resVersion: "26-08-07-14-53-29_30b8f0",
    clientVersion: "2.7.61",
  },
  assets: {
    enableMods: true,
    downloadLocally: false,
    autoUpdate: true,
    downloadPeoxy: false,
  },
  NetworkConfig: {},
}));

/**
 * fs/promises 替身（精确重载）
 *
 * `vi.mocked(readdir)` 会落到 `readdir(path, { withFileTypes: true })` 这个**最后重载**
 * （返回 `Dirent[]`），而被测代码走的是无 options 重载（返回 `string[]`）——故不借用
 * `vi.mocked`，改为本地持有一组精确签名的 mock，并在模块工厂里原样安装（同一函数对象）。
 */
const fsMock = vi.hoisted(() => ({
  readdir: vi.fn<(path: string) => Promise<string[]>>(),
  readFile: vi.fn<(path: string) => Promise<Buffer | string | undefined>>(),
  stat: vi.fn<(path: string) => Promise<{ mtimeMs: number; size: number }>>(),
}));

vi.mock("@utils/file", () => ({
  readJsonSync: vi.fn(() => mockConfig),
  exists: vi.fn(),
  size: vi.fn(),
}));

vi.mock("axios", () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { abInfos: [] } }) },
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readdir: fsMock.readdir,
    readFile: fsMock.readFile,
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: fsMock.stat,
  };
});

// 损坏 zip 场景：openZipFile 拒绝（yauzl.open 报错）→ loadMods 逐文件跳过
vi.mock("yauzl", () => ({
  default: {
    open: vi.fn(
      (
        _path: string,
        _opts: unknown,
        cb: (err: Error | null) => void,
      ) => cb(new Error("mock: invalid zip")),
    ),
  },
  ZipFile: class {},
}));

import assetRouter from "@ops/assets/asset";
import { getModsList, getModVersionSuffix, refreshModsIfChanged, nextModBaseCid } from "@ops/assets/asset";
import { exists, size } from "@utils/file";

/** asset.ts 的 mods 目录（app/.. / mods = 项目根 / mods） */
const modsDir = join(__dirname, "..", "..", "mods");
/** 平台专属子目录（本组测试走 Android 平台） */
const androidModsDir = join(modsDir, "android");

/** 判断路径是否为平台专属子目录（用于 readdir mock 区分：平台目录视为不存在 → 走共享根目录） */
function isPlatformSubdir(p: string): boolean {
  return p.replace(/\\/g, "/").endsWith("/android");
}

/** asset 路由的测试请求视图：只声明被测分支读到的三个成员（真实 express Request 可赋给它） */
interface MockReq {
  method: string;
  url: string;
  params: Record<string, string>;
}

/** asset 路由的测试响应视图：只声明被测分支调用的五个方法（真实 express Response 可赋给它） */
interface MockRes {
  sendFile: Response["sendFile"];
  redirect: Response["redirect"];
  send: Response["send"];
  status: Response["status"];
  setHeader: Response["setHeader"];
}

type RouterReq = Parameters<typeof assetRouter>[0];

function manifestReq(): MockReq {
  return {
    method: "GET",
    url: "/official/Android/assets/26-08-07-14-53-29_30b8f0/hot_update_list.json",
    params: {
      platform: "Android",
      assetsHash: "26-08-07-14-53-29_30b8f0",
      fileName: "hot_update_list.json",
    },
  };
}

function mockRes(): MockRes {
  return {
    sendFile: vi.fn(),
    redirect: vi.fn(),
    send: vi.fn(),
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  };
}

/** 以窄替身调用 asset 路由（`req`/`res` 单向断言，见 {@link MockReq}/{@link MockRes}） */
async function callRouter(req: MockReq, res: MockRes): Promise<void> {
  await assetRouter(req as RouterReq, res as Response, () => {});
}

describe("asset mod（enableMods=true）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.assets.enableMods = true;
  });

  it("mods 目录缺失时清单请求不 500，mod 列表为空", async () => {
    fsMock.readdir.mockRejectedValue(new Error("ENOENT"));
    vi.mocked(exists).mockResolvedValue(false);

    const res = mockRes();
    await callRouter(manifestReq(), res);
    await new Promise((r) => setTimeout(r, 30));

    expect(res.sendFile).toHaveBeenCalled();
    expect(getModsList("Android").mods).toHaveLength(0);
    expect(getModVersionSuffix("Android")).toBe("");
  });

  it("损坏的 .dat（zip 解析失败）自动跳过，清单请求正常返回", async () => {
    fsMock.readdir.mockResolvedValue(["bad.dat"]);
    fsMock.readFile.mockResolvedValue(Buffer.from("not a zip"));
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(size).mockResolvedValue(16);

    const res = mockRes();
    await callRouter(manifestReq(), res);
    await new Promise((r) => setTimeout(r, 30));

    expect(res.sendFile).toHaveBeenCalled();
    expect(getModsList("Android").mods).toHaveLength(0);
  });

  it("相对路径缓存命中时复用，并按 mods 目录解析绝对路径；resVersion 后缀稳定", async () => {
    const mods = ["a.dat", "b.dat"];
    const dat1 = Buffer.alloc(10);
    const dat2 = Buffer.alloc(11);
    // 平台专属目录不存在（readdir ENOENT）→ 仅共享根目录有 mod
    fsMock.readdir.mockImplementation(async (d: string) => {
      if (isPlatformSubdir(String(d))) throw new Error("ENOENT");
      return mods;
    });
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("mods.Android.json")) {
        return JSON.stringify({
          file: {
            [join(modsDir, "a.dat")]: { size: 10, crc32: crc32(dat1) },
            [join(modsDir, "b.dat")]: { size: 11, crc32: crc32(dat2) },
          },
          mod: {
            mods: [
              { name: "activity/test.ab", hash: "h1", md5: "h1", totalSize: 10, abSize: 10 },
              { name: "scenes/x.ab", hash: "h2", md5: "h2", totalSize: 11, abSize: 11 },
            ],
            name: ["activity/test.ab", "scenes/x.ab"],
            path: ["a.dat", "b.dat"],
            download: ["activity_test.dat", "scenes_x.dat"],
          },
        });
      }
      if (String(p).endsWith("a.dat")) return dat1;
      if (String(p).endsWith("b.dat")) return dat2;
      return undefined;
    });
    // 仅平台缓存文件存在；资产版本目录视为不存在（走 axios 下载分支）
    vi.mocked(exists).mockImplementation(async (p: string) =>
      String(p).endsWith("mods.Android.json"),
    );
    vi.mocked(size).mockResolvedValue(10);

    const res = mockRes();
    await callRouter(manifestReq(), res);
    await new Promise((r) => setTimeout(r, 30));

    expect(res.sendFile).toHaveBeenCalled();
    expect(getModsList("Android").mods).toHaveLength(2);
    // 相对文件名已按当前 mods 目录解析为绝对路径
    expect(getModsList("Android").path[0]).toBe(join(modsDir, "a.dat"));
    expect(getModsList("Android").path[1]).toBe(join(modsDir, "b.dat"));
    expect(getModsList("Android").download).toEqual(["activity_test.dat", "scenes_x.dat"]);

    // 确定性后缀：非空且同 mod 集再次请求保持一致
    const s1 = getModVersionSuffix("Android");
    expect(s1).not.toBe("");
    await callRouter(manifestReq(), res);
    await new Promise((r) => setTimeout(r, 30));
    expect(getModVersionSuffix("Android")).toBe(s1);
  });

  it("旧格式绝对路径缓存判失效（不命中）", async () => {
    fsMock.readdir.mockResolvedValue(["a.dat"]);
    fsMock.readFile.mockImplementation(async (p: string) => {
      if (String(p).endsWith("mods.Android.json")) {
        return JSON.stringify({
          file: { [join(modsDir, "a.dat")]: { size: 10, crc32: 0 } },
          // 旧格式：path 为绝对路径（含盘符/分隔符）→ 应判失效
          mod: {
            mods: [],
            name: [],
            path: ["D:\\develop\\test\\mods\\a.dat"],
            download: [],
          },
        });
      }
      return Buffer.from("not a zip");
    });
    vi.mocked(exists).mockImplementation(async (p: string) =>
      String(p).endsWith("mods.Android.json"),
    );
    vi.mocked(size).mockResolvedValue(10);

    const res = mockRes();
    await callRouter(manifestReq(), res);
    await new Promise((r) => setTimeout(r, 30));

    // 缓存指纹不匹配 → 走 zip 解析（yauzl mock 失败）→ 空列表（而非使用旧路径缓存）
    expect(getModsList("Android").mods).toHaveLength(0);
  });

  it("nextModBaseCid：mod cid 越过 abInfos 与 packInfos 的最大值（防撞号回归）", () => {
    // 官方实测：abInfos cid 1..14981，packInfos cid 14982..15062
    const abInfos = Array.from({ length: 14981 }, (_, i) => ({ cid: i + 1 }));
    const packInfos = Array.from({ length: 81 }, (_, i) => ({ cid: 14982 + i }));
    expect(nextModBaseCid(abInfos, packInfos)).toBe(15063);
    // packInfos 缺省时退化为 abInfos 之后
    expect(nextModBaseCid(abInfos, [])).toBe(14982);
    // 空清单
    expect(nextModBaseCid([], [])).toBe(1);
  });

  it("平台专属目录 mod（mods/windows/）下发返回真实子目录路径（回归：曾被拼接为根路径 404）", async () => {
    fsMock.readdir.mockImplementation(async (d: string) => {
      const p = String(d).replace(/\\/g, "/");
      if (p.endsWith("/mods/windows")) return ["skinpack_char_4064_mlynar.dat"];
      return []; // 根目录无 mod → 平台目录唯一来源
    });
    fsMock.readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith("mods.Windows.json")) {
        return JSON.stringify({
          file: {
            [join(modsDir, "windows", "skinpack_char_4064_mlynar.dat")]: { size: 100, crc32: crc32(Buffer.alloc(100)) },
          },
          mod: {
            mods: [{ name: "skinpack/char_4064_mlynar.ab", hash: "h", md5: "h", totalSize: 100, abSize: 200 }],
            name: ["skinpack/char_4064_mlynar.ab"],
            path: ["windows/skinpack_char_4064_mlynar.dat"],
            download: ["skinpack_char_4064_mlynar.dat"],
          },
        });
      }
      if (s.endsWith("skinpack_char_4064_mlynar.dat")) return Buffer.alloc(100);
      return undefined;
    });
    vi.mocked(exists).mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, "/");
      return (
        s.endsWith("mods.Windows.json") ||
        s.endsWith("mods/windows/skinpack_char_4064_mlynar.dat")
      );
    });
    vi.mocked(size).mockResolvedValue(100);

    const req: MockReq = {
      method: "GET",
      url: "/official/Windows/assets/26-08-07-10-51-39_26e0fc-8ddfbe/skinpack_char_4064_mlynar.dat",
      params: {
        platform: "Windows",
        assetsHash: "26-08-07-10-51-39_26e0fc-8ddfbe",
        fileName: "skinpack_char_4064_mlynar.dat",
      },
    };
    const res = mockRes();
    await callRouter(req, res);
    await new Promise((r) => setTimeout(r, 30));

    // 回归断言：sendFile 必须是 mods/windows/ 下的真实路径（旧代码拼成 mods/ 根 → ENOENT 404）
    expect(res.sendFile).toHaveBeenCalledWith(
      join(modsDir, "windows", "skinpack_char_4064_mlynar.dat"),
    );
    // 且不应误用根目录路径
    expect(res.sendFile).not.toHaveBeenCalledWith(
      join(modsDir, "skinpack_char_4064_mlynar.dat"),
    );
  });

  it("清单注入：mod 覆盖官方同名条目，保留身份字段（cid/cat/meta/hash），只换内容令牌与尺寸", async () => {
    // 官方实测形态（2026-09-14）：匿名 bundle 是独立下载项——meta=1（ABMetaFlag.IGNORE_MD5）、
    // hash==md5==4 位内容令牌、带 cid/cat；主体 bundle 的 hash 是稳定身份键、md5 是 32 位内容 md5。
    const official = {
      versionId: "26-08-07-14-53-29_30b8f0",
      manifestName: "e6d09183218d744a42403a4ed22556e2.idx",
      manifestVersion: "V077",
      abInfos: [
        {
          name: "anon/63bbacd2fab677125a1516d4396114ab.bin",
          hash: "d21c",
          md5: "d21c",
          totalSize: 1112961,
          abSize: 1121653,
          cid: 2457,
          cat: 1,
          meta: 1,
        },
        {
          name: "shaders/other.ab",
          hash: "3a3fec0c5875afee8410d3dba8e002cb",
          md5: "ef1db26aee7f598bd01773179b84e5aa",
          totalSize: 106536,
          abSize: 133308,
          cid: 2,
        },
      ],
      packInfos: [],
    };
    const dat = Buffer.alloc(10);
    fsMock.readdir.mockImplementation(async (d: string) => {
      if (isPlatformSubdir(String(d))) throw new Error("ENOENT");
      return ["anon_63bbacd2fab677125a1516d4396114ab.dat"];
    });
    fsMock.readFile.mockImplementation(async (p: string) => {
      const s = String(p);
      if (s.endsWith("mods.Android.json")) {
        return JSON.stringify({
          file: {
            [join(modsDir, "anon_63bbacd2fab677125a1516d4396114ab.dat")]: {
              size: 10,
              crc32: crc32(dat),
            },
          },
          mod: {
            mods: [
              {
                name: "anon/63bbacd2fab677125a1516d4396114ab.bin",
                hash: "ba45090f85f0d3876400a82a396503f7",
                md5: "ba45090f85f0d3876400a82a396503f7",
                totalSize: 1175777,
                abSize: 1213360,
              },
            ],
            name: ["anon/63bbacd2fab677125a1516d4396114ab.bin"],
            path: ["android/anon_63bbacd2fab677125a1516d4396114ab.dat"],
            download: ["anon_63bbacd2fab677125a1516d4396114ab.dat"],
          },
        });
      }
      if (s.endsWith("anon_63bbacd2fab677125a1516d4396114ab.dat")) return dat;
      if (s.endsWith("hot_update_list.json")) return JSON.stringify(official);
      return undefined;
    });
    vi.mocked(exists).mockImplementation(async (p: string) => {
      const s = String(p).replace(/\\/g, "/");
      return s.endsWith("mods.Android.json") || s.endsWith("hot_update_list.json");
    });
    vi.mocked(size).mockResolvedValue(10);

    const res = mockRes();
    await callRouter(manifestReq(), res);
    await new Promise((r) => setTimeout(r, 30));

    // exportFile 把注入后的清单写盘（cache/hot_update_list.json）——从写盘内容断言下发形态
    const bodies = vi
      .mocked(writeFile)
      .mock.calls.map((call) => String(call[1]))
      .filter((body) => body.includes("\"abInfos\""));
    expect(bodies).toHaveLength(1);
    const served = JSON.parse(bodies[0]) as {
      versionId: string;
      abInfos: ServedAbInfo[];
    };

    // 官方条目被就地替换（不重复、不追加到末尾）
    const merged = served.abInfos.filter(
      (e) => e.name === "anon/63bbacd2fab677125a1516d4396114ab.bin",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      // 内容令牌 = mod md5 前 4 位（匿名 bundle 保持 hash==md5 同形；令牌变化即"有新版本"）
      hash: "ba45",
      md5: "ba45",
      totalSize: 1175777,
      abSize: 1213360,
      // 身份字段全部沿用官方条目——丢掉它们会让客户端把该条目当作无人认领的打包资源而忽略
      cid: 2457,
      cat: 1,
      meta: 1,
    });

    // 未被 mod 覆盖的主体 bundle 原样下发（含 32 位 md5 与身份 hash）
    expect(served.abInfos.find((e) => e.name === "shaders/other.ab")).toMatchObject({
      hash: "3a3fec0c5875afee8410d3dba8e002cb",
      md5: "ef1db26aee7f598bd01773179b84e5aa",
      cid: 2,
    });
    expect(served.versionId).toBe("26-08-07-14-53-29_30b8f0");
  });

  it("refreshModsIfChanged：mod 文件指纹变化时触发重载，未变化时跳过（运行时重打包热更新）", async () => {    // loadMods 走 zip 解析（yauzl mock 失败 → 空列表）；仅验证指纹驱动的重载触发
    let mtime = 1000;
    fsMock.readdir.mockImplementation(async (d: string) => {
      if (isPlatformSubdir(String(d))) throw new Error("ENOENT");
      return ["a.dat"];
    });
    fsMock.stat.mockImplementation(async () => ({ mtimeMs: mtime, size: 10 }));
    vi.mocked(exists).mockResolvedValue(false); // 平台缓存文件不存在
    vi.mocked(size).mockResolvedValue(10);
    fsMock.readFile.mockResolvedValue(Buffer.from("not a zip"));

    // 首次调用建立指纹基线 → 触发重载
    expect(await refreshModsIfChanged("Android")).toBe(true);
    // 指纹未变 → 不重载（避免每次版本请求重复扫描）
    expect(await refreshModsIfChanged("Android")).toBe(false);
    // mod 内容变更（mtime 变化）→ 再次触发重载
    mtime = 2000;
    expect(await refreshModsIfChanged("Android")).toBe(true);
    // 变更后趋于稳定 → 不再重载
    expect(await refreshModsIfChanged("Android")).toBe(false);
  });
});
