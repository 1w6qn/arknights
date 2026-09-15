/**
 * 自动化桥 HTTP 客户端
 *
 * MCP server 与私服之间的那一跳：把「下发一条命令并等结果」封装成一次
 * `POST /plugin/automation/call`（服务端会一直挂到客户端回传结果或超时）。
 *
 * 为什么要独立成模块：MCP 工具表是纯数据（`automation-tools.ts`），
 * 传输层可在测试里用 `fetchImpl` 注入替身，不必起真服务。
 */
import type { JsonValue } from "@core/utils/json-value";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "@ops/automation";

/** `POST /plugin/automation/call` 的响应 */
export interface AutomationCallResponse {
  /** 0 = 请求被受理；1 = 参数/会话非法（此时 ok 也为 false） */
  status: number;
  protocol?: number;
  id: string;
  sid: string;
  /** 命令在客户端侧是否执行成功 */
  ok: boolean;
  /** 客户端侧耗时（毫秒） */
  ms: number;
  /** 结果载荷（失败时可能为 null） */
  result: JsonValue;
  /** 失败原因 */
  error: string | null;
  /** 服务端观测的往返耗时（毫秒） */
  roundTripMs: number;
}

/** 在线会话快照 */
export interface AutomationSessionSnapshot {
  sid: string;
  firstSeenAt: number;
  lastSeenAt: number;
  pollCount: number;
  pending: number;
  inflight: number;
  idleMs: number;
  lastCommandName: string | null;
}

/** `GET /plugin/automation/sessions` 的响应 */
export interface AutomationSessionsResponse {
  status: number;
  count: number;
  sessions: AutomationSessionSnapshot[];
  hub: { sessions: number; waiters: number; partials: number };
}

/** 构造参数 */
export interface AutomationClientOptions {
  /** 私服基址，如 `http://127.0.0.1:8443` */
  baseUrl: string;
  /** 注入点：测试里替换网络实现 */
  fetchImpl?: typeof fetch;
  /** 请求超时相对命令超时的余量（毫秒，缺省 5s：让服务端先超时并给出诊断） */
  graceMs?: number;
}

/**
 * 私服自动化端点客户端。
 */
export class AutomationClient {
  private readonly _baseUrl: string;
  private readonly _fetch: typeof fetch;
  private readonly _graceMs: number;

  /**
   * @param options - 基址与可注入的 fetch
   */
  constructor(options: AutomationClientOptions) {
    this._baseUrl = options.baseUrl.replace(/\/+$/, "");
    this._fetch = options.fetchImpl ?? fetch;
    this._graceMs = options.graceMs ?? 5000;
  }

  /** 基址（自检/日志用） */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /**
   * 下发一条命令并等待结果。
   * @param sid - 目标会话
   * @param name - 命令名
   * @param args - 命令参数
   * @param timeoutMs - 超时（缺省 20s）
   * @returns 命令结果（超时/失败都是 `ok=false`，不抛异常）
   */
  async call(
    sid: string,
    name: string,
    args: JsonValue,
    timeoutMs?: number,
  ): Promise<AutomationCallResponse> {
    const limit = Math.min(Math.max(timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const response = await this._request("/plugin/automation/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid, name, args, timeoutMs: limit }),
      // 比服务端超时多留一点：先让服务端超时并回报「客户端多久没轮询」的诊断
      signal: AbortSignal.timeout(limit + this._graceMs),
    });
    return (await response.json()) as AutomationCallResponse;
  }

  /**
   * 列出在线会话。
   * @returns 会话快照与 hub 统计
   */
  async sessions(): Promise<AutomationSessionsResponse> {
    const response = await this._request("/plugin/automation/sessions", {
      signal: AbortSignal.timeout(5000),
    });
    return (await response.json()) as AutomationSessionsResponse;
  }

  /**
   * 发一次请求（统一错误信息：把「私服没起」这类最常见的失败说清楚）。
   * @param path - 路径
   * @param init - fetch 参数
   * @returns 响应
   */
  private async _request(path: string, init: RequestInit): Promise<Response> {
    const url = `${this._baseUrl}${path}`;
    try {
      const response = await this._fetch(url, init);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`私服返回 HTTP ${response.status}（${url}）: ${text.slice(0, 300)}`);
      }
      return response;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("私服返回")) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法连接私服 ${url}（${reason}）。请确认私服已启动（pnpm run start:quick），且 DTS_SERVER_URL 指向正确。`,
      );
    }
  }
}
