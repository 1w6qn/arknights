/**
 * 插件 chunk 打包器（服务端 GET /plugin/lua 的数据源）
 *
 * 覆盖递归读取：core/ + ui/ + plugins/ + 根 PluginDefs.lua 全部内联，
 * 模块名 = Lua require 路径（Plugin/<相对路径>），且引导段与引导顺序一致。
 */
import { describe, it, expect } from "vitest";
import { buildPluginLuaChunk } from "@plugin/lua-chunk-builder";

describe("lua-chunk-builder 自包含插件 chunk", () => {
  const chunk = buildPluginLuaChunk();

  it("内联全部 20 个模块，模块名为 require 路径（含分层子目录）", () => {
    expect(chunk.modules).toHaveLength(20);
    expect(chunk.modules).toContain("Plugin/PluginDefs");
    expect(chunk.modules).toContain("Plugin/core/PluginManager");
    expect(chunk.modules).toContain("Plugin/core/PluginBootHotfixer");
    expect(chunk.modules).toContain("Plugin/core/AutomationBridge");
    expect(chunk.modules).toContain("Plugin/ui/PluginUI");
    expect(chunk.modules).toContain("Plugin/plugins/EnemyHpPlugin");
    expect(chunk.modules).toContain("Plugin/plugins/EventLogBlockPlugin");
    expect(chunk.modules).toContain("Plugin/plugins/AutomationPlugin");
    // 没有残留的扁平旧路径
    expect(chunk.modules).not.toContain("Plugin/PluginManager");
    expect(chunk.modules).not.toContain("Plugin/BasePlugin");
  });

  it("模块表键与引导 require 路径一致，并装 Plugin/* searcher", () => {
    expect(chunk.lua).toContain('["Plugin/core/PluginManager"]');
    expect(chunk.lua).toContain('_G.PluginManager = require "Plugin/core/PluginManager"');
    expect(chunk.lua).toContain('_G.PluginEntry = require "Plugin/core/PluginEntry"');
    expect(chunk.lua).toContain('_G.PluginHeartbeat = require "Plugin/core/PluginHeartbeat"');
    expect(chunk.lua).toContain("dts_searcher");
    expect(chunk.lua).toContain("PluginEntry.init()");
  });

  it("内容指纹为 12 位十六进制（缓存/日志校验用）", () => {
    expect(chunk.version).toMatch(/^[0-9a-f]{12}$/);
  });
});
