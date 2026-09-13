/**
 * arkhub 网关帧分发（dispatch 层）
 *
 * 把「帧 → 应答」的 dispatch 从业务实现中剥离：
 *   - 传输层（session/server.ts）只负责组帧/切帧/收发/日志；
 *   - 业务层（session/handlers/*）按 (mainID, subID) 注册处理函数；
 *   - 分发层（本模块）按帧头 mainID/subID 分发到对应 handler。
 *
 * 匹配规则（按优先级）：
 *   1. main 级 handler（mainID 精确，如心跳 main=1）
 *   2. full 匹配（整 64 位 subID，如登录 0x0fa1 / 场景 hello 0x00018fb64de29cdb）
 *   3. low32 匹配（低 32 位，如玩法帧 subID 高 32 位是会话/场景前缀，随场景变化）
 *   4. fallback（未注册帧的兜底——main=8 回通用 ACK，其余仅日志）
 *
 * 类型契约见 ./contract，帧常量见 ./messages。
 */
import { FRAME_NAMES } from "./codec";
import type {
  ArkhubSessionFrameHandler,
  ArkhubSessionFrame,
  ArkhubSessionHandlerContext,
} from "./contract";

/** 路由匹配模式 */
type MatchMode = "full" | "low";

/** 已注册路由条目 */
interface RegisteredRoute {
  /** 语义名（日志/自检用） */
  name: string;
  /** 处理函数 */
  handler: ArkhubSessionFrameHandler;
  /** 匹配模式：full=整 64 位、low=低 32 位 */
  mode: MatchMode;
}

/**
 * arkhub 网关帧路由器
 *
 * 注册表 + dispatch：
 *   register      —— 整 64 位 subID 精确匹配（登录/场景 hello 等）
 *   registerLow   —— 低 32 位匹配（玩法帧，高 32 位会话/场景前缀随场景变化）
 *   registerMain  —— mainID 级匹配（心跳等无 subID 语义的帧）
 *   setFallback   —— 未注册帧兜底（main=8 通用 ACK）
 *   dispatch      —— 按 mainID/subID 分发；未命中走 fallback
 *   nameOf        —— 查帧名（日志可读化；未注册时回退 FRAME_NAMES / "未知"）
 *   routes        —— 路由表（自检/文档）
 */
export class ArkhubSessionFrameRouter {
  /** mainID 级路由（mainID → 条目） */
  private readonly mainRoutes = new Map<number, RegisteredRoute>();
  /** subID 级路由（`${mainID}:${mode}:${hex}` → 条目） */
  private readonly subRoutes = new Map<string, RegisteredRoute>();
  /** 未注册帧兜底 */
  private fallbackRoute: RegisteredRoute | null = null;

  /**
   * 注册整 64 位 subID 精确匹配路由
   *
   * @param mainID - 消息族 ID
   * @param subID - 完整 64 位 subID
   * @param name - 语义名
   * @param handler - 处理函数
   * @returns this（链式）
   */
  register(mainID: number, subID: bigint, name: string, handler: ArkhubSessionFrameHandler): this {
    this.subRoutes.set(`${mainID}:full:${subID.toString(16)}`, { name, handler, mode: "full" });
    return this;
  }

  /**
   * 注册低 32 位匹配路由（玩法帧——subID 高 32 位为会话/场景前缀）
   *
   * @param mainID - 消息族 ID（玩法帧恒为 8）
   * @param low32 - 低 32 位 subID
   * @param name - 语义名
   * @param handler - 处理函数
   * @returns this（链式）
   */
  registerLow(mainID: number, low32: bigint, name: string, handler: ArkhubSessionFrameHandler): this {
    this.subRoutes.set(`${mainID}:low:${low32.toString(16)}`, { name, handler, mode: "low" });
    return this;
  }

  /**
   * 注册 mainID 级路由（心跳等无 subID 语义的帧）
   *
   * @param mainID - 消息族 ID
   * @param name - 语义名
   * @param handler - 处理函数
   * @returns this（链式）
   */
  registerMain(mainID: number, name: string, handler: ArkhubSessionFrameHandler): this {
    this.mainRoutes.set(mainID, { name, handler, mode: "full" });
    return this;
  }

  /**
   * 设置未注册帧的兜底处理（main=8 回通用 ACK {1:100}；其余 main 仅日志——见传输层装配）
   *
   * @param name - 兜底名
   * @param handler - 处理函数
   * @returns this（链式）
   */
  setFallback(name: string, handler: ArkhubSessionFrameHandler): this {
    this.fallbackRoute = { name, handler, mode: "full" };
    return this;
  }

  /**
   * 分发一帧到对应 handler
   *
   * 优先级：main 级 → full → low32 → fallback。
   *
   * @param ctx - 处理上下文（连接状态 + 配置 + send）
   * @param frame - 解析后的一帧
   */
  dispatch(ctx: ArkhubSessionHandlerContext, frame: ArkhubSessionFrame): void {
    const route =
      this.mainRoutes.get(frame.mainID) ??
      this.subRoutes.get(`${frame.mainID}:full:${frame.subID.toString(16)}`) ??
      this.subRoutes.get(`${frame.mainID}:low:${frame.low32.toString(16)}`) ??
      this.fallbackRoute;
    if (!route) return;
    route.handler(ctx, frame);
  }

  /**
   * 查帧名（日志可读化）
   *
   * 先查已注册路由（请求帧），再回退 FRAME_NAMES（响应/广播 subID 未注册为路由），最后 "未知"。
   *
   * @param mainID - 消息族 ID
   * @param subID - 完整 64 位 subID
   * @returns 帧名（含官方消息名；未识别为 "未知"）
   */
  nameOf(mainID: number, subID: bigint): string {
    const lowKey = (subID & 0xffffffffn).toString(16).padStart(8, "0");
    const fullKey = subID.toString(16);
    const route =
      this.subRoutes.get(`${mainID}:full:${fullKey}`) ??
      this.subRoutes.get(`${mainID}:low:${lowKey}`);
    return route?.name ?? FRAME_NAMES[lowKey] ?? "未知";
  }

  /**
   * 当前已注册路由表（自检/日志/文档）
   *
   * @returns 路由描述数组（mainID + subID(low32) + 语义名）
   */
  routes(): Array<{ mainID: number; subID: string; name: string }> {
    const out: Array<{ mainID: number; subID: string; name: string }> = [];
    for (const [mainID, r] of this.mainRoutes) out.push({ mainID, subID: `main:${mainID}`, name: r.name });
    for (const [key, r] of this.subRoutes) {
      const [mainID, mode, hex] = key.split(":");
      out.push({
        mainID: Number(mainID),
        subID: mode === "low" ? `low:${hex}` : `full:${hex}`,
        name: r.name,
      });
    }
    return out;
  }
}
