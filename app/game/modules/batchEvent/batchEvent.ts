/**
 * 客户端事件批量上报（/batch_event）协议类型
 *
 * 服务端自定义端点：客户端只认状态码，请求体无业务字段，响应为空对象。
 */

/** 客户端事件批量上报请求（服务端自定义；统计/BI 类接口，请求体无业务字段） */
export interface BatchEventRequest {}

/** 客户端事件批量上报响应（服务端自定义；返回空对象） */
export interface BatchEventResponse {}
