import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
// PlayerDataManager 构造挂载 mission.init（fire-and-forget）需要 Immer Patches 插件——
// 缺失会报「The plugin for 'Patches' has not been loaded」unhandled rejection（假阳性噪音）

/**
 * 配置模块替身（只放用例相关的两个认证字段）
 *
 * 按真实 `Config` 的字段类型声明：`authMode` 为 "single" | "real"、`singleUid` 可选，
 * 故用例可来回切换而不必 cast。
 */
const configMock = vi.hoisted(() => {
  const defaultConfig: {
    authMode: "single" | "real";
    singleUid?: string;
    authTokenFallback?: boolean;
    authAutoRegister?: boolean;
  } = {
    authMode: "single",
  };
  return { default: defaultConfig };
});
vi.mock("@core/config/index", () => configMock);
vi.mock("@utils/time", () => ({ now: () => 1234567890 }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, writeFile: vi.fn().mockResolvedValue(undefined), rename: vi.fn().mockResolvedValue(undefined) };
});
// readJson 默认走真实实现（读文件），懒加载用例可 mockResolvedValueOnce 覆盖
vi.mock("@utils/file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/file")>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

import { accountManager, generateSecret, type UserConfig } from "@game/modules/account/account-manager";
import type { PlayerDataManager } from "@game/kernel/player-data-manager";
import { type MockSeed } from "../../helpers";
import config from "@core/config/index";
import { readJson } from "@utils/file";
import { readFileSync, existsSync, copyFileSync, rmSync } from "fs";
import { writeFile, rename } from "fs/promises";

/**
 * 写入 accountManager.configs 的用例夹具（窄视图）
 *
 * 生产字段是完整 {@link UserConfig}（uid/password/auth/battle/gacha/rlv2 全必填），
 * 而用例只写被测分支读到的键；`MockSeed` 提供深可选视图（键名与字段类型仍受真实契约
 * 约束）。组合根字段直接赋值会被完整结构校验挡住，故经 Object.assign 单点写入
 * （零关键字、零 cast；运行期就是原来的整表替换）。
 * @param configs - 用例提供的配置窄视图
 */
function setConfigs(configs: Record<string, MockSeed<UserConfig>>): void {
  Object.assign(accountManager, { configs });
}

/**
 * 替换 accountManager 的内存玩家表 / 空闲计时表（用例模拟未加载与空闲账号）
 *
 * 用例只关心「哪些 uid 在表里」，值本身不是真实 `PlayerDataManager`；`_lastAccess`
 * 是私有字段，直接赋值需要 cast，故与 setConfigs 同款经 Object.assign 写入。
 * @param patch - data 与/或 _lastAccess 的替换值
 */
function setAccountData(patch: {
  data?: Record<string, MockSeed<PlayerDataManager>>;
  _lastAccess?: Record<string, number>;
}): void {
  Object.assign(accountManager, patch);
}

describe("getUidByToken 认证模式", () => {
  // T3 目录重组：根 player_data.json 已归档至 data/player_data.json.root-backup（未跟踪本地产物）。
  // S3 回退/官服基底用例按 CWD 读取根种子文件（AccountManager._loadTemplate 运行时语义），
  // 缺失时从归档临时还原，测试结束后清理。
  const ROOT_SEED = "./player_data.json";
  const SEED_ARCHIVE = "./data/player_data.json.root-backup";
  let seeded = false;
  beforeAll(() => {
    if (!existsSync(ROOT_SEED) && existsSync(SEED_ARCHIVE)) {
      copyFileSync(SEED_ARCHIVE, ROOT_SEED);
      seeded = true;
    }
  });
  afterAll(() => {
    if (seeded) rmSync(ROOT_SEED, { force: true });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    configMock.default.authMode = "single";
    configMock.default.singleUid = undefined;
    configMock.default.authTokenFallback = undefined;
    configMock.default.authAutoRegister = undefined;
    setConfigs({
        "1": { auth: { phone: "1" } },
        "2221": { auth: { phone: "2221" } },
    });
  });

  it("single 模式：任意 token 收敛到 uid=1（oauth2/basic/u8 全流程正常）", async () => {
    config.authMode = "single";
    expect(await accountManager.getUidByToken("aId1QCwRP8rVkxSYsG4bCzjQ")).toBe("1");
    expect(await accountManager.getUidByToken("2221")).toBe("1");
    expect(await accountManager.getUidByToken("")).toBe("1");
  });

  it("single 模式 tokenByPhonePassword 返回固定 uid=1（不注册新账号）", async () => {
    config.authMode = "single";
    expect(await accountManager.tokenByPhonePassword("13900001111", "any")).toBe("1");
    expect(await accountManager.tokenByPhonePassword("不存在", "pwd")).toBe("1");
  });

  it("single 模式配置 singleUid 时收敛到该账号（过渡用）", async () => {
    config.authMode = "single";
    config.singleUid = "2222";
    expect(await accountManager.getUidByToken("any")).toBe("2222");
    expect(await accountManager.tokenByPhonePassword("x", "y")).toBe("2222");
  });

  it("ensureSingleUser 应创建缺失的单例账号（干净模板）", async () => {
    const spy = vi
      .spyOn(accountManager, "saveUserConfig")
      .mockResolvedValue(undefined);
    await accountManager.ensureSingleUser("2222");
    const conf = accountManager.configs["2222"];
    expect(conf).toBeDefined();
    expect(conf.auth.phone).toBe("2222");
    expect(conf.secret).toBeDefined();
    expect(spy).toHaveBeenCalled();
  });

  it("ensureSingleUser 后应加载玩家数据（getPlayerData 可用）", async () => {
    const spy = vi
      .spyOn(accountManager, "saveUserConfig")
      .mockResolvedValue(undefined);
    await accountManager.ensureSingleUser("2222");
    const data = accountManager.data["2222"];
    expect(data).toBeDefined();
    expect(data._playerdata.status.uid).toBe("2222");
  });

  it("ensureSingleUser 账号已存在时应直接返回", async () => {
    const spy = vi
      .spyOn(accountManager, "saveUserConfig")
      .mockResolvedValue(undefined);
    await accountManager.ensureSingleUser("1");
    expect(spy).not.toHaveBeenCalled();
  });

  it("ensureSingleUser 在 1.json 缺失时回退 player_data.json 官服基底（S3）", async () => {
    const spy = vi
      .spyOn(accountManager, "saveUserConfig")
      .mockResolvedValue(undefined);
    vi.mocked(readJson)
      .mockRejectedValueOnce(new Error("ENOENT")) // 1.json 缺失
      .mockResolvedValueOnce(JSON.parse(readFileSync(ROOT_SEED, "utf8")));
    await accountManager.ensureSingleUser("9999");
    expect(accountManager.configs["9999"]).toBeDefined();
    expect(spy).toHaveBeenCalled();
  });

  it("real 模式：有效 uid 返回原样，未知 token 缺省不再兜底（认证绕过修复）", async () => {
    config.authMode = "real";
    expect(await accountManager.getUidByToken("2221")).toBe("2221");
    // 缺省关闭兜底：未知 token 一律拒绝（历史行为是回退默认账号——等于任意字符串即主账号）
    expect(await accountManager.getUidByToken("aId1QCwRP8rVkxSYsG4bCzjQ")).toBe("");
    // 显式开启 authTokenFallback 才恢复旧兼容行为（迁移过渡用）
    config.authTokenFallback = true;
    expect(await accountManager.getUidByToken("aId1QCwRP8rVkxSYsG4bCzjQ")).toBe("1");
  });

  it("real 模式：token 匹配账号 secret 应返回对应 uid（参考 DoctoratePy query_account_by_secret）", async () => {
    config.authMode = "real";
    setConfigs({
        "1": { auth: { phone: "1" }, secret: "secret_1" },
        "2221": { auth: { phone: "2221" }, secret: "secret_2221" },
    });
    expect(await accountManager.getUidByToken("secret_2221")).toBe("2221");
    expect(await accountManager.getUidByToken("secret_1")).toBe("1");
    // 未知 token 缺省拒绝（不再兜底默认账号）
    expect(await accountManager.getUidByToken("unknown")).toBe("");
  });

  it("generateSecret 应生成随机 token（不可由手机号推导）", async () => {
    const a = generateSecret();
    const b = generateSecret();
    // base64url(32B) = 43 字符；不再是 md5(phone + 源码内公开常量)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).not.toBe(a);
  });

  it("real 模式 tokenByPhonePassword 应返回账号 secret（而非 uid）", async () => {
    config.authMode = "real";
    setConfigs({
        "1": { auth: { phone: "1" }, password: "p1", secret: "secret_1" },
    });
    expect(await accountManager.tokenByPhonePassword("1", "p1")).toBe("secret_1");
    // 旧明文账号登录成功后惰性升级为 scrypt（R7——不再明文/弱哈希存储）
    expect(accountManager.configs["1"].password).toMatch(/^scrypt\$/);
  });

  it("getTokenByUid 应返回账号 secret（无 secret 旧账号回退 uid）", async () => {
    setConfigs({
        "1": { auth: { phone: "1" }, secret: "abc123" },
        "2": { auth: { phone: "2" } },
    });
    expect(await accountManager.getTokenByUid("1")).toBe("abc123");
    expect(await accountManager.getTokenByUid("2")).toBe("2");
  });

  it("getPlayerData 懒加载：data 缺失时从存档文件加载（real 模式注册后免重启）", async () => {
    // 用真实 1.json 模板构造完整 playerdata（PlayerDataManager 构造需要完整字段）
    const raw = JSON.parse(readFileSync("./data/user/databases/1.json", "utf8"));
    raw.status.uid = "7";
    vi.mocked(readJson).mockResolvedValueOnce(raw);
    accountManager.data = {}; // 模拟未加载状态
    const player = await accountManager.getPlayerData("7");
    expect(player).toBeDefined();
    expect(player._playerdata.status.uid).toBe("7");
  });

  it("single 模式 registerUser 不建号（收敛固定账号，避免垃圾账号污染 configs/users）", async () => {
    config.authMode = "single";
    config.singleUid = undefined;
    expect(await accountManager.registerUser("13900009999", "pwd123456")).toBe("1");
    expect(accountManager.configs["13900009999"]).toBeUndefined();
    // 指定 singleUid 时收敛到该账号
    config.singleUid = "2222";
    expect(await accountManager.registerUser("13900009999", "pwd123456")).toBe("2222");
  });

  it("real 模式：有 secret 的账号拒绝 uid 数字直通（必须用 secret 登录）", async () => {
    config.authMode = "real";
    setConfigs({
        "1": { auth: { phone: "1" }, secret: "secret_1" },
        "2221": { auth: { phone: "2221" }, secret: "secret_2221" },
    });
    expect(await accountManager.getUidByToken("2221")).toBe("");
    expect(await accountManager.getUidByToken("1")).toBe("");
    expect(await accountManager.getUidByToken("secret_2221")).toBe("2221");
    expect(await accountManager.getUidByToken("secret_1")).toBe("1");
  });

  it("real 模式：无 secret 的旧账号保留 uid 直通（兼容迁移前账号）", async () => {
    config.authMode = "real";
    setConfigs({
        "1": { auth: { phone: "1" } },
    });
    expect(await accountManager.getUidByToken("1")).toBe("1");
  });

  it("real 模式：禁用账号禁止鉴权与登录（Dashboard 删除/禁用用户）", async () => {
    config.authMode = "real";
    setConfigs({
        "1": { auth: { phone: "1" }, secret: "secret_1" },
        "2221": { auth: { phone: "2221" }, secret: "secret_2221", disabled: true, password: "p2221" },
        "2222": { auth: { phone: "2222" }, disabled: true }, // 无 secret 旧账号 + 已禁用
    });
    // secret 登录被拒
    expect(await accountManager.getUidByToken("secret_2221")).toBe("");
    // uid 数字直通被拒（无 secret 旧账号 + 已禁用）
    expect(await accountManager.getUidByToken("2222")).toBe("");
    // 未禁用账号正常
    expect(await accountManager.getUidByToken("secret_1")).toBe("1");
    // 登录被拒
    await expect(accountManager.tokenByPhonePassword("2221", "p2221")).rejects.toThrow("禁用");
  });

  it("single 模式：禁用固定账号后 getUidByToken 返回空（无法鉴权）", async () => {
    config.authMode = "single";
    config.singleUid = "1";
    setConfigs({
        "1": { auth: { phone: "1" }, disabled: true },
    });
    expect(await accountManager.getUidByToken("any")).toBe("");
  });

  it("registerUser 原子写（.tmp + rename，避免写一半崩溃留坏档）", async () => {
    config.authMode = "real";
    const writeMock = vi.mocked(writeFile);
    const renameMock = vi.mocked(rename);
    writeMock.mockClear();
    renameMock.mockClear();
    await accountManager.registerUser("13900009999", "pwd123456");
    const tmpWrite = writeMock.mock.calls.find((c) => String(c[0]).includes(".tmp"));
    expect(tmpWrite).toBeDefined();
    expect(renameMock).toHaveBeenCalledWith(
      expect.stringContaining("2222.json.tmp"),
      expect.stringContaining("2222.json"),
    );
  });

  it("getPlayerData 并发：同一 uid 共享一次加载（不双实例互踩）", async () => {
    vi.mocked(readJson).mockClear();
    const raw = JSON.parse(readFileSync("./data/user/databases/1.json", "utf8"));
    raw.status.uid = "8";
    vi.mocked(readJson).mockResolvedValueOnce(raw);
    // ShopController 构造时会异步读信用商店静态配置（SocialGoodList.json），一并给值
    vi.mocked(readJson).mockResolvedValueOnce({ goodList: [], charPurchase: {} });
    setAccountData({ data: {} });
    const [p1, p2] = await Promise.all([
      accountManager.getPlayerData("8"),
      accountManager.getPlayerData("8"),
    ]);
    expect(p1).toBe(p2);
    // 玩家数据只加载一次（第二次 readJson 为 ShopController 读 SocialGoodList 静态配置）
    const playerLoads = vi.mocked(readJson).mock.calls.filter((c) =>
      String(c[0]).includes("databases/8.json"),
    );
    expect(playerLoads).toHaveLength(1);
  });

  it("空闲账号清扫应卸载超时账号（先落盘；fresh 与 singleUid 保留）——D-1", async () => {
    config.singleUid = "1";
    const manager = accountManager;
    setAccountData({
      data: { "1": {}, "2": {} },
      _lastAccess: {
        "1": Date.now(),
        "2": Date.now() - 40 * 60 * 1000, // 40 分钟前——超 30 分钟阈值
      },
    });
    const flushSpy = vi
      .spyOn(manager, "flushSave")
      .mockResolvedValue(undefined);
    await manager.sweepIdleAccounts();
    expect(manager.data["2"]).toBeUndefined();
    expect(manager.data["1"]).toBeDefined();
    expect(flushSpy).toHaveBeenCalledWith("2");
  });
});

describe("updatePassword / updatePhone（real 模式用户管理闭环）", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configMock.default.authMode = "real";
    setConfigs({
        "1": { auth: { phone: "1" }, secret: "secret_1" },
    });
  });

  it("updatePassword 应哈希存储新密码并轮换 secret（旧会话失效）", async () => {
    const ok = await accountManager.updatePassword("1", "NewPwd123");
    expect(ok).toBe(true);
    const conf = accountManager.configs["1"];
    expect(conf.password.startsWith("scrypt$")).toBe(true);
    // 改密同时轮换 secret：旧 token 立即失效（修复「改密无法撤销已泄露令牌」）
    expect(conf.secret).not.toBe("secret_1");
    // 新密码可验证
    const { verifyPassword } = await import("@utils/crypt");
    expect(verifyPassword(conf.password, "NewPwd123")).toBe(true);
  });

  it("updatePassword 账号不存在返回 false", async () => {
    expect(await accountManager.updatePassword("999", "NewPwd123")).toBe(false);
  });

  it("updatePhone 应更新手机并轮换随机 secret", async () => {
    const ok = await accountManager.updatePhone("1", "13812345678");
    expect(ok).toBe(true);
    const conf = accountManager.configs["1"];
    expect(conf.auth.phone).toBe("13812345678");
    expect(conf.secret).not.toBe("secret_1");
    // 随机 secret（不再由新手机号 + 公开常量确定性派生）
    expect(conf.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
