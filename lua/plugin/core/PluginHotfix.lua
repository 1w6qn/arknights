--[[
  PluginHotfix.lua —— 插件级 hotfix 共享注册表

  解决多插件 hook 同一 C# 方法时，各插件持有独立 HotfixBase、Dispose 时
  把方法槽恢复成各自记录的旧实现、从而互相覆盖的问题（例如 EnemyInfoPlugin 与
  BattleAssistPlugin 同时包装 UIController.Awake / BattleController.Update）。

  设计：
  - 对同一 (cls, method) 只安装一个 xlua.hotfix 包装器；所有插件的处理函数
    按注册顺序链式组合（后注册者 orig = 前一段组合，最终 orig = 原方法）。
  - 卸载只移除本插件的处理函数；最后一个处理函数移除时才还原原方法。
  - 两种模式：
      Hotfix —— 包装模式：fixFunc(self, orig, ...)，orig 为链上下一段实现，
                可调用保留原行为（对应 BasePlugin:Hotfix）。
      FixEx  —— 完整替换模式：fixFunc(self, ...) 取代整条链，同一方法同时
                最多一个生效（对应 BasePlugin:Fix_ex）。
  - 不依赖游戏提供的 HotfixBase，直接用 xlua.hotfix；任何注册失败（如方法
    不存在/版本漂移）返回 false，由调用方记录日志，不影响其它插件。

  依赖：无（模块加载不触碰任何游戏全局，运行时才访问 xlua）。
--]]
local PluginHotfix = {}

-- entries[cls][method] = { orig, handlers = { {plugin, fn}, ... }, fixEx, chain }
local entries = {}

--[[
  重建 (cls, method) 的调用链并缓存。
  链从后往前构造：handlers[n] 的 orig = 原方法；handlers[i] 的 orig =
  handlers[i+1..n] 的组合。仅注册/注销时重建，热路径零开销。
  @param entry (cls, method) 条目
--]]
local function _RebuildChain(entry)
  if entry.fixEx ~= nil then
    -- 完整替换优先：整条链被取代（fixFunc(self, ...)）
    entry.chain = entry.fixEx.fn
    return
  end
  local n = #entry.handlers
  if n == 0 then
    entry.chain = entry.orig
    return
  end
  local chain = entry.orig
  for i = n, 1, -1 do
    local h = entry.handlers[i]
    local inner = chain
    chain = function(self, ...)
      return h.fn(self, inner, ...)
    end
  end
  entry.chain = chain
end

--[[
  确保 (cls, method) 已安装包装器；原方法不存在（版本漂移）时返回 nil。
  @param cls    C# 类型
  @param method 方法名
  @return 条目或 nil
--]]
local function _EnsureInstalled(cls, method)
  local byMethod = entries[cls]
  if byMethod == nil then
    byMethod = {}
    entries[cls] = byMethod
  end
  local entry = byMethod[method]
  if entry == nil then
    local orig = cls[method]
    if orig == nil then
      -- 方法不存在：不安装包装器，调用方记录失败
      return nil
    end
    entry = { orig = orig, handlers = {}, fixEx = nil, chain = orig }
    byMethod[method] = entry
    xlua.hotfix(cls, method, function(self, ...)
      return entry.chain(self, ...)
    end)
  end
  return entry
end

--[[
  注册包装模式处理函数（fixFunc(self, orig, ...)）。
  @param cls     C# 类型
  @param method  方法名
  @param plugin  所属插件实例（用于卸载匹配）
  @param fixFunc 包装实现
  @return 注册是否成功
--]]
function PluginHotfix.Hotfix(cls, method, plugin, fixFunc)
  local entry = _EnsureInstalled(cls, method)
  if entry == nil then return false end
  entry.handlers[#entry.handlers + 1] = { plugin = plugin, fn = fixFunc }
  _RebuildChain(entry)
  return true
end

--[[
  注册完整替换处理函数（fixFunc(self, ...)）。同一方法同时只有一个生效，
  后注册覆盖先注册；卸载时以 plugin 匹配移除。
  @param cls     C# 类型
  @param method  方法名
  @param plugin  所属插件实例（用于卸载匹配）
  @param fixFunc 替换实现
  @return 注册是否成功
--]]
function PluginHotfix.FixEx(cls, method, plugin, fixFunc)
  local entry = _EnsureInstalled(cls, method)
  if entry == nil then return false end
  entry.fixEx = { plugin = plugin, fn = fixFunc }
  _RebuildChain(entry)
  return true
end

--[[
  移除某插件的全部处理函数（包装 + 完整替换）。
  最后一个处理函数移除时还原原方法并卸载包装器；其余情况重建调用链。
  @param cls    C# 类型
  @param method 方法名
  @param plugin 所属插件实例
--]]
function PluginHotfix.Unfix(cls, method, plugin)
  local byMethod = entries[cls]
  if byMethod == nil then return end
  local entry = byMethod[method]
  if entry == nil then return end
  local handlers = entry.handlers
  for i = #handlers, 1, -1 do
    if handlers[i].plugin == plugin then
      table.remove(handlers, i)
    end
  end
  if entry.fixEx ~= nil and entry.fixEx.plugin == plugin then
    entry.fixEx = nil
  end
  if #handlers == 0 and entry.fixEx == nil then
    -- 还原原方法，卸载包装器
    if entry.orig ~= nil then
      xpcall(function() xlua.hotfix(cls, method, entry.orig) end, debug.traceback)
    end
    byMethod[method] = nil
    if next(byMethod) == nil then
      entries[cls] = nil
    end
    return
  end
  _RebuildChain(entry)
end

return PluginHotfix
