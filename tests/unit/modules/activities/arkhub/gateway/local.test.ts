import { describe, it, expect, afterEach } from "vitest";
import net from "net";
import {
  startArkhubSessionServer,
  isArkhubSessionActive,
  setArkhubSessionActive,
  getArkhubSessionPort,
} from "@game/modules/activities/arkhub/public";

const servers: net.Server[] = [];
afterEach(() => {
  setArkhubSessionActive(false);
  for (const s of servers.splice(0)) s.close();
});

/** 组帧：[4B len][4B mainID][8B subID][body] */
function frame(mainID: number, subID: bigint, body: Buffer): Buffer {
  const f = Buffer.alloc(16 + body.length);
  f.writeUInt32BE(f.length, 0);
  f.writeUInt32BE(mainID, 4);
  f.writeBigUInt64BE(subID, 8);
  body.copy(f, 16);
  return f;
}

/** 连接本地网关，发一帧，收齐一帧响应 */
function roundTrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const client = net.connect(port, "127.0.0.1", () => client.write(payload));
    let buf = Buffer.alloc(0);
    client.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 16 && buf.length >= buf.readUInt32BE(0)) {
        client.end();
        resolve(buf);
      }
    });
    client.on("error", reject);
  });
}

async function startServer(): Promise<number> {
  const server = (await startArkhubSessionServer({ port: 0 }))!;
  servers.push(server);
  return (server.address() as net.AddressInfo).port;
}

/** protobuf 轻解析（返回 [field, wire, payload] 列表；wire0=varint 值，wire2=子 Buffer） */
function parseProto(buf: Buffer): Array<[number, number, Buffer | number]> {
  const out: Array<[number, number, Buffer | number]> = [];
  let p = 0;
  const rv = () => {
    let v = 0, s = 0;
    for (;;) {
      const b = buf[p++];
      v |= (b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7;
    }
    return v;
  };
  while (p < buf.length) {
    const tag = rv();
    const f = tag >> 3;
    const w = tag & 7;
    if (w === 2) {
      const len = rv();
      out.push([f, w, buf.subarray(p, p + len)]);
      p += len;
    } else if (w === 0) {
      out.push([f, w, rv()]);
    } else break;
  }
  return out;
}

describe("arkhub 本地网关应答器", () => {
  it("登录帧应返回 UserLoginResp（main=4 sub=0xfa2，code=100）", async () => {
    const port = await startServer();
    // UserLoginReq body: {1:'2222', 2:'secret', 3:1, 4:'dev'}
    const login = Buffer.concat([
      Buffer.from([0x0a, 0x04]),
      Buffer.from("2222"),
      Buffer.from([0x12, 0x06]),
      Buffer.from("secret"),
      Buffer.from([0x18, 0x01]),
      Buffer.from([0x22, 0x03]),
      Buffer.from("dev"),
    ]);
    const resp = await roundTrip(port, frame(4, BigInt(0x0fa1), login));
    expect(resp.readUInt32BE(4)).toBe(4);
    expect(resp.readBigUInt64BE(8)).toBe(BigInt(0x0fa2));
    // body 首字段 = code 100（0x08 0x64）
    expect(resp[16]).toBe(0x08);
    expect(resp[17]).toBe(100);
  });

  it("心跳帧应回 main=2 sub=0x0 的 16B 回显", async () => {
    const port = await startServer();
    const resp = await roundTrip(port, frame(1, BigInt(0), Buffer.alloc(8)));
    expect(resp.readUInt32BE(4)).toBe(2);
    expect(resp.readBigUInt64BE(8)).toBe(BigInt(0));
    expect(resp.length).toBe(16 + 16);
  });

  it("场景 hello 应返回合法 EnterSceneNotify（main=8 sub=0x2c89b38b37d3d）", async () => {
    const port = await startServer();
    // 先登录（记录 uid），再发场景 hello——场景帧应含自己的 PlayerSyncData（field1=uid）
    const login = Buffer.concat([
      Buffer.from([0x0a, 0x01]),
      Buffer.from("1"),
      Buffer.from([0x12, 0x01]),
      Buffer.from("x"),
      Buffer.from([0x18, 0x01]),
    ]);
    await roundTrip(port, frame(4, BigInt(0x0fa1), login));
    const resp = await roundTrip(
      port,
      frame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01])),
    );
    expect(resp.readUInt32BE(4)).toBe(8);
    expect(resp.readBigUInt64BE(8)).toBe(BigInt("0x2c89b38b37d3d"));
    // 场景 body 非空（含 HallInfo + PlayerSyncData + PlayerHallBrief）
    expect(resp.length).toBeGreaterThan(16 + 40);
    // 顶层 3 个 length-delimited 字段（field1/2/3）
    const body = resp.subarray(16);
    expect(body[0] >> 3).toBe(1);
    expect(body[0] & 7).toBe(2);
    expect(body[1]).toBeGreaterThan(0);
  });

  it("场景 hello 未登录时也返回合法帧（uid 空回退）", async () => {
    const port = await startServer();
    const resp = await roundTrip(
      port,
      frame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01])),
    );
    expect(resp.readUInt32BE(4)).toBe(8);
    expect(resp.length).toBeGreaterThan(16 + 40);
  });

  it("切场景（传送门）：请求带目标 map_id → ACK + 新场景 EnterSceneNotify", async () => {
    const port = await startServer();
    // 单连接全程（网关场景状态按连接维护——切场景状态不跨连接保留）
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    const pending: Array<(f: Buffer) => void> = [];
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16) {
        const len = buf.readUInt32BE(0);
        if (buf.length < len) return;
        const f = buf.subarray(0, len);
        buf = buf.subarray(len);
        pending.shift()?.(f);
      }
    });
    const next = () =>
      new Promise<Buffer>((resolve) => pending.push(resolve));
    await new Promise<void>((r) => sock.once("connect", r));
    const sendFrame = (mainID: number, subID: bigint, body: Buffer) =>
      sock.write(frame(mainID, subID, body));
    const signedVarint = (v: number) => {
      let value = BigInt.asUintN(64, BigInt(v));
      const out: number[] = [];
      do {
        let byte = Number(value & 0x7fn);
        value >>= 7n;
        if (value !== 0n) byte |= 0x80;
        out.push(byte);
      } while (value !== 0n);
      return Buffer.from(out);
    };

    // 登录
    let p = next();
    sendFrame(4, BigInt(0x0fa1), Buffer.concat([
      Buffer.from([0x0a, 0x01]), Buffer.from("1"),
      Buffer.from([0x12, 0x01]), Buffer.from("x"),
      Buffer.from([0x18, 0x01]),
    ]));
    await p;
    // 场景 hello → TOWN（map -1520665757，varint e3f6f1aafaffffffff01）
    p = next();
    sendFrame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01]));
    const enter = await p;
    expect(enter.subarray(16).toString("hex").includes("e3f6f1aafaffffffff01")).toBe(true);
    // 切场景：body = {1:2, 2:<map_id=-820616879 CAPTURE 1>}
    // 网关连续回两帧（ACK + EnterSceneNotify）——先注册两个 next 再发包
    const pa = next();
    const ps = next();
    sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3b60b),
      Buffer.concat([Buffer.from([0x08, 0x02, 0x10]), signedVarint(-820616879)]));
    const ack = await pa;
    // ACK：sub=0x38b3a5a8，body={1:9}
    expect((ack.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3a5a8");
    expect(ack[16]).toBe(0x08);
    expect(ack[17]).toBe(9);
    // 随后 EnterSceneNotify：map_id = CAPTURE 1（-820616879，varint d1c2d9f8fcffffffff01）
    const scene = await ps;
    expect(scene.subarray(16).toString("hex").includes("d1c2d9f8fcffffffff01")).toBe(true);
    // 出生点应为捕抓区坐标（z=-6.85，LE float32）——修复：原统一用广场坐标导致传送后位置错误
    const capZ = Buffer.alloc(4);
    capZ.writeFloatLE(-6.85, 0);
    expect(scene.subarray(16).includes(capZ)).toBe(true);
    sock.end();
  });

  it("EnterSceneNotify 的 PlayerBrief 含 charId/skinId（广场玩家模型渲染所需）", async () => {
    const server = (await startArkhubSessionServer({
      port: 0,
      resolvePlayerProfile: () => ({
        nickname: "博士2222",
        level: 120,
        charId: "char_1012_skadi2",
        skinId: "char_1012_skadi2#1",
      }),
    }))!;
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const login = Buffer.concat([
      Buffer.from([0x0a, 0x04]),
      Buffer.from("2222"),
      Buffer.from([0x12, 0x06]),
      Buffer.from("secret"),
      Buffer.from([0x18, 0x01]),
    ]);
    await roundTrip(port, frame(4, BigInt(0x0fa1), login));
    const resp = await roundTrip(
      port,
      frame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01])),
    );
    // 顶层 f2 = PlayerSyncData，其 f1 = PlayerBrief，f1.f6/f1.f7 = charId/skinId
    const body = resp.subarray(16);
    // 解析顶层 f2（length-delimited，field 2）
    let p = 0;
    const readVarint = () => {
      let v = 0, s = 0;
      for (;;) {
        const b = body[p++];
        v |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      return v;
    };
    while (p < body.length) {
      const tag = readVarint();
      const field = tag >> 3;
      const wire = tag & 7;
      if (wire === 2) {
        const len = readVarint();
        const chunk = body.subarray(p, p + len);
        p += len;
        if (field === 2) {
          // PlayerSyncData：解析其 f1（PlayerBrief）
          let q = 0;
          const rv = () => {
            let v = 0, s = 0;
            for (;;) {
              const b = chunk[q++];
              v |= (b & 0x7f) << s;
              if (!(b & 0x80)) break;
              s += 7;
            }
            return v;
          };
          const briefFields: Record<number, string> = {};
          while (q < chunk.length) {
            const t2 = rv();
            const f2 = t2 >> 3;
            const w2 = t2 & 7;
            if (w2 === 2) {
              const l2 = rv();
              if (f2 === 1) {
                // PlayerBrief 本体：解析其字段
                const brief = chunk.subarray(q, q + l2);
                let bq = 0;
                const bv = () => {
                  let v = 0, s = 0;
                  for (;;) {
                    const b = brief[bq++];
                    v |= (b & 0x7f) << s;
                    if (!(b & 0x80)) break;
                    s += 7;
                  }
                  return v;
                };
                while (bq < brief.length) {
                  const t3 = bv();
                  const f3 = t3 >> 3;
                  const w3 = t3 & 7;
                  if (w3 === 2) {
                    const l3 = bv();
                    if ([1, 2, 3, 6, 7].includes(f3)) {
                      briefFields[f3] = brief.subarray(bq, bq + l3).toString("utf8");
                    }
                    bq += l3;
                  } else if (w3 === 0) bv();
                  else break;
                }
              }
              q += l2;
            } else if (w2 === 0) rv();
            else break;
          }
          expect(briefFields[6]).toBe("char_1012_skadi2");
          expect(briefFields[7]).toBe("char_1012_skadi2#1");
          return;
        }
      } else if (wire === 0) readVarint();
      else break;
    }
    throw new Error("PlayerSyncData(f2) not found in EnterSceneNotify");
  });

  it("EnterSceneNotify 的 GuideFlags 为重复 f1 条目且含全部 hub 引导/区域标记（防引导重复）", async () => {
    const server = (await startArkhubSessionServer({ port: 0 }))!;
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const login = Buffer.concat([
      Buffer.from([0x0a, 0x01]),
      Buffer.from("1"),
      Buffer.from([0x12, 0x01]),
      Buffer.from("x"),
      Buffer.from([0x18, 0x01]),
    ]);
    await roundTrip(port, frame(4, BigInt(0x0fa1), login));
    const resp = await roundTrip(
      port,
      frame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01])),
    );
    const body = resp.subarray(16);
    // 用共享 cursor 的 protobuf 轻解析（返回 [field, wire, payload] 列表）
    const parse = (buf: Buffer): Array<[number, number, Buffer | number]> => {
      const out: Array<[number, number, Buffer | number]> = [];
      let p = 0;
      const rv = () => {
        let v = 0, s = 0;
        for (;;) {
          const b = buf[p++];
          v |= (b & 0x7f) << s;
          if (!(b & 0x80)) break;
          s += 7;
        }
        return v;
      };
      while (p < buf.length) {
        const tag = rv();
        const f = tag >> 3;
        const w = tag & 7;
        if (w === 2) {
          const len = rv();
          out.push([f, w, buf.subarray(p, p + len)]);
          p += len;
        } else if (w === 0) {
          out.push([f, w, rv()]);
        } else break;
      }
      return out;
    };

    // 顶层找 f2 (PlayerSyncData)
    let guideFlags: Buffer | null = null;
    for (const [f, w, payload] of parse(body)) {
      if (f === 2 && w === 2) {
        for (const [f2, w2, p2] of parse(payload as Buffer)) {
          if (f2 === 3 && w2 === 2) {
            guideFlags = p2 as Buffer;
          }
        }
      }
    }
    expect(guideFlags).not.toBeNull();
    // GuideFlags 内：f1 为重复条目 {1:key, 2:value}，f2 为时间戳
    const flags = new Map<string, number>();
    let tsFound = false;
    for (const [f, w, payload] of parse(guideFlags!)) {
      if (f === 2 && w === 0) tsFound = true;
      if (f === 1 && w === 2) {
        let key = "";
        let val = 0;
        for (const [f3, w3, p3] of parse(payload as Buffer)) {
          if (f3 === 1 && w3 === 2) key = (p3 as Buffer).toString("utf8");
          else if (f3 === 2 && w3 === 0) val = p3 as number;
        }
        flags.set(key, val);
      }
    }
    expect(tsFound).toBe(true);
    // 全部 hub 引导/区域标记应逐条下发（缺失 → 客户端每次进图重放引导对话）。
    // 取值对齐官服完成态：进度计数类（capture_catch_guide_01/02、arkdex_battle_guide）为 2，
    // 其余布尔标记为 1——取 1 会触发条件 ==1 的 AUTO 引导对话（mmkabi_01b 领奖帧无
    // 官服响应样本 → 客户端 9s 超时重试 → 对话无法结束），故 02 取完成态 2。
    const expected: Record<string, number> = {
      arkdex_battle_guide: 2,
      area_2_guard: 1,
      area_3_guard: 1,
      terminal_guide: 1,
      area_3_blcok: 1,
      terminal_guide_arkdex: 1,
      arkhub_login: 1,
      arkdex_mmkabi1: 1,
      capture_catch_guide_02: 2,
      pixel_unlock: 1,
      pixel_unlock_system: 1,
      area_2_block: 1,
      area_1_block: 1,
      capture_catch_guide_01: 2,
    };
    for (const [key, val] of Object.entries(expected)) {
      expect(flags.get(key)).toBe(val);
    }
  });

  it("配置 resolveArkdexDocs：EnterSceneNotify 的 PlayerSyncData 含 f5-f9 户籍（生物图鉴/道具/功能位）", async () => {
    const server = (await startArkhubSessionServer({
      port: 0,
      resolveArkdexDocs: () => ({
        dex: { "19001": 1, "19002": 1 },
        scanBag: [{ id: 1, numId: 19001, persona: 0, source: "10" }], // 源游客 uid=10
        coin: 155,
        items: [{ itemId: 5004, count: 2 }],
      }),
    }))!;
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    const login = Buffer.concat([
      Buffer.from([0x0a, 0x01]), Buffer.from("1"),
      Buffer.from([0x12, 0x01]), Buffer.from("x"),
      Buffer.from([0x18, 0x01]),
    ]);
    await roundTrip(port, frame(4, BigInt(0x0fa1), login));
    const resp = await roundTrip(
      port,
      frame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01])),
    );
    const body = resp.subarray(16);
    // 顶层 f2 = PlayerSyncData
    let playerSync: Buffer | null = null;
    for (const [f, w, p] of parseProto(body)) {
      if (f === 2 && w === 2) playerSync = p as Buffer;
    }
    expect(playerSync).not.toBeNull();
    const playerFields = new Map<number, Buffer>();
    for (const [f, w, p] of parseProto(playerSync!)) {
      if (w === 2) playerFields.set(f, p as Buffer);
    }
    // f5 creatureDoc：collections（f2 wire2）含收录种类 template_id（f1）= 19001 / 19002
    const collectTemplates: number[] = [];
    for (const [cf, cw, cp] of parseProto(playerFields.get(5)!)) {
      if (cf === 2 && cw === 2) {
        for (const [tf, tw, tp] of parseProto(cp as Buffer)) {
          if (tf === 1 && tw === 0) collectTemplates.push(tp as number);
        }
      }
    }
    expect(collectTemplates).toContain(19001);
    expect(collectTemplates).toContain(19002);
    // f6 itemData：coin(f1)=155
    let coin = -1;
    for (const [f, w, p] of parseProto(playerFields.get(6)!)) {
      if (f === 1 && w === 0) coin = p as number;
    }
    expect(coin).toBe(155);
    // f7/f8 为空容器（存在即可）
    expect(playerFields.has(7)).toBe(true);
    expect(playerFields.has(8)).toBe(true);
    // f9 featureDoc：flags 含菜单解锁位（ActArkHubMenuType：数据库=6、画像册=7 等）
    const featureIds: number[] = [];
    for (const [f, w, p] of parseProto(playerFields.get(9)!)) {
      if (f === 1 && w === 2) {
        for (const [kf, kw, kp] of parseProto(p as Buffer)) {
          if (kf === 1 && kw === 0) featureIds.push(kp as number);
        }
      }
    }
    expect(featureIds).toContain(4); // 扫描仪 ARKDEX_CREATURE
    expect(featureIds).toContain(6); // 数据库 ARKDEX_ALBUM
    expect(featureIds).toContain(7); // 画像册 ARKPIXEL
  });

  it("未配置 resolveArkdexDocs 时 PlayerSyncData 不带 f5-f9（维持现状，不影响既有用例）", async () => {
    const port = await startServer();
    const login = Buffer.concat([
      Buffer.from([0x0a, 0x01]), Buffer.from("1"),
      Buffer.from([0x12, 0x01]), Buffer.from("x"),
      Buffer.from([0x18, 0x01]),
    ]);
    await roundTrip(port, frame(4, BigInt(0x0fa1), login));
    const resp = await roundTrip(
      port,
      frame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01])),
    );
    const body = resp.subarray(16);
    let playerSync: Buffer | null = null;
    for (const [f, w, p] of parseProto(body)) {
      if (f === 2 && w === 2) playerSync = p as Buffer;
    }
    const present = new Set<number>();
    for (const [f, w] of parseProto(playerSync!)) {
      if (w === 2) present.add(f);
    }
    // 仅 f1-f4（PlayerBrief/AvatarInfo/GuideFlags/GameplayAttr），无 f5-f9
    expect(present.has(4)).toBe(true);
    expect(present.has(5)).toBe(false);
    expect(present.has(6)).toBe(false);
    expect(present.has(9)).toBe(false);
  });

  it("启动后 isArkhubSessionActive 为 true（enterHall 据此指向本服）", async () => {
    await startServer();
    expect(isArkhubSessionActive()).toBe(true);
  });

  it("端口被占时自动避让到下一个空闲端口，getArkhubSessionPort 回报实际端口", async () => {
    // 先占用一个端口（与网关同样监听全部接口——Windows 上 127.0.0.1 占用不阻塞全局端口），
    // 再让本地网关以该端口为首选 → 应避让到下一个空闲端口
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    const blockedPort = (blocker.address() as net.AddressInfo).port;
    const server = (await startArkhubSessionServer({ port: blockedPort }))!;
    servers.push(server);
    const actualPort = (server.address() as net.AddressInfo).port;
    expect(actualPort).toBeGreaterThan(blockedPort);
    expect(getArkhubSessionPort()).toBe(actualPort);
    expect(isArkhubSessionActive()).toBe(true);
    blocker.close();
  });

  it("首选端口及全部避让端口被占时返回 null（本地网关不可用）", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    const port = (blocker.address() as net.AddressInfo).port;
    // maxPortTries=1：仅尝试首选端口，被占即放弃
    const result = await startArkhubSessionServer({ port, maxPortTries: 1 });
    expect(result).toBeNull();
    expect(isArkhubSessionActive()).toBe(false);
    blocker.close();
  });

  describe("ARKDUEL/令牌网关帧（官服抓包对齐）", () => {
    async function openConn(port: number) {
      const sock = net.connect(port, "127.0.0.1");
      let buf = Buffer.alloc(0);
      const pending: Array<(f: Buffer) => void> = [];
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 16) {
          const len = buf.readUInt32BE(0);
          if (buf.length < len) return;
          const f = buf.subarray(0, len);
          buf = buf.subarray(len);
          pending.shift()?.(f);
        }
      });
      const next = () => new Promise<Buffer>((resolve) => pending.push(resolve));
      await new Promise<void>((r) => sock.once("connect", r));
      const sendFrame = (mainID: number, subID: bigint, body: Buffer) => sock.write(frame(mainID, subID, body));
      return { sock, next, sendFrame };
    }

    it("ARKDUEL 商店（0x28f5ba6f）→ 价格表（0x28f5229c，含 7 件道具）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      const seq = Buffer.alloc(4);
      seq.writeUInt32BE(1, 0);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x28f5ba6f), seq);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("28f5229c");
      // [seq=1] {1:100, 3:{1:ts, 2:[7 items]}}
      const body = resp.subarray(16);
      expect(body.readUInt32BE(0)).toBe(1);
      expect(body[4]).toBe(0x08); // f1
      expect(body[5]).toBe(100); // code 100
      // 含 itemNumId 5004（标准诱引剂，varint 8c27）与价格 40（f3=1828）
      const hex = body.toString("hex");
      expect(hex).toContain("108c27");
      expect(hex).toContain("1828");
      // 稀有诱引剂 5006 价格 250（f3 varint = fa01）
      expect(hex).toContain("18fa01");
      sock.end();
    });

    it("捕捉链路：StartCaptureReq(捕捉区) → StartCaptureResp+EncounterCreatureNotify；EndCaptureReq → EndCaptureResp+onScanStart/onScanSettle", async () => {
      const onScanStart = vi.fn();
      const onScanSettle = vi.fn();
      const server = (await startArkhubSessionServer({
        port: 0,
        onScanStart,
        onScanSettle,
      }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // 登录（uid=1）
      let p = next();
      sendFrame(4, BigInt(0x0fa1), Buffer.concat([
        Buffer.from([0x0a, 0x01]), Buffer.from("1"),
        Buffer.from([0x12, 0x01]), Buffer.from("x"),
        Buffer.from([0x18, 0x01]),
      ]));
      await p;
      // 切到捕抓区 CAPTURE 1（-820616879）：StartCaptureReq 的 onScanStart 判定按 currentMapId
      const signedVarint = (v: number) => {
        let value = BigInt.asUintN(64, BigInt(v));
        const out: number[] = [];
        do {
          let byte = Number(value & 0x7fn);
          value >>= 7n;
          if (value !== 0n) byte |= 0x80;
          out.push(byte);
        } while (value !== 0n);
        return Buffer.from(out);
      };
      let pa = next();
      let ps = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3b60b),
        Buffer.concat([Buffer.from([0x08, 0x02, 0x10]), signedVarint(-820616879)]));
      await pa; // 切场景 ACK
      await ps; // 新场景 EnterSceneNotify
      // 捕捉开始 b7c267d7 → 连发三帧：StartCaptureResp + EncounterCreatureNotify + 捕捉战状态推送（f1=0x400）
      const ps1 = next();
      const ps2 = next();
      const psState = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c267d7),
        Buffer.from([0x0a, 0x00])); // {1:param=ArkDexStartParam}，本地无需解析
      const startResp = await ps1;
      expect((startResp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c2b07e");
      expect(startResp.subarray(16).toString("hex")).toContain("0864"); // f1=code 100
      expect(onScanStart).toHaveBeenCalledWith("1", -820616879);
      const notify = await ps2;
      expect((notify.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c20f13");
      const notifyHex = notify.subarray(16).toString("hex");
      expect(notifyHex).toContain("6163743161726b6875625f3133"); // stage act1arkhub_13（CAPTURE 1 按序映射）
      expect(notifyHex).toContain("10bd9401"); // 本地遭遇生物 19005（template_id f2）
      // 捕捉战状态推送（官服同形：PlayerAlterDataNotify f1=state_mask=0x400 CAPTURE_BATTLE）
      const capState = await psState;
      expect((capState.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b36462");
      expect(capState.subarray(16).toString("hex")).toBe("088008"); // f1=1024 varint
      // 捕捉结束 b7c204e8 → EndCaptureResp(b7c26451) 含 settle_info + 状态清除推送（f1=0）
      p = next();
      const pClear = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c204e8), Buffer.alloc(0));
      const endResp = await p;
      expect((endResp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c26451");
      const endHex = endResp.subarray(16).toString("hex");
      expect(endHex).toContain("0801"); // settle_info.f1 is_success=true
      expect(endHex).toContain("10bd9401"); // 捕获生物 19005（CreatureBrief.template_id）
      expect(endHex).toContain("08892710" ); // settle_info.f4 rewards 奖励 id 5001（扫描 15 券）
      expect(onScanSettle).toHaveBeenCalledWith("1", [19005, 19016, 19060]);
      const clearState = await pClear;
      // f1=0（状态回闲）+ f2=ItemChangeNotify{1:15}（扫描 +15 券同帧推送，免切地图才刷新）
      expect(clearState.subarray(16).toString("hex")).toBe("08001202080f");
      sock.end();
    });

    it("捕捉结束官服形状（[seq]{battle_id, param{complete_state=3, captured 槽位}}）→ 按槽位取捕获子集", async () => {
      const onScanSettle = vi.fn();
      const server = (await startArkhubSessionServer({
        port: 0,
        onScanStart: () => ({ creatures: [19001, 19002, 19003] }),
        onScanSettle,
      }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // 登录（uid=1）
      let p = next();
      sendFrame(4, BigInt(0x0fa1), Buffer.concat([
        Buffer.from([0x0a, 0x01]), Buffer.from("1"),
        Buffer.from([0x12, 0x01]), Buffer.from("x"),
        Buffer.from([0x18, 0x01]),
      ]));
      await p;
      // 切到捕抓区 CAPTURE 1（-820616879）
      const signedVarint = (v: number) => {
        let value = BigInt.asUintN(64, BigInt(v));
        const out: number[] = [];
        do {
          let byte = Number(value & 0x7fn);
          value >>= 7n;
          if (value !== 0n) byte |= 0x80;
          out.push(byte);
        } while (value !== 0n);
        return Buffer.from(out);
      };
      let pa = next();
      let ps = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3b60b),
        Buffer.concat([Buffer.from([0x08, 0x02, 0x10]), signedVarint(-820616879)]));
      await pa;
      await ps;
      // StartCapture：onScanStart 同步返回遭遇 [19001,19002,19003] → Notify 用真实遭遇而非兜底集（后随状态推送）
      const ps1 = next();
      const ps2 = next();
      const psSt = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c267d7), Buffer.from([0x0a, 0x00]));
      await ps1;
      const notify = await ps2;
      expect(notify.subarray(16).toString("hex")).toContain("10b99401"); // 19001（遭遇引擎结果送达）
      await psSt; // 捕捉战状态推送（0x400）
      // EndCapture 官服形状：[4B seq] {1:battle_id, 2:{1:complete_state=3, 2:packed[2,0]}}
      p = next();
      const pSt2 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c204e8), Buffer.concat([
        Buffer.from([0, 0, 0, 7]), // seq
        Buffer.from([0x0a, 0x04]), Buffer.from("1:23"), // f1 battle_id
        Buffer.from([0x12, 0x06, 0x08, 0x03, 0x12, 0x02, 0x02, 0x00]), // f2 param（内容 6B）
      ]));
      const endResp = await p;
      const endHex = endResp.subarray(16).toString("hex");
      expect(endHex.startsWith("00000007")).toBe(true); // seq 回显
      expect(endHex).toContain("0801"); // is_success
      // 槽位 [2,0] → 捕获子集 [19003, 19001]（而非全量遭遇）
      expect(onScanSettle).toHaveBeenCalledWith("1", [19003, 19001]);
      await pSt2; // 状态清除推送（f1=0）
      // 放弃帧（仅 {2:{1:1}}）→ 无奖励最小响应，不发 onScanSettle
      const ps3 = next();
      const ps4 = next();
      const ps5 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c267d7), Buffer.from([0x0a, 0x00]));
      await ps3;
      await ps4;
      await ps5; // 状态推送（0x400）
      onScanSettle.mockClear();
      p = next();
      const pSt3 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c204e8), Buffer.concat([
        Buffer.from([0, 0, 0, 8]),
        Buffer.from([0x12, 0x02, 0x08, 0x01]), // param{1:1}，无 captured
      ]));
      const abortResp = await p;
      const abortHex = abortResp.subarray(16).toString("hex");
      expect(abortHex).not.toContain("0801"); // 无 is_success
      expect(abortHex).not.toContain("2205"); // 无 rewards（f4）
      expect(onScanSettle).not.toHaveBeenCalled();
      await pSt3; // 状态清除推送（f1=0）
      sock.end();
    });

    it("对局链路：JoinDuel → JoinDuelResp+OnJoinDuelNotify；StartDuel → StartDuelResp；DuelRoundResultReport → onDuelSettle", async () => {
      const onDuelSettle = vi.fn();
      const server = (await startArkhubSessionServer({ port: 0, onDuelSettle }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // 登录（uid=1）
      let p = next();
      sendFrame(4, BigInt(0x0fa1), Buffer.concat([
        Buffer.from([0x0a, 0x01]), Buffer.from("1"),
        Buffer.from([0x12, 0x01]), Buffer.from("x"),
        Buffer.from([0x18, 0x01]),
      ]));
      await p;
      // 对局入座 b7c277bf → JoinDuelResp(b7c2a2e2{code,mode_type}) + OnJoinDuelNotify(b7c2ef4f)
      const pj1 = next();
      const pj2 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c277bf), Buffer.alloc(0));
      const join = await pj1;
      expect((join.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c2a2e2");
      expect(join.subarray(16).toString("hex")).toContain("0864"); // f1=code 100
      const notify = await pj2;
      expect((notify.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c2ef4f");
      expect(notify.subarray(16).toString("hex")).toContain("6163743161726b6875625f3038"); // stage act1arkhub_08
      // 对局开始 f8faa515 → StartDuelResp(f8fa2dce{code=100}) + 对局战状态推送（f1=0x800）
      p = next();
      const pDuelState = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xf8faa515),
        Buffer.concat([Buffer.from([0x0a, 0x01]), Buffer.from("d"), Buffer.from([0x10, 0x05])]));
      const start = await p;
      expect((start.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("f8fa2dce");
      expect(start.subarray(16).toString("hex")).toBe("0864"); // f1=code 100
      // 对局战状态推送（官服同形：PlayerAlterDataNotify f1=2048 DUEL_BATTLE，客户端据此开战斗对话框）
      const duelState = await pDuelState;
      expect((duelState.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b36462");
      expect(duelState.subarray(16).toString("hex")).toBe("088010"); // f1=2048 varint
      // 对局回合结算上报 f8fa293a（空 body 不可解析 → 保守按胜）→ onDuelSettle(uid, true) + ACK + 状态清除
      p = next();
      const pClear = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xf8fa293a), Buffer.alloc(0));
      const report = await p;
      expect((report.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("f8fa293b");
      expect(report.subarray(16).toString("hex")).toBe("0864");
      expect(onDuelSettle).toHaveBeenCalledWith("1", true);
      const clearState = await pClear;
      // f1=0（状态回闲）+ f2={1:15}（WIN +15 券同帧推送）
      expect(clearState.subarray(16).toString("hex")).toBe("08001202080f");
      sock.end();
    });

    it("回合结算胜负判定：胜局带胜者 uid / 负局仅终局报；同 battle_id 去重", async () => {
      const onDuelSettle = vi.fn();
      const server = (await startArkhubSessionServer({ port: 0, onDuelSettle }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // 登录（uid=1，胜负判定按 winner===登录 uid 比对）
      let p = next();
      sendFrame(4, BigInt(0x0fa1), Buffer.concat([
        Buffer.from([0x0a, 0x01]), Buffer.from("1"),
        Buffer.from([0x12, 0x01]), Buffer.from("x"),
        Buffer.from([0x18, 0x01]),
      ]));
      await p;
      const reportSub = (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xf8fa293a);
      const varint = (v: number | bigint) => {
        let value = BigInt.asUintN(64, BigInt(v));
        const out: number[] = [];
        do {
          let byte = Number(value & 0x7fn);
          value >>= 7n;
          if (value !== 0n) byte |= 0x80;
          out.push(byte);
        } while (value !== 0n);
        return Buffer.from(out);
      };
      // ① 胜局回合报（官服 08-23 形状）：{1:battle_id, 3:winner="1"(本人)} → WIN + 状态清除推送；同 battle_id 第二报去重（接登录帧后继续）
      p = next();
      let pSt = next();
      sendFrame(8, reportSub, Buffer.concat([
        Buffer.from([0x08]), varint(999), // f1 battle_id
        Buffer.from([0x1a, 0x01]), Buffer.from("1"), // f3 winner=本人
      ]));
      await p;
      expect(onDuelSettle).toHaveBeenLastCalledWith("1", true);
      const stWin = await pSt; // 状态清除 + 券数同帧推送（WIN +15）
      expect(stWin.subarray(16).toString("hex")).toBe("08001202080f");
      p = next();
      sendFrame(8, reportSub, Buffer.concat([
        Buffer.from([0x08]), varint(999), // 同 battle_id → 已结算跳过（仅 ACK，无状态推送）
        Buffer.from([0x1a, 0x01]), Buffer.from("1"),
      ]));
      await p;
      expect(onDuelSettle).toHaveBeenCalledTimes(1);
      // ② 负局（官服 08-16 形状）：回合报无 f3/f4 不发券；终局报带 f4 → LOSE + 状态清除推送
      p = next();
      sendFrame(8, reportSub, Buffer.concat([
        Buffer.from([0x08]), varint(888), // 回合报：仅 battle_id + 快照（无 f3 无 f4）
        Buffer.from([0x2a, 0x02, 0x0a, 0x00]), // f5 快照占位
      ]));
      await p;
      expect(onDuelSettle).toHaveBeenCalledTimes(1); // 回合报不结算，等终局报
      p = next();
      pSt = next();
      sendFrame(8, reportSub, Buffer.concat([
        Buffer.from([0x08]), varint(888), // 同 battle_id 终局报：{4:{…}} 无 winner
        Buffer.from([0x22, 0x04, 0x0a, 0x02, 0x0a, 0x00]),
      ]));
      await p;
      expect(onDuelSettle).toHaveBeenLastCalledWith("1", false);
      expect(onDuelSettle).toHaveBeenCalledTimes(2);
      const clearFrame = await pSt;
      // 状态回闲（f1=0）+ 券数同帧推送（LOSE +7）
      expect(clearFrame.subarray(16).toString("hex")).toBe("080012020807");
      sock.end();
    });

    it("动作掩码（0x38b39680）：SET/CLEAR 应用 + 状态推送（ActArkhubPlayerStateMask 官形）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const maskSub = (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b39680);
      // SET PIXEL_CREATE(0x1000)（官服样本：像素画打开时客户端上报 {1:1, 2:4096}）
      let p1 = next();
      let p2 = next();
      sendFrame(8, maskSub, Buffer.from([0x08, 0x01, 0x10, 0x80, 0x20]));
      const ack = await p1;
      expect((ack.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b39681");
      expect(ack.subarray(16).toString("hex")).toBe("0864");
      const push = await p2;
      expect((push.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b36462");
      expect(push.subarray(16).toString("hex")).toBe("088020"); // f1=4096 varint
      // CLEAR PIXEL_CREATE（{1:2, 2:4096}）→ 状态回 0
      p1 = next();
      p2 = next();
      sendFrame(8, maskSub, Buffer.from([0x08, 0x02, 0x10, 0x80, 0x20]));
      await p1;
      const push2 = await p2;
      expect(push2.subarray(16).toString("hex")).toBe("0800"); // f1=0（回闲）
      sock.end();
    });

    it("网关状态持久化：登录恢复掩码/去重键；变更后经钩子落盘", async () => {
      const onDuelSettle = vi.fn();
      const onStateMaskChanged = vi.fn();
      const onDuelSettled = vi.fn();
      const server = (await startArkhubSessionServer({
        port: 0,
        onDuelSettle,
        onStateMaskChanged,
        onDuelSettled,
        // 存档恢复源：掩码 0x800（对局战中）+ 已结算对局 ["777"]
        resolveGatewayState: () => ({ stateMask: 0x800, settledDuels: ["777"] }),
      }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      const varint = (v: number | bigint) => {
        let value = BigInt.asUintN(64, BigInt(v));
        const out: number[] = [];
        do {
          let byte = Number(value & 0x7fn);
          value >>= 7n;
          if (value !== 0n) byte |= 0x80;
          out.push(byte);
        } while (value !== 0n);
        return Buffer.from(out);
      };
      // 登录（恢复持久化状态）
      let p = next();
      sendFrame(4, BigInt(0x0fa1), Buffer.concat([
        Buffer.from([0x0a, 0x01]), Buffer.from("1"),
        Buffer.from([0x12, 0x01]), Buffer.from("x"),
        Buffer.from([0x18, 0x01]),
      ]));
      await p;
      const reportSub = (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xf8fa293a);
      // ① 已结算对局 777（存档恢复的去重键）重报 → 不重复发券（仅 ACK）
      p = next();
      sendFrame(8, reportSub, Buffer.concat([
        Buffer.from([0x08]), varint(777),
        Buffer.from([0x1a, 0x01]), Buffer.from("1"),
      ]));
      await p;
      expect(onDuelSettle).not.toHaveBeenCalled();
      // ② ModifyPlayerAction SET 0x100 → 掩码 0x800|0x100=0x900 → onStateMaskChanged 落盘钩子
      const maskSub = (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b39680);
      const pm1 = next();
      const pm2 = next();
      sendFrame(8, maskSub, Buffer.from([0x08, 0x01, 0x10, 0x80, 0x02]));
      await pm1; // ACK
      const maskPush = await pm2;
      expect(maskPush.subarray(16).toString("hex")).toBe("088012"); // f1=2304(0x900) varint
      expect(onStateMaskChanged).toHaveBeenCalledWith("1", 0x900);
      // ③ 新对局 888 胜局结算 → 发券 + onDuelSettled 去重键落盘钩子；掩码清 DUEL 位后余 0x100
      p = next();
      const pSt = next();
      sendFrame(8, reportSub, Buffer.concat([
        Buffer.from([0x08]), varint(888),
        Buffer.from([0x1a, 0x01]), Buffer.from("1"),
      ]));
      await p;
      expect(onDuelSettle).toHaveBeenCalledWith("1", true);
      expect(onDuelSettled).toHaveBeenCalledWith("1", "888");
      const clearPush = await pSt;
      // f1=256(0x100)：DUEL 位已清，INTERACT 保留（0x900 & ~0x800）；+ f2={1:15} 券数推送
      expect(clearPush.subarray(16).toString("hex")).toBe("0880021202080f");
      sock.end();
    });

    it("交换信息查询 → f2 回显请求 exchange_type（官服样本 `1001`）；预设交换 → onTradePreset + ACK", async () => {
      const onTradePreset = vi.fn();
      const server = (await startArkhubSessionServer({ port: 0, onTradePreset }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // 交换信息 b7c21f3a {1:1} → b7c25f13 {2:1}（回显而非硬编 0）
      let p = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c21f3a), Buffer.from([0x08, 0x01]));
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c25f13");
      expect(resp.subarray(16).toString("hex")).toBe("1001"); // {2:exchange_type=1}
      // 预设交换 b7c2369e（官服样本 `08f29401 1004` = want 19058 / giving 个体 4）→ ACK + 回调
      p = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c2369e),
        Buffer.from([0x08, 0xf2, 0x94, 0x01, 0x10, 0x04]));
      const ackResp = await p;
      expect((ackResp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c2369f");
      expect(ackResp.subarray(16).toString("hex")).toBe("0864");
      expect(onTradePreset).toHaveBeenCalledWith("", 19058, 4);
      // 删除生物 b7c264e3 → ACK {1:100}
      p = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c264e3),
        Buffer.from([0x0a, 0x04, 0x00, 0x00, 0x00, 0x01]));
      const ack = await p;
      expect((ack.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c264e4");
      expect(ack.subarray(16).toString("hex")).toBe("0864");
      sock.end();
    });

    it("交换信息查询（配置 resolveTrade）→ requests 按挂单回填（CreatureExchangeRequest 反编译字段）", async () => {
      const server = (await startArkhubSessionServer({
        port: 0,
        resolveTrade: () => ({ wantSpecies: 19058, offeringUniqueId: 4, ts: 1786000000000 }),
      }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0xb7c21f3a), Buffer.from([0x08, 0x01]));
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("b7c25f13");
      const hex = resp.subarray(16).toString("hex");
      expect(hex.endsWith("1001")).toBe(true); // f2 exchange_type 回显在帧尾（requests 在前）
      expect(hex).toContain("0a0130"); // f1 from_player_uid="0"（未登录）
      expect(hex).toContain("10f29401"); // to_creature_brief.template_id=19058（想要的种类）
      expect(hex).toContain("0804"); // from_creature_brief.unique_id=4（给出的个体）
      sock.end();
    });

    it("使用道具（0x28f5b1ab [seq]{item_id=5006, count=1}）→ UseItemResp（[seq回显]{1:100}）+ onUseProp", async () => {
      const onUseProp = vi.fn();
      const server = (await startArkhubSessionServer({ port: 0, onUseProp }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // 官服抓包形状（08-12/08-18）：[4B seq] {1:5006, 2:1}
      const p = next();
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x11]), // seq=17
        Buffer.from([0x08, 0x8e, 0x27, 0x10, 0x01]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x28f5b1ab), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("28f5de74");
      expect(resp.subarray(16).toString("hex")).toBe("000000110864"); // [seq回显]{1:code=100}
      expect(onUseProp).toHaveBeenCalledWith("", 5006, 1);
      sock.end();
    });

    it("商店序号购买（0x28f56f2c [seq]{count=1, index=1}）→ 官服形状响应 + 道具变更广播 + onBuyProp；业务拒绝 → 错误码", async () => {
      const onBuyProp = vi.fn();
      const server = (await startArkhubSessionServer({ port: 0, onBuyProp }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      // [seq=10] {1:count=1, 2:index=1}（1 号位恒为 5004 标准诱引剂）
      const p1 = next();
      const p2 = next();
      const body = Buffer.concat([
        Buffer.from([0, 0, 0, 10]),
        Buffer.from([0x08, 0x01, 0x10, 0x01]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x28f56f2c), body);
      let resp = await p1;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("28f5568f");
      let hex = resp.subarray(16).toString("hex");
      expect(hex.startsWith("0000000a")).toBe(true); // seq 回显
      expect(hex).toContain("0864"); // f1=100
      expect(hex).toContain("188c27"); // f3=5004（标准诱引剂）
      expect(onBuyProp).toHaveBeenCalledWith("", 5004, 1);
      // 购买响应后紧跟道具变更广播（0x38b36462，官服样本同序）——客户端据此弹获得提示；
      // body = f2=ItemChangeNotify{1:剩余券, 2:[{1:5004, 2:1}]}
      const notify = await p2;
      expect((notify.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b36462");
      const notifyHex = notify.subarray(16).toString("hex");
      expect(notifyHex).toContain("1205088c271001"); // f2.f2 = {1:5004, 2:1}
      // 业务拒绝（券不足 601）→ 官方错误码响应 + 错误提示通知（双通道，客户端弹对应文案）
      onBuyProp.mockReturnValueOnce({ ok: false, code: 601 });
      const p3 = next();
      const p4 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x28f56f2c), body);
      resp = await p3;
      hex = resp.subarray(16).toString("hex");
      expect(hex.startsWith("0000000a")).toBe(true);
      expect(hex).toBe("0000000a08d904"); // [seq]{1:601}（varint d904 = ITEM_NOT_ENOUGH）
      const errNotify = await p4;
      expect((errNotify.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("30009df1"); // NotifyErrorMessageNotify
      expect(errNotify.subarray(16).toString("hex")).toBe("08d904"); // ErrorCodeNotify{1:601}
      sock.end();
    });

    it("收集画像（0x31d61490）→ ACK", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // {1:"1234567890"(target_uid), 2:像素id}
      const body = Buffer.concat([
        Buffer.from([0x0a, 0x0a]),
        Buffer.from("1234567890"),
        Buffer.from([0x10, 0x80, 0x8f, 0x8e, 0x8d, 0x1f]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x31d61490), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("31d61491");
      expect(resp.subarray(16).toString("hex")).toContain("0864");
      sock.end();
    });

    it("删除像素（0x31d6d13b）→ DeletePixelArtResp（0x31d67d3e，[seq回显]{1:100}）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // 官服抓包 2026-08-12：请求带 4B seq 前缀 + {1:像素id}（此前按纯 protobuf 解析把
      // seq 当 id → 删不掉）；响应带 [seq] 回显 + {1:100}
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x03]), // seq
        Buffer.from([0x08, 0xd2, 0xb8, 0xb1, 0x86, 0x1a]), // f1 像素id
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x31d6d13b), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("31d67d3e");
      expect(resp.subarray(16).toString("hex")).toBe("000000030864");
      sock.end();
    });

    it("删除像素收藏（0x31d65453）→ DeletePixelArtCollectionResp（0x31d6ea56，[seq回显]{1:100}）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // 同删除像素：请求带 4B seq 前缀 + {1:像素id}，响应带 [seq] 回显 + {1:100}
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x04]), // seq
        Buffer.from([0x08, 0xd2, 0xb8, 0xb1, 0x86, 0x1a]), // f1 像素id
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x31d65453), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("31d6ea56");
      expect(resp.subarray(16).toString("hex")).toBe("000000040864");
      sock.end();
    });

    it("重连登录（main=4 sub=0x0fa3）→ {1:101} 重连成功", async () => {
      const port = await startServer();
      const resp = await roundTrip(
        port,
        frame(4, BigInt(0x0fa3), Buffer.concat([
          Buffer.from([0x0a, 0x01]), Buffer.from("1"),
          Buffer.from([0x12, 0x04]), Buffer.from("jwt!"),
        ])),
      );
      expect(resp.readUInt32BE(4)).toBe(4);
      expect(resp.readBigUInt64BE(8)).toBe(BigInt(0x0fa4));
      expect(resp.subarray(16).toString("hex")).toBe("0865"); // {1:101}
    });

    it("像素上传 token（0x31d603b3）→ 凭据（0x31d60cf6，[seq回显]+code=100+真实id）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // 请求形状对齐官服（2026-08-12 抓包）：[4B 请求序号] {1:pixel_art_id, 2:md5}
      // 已存在画布重传带 f1；新画布上传仅带 {2:md5}（pixel_art_id 缺省=0）
      const md5 = "c13ee8e6008018bc773b76b9eade06d7";
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x05]), // seq 前缀
        Buffer.from([0x08, 0x80, 0xb2, 0xb1, 0x86, 0x1a]), // f1 pixel_art_id
        Buffer.from([0x12, 0x20]),
        Buffer.from(md5, "utf8"),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x31d603b3), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("31d60cf6");
      const hex = resp.subarray(16).toString("hex");
      // ① 4B 请求序号回显（客户端按 [seq]+proto 解析，缺前缀响应会错乱——上传失败根因）
      expect(hex.startsWith("00000005")).toBe(true);
      // ② code=100（GW_CODE_OK，官服字节实为 100 而非 0）
      expect(hex).toContain("0864");
      // ③ credential 回显请求的 pixel_art_id（f1=0880b2b1861a）
      expect(hex).toContain("0880b2b1861a");
      // upload_token 字段（f2 wire2，长度 0x20=32 字节）——生成 32 位 hex 令牌
      expect(hex).toContain("1220");
      // credential 末尾为 expire_time（f3=0x18 wire0）的 varint 结束（高位无续位 => 末字节 < 0x80）
      const f3Idx = hex.lastIndexOf("18");
      expect(f3Idx).toBeGreaterThan(0);
      const last = Number.parseInt(hex.slice(hex.length - 2), 16);
      expect(last).toBeLessThan(0x80);
      sock.end();
    });

    it("像素上传 token 新画布（仅 md5）→ 服务端分配真实 pixel_art_id", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // 新画布上传：请求仅 [seq] + {2:md5}（无 pixel_art_id）
      const md5 = "c13ee8e6008018bc773b76b9eade06d7";
      const body = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x06]),
        Buffer.from([0x12, 0x20]),
        Buffer.from(md5, "utf8"),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x31d603b3), body);
      const resp = await p;
      const hex = resp.subarray(16).toString("hex");
      expect(hex.startsWith("00000006")).toBe(true); // seq 回显
      expect(hex).toContain("0864"); // code=100
      // credential（field2，len 0x2e=46B）内 pixel_art_id 非 0（服务端分配真实 id）
      const credStart = hex.indexOf("122e");
      expect(credStart).toBeGreaterThan(0);
      const credHex = hex.slice(credStart + 4); // 跳过 12 2e
      expect(credHex.startsWith("08")).toBe(true);
      const idEnd = credHex.indexOf("1220");
      const idVarint = credHex.slice(2, idEnd);
      expect(idVarint.length).toBeGreaterThan(0);
      expect(BigInt("0x" + idVarint)).toBeGreaterThan(BigInt(0));
      sock.end();
    });

    it("像素保存确认（0x31d674d5）→ PixelArtDataAlterNotify（0x31d62bbd 推送确认）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // SavePixelArtReq：纯 protobuf 无 seq 前缀（官服抓包 2026-08-12）：{1:pixel_art_id, 2:1, 3:0}
      const pixelArtId = 12345;
      const body = Buffer.concat([
        Buffer.from([0x08, 0xb9, 0x60]), // f1 id=12345 varint
        Buffer.from([0x10, 0x01]), // f2 upload_success=1
        Buffer.from([0x18, 0x00]), // f3 do_publish=0
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x31d674d5), body);
      const resp = await p;
      // 服务端 fire-and-forget（无 ACK），主动推 PixelArtDataAlterNotify（31d62bbd）
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("31d62bbd");
      const hex = resp.subarray(16).toString("hex");
      // PixelArtDataAlterNotify：未登录/无该像素时至少带 f9 remaining_publish_count（=50）
      //（此前字段号错配导致客户端收不到列表与发布次数）
      expect(hex).toContain("4832"); // fv(9, 50) = 48 32
      sock.end();
    });

    it("交互提交（0x38b3116d）mmkabi 领奖 → ACK + 道具奖励通知 + GuideFlags 广播", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      // 场景 hello（获取 flags——capture_catch_guide_02=2 完成态，mmkabi 引导不触发；
      // 官服进图不发 38b36462，仅场景帧）
      const p = next();
      sendFrame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01]));
      const enter = await p;
      const keyHex = "636170747572655f63617463685f67756964655f3032";
      expect(enter.subarray(16).toString("hex")).toContain(keyHex + "1002");
      // 交互提交：[seq=4] {1:"arkhub_capture1_mmkabi_01b", 2:"get_reward"}
      // 官服响应 3 帧：38b38cd6 ACK → 3000ee32 道具奖励通知 → 38b36462 引导更新广播
      const pa = next();
      const pb = next();
      const pc = next();
      const body = Buffer.concat([
        Buffer.from([0, 0, 0, 4]),
        Buffer.from([0x0a, 0x1a]),
        Buffer.from("arkhub_capture1_mmkabi_01b", "utf8"),
        Buffer.from([0x12, 0x0a]),
        Buffer.from("get_reward", "utf8"),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3116d), body);
      const resp = await pa;
      // ① 38b38cd6 通用 ACK（[seq回显]{1:100}）
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b38cd6");
      expect(resp.subarray(16).toString("hex")).toBe("000000040864"); // [seq=4]{1:100}
      const rewardNotif = await pb;
      // ② 3000ee32 道具奖励通知 {1:1, 2:[{1:5012,2:1},{1:5022,2:1}]}
      expect((rewardNotif.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("3000ee32");
      expect(rewardNotif.subarray(16).toString("hex")).toBe("0801120508942710011205089e271001");
      const push = await pc;
      // ③ 38b36462 引导更新广播：f2={1:券数, 2:[{1:5012,2:1},{1:5022,2:1}]} + capture_update_guide=1
      expect((push.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b36462");
      expect(push.subarray(16).toString("hex")).toContain(
        "636170747572655f7570646174655f6775696465" + "1001",
      );
      expect(push.subarray(16).toString("hex")).toContain("0894271001"); // 道具 5012×1
      sock.end();
    });

    it("交互提交（0x38b3116d）shiane_02b 夏妮领奖 → ACK + 道具奖励通知 + GuideFlags 广播推进", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      // 场景 hello：capture_catch_guide_01=2（完成态；官服进图不发 38b36462，仅场景帧）
      const p = next();
      sendFrame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01]));
      let enter = await p;
      const key01 = "636170747572655f63617463685f67756964655f3031";
      expect(enter.subarray(16).toString("hex")).toContain(key01 + "1002");
      // 交互提交：[seq=5] {1:"arkhub_main_shiane_02b", 2:"get_reward"}
      // 官服响应 3 帧：38b38cd6 ACK → 3000ee32 道具奖励通知 → 38b36462 引导更新广播
      const pa = next();
      const pb = next();
      const pc = next();
      const body = Buffer.concat([
        Buffer.from([0, 0, 0, 5]),
        Buffer.from([0x0a, 0x16]),
        Buffer.from("arkhub_main_shiane_02b", "utf8"),
        Buffer.from([0x12, 0x0a]),
        Buffer.from("get_reward", "utf8"),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3116d), body);
      const resp = await pa;
      // ① 38b38cd6 通用 ACK（[seq回显]{1:100}）
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b38cd6");
      expect(resp.subarray(16).toString("hex")).toBe("000000050864"); // [seq=5]{1:100}
      const rewardNotif = await pb;
      // ② 3000ee32 道具奖励通知 {1:1, 2:[{1:5012,2:1},{1:5022,2:1}]}
      expect((rewardNotif.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("3000ee32");
      expect(rewardNotif.subarray(16).toString("hex")).toBe("0801120508942710011205089e271001");
      // ③ 38b36462 引导更新广播：f2={1:券数,2:[道具]} + capture_update_guide=1（客户端据此结束对话）
      const broadcast = await pc;
      expect((broadcast.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b36462");
      expect(broadcast.subarray(16).toString("hex")).toContain(
        "636170747572655f7570646174655f6775696465" + "1001",
      );
      // 再次场景 hello：capture_catch_guide_01 仍为 2（推进不改变已完成状态；无进图广播）
      const p2 = next();
      sendFrame(8, BigInt("0x18fb64de29cdb"), Buffer.from([0x08, 0x01]));
      enter = await p2;
      expect(enter.subarray(16).toString("hex")).toContain(key01 + "1002");
      sock.end();
    });

    it("交互领奖一次性闸门：首次正常发奖，已领过仅回 ACK（修复每次进入都提示）", async () => {
      const claimActorReward = vi
        .fn()
        .mockReturnValueOnce(true) // 首次：可领（已记录）
        .mockReturnValueOnce(false); // 二次：已领过
      const server = (await startArkhubSessionServer({ port: 0, claimActorReward }))!;
      servers.push(server);
      const port = (server.address() as net.AddressInfo).port;
      const { sock, next, sendFrame } = await openConn(port);
      const interactBody = Buffer.concat([
        Buffer.from([0, 0, 0, 9]),
        Buffer.from([0x0a, 0x16]),
        Buffer.from("arkhub_main_shiane_02b", "utf8"),
        Buffer.from([0x12, 0x0a]),
        Buffer.from("get_reward", "utf8"),
      ]);
      // 首次：ACK + 奖励通知 + 引导广播（完整链路）
      const p1 = next();
      const p2 = next();
      const p3 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3116d), interactBody);
      await p1;
      await p2;
      await p3;
      expect(claimActorReward).toHaveBeenCalledTimes(1);
      // 二次：仅 ACK，无奖励通知/广播（不重复提示）
      const q1 = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3116d), interactBody);
      const ackOnly = await q1;
      expect((ackOnly.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b38cd6");
      expect(ackOnly.subarray(16).toString("hex")).toBe("000000090864");
      const extra = await new Promise<boolean>((resolve) => {
        sock.once("data", () => resolve(true));
        setTimeout(() => resolve(false), 80);
      });
      expect(extra).toBe(false); // 80ms 内无后续帧（无奖励通知/广播）
      expect(claimActorReward).toHaveBeenCalledTimes(2);
      sock.end();
    });
  });

  describe("会话/设置/外观帧（路由补齐：此前落通用 ACK 或错位响应）", () => {
    async function openConn(port: number) {
      const sock = net.connect(port, "127.0.0.1");
      let buf = Buffer.alloc(0);
      const pending: Array<(f: Buffer) => void> = [];
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 16) {
          const len = buf.readUInt32BE(0);
          if (buf.length < len) return;
          const f = buf.subarray(0, len);
          buf = buf.subarray(len);
          pending.shift()?.(f);
        }
      });
      const next = () => new Promise<Buffer>((resolve) => pending.push(resolve));
      await new Promise<void>((r) => sock.once("connect", r));
      const sendFrame = (mainID: number, subID: bigint, body: Buffer) => sock.write(frame(mainID, subID, body));
      return { sock, next, sendFrame };
    }

    it("更换形象（0x38b3d83c）→ ChangeOutlookResp（0x38b3f7a7，code=100 + 回显外观）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // ChangeOutlookReq：{1:"char_1012_skadi2", 2:"char_1012_skadi2#1", 3:1(SP)}（§10 字段）
      const body = Buffer.concat([
        Buffer.from([0x0a, 0x10]), Buffer.from("char_1012_skadi2"),
        Buffer.from([0x12, 0x12]), Buffer.from("char_1012_skadi2#1"),
        Buffer.from([0x18, 0x01]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3d83c), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3f7a7");
      const hex = resp.subarray(16).toString("hex");
      expect(hex.startsWith("0864")).toBe(true); // {1:code=100}
      expect(hex).toContain("636861725f313031325f736b61646932"); // char_1012_skadi2
      expect(hex).toContain("636861725f313031325f736b616469322331"); // char_1012_skadi2#1
      expect(hex.endsWith("2001")).toBe(true); // {4:skin_sp=1}
      sock.end();
    });

    it("设置更新（0x38b36054 settings={4:0}）→ UpdatePlayerSettingsResp（0x38b3db61 回显）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // 官服抓包 2026-08-09：请求 {1:{1:4}}（settings map 条目 {key=4, value 缺省 0}）
      const body = Buffer.from([0x0a, 0x02, 0x08, 0x04]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b36054), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3db61");
      // 响应 {1:100, 2:{1:4, 2:0}}——对齐官服抓包字节（0864120408041000）
      expect(resp.subarray(16).toString("hex")).toBe("0864120408041000");
      sock.end();
    });

    it("名片查看（0x38b322c3）→ GetBusinessCardResp（0x38b3613c 最小结构）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // 官服抓包：请求带 [4B seq] 前缀 + {1:unique_id}
      const body = Buffer.concat([
        Buffer.from([0, 0, 0, 7]),
        Buffer.from([0x08, 0x01]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b322c3), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3613c");
      // {1: card=BusinessCard{1: card_info=NameCard(空)}} = 0a 02 0a 00
      expect(resp.subarray(16).toString("hex")).toBe("0a020a00");
      sock.end();
    });

    it("活跃上报（0x38b3ab0c）→ fire-and-forget 不响应", async () => {
      const port = await startServer();
      const { sock, sendFrame } = await openConn(port);
      // ReportPlayerActiveReq：{1:count}——官服忽略不响应（此前落通用 ACK 属多余帧）
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3ab0c),
        Buffer.from([0x08, 0x01]));
      const got = await new Promise<boolean>((resolve) => {
        sock.once("data", () => resolve(true));
        setTimeout(() => resolve(false), 60);
      });
      expect(got).toBe(false);
      sock.end();
    });

    it("离开场景（0x38b3c3c9）→ ACK {1:100}", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3c3c9),
        Buffer.from([0x08, 0x01])); // {1:logout_type=1}
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3c3ca");
      expect(resp.subarray(16).toString("hex")).toBe("0864");
      sock.end();
    });

    it("交互（0x38b36055）→ InteractionActionResp（0x38b3d134 {1:result_code=0}）", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // InteractionActionReq：{1:target_unique_id, 2:action, 3:squad_index}（§10 字段）
      const body = Buffer.concat([
        Buffer.from([0x08, 0x01]),
        Buffer.from([0x10, 0x00]),
        Buffer.from([0x18, 0x00]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b36055), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3d134");
      expect(resp.subarray(16).toString("hex")).toBe("0800");
      sock.end();
    });

    it("表情（0x38b3170a）→ ACK {1:100}", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // DoRolePlayingReq：{1:emoj_id, 2:theme_id, 3:action_mask}
      const body = Buffer.concat([
        Buffer.from([0x0a, 0x01]), Buffer.from("e"),
        Buffer.from([0x12, 0x01]), Buffer.from("t"),
        Buffer.from([0x18, 0x01]),
      ]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b3170a), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b3170b");
      expect(resp.subarray(16).toString("hex")).toBe("0864");
      sock.end();
    });

    it("动作掩码（0x38b39680）→ ACK {1:100}", async () => {
      const port = await startServer();
      const { sock, next, sendFrame } = await openConn(port);
      const p = next();
      // ModifyPlayerActionReq：{1:operation, 2:state_mask}
      const body = Buffer.from([0x08, 0x00, 0x10, 0x00]);
      sendFrame(8, (BigInt("0x2c89b3") << BigInt(32)) | BigInt(0x38b39680), body);
      const resp = await p;
      expect((resp.readBigUInt64BE(8) & 0xffffffffn).toString(16)).toBe("38b39681");
      expect(resp.subarray(16).toString("hex")).toBe("0864");
      sock.end();
    });
  });
});
