--[[
  PluginBootHotfixer.lua —— 插件系统引导 hotfixer
  经游戏原生 DefinedFix 管线引导：HotfixProcesser.Do 阶段 new() + Init() → OnInit()。
  OnInit 里先建立全局依赖绑定（Class/HotfixBase 由游戏提供，插件自身模块用 local 定义，
  需显式挂 _G 供跨模块引用），再 require "Plugin/core/PluginEntry" 并初始化插件系统。
  将其加入内置 bundle 的 DefinedFix 清单（见 scripts/repack-lua-bundle.ts 的 patchDefinedFix）。

  【真机诊断】OnInit 各步骤向 persistentDataPath/plugin_boot_trace.txt 追加标记，
  重启客户端后检查该文件即可确定引导走到哪一步（无需客户端 Lua 日志）。
--]]
local PluginBootHotfixer = Class("PluginBootHotfixer", HotfixBase)
local eutil = CS.Torappu.Lua.Util

--[[
  向真机诊断文件追加一行（含当前时间戳）。
  @param msg 标记内容
--]]
local function _Trace(msg)
  xpcall(function()
    local path = CS.UnityEngine.Application.persistentDataPath .. "/plugin_boot_trace.txt"
    local line = os.date("%H:%M:%S") .. " " .. msg .. "\n"
    CS.Torappu.FileUtil.WriteToFile(line, path, true)
  end, function() end)
end

--[[
  建立插件系统全局依赖：把 local 定义的模块表挂到 _G，供跨模块以全局名引用。
  require 会走 xLua 模块缓存，重复 require 返回同一表，故幂等。
  顺序：PluginDefs → PluginManager → PluginEntry（依赖关系由后向前）。
--]]
local function _BootstrapGlobals()
  _G.PluginDefs = require "Plugin/PluginDefs"
  _Trace("PluginDefs loaded")
  _G.PluginManager = require "Plugin/core/PluginManager"
  _Trace("PluginManager loaded")
  _G.PluginEntry = require "Plugin/core/PluginEntry"
  _Trace("PluginEntry loaded")
  _G.PluginHeartbeat = require "Plugin/core/PluginHeartbeat"
  _Trace("PluginHeartbeat loaded")
end

--[[
  初始化插件系统（引导入口）。异常经 xpcall 兜底并记日志。
--]]
function PluginBootHotfixer:OnInit()
  _Trace("OnInit enter")
  local ok, err = xpcall(function()
    _BootstrapGlobals()
    PluginEntry.init()
    _Trace("PluginEntry.init ok")
    -- 插件系统引导成功后：best-effort 生效确认（网络就绪后经 TimerModel 自动重试）
    PluginHeartbeat.ScheduleAuto()
    _Trace("ScheduleAuto ok")
  end, debug.traceback)
  if not ok then
    _Trace("FAILED: " .. tostring(err))
    eutil.LogHotfixError("[PluginBootHotfixer] 插件系统引导失败: " .. err)
  end
end

return PluginBootHotfixer