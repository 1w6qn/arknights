--[[
  PluginConfigFile.lua —— 插件配置文件（plugin_config.json）共享读写

  游戏内插件系统只有一份持久化文件（persistentDataPath/plugin_config.json），
  被两块配置共用：
    - enabled：各插件启停态（PluginManager 写）
    - options：各插件选项值（PluginOptions 写）

  若各自「只写自己那一块」，后写者会把对方字段清掉。故两块统一走本模块的
  「读 → 改 → 写」（Update），未知顶层键原样保留。

  依赖一律惰性获取：引导阶段 rapidjson / System.IO.File 可能尚不可用，
  顶层 require 失败会拖垮整个插件系统，故 pcall + 失败缓存。
--]]
local PluginConfigFile = {}

-- 顶层不再 require rapidjson / CS.System.IO.File（见模块注释），改为惰性 + 缓存
local _jsonMod = nil
local _fileType = nil
local _path = nil

--[[
  惰性获取 rapidjson 模块（失败缓存 false，避免每次重试）。
  @return rapidjson 模块或 nil
--]]
local function _Json()
  if _jsonMod == nil then
    local ok, mod = pcall(function() return require("rapidjson") end)
    _jsonMod = ok and mod or false
  end
  return _jsonMod or nil
end

--[[
  惰性获取 System.IO.File 类型（失败缓存 false）。
  @return File 类型或 nil
--]]
local function _File()
  if _fileType == nil then
    local ok, f = pcall(function() return CS.System.IO.File end)
    _fileType = ok and f or false
  end
  return _fileType or nil
end

--[[
  返回配置文件绝对路径（懒计算并缓存）。
  @return 配置文件路径
--]]
function PluginConfigFile.Path()
  if _path == nil then
    _path = CS.UnityEngine.Application.persistentDataPath .. "/plugin_config.json"
  end
  return _path
end

--[[
  读取配置；文件不存在、依赖不可用或解析失败时返回空表（绝不返回 nil）。
  @return 配置表（可能为空表）
--]]
function PluginConfigFile.Read()
  local file = _File()
  if file == nil then return {} end
  local path = PluginConfigFile.Path()
  local okExists, exists = pcall(function() return file.Exists(path) end)
  if not okExists or not exists then return {} end
  local okRead, text = pcall(function() return file.ReadAllText(path) end)
  if not okRead or type(text) ~= "string" then return {} end
  local json = _Json()
  if json == nil then return {} end
  local okParse, decoded = pcall(function() return json.decode(text) end)
  if okParse and type(decoded) == "table" then return decoded end
  return {}
end

--[[
  覆盖写入配置（best-effort：依赖不可用或写入失败仅返回 false，不抛错）。
  @param cfg 配置表
  @return 是否写入成功
--]]
function PluginConfigFile.Write(cfg)
  local json = _Json()
  if json == nil then return false end
  local okEncode, text = pcall(function() return json.encode(cfg) end)
  if not okEncode or type(text) ~= "string" then return false end
  local okWrite = pcall(function()
    CS.Torappu.FileUtil.WriteToFile(text, PluginConfigFile.Path(), false)
  end)
  return okWrite and true or false
end

--[[
  「读 → 改 → 写」更新配置：mutator(cfg) 就地修改，随后整体落盘。
  未知顶层键（如对方模块负责的字段）原样保留，避免互相清空。
  @param mutator function(cfg) 就地修改配置表
  @return 修改后的配置表
--]]
function PluginConfigFile.Update(mutator)
  local cfg = PluginConfigFile.Read()
  local ok = pcall(mutator, cfg)
  if not ok then return cfg end
  PluginConfigFile.Write(cfg)
  return cfg
end

return PluginConfigFile
