import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, mkdir } from "fs/promises";
import { join } from "path";
import os from "os";
import { PluginConfigService } from "@plugin/plugin-config-service";

const tempDirs: string[] = [];

async function makeConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "plugin-cfg-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

describe("PluginConfigService", () => {
  it("默认全部插件启用", async () => {
    const svc = new PluginConfigService(await makeConfigPath());
    expect(await svc.isEnabled("enemy_hp")).toBe(true);
    expect(await svc.isEnabled("plugin_panel")).toBe(true);
  });

  it("设置启用状态并持久化（可重新加载）", async () => {
    const path = await makeConfigPath();
    const svc = new PluginConfigService(path);
    await svc.setEnabled("enemy_hp", false);
    await svc.setEnabled("battle_assist", true);

    // 文件已写入
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    expect(onDisk.enabled.enemy_hp).toBe(false);

    // 新实例重新读取
    const svc2 = new PluginConfigService(path);
    expect(await svc2.isEnabled("enemy_hp")).toBe(false);
    expect(await svc2.isEnabled("battle_assist")).toBe(true);
  });

  it("setEnabled 幂等：重复设置同值不报错", async () => {
    const svc = new PluginConfigService(await makeConfigPath());
    await svc.setEnabled("enemy_info", false);
    await svc.setEnabled("enemy_info", false);
    expect(await svc.isEnabled("enemy_info")).toBe(false);
  });

  it("未知插件 id 抛错", async () => {
    const svc = new PluginConfigService(await makeConfigPath());
    await expect(svc.setEnabled("nope", true)).rejects.toThrow(/未知插件/);
  });

  it("配置文件损坏时回退默认全启用", async () => {
    const path = await makeConfigPath();
    await mkdir(join(path, ".."), { recursive: true });
    // 写入非法 JSON
    const { writeFile } = await import("fs/promises");
    await writeFile(path, "{ not json ");
    const svc = new PluginConfigService(path);
    expect(await svc.isEnabled("enemy_hp")).toBe(true);
  });

  it("getAll 返回目录顺序与启用状态", async () => {
    const path = await makeConfigPath();
    const svc = new PluginConfigService(path);
    await svc.setEnabled("enemy_hp", false);
    const list = await svc.getAll();
    // 顺序与 PluginDefs.lua 单一数据源一致（面板管理的 9 个插件，含选项面板、服务器切换、上报截断、自动化桥与日志回传）
    expect(list.map((p) => p.id)).toEqual([
      "enemy_hp",
      "enemy_info",
      "battle_assist",
      "plugin_panel",
      "options_panel",
      "network_redirect",
      "event_log_block",
      "automation_bridge",
      "unity_log",
    ]);
    expect(list.find((p) => p.id === "enemy_hp")?.enabled).toBe(false);
    expect(list.find((p) => p.id === "plugin_panel")?.enabled).toBe(true);
  });

  it("入口守卫：不能停用最后一个 UI 入口面板（隐藏后无法再从游戏内调出）", async () => {
    const path = await makeConfigPath();
    const svc = new PluginConfigService(path);
    // 两个入口都开着 → 允许先关掉一个
    await expect(svc.setEnabled("plugin_panel", false)).resolves.toBe(false);
    expect(await svc.isEnabled("plugin_panel")).toBe(false);
    expect(await svc.canDisable("options_panel")).toBe(false);
    // 再关另一个 → 拒绝（否则游戏内再无入口）
    await expect(svc.setEnabled("options_panel", false)).rejects.toThrow(/最后一个插件入口/);
    expect(await svc.isEnabled("options_panel")).toBe(true);
    // 可以重新打开被关掉的那个
    await expect(svc.setEnabled("plugin_panel", true)).resolves.toBe(true);
    expect(await svc.canDisable("plugin_panel")).toBe(true);
    // 非入口插件不受守卫影响
    await expect(svc.setEnabled("enemy_hp", false)).resolves.toBe(false);
    expect(await svc.canDisable("enemy_hp")).toBe(true);
  });

  it("目录暴露 uiEntry 标记（客户端入口守卫的数据来源）", async () => {
    const path = await makeConfigPath();
    const svc = new PluginConfigService(path);
    expect(svc.uiEntryIds().sort()).toEqual(["options_panel", "plugin_panel"]);
    const list = await svc.getAll();
    expect(list.find((p) => p.id === "plugin_panel")?.uiEntry).toBe(true);
    expect(list.find((p) => p.id === "enemy_hp")?.uiEntry).toBeUndefined();
  });

  it("setOption 持久化标量取值（可重新加载）", async () => {
    const path = await makeConfigPath();
    const svc = new PluginConfigService(path);
    await svc.setOption("enemy_hp", "font_size", 20);
    await svc.setOption("enemy_hp", "color", "orange");
    await svc.setOption("battle_assist", "show_timer", false);

    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    expect(onDisk.options.enemy_hp).toEqual({ font_size: 20, color: "orange" });

    const svc2 = new PluginConfigService(path);
    expect(await svc2.getOptions("enemy_hp")).toEqual({ font_size: 20, color: "orange" });
    expect(await svc2.getOptions("battle_assist")).toEqual({ show_timer: false });
    expect(await svc2.getAllOptions()).toEqual({
      enemy_hp: { font_size: 20, color: "orange" },
      battle_assist: { show_timer: false },
    });
  });

  it("启用态与选项取值互不覆盖（同一配置文件两块字段）", async () => {
    const path = await makeConfigPath();
    const svc = new PluginConfigService(path);
    await svc.setOption("enemy_hp", "font_size", 18);
    await svc.setEnabled("enemy_hp", false);
    await svc.setEnabled("plugin_panel", false);
    await svc.setOption("enemy_hp", "font_size", 22);
    await svc.setEnabled("plugin_panel", true);

    const svc2 = new PluginConfigService(path);
    expect(await svc2.isEnabled("enemy_hp")).toBe(false);
    expect(await svc2.isEnabled("plugin_panel")).toBe(true);
    expect(await svc2.getOptions("enemy_hp")).toEqual({ font_size: 22 });
  });

  it("setOption 校验插件 id / 键名 / 取值", async () => {
    const svc = new PluginConfigService(await makeConfigPath());
    await expect(svc.setOption("nope", "font_size", 20)).rejects.toThrow(/未知插件/);
    await expect(svc.setOption("enemy_hp", "1bad", 20)).rejects.toThrow(/非法选项键/);
    await expect(svc.setOption("enemy_hp", "font_size", Number.NaN)).rejects.toThrow(/非法选项值/);
    await expect(svc.setOption("enemy_hp", "font_size", "x".repeat(80))).rejects.toThrow(/非法选项值/);
  });

  it("磁盘上的脏选项在读取时被清洗", async () => {
    const path = await makeConfigPath();
    await mkdir(join(path, ".."), { recursive: true });
    const { writeFile } = await import("fs/promises");
    await writeFile(
      path,
      JSON.stringify({
        enabled: { enemy_hp: false },
        options: {
          enemy_hp: { font_size: 20, "bad key": 1, nested: { a: 1 }, color: "orange" },
        },
      }),
    );
    const svc = new PluginConfigService(path);
    expect(await svc.getOptions("enemy_hp")).toEqual({ font_size: 20, color: "orange" });
  });
});