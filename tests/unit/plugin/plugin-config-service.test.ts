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
    // 顺序与 PluginDefs.lua 单一数据源一致（PluginDefs 现列 4 个可由面板管理的插件；
    // network_redirect 私服引导由 PluginBootHotfixer 纳入引导，不在此面板清单中）
    expect(list.map((p) => p.id)).toEqual([
      "enemy_hp",
      "enemy_info",
      "battle_assist",
      "plugin_panel",
    ]);
    expect(list.find((p) => p.id === "enemy_hp")?.enabled).toBe(false);
    expect(list.find((p) => p.id === "plugin_panel")?.enabled).toBe(true);
  });
});