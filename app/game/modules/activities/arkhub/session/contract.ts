/**
 * arkhub 网关会话——跨层类型契约
 *
 * 连接状态 / 处理上下文 / 帧形状 / 服务端配置回调：由 handlers（业务）、dispatch（帧分发）、
 * server（传输装配）三方共享，单独成文件避免循环依赖（原内联在 gateway/router.ts）。
 * 层次：messages → codec → contract → dispatch → handlers → server。
 */
/**
 * 玩家奇象展册户籍数据（EnterSceneNotify PlayerSyncData f5-f9 的数据源）。
 * 来源：私服存档 ARK_HUB.act1arkhub（dex 图鉴收录 / scanBag 持有个体 / coin 券 / props 道具箱）。
 */
export interface ArkdexDocsData {
  /** 图鉴收录种类集（key = numId 字符串，value 计 1/可忽略 → CreatureCollection.template_id） */
  dex: Record<string, number>;
  /** 持有的生物个体（→ Creature：id→unique_id，numId→template_id，source→source） */
  scanBag: Array<{ id: number; numId: number; persona?: number; source?: string }>;
  /** 奇象兑换券（→ ArkhubItemData.coin） */
  coin: number;
  /** 巡展道具箱（→ ArkhubItemData.items[item_id, count]；可空） */
  items?: Array<{ itemId: number; count: number }>;
}

/** 本地网关启动选项（index.ts 注入私服玩法回调） */
export interface ArkhubSessionServerOptions {
  /** 本机监听端口（缺省 30000，对齐官服网关端口） */
  port?: number;
  /** 端口被占时自动避让尝试次数上限（缺省 50：port, port+1, ...） */
  maxPortTries?: number;
  /** 可选：按 uid 解析玩家昵称（旧接口；新实现用 resolvePlayerProfile 统一返回） */
  resolveNickname?: (uid: string) => string;
  /** 可选：按 uid 解析广场玩家资料（昵称/等级/秘书干员/皮肤——客户端据此渲染玩家模型） */
  resolvePlayerProfile?: (uid: string) => {
    nickname?: string;
    level?: number;
    charId?: string;
    skinId?: string;
    avatarId?: string;
  };
  /**
   * 可选：网关登录时确保玩家存档已加载到内存（含 ARK_HUB 播种）。
   * 背景：网关登录不经过 HTTP 请求链，若存档未被加载（懒加载仅在 HTTP 首访触发），
   * 后续场景帧的户籍（resolveArkdexDocs）/购买扣券等回调全部读不到玩家 → 捕捉区功能不解锁。
   */
  ensurePlayerLoaded?: (uid: string) => Promise<void> | void;
  /**
   * 可选：ARKDUEL 战斗结算回调（uid=已登录账号；私服据此发券 + 对战计数）。
   * win 由回合结算上报帧（f8fa293a）的 winner 字段判定（胜局带胜者 uid、负局仅终局报，
   * 官服抓包 + 反编译双证）；解析失败/空上报保守按胜（不扣玩家）。
   */
  onDuelSettle?: (uid: string, win: boolean) => void;
  /** 可选：每日物资领取回调（uid；私服据此记录领取天数 + 发 100 券） */
  onDailySupplyClaimed?: (uid: string) => void;
  /**
   * 可选：按 uid 解析枢纽 GuideFlags（渐进引导/剧情推进）。
   * 返回完整 flag 表（含完成态兜底）；返回 undefined 时用网关默认完成态。
   * 支持异步（动态加载玩法模块场景）——登录后 fire-and-forget 更新，场景 hello 前生效。
   * 缺省不提供 → 维持"全完成态"（不触发任何引导，对齐官服完成态快照）。
   */
  resolveGuideFlags?: (
    uid: string,
  ) => Record<string, number> | undefined | Promise<Record<string, number> | undefined>;
  /**
   * 可选：枢纽引导推进回调（交互帧 actor 命中引导链时；私服据此落持久化 + 出展指引任务）。
   * 与 onDuelSettle/onDailySupplyClaimed 同源（index.ts 注入 arkhub.ts 的 arkhubAdvanceGuide）。
   */
  onGuideAdvance?: (uid: string, actorId: string, operationId: string) => void;
  /**
   * 可选：按 uid 解析玩家当前奇象兑换券数（arkdex_1_gold 持有量）。
   * 引导推进广播（38b36462）的 f2.f1 需携带当前券数（官服实锤：领奖后 f2={1:155,...}）；
   * 私服从 ARK_HUB.act1arkhub.coin 读。缺省返回 0。
   */
  resolveArkDexGold?: (uid: string) => number;
  /**
   * 可选：按 uid 解析玩家奇象展册户籍数据（ARK_HUB.act1arkhub：dex/scanBag/coin/道具箱）。
   * 场景帧（EnterSceneNotify）的 PlayerSyncData 据此构造 f5-f9（生物图鉴/道具/像素/状态/功能位）
   * ——客户端没有这些字段时"数据库/功能"显示未解锁（户籍裁剪）。
   * 返回 undefined 时维持现状（场景帧不带 f5-f9，不影响既有用例）。
   */
  resolveArkdexDocs?: (uid: string) => ArkdexDocsData | undefined;
  /**
   * 可选：捕捉开始回调（StartCaptureReq b7c267d7 后，捕获区场景时）。
   * **同步**返回本轮遭遇（私服读上一轮已落盘的 ARK_HUB.arkdexState.activeEncounter，
   * 错开一帧避免 async 竞态），并异步触发下一轮遭遇生成；返回 undefined 时网关回落兜底集。
   */
  onScanStart?: (
    uid: string,
    areaId: number | string,
  ) => { creatures: number[]; lureNumId?: number } | undefined;
  /**
   * 可选：捕捉结算回调（EndCaptureReq b7c204e8 后，捕获成功时）。
   * capturedNumIds = 客户端上报的捕获槽位对应的生物种类 id——私服据此调
   * arkhubEndScan（扫描成功 15 券 + 数据库收录 + 扫描仪入袋，失败无奖励）。
   */
  onScanSettle?: (uid: string, capturedNumIds: number[]) => void;
  /**
   * 可选：巡展道具购买回调（购买帧 28f56f2c；私服据此扣券 + 道具箱 +
   * 生效次数 + 每日库存限购——arkhubBuyProp）。返回 { ok, code }：code 为
   * ActArkhubErrorCode 官方错误码（响应用之弹对应文案提示）；返回 undefined（未接线）视为成功。
   */
  onBuyProp?: (
    uid: string,
    itemNumId: number,
    count: number,
  ) => { ok: boolean; code: number } | Promise<{ ok: boolean; code: number } | undefined> | undefined;
  /**
   * 可选：巡展道具使用回调（使用帧 28f5b1ab；诱引剂写 activeLure 定向遭遇池，
   * 信息素发射任务 15 事件——arkhubUseProp/arkhubPheromoneScan）。
   * 返回 { ok, code }：失败时 code 为官方错误码（602/603）。
   */
  onUseProp?: (
    uid: string,
    itemNumId: number,
    count: number,
  ) => { ok: boolean; code: number } | Promise<{ ok: boolean; code: number } | undefined> | undefined;
  /**
   * 可选：交换预设回调（PresetCreatureExchangeReq b7c2369e：{1:想要的种类, 2:给出的个体}）。
   * 私服据此落 ARK_HUB.trade（arkhubSetTrade）。
   */
  onTradePreset?: (uid: string, wantNumId: number, givingUniqueId: number) => void;
  /** 可选：发起交换回调（CreateCreatureExchangeReq b7c2394d；任务 16 计数——arkhubDoTrade） */
  onTradeCreate?: (uid: string) => void;
  /**
   * 可选：按 uid 解析玩家当前交换挂单（GetAllCreatureExchangeInfoResp 的 requests 回填，
   * 单机：回显自己的挂单）。数据源 ARK_HUB.trade（arkhubSetTrade 落）。
   */
  resolveTrade?: (
    uid: string,
  ) => { wantSpecies: number; offeringUniqueId: number; ts: number } | undefined;
  /**
   * 可选：按 uid 解析当日货架道具 numId（hub.shopToday 落盘值，日期匹配时）；
   * 缺省/跨日回落网关侧确定性生成（同算法，保证价格表与购买校验一致）。
   */
  resolveShopIds?: (uid: string) => number[] | undefined;
  /** 可选：商店打开/购买后货架落盘回调（hub.shopToday；arkhubPersistShopToday） */
  onShopResolved?: (uid: string, ids: number[]) => void;
  /** 可选：按 uid 解析玩家当前奇象兑换券数（购买响应 f6 剩余券数；缺省 0） */
  resolveCoin?: (uid: string) => number;
  /**
   * 可选：登录/重连时按 uid 解析持久化的网关状态（连接状态恢复：重连/重启不丢）。
   * 数据源：存档 ARK_HUB.act1arkhub（stateMask/settledDuels）+ activeEncounter（捕捉会话）。
   */
  resolveGatewayState?: (uid: string) =>
    | {
        stateMask?: number;
        settledDuels?: string[];
        encounter?: { creatures: number[]; lureNumId?: number };
      }
    | undefined;
  /** 可选：状态掩码变更持久化回调（每次 stateMask 变化后触发；arkhubSetStateMask） */
  onStateMaskChanged?: (uid: string, mask: number) => void;
  /** 可选：对局结算去重键持久化回调（整局结算后触发；arkhubRecordSettledDuel） */
  onDuelSettled?: (uid: string, battleId: string) => void;
  /**
   * 可选：交互领奖一次性闸门（get_reward 提交时调用）。
   * 返回 true=首次领取（已记录，正常发奖）；false=已领过（仅回 ACK，不发奖/不提示）。
   * claimKey：一次性演员=actorId；每日演员=`actorId:自然日`（次日可再领）。未配置时不拦截。
   */
  claimActorReward?: (uid: string, claimKey: string) => boolean;
  /** 可选：按 uid 解析今日是否已领每日物资（每日奖励推送券数修正用） */
  resolveDailyClaimed?: (uid: string) => boolean;
}

/** 单条连接的可变状态（handler 直接读写；按连接维护，不跨连接保留） */
export interface ArkhubSessionConnectionState {
  /** 当前连接的登录 uid（登录帧解析；场景 hello 用它构建自己的玩家条目） */
  uid: string;
  /** 当前场景 map_id（初始 TOWN；切场景后更新） */
  currentMapId: number;
  /** 枢纽 GuideFlags（按连接维护——mmkabi 引导领奖后 capture_catch_guide_02 1→2） */
  guideState: Record<string, number>;
  /**
   * 本次捕捉的遭遇会话（capture 链路：EndCaptureReq 结算入参 + EncounterCreatureNotify
   * 推送数据源）。位于捕捉区时 StartCaptureReq 同步读 onScanStart 返回的遭遇填入；
   * 无遭遇时回填本地兜底集（私服降级）。结算后清空。
   */
  encounter?: {
    /** 遭遇生物种类 id（模板 numId，顺序 = 客户端捕获槽位索引） */
    creatures: number[];
    /** 定向本次遭遇的生效道具（诱引剂/信息素；可空） */
    lureNumId?: number;
  };
  /** 已结算的对局 battle_id 集（BO3 每回合上报，按局去重防重复发券） */
  settledDuelBattles: Set<string>;
  /**
   * 玩家状态掩码（反编译 ActArkhubPlayerStateMask/ActArkhubServerPlayerStatusMask：
   * IDLE=0 / MOVE=1 / SPECIAL=2 / INTERACT=0x100 / MATCHING=0x200 /
   * CAPTURE_BATTLE=0x400 / DUEL_BATTLE=0x800 / PIXEL_CREATE=0x1000）。
   * 客户端 ModifyPlayerActionReq(SET/CLEAR) 上报 + 玩法节点服务端驱动，经
   * PlayerAlterDataNotify(38b36462) f1 下发驱动客户端状态机（官服抓包实锤）。
   */
  stateMask: number;
}

/** 解析后的一帧（传输层切帧后交给路由层） */
export interface ArkhubSessionFrame {
  /** 消息族 ID（1=心跳 / 2=心跳回显 / 4=登录 / 8=玩法帧） */
  mainID: number;
  /** 完整 64 位 subID */
  subID: bigint;
  /** 低 32 位 subID（玩法帧段内消息号，随场景前缀变化） */
  low32: bigint;
  /** 帧体（protobuf，部分帧含 [4B 请求序号] 前缀） */
  body: Buffer;
}

/** handler 执行上下文（连接状态 + 网关配置 + 发送能力） */
export interface ArkhubSessionHandlerContext {
  /** 连接级可变状态（uid/场景/引导/遭遇），handler 直接读写 */
  state: ArkhubSessionConnectionState;
  /** 服务器级配置回调（index.ts 注入，见 ArkhubSessionServerOptions） */
  opts: ArkhubSessionServerOptions;
  /**
   * 发送一帧（mainID + subID + body）——传输层注入：写 socket 并记录收发日志。
   * handler 用其返回应答/推送帧。
   */
  send: (mainID: number, subID: bigint, proto: Buffer) => void;
}

/** 单帧处理函数（业务逻辑——见 handlers/*） */
export type ArkhubSessionFrameHandler = (
  ctx: ArkhubSessionHandlerContext,
  frame: ArkhubSessionFrame,
) => void;
