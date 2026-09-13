/**
 * Express 请求对象类型增强（全局，仅供类型系统）
 *
 * capture 模式下 `server.ts` 的采集中间件会把非 JSON 请求体（multipart 等）的原始字节
 * 挂到 `req.rawBody`，供转发层原样透传、抓包层原样落盘。该字段是运行期挂载的，
 * `@types/express` 无声明——此前 8 处消费点各自写 `req as unknown as { rawBody?: Buffer }`。
 *
 * 这里声明一次，消费点直接 `req.rawBody`：
 * 运行期写入方见 `app/server.ts`（capture 中间件）与 `scripts/proxy-harness.ts`；
 * 其余模式（未开启 capture）下恒为 `undefined`，消费点必须按可选处理。
 */

declare global {
  namespace Express {
    interface Request {
      /**
       * 原始请求体字节（capture 模式下由采集中间件写入）
       *
       * 仅非 JSON 请求体（multipart / 二进制）会写入；JSON 请求体已被 bodyParser 消费，
       * 此处保持 `undefined`，消费点按此回退到 `req.body`。
       */
      rawBody?: Buffer;
    }
  }
}

export {};
