import { describe, it, expect, vi } from "vitest";
import net from "net";
import os from "os";
import path from "path";
import fs from "fs";
import {
  startArkhubGatewayProxy,
  adaptArkhubEnterHallResponse,
  isArkhubEnterHall,
  setGatewayRecordSink,
  OFFICIAL_ARKHUB_GATEWAY_HOST,
  OFFICIAL_ARKHUB_GATEWAY_PORT,
} from "@game/modules/activities/arkhub/public";

/** 等待端口监听就绪 */
function listen(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
}

/** 等待一个 TCP 客户端完整往返（写数据→收够数据→关闭） */
function roundTrip(port: number, payload: Buffer): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const received: Buffer[] = [];
    const client = net.connect(port, "127.0.0.1", () => client.write(payload));
    client.on("data", (d) => {
      received.push(d);
      // 收够 payload 长度即主动关闭（兼容 echo 被拆成多段）
      const total = received.reduce((n, b) => n + b.length, 0);
      if (total >= payload.length) client.end();
    });
    client.on("error", reject);
    client.on("close", () => resolve(received));
  });
}

describe("adaptArkhubEnterHallResponse（enterHall 响应改写）", () => {
  it("改写 endpoint/port 为代理网关信息，其余字段不动", () => {
    const payload = {
      result: 0,
      endpoint: OFFICIAL_ARKHUB_GATEWAY_HOST,
      port: OFFICIAL_ARKHUB_GATEWAY_PORT,
      playerDataDelta: { modified: {}, deleted: {} },
    };
    const out = adaptArkhubEnterHallResponse(payload, { endpoint: "127.0.0.1", port: 30000 });
    expect(out).toEqual({
      result: 0,
      endpoint: "127.0.0.1",
      port: 30000,
      playerDataDelta: { modified: {}, deleted: {} },
    });
  });

  it("非网关形状（缺 endpoint/port）不改写，原对象返回", () => {
    const payload = { result: 1, msg: "x" };
    expect(adaptArkhubEnterHallResponse(payload, { endpoint: "127.0.0.1", port: 30000 })).toBe(payload);
  });

  it("非对象（Buffer/字符串）不改写", () => {
    const buf = Buffer.from("hello");
    expect(adaptArkhubEnterHallResponse(buf, { endpoint: "127.0.0.1", port: 30000 })).toBe(buf);
  });
});

describe("isArkhubEnterHall", () => {
  it("仅识别 /activity/arkhub/enterHall", () => {
    expect(isArkhubEnterHall("/activity/arkhub/enterHall")).toBe(true);
    expect(isArkhubEnterHall("/activity/arkhub/syncInfo")).toBe(false);
    expect(isArkhubEnterHall("/activity/arkhub/setSecretary")).toBe(false);
    expect(isArkhubEnterHall("/account/login")).toBe(false);
  });
});

describe("startArkhubGatewayProxy（30000 TCP 转发器）", () => {
  afterEach(() => {
    // 清理注入 sink（模块级全局状态，防用例间泄漏）
    setGatewayRecordSink(null);
  });

  it("注入 GatewayRecordSink 后连接关闭时提交记录；取消注入后 no-op", async () => {
    // 本地 echo 服务器模拟官服网关
    const echo = net.createServer((sock) => sock.pipe(sock));
    await listen(echo);
    const echoPort = (echo.address() as net.AddressInfo).port;

    const recordRoot = path.join(os.tmpdir(), `arkhub-gw-sink-${Date.now()}-${Math.floor(Math.random() * 1e5)}`);
    const sink = {
      isReady: vi.fn(() => true),
      commitRecord: vi.fn().mockResolvedValue(null),
    };
    setGatewayRecordSink(sink);
    const result = await startArkhubGatewayProxy({
      port: 0,
      targetHost: "127.0.0.1",
      targetPort: echoPort,
      recordRoot,
    });
    try {
      // 注入 sink：连接关闭后提交记录（字段形状与 capture-manager CaptureRecordInput 兼容）
      await roundTrip(result.port, Buffer.from("sink-1"));
      await new Promise((r) => setTimeout(r, 300));
      expect(sink.isReady).toHaveBeenCalled();
      expect(sink.commitRecord).toHaveBeenCalledTimes(1);
      const [rid, input] = sink.commitRecord.mock.calls[0] as [string, Record<string, unknown>];
      expect(rid).toBeTruthy();
      expect(input).toMatchObject({
        path: "/arkhub/gateway",
        source: "gateway",
        direction: "gateway-bidi",
        reqSize: 6,
        resSize: 6,
      });

      // 取消注入 → 后续连接不再提交（no-op 不抛）
      sink.commitRecord.mockClear();
      setGatewayRecordSink(null);
      await roundTrip(result.port, Buffer.from("noop-1"));
      await new Promise((r) => setTimeout(r, 300));
      expect(sink.commitRecord).not.toHaveBeenCalled();
    } finally {
      result.server?.close();
      echo.close();
      fs.rmSync(recordRoot, { recursive: true, force: true });
    }
  });

  it("透传客户端↔目标字节流并记录 up/down/meta", async () => {
    // 本地 echo 服务器模拟官服网关
    const echo = net.createServer((sock) => sock.pipe(sock));
    await listen(echo);
    const echoPort = (echo.address() as net.AddressInfo).port;

    const recordRoot = path.join(os.tmpdir(), `arkhub-gw-test-${Date.now()}`);
    const result = await startArkhubGatewayProxy({
      port: 0, // 随机端口
      targetHost: "127.0.0.1",
      targetPort: echoPort,
      recordRoot,
    });
    expect(result.adjusted).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.server).not.toBeNull();
    const server = result.server!;
    const proxyPort = result.port; // 实际监听端口 = server.address().port

    try {
      // 客户端 → 代理 → echo → 代理 → 客户端
      const received = await roundTrip(proxyPort, Buffer.from("ping-1"));
      expect(Buffer.concat(received).toString()).toBe("ping-1");

      // 等异步落盘完成
      await new Promise((r) => setTimeout(r, 300));
      const dirs = fs.readdirSync(recordRoot);
      expect(dirs.length).toBe(1);
      const connDir = path.join(recordRoot, dirs[0]);
      expect(fs.readFileSync(path.join(connDir, "up.bin")).toString()).toBe("ping-1");
      expect(fs.readFileSync(path.join(connDir, "down.bin")).toString()).toBe("ping-1");
      const meta = JSON.parse(fs.readFileSync(path.join(connDir, "meta.json"), "utf-8"));
      expect(meta.upBytes).toBe(6);
      expect(meta.downBytes).toBe(6);
      expect(meta.targetAddr).toBe("127.0.0.1:" + echoPort);
    } finally {
      server.close();
      echo.close();
      fs.rmSync(recordRoot, { recursive: true, force: true });
    }
  });

  it("首选端口被占时自动避让到下一个空闲端口（adjusted=true，port=避让后端口）", async () => {
    // 唯一目录名（Windows 并行测试下固定名目录会被并发删除导致 EPERM）
    const recordRoot = path.join(os.tmpdir(), `arkhub-gw-auto-${Date.now()}-${Math.floor(Math.random() * 1e5)}`);
    // 真实 echo 服务器作目标（避免 ECONNRESET）
    const echo = net.createServer((sock) => sock.pipe(sock));
    await listen(echo);
    const echoPort = (echo.address() as net.AddressInfo).port;
    // 第一个实例占住端口 A（双栈 listen 语义一致）
    const first = await startArkhubGatewayProxy({
      port: 0,
      targetHost: "127.0.0.1",
      targetPort: echoPort,
      recordRoot,
    });
    expect(first.server).not.toBeNull();
    const usedPort = first.port;
    let second: import("@game/modules/activities/arkhub/public").ArkhubGatewayProxyResult | undefined;
    try {
      // 第二个实例首选 usedPort 被占 → 自动避让到 usedPort+1
      second = await startArkhubGatewayProxy({
        port: usedPort,
        targetHost: "127.0.0.1",
        targetPort: echoPort,
        recordRoot,
      });
      expect(second.server).not.toBeNull();
      expect(second.adjusted).toBe(true);
      // 避让到首个空闲端口（并行测试可能占住 usedPort+1，断言"更大端口"而非精确值）
      expect(second.port).toBeGreaterThan(usedPort);
      expect(second.port).not.toBe(usedPort);
      // 避让后端口确实可连（转发器可用）
      const received = await roundTrip(second.port, Buffer.from("auto-ok"));
      expect(Buffer.concat(received).toString()).toBe("auto-ok");
      // 等异步落盘完成再清理（Windows 下文件句柄未释放会 EPERM）
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      first.server!.close();
      if (second?.server) second.server.close();
      echo.close();
      fs.rmSync(recordRoot, { recursive: true, force: true });
    }
  });

  it("首选端口及避让端口全部被占时返回 { server:null, exhausted:true }", async () => {
    const recordRoot = path.join(os.tmpdir(), `arkhub-gw-exhaust-${Date.now()}-${Math.floor(Math.random() * 1e5)}`);
    // 第一个实例占 usedPort，blocker 再占 usedPort+1 → maxPortTries=2 两次都 EADDRINUSE → 耗尽
    const first = await startArkhubGatewayProxy({
      port: 0,
      targetHost: "127.0.0.1",
      targetPort: 1,
      recordRoot,
    });
    expect(first.server).not.toBeNull();
    const usedPort = first.port;
    // blocker 用与代理相同的 listen 语义（无 host 双栈）占住避让目标端口
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(usedPort + 1, () => r()));
    try {
      const result = await startArkhubGatewayProxy({
        port: usedPort,
        targetHost: "127.0.0.1",
        targetPort: 1,
        recordRoot,
        maxPortTries: 2,
      });
      expect(result.server).toBeNull();
      expect(result.exhausted).toBe(true);
      expect(result.port).toBe(usedPort); // 失败时 port=配置首选端口
      await new Promise((r) => setTimeout(r, 300)); // 等异步落盘完成再清理
    } finally {
      first.server!.close();
      blocker.close();
      fs.rmSync(recordRoot, { recursive: true, force: true });
    }
  });
});
