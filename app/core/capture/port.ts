/**
 * 抓包写入端口（CaptureRecorder）—— **core 侧最小契约**
 *
 * 背景：`core/utils/traffic-recorder.ts` 需要把 HTTP 抓包记录落库，但具体实现在
 * `app/ops/capture/capture-manager.ts`。core 不得依赖 ops（R1），故此处只声明
 * 「写入一条记录」所需的最小结构契约，由组合根（`app/server.ts`）注入实现。
 *
 * 与 ops 侧类型的关系：ops 的 `CaptureRecordInput` / `CaptureBodiesInput` /
 * `CaptureRecord` 是**更宽**的定义（含 session 查询、网关双向流、body 文件句柄等
 * traffic-recorder 用不到的字段）。本文件只收敛中间件实际写入的字段，ops 的实现
 * 天然结构性满足（参数逆变、返回值协变），无需 ops 反向依赖 core 的命名。
 *
 * 类型取向：**不使用 any/unknown/object**——模糊类型棘轮禁止新增含模糊类型的文件
 * （tests/unit/architecture/type-debt-ratchet.test.ts）。头部用精确的
 * `string | string[] | number | undefined` 联合，body 用 `JsonValue | Buffer`。
 */
import type { JsonValue } from "@utils/json-value";

/** 抓包来源 */
export type CaptureSource = "private" | "official" | "harness" | "gateway" | "ops";

/** 记录方向：http 请求/响应 | 网关双向字节流 */
export type CaptureDirection = "http" | "gateway-bidi";

/** body 文件类型 */
export type BodyKind = "json" | "bin" | "none";

/**
 * HTTP 头视图
 *
 * 同时覆盖请求头（`IncomingHttpHeaders`：string | string[] | undefined）与响应头
 * （`OutgoingHttpHeaders`：额外允许 number），使调用方无需强制断言。
 */
export type CaptureHeaders = Record<string, string | string[] | number | undefined>;

/** 抓包记录的最小引用（写入方只关心落库后的 id/rid，不读取其余字段） */
export interface CaptureRecordRef {
  /** 自增主键 */
  id: number;
  /** 记录目录名（tmp/capture/records/{rid}/） */
  rid: string;
}

/** 新记录元数据（traffic-recorder 写入面） */
export interface CaptureRecordInputPort {
  /** 会话 id（缺省归入自动会话） */
  sessionId?: string | null;
  /** 记录时间（epoch ms；缺省 Date.now()） */
  ts?: number;
  /** HTTP 方法 */
  method?: string;
  /** 归一化路径（不含 query） */
  path?: string;
  /** 原始 query 字符串 */
  query?: string;
  /** 响应状态码 */
  status?: number | null;
  /** 端到端耗时（ms） */
  latencyMs?: number | null;
  /** 抓包来源 */
  source: CaptureSource;
  /** 记录方向（缺省 http） */
  direction?: CaptureDirection;
  /** 请求头 */
  reqHeaders?: CaptureHeaders | null;
  /** 响应头 */
  resHeaders?: CaptureHeaders | null;
  /** 已存在于记录目录中的 body 文件 */
  reqBodyFile?: string | null;
  /** 已存在于记录目录中的 body 文件 */
  resBodyFile?: string | null;
  /** body 尺寸 */
  reqSize?: number | null;
  /** body 尺寸 */
  resSize?: number | null;
  /** 记录备注 */
  note?: string;
}

/** 单个 body 输入 */
export interface CaptureBodyInputPort {
  /** body 类型 */
  kind: BodyKind;
  /** json：对象/字符串；bin：Buffer/字符串（原始字节） */
  data: JsonValue | Buffer;
}

/** body 文件输入（traffic-recorder 只写 req/res） */
export interface CaptureBodiesInputPort {
  /** 请求体 */
  req?: CaptureBodyInputPort | null;
  /** 响应体 */
  res?: CaptureBodyInputPort | null;
}

/**
 * 抓包写入端口
 *
 * @remarks
 * 仅声明 addRecord 一条写入能力，供 HTTP 抓包中间件（traffic-recorder）面向接口写入
 * 统一抓包存储。实现与默认绑定在 `app/ops/capture/`，由组合根注入。
 */
export interface CaptureRecorder {
  /**
   * 写入一条抓包记录
   * @param input - 记录元信息（方法/路径/来源等）
   * @param bodies - 请求/响应体（可选）
   * @returns 落库后的记录（最小引用）
   */
  addRecord(
    input: CaptureRecordInputPort,
    bodies?: CaptureBodiesInputPort,
  ): Promise<CaptureRecordRef>;
}
