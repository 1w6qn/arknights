/**
 * 管理 REST API 端点规范
 *
 * Dashboard「接口」Tab 据此渲染管理 API 控制台（端点列表 + 请求构造器）。
 * 与 admin-router.ts 保持同步维护：新增端点时在此登记 method/path/说明/参数示例。
 */
export interface AdminParamSpec {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  desc: string;
}

export interface AdminEndpointSpec {
  method: "GET" | "POST" | "DELETE";
  /** 路径模板，:param 为路径参数（控制台会尝试用选中 uid 预填 :uid） */
  path: string;
  summary: string;
  params?: AdminParamSpec[];
  /** JSON 请求体示例 */
  body?: string;
}

export const ADMIN_ENDPOINTS: AdminEndpointSpec[] = [
  { method: "GET", path: "/api/asset", summary: "资产列表（?category=manifest|excel|file|mod|version&name=模糊搜索&limit=&offset=）", params: [{ name: "category", type: "string", desc: "资产分类" }, { name: "name", type: "string", desc: "按资产名模糊搜索" }] },
  { method: "GET", path: "/api/asset/lineage", summary: "资产溯源链（?name= 返回获取→转换→修改→下发完整事件链）", params: [{ name: "name", type: "string", required: true, desc: "资产名" }] },
  { method: "GET", path: "/api/asset/events", summary: "审计事件流（?action=acquire|transform|modify|deliver）" },
  { method: "GET", path: "/api/asset/events/stream", summary: "审计事件实时流（SSE 尾随）" },
  { method: "GET", path: "/api/plugin", summary: "Lua 插件列表（含启用状态与选项取值）" },
  { method: "POST", path: "/api/plugin/:id/enable", summary: "启用 Lua 插件", params: [{ name: "id", type: "string", required: true, desc: "插件 ID（enemy_hp / enemy_info / battle_assist / plugin_panel / options_panel / network_redirect / event_log_block）" }] },
  { method: "POST", path: "/api/plugin/:id/disable", summary: "停用 Lua 插件", params: [{ name: "id", type: "string", required: true, desc: "插件 ID" }] },
  { method: "GET", path: "/api/status", summary: "服务器状态（端口/离线模式/版本/用户数/数据文件）" },
  { method: "GET", path: "/api/users", summary: "用户列表（?filter= 按 uid/昵称/手机号过滤）", params: [{ name: "filter", type: "string", desc: "过滤关键字（匹配 uid/昵称/手机号）" }] },
  { method: "GET", path: "/api/users/:uid", summary: "用户详情（资源/道具中文名）" },
  {
    method: "POST",
    path: "/api/users",
    summary: "创建用户",
    params: [
      { name: "phone", type: "string", required: true, desc: "登录手机号" },
      { name: "password", type: "string", desc: "密码（缺省同手机号）" },
    ],
    body: '{"phone":"13800000000","password":"123456"}',
  },
  {
    method: "POST",
    path: "/api/users/:uid/grant",
    summary: "发放物品/资源（支持中文名/别名）",
    params: [
      { name: "itemId", type: "string", required: true, desc: "物品 ID 或中文名（如 4001 / 合成玉）" },
      { name: "count", type: "number", required: true, desc: "数量（正整数）" },
    ],
    body: '{"itemId":"4001","count":100}',
  },
  {
    method: "POST",
    path: "/api/users/:uid/grantchar",
    summary: "发放干员（重复按稀有度折算信物/凭证）",
    params: [
      { name: "charId", type: "string", required: true, desc: "干员 ID 或中文名（如 char_002_amiya / 阿米娅）" },
    ],
    body: '{"charId":"char_002_amiya"}',
  },
  {
    method: "POST",
    path: "/api/users/:uid/grantskin",
    summary: "解锁皮肤",
    params: [{ name: "skinId", type: "string", required: true, desc: "皮肤 ID（如 char_002_amiya#2）" }],
    body: '{"skinId":"char_002_amiya#2"}',
  },
  { method: "GET", path: "/api/users/:uid/chars", summary: "干员列表（中文名/星级/最大等级）" },
  { method: "GET", path: "/api/users/:uid/chars/:instId", summary: "单个干员详情（技能/专精/装备/语音/信赖）" },
  { method: "GET", path: "/api/users/:uid/shop", summary: "商店数据汇总（只读：各类型购买记录数）" },
  { method: "GET", path: "/api/users/:uid/checkin", summary: "玩家签到状态（只读：组/已签/总档位）" },
  { method: "POST", path: "/api/users/:uid/checkin/reset", summary: "重置签到（切到当前进行中签到组，清空进度）", body: "{}" },
  { method: "POST", path: "/api/users/:uid/checkin/do", summary: "代签（领取当前档位奖励，当日已签返回空）", body: "{}" },
  {
    method: "POST",
    path: "/api/users/:uid/chars",
    summary: "修改干员属性（免费路径，越界钳制）",
    params: [
      { name: "instId", type: "number", required: true, desc: "干员 instId" },
      { name: "level", type: "number", desc: "等级（≤ 当前精二阶段 maxLevel）" },
      { name: "evolvePhase", type: "number", desc: "精二阶段" },
      { name: "potentialRank", type: "number", desc: "潜能" },
      { name: "mainSkillLvl", type: "number", desc: "技能等级" },
    ],
    body: '{"instId":1,"level":90,"evolvePhase":2}',
  },
  { method: "POST", path: "/api/users/:uid/maxout", summary: "一键满配（资源/背包/干员/基建/皮肤，不覆盖阵容）", body: "{}" },
  { method: "POST", path: "/api/users/:uid/building-max", summary: "基建满级", body: "{}" },
  { method: "POST", path: "/api/users/:uid/building-advance", summary: "基建加速（快进 seconds 秒并结算产出）", body: '{"seconds":3600}' },
  { method: "POST", path: "/api/users/:uid/backup", summary: "备份存档", body: "{}" },
  { method: "GET", path: "/api/users/:uid/backups", summary: "备份列表（按时间倒序）" },
  {
    method: "POST",
    path: "/api/users/:uid/restore",
    summary: "从备份恢复（文件名白名单防路径穿越）",
    params: [{ name: "backup", type: "string", required: true, desc: "备份文件名（users backups 查看）" }],
    body: '{"backup":"1-20260808-181345.json"}',
  },
  { method: "GET", path: "/api/users/:uid/raw", summary: "完整玩家数据 JSON（只读）" },
  { method: "GET", path: "/api/users/:uid/mails", summary: "用户邮件列表（附件中文名）" },
  {
    method: "DELETE",
    path: "/api/users/:uid/mails/:mailId",
    summary: "删除单封邮件",
    params: [{ name: "mailId", type: "number", required: true, desc: "邮件 ID" }],
  },
  {
    method: "POST",
    path: "/api/mail",
    summary: "发送邮件",
    params: [
      { name: "uid", type: "string", required: true, desc: "接收者 uid" },
      { name: "subject", type: "string", required: true, desc: "标题" },
      { name: "content", type: "string", desc: "正文" },
      { name: "items", type: "object", desc: "附件 [{id, count}]" },
    ],
    body: '{"uid":"1","subject":"标题","content":"正文","items":[{"id":"4001","count":100}]}',
  },
  {
    method: "POST",
    path: "/api/mail/all",
    summary: "群发邮件（全部用户）",
    params: [
      { name: "subject", type: "string", required: true, desc: "标题" },
      { name: "content", type: "string", desc: "正文" },
      { name: "items", type: "object", desc: "附件 [{id, count}]" },
    ],
    body: '{"subject":"公告","content":"","items":[{"id":"4001","count":100}]}',
  },
  { method: "POST", path: "/api/users/:uid/refresh", summary: "触发每日/每周刷新（理智/任务重置）", body: "{}" },
  { method: "POST", path: "/api/users/:uid/save", summary: "立即保存存档", body: "{}" },
  { method: "GET", path: "/api/stats", summary: "统计聚合（等级/注册分布、资源合计）" },
  { method: "GET", path: "/api/logs", summary: "管理操作审计日志", params: [{ name: "limit", type: "number", desc: "条数（默认 50）" }] },
  { method: "GET", path: "/api/common-items", summary: "常用物品别名表" },
  { method: "GET", path: "/api/mail-templates", summary: "邮件模板列表（补偿/公告/欢迎，CLI mail send --template 用）" },
  { method: "GET", path: "/api/official/backend", summary: "当前官服操作后端（enabled + game/account/conf 地址，config.officialBackend 配置）" },
  { method: "GET", path: "/api/mapviz-data", summary: "地图可视化数据（主题关卡池 + rogue_6 gridzone 构造模板/规则，供 dashboard 地图 tab）" },
  {
    method: "POST",
    path: "/api/rogue/sim-auto",
    summary: "肉鸽流程自动模拟（开局→逐层→结算，不含战斗）",
    params: [
      { name: "uid", type: "string", required: true, desc: "目标玩家 uid" },
      { name: "theme", type: "string", required: true, desc: "主题（rogue_1..6）" },
      { name: "maxZone", type: "number", desc: "模拟到第几层为止（缺省到底）" },
    ],
    body: '{"uid":"1","theme":"rogue_1","maxZone":3}',
  },
  {
    method: "POST",
    path: "/api/rogue/sim-step",
    summary: "肉鸽流程分步模拟（白名单单步，经 /rlv2 代理）",
    params: [
      { name: "uid", type: "string", required: true, desc: "目标玩家 uid" },
      { name: "action", type: "string", required: true, desc: "rlv2 端点名（createGame/finishEvent/moveTo/selectChoice/gameSettle 等）" },
    ],
    body: '{"uid":"1","action":"moveTo","body":{"to":{"x":0,"y":0}}}',
  },
  { method: "GET", path: "/api/rogue/state", summary: "肉鸽流程当前状态快照（rlv2.toJSON，分步模式用）", params: [{ name: "uid", type: "string", desc: "目标玩家 uid" }] },
  { method: "GET", path: "/api/activity/list", summary: "活动列表 + 开关状态（activity 切换：冻结时间戳/生效时间戳/强制开启/合约赛季与各活动 open/forced）" },
  {
    method: "POST",
    path: "/api/activity/switch",
    summary: "切换活动：时间冻结 + 强制开启 + 合约赛季（timestamp=-1 恢复真实时间，仅限过去；forceOpen 忽略时间窗口；crisisV1/crisisV2 选择赛季）",
    params: [
      { name: "timestamp", type: "number", desc: "-1=真实时间；或活动窗口内的过去时间戳（建议取活动 startTime）" },
      { name: "forceOpen", type: "string", desc: "强制开启的活动 ID 列表（逗号分隔，basicInfo.id，忽略时间窗口播种且不修剪）" },
      { name: "crisisV1", type: "string", desc: "危机合约V1赛季（data/crisis/*.json 文件名，如 cc3）" },
      { name: "crisisV2", type: "string", desc: "危机合约V2赛季（data/crisisV2/*.json 文件名，如 cc3）" },
    ],
    body: '{"timestamp":1785538800,"forceOpen":["act1arkhub"],"crisisV1":"cc3","crisisV2":"cc1"}',
  },
  { method: "POST", path: "/api/asset/backfill", summary: "启动资产补全后台任务（补全过往活动缺失 asset；target=all|活动id|危机赛季id）", params: [{ name: "target", type: "string", required: true, desc: "all=全部关卡；或活动 id / 危机赛季 id" }, { name: "platform", type: "string", desc: "Android|Windows，缺省 Android" }], body: '{"target":"cc3"}' },
  { method: "GET", path: "/api/asset/backfill/:id", summary: "查询资产补全后台任务状态（running/done/error + 统计）" },
  { method: "GET", path: "/api/asset/backfill", summary: "最近资产补全后台任务列表（新→旧，最多 20 条）" },
  {
    method: "POST",
    path: "/api/cli/exec",
    summary: "CLI 集成：服务器内执行 CLI 命令（复用 admin-cli dispatch，输出捕获返回）",
    params: [{ name: "command", type: "string", required: true, desc: "CLI 命令文本（如 users list --json、gacha pools）" }],
    body: '{"command":"users list --json"}',
  },
  { method: "GET", path: "/api/pools", summary: "卡池清单（poolId/名称/规则/开闭池/保底）" },
  { method: "GET", path: "/api/pools/:poolId", summary: "卡池详情（UP/可用干员 + 概率）" },
  { method: "GET", path: "/api/users/:uid/pools/:poolId", summary: "玩家卡池状态（UP 选择 + 保底计数）" },
  {
    method: "POST",
    path: "/api/users/:uid/pools/:poolId/up",
    summary: "设置玩家卡池 UP 选择（charIds 空数组清除）",
    params: [{ name: "charIds", type: "object", desc: "UP 干员 ID 数组，如 [\"char_002_amiya\"]" }],
    body: '{"charIds":["char_002_amiya"]}',
  },
  {
    method: "POST",
    path: "/api/users/:uid/pity",
    summary: "设置玩家保底计数（按 gachaRuleType，如 NORMAL/LIMITED/CLASSIC）",
    params: [
      { name: "ruleType", type: "string", required: true, desc: "抽卡规则类型（NORMAL/LIMITED/CLASSIC/ATTAIN/LINKAGE…）" },
      { name: "count", type: "number", required: true, desc: "非负整数（距离保底的抽数）" },
    ],
    body: '{"ruleType":"NORMAL","count":50}',
  },
  {
    method: "POST",
    path: "/api/official/migrate",
    summary: "官服账号迁移（联网拉取官服数据 → 注册私服账号；需公网访问官服）",
    params: [
      { name: "accounts", type: "string", required: true, desc: "账号内容（每行 手机号 密码，或两行一组 手机号\\n密码）" },
      { name: "templateUid", type: "string", desc: "模板存档 uid（私服特有字段兜底，默认 1）" },
    ],
    body: '{"accounts":"13800000000\\npassword123","templateUid":"1"}',
  },
  {
    method: "POST",
    path: "/api/official/action",
    summary: "官服操作（登录官服执行签到/邮件等；status/signin/mails/receive/daily，无状态会话即用即弃）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "action", type: "string", required: true, desc: "status/signin/mails/receive/daily" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","action":"signin"}',
  },
  {
    method: "POST",
    path: "/api/official/call",
    summary: "官服通用 API 调用（登录后调用任意官方 cgi，如 /user/checkIn）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "cgi", type: "string", required: true, desc: "官服接口路径（/xxx/yyy 形式）" },
      { name: "body", type: "object", desc: "请求体（可选）" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","cgi":"/mail/getMetaInfoList","body":{"from":0}}',
  },
  {
    method: "POST",
    path: "/api/official/sync-gacha",
    summary: "从官服同步卡池详情（补全模式：跳过本地已有池，只抓缺失新池；refresh=true 全量刷新；写 gacha_detail_table.json，备份 .bak，重启生效）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "poolIds", type: "object", desc: "目标池列表（缺省读本地 gachaPoolClient 全部）" },
      { name: "refresh", type: "boolean", desc: "true = 全量刷新（不跳过已有），缺省补全模式" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","poolIds":["NORM_0_1_3"],"refresh":false}',
  },
  {
    method: "POST",
    path: "/api/pixel/upload-official",
    summary: "上传像素画到官服 arkhub（24×24×3 RGB → 网关申请 token → multipart savePixelArt → 保存确认）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "pixelData", type: "object", required: true, desc: "24×24×3 RGB（1728 长度数组，或 576 长度 {r,g,b} 数组）" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","pixelData":[255,255,255,...]}',
  },
  {
    method: "POST",
    path: "/api/pixel/upload-batch",
    summary: "批量上传像素画到官服 arkhub（大图拆分多张 24×24 逐张上传，逐张返回结果）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "pixelDataList", type: "object", required: true, desc: "多张 24×24×3 RGB 数组（每项 1728 长度）" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","pixelDataList":[[255,255,255,...]]}',
  },
  {
    method: "POST",
    path: "/api/pixel/list-official",
    summary: "读取官服已上传像素画（HTTP getPixelArt + OSS .dat 下载解析，返回缩略像素数组）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "pixelArtIds", type: "object", desc: "像素画 ID 列表（缺省读全部）" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","pixelArtIds":[1001,1002]}',
  },
  {
    method: "POST",
    path: "/api/pixel/delete-official",
    summary: "撤销（删除）官服已上传像素画（网关 DeletePixelArtReq）",
    params: [
      { name: "phone", type: "string", required: true, desc: "官服手机号" },
      { name: "pwd", type: "string", required: true, desc: "官服密码" },
      { name: "pixelArtIds", type: "object", required: true, desc: "要删除的像素画 ID 列表" },
    ],
    body: '{"phone":"13800000000","pwd":"password123","pixelArtIds":[1001,1002]}',
  },
  {
    method: "POST",
    path: "/api/users/:uid/grant-all",
    summary: "批量发放全部 ItemTable 物品（sortId>0；CONSUME→consumable，其余→inventory）",
    params: [{ name: "count", type: "number", desc: "每样数量（默认 999）" }],
    body: '{"count":999}',
  },
  { method: "POST", path: "/api/users/:uid/maxchars", summary: "批量拉满全部已有干员（精二满级/满潜/满技能/专三/满信赖/装备）", body: "{}" },
  { method: "POST", path: "/api/users/:uid/repair-chars", summary: "修复干员结构（补齐 voiceLan/starMark/equip/skills/阿米娅 tmpl）", body: "{}" },
  { method: "GET", path: "/api/users/:uid/stages", summary: "玩家推图进度（只读：已解锁/已完成关卡）" },
  {
    method: "POST",
    path: "/api/users/:uid/stages/unlock",
    summary: "解锁指定关卡（标记已完成）",
    params: [{ name: "stageId", type: "string", required: true, desc: "关卡 ID（如 main_01-01）" }],
    body: '{"stageId":"main_01-01"}',
  },
  { method: "POST", path: "/api/users/:uid/stages/unlock-all", summary: "推图全解锁（遍历 StageTable，跳过已有进度）", body: "{}" },
  { method: "GET", path: "/api/items", summary: "物品搜索（按 ID/中文名过滤 ItemTable，供发放选择）", params: [{ name: "q", type: "string", desc: "关键字（空返回前 50 条）" }, { name: "limit", type: "number", desc: "条数（默认 50）" }] },
  { method: "GET", path: "/api/users/:uid/missions", summary: "任务进度统计（只读：各组任务数/已完成数）" },
  { method: "GET", path: "/api/users/:uid/activity", summary: "活动数据摘要（只读：各类型活动数）" },
  { method: "GET", path: "/api/users/:uid/medals", summary: "勋章进度（只读：已解锁/总数）" },
  {
    method: "POST",
    path: "/api/users/:uid/export",
    summary: "导出用户存档到 JSON 文件（默认 ./exports/{uid}-{ts}.json）",
    params: [{ name: "path", type: "string", desc: "目标路径（可选）" }],
    body: '{"path":"./exports/1-backup.json"}',
  },
  {
    method: "POST",
    path: "/api/import",
    summary: "从 JSON 文件导入存档（替换指定 uid；uid 缺省取文件内 status.uid）",
    params: [
      { name: "filePath", type: "string", required: true, desc: "存档 JSON 路径" },
      { name: "uid", type: "string", desc: "目标 uid（缺省取文件内 status.uid）" },
    ],
    body: '{"filePath":"./exports/1-backup.json","uid":"1"}',
  },
  { method: "GET", path: "/api/check", summary: "数据完整性校验（已加载用户 status/troop/干员结构/可序列化）" },
  { method: "GET", path: "/api/check-files", summary: "存档文件级校验（磁盘全部 databases/*.json，含未加载用户）" },
  { method: "GET", path: "/api/openapi.json", summary: "OpenAPI 3.0 规范（管理 API，供外部工具消费）" },
  { method: "GET", path: "/api/config", summary: "查看配置（只读）" },
  {
    method: "POST",
    path: "/api/game-proxy",
    summary: "游戏协议代理（带玩家 secret 调用游戏端点，返回 {status, data}）",
    params: [
      { name: "uid", type: "string", required: true, desc: "目标玩家 uid（取其 secret 认证）" },
      { name: "path", type: "string", required: true, desc: "游戏端点路径（如 /user/info、/gacha/advancedGacha）" },
      { name: "method", type: "string", desc: "GET/POST/DELETE（默认 GET）" },
      { name: "body", type: "object", desc: "请求体 JSON" },
    ],
    body: '{"uid":"1","path":"/user/info","method":"GET"}',
  },
  { method: "GET", path: "/api/spec", summary: "本端点规范（Dashboard 接口控制台数据源）" },

  /* ---- 统一抓包管理 ---- */
  { method: "GET", path: "/api/capture/sessions", summary: "抓包会话列表（含记录数；最新在前）" },
  {
    method: "POST",
    path: "/api/capture/sessions",
    summary: "新建抓包会话",
    params: [
      { name: "name", type: "string", required: true, desc: "会话名称" },
      { name: "source", type: "string", desc: "来源（private/official/harness/gateway/ops）" },
    ],
    body: '{"name":"登录链路","source":"official"}',
  },
  { method: "POST", path: "/api/capture/sessions/:id/stop", summary: "停止抓包会话", body: "{}" },
  { method: "DELETE", path: "/api/capture/sessions/:id", summary: "删除会话（级联删除其全部记录）" },
  {
    method: "GET",
    path: "/api/capture/records",
    summary: "抓包记录列表（过滤+分页：sessionId/source/method/path/module/status/direction/q/from/to）",
    params: [
      { name: "sessionId", type: "string", desc: "会话 id" },
      { name: "source", type: "string", desc: "来源（private/official/harness/gateway/ops）" },
      { name: "method", type: "string", desc: "HTTP 方法（GET/POST…）" },
      { name: "path", type: "string", desc: "路径子串" },
      { name: "status", type: "number", desc: "响应状态码" },
      { name: "q", type: "string", desc: "路径/模块/接口关键字" },
      { name: "from", type: "number", desc: "起始时间（epoch ms）" },
      { name: "to", type: "number", desc: "结束时间（epoch ms）" },
      { name: "limit", type: "number", desc: "条数（默认 100，最大 1000）" },
      { name: "offset", type: "number", desc: "偏移（默认 0）" },
    ],
  },
  { method: "GET", path: "/api/capture/records/:id", summary: "抓包记录详情（请求/响应头 + body 内容）" },
  { method: "DELETE", path: "/api/capture/records/:id", summary: "删除单条抓包记录" },
  {
    method: "POST",
    path: "/api/capture/clear",
    summary: "清空全部抓包（危险操作）",
    params: [{ name: "confirmWord", type: "string", required: true, desc: "确认词 CLEAR" }],
    body: '{"confirmWord":"CLEAR"}',
  },
  { method: "GET", path: "/api/capture/stats", summary: "抓包统计（总数/来源/状态码/按天）" },
  { method: "GET", path: "/api/capture/sessions/:id/export", summary: "导出会话 zip 下载" },
  { method: "GET", path: "/api/capture/records/:id/export", summary: "导出单条记录 zip 下载" },
  { method: "GET", path: "/api/capture/stream", summary: "抓包实时流（SSE，?token= 认证；回填 50 条后直播）" },

  /* ---- 统一日志管理 ---- */
  {
    method: "GET",
    path: "/api/logs/server",
    summary: "服务器日志（日期/级别/标签/关键字过滤 + 分页，倒序）",
    params: [
      { name: "date", type: "string", desc: "日期 YYYYMMDD（缺省当天）" },
      { name: "level", type: "string", desc: "级别 DEBUG/INFO/WARN/ERROR" },
      { name: "tag", type: "string", desc: "标签（如 index/capture）" },
      { name: "q", type: "string", desc: "内容关键字" },
      { name: "limit", type: "number", desc: "条数（默认 100，最大 2000）" },
      { name: "offset", type: "number", desc: "偏移（默认 0）" },
    ],
  },
  { method: "GET", path: "/api/logs/server/dates", summary: "服务器日志可用日期列表（倒序）" },
  { method: "GET", path: "/api/logs/watchdog", summary: "看门狗日志（文件列表 + 行）" },
  {
    method: "GET",
    path: "/api/logs/audit",
    summary: "审计日志（action/uid/关键字过滤；兼容旧 GET /api/logs）",
    params: [
      { name: "action", type: "string", desc: "操作名（如 grantItem）" },
      { name: "uid", type: "string", desc: "目标 uid" },
      { name: "q", type: "string", desc: "关键字" },
      { name: "limit", type: "number", desc: "条数（默认 100）" },
    ],
  },
  {
    method: "POST",
    path: "/api/logs/server/clear",
    summary: "清空服务器日志（危险操作）",
    params: [{ name: "confirmWord", type: "string", required: true, desc: "确认词 CLEAR" }],
    body: '{"confirmWord":"CLEAR"}',
  },
  { method: "GET", path: "/api/logs/stream", summary: "日志实时流（SSE，?kind=server|audit|capture；回填 50 条后直播）" },
];
