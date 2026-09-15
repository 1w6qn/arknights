--[[
  PluginDefs.lua —— 插件清单（插件系统的唯一注册表）

  目录约定（规范化模块化，2026-09-14）：
    lua/plugin/
    ├── PluginDefs.lua   本清单（保持根目录：服务端 plugin-catalog 按固定路径解析）
    ├── core/            插件系统基础设施（生命周期 / 注册表 / 配置 / 选项 / 心跳 / 引导）
    ├── ui/              共享 UI 控件工厂
    └── plugins/         业务插件（每个插件一个自包含模块，经本清单登记）

  module 为 Lua 的 require 路径，即相对 lua/plugin/ 去掉 .lua 的 POSIX 路径（前缀固定 "Plugin/"）。
  客户端按 require 路径推导容器 key（`dyn/gamedata/[uc]lua/<小写相对路径>.bytes`，重打包时
  repack-lua-bundle 另补一条 basename 别名），故子目录参与寻址但 **basename 仍须全局唯一**
  （守卫见 tests/unit/plugin/plugin-module-layout.test.ts）。
--]]
local PluginDefs = {
  {
    id = "enemy_hp",
    name = "敌人血量显示",
    desc = "在敌人血条旁显示具体血量数值",
    module = "Plugin/plugins/EnemyHpPlugin",
  },
  {
    id = "enemy_info",
    name = "敌人属性面板",
    desc = "战斗中长按并点击敌人查看属性与路线",
    module = "Plugin/plugins/EnemyInfoPlugin",
  },
  {
    id = "battle_assist",
    name = "战斗辅助",
    desc = "战斗时间轴 / 倍速 / TAS 暂停帧",
    module = "Plugin/plugins/BattleAssistPlugin",
  },
  {
    id = "plugin_panel",
    name = "插件管理面板",
    desc = "现代化插件启停管理面板",
    -- ui_entry：游戏内 UI 入口（提供面板/浮窗按钮）。至少要保留一个启用，
    -- 否则游戏内再无任何入口能重新打开被隐藏的面板（PluginManager 有守卫）。
    ui_entry = true,
    module = "Plugin/plugins/PanelPlugin",
  },
  {
    id = "options_panel",
    name = "插件选项面板",
    desc = "游戏内调节各插件参数（开关/数值/枚举）并同步服务端",
    ui_entry = true,
    module = "Plugin/plugins/OptionsPanelPlugin",
  },
  {
    -- 曾经漏登记：模块打进 bundle 也从不被 require（死代码），私服请求重定向失效
    id = "network_redirect",
    name = "网络重定向",
    desc = "把官服域名请求重定向到私服地址",
    module = "Plugin/plugins/NetworkRedirectPlugin",
  },
}

return PluginDefs