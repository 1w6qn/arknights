--[[
  PluginDefs.lua —— 插件清单
  供 PluginManager 加载：module 为 require 路径（对齐打包后的 m_Name，如 "Plugin/EnemyHpPlugin"）。
--]]
local PluginDefs = {
  {
    id = "enemy_hp",
    name = "敌人血量显示",
    desc = "在敌人血条旁显示具体血量数值",
    module = "Plugin/EnemyHpPlugin",
  },
  {
    id = "enemy_info",
    name = "敌人属性面板",
    desc = "战斗中长按并点击敌人查看属性与路线",
    module = "Plugin/EnemyInfoPlugin",
  },
  {
    id = "battle_assist",
    name = "战斗辅助",
    desc = "战斗时间轴 / 倍速 / TAS 暂停帧",
    module = "Plugin/BattleAssistPlugin",
  },
  {
    id = "plugin_panel",
    name = "插件管理面板",
    desc = "现代化插件启停管理面板",
    module = "Plugin/PanelPlugin",
  },
  {
    id = "options_panel",
    name = "插件选项面板",
    desc = "游戏内调节各插件参数（开关/数值/枚举）并同步服务端",
    module = "Plugin/OptionsPanelPlugin",
  },
  {
    -- 曾经漏登记：模块打进 bundle 也从不被 require（死代码），私服请求重定向失效
    id = "network_redirect",
    name = "网络重定向",
    desc = "把官服域名请求重定向到私服地址",
    module = "Plugin/NetworkRedirectPlugin",
  },
}

return PluginDefs