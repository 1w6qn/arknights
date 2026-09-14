import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { join } from "path";
import os from "os";
import {
  parsePluginDefs,
  loadPluginCatalog,
  FALLBACK_CATALOG,
} from "@plugin/plugin-catalog";

describe("plugin-catalog 插件目录单一数据源", () => {
  it("parsePluginDefs 解析 PluginDefs.lua 文本为目录条目", () => {
    const content = [
      "local PluginDefs = {",
      '  { id = "enemy_hp", name = "敌人血量显示", desc = "在敌人血条旁显示具体血量数值", module = "Plugin/EnemyHpPlugin" },',
      '  { id = "plugin_panel", name = "插件管理面板", desc = "现代化插件启停管理面板", module = "Plugin/PanelPlugin" },',
      "}",
      "",
    ].join("\n");
    const parsed = parsePluginDefs(content);
    expect(parsed).toEqual([
      { id: "enemy_hp", name: "敌人血量显示", desc: "在敌人血条旁显示具体血量数值", module: "Plugin/EnemyHpPlugin" },
      { id: "plugin_panel", name: "插件管理面板", desc: "现代化插件启停管理面板", module: "Plugin/PanelPlugin" },
    ]);
  });

  it("parsePluginDefs 忽略不含 module 的条目", () => {
    const content = 'local x = { { id = "a", name = "A", desc = "", module = "Plugin/A" }, { id = "b" } }';
    const parsed = parsePluginDefs(content);
    expect(parsed).toEqual([{ id: "a", name: "A", desc: "", module: "Plugin/A" }]);
  });

  it("parsePluginDefs 字段顺序无关 + 空白宽容 + 单引号字符串", () => {
    const content = [
      "local PluginDefs = {",
      "  { module = 'Plugin/EnemyHpPlugin',  id   =   'enemy_hp', desc='血量数值', name = '敌人血量显示' },",
      '  {id="battle_assist", module="Plugin/BattleAssistPlugin"},',
      "}",
      "",
    ].join("\n");
    const parsed = parsePluginDefs(content);
    expect(parsed).toEqual([
      { id: "enemy_hp", name: "敌人血量显示", desc: "血量数值", module: "Plugin/EnemyHpPlugin" },
      { id: "battle_assist", name: "battle_assist", desc: "", module: "Plugin/BattleAssistPlugin" },
    ]);
  });

  it("parsePluginDefs 忽略注释中的假条目", () => {
    const content = [
      "local PluginDefs = {",
      '  { id = "enemy_hp", name = "敌人血量显示", desc = "", module = "Plugin/EnemyHpPlugin" },',
      '  --[[ { id = "fake", name = "注释插件", desc = "", module = "Plugin/Fake" } ]]',
      '  -- { id = "fake2", name = "注释插件2", desc = "", module = "Plugin/Fake2" }',
      "}",
      "",
    ].join("\n");
    const parsed = parsePluginDefs(content);
    expect(parsed).toEqual([
      { id: "enemy_hp", name: "敌人血量显示", desc: "", module: "Plugin/EnemyHpPlugin" },
    ]);
  });

  it("loadPluginCatalog 从真实 PluginDefs.lua 加载（含全部 6 个插件）", () => {
    const catalog = loadPluginCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(4);
    expect(catalog.map((c) => c.id)).toEqual(
      expect.arrayContaining(["enemy_hp", "enemy_info", "battle_assist", "plugin_panel"]),
    );
  });

  it("loadPluginCatalog 文件不存在时回退内置目录", async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "plugin-cat-"));
    try {
      const catalog = loadPluginCatalog(join(dir, "missing.lua"));
      expect(catalog).toEqual([...FALLBACK_CATALOG]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loadPluginCatalog 解析结果为空时回退内置目录", async () => {
    const dir = await mkdtemp(join(os.tmpdir(), "plugin-cat-"));
    try {
      const emptyFile = join(dir, "empty.lua");
      await writeFile(emptyFile, "local x = 1\n");
      const catalog = loadPluginCatalog(emptyFile);
      expect(catalog).toEqual([...FALLBACK_CATALOG]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
