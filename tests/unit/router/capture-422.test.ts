/**
 * 抓包 422 修复回归测试
 *
 * 覆盖真实客户端抓包中被 zod 校验拦成 422、现已修复放行的请求形态，
 * 防止后续收紧 schema 再次误伤正常客户端请求。
 */
import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Response } from "express";
import type { ZodSchema } from "zod";
import type { JsonValue } from "@excel/json-value";
import * as Building from "@game/modules/building/schemas";
import * as BusinessCard from "@game/modules/businessCard/businessCard.schema";
import { validateBody } from "@core/http/validate-body";

/** 校验中间件的请求视图：只声明被测分支读到的 body */
interface MockReq {
  body: JsonValue;
}

/** 校验中间件的响应视图：只声明被测分支读到的两个方法 */
interface MockRes {
  json: Response["json"];
  status: Response["status"];
}

type ValidateMiddleware = ReturnType<typeof validateBody>;
type RouterReq = Parameters<ValidateMiddleware>[0];

function makeRes(): MockRes {
  return {
    json: vi.fn<Response["json"]>(),
    status: vi.fn<Response["status"]>().mockReturnThis(),
  };
}

/** 断言合法 body 通过（next 被调用且未返回 4xx） */
function expectPass(schema: ZodSchema, body: JsonValue): void {
  const res = makeRes();
  const next: NextFunction = vi.fn();
  const req: MockReq = { body };
  // mock 请求/响应只覆盖被测分支用到的成员，故按窄视图断言为 express Request/Response
  validateBody(schema)(req as RouterReq, res as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
}

describe("抓包 422 修复（真实客户端形态放行）", () => {
  it("/building/batchRestChar 发空体 {} 应通过（handler 空列表不改分配）", () => {
    expectPass(Building.batchRestCharSchema, {});
  });

  it("/building/batchChangeWorkChar 发空体 {} 应通过（换班走预设队列轮换）", () => {
    expectPass(Building.batchChangeWorkCharSchema, {});
  });

  it("/businessCard/editNameCard content.skinId/component 为 null、misc 为 0/1 数字应通过", () => {
    expectPass(BusinessCard.editNameCardSchema, {
      flag: 4,
      content: {
        skinId: null,
        component: null,
        misc: { showDetail: 1, showBirthday: 0 },
        skinTmpl: 0,
      },
    });
  });

  it("/businessCard/editNameCard 非杂项模式 flag=1 时 misc 显式传 null 应通过", () => {
    expectPass(BusinessCard.editNameCardSchema, {
      flag: 1,
      content: {
        skinId: null,
        component: ["module_medal", "module_equip"],
        misc: null,
        skinTmpl: 0,
      },
    });
  });
});