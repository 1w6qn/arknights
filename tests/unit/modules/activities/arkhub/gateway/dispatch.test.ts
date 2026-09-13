/**
 * arkhub 网关帧路由器（ArkhubSessionFrameRouter）单元测试
 *
 * 验证路由分发优先级（main 级 > full 匹配 > low32 匹配 > fallback）与帧名查询。
 */
import { describe, it, expect } from "vitest";
import { ArkhubSessionFrameRouter, GW_CODE_OK } from "@game/modules/activities/arkhub/public";
import type {
  ArkhubSessionHandlerContext,
  ArkhubSessionFrame,
} from "@game/modules/activities/arkhub/public";

/** 构造一个带发送捕获的测试上下文 */
function makeCtx(): {
  ctx: ArkhubSessionHandlerContext;
  sent: Array<{ mainID: number; subID: bigint; body: Buffer }>;
} {
  const sent: Array<{ mainID: number; subID: bigint; body: Buffer }> = [];
  const ctx: ArkhubSessionHandlerContext = {
    state: { uid: "", currentMapId: 0, guideState: {}, settledDuelBattles: new Set<string>(), stateMask: 0 },
    opts: {},
    send: (mainID, subID, body) => sent.push({ mainID, subID, body }),
  };
  return { ctx, sent };
}

/** 构造一帧 */
function frame(mainID: number, subID: bigint, body: Buffer = Buffer.alloc(0)): ArkhubSessionFrame {
  return { mainID, subID, low32: subID & 0xffffffffn, body };
}

describe("arkhub 网关帧路由器", () => {
  it("main 级路由：main=1 心跳分发给 main handler", () => {
    const router = new ArkhubSessionFrameRouter();
    let handled = false;
    router.registerMain(1, "心跳(Ping)", () => {
      handled = true;
    });
    router.dispatch(makeCtx().ctx, frame(1, BigInt(0)));
    expect(handled).toBe(true);
  });

  it("full 匹配：登录 0x0fa1 精确分发（不误命中其它 main=4）", () => {
    const router = new ArkhubSessionFrameRouter();
    let handled = 0;
    router.register(4, BigInt(0x0fa1), "登录", () => {
      handled++;
    });
    router.dispatch(makeCtx().ctx, frame(4, BigInt(0x0fa1)));
    router.dispatch(makeCtx().ctx, frame(4, BigInt(0x0fa2))); // 登录响应 subID 不命中
    expect(handled).toBe(1);
  });

  it("low32 匹配：切场景带会话前缀（高 32 位变化）仍命中", () => {
    const router = new ArkhubSessionFrameRouter();
    let handled = false;
    router.registerLow(8, BigInt(0x38b3b60b), "切场景", () => {
      handled = true;
    });
    // 高 32 位为会话/场景前缀（0x2c89b3…），低 32 位一致 → 命中
    router.dispatch(makeCtx().ctx, frame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3b60b)));
    expect(handled).toBe(true);
  });

  it("full 匹配优先于 low32 匹配（同低 32 位时整 64 位路由胜出）", () => {
    const router = new ArkhubSessionFrameRouter();
    let winner = "";
    router.register(8, BigInt("0x00018fb64de29cdb"), "场景hello", () => {
      winner = "full";
    });
    router.registerLow(8, BigInt(0x4de29cdb), "low同名", () => {
      winner = "low";
    });
    // 该帧低 32 位 = 0x4de29cdb，full 精确匹配优先
    router.dispatch(makeCtx().ctx, frame(8, BigInt("0x00018fb64de29cdb")));
    expect(winner).toBe("full");
  });

  it("fallback：main=8 未注册帧回通用 ACK {1:100}（subID+1）", () => {
    const router = new ArkhubSessionFrameRouter();
    router.setFallback("通用ACK", (ctx, f) => {
      if (f.mainID === 8) ctx.send(8, f.subID + BigInt(1), Buffer.from([0x08, GW_CODE_OK]));
    });
    const { ctx, sent } = makeCtx();
    router.dispatch(ctx, frame(8, BigInt(0x12345678)));
    expect(sent).toHaveLength(1);
    expect(sent[0].subID).toBe(BigInt(0x12345679));
    expect(sent[0].body.toString("hex")).toBe("0864");
  });

  it("fallback：main≠8 未注册帧静默（不响应）", () => {
    const router = new ArkhubSessionFrameRouter();
    router.setFallback("通用ACK", (ctx, f) => {
      if (f.mainID === 8) ctx.send(8, f.subID + BigInt(1), Buffer.from([0x08, GW_CODE_OK]));
    });
    const { ctx, sent } = makeCtx();
    router.dispatch(ctx, frame(2, BigInt(0)));
    expect(sent).toHaveLength(0);
  });

  it("未注册路由时 dispatch 不抛错（静默忽略）", () => {
    const router = new ArkhubSessionFrameRouter();
    const { ctx, sent } = makeCtx();
    expect(() => router.dispatch(ctx, frame(8, BigInt(0xffffffff)))).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("nameOf：已注册路由名 / FRAME_NAMES / 未知 三级回退", () => {
    const router = new ArkhubSessionFrameRouter();
    router.register(4, BigInt(0x0fa1), "登录(UserLoginReq)", () => {});
    // 已注册路由
    expect(router.nameOf(4, BigInt(0x0fa1))).toBe("登录(UserLoginReq)");
    // FRAME_NAMES 注册表（响应 subID 未注册为路由）
    expect(router.nameOf(8, BigInt("0x0002c89b38b3db61"))).toContain("UpdatePlayerSettingsResp");
    // 未知
    expect(router.nameOf(8, BigInt(0x12345678))).toBe("未知");
  });

  it("routes()：导出已注册路由表（自检/文档）", () => {
    const router = new ArkhubSessionFrameRouter();
    router.registerMain(1, "心跳(Ping)", () => {});
    router.register(4, BigInt(0x0fa1), "登录(UserLoginReq)", () => {});
    router.registerLow(8, BigInt(0x38b3b60b), "切场景(ChangeSceneReq)", () => {});
    const routes = router.routes();
    expect(routes).toHaveLength(3);
    expect(routes.some((r) => r.name === "心跳(Ping)")).toBe(true);
    expect(routes.some((r) => r.subID === "full:fa1")).toBe(true);
    expect(routes.some((r) => r.subID === "low:38b3b60b")).toBe(true);
  });
});
