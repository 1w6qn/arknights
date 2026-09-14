import { describe, it, expect, beforeEach, vi } from "vitest";
import { AccountManager } from "@game/modules/account/account-manager";
import { writeFile, rename } from "fs/promises";
import { mockPlayerData, asPlayerManager } from "../../helpers";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, writeFile: vi.fn().mockResolvedValue(undefined), rename: vi.fn().mockResolvedValue(undefined) };
});

describe("AccountManager 保存优化（原子写 + 防抖）", () => {
  let manager: AccountManager;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    manager = new AccountManager();
    manager.data = { "1": asPlayerManager(mockPlayerData({})) };
  });

  it("savePlayerData 应原子写（临时文件 + rename）", async () => {
    const writeMock = vi.mocked(writeFile);
    const renameMock = vi.mocked(rename);
    await manager.savePlayerData("1");
    // 写临时文件
    const tmpWrite = writeMock.mock.calls.find((c) => String(c[0]).includes(".tmp"));
    expect(tmpWrite).toBeDefined();
    // rename 到最终路径
    expect(renameMock).toHaveBeenCalledWith(
      expect.stringContaining(".tmp"),
      expect.stringContaining("1.json"),
    );
  });

  it("flushSave 应原子写并保存配置", async () => {
    const saveConfigSpy = vi.spyOn(manager, "saveUserConfig").mockResolvedValue(undefined);
    await manager.flushSave("1");
    expect(saveConfigSpy).toHaveBeenCalled();
  });

  it("scheduleSave 500ms 内多次调用只 flush 一次（防抖合并）", async () => {
    vi.useFakeTimers();
    const flushSpy = vi.spyOn(manager, "flushSave").mockResolvedValue(undefined);
    // 模拟 3 次 save 事件
    manager["scheduleSave"]("1");
    manager["scheduleSave"]("1");
    manager["scheduleSave"]("1");
    expect(flushSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(499);
    expect(flushSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("不同 uid 的保存互不影响（独立防抖）", async () => {
    vi.useFakeTimers();
    const flushSpy = vi.spyOn(manager, "flushSave").mockResolvedValue(undefined);
    manager["scheduleSave"]("1");
    manager["scheduleSave"]("2");
    vi.advanceTimersByTime(500);
    expect(flushSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
